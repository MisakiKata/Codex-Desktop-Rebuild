#!/usr/bin/env node
/**
 * Run all patch scripts in sequence.
 *
 * Usage:
 *   node scripts/patch-all.js              # Patch both platforms
 *   node scripts/patch-all.js unix         # Patch unix only
 *   node scripts/patch-all.js win          # Patch win only
 *   node scripts/patch-all.js --check      # Dry-run all
 */
const { execFileSync } = require("child_process");
const path = require("path");

const PATCHES = [
  // Must run early: the app shows a blocking "Update required" overlay when the
  // Statsig appSunset gate (2929582856) is on. Without this the build cannot start.
  "patch-sunset.js",
  // Also must run early: injects proxy config into the Electron entry point,
  // which must happen before app.whenReady() or Chromium ignores the switches.
  "patch-proxy.js",
  "patch-i18n.js",
  "patch-devtools.js",
  "patch-plugin-auth.js",
  "patch-updater.js",
  // Renderer patch: web_search's MCP context was gated to official models only.
  // Relaxes the three gates so it also works with third-party providers.
  "patch-websearch-mcp.js",
  // Removed — see README:
  //   patch-copyright.js      cosmetic only (About dialog text); keeping upstream
  //   patch-fast-mode.js      upstream dropped the auth gate; fast_mode now only
  //                           feeds the profile "Insights" usage panel
  //   patch-archive-delete.js superseded by the official delete-thread-dialog
];

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win", "unix"].includes(a));
  const extra = args.filter((a) => a.startsWith("--"));
  const passArgs = [...(platform ? [platform] : []), ...extra];

  let failed = 0;

  for (const script of PATCHES) {
    const scriptPath = path.join(__dirname, script);
    const label = script.replace(".js", "");
    console.log(`\n== ${label} ==`);

    try {
      execFileSync("node", [scriptPath, ...passArgs], { stdio: "inherit" });
    } catch (e) {
      console.error(`[x] ${label} failed (exit ${e.status})`);
      failed++;
    }
  }

  console.log(`\n== Summary: ${PATCHES.length - failed}/${PATCHES.length} succeeded ==`);
  if (failed > 0) process.exit(1);
}

main();
