# Codex Desktop Rebuild

对 [Codex 桌面端](https://openai.com/codex/)（Electron）做构建期补丁，解锁被云控和平台限制的功能。

上游把若干能力锁在 Statsig 云控 gate、平台判断和账号类型后面。本项目在**打包阶段**直接改写产物里的判断，让它们无条件生效。

部分补丁思路参考自 [Haleclipse/CodexDesktop-Rebuild](https://github.com/Haleclipse/CodexDesktop-Rebuild)。

## 补丁

按 `scripts/patch-all.js` 的顺序执行，共 9 个：

| 补丁 | 作用 |
|---|---|
| `patch-sunset.js` | **关闭启动强制更新门控**。Statsig gate `2929582856` 为真时会盖全屏 "Update required" 遮罩，UI 完全不可用。缺失此补丁软件打不开。 |
| `patch-proxy.js` | **网络代理支持**（见下方专节）。上游忽略 `[network]` 配置段，此补丁让一份配置同时驱动 Chromium 层与子进程层。 |
| `patch-gpu.js` | Intel 集显 Mac（x64）强制使用独显，修复 Chromium 合成器的渲染异常。 |
| `patch-i18n.js` | 强制启用多语言，把 Statsig layer 的 `enable_i18n` 写死为 true，避免服务端下发关闭。 |
| `patch-devtools.js` | 强制开启 DevTools 与元素检查。 |
| `patch-plugin-auth.js` | 解除功能门控：`browserPane` / `computerUse` / `control` / `multiWindow` 等默认关闭的特性改为开启；绕过 bundled 插件的 `isAvailable` 过滤与 browser-use 原生管道的代码签名校验。 |
| `patch-updater.js` | 关闭自动更新，防止补丁产物被官方更新覆盖。 |
| `patch-websearch-mcp.js` | 让 `web_search` 对第三方 provider 的模型生效。上游在渲染层 `Crn()` 设了三道门控（`model_provider !== "openai"`、模型名不以 `gpt-` 开头、配了 `model_catalog_json`），配了第三方 API 后三道全中导致 web_search 失效。 |

`patch-util.js` 是共享的 bundle 定位工具，`patch-report.js` 生成本地补丁报告。

### 实现方式

补丁分两类：

- **AST 定位**（`sunset` / `devtools` / `updater` / `gpu`）—— 用 acorn 解析后按 `node.start/end` 替换，上游重新打包导致变量名变化时仍能正确定位。replacement 与原文等长（`!0` / `!1`），偏移不会错位。
- **锚点字符串替换**（`proxy` / `i18n` / `plugin-auth` / `websearch-mcp`）—— 依赖上游代码里的唯一锚点。

所有补丁幂等，重复执行不会叠加。

## 网络代理

上游**完全忽略** `[network]` 配置段 —— 逆向确认 `resolveProxy` 相关逻辑为零，纯走 Chromium 默认解析。`patch-proxy.js` 让一份配置同时驱动两层网络：

| 层 | 机制 | 覆盖 |
|---|---|---|
| Chromium | `commandLine.appendSwitch('proxy-server')` | 主进程 + 渲染进程 |
| 子进程 | `process.env.HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | `codex.exe`（Rust）、shell（git/curl）等 |

配置写在现有的 Codex 配置文件里，不需要额外文件：

```toml
# ~/.codex/config.toml
[network]
proxy_enabled = true
proxy_server = "127.0.0.1:10809"
proxy_protocol = "http"          # http | socks5 | socks5h | socks4
proxy_bypass = ["localhost", "127.0.0.1", "<local>"]
```

两个实现要点：

- 注入点是 `early-bootstrap.js` 的模块顶层、`require("electron")` 之后 —— 必须在 `app.whenReady()` **之前**，那是 Chromium 接受 proxy switch 的唯一窗口。
- 子进程不需要额外处理，上游已有 env 白名单会把代理变量转发给 spawn 的进程。

缺段或 `proxy_enabled = false` 时静默降级为直连。

## 第三方 API

除补丁外，本项目还支持把模型请求指向第三方 provider（DeepSeek、Kimi、智谱等）。

模型清单走上游原生的 `model_catalog_json` 机制，**不需要补丁**，建议固定**`custom`**，便于归档会话显示：
```toml
# ~/.codex/config.toml
model_provider = "custom"
model_catalog_json = "~/.codex/model-catalog.json"

[model_providers.custom]
name = "DeepSeek"
base_url = "https://api.deepseek.com"
wire_api = "responses"
env_key = "DEEPSEEK_API_KEY"
```

完整的 catalog schema、字段说明与常见错误对照见
[`docs/third-party-provider.toml.example`](docs/third-party-provider.toml.example)。

**两个已知边界**：

- 顶层 `model_provider` 是单值而非 map，**不支持 per-model provider** —— 不能「列表里混着官方和第三方、选谁走谁」。不设它则强制走 ChatGPT 账号通道，第三方模型会被服务器拒绝。
- `web_search` 的 MCP 端点仍在 `chatgpt.com`（Rust 侧写死），所以效果是「第三方模型也能用官方的 web_search」，要求账号保持 ChatGPT 登录。

## 构建

```bash
npm install
npm run sync          # 拉取上游包并解出 src/{platform}/
npm run patch:win     # 或 patch:mac
npm run build:win-x64
```

产物在 `out/`。

> **不要放在 `Downloads` 目录下运行。** Windows 的受控文件夹访问会限制 Chromium
> 沙箱子进程的文件操作，表现为启动后卡在「无法加载组织设置」。

宿主二进制是 `ChatGPT.exe`（不是 20KB 的 `Codex.exe` launcher），asar 完整性哈希写在它的内嵌清单里，构建时会自动同步。

## 说明

- 本项目与 OpenAI 无关，是其桌面端客户端的第三方修改版。
- `scripts/certs/` 下是微软公开发布的根 CA 证书（纯公钥，无私钥），用于校验 MSIX 签名。
- `scripts/STATSIG_GATES.md` 记录从客户端 bundle 提取的 Statsig gate ID 映射，是补丁的依据。
- 补丁面向跨平台共用逻辑（AST 改写），macOS / Linux 走同样的流程；目前仅在 Windows x64 上实测。
