/*
 * Persistent configuration for the LLM-failure recovery plugin.
 *
 * Stored as JSON under the dsh home directory rather than in the profile's
 * cordis patch: the host half then imports nothing but Node builtins, which is
 * what lets the plugin live inside a profile whose node_modules cannot resolve
 * any `@deepseek-ai/*` package.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** ADB serial used when the operator has no strong preference. */
export const DEFAULT_SERIAL = "";

/** Default local port that the model proxy listens on. */
export const DEFAULT_PORT = 33377;

/** The command run when `command` is left empty: built from the serial and port. */
export function defaultCommand(serial, port) {
  const target = serial.trim() === "" ? "" : `-s ${serial.trim()} `;
  return `adb ${target}forward tcp:${String(port)} tcp:${String(port)}`;
}

/** Hard bounds applied to every stored value. */
export const LIMITS = Object.freeze({
  timeoutMs: { min: 1000, max: 120_000 },
  maxRetries: { min: 0, max: 10 },
  port: { min: 1, max: 65_535 },
});

/** The serial the settings page offers as its placeholder. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  command: "",
  timeoutMs: 15_000,
  maxRetries: 1,
  deviceSerial: DEFAULT_SERIAL,
  port: DEFAULT_PORT,
});

/** dsh home directory, matching where the harness keeps its own state. */
function dshHome() {
  const explicit = process.env.DSH_HOME?.trim();
  if (explicit) return explicit;
  return join(homedir(), ".dsh");
}

/** Absolute path of the plugin's configuration file. */
export function configPath() {
  return join(dshHome(), "llm-failure-command.json");
}

/**
 * The command that will actually run.
 *
 * An explicit `command` always wins, so an operator can use any repair step at
 * all. Left empty, the command is composed from the serial and port fields,
 * which keeps the common case — one adb forward — editable field by field
 * instead of as shell text.
 * @param config - a complete configuration.
 * @returns the command line handed to the shell.
 */
export function resolveCommand(config) {
  if (typeof config.command === "string" && config.command.trim() !== "") return config.command.trim();
  return defaultCommand(config.deviceSerial, config.port);
}

/** Read the stored configuration, filling defaults for missing or invalid keys. */
export function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return normalize(parsed);
  } catch {
    // A missing or unreadable file is a fresh install, not an error.
    return { ...DEFAULTS };
  }
}

/** Merge a patch into the stored configuration and return the result. */
export function writeConfig(patch) {
  const next = normalize({ ...readConfig(), ...patch });
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file is already user-scoped.
  }
  return next;
}

/** The value a fresh install starts from, for a settings page's "reset" hint. */
export function defaultConfig() {
  return { ...DEFAULTS };
}

/**
 * Validate one incoming settings submission.
 *
 * Every field is optional so the page can save a single control. A rejected
 * field names itself, so the page can show the message beside the form instead
 * of silently keeping a stale value.
 * @param input - the parsed request body.
 * @returns the accepted patch.
 * @throws {TypeError} naming the first rejected field.
 */
export function validatePatch(input) {
  const patch = {};

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new TypeError("enabled 必须是布尔值");
    patch.enabled = input.enabled;
  }

  if (input.command !== undefined) {
    if (typeof input.command !== "string") throw new TypeError("command 必须是字符串");
    const command = input.command.trim();
    if (command.length > 4096) throw new TypeError("command 过长（最多 4096 字符）");
    // An empty command is meaningful: it means "compose one from the fields".
    patch.command = command;
  }

  if (input.deviceSerial !== undefined) {
    if (typeof input.deviceSerial !== "string") throw new TypeError("deviceSerial 必须是字符串");
    const serial = input.deviceSerial.trim();
    if (serial.length > 256) throw new TypeError("deviceSerial 过长（最多 256 字符）");
    // A serial reaches a shell, so anything outside ADB's own alphabet is
    // refused rather than escaped: `adb -s` takes a host:port for TCP devices.
    if (!/^[A-Za-z0-9._:-]*$/.test(serial)) {
      throw new TypeError("deviceSerial 只能包含字母、数字、点、下划线、冒号和连字符");
    }
    patch.deviceSerial = serial;
  }

  if (input.port !== undefined) {
    patch.port = readInteger(input.port, LIMITS.port, "port");
  }

  if (input.timeoutMs !== undefined) {
    patch.timeoutMs = readInteger(input.timeoutMs, LIMITS.timeoutMs, "timeoutMs");
  }

  if (input.maxRetries !== undefined) {
    patch.maxRetries = readInteger(input.maxRetries, LIMITS.maxRetries, "maxRetries");
  }

  const known = ["enabled", "command", "deviceSerial", "port", "timeoutMs", "maxRetries"];
  const unknown = Object.keys(input).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new TypeError(`未知字段：${unknown.join("、")}`);

  return patch;
}

/** Coerce one bounded integer field, accepting the page's numeric strings. */
function readInteger(value, bounds, field) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number)) {
    throw new TypeError(`${field} 必须是整数`);
  }
  if (number < bounds.min || number > bounds.max) {
    throw new TypeError(`${field} 必须在 ${bounds.min} 到 ${bounds.max} 之间`);
  }
  return number;
}

/** Coerce an arbitrary value into a complete, bounded configuration. */
function normalize(input) {
  const source = typeof input === "object" && input !== null ? input : {};
  const text = (value) => (typeof value === "string" ? value.trim() : "");

  const command = text(source.command);
  const deviceSerial = text(source.deviceSerial);
  const port = Number(source.port);
  const timeoutMs = Number(source.timeoutMs);
  const maxRetries = Number(source.maxRetries);

  return {
    enabled: source.enabled !== false,
    command: command.length > 4096 ? "" : command,
    deviceSerial: deviceSerial.length > 256 ? DEFAULT_SERIAL : deviceSerial,
    port: Number.isInteger(port) && port >= LIMITS.port.min && port <= LIMITS.port.max
      ? port
      : DEFAULTS.port,
    timeoutMs: Number.isInteger(timeoutMs) && timeoutMs >= LIMITS.timeoutMs.min && timeoutMs <= LIMITS.timeoutMs.max
      ? timeoutMs
      : DEFAULTS.timeoutMs,
    maxRetries: Number.isInteger(maxRetries) && maxRetries >= LIMITS.maxRetries.min && maxRetries <= LIMITS.maxRetries.max
      ? maxRetries
      : DEFAULTS.maxRetries,
  };
}

/** A short random tag, so a settings write is attributable in logs. */
export function revision() {
  return randomBytes(6).toString("base64url");
}
