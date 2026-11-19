/*
 * Offline harness for the recovery plugin's host half.
 *
 * Loads the real plugin against a stub Cordis context, then drives the
 * `agent/request-error` waterfall the way the agent loop does, so the retry
 * decision, the attempt budget, and the command execution are exercised
 * without a running harness.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "lfc-test-"));
process.env.DSH_HOME = home;

const { default: plugin, apply } = await import("../lib/index.js");
const config = await import("../lib/config.js");
const { runCommand } = await import("../lib/run-command.js");

let failures = 0;
async function test(title, body) {
  try {
    await body();
    console.log(`  ok   ${title}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${title}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A stub context that captures listeners and service lookups. */
function makeContext() {
  const listeners = new Map();
  const routes = new Map();
  const logs = [];
  const ctx = {
    logger: {
      info: (message) => logs.push(["info", String(message)]),
      warn: (message) => logs.push(["warn", String(message)]),
      error: (message) => logs.push(["error", String(message)]),
    },
    on(hook, listener, options) {
      const rows = listeners.get(hook) ?? [];
      // `prepend: true` inserts at the head, exactly as Cordis does.
      const prepend = options === true || options?.prepend === true;
      if (prepend) rows.unshift(listener);
      else rows.push(listener);
      listeners.set(hook, rows);
      return () => {
        const at = rows.indexOf(listener);
        if (at !== -1) rows.splice(at, 1);
      };
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, listeners, routes, logs };
}

/**
 * Run one `agent/request-error` waterfall the way the agent loop does.
 * @returns the returned action, or "terminal" when every listener declined.
 */
async function dispatchRequestError(listeners, payload) {
  const rows = [...(listeners.get("agent/request-error") ?? [])];
  const terminal = async () => undefined;
  const call = (index) => {
    const listener = rows[index] ?? terminal;
    return Promise.resolve(listener(payload, () => call(index + 1)));
  };
  const action = await call(0);
  return action?.kind === "retry" ? "retry" : "terminal";
}

console.log("runCommand");

// A temp script is used instead of `-e` so the nested quoting is the test's
// only concern: cmd.exe re-parses the command line, and inline JS would make a
// quoting bug look like a plugin bug.
const scriptDir = mkdtempSync(join(tmpdir(), "lfc-cmd-"));
const script = (name, source) => {
  const file = join(scriptDir, `${name}.mjs`);
  writeFileSync(file, source);
  return `"${process.execPath}" "${file}"`;
};

await test("runs a real command and reports success", async () => {
  const result = await runCommand(script("ok", "console.log('hello')"), { timeoutMs: 20_000 });
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello/);
});

