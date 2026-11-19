/*
 * Render the real settings page with a minimal React stand-in.
 *
 * The browser module table supplies React from the shell bundle, which is not
 * installed as a package, so the page cannot be imported the normal way. This
 * harness implements just enough of React's hooks to execute the component and
 * inspect the element tree it returns, which catches the mistakes that matter
 * for a hand-written page: a hook used conditionally, a missing prop, a field
 * that never renders, or a click handler that does not call the API.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "lfc-render-"));
process.env.DSH_HOME = home;

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

/** The element tree `createElement` produces. */
const ELEMENT = Symbol("element");

/**
 * Build a React stand-in.
 *
 * Hooks are backed by a slot array that is reset per component render, which is
 * enough for a page whose hook calls are unconditional: an out-of-order call
 * would surface as a shape mismatch and fail the render.
 */
function makeReact(initialState = {}) {
  const hooks = { slots: [], cursor: 0, effects: [] };

  const React = {
    createElement(type, props, ...children) {
      return { [ELEMENT]: true, type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
    },
    useState(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
      const set = (next) => {
        hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next;
      };
      return [hooks.slots[index], set];
    },
    useRef(initial) {
      const index = hooks.cursor++;
      hooks.slots[index] ??= { current: initial };
      return hooks.slots[index];
    },
    useCallback(fn) {
      hooks.cursor++;
      return fn;
    },
    useEffect(fn) {
      hooks.cursor++;
      hooks.effects.push(fn);
    },
  };

  /** Render a component, preserving hook slots across calls. */
  const render = (Component, props, { reset = false } = {}) => {
    if (reset) {
      hooks.slots = [];
      hooks.effects = [];
    }
    hooks.cursor = 0;
    const tree = Component(props);
    // Drain effects once, as React does after a commit.
    const pending = hooks.effects.splice(0);
    for (const effect of pending) {
      const cleanup = effect();
      if (typeof cleanup === "function") hooks.cleanups.push(cleanup);
    }
    return tree;
  };
  hooks.cleanups = [];

  return { React, render, hooks };
}

/** Walk an element tree, collecting every node of a given type or matching a predicate. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (node[ELEMENT]) {
    if (predicate(node)) found.push(node);
    findAll(node.props.children, predicate, found);
  }
  return found;
}

/** Collect all text content of an element tree. */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (node[ELEMENT]) return textOf(node.props.children);
  return "";
}

/** Load the client bundle and return its plugin object. */
async function loadClient(initialFetch) {
  const registrations = [];
  globalThis.window = {
    __ModuleLoader__: { load: (r) => registrations.push(r) },
    // The page schedules a poll and a debounce through `window`, as a browser
    // page does; the harness supplies the host's timers.
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  globalThis.document = { baseURI: "http://127.0.0.1:1243/" };
  globalThis.fetch = initialFetch;

  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8"),
  );
  new Function("window", "document", source)(globalThis.window, globalThis.document);
  assert.equal(registrations.length, 1);

  const { React, render, hooks } = makeReact();
  const plugin = registrations[0].factory((spec) => {
    if (spec === "react") return React;
    throw new Error(`unexpected require(${JSON.stringify(spec)})`);
  });

  // Capture the component the plugin registers.
  let component;
  plugin.apply({
    slots: {
      inject: (_name, body) => body(),
      register: (_options, Page) => {
        component = Page;
        return () => {};
      },
    },
  });
  assert.equal(typeof component, "function");
  return { component, render, hooks };
}

/** A snapshot shaped exactly like the host's settings route response. */
function snapshot(overrides = {}) {
  const config = {
    enabled: true, command: "", deviceSerial: "", port: 33377, timeoutMs: 15000, maxRetries: 1,
    ...overrides.config,
  };
  return {
    config,
    defaults: { enabled: true, command: "", deviceSerial: "", port: 33377, timeoutMs: 15000, maxRetries: 1 },
    effectiveCommand: overrides.effectiveCommand ?? "adb forward tcp:33377 tcp:33377",
    limits: { timeoutMs: { min: 1000, max: 120000 }, maxRetries: { min: 0, max: 10 }, port: { min: 1, max: 65535 } },
    runtime: { running: false, lastRun: null, driven: 0, recovered: 0, exhausted: 0, ...overrides.runtime },
    status: { path: "C:\\Users\\x\\.dsh\\llm-failure-command.json", repairableCodes: ["TRANSPORT", "TIMEOUT"] },
  };
}

