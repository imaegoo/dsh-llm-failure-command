/*
 * One-shot shell command execution for the recovery plugin.
 *
 * Node's own `child_process` is used rather than `ctx.shell`: that service is
 * sandbox-confined, and a repair command must still run under the presets that
 * deny writes. It is also not resolvable from a profile-installed package.
 *
 * The command runs through `shell: true`, which is the only portable way to
 * hand a command LINE to a shell: on Windows that spawns
 * `cmd.exe /d /s /c <command>` with `windowsVerbatimArguments` set, so the
 * operator's own quoting reaches cmd unchanged instead of being re-escaped by
 * Node's CRT rules.
 */
import { spawn, spawnSync } from "node:child_process";

/** Bytes of each stream retained for the settings page; the rest is dropped. */
const STREAM_CAP_BYTES = 8192;

/**
 * Run one shell command to completion with a hard timeout.
 *
 * Never rejects: an unusable command, a non-zero exit, and a timeout all
 * resolve with a described result, because the caller is already handling a
 * failure and must not be derailed by this one.
 * @param command - the command line, run verbatim by the platform's shell.
 * @param options - timeout, working directory, and an optional abort signal.
 * @returns the exit status, whether it timed out, and captured output.
 */
export function runCommand(command, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000;
  const signal = options.signal;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        ok: false,
        code: null,
        signal: null,
        timedOut: false,
        aborted: true,
        stdout: "",
        stderr: "已取消",
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer;

    /** Settle once, clearing the timer and the abort listener. */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        ok: result.ok === true,
        code: result.code ?? null,
        signal: result.signal ?? null,
        timedOut: result.timedOut === true,
        aborted: result.aborted === true,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    };

    /** Stop the command, taking its whole tree down on Windows. */
    const stop = () => {
      if (process.platform === "win32" && child?.pid !== undefined) {
        // `cmd.exe` runs the real command as a grandchild, so killing the shell
        // alone would leave the operator's process behind.
        try {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          return;
        } catch {
          // Fall through to the direct kill below.
        }
      }
      try {
        child?.kill("SIGKILL");
      } catch {
        // The process is already gone; `close` settles the promise.
      }
    };

    const onAbort = () => {
      stop();
      finish({ ok: false, code: null, timedOut: false, aborted: true, stdout, stderr });
    };

    let child;
    try {
      child = spawn(command, {
        shell: true,
        cwd: options.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      finish({ ok: false, code: null, timedOut: false, aborted: false, stdout: "", stderr: describe(error) });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, timeoutMs));
    timer.unref?.();

    signal?.addEventListener?.("abort", onAbort, { once: true });

    // Reading only what the page can show bounds memory if the command is chatty.
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        code: null,
        timedOut,
        aborted: false,
        stdout,
        stderr: append(stderr, Buffer.from(describe(error))),
      });
    });
    child.on("close", (code, closeSignal) => {
      finish({
        ok: code === 0 && !timedOut,
        code,
        signal: closeSignal ?? null,
        timedOut,
        aborted: false,
        stdout,
        stderr,
      });
    });
  });
}

/** Append a chunk, keeping at most {@link STREAM_CAP_BYTES} of decoded text. */
function append(text, chunk) {
  if (text.length >= STREAM_CAP_BYTES) return text;
  return (text + chunk.toString("utf8")).slice(0, STREAM_CAP_BYTES);
}

/** Render a thrown value without letting hostile coercion escape. */
function describe(value) {
  try {
    return value instanceof Error ? value.message : String(value);
  } catch {
    return "unknown error";
  }
}
