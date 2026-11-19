/*
 * The in-GUI settings section for the model-failure recovery plugin.
 *
 * Registers one page under Settings where the repair command, its switch, and
 * its limits live, plus the outcome of the last run. Every field saves itself;
 * the buttons are "run now" and "restore defaults". The page talks to
 * `/llm-failure-command/api/state`, which the host half serves.
 *
 * React comes from the browser module table and the styling uses dsw theme
 * tokens, so the page follows the harness light and dark themes.
 *
 * IMPORTANT — everything lives inside the factory below.
 *
 * The host concatenates several client bundles into ONE classic script. A
 * top-level `const` here is therefore a global of that shared script, and a name
 * another concatenated package also declares raises `Identifier 'X' has already
 * been declared`. That SyntaxError stops the whole script, so every package in
 * the batch fails to register — the failure reads as
 * "loaded without registering ... via __ModuleLoader__.load".
 */
(window.__ModuleLoader__)?.load({
  id: "@imaegoo/dsh-llm-failure-command",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const CSS = `
.lfc { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 24px; max-width: 620px; min-width: 0; }
.lfc, .lfc * { box-sizing: border-box; }
.lfc h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.lfc p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.lfc-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; min-width: 0;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); }
.lfc-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
  font-size: 13px; min-width: 0; color: var(--dsw-alias-label-primary); }
.lfc-row > span:first-child { flex: none; }
.lfc-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.lfc-field > span { font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.lfc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lfc input[type=text], .lfc input[type=number] { width: 100%; height: 34px; padding: 0 10px; font: inherit; font-size: 13px; min-width: 0;
  font-family: ui-monospace, Menlo, monospace;
  color: var(--dsw-alias-label-primary); background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2));
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-sm); outline: none; }
.lfc input[type=number] { font-family: inherit; }
.lfc input:focus { border-color: var(--dsw-alias-state-business-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }
.lfc-toggle { display: inline-flex; align-items: center; flex: none; cursor: pointer; }
.lfc-toggle input { position: absolute; opacity: 0; width: 0; height: 0; }
.lfc-toggle i { width: 38px; height: 22px; border-radius: 999px; background: var(--dsw-alias-border-l4);
  position: relative; transition: background .15s ease; }
.lfc-toggle i::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--dsw-alias-label-primary); transition: transform .15s ease; }
.lfc-toggle input:checked + i { background: var(--dsw-alias-state-business-primary); }
.lfc-toggle input:checked + i::after { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground, #fff); }
.lfc-toggle input:disabled + i { opacity: .5; cursor: default; }
.lfc-toggle input:focus-visible + i { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.lfc-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lfc button { height: 32px; padding: 0 14px; font: inherit; font-size: 13px; border-radius: var(--dsw-radius-sm);
  cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l4);
  background: transparent; color: var(--dsw-alias-label-primary); }
.lfc button:disabled { opacity: .55; cursor: default; }
.lfc button.primary { color: var(--dsw-alias-label-primary-foreground, #fff); font-weight: 500; border-color: transparent;
  background: var(--dsw-alias-state-business-primary); }
.lfc button.primary:hover:not(:disabled) { filter: brightness(1.08); }
.lfc-pill { display: inline-flex; align-items: center; gap: 6px; padding: 1px 10px; border-radius: 999px;
  font-size: 12px; border: 0.5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.lfc-pill.on { color: var(--dsw-alias-state-success-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }
.lfc-pill.bad { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }
.lfc-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.lfc-note { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.lfc-err { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.lfc-out { margin: 0; padding: 10px 12px; max-height: 180px; overflow: auto; min-width: 0;
  font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap;
  word-break: break-word; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-sm); }
.lfc-kv { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12.5px; min-width: 0; }
.lfc-kv > span:first-child { flex: none; color: var(--dsw-alias-label-secondary); }
.lfc-kv > span:last-child { font-family: ui-monospace, Menlo, monospace; word-break: break-all;
  color: var(--dsw-alias-label-primary); }
@media (max-width: 560px) { .lfc-grid { grid-template-columns: 1fr; } }
`;

    /** API endpoint, resolved against the document so a mounted GUI still works. */
    function apiUrl() {
      return new URL("llm-failure-command/api/state", document.baseURI).href;
    }

    /** Render a stored timestamp as a coarse "how long ago". */
    function relativeTime(ms) {
      if (!ms) return "";
      const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (seconds < 60) return "刚刚";
      if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
      return `${Math.floor(seconds / 86400)} 天前`;
    }

    /** The settings page: the switch, the command, its limits, and the last run. */
    function LlmFailureCommand() {
      const [snapshot, setSnapshot] = useState(null);
      const [draft, setDraft] = useState({
        enabled: true, command: "", deviceSerial: "", port: "", timeoutMs: "", maxRetries: "",
      });
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");

      /** Pending auto-save for the text fields. */
      const saveTimer = useRef(undefined);
      const draftRef = useRef(draft);
      draftRef.current = draft;
      /** True while the operator has edits that are not saved yet. */
      const dirty = useRef(false);

      /**
       * Adopt a host snapshot.
       *
       * The form follows the host whenever the operator is not editing it, so
       * reopening the page always shows the stored configuration.
       */
      const applySnapshot = useCallback((next) => {
        setSnapshot(next);
        if (dirty.current) return;
        setDraft({
          enabled: next.config.enabled,
          command: next.config.command,
          deviceSerial: next.config.deviceSerial,
          port: String(next.config.port),
          timeoutMs: String(next.config.timeoutMs),
          maxRetries: String(next.config.maxRetries),
        });
      }, []);

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(apiUrl(), { headers: { accept: "application/json" } });
          if (!response.ok) return;
          applySnapshot(await response.json());
        } catch {
          // Keep the last known state; the next poll retries.
        }
      }, [applySnapshot]);

      /** Send one patch. A rejected field leaves the draft for correction. */
      const save = useCallback(async (patch, options = {}) => {
        try {
          const response = await fetch(apiUrl(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(patch),
          });
          const payload = await response.json();
          if (!response.ok) {
            setError(payload.error ?? "保存失败");
            return null;
          }
          setError("");
          if (options.announce === true) {
            setNotice("已保存");
            window.setTimeout(() => setNotice(""), 1600);
          }
          dirty.current = false;
          applySnapshot(payload);
          return payload;
        } catch (err) {
          setError(err?.message || "无法访问插件接口");
          return null;
        }
      }, [applySnapshot]);

      const scheduleSave = useCallback(() => {
        if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = undefined;
          const current = draftRef.current;
          void save({
            command: current.command,
            deviceSerial: current.deviceSerial,
            port: current.port,
            timeoutMs: current.timeoutMs,
            maxRetries: current.maxRetries,
          });
        }, 700);
      }, [save]);

      /** Run the command now, so the operator can verify it before relying on it. */
      const runNow = useCallback(async () => {
        setBusy(true);
        setError("");
        try {
          await save({ action: "test" });
        } finally {
          setBusy(false);
        }
      }, [save]);

      /** Restore the shipped defaults. */
      const reset = useCallback(async () => {
        setBusy(true);
        setError("");
        dirty.current = false;
        try {
          await save({ action: "reset" }, { announce: true });
        } finally {
          setBusy(false);
        }
      }, [save]);

      /** The switch applies immediately: a disabled plugin needs no debounce. */
      const toggle = useCallback((enabled) => {
        dirty.current = true;
        setDraft((current) => ({ ...current, enabled }));
        void save({ enabled });
      }, [save]);

      const edit = (field, value) => {
        dirty.current = true;
        setDraft((current) => ({ ...current, [field]: value }));
        scheduleSave();
      };

      useEffect(() => {
        void refresh();
        // A failed run's outcome is worth seeing without a manual reload.
        const timer = window.setInterval(() => { void refresh(); }, 2500);
        return () => window.clearInterval(timer);
      }, [refresh]);

      useEffect(() => () => {
        if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
      }, []);

      if (snapshot === null) {
        return h("div", { className: "lfc" }, h("style", null, CSS), h("p", null, "加载中…"));
      }

      const { runtime, status, limits } = snapshot;
      const last = runtime.lastRun;
      const running = runtime.running;

      const statusCard = h("div", { className: "lfc-card" },
        h("div", { className: "lfc-row" },
          h("span", null, "状态"),
          h("span", { className: "lfc-pill " + (snapshot.config.enabled ? "on" : "") },
            h("span", { className: "lfc-dot" }),
            snapshot.config.enabled ? "已启用" : "未启用")),
        h("div", { className: "lfc-kv" },
          h("span", null, "已触发"),
          h("span", null, `${runtime.driven} 次`)),
        h("div", { className: "lfc-kv" },
          h("span", null, "成功重试"),
          h("span", null, `${runtime.recovered} 次`)),
        runtime.exhausted > 0
          ? h("div", { className: "lfc-kv" },
              h("span", null, "命令失败"),
              h("span", null, `${runtime.exhausted} 次`))
          : null,
        runtime.recovered === 0 && runtime.driven === 0
          ? h("p", { className: "lfc-note" }, "尚未触发过。模型调用失败时会自动执行下面的命令并重试请求。")
          : null);

      const form = h("div", { className: "lfc-card" },
        h("label", { className: "lfc-row" },
          h("span", null, "模型调用失败时自动执行命令"),
          h("span", { className: "lfc-toggle" },
            h("input", {
              type: "checkbox",
              checked: draft.enabled,
              disabled: busy,
              onChange: (event) => toggle(event.currentTarget.checked),
            }),
            h("i", null))),
        h("div", { className: "lfc-grid" },
          h("div", { className: "lfc-field" },
            h("span", null, "设备序列号（可选）"),
            h("input", {
              type: "text",
              value: draft.deviceSerial,
              spellCheck: false,
              autoComplete: "off",
              placeholder: "留空表示当前唯一的设备",
              onChange: (event) => edit("deviceSerial", event.currentTarget.value),
            }),
            h("span", { className: "lfc-note" },
              "adb devices 里那一列。多台设备时必填，单台可留空。")),
          h("div", { className: "lfc-field" },
            h("span", null, "本地端口"),
            h("input", {
              type: "number",
              value: draft.port,
              min: limits.port.min,
              max: limits.port.max,
              step: 1,
              disabled: busy,
              onChange: (event) => edit("port", event.currentTarget.value),
            }),
            h("span", { className: "lfc-note" },
              "模型代理监听的端口，转发到的手机端口与之相同。"))),
        h("div", { className: "lfc-field" },
          h("span", null, "要执行的命令"),
          h("input", {
            type: "text",
            value: draft.command,
            spellCheck: false,
            autoComplete: "off",
            placeholder: snapshot.effectiveCommand,
            onChange: (event) => edit("command", event.currentTarget.value),
          }),
          h("span", { className: "lfc-note" },
            draft.command.trim() === ""
              ? `留空则按上面的序列号和端口拼出：${snapshot.effectiveCommand}`
              : "已手动指定命令，上面的序列号与端口不再参与拼装。原样交给系统 shell 执行。")),
        h("div", { className: "lfc-grid" },
          h("div", { className: "lfc-field" },
            h("span", null, "命令超时（毫秒）"),
            h("input", {
              type: "number",
              value: draft.timeoutMs,
              min: limits.timeoutMs.min,
              max: limits.timeoutMs.max,
              step: 500,
              disabled: busy,
              onChange: (event) => edit("timeoutMs", event.currentTarget.value),
            })),
          h("div", { className: "lfc-field" },
            h("span", null, "每次失败最多重试"),
            h("input", {
              type: "number",
              value: draft.maxRetries,
              min: limits.maxRetries.min,
              max: limits.maxRetries.max,
              step: 1,
              disabled: busy,
              onChange: (event) => edit("maxRetries", event.currentTarget.value),
            }))),
        h("div", { className: "lfc-actions" },
          h("button", {
            type: "button",
            className: "primary",
            disabled: busy || running,
            onClick: () => { void runNow(); },
          }, running ? "执行中…" : "立即执行一次"),
          h("button", {
            type: "button",
            disabled: busy || running,
            onClick: () => { void reset(); },
          }, "恢复默认"),
          notice !== "" ? h("span", { className: "lfc-note" }, notice) : null),
        error !== "" ? h("div", { className: "lfc-err" }, error) : null);

      const lastCard = last === null
        ? null
        : h("div", { className: "lfc-card" },
            h("div", { className: "lfc-row" },
              h("span", null, "最近一次执行"),
              h("span", { className: "lfc-pill " + (last.ok ? "on" : "bad") },
                h("span", { className: "lfc-dot" }),
                last.ok ? "成功" : last.timedOut ? "超时" : last.aborted ? "已取消" : `退出码 ${String(last.code)}`)),
            h("div", { className: "lfc-kv" },
              h("span", null, "时间"),
              h("span", null, `${relativeTime(last.at)} · ${String(last.durationMs)}ms`)),
            h("div", { className: "lfc-kv" },
              h("span", null, "触发"),
              h("span", null, last.reason === "manual" ? "手动执行" : last.reason)),
            last.stdout !== "" ? h("pre", { className: "lfc-out" }, last.stdout) : null,
            last.stderr !== "" ? h("pre", { className: "lfc-out" }, last.stderr) : null);

      return h("div", { className: "lfc" },
        h("style", null, CSS),
        h("h3", null, "模型调用失败恢复"),
        h("p", null,
          "当模型调用因为连接类错误失败时，先执行下面这条命令，再重试同一次请求。适合用来恢复 adb 端口转发之类的外部依赖。"),
        statusCard,
        form,
        lastCard,
        h("p", { className: "lfc-note" }, `配置文件：${status.path}`));
    }

    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "llm-failure-command",
          order: 66,
          label: "模型调用失败恢复",
        }, LlmFailureCommand));
      },
    };
  },
});
