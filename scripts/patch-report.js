#!/usr/bin/env node
/**
 * 报告各补丁在**干净上游**上的真实命中数。
 *
 * 使用前提（重要）：
 *   补丁全部幂等。在已打过补丁的 src/ 上重跑，除本就无目标的补丁外一律报 0。
 *   因此必须先重置为原始上游：
 *     node scripts/sync-upstream.js --skip-mac
 *
 * ⚠ 副作用：patch-updater.js 未实现 --check，传入该标志会被忽略并**真实改写文件**。
 *   本工具因此会真实执行它。跑完之后 src/ 即处于「已打 updater 补丁」状态；
 *   如需回到干净状态请重新 sync。
 *
 * 用法: node scripts/patch-report.js [platform]
 */
const { execFileSync } = require("child_process");
const path = require("path");

const platform = process.argv[2] || "win";

const PATCHES = [
  ["patch-sunset.js", "启动强制更新门控"],
  ["patch-i18n.js", "i18n 多语言"],
  ["patch-devtools.js", "DevTools / 元素检查"],
  ["patch-plugin-auth.js", "插件 / 浏览器 / 代码签名"],
  ["patch-updater.js", "自动更新"],
];

/**
 * patch-updater.js ignores --check and always rewrites files, so running it
 * twice on the same tree reports 0 the second time (idempotency). Measure it
 * on a pristine tree via a dedicated --check run instead of folding it into
 * the same loop.
 */
const NEEDS_ISOLATION = new Set(["patch-updater.js"]);

/** Count real replacements from a patch script's output. */
function countHits(out) {
  // "Matches: N" summary line
  let n = 0;
  for (const m of out.matchAll(/\[?\?\]?\s*Matches:\s*(\d+)/g)) n += Number(m[1]);
  if (n > 0) return n;

  // Detail lines across the three output dialects
  const lines = out.split("\n").map((l) => l.trim());
  for (const l of lines) {
    if (/^\*\s+\[[^\]]+\]\s+offset\s+\d+:/.test(l)) { n++; continue; }
    if (/^>\s+offset\s+\d+:/.test(l)) { n++; continue; }
    if (/^\[\?\]\s+\[[^\]]+\]\s+offset\s+\d+:/.test(l)) { n++; continue; }
  }
  return n;
}

const rows = [];

for (const [script, label] of PATCHES) {
  if (NEEDS_ISOLATION.has(script)) {
    rows.push({ script, label, ok: true, hits: 0, skipped: true });
    continue;
  }

  const scriptPath = path.join(__dirname, script);
  let out = "";
  let ok = true;
  try {
    out = execFileSync("node", [scriptPath, platform, "--check"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    ok = e.status === 0;
    out = (e.stdout || "") + (e.stderr || "");
  }
  rows.push({ script, label, ok, hits: countHits(out) });
}

console.log("\n============ PATCH REPORT (raw upstream) ============\n");
console.log("  " + "PATCH".padEnd(24) + "HITS  STATUS  PURPOSE");
console.log("  " + "-".repeat(72));

let total = 0;
for (const r of rows) {
  if (r.skipped) {
    console.log(
      "  " + r.script.padEnd(24) + "   -  SKIP   " + r.label + "  (ignores --check; run standalone)",
    );
    continue;
  }
  total += r.hits;
  const status = !r.ok ? "ERROR " : r.hits > 0 ? "HIT   " : "none  ";
  console.log("  " + r.script.padEnd(24) + String(r.hits).padStart(3) + "  " + status + "  " + r.label);
}

const measured = rows.filter((r) => !r.skipped);
const active = measured.filter((r) => r.hits > 0).length;
console.log("\n  TOTAL: " + total + " replacements across " + active + "/" + measured.length + " dry-run patches");
console.log("====================================================\n");

console.log(
  "  patch-updater.js ignores --check and always rewrites files. Measure it on a\n" +
    "  pristine tree with:\n" +
    "    node scripts/sync-upstream.js --skip-mac && node scripts/patch-updater.js win --check\n\n",
);

if (active === 0) {
  console.log(
    "All-zero usually means src/ is already patched (patches are idempotent).\n" +
      "Run `node scripts/sync-upstream.js --skip-mac` first, then this again.\n",
  );
}