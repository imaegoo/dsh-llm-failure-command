/*
 * LLM-failure recovery: run a command when a model call fails, then retry.
 *
 * The motivating case is a local model proxy that listens on a host port which
 * an adb port forward maps onto a phone. When the forward is lost every model
 * call fails with a transport error, and the fix is a single `adb forward`
 * command: run it, then let the loop try the same request again.
 *
 * Wiring: `agent/request-error` is a waterfall dispatched by the agent loop
 * after a model request produced a terminal error finish. A listener that
 * returns `{ kind: "retry" }` makes the loop reopen the step and re-dispatch
 * the request; `undefined` (or polling `next()`) leaves the failure terminal.
 * The listener is registered with `prepend: true` because the built-in
 * `llm-retry` policy also listens here and, for the codes this fails on
 * (`TRANSPORT`, `TIMEOUT`, `SERVER`, `RATE_LIMIT`), does not poll `next()` until
 * its own budget is exhausted — a repair that runs after five backoff attempts
 * would arrive minutes late.
 *
 * This half imports nothing but Node builtins and the plugin's own modules: the
 * profile's node_modules cannot resolve any `@deepseek-ai/*` package.
 */
import { readConfig, resolveCommand, validatePatch, writeConfig, defaultConfig, LIMITS, configPath } from "./config.js";
import { runCommand } from "./run-command.js";

/** Stable Cordis plugin name. */
export const name = "llm-failure-command";

/** The settings page and its API vanish with the web server they extend. */
export const inject = ["webServer"];

/** Largest settings payload accepted from the browser. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Failure codes worth repairing. Anything else (a bad credential, an exceeded
 * context window, a malformed request) is a configuration problem that the
 * same request will reproduce, so running a command would only add latency.
 * `UNKNOWN`/`PI_AI_ERROR` are included because an adapter that could not even
 * classify a connection error reports one of them.
 */
const REPAIRABLE_CODES = new Set([
  "TRANSPORT",
  "TIMEOUT",
  "SERVER",
  "RATE_LIMIT",
  "UNKNOWN",
  "PI_AI_ERROR",
]);

/** How long a finished attempt record stays useful before it may be pruned. */
const ATTEMPT_STALE_MS = 30_000;

/** Bound on the per-step attempt ledger, so a long session cannot grow it. */
const ATTEMPT_LEDGER_LIMIT = 256;

/**
 * Run a configured command after a failed model request and retry it.
 *
 * The plugin keeps no state that a restart must preserve beyond the settings
 * file: the attempt ledger is per-step and self-expiring.
 */