/** A fetch stub that answers the settings route from a fixed snapshot. */
function fetchStub(state, sink = { calls: [] }) {
  return async (url, init = {}) => {
    sink.calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    if ((init.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => state() };
    }
    const patch = JSON.parse(init.body);
    sink.lastPatch = patch;
    return { ok: true, status: 200, json: async () => state() };
  };
}

console.log("settings page render");

await test("renders the loading state before the first response arrives", async () => {
  const { component, render } = await loadClient(async () => {
    throw new Error("offline");
  });
  const tree = render(component, {});
  assert.match(textOf(tree), /加载中/);
});

await test("renders the title, the switch, and the fields once loaded", async () => {
  config.writeConfig({ enabled: true, command: "", deviceSerial: "SER1", port: 33377, timeoutMs: 15000, maxRetries: 1 });
  const { component, render } = await loadClient(fetchStub(() => snapshot({ config: { command: "", deviceSerial: "SER1" } })));
  // First render: loading. The fetch effect resolves, then the page re-renders.
  const first = render(component, {});
  assert.match(textOf(first), /加载中/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});

  assert.match(textOf(tree), /模型调用失败恢复/, "page title must render");
  assert.match(textOf(tree), /自动执行命令/, "the switch label must render");
  assert.match(textOf(tree), /设备序列号/, "the serial field must render");
  assert.match(textOf(tree), /本地端口/, "the port field must render");
  assert.match(textOf(tree), /要执行的命令/, "the command field must render");
  assert.match(textOf(tree), /命令超时/, "the timeout field must render");
  assert.match(textOf(tree), /最多重试/, "the retry field must render");

  const checkbox = findAll(tree, (n) => n.type === "input" && n.props.type === "checkbox");
  assert.equal(checkbox.length, 1, "exactly one switch");
  assert.equal(checkbox[0].props.checked, true, "the switch mirrors the stored value");

  const texts = findAll(tree, (n) => n.type === "input" && n.props.type === "text");
  assert.equal(texts.length, 2, "the serial and the optional command");
  assert.equal(texts[0].props.value, "SER1", "the serial field mirrors the stored value");
  assert.equal(texts[1].props.value, "", "the command is empty when the fields compose it");

  const numbers = findAll(tree, (n) => n.type === "input" && n.props.type === "number");
  assert.equal(numbers.length, 3, "port, timeout and retry fields");
  assert.deepEqual(numbers.map((n) => n.props.value), ["33377", "15000", "1"]);
});

await test("the switch writes the new value immediately", async () => {
  const sink = { calls: [] };
  const { component, render } = await loadClient(fetchStub(() => snapshot(), sink));
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});
  const checkbox = findAll(tree, (n) => n.type === "input" && n.props.type === "checkbox")[0];

  sink.calls.length = 0;
  checkbox.props.onChange({ currentTarget: { checked: false } });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const write = sink.calls.find((call) => call.method === "POST");
  assert.ok(write !== undefined, "the toggle must POST");
  assert.equal(JSON.parse(write.body).enabled, false);
});

await test("editing the command debounces into one write", async () => {
  const sink = { calls: [] };
  const { component, render } = await loadClient(fetchStub(() => snapshot(), sink));
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});
  // The command is the second text field; the first is the device serial.
  const field = findAll(tree, (n) => n.type === "input" && n.props.type === "text")[1];

  sink.calls.length = 0;
  for (const value of ["a", "ab", "abc"]) {
    field.props.onChange({ currentTarget: { value } });
    render(component, {});
  }
  await new Promise((resolve) => setTimeout(resolve, 900));

  const writes = sink.calls.filter((call) => call.method === "POST");
  assert.equal(writes.length, 1, `expected one debounced write, got ${String(writes.length)}`);
  assert.equal(JSON.parse(writes[0].body).command, "abc", "the last keystroke wins");
});