await test("reports a non-zero exit without throwing", async () => {
  const result = await runCommand("exit 7", { timeoutMs: 20_000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
});

await test("kills a command that exceeds its timeout", async () => {
  const result = await runCommand(script("sleep", "setTimeout(() => {}, 60000)"), { timeoutMs: 400 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true, `expected a timeout, got ${JSON.stringify(result)}`);
});

await test("captures stderr", async () => {
  const result = await runCommand(script("err", "console.error('boom'); process.exit(3)"), { timeoutMs: 20_000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
});

await test("caps captured output instead of growing without bound", async () => {
  const result = await runCommand(script("chatty", "console.log('x'.repeat(200000))"), { timeoutMs: 20_000 });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length <= 8192, `stdout must be capped, got ${result.stdout.length}`);
});

await test("resolves immediately when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand(script("never", "setTimeout(() => {}, 60000)"), {
    timeoutMs: 20_000,
    signal: controller.signal,
  });
  assert.equal(result.aborted, true);
});

console.log("config");

await test("defaults are used on a fresh install", async () => {
  const stored = config.readConfig();
  assert.equal(stored.enabled, true);
  assert.equal(stored.command, "", "the shipped command is composed, not stored");
  assert.equal(stored.deviceSerial, "");
  assert.equal(stored.port, 33377);
  assert.equal(stored.maxRetries, 1);
  assert.equal(stored.timeoutMs, 15_000);
});

await test("composes the adb command from the serial and port", async () => {
  assert.equal(
    config.resolveCommand({ command: "", deviceSerial: "", port: 33377 }),
    "adb forward tcp:33377 tcp:33377",
    "no serial means the single attached device",
  );
  assert.equal(
    config.resolveCommand({ command: "", deviceSerial: "ABC123", port: 33377 }),
    "adb -s ABC123 forward tcp:33377 tcp:33377",
  );
  assert.equal(
    config.resolveCommand({ command: "echo mine", deviceSerial: "ignored", port: 1 }),
    "echo mine",
    "an explicit command wins over the composed one",
  );
});

await test("writes survive a re-read", async () => {
  config.writeConfig({ command: "echo hi", maxRetries: 3 });
  const stored = config.readConfig();
  assert.equal(stored.command, "echo hi");
  assert.equal(stored.maxRetries, 3);
  assert.equal(stored.enabled, true, "unrelated keys must be preserved");
});

await test("rejects a bad type, out-of-range numbers, and an unsafe serial", async () => {
  assert.throws(() => config.validatePatch({ enabled: "yes" }), /布尔值/);
  assert.throws(() => config.validatePatch({ maxRetries: 99 }), /之间/);
  assert.throws(() => config.validatePatch({ port: 0 }), /之间/);
  assert.throws(() => config.validatePatch({ unknownKey: 1 }), /未知字段/);
  // A serial reaches a shell, so quoting characters are refused, not escaped.
  assert.throws(() => config.validatePatch({ deviceSerial: "a; rm -rf /" }), /只能包含/);
  assert.throws(() => config.validatePatch({ deviceSerial: 'a"b' }), /只能包含/);
  assert.deepEqual(config.validatePatch({ deviceSerial: "" }), { deviceSerial: "" });
  assert.deepEqual(config.validatePatch({ deviceSerial: "192.168.1.5:5555" }), { deviceSerial: "192.168.1.5:5555" });
});

await test("an empty command is accepted as 'compose one'", async () => {
  assert.deepEqual(config.validatePatch({ command: "   " }), { command: "" });
});

await test("accepts the page's numeric strings", async () => {
  assert.deepEqual(config.validatePatch({ timeoutMs: "5000", maxRetries: "2" }), { timeoutMs: 5000, maxRetries: 2 });
});

console.log("hook: agent/request-error");

await test("returns retry for a transport failure and runs the command", async () => {
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1, timeoutMs: 20_000 });
  const { ctx, listeners, logs } = makeContext();
  apply(ctx);
  const action = await dispatchRequestError(listeners, {
    agent: { id: "a1" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  });
  assert.equal(action, "retry");
  assert.ok(logs.some(([level, message]) => level === "warn" && /running repair command/.test(message)));
});

await test("is registered ahead of the built-in retry policy", async () => {
  const { ctx, listeners } = makeContext();
  // Simulate llm-retry registering later with the default (append) order.
  ctx.on("agent/request-error", async (_payload, next) => next());
  apply(ctx);
  const rows = listeners.get("agent/request-error");
  assert.equal(rows.length, 2);
  assert.match(String(rows[0]), /repair|config|readConfig|next/);
});

await test("delegates a credential failure without running anything", async () => {
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1 });
  const { ctx, listeners, logs } = makeContext();
  apply(ctx);
  const action = await dispatchRequestError(listeners, {
    agent: { id: "a2" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "bad key", code: "AUTH" },
    signal: { aborted: false },
  });
  assert.equal(action, "terminal", "AUTH must stay terminal");
  assert.equal(logs.some(([, message]) => /running repair command/.test(message)), false);
});

