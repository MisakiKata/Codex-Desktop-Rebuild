#!/usr/bin/env node
/**
 * patch-unified-sessions.js — 统一会话列表 + 自动切换 provider
 *
 * 目标
 * ----
 * 官方订阅和第三方 API 的会话在同一个列表里可见，且切换时不用手改 config.toml。
 *
 * 背景（来自 CC Switch 的 codex-unified-session-history-guide）
 * --------------------------------------------------------
 * Codex 的历史列表只显示与当前激活 provider 同标签的会话，
 * 标签 = state_5.sqlite 的 threads.model_provider。
 * 把官方(openai)和第三方(deepseek 等)的标签统一成一个名字，
 * 两个"抽屉"就合并成一个共享列表。
 *
 * 本补丁做三件事
 * --------------
 * ① 数据统一（tools/unify-session-provider.js，一次性，已完成）
 *    把所有 threads.model_provider 和 jsonl session_meta.model_provider
 *    统一改成 "custom"
 *
 * ② 归档列表补 modelProviders
 *    归档列表走 app-initial @10462409 这段，不传 modelProviders 时
 *    app-server 会过滤到 0 条（统一标签后实测）。补上传参。
 *
 * ③ 自动维护 [model_providers.custom]
 *    官方登录时这段配置本来不存在，需要补上才能让标签匹配。
 *    补丁挂钩 UI 选模型的入口（writeModel），自动写这段：
 *
 *    model 是 gpt-*  → 写官方配置（requires_openai_auth = true）
 *    model 是其他   → 写第三方配置（沿用 config 里 deepseek 段的 base_url）
 *
 *    用户只管在 UI 里选模型，不用手动改 config.toml。
 *
 * 已知限制（上游设计，非本补丁引入）
 * ---------------------------------
 * 跨 provider 续聊会失败：encrypted_content 只有当初生成它的后端能解密。
 * 原始 jsonl 仍完整可读，只是不能接着聊。
 *
 * 用法：
 *   node scripts/patch-unified-sessions.js [platform]
 *   node scripts/patch-unified-sessions.js [platform] --check
 */
const fs = require("fs");
const { locateBundles, relPath } = require("./patch-util");

const MARKER = "[CodexUnifiedSessions]";
const VER = "v1";

/** 归档列表的真实调用点（全文件唯一出现） */
const ORIG_ARCHIVED =
  "s.sendRequest(`thread/list`,{archived:!0,cursor:n,limit:50,sortKey:`updated_at`,useStateDbOnly:!0})";

const PATCHED_ARCHIVED =
  "s.sendRequest(`thread/list`,{archived:!0,cursor:n,limit:50,sortKey:`updated_at`,useStateDbOnly:!0," +
  "modelProviders:await globalThis[\"" + MARKER + "Providers\"](s)})";

/** UI 选模型的唯一入口 */
const ORIG_WRITE_MODEL =
  "writeModel(t,n,r){return e.sendRequest(`config/batchWrite`,a1t(t,n,r))}";

const PATCHED_WRITE_MODEL =
  "writeModel(t,n,r){var __p=e.sendRequest(`config/batchWrite`,a1t(t,n,r));" +
  "try{globalThis[\"" + MARKER + "AutoSwitch\"](e).catch(function(){})}catch(_){}" +
  "return __p}";

/**
 * HELPER 用单个模板字符串写，避免数组拼接时花括号错位。
 * 挂在 globalThis 上：那段代码位于 class 体内，类体方法之间不能放函数声明。
 */