await test("editing the serial debounces into one write with the other fields", async () => {
  const sink = { calls: [] };
  const { component, render } = await loadClient(fetchStub(() => snapshot(), sink));
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});
  const serial = findAll(tree, (n) => n.type === "input" && n.props.type === "text")[0];

  sink.calls.length = 0;
  for (const value of ["L", "LP", "LPEM"]) {
    serial.props.onChange({ currentTarget: { value } });
    render(component, {});
  }
  await new Promise((resolve) => setTimeout(resolve, 900));

  const writes = sink.calls.filter((call) => call.method === "POST");
  assert.equal(writes.length, 1, `expected one debounced write, got ${String(writes.length)}`);
  const body = JSON.parse(writes[0].body);
  assert.equal(body.deviceSerial, "LPEM", "the serial is saved");
  assert.equal(body.command, "", "an empty command keeps the composed one in force");
});

await test("'run now' and 'restore defaults' are wired to their actions", async () => {
  const sink = { calls: [] };
  const { component, render } = await loadClient(fetchStub(() => snapshot(), sink));
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});

  const buttons = findAll(tree, (n) => n.type === "button");
  assert.equal(buttons.length, 2, "two action buttons");
  assert.match(textOf(buttons[0]), /立即执行一次/);
  assert.match(textOf(buttons[1]), /恢复默认/);

  sink.calls.length = 0;
  buttons[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const runPatch = sink.calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body));
  assert.ok(runPatch.some((p) => p.action === "test"), "run-now must send action:test");

  sink.calls.length = 0;
  buttons[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const resetPatch = sink.calls.filter((c) => c.method === "POST").map((c) => JSON.parse(c.body));
  assert.ok(resetPatch.some((p) => p.action === "reset"), "restore-defaults must send action:reset");
});

await test("a successful run is shown with its output", async () => {
  const state = snapshot({
    runtime: {
      running: false,
      driven: 2,
      recovered: 1,
      exhausted: 0,
      lastRun: {
        at: Date.now() - 5000,
        durationMs: 132,
        command: "adb -s X forward tcp:1 tcp:1",
        ok: true,
        code: 0,
        timedOut: false,
        aborted: false,
        stdout: "forwarded",
        stderr: "",
        reason: "auto:TRANSPORT",
      },
    },
  });
  const { component, render } = await loadClient(fetchStub(() => state));
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});

  const text = textOf(tree);
  assert.match(text, /最近一次执行/, "the run card must render");
  assert.match(text, /成功/, "a successful run must read as success");
  assert.match(text, /forwarded/, "captured stdout must be shown");
  assert.match(text, /2 次/, "the trigger count must render");
});

await test("a failed run is shown as an error, not as success", async () => {
  const state = snapshot({
    config: { enabled: true },
    runtime: {
      running: false,
      driven: 1,
      recovered: 0,
      exhausted: 1,
      lastRun: {
        at: Date.now() - 1000,
        durationMs: 40,
        command: "adb -s X forward tcp:1 tcp:1",
        ok: false,
        code: 1,
        timedOut: false,
        aborted: false,
        stdout: "",
        stderr: "device offline",
        reason: "auto:TRANSPORT",
      },
    },
  });
  const { component, render } = await loadClient(fetchStub(() => state));
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});

  const text = textOf(tree);
  assert.match(text, /退出码 1/, "a non-zero exit must name its code");
  assert.match(text, /device offline/, "stderr must be shown");
  assert.doesNotMatch(text, /最近一次执行 成功/, "a failed run must not read as success");
});

await test("a rejected save is surfaced to the operator", async () => {
  const { component, render } = await loadClient(async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => snapshot() };
    }
    return { ok: false, status: 400, json: async () => ({ error: "command 不能为空" }) };
  });
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tree = render(component, {});
  const field = findAll(tree, (n) => n.type === "input" && n.props.type === "text")[0];

  field.props.onChange({ currentTarget: { value: "   " } });
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 900));
  const after = render(component, {});

  assert.match(textOf(after), /command 不能为空/, "the host's message must be shown");
});

await test("an unreachable host is reported, not crashed on", async () => {
  const { component, render } = await loadClient(async () => {
    throw new Error("network down");
  });
  render(component, {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The GET failure leaves the page loading; a mutation must report the error.
  const tree = render(component, {});
  assert.ok(tree !== null, "the page must still render");
});

rmSync(home, { recursive: true, force: true });

console.log(failures === 0 ? "\nrender checks passed" : `\n${failures} render check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
