# 模型调用失败恢复（llm-failure-command）

当 DSH 的模型调用因为连接类错误失败时，自动执行一条可配置的命令，然后重试同一次请求。

典型的用法是恢复 adb 端口转发：本机的模型代理监听 `33377` 端口，通过 adb forward 映射到手机上的服务。转发一旦断开，之后每一次模型调用都会失败，而修复动作就是重新执行一次 `adb forward`。这个插件把「重连 + 重试」做成自动的：

```
模型调用失败 → 执行命令 → 成功则重试请求 → 请求通过
```

## 安装

在 DSH 的 **设置 → 插件 → 添加插件** 中填入包名：

```
@imaegoo/dsh-llm-failure-command
```

装上后在 **设置 → 模型调用失败恢复** 里配置。

## 设置

打开 **设置 → 模型调用失败恢复**。所有字段修改后立即保存，没有「保存」按钮。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 关闭后插件完全不介入，失败照常抛出 |
| 设备序列号 | 空 | `adb devices` 第一列的那个序列号；单台设备可留空，多台时必填 |
| 本地端口 | `33377` | 模型代理监听的端口，转发到的手机端口与之相同 |
| 要执行的命令 | 空 | 留空则用上面两项拼出 `adb [-s 序列号] forward tcp:<端口> tcp:<端口>`；填写则忽略上面两项，原样交给系统 shell 执行 |
| 命令超时 | 15000 ms | 超时后会连同子进程树一起结束 |
| 每次失败最多重试 | 1 | 同一个 step 内最多触发几次修复；`0` 等同于关闭 |

序列号和端口是分开的字段，所以换手机或换端口时改一个字段就行，不用重写整条命令。需要做别的事情（重启服务、重连隧道等）时，把「要执行的命令」填上，它优先于序列号和端口。

页面上的 **立即执行一次** 会真实跑一次命令并显示输出，方便先确认命令本身可用；**恢复默认** 把所有项还原。

配置存放在 `~/.dsh/llm-failure-command.json`（可用 `DSH_HOME` 覆盖目录）。

> 序列号会进入 shell，所以只接受字母、数字、点、下划线、冒号和连字符。含引号或分号的值会被拒绝，而不是转义后拼进去。

## 哪些失败会触发

只有连接类错误才会触发，因为这些才是重跑命令能修好的：

`TRANSPORT`、`TIMEOUT`、`SERVER`、`RATE_LIMIT`、`UNKNOWN`、`PI_AI_ERROR`

**不会**触发的是配置类错误——`AUTH`、`INVALID_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`、`INVALID_REQUEST` 等。同一次请求再发一遍仍然会失败，执行命令只会白等。

## 实现要点

- 挂的是 `agent/request-error` 瀑布钩子。返回 `{ kind: "retry" }` 会让 agent loop 重开 step、重新发起这次请求；返回 `undefined` 则保持失败终止。
- 用 `prepend: true` 注册。内置的 `@deepseek-ai/dsh-llm-retry` 也监听同一个钩子，而对 `TRANSPORT` 这类可重试错误码它**不会**先问下一个监听器，而是自己先退避重试 5 次（500ms→10s）。如果排在它后面，修复动作要等好几分钟才轮到。
- 命令失败时不声称修复成功，直接 `next()` 把决定权交回去，保留原本的失败信息。
- 每个 step 的尝试次数有上限，避免命令无效时无限重试；`session/event` 的 `step/start` 与 `turn/end` 会重置该 session 的计数。
- 命令用 `spawn(command, { shell: true })` 执行。这样 Windows 上走的是 `cmd.exe /d /s /c <命令>` 且不重新转义引号，命令行原样到达 shell；超时时用 `taskkill /T` 结束整个进程树。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主插件：钩子、命令触发、设置 HTTP 接口 |
| `lib/config.js` | `~/.dsh/llm-failure-command.json` 的读写与校验 |
| `lib/run-command.js` | 带超时的单次命令执行 |
| `lib/client.js` | 设置页（`settings.section` 槽位） |
| `test/harness.mjs` | 离线单测：命令执行、配置、钩子决策、设置接口、客户端包 |
| `test/e2e-cordis.mjs` | 真实 Cordis 端到端：验证 `prepend` 顺序，以及「修复后请求成功」 |
| `test/render.mjs` | 用最小 React 替身渲染真实设置页，检查字段、开关、按钮与错误提示 |

## 测试

```bash
npm test          # harness + render
```

`test/e2e-cordis.mjs` 需要一份解包出来的 DSH 运行时，默认指向本机路径；改路径见文件开头的 `DSH_MODULES`：

```bash
node test/e2e-cordis.mjs
```