export function apply(ctx) {
  const log = (message) => {
    ctx.logger?.info?.(`llm-failure-command: ${message}`);
  };
  const warn = (message) => {
    ctx.logger?.warn?.(`llm-failure-command: ${message}`);
  };

  /** Attempt counters keyed by agent/turn/step. */
  const attempts = new Map();

  /** How many repairs are in flight, so the page's "running" state survives overlap. */
  let running = 0;

  /** What the settings page renders: the stored configuration and what it has done. */
  const runtime = {
    lastRun: null,
    driven: 0,
    recovered: 0,
    exhausted: 0,
  };

  /** Forget records that are stale, keeping the ledger bounded across a long session. */
  function prune(now) {
    if (attempts.size <= ATTEMPT_LEDGER_LIMIT) return;
    for (const [key, entry] of attempts) {
      if (now - entry.touchedAt > ATTEMPT_STALE_MS) attempts.delete(key);
    }
  }

  /**
   * Run the stored command and record the outcome.
   *
   * @param options - `signal` cancels the run; `reason` labels the log line.
   * @returns the run result, ready for the page.
   */
  async function repair(options = {}) {
    const config = readConfig();
    const command = resolveCommand(config);
    const startedAt = Date.now();
    running += 1;
    try {
      const result = await runCommand(command, {
        timeoutMs: config.timeoutMs,
        signal: options.signal,
      });
      const finishedAt = Date.now();
      runtime.lastRun = {
        at: finishedAt,
        durationMs: finishedAt - startedAt,
        command,
        ok: result.ok,
        code: result.code,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdout: result.stdout,
        stderr: result.stderr,
        reason: options.reason ?? "manual",
      };
      if (result.ok) {
        log(`${options.reason ?? "manual"}: rescued by \`${command}\` in ${String(finishedAt - startedAt)}ms`);
      } else {
        const detail = result.timedOut
          ? `timed out after ${String(config.timeoutMs)}ms`
          : result.aborted
            ? "aborted"
            : `exit ${String(result.code)}`;
        warn(`${options.reason ?? "manual"}: \`${command}\` ${detail}`);
      }
      return runtime.lastRun;
    } finally {
      running -= 1;
    }
  }

  /**
   * Hand one failed request a repair and, when it worked, ask for a retry.
   *
   * A failed repair still polls `next()`: the built-in retry policy gets its
   * turn, and the failure stays terminal when it declines.
   */
  ctx.on("agent/request-error", async (payload, next) => {
    const { agent, turn, step, provider, failure, signal } = payload ?? {};
    const config = readConfig();
    if (!config.enabled || config.maxRetries === 0) return next();

    const code = typeof failure?.code === "string" ? failure.code : "UNKNOWN";
    if (!REPAIRABLE_CODES.has(code)) return next();
    if (signal?.aborted) return next();

    const agentId = typeof agent?.id === "string" ? agent.id : "unknown";
    const key = `${agentId}:${String(turn)}:${String(step)}`;
    const now = Date.now();
    prune(now);

    const used = attempts.get(key)?.count ?? 0;
    if (used >= config.maxRetries) {
      // This step has already spent its budget; a second repair is unlikely to
      // help and would only stall the failure the operator needs to see.
      return next();
    }

    attempts.set(key, { count: used + 1, touchedAt: now });

    runtime.driven += 1;
    warn(
      `model call failed (provider=${String(provider)}, code=${code}, status=${String(failure?.status ?? "-")}); running repair command`,
    );

    const result = await repair({ signal, reason: `auto:${code}` });
    if (signal?.aborted) return next();

    if (!result.ok) {
      runtime.exhausted += 1;
      return next();
    }

    runtime.recovered += 1;
    return { kind: "retry" };
  }, { prepend: true });

  /** A session's step boundary and its end both start a clean ledger for that session. */
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "step/start" && event?.type !== "turn/end") return;
    const sessionId = typeof session?.id === "string" ? session.id : undefined;
    if (sessionId === undefined) return;
    for (const key of attempts.keys()) {
      if (key.startsWith(`${sessionId}:`)) attempts.delete(key);
    }
  });

  /** The JSON the settings page renders from. */
  function snapshot() {
    const config = readConfig();
    return {
      config,
      defaults: defaultConfig(),
      limits: LIMITS,
      // What an empty `command` will actually run, so the page can show it.
      effectiveCommand: resolveCommand(config),
      runtime: {
        running: running > 0,
        lastRun: runtime.lastRun,
        driven: runtime.driven,
        recovered: runtime.recovered,
        exhausted: runtime.exhausted,
      },
      status: {
        path: configPath(),
        repairableCodes: [...REPAIRABLE_CODES],
      },
    };
  }

  /**
   * Apply one settings submission.
   *
   * Fields are saved as they arrive, so the page has no save button. The only
   * actions apart from a plain save are `test` (run the command now) and
   * `reset` (restore the shipped defaults).
   */
  async function applySettings(body) {
    const { action, ...fields } = body;
    if (action !== undefined && typeof action !== "string") {
      throw new TypeError("action 必须是字符串");
    }

    let changed = false;
    if (action === "reset") {
      writeConfig(defaultConfig());
      changed = true;
      log("settings reset to defaults");
    } else if (Object.keys(fields).length > 0) {
      const patch = validatePatch(fields);
      const before = readConfig();
      const after = writeConfig(patch);
      changed = JSON.stringify(before) !== JSON.stringify(after);
    }

    if (action === "test") {
      await repair({ reason: "manual" });
    }

    return { ok: true, changed, ...snapshot() };
  }

  /** Guard against cross-origin writes: the page is same-origin with the API. */
  function trusted(req) {
    const origin = headerValue(req, "origin");
    if (origin === undefined || origin === "") return true;
    const host = headerValue(req, "host");
    if (host === undefined) return false;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  async function handleState(req, res) {
    if (!trusted(req)) {
      writeJSON(res, 403, { error: "forbidden" });
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET") {
      writeJSON(res, 200, snapshot());
      return;
    }
    if (method !== "POST") {
      writeJSON(res, 405, { error: "method not allowed" });
      return;
    }
    try {
      const body = await readJSON(req);
      writeJSON(res, 200, await applySettings(body));
    } catch (error) {
      writeJSON(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: "exact", path: "/llm-failure-command/api/state", handler: handleState }),
    "llm-failure-command: settings api",
  );

  const initial = readConfig();
  log(
    `ready (enabled=${String(initial.enabled)}, maxRetries=${String(initial.maxRetries)}, command=${initial.command})`,
  );
}

function headerValue(req, field) {
  const raw = req.headers[field] ?? req.headers[field.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === "string" ? raw : undefined;
}

function writeJSON(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Read and parse a bounded JSON request body. */
function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk)) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("请求体必须是 JSON 对象"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", () => {
      reject(new Error("读取请求体失败"));
    });
  });
}