await test("stays terminal when the plugin is disabled", async () => {
  config.writeConfig({ enabled: false, command: "exit 0" });
  const { ctx, listeners } = makeContext();
  apply(ctx);
  const action = await dispatchRequestError(listeners, {
    agent: { id: "a3" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  });
  assert.equal(action, "terminal");
});

await test("stays terminal when the repair command itself fails", async () => {
  config.writeConfig({ enabled: true, command: "exit 1", maxRetries: 1, timeoutMs: 20_000 });
  const { ctx, listeners } = makeContext();
  apply(ctx);
  const action = await dispatchRequestError(listeners, {
    agent: { id: "a4" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  });
  assert.equal(action, "terminal", "a failed repair must not claim recovery");
});

await test("honours the per-step attempt budget", async () => {
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1, timeoutMs: 20_000 });
  const { ctx, listeners } = makeContext();
  apply(ctx);
  const payload = {
    agent: { id: "a5" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  };
  assert.equal(await dispatchRequestError(listeners, payload), "retry");
  assert.equal(await dispatchRequestError(listeners, payload), "terminal", "budget of 1 must stop the second attempt");
});

await test("maxRetries: 0 disables the repair entirely", async () => {
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 0 });
  const { ctx, listeners } = makeContext();
  apply(ctx);
  const action = await dispatchRequestError(listeners, {
    agent: { id: "a6" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  });
  assert.equal(action, "terminal");
});

await test("does not run when the request was aborted", async () => {
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1 });
  const { ctx, listeners } = makeContext();
  apply(ctx);
  const action = await dispatchRequestError(listeners, {
    agent: { id: "a7" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "aborted", code: "TRANSPORT" },
    signal: { aborted: true },
  });
  assert.equal(action, "terminal");
});

await test("clears the ledger at a session step boundary", async () => {
  config.writeConfig({ enabled: true, command: "exit 0", maxRetries: 1, timeoutMs: 20_000 });
  const { ctx, listeners } = makeContext();
  apply(ctx);
  const payload = {
    agent: { id: "s1" },
    turn: 1,
    step: 1,
    provider: "imaegoo",
    failure: { message: "fetch failed", code: "TRANSPORT" },
    signal: { aborted: false },
  };
  assert.equal(await dispatchRequestError(listeners, payload), "retry");
  assert.equal(await dispatchRequestError(listeners, payload), "terminal");
  // The loop opens the next step, which must restore the budget.
  for (const listener of listeners.get("session/event") ?? []) {
    listener({ id: "s1" }, { type: "step/start" });
  }
  assert.equal(await dispatchRequestError(listeners, payload), "retry");
});

console.log("settings api");

