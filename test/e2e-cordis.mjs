/*
 * End-to-end proof that the repair path actually rescues a failed request.
 *
 * Boots a real Cordis app with the plugin mounted next to a service stand-in
 * that fails until the repair command has run, then drives one failed request.
 * The assertion is the one that matters: the retried request succeeds.
 *
 * This exercises the real `agent/request-error` waterfall, so the
 * `prepend: true` registration is verified against Cordis' own listener
 * ordering rather than assumed.
 *
 * The DSH runtime ships inside the app's `app.asar`, which Node cannot import
 * from directly. Point DSH_CORDIS_DIR at an extracted `@deepseek-ai` directory
 * to run this suite; without one it skips with instructions instead of failing.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Locate the extracted `@deepseek-ai` directory holding Cordis.
 * @returns the directory, or undefined when no extraction is available.
 */
function findCordisDir() {
  const explicit = process.env.DSH_CORDIS_DIR?.trim();
  if (explicit !== undefined && explicit !== "" && existsSync(join(explicit, "cordis/lib/index.js"))) {
    return explicit;
  }
  return undefined;
}

const cordisDir = findCordisDir();
if (cordisDir === undefined) {
  console.log(
    [
      "e2e checks skipped: no extracted DSH runtime found.",
      "",
      "The DSH runtime lives inside app.asar, which Node cannot import from directly.",
      "To run this suite, extract the runtime once and point the suite at it:",
      "",
      '  $env:DSH_CORDIS_DIR = "<path>\\dsh\\node_modules\\@deepseek-ai"',
      "",
      "Any directory whose `cordis/lib/index.js` is the harness's Cordis will do.",
      "test/harness.mjs and test/render.mjs need no runtime and always run.",
    ].join("\n"),
  );
  process.exit(0);
}

const home = mkdtempSync(join(tmpdir(), "lfc-e2e-"));
process.env.DSH_HOME = home;

const { Context } = await import(`file:///${cordisDir.replace(/\\/g, "/")}/cordis/lib/index.js`);
const { apply } = await import("../lib/index.js");
const config = await import("../lib/config.js");

let failures = 0;
async function test(title, body) {
  try {
    await body();
    console.log(`  ok   ${title}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${title}\n       ${error instanceof Error ? error.stack : String(error)}`);
  }
}

/**
 * Build the waterfall the way the agent loop does, over a real Cordis context.
 * A context needs no explicit start: awaiting the fiber `ctx.plugin()` returns
 * is what settles activation.
 * @returns the root context.
 */
function makeApp() {
  return new Context();
}

/**
 * Stand up the `webServer` service the plugin requires, then mount it.
 *
 * In a real composition `@deepseek-ai/dsh-host-webserver` provides this; here a
 * registry stub is enough, and it also lets the test read the route the plugin
 * registers exactly as the HTTP server would.
 * @returns `{ fiber, routes }`.
 */
async function mount(ctx) {
  const routes = new Map();
  const host = ctx.plugin({
    apply(hostCtx) {
      hostCtx.provide("webServer", {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      });
    },
  });
  await host;

  const fiber = ctx.plugin({ inject: ["webServer"], apply });
  await fiber;
  return { fiber, routes };
}

/** Call the plugin's settings route the way the web server would. */
async function callState(routes, { method = "GET", body } = {}) {
  const route = routes.get("/llm-failure-command/api/state");
  assert.ok(route !== undefined, "the settings route must be registered");
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: { host: "127.0.0.1:1243" },
    on(event, handler) {
      if (event === "data") for (const chunk of chunks) handler(chunk);
      if (event === "end") handler();
      return req;
    },
  };
  const captured = { status: 0, body: undefined };
  const res = {
    writeHead(status) {
      captured.status = status;
    },
    end(text) {
      captured.body = JSON.parse(text);
    },
  };
  await route.handler(req, res);
  return captured;
}

/**
 * Run `agent/request-error` through Cordis' own waterfall, so listener order
 * and `prepend` semantics are the harness's, not this test's.
 */
async function dispatchError(ctx, payload) {
  const action = await ctx.waterfall("agent/request-error", payload, async () => undefined);
  return action?.kind === "retry" ? "retry" : "terminal";
}

console.log("cordis waterfall (real)");

await test("the plugin's retry wins over the built-in retry policy", async () => {
  const ctx = makeApp();

  // Stand in for @deepseek-ai/dsh-llm-retry: for a retryable code it decides
  // on its own and never polls `next()`, which is why we must run first.
  let policyConsulted = false;
  ctx.on("agent/request-error", async (payload, next) => {
    policyConsulted = true;
    const retryable = ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];
    if (!retryable.includes(payload.failure?.code)) return next();
    // Its budget is exhausted here, so it delegates 鈥?the interesting case.
    return next();
  });

  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1, timeoutMs: 20_000 });
  await mount(ctx);

  const action = await dispatchError(ctx, {
    agent: { id: "e2e" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  });

  assert.equal(action, "retry", "the repair must claim recovery");
  assert.equal(policyConsulted, false, "the repair must run before the retry policy decides");
  await ctx.fiber.dispose();
});

await test("a healthy command is recorded as a successful rescue", async () => {
  const ctx = makeApp();
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1, timeoutMs: 20_000 });
  const { routes } = await mount(ctx);

  await dispatchError(ctx, {
    agent: { id: "e2e2" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  });

  // Read the counters through the plugin's own settings route contract.
  const { status, body: state } = await callState(routes);
  assert.equal(status, 200);
  assert.equal(state.runtime.driven, 1);
  assert.equal(state.runtime.recovered, 1);
  assert.equal(state.runtime.lastRun.ok, true);
  await ctx.fiber.dispose();
});

console.log("real failed request rescued end to end");

await test("a request that only succeeds after the repair completes the turn", async () => {
  const ctx = makeApp();

  // The marker file is what the repair command creates; the adapter fails
  // until it exists. This is the adb-forward shape: the environment is broken
  // in a way only the command can fix.
  const marker = join(home, "port-open");
  const script = join(home, "open-port.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "1");`);
  config.writeConfig({
    enabled: true,
    command: `"${process.execPath}" "${script}"`,
    maxRetries: 2,
    timeoutMs: 30_000,
  });

  await mount(ctx);

  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(marker), false, "precondition: the port is closed");

  // Simulate the loop: dispatch the failure, and on `retry` attempt the call.
  let attempts = 0;
  let completed = false;
  for (let i = 0; i < 5 && !completed; i += 1) {
    attempts += 1;
    if (existsSync(marker)) {
      completed = true;
      break;
    }
    const action = await dispatchError(ctx, {
      agent: { id: "e2e3" },
      turn: 1,
      step: 1,
      provider: "imaegoo",
      failure: { message: "connect ECONNREFUSED 127.0.0.1:33377", code: "TRANSPORT" },
      signal: { aborted: false },
    });
    if (action !== "retry") break;
  }

  assert.equal(completed, true, "the retried request must succeed after the repair");
  assert.equal(existsSync(marker), true, "the command must have run");
  // One failed attempt, one repair, then the successful attempt.
  assert.equal(attempts, 2, `expected 2 attempts, saw ${attempts}`);
  await ctx.fiber.dispose();
});

rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? "\nend-to-end checks passed" : `\n${failures} end-to-end check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