const HELPER = `
globalThis["${MARKER}Providers"] = async function(__rc) {
  var __tp = [];
  try {
    var __c = await __rc.sendRequest("config/read", {cwd:null, includeLayers:false});
    var __cfg = __c && __c.config;
    if (__cfg) {
      if (typeof __cfg.model_provider === "string" && __cfg.model_provider) __tp.push(__cfg.model_provider);
      var __mp = __cfg.model_providers;
      if (__mp && typeof __mp === "object") {
        for (var __k of Object.keys(__mp)) { if (__k && __tp.indexOf(__k) < 0) __tp.push(__k); }
      }
    } else {
      if (__c && typeof __c.model_provider === "string") __tp.push(__c.model_provider);
      var __mp2 = __c && __c.model_providers;
      if (__mp2 && typeof __mp2 === "object") {
        for (var __k2 of Object.keys(__mp2)) { if (__k2 && __tp.indexOf(__k2) < 0) __tp.push(__k2); }
      }
    }
  } catch (__e) { console.warn("${MARKER} config/read failed:", __e && __e.message); }
  if (__tp.length === 0) __tp = ["openai"];
  console.log("${MARKER} providers=", JSON.stringify(__tp));
  return __tp;
};

globalThis["${MARKER}AutoSwitch"] = async function(__rc) {
  try {
    var __c = await __rc.sendRequest("config/read", {cwd:null, includeLayers:false});
    var __cfg = (__c && __c.config) || __c || {};
    var __model = typeof __cfg.model === "string" ? __cfg.model : "";
    if (!__model) return;
    var __isOfficial = /^(gpt|o[0-9]|chatgpt)/i.test(__model);
    var __cur = __cfg.model_providers && __cfg.model_providers.custom;
    if (__cur) {
      if (__isOfficial && __cur.requires_openai_auth === true) return;
      if (!__isOfficial && __cur.base_url && !__cur.requires_openai_auth) return;
    }
    var __edits = [{keyPath:"model_provider", value:"custom", mergeStrategy:"upsert"}];
    if (__isOfficial) {
      __edits.push({keyPath:"model_providers.custom.name", value:"OpenAI", mergeStrategy:"upsert"});
      __edits.push({keyPath:"model_providers.custom.requires_openai_auth", value:true, mergeStrategy:"upsert"});
      __edits.push({keyPath:"model_providers.custom.supports_websockets", value:true, mergeStrategy:"upsert"});
      __edits.push({keyPath:"model_providers.custom.wire_api", value:"responses", mergeStrategy:"upsert"});
    } else {
      var __src = __cfg.model_providers && __cfg.model_providers.deepseek;
      if (!__src || !__src.base_url) return;
      __edits.push({keyPath:"model_providers.custom.name", value:__src.name || "Custom", mergeStrategy:"upsert"});
      __edits.push({keyPath:"model_providers.custom.base_url", value:__src.base_url, mergeStrategy:"upsert"});
      __edits.push({keyPath:"model_providers.custom.wire_api", value:__src.wire_api || "responses", mergeStrategy:"upsert"});
      if (__src.env_key) __edits.push({keyPath:"model_providers.custom.env_key", value:__src.env_key, mergeStrategy:"upsert"});
    }
    console.log("${MARKER} auto-switch:", __model, __isOfficial ? "official" : "third-party");
    await __rc.sendRequest("config/batchWrite", {edits:__edits, filePath:null, expectedVersion:null});
  } catch (__e) { console.warn("${MARKER} auto-switch failed:", __e && __e.message); }
};
`;

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
    console.log("[!] app-initial-*.js not found — nothing to patch");
    return;
  }

  let total = 0;
  for (const b of bundles) {
    let code = fs.readFileSync(b.path, "utf8");
    console.log(`\n-- [${b.platform}] ${relPath(b.path)}`);
    console.log(`   size: ${(code.length / 1048576).toFixed(1)} MB`);

    if (code.includes(MARKER + " " + VER)) {
      console.log("   [ok] already patched");
      total++;
      continue;
    }

    const n = code.split(ORIG_ARCHIVED).length - 1;
    if (n === 0) {
      console.log("   [!] archived thread/list call not found — upstream layout changed?");
      continue;
    }
    code = code.split(ORIG_ARCHIVED).join(PATCHED_ARCHIVED);

    const n2 = code.split(ORIG_WRITE_MODEL).length - 1;
    if (n2 === 0) {
      console.log("   [!] writeModel() not found — auto-switch skipped (not fatal)");
    } else {
      code = code.split(ORIG_WRITE_MODEL).join(PATCHED_WRITE_MODEL);
    }

    // HELPER 插到第 1 行之后（bundle 第 1 行是 const __vite__mapDeps=...，
    // 第 2 行起才是 import）。HELPER 自带首尾换行，独立成行。
    const firstNL = code.indexOf("\n");
    const impEnd = firstNL < 0 ? 0 : firstNL + 1;
    code = code.slice(0, impEnd) + HELPER + code.slice(impEnd);

    if (isCheck) {
      console.log(`   [?] ${n} site(s) would be patched`);
      total += n;
      continue;
    }

    fs.writeFileSync(b.path, code, "utf8");
    console.log(`   [ok] patched ${n} site(s)`);
    total += n;
  }

  if (isCheck) console.log(`\n== Total: ${total} match(es) ==`);
  else console.log(`\n== Total: ${total} site(s) patched ==`);
}

main();