#!/usr/bin/env node
/**
 * patch-updater.js — Disable Sparkle (macOS) and Windows auto-updater
 *
 * AST match: in the file containing shouldIncludeSparkle / shouldIncludeUpdater,
 * find these method definitions and replace their bodies to return false.
 *
 * Specifically targets:
 *   shouldIncludeSparkle(e,t,n){return ...}  → return !1
 *   shouldIncludeWindowsUpdater(e,t,n){return ...}  → return !1
 *   shouldIncludeUpdater(e,t,n){return ...}  → return !1
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const UPDATER_METHODS = new Set([
  "shouldIncludeSparkle",
  "shouldIncludeWindowsUpdater",
  "shouldIncludeWindowsMsixUpdater",
  "shouldIncludeUpdater",
]);

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child)
        if (item && typeof item === "object" && item.type) walk(item, visitor);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];
  const already = [];
  const unsupported = [];

  walk(ast, (node) => {
    // Match: Property with key being an updater method name and value being a function
    if (node.type !== "Property") return;
    const keyName = node.key?.name || node.key?.value;
    if (!UPDATER_METHODS.has(keyName)) return;

    const fn = node.value;
    if (fn?.type !== "FunctionExpression") {
      unsupported.push(keyName);
      return;
    }
    const body = fn.body;
    if (!body || body.type !== "BlockStatement") {
      unsupported.push(keyName);
      return;
    }
    if (body.body.length !== 1) {
      unsupported.push(keyName);
      return;
    }
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) {
      unsupported.push(keyName);
      return;
    }

    const retSrc = source.slice(ret.argument.start, ret.argument.end);
    if (retSrc === "!1") {
      already.push(keyName);
      return;
    }

    patches.push({
      id: keyName,
      start: ret.argument.start,
      end: ret.argument.end,
      replacement: "!1",
      original: retSrc.length > 50 ? retSrc.slice(0, 47) + "..." : retSrc,
    });
  });

  return { patches, already, unsupported };
}

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(buildDir)) continue;
    for (const f of fs.readdirSync(buildDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(buildDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if ([...UPDATER_METHODS].some((name) => src.includes(name))) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }
  return targets;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);
  if (targets.length === 0) {
    console.log("  [ok] No updater targets found");
    return;
  }

  let failed = false;

  for (const bundle of targets) {
    console.log(`  [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    const { patches, already, unsupported } = collectPatches(ast, source);

    if (unsupported.length > 0) {
      console.error(
        `    [x] updater method shape unsupported: ${unsupported.join(", ")}`,
      );
      failed = true;
    }

    if (patches.length === 0) {
      if (already.length > 0) {
        console.log(`    [ok] Already patched: ${already.join(", ")}`);
      } else if (unsupported.length === 0) {
        console.log("    [ok] No updater method definitions found");
      }
      continue;
    }

    if (isCheck) {
      console.log(`    [?] Matches: ${patches.length}`);
      for (const p of [...patches].reverse()) {
        console.log(`      > [${p.id}] ${p.original} -> !1`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of patches) {
      console.log(`    * [${p.id}] ${p.original} -> !1`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`    [ok] ${patches.length} updater methods disabled`);

    const after = collectPatches(
      parse(code, { ecmaVersion: "latest", sourceType: "module" }),
      code,
    );
    if (after.patches.length > 0 || after.unsupported.length > 0) {
      console.error("    [x] updater verification failed after patch");
      failed = true;
    }
  }

  if (failed) process.exit(1);
}

main();
