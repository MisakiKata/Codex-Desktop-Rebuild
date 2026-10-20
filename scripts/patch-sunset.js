/**
 * Post-build patch: Disable appSunset forced-update gate
 *
 * Codex uses a Statsig gate to control version sunsetting.
 * When the gate returns true, a full-screen "Update Required" overlay blocks the UI.
 *
 * AST match: find functions containing the sunset i18n key "appSunset",
 * then locate gate checker calls identifier(`numericString`) within them,
 * and replace with !1 (false).
 *
 * Usage:
 *   node scripts/patch-sunset.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-sunset.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

// Structural markers for sunset functions (i18n keys present in the sunset UI)
const SUNSET_MARKERS = ["appSunset", "app.sunset", "sunset"];

/**
 * Detect the "sunset gate guard" component shape used by newer builds:
 *
 *   function Guard({children}) {
 *     let t = memo(...), {children:n} = e;
 *     if (Gate(`2929582856`)) { ... return jsx(SunsetView, {}) ... }
 *     let r;
 *     return memo(() => jsx(Fragment, {children: n}), ...), r;
 *   }
 *
 * Tight signature (all three must hold on the SAME function):
 *   1. destructures `children` from its props parameter,
 *   2. contains an `if (<numeric gate call>)` statement,
 *   3. renders Fragment{children} in the fall-through path.
 */
function looksLikeGuardComponent(node, source) {
  if (
    node.type !== "FunctionDeclaration" &&
    node.type !== "FunctionExpression" &&
    node.type !== "ArrowFunctionExpression"
  )
    return false;

  const body = node.body;
  if (!body || body.type !== "BlockStatement") return false;
  const src = source.slice(node.start, node.end);

  // (1) destructures children out of a parameter: {children: X} = e
  let destructuresChildren = false;
  walk(node, (c) => {
    if (c.type !== "ObjectPattern") return;
    for (const prop of c.properties || []) {
      if (prop.type !== "Property") continue;
      const key = prop.key?.name ?? prop.key?.value;
      if (key === "children" && prop.value?.type === "Identifier") {
        destructuresChildren = true;
      }
    }
  });
  if (!destructuresChildren) return false;

  // (2) if (<numeric gate call>) — the gate must be the if-test itself
  let guardedGate = null;
  walk(node, (c) => {
    if (c.type !== "IfStatement") return;
    const t = c.test;
    if (t?.type !== "CallExpression") return;
    if (t.callee?.type !== "Identifier") return;
    if (t.arguments?.length !== 1) return;
    const v = getLiteralValue(t.arguments[0]);
    if (v && /^\d{6,}$/.test(v)) guardedGate = t;
  });
  if (!guardedGate) return false;

  // (3) fall-through renders Fragment{children: ...}
  if (!/Fragment\s*,\s*\{\s*children\s*:/.test(src)) return false;

  return true;
}

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

function collectPatches(ast, source) {
  const allPatches = [];

  // Strategy A — a function that both renders the sunset UI and calls a gate.
  // (older builds: if (gate("2929582856")) return <Sunset/> inside one function)
  walk(ast, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    )
      return;

    const funcSrc = source.slice(node.start, node.end);
    if (!SUNSET_MARKERS.some((m) => funcSrc.includes(m))) return;

    // Only short-circuit gate calls that actually guard a branch. Replacing
    // every numeric call in the function would disable unrelated feature gates.
    const testRanges = [];
    walk(node, (child) => {
      if (
        (child.type === "IfStatement" || child.type === "ConditionalExpression") &&
        child.test
      ) {
        testRanges.push([child.test.start, child.test.end]);
      }
    });

    walk(node, (child) => {
      if (child.type !== "CallExpression") return;
      if (child.callee?.type !== "Identifier") return;
      if (child.arguments?.length !== 1) return;
      if (
        !testRanges.some(
          ([start, end]) => child.start >= start && child.end <= end,
        )
      )
        return;

      const argVal = getLiteralValue(child.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(argVal)) return;

      const callSrc = source.slice(child.start, child.end);
      if (callSrc === "!1") return;

      if (!allPatches.some((x) => x.start === child.start)) {
        allPatches.push({
          start: child.start,
          end: child.end,
          replacement: "!1",
          original: callSrc,
        });
      }
    });
  });

  // Strategy B — newer builds split it into a guard component that holds only
  // the gate call, while the sunset view holds the i18n markers. Match the guard
  // structurally (numeric gate + Fragment-renders-children) and short-circuit it.
  walk(ast, (node) => {
    if (!looksLikeGuardComponent(node, source)) return;

    // Replace ONLY the gate call that is the if-test, so unrelated feature
    // gates coexisting in the same component stay intact.
    walk(node, (child) => {
      if (child.type !== "IfStatement") return;
      const t = child.test;
      if (t?.type !== "CallExpression") return;
      if (t.callee?.type !== "Identifier") return;
      if (t.arguments?.length !== 1) return;
      const argVal = getLiteralValue(t.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(argVal)) return;

      const callSrc = source.slice(t.start, t.end);
      if (callSrc === "!1") return;
      if (allPatches.some((x) => x.start === t.start)) return;

      allPatches.push({
        start: t.start,
        end: t.end,
        replacement: "!1",
        original: callSrc,
      });
    });
  });

  return allPatches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  // The sunset gate moved out of index-*.js into the lazily-loaded app shell
  // chunk (app-initial-*.js in 26.1013+). Scan every JS chunk instead of
  // guessing the filename, but skip i18n locale bundles which are pure strings.
  const LOCALE_RE =
    /^(am|ar|bg|bn|bs|ca|cs|da|de|el|en|es|et|fa|fil|fi|fr|gu|hi|hr|hu|hy|id|is|it|ja|ka|kk|kn|ko|lt|lv|mk|ml|mn|mr|ms|my|nb|nl|no|pa|pl|pt|ro|ru|sk|sl|so|sq|sr|sv|sw|ta|te|th|tl|tr|uk|ur|vi|zh)-/;

  const bundles = [];
  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      if (LOCALE_RE.test(f)) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes("appSunset") || src.includes("app.sunset")) {
        bundles.push({ platform: plat, path: fp });
      }
    }
  }

  if (bundles.length === 0) {
    console.log("[ok] No chunk contains appSunset markers (gate may be absent upstream)");
    return;
  }

  let totalPatched = 0;
  let failed = false;

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      if (source.includes("2929582856")) {
        console.error(
          "   [x] sunset gate 2929582856 still present but no patch matched; upstream shape changed?",
        );
        failed = true;
      } else if (!SUNSET_MARKERS.some((m) => source.includes(m))) {
        console.log("   [!] No sunset markers found in bundle");
      } else {
        console.log("   [ok] Sunset gate already disabled or no gate call found");
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Sunset gate disabled: ${patches.length} gate calls -> !1`);
    totalPatched += patches.length;

    if (code.includes("2929582856")) {
      console.error("   [x] sunset gate ID still present after patch");
      failed = true;
    }
  }

  if (!isCheck) {
    console.log(`\n== Total: ${totalPatched} gate call(s) short-circuited ==`);
  }

  if (failed) process.exit(1);
}

main();