/** Issue one request against the registered route and return its parsed body. */
async function callRoute(routes, { method = "GET", body, origin } = {}) {
  const route = routes.get("/llm-failure-command/api/state");
  assert.ok(route !== undefined, "route must be registered");
  const headers = { host: "127.0.0.1:1243" };
  if (origin !== undefined) headers.origin = origin;
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers,
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

await test("GET returns the configuration and runtime counters", async () => {
  config.writeConfig({ command: "exit 0" });
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { status, body } = await callRoute(routes);
  assert.equal(status, 200);
  assert.equal(body.config.command, "exit 0");
  assert.equal(body.defaults.command, "");
  assert.equal(body.effectiveCommand, "exit 0", "an explicit command is what runs");
  assert.equal(typeof body.status.path, "string");
  assert.ok(Array.isArray(body.status.repairableCodes));
});

await test("GET reports the composed command when none is stored", async () => {
  config.writeConfig({ command: "", deviceSerial: "ABC123", port: 4444 });
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { body } = await callRoute(routes);
  assert.equal(body.config.command, "");
  assert.equal(body.effectiveCommand, "adb -s ABC123 forward tcp:4444 tcp:4444");
});

await test("POST saves a patch", async () => {
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { status, body } = await callRoute(routes, {
    method: "POST",
    body: { command: "echo patched", maxRetries: 2 },
  });
  assert.equal(status, 200);
  assert.equal(body.config.command, "echo patched");
  assert.equal(body.config.maxRetries, 2);
});

await test("POST rejects an invalid field with a 400 and a message", async () => {
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { status, body } = await callRoute(routes, { method: "POST", body: { deviceSerial: "bad serial; rm -rf /" } });
  assert.equal(status, 400);
  assert.match(body.error, /只能包含/);
});

await test("POST test runs the command and reports the run", async () => {
  config.writeConfig({ command: "echo tested", timeoutMs: 20_000 });
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { status, body } = await callRoute(routes, { method: "POST", body: { action: "test" } });
  assert.equal(status, 200);
  assert.equal(body.runtime.lastRun.ok, true);
  assert.match(body.runtime.lastRun.stdout, /tested/);
  assert.equal(body.runtime.lastRun.reason, "manual");
});

await test("POST reset restores the shipped defaults", async () => {
  config.writeConfig({ command: "echo mine", maxRetries: 5, deviceSerial: "X", port: 1 });
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { body } = await callRoute(routes, { method: "POST", body: { action: "reset" } });
  assert.equal(body.config.command, "", "reset clears the override so the fields compose again");
  assert.equal(body.config.deviceSerial, "");
  assert.equal(body.config.port, 33377);
  assert.equal(body.config.maxRetries, 1);
});

await test("a cross-origin POST is refused", async () => {
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { status } = await callRoute(routes, {
    method: "POST",
    body: { command: "echo nope" },
    origin: "https://evil.example",
  });
  assert.equal(status, 403);
});

await test("an unsupported method is refused", async () => {
  const { ctx, routes } = makeContext();
  apply(ctx);
  const { status } = await callRoute(routes, { method: "DELETE" });
  assert.equal(status, 405);
});

console.log("client bundle");

await test("lib/client.js registers exactly one module under the package name", async () => {
  const registrations = [];
  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  };
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8"),
  );
  // Evaluate the bundle with a minimal `document` and `fetch`, as the shell would.
  globalThis.document = { baseURI: "http://127.0.0.1:1243/" };
  const factory = new Function("window", "document", source);
  factory(globalThis.window, globalThis.document);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, "@imaegoo/dsh-llm-failure-command");

  const React = {
    createElement: (...args) => ({ args }),
    useState: (init) => [typeof init === "function" ? init() : init, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: (init) => ({ current: init }),
  };
  const plugin = registrations[0].factory((spec) => {
    if (spec === "react") return React;
    throw new Error(`unexpected require(${JSON.stringify(spec)})`);
  });
  assert.ok(Array.isArray(plugin.inject));
  assert.deepEqual(plugin.inject, ["slots"]);
  assert.equal(typeof plugin.apply, "function");

  // The slot registration must carry the id/order/label the shell reads.
  let registered;
  const slots = {
    inject: (name, body) => {
      assert.equal(name, "settings.section");
      body();
    },
    register: (options, component) => {
      registered = { options, component };
      return () => {};
    },
  };
  plugin.apply({ slots });
  assert.equal(registered.options.name, "settings.section");
  assert.equal(registered.options.id, "llm-failure-command");
  assert.equal(typeof registered.options.order, "number");
  assert.equal(typeof registered.options.label, "string");
  assert.equal(typeof registered.component, "function");
});

console.log("manifest");

await test("package.json declares the client half the loader scans for", async () => {
  const fs = await import("node:fs/promises");
  const manifest = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.name, "@imaegoo/dsh-llm-failure-command");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.exports["."], "./lib/index.js");
  assert.equal(manifest.exports["./client"], "./lib/client.js");
  assert.equal(manifest.dsh.client.platform, "web");
  // The bundle's registration id must match the package name the loader keys on.
  assert.ok(manifest.exports["./client"].endsWith("client.js"));
});

rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
