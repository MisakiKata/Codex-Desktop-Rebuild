#!/usr/bin/env node
/**
 * patch-websearch-mcp.js — 让 web_search 的 MCP 上下文对第三方模型生效
 *
 * 背景
 * ----
 * Codex 的 web_search 不是普通工具，而是一个走 chatgpt.com 后端 MCP 的
 * searchMcpContext。上游把它锁死在「官方模型」上，函数 `Crn()` 里有
 * 两道门控：
 *
 *   1. `model_provider !== "openai"` → 直接放弃
 *   2. 模型名不以 `gpt-` 开头 → 直接放弃
 *
 * 配了第三方 provider + model_catalog_json 后，两道都命中，web_search 完全失效。
 *
 * 改法
 * ----
 * 只松这两道门控，其余判断（账号类型、app-server 版本、web_search 开关等）
 * 全部保留 —— 上游仍然可以自己用 `web_search` 配置项关掉它。
 *
 * 注意：这会让 searchMcpContext 仍然走 chatgpt.com 的官方 MCP 端点
 * （路径写死在 Rust 侧），所以效果是「第三方模型也能用官方 web_search」，
 * 而不是「让第三方 provider 提供 web_search」。已实测通。
 *
 *   node scripts/patch-websearch-mcp.js [platform]
 *   node scripts/patch-websearch-mcp.js [platform] --check
 */
const fs = require("fs");
const path = require("path");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const MARKER = "[CodexWebSearchMCP]";

/**
 * 门控 1：provider 必须是 openai。
 * 改为恒 false，即不再因 provider 而禁用。
 *
 *   原文： (e.modelProvider??s(`model_provider`)??`openai`)!==`openai`
 *   改成： !1
 */
const GATE_PROVIDER_ORIG =
  "(e.modelProvider??s(`model_provider`)??`openai`)!==`openai`";

const GATE_PROVIDER_PATCHED =
  `(!1/* ${MARKER} provider gate relaxed */)`;

/**
 * 门控 2：模型名必须以 gpt- 开头。
 * 改为恒 false，让 deepseek-* 等第三方模型也能进入后续逻辑。
 *
 *   原文： typeof u!==`string`||!u.startsWith(`gpt-`)||u.includes(`law`)||...
 *   改成： typeof u!==`string`||!1||u.includes(`law`)||...
 */
const GATE_MODEL_ORIG =
  "!u.startsWith(`gpt-`)||u.includes(`law`)";

const GATE_MODEL_PATCHED =
  `!1/* ${MARKER} model-name gate relaxed */||u.includes(\`law\`)`;

/**
 * 门控 3：配了 model_catalog_json 就禁用。
 * catalog 是上游官方的自定义模型目录机制，不应成为 web_search 的禁用条件。
 */
const GATE_CATALOG_ORIG = "s(`model_catalog_json`)!=null";
const GATE_CATALOG_PATCHED = `(!1/* ${MARKER} catalog gate relaxed */)`;

const GATES = [
  {
    name: "provider 门控",
    orig: GATE_PROVIDER_ORIG,
    patched: GATE_PROVIDER_PATCHED,
    marker: `${MARKER} provider gate relaxed`,
  },
  {
    name: "模型名门控",
    orig: GATE_MODEL_ORIG,
    patched: GATE_MODEL_PATCHED,
    marker: `${MARKER} model-name gate relaxed`,
  },
  {
    name: "catalog 门控",
    orig: GATE_CATALOG_ORIG,
    patched: GATE_CATALOG_PATCHED,
    marker: `${MARKER} catalog gate relaxed`,
  },
];

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "assets",
    pattern: /^app-initial-.*\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    const platformDirs = ["mac-arm64", "mac-x64", "win"].filter((p) =>
      fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
    );
    if (platformDirs.length > 0) {
      console.error(
        `[x] app-initial-*.js not found in ${platformDirs.join(", ")}; upstream layout changed?`,
      );
      process.exit(1);
    }
    console.log("[skip] no platform assets present");
    return;
  }

  let total = 0;
  let failed = false;

  for (const b of bundles) {
    const source = fs.readFileSync(b.path, "utf8");
    console.log(`\n-- [${b.platform}] ${relPath(b.path)}`);
    console.log(`   size: ${(source.length / 1048576).toFixed(1)} MB`);

    let code = source;
    let hits = 0;

    for (const g of GATES) {
      // Each gate has its own marker. Do not skip the whole file when only one
      // gate was applied by an earlier (possibly partial) run.
      if (code.includes(g.marker)) {
        console.log(`   [ok] ${g.name}: already patched`);
        continue;
      }

      const n = code.split(g.orig).length - 1;
      if (n === 0) {
        console.error(`   [x] ${g.name}: 未命中且无已补丁标记，上游可能已改`);
        failed = true;
        continue;
      }

      code = code.split(g.orig).join(g.patched);
      hits += n;
      console.log(`   [${isCheck ? "?" : "ok"}] ${g.name}: ${n} 处`);
    }

    if (hits === 0) continue;

    if (isCheck) {
      total += hits;
      continue;
    }

    fs.writeFileSync(b.path, code, "utf8");
    console.log(`   [ok] patched ${hits} site(s)`);
    total += hits;
  }

  if (isCheck) console.log(`\n== Total: ${total} match(es) ==`);
  else console.log(`\n== Total: ${total} site(s) patched ==`);

  if (failed) process.exit(1);
}

main();