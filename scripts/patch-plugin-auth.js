#!/usr/bin/env node
/**
 * Post-build patch: Remove plugin auth gate + force browser-use available
 *
 * Rule 1 — Plugin auth gate (gradient-*.js or similar):
 *   AST match: function(X) { return X !== `chatgpt` }
 *   Replace expression with !1 (always allow non-chatgpt auth)
 *
 * Rule 2 — Browser/computer-use availability gates:
 *   These hooks moved into app-initial-*.js in 26.1013+.
 *   AST match: function containing featureName:`browser_use` /
 *   `browser_use_external` / `computer_use` and an is*GateEnabled helper.
 *   Replace its numeric Statsig gate calls with !0.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

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

function nodeContainsString(node, source, str) {
  return source.slice(node.start, node.end).includes(str);
}

// ── Rule 1: Plugin auth — function(e){return e!==`chatgpt`} → !1 ──

function findPluginAuthPatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "FunctionDeclaration" && node.type !== "FunctionExpression")
      return;
    const body = node.body;
    if (!body || body.type !== "BlockStatement" || body.body.length !== 1) return;
    const ret = body.body[0];
    if (ret.type !== "ReturnStatement" || !ret.argument) return;
    const arg = ret.argument;
    if (arg.type !== "BinaryExpression" || arg.operator !== "!==") return;
    if (
      getLiteralValue(arg.left) !== "chatgpt" &&
      getLiteralValue(arg.right) !== "chatgpt"
    )
      return;
    const expr = source.slice(arg.start, arg.end);
    if (expr === "!1") return;
    patches.push({
      id: "plugin_auth_gate",
      start: arg.start,
      end: arg.end,
      replacement: "!1",
      original: expr,
    });
  });
  return patches;
}

// ── Rule 6: Force /goal slash command available ──
// The goal feature is gated by: gate(ID) && config.goals === true && mode !== 'cloud'
// AST match: LogicalExpression chain containing `goals` string AND a gate call,
// replace with just the mode check (X !== `cloud`).

function findGoalGatePatches(ast, source) {
  const patches = [];
  walk(ast, (node) => {
    if (node.type !== "LogicalExpression" || node.operator !== "&&") return;
    const slice = source.slice(node.start, node.end);
    // Must contain `goals` config check and `cloud` mode check
    if (!slice.includes("`goals`") && !slice.includes('"goals"')) return;
    if (!slice.includes("`cloud`") && !slice.includes('"cloud"')) return;
    // Must contain a gate call (identifier with numeric string arg)
    let hasGateCall = false;
    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier") return;
      if (inner.arguments?.length !== 1) return;
      const val = getLiteralValue(inner.arguments[0]);
      if (val && /^\d{6,}$/.test(val)) hasGateCall = true;
    });
    if (!hasGateCall) return;
    // The rightmost operand is the mode check (X !== `cloud`).
    // In A && B && C, node.right is C.
    const right = node.right;
    const rightSrc = source.slice(right.start, right.end);
    if (!rightSrc.includes("cloud")) return;
    const fullSrc = source.slice(node.start, node.end);
    if (fullSrc === rightSrc) return;
    patches.push({
      id: "goal_gate_bypass",
      start: node.start,
      end: node.end,
      replacement: rightSrc,
      original: fullSrc.slice(0, 50) + "...",
    });
  });
  return patches;
}

/**
 * Nested `&&` chains can match at several depths. Applying every match with
 * stale offsets corrupts the file, so keep the outermost patch of each nested
 * group and drop anything that overlaps an already-kept range.
 */
function selectNonOverlapping(patches) {
  const sorted = [...patches].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  const skipped = [];
  let lastEnd = -1;
  for (const p of sorted) {
    if (p.start < lastEnd) {
      skipped.push(p);
      continue;
    }
    kept.push(p);
    lastEnd = p.end;
  }
  return { kept, skipped };
}

// ── Rule 2: Bypass Statsig gates in browser/computer-use availability hooks ──
// These hooks moved into app-initial-*.js; filename-based targeting no longer
// works. Match structurally instead: a function that declares a featureName for
// browser_use / browser_use_external / computer_use AND feeds an is*GateEnabled
// flag into its availability decision. Replace the numeric Statsig gate calls
// in that function with !0.

const AVAILABILITY_FEATURE_RE =
  /featureName\s*:\s*[`"](browser_use|browser_use_external|computer_use)[`"]/;

const AVAILABILITY_GATE_HELPERS = [
  "isBrowserAgentGateEnabled",
  "isExternalBrowserUseGateEnabled",
  "isComputerUseGateEnabled",
];

// Known IDs are only used as a post-patch sanity check, not for matching.
const KNOWN_AVAILABILITY_GATE_IDS = ["410065390", "410262010", "1506311413"];

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isAvailabilityHook(node, source) {
  if (!isFunctionNode(node)) return false;
  const slice = source.slice(node.start, node.end);
  if (!AVAILABILITY_FEATURE_RE.test(slice)) return false;
  return AVAILABILITY_GATE_HELPERS.some((h) => slice.includes(h));
}

function findAvailabilityGatePatches(ast, source) {
  const patches = [];
  const seen = new Set();

  walk(ast, (node) => {
    if (!isAvailabilityHook(node, source)) return;

    walk(node, (inner) => {
      if (inner.type !== "CallExpression") return;
      if (inner.callee?.type !== "Identifier") return;
      if (inner.arguments?.length !== 1) return;
      const argVal = getLiteralValue(inner.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(String(argVal))) return;

      const expr = source.slice(inner.start, inner.end);
      if (expr === "!0") return;

      const key = `${inner.start}:${inner.end}`;
      if (seen.has(key)) return;
      seen.add(key);

      patches.push({
        id: `statsig_gate_${argVal}`,
        start: inner.start,
        end: inner.end,
        replacement: "!0",
        original: expr,
      });
    });
  });

  return patches;
}

/** Return known availability gate IDs still present inside hook functions. */
function findRemainingHookGateIds(ast, source) {
  const ids = new Set();
  walk(ast, (node) => {
    if (!isAvailabilityHook(node, source)) return;
    const slice = source.slice(node.start, node.end);
    for (const id of KNOWN_AVAILABILITY_GATE_IDS) {
      if (slice.includes(id)) ids.add(id);
    }
  });
  return [...ids];
}

// ── Rule 4: Force default desktop feature availability to true ──
// The main process has a default features object with all values false.
// This prevents bundled plugins from being installed during early startup.
// AST match: ObjectExpression with properties like inAppBrowserUse:!1, externalBrowserUseAllowed:!1, etc.

const FEATURE_KEYS = [
  "browserPane", "inAppBrowserUse", "inAppBrowserUseAllowed",
  "externalBrowserUse", "externalBrowserUseAllowed",
  "computerUse", "computerUseNodeRepl", "control", "multiWindow",
];

function findFeatureDefaultPatches(ast, source) {
  const patches = [];

  // Part A: Force default feature values from !1 to !0
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length < 5) return;
    const keys = props.map((p) => p.key?.name || p.key?.value);
    let matchCount = 0;
    for (const k of FEATURE_KEYS) if (keys.includes(k)) matchCount++;
    if (matchCount < 3) return;

    for (const prop of props) {
      const name = prop.key?.name || prop.key?.value;
      if (!FEATURE_KEYS.includes(name)) continue;
      const val = source.slice(prop.value.start, prop.value.end);
      if (val !== "!1") continue;
      patches.push({
        id: `feature_default_${name}`,
        start: prop.value.start,
        end: prop.value.end,
        replacement: "!0",
        original: val,
      });
    }
  });

  // Part A2: Force features.js_repl to true.
  // This is a separate object {"features.js_repl":!1} that controls whether
  // the Node.js REPL (Chrome browser control) is exposed to the model.
  walk(ast, (node) => {
    if (node.type !== "ObjectExpression") return;
    const props = node.properties;
    if (!props || props.length !== 1) return;
    const prop = props[0];
    const key = prop.key?.value;
    if (key !== "features.js_repl") return;
    const val = source.slice(prop.value.start, prop.value.end);
    if (val !== "!1") return;
    patches.push({
      id: "feature_js_repl",
      start: prop.value.start,
      end: prop.value.end,
      replacement: "!0",
      original: val,
    });
  });

  // Part B: Bypass the isAvailable filter in bundled plugins descriptor.
  // Pattern: X.filter(Y => Y.isAvailable({buildFlavor:..., features:..., platform:...}))
  // The filter callback checks features like externalBrowserUseAllowed which may be
  // false at startup. Replace the callback with ()=>!0 so all plugins are included.
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    if (node.callee?.type !== "MemberExpression") return;
    if (node.callee.property?.name !== "filter") return;
    if (node.arguments?.length !== 1) return;
    const cb = node.arguments[0];
    if (cb.type !== "ArrowFunctionExpression") return;
    const cbSrc = source.slice(cb.start, cb.end);
    if (!cbSrc.includes("isAvailable")) return;
    if (!cbSrc.includes("features")) return;
    if (cbSrc === "()=>!0") return;
    patches.push({
      id: "bundled_plugins_filter_bypass",
      start: cb.start,
      end: cb.end,
      replacement: "()=>!0",
      original: cbSrc.slice(0, 40) + "...",
    });
  });

  // Part C: Bypass browser-use native pipe peer authorization.
  // The BM() function checks code signing identity via a native module.
  // Ad-hoc signed builds fail because teamId !== "2DC432GLL2" (OpenAI).
  // AST match: function containing literal "browser-use-peer-authorization.node",
  // find the IfStatement whose consequent returns ()=>({authorized:!0}) —
  // that's the bypass path — force its condition to !0.
  walk(ast, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression"
    ) return;
    const slice = source.slice(node.start, node.end);
    if (!slice.includes("shouldIncludeBrowserUsePeerAuthorization")) return;

    // Find if(...) return ()=>({authorized:!0}) — the bypass return.
    // There are multiple returns; we want the one right before the native module load.
    // It's the IfStatement whose consequent returns an ArrowFunction with authorized:!0.
    walk(node, (inner) => {
      if (inner.type !== "IfStatement") return;
      const cons = inner.consequent;
      if (!cons) return;
      // consequent is ReturnStatement returning ArrowFunctionExpression
      const ret = cons.type === "ReturnStatement" ? cons : null;
      if (!ret || !ret.argument) return;
      if (ret.argument.type !== "ArrowFunctionExpression") return;
      // The arrow body must be an ObjectExpression with authorized:!0
      const body = ret.argument.body;
      if (!body || body.type !== "ObjectExpression") return;
      // Check for {authorized:!0} with no "reason" property
      const props = body.properties;
      const authProp = props?.find((p) => (p.key?.name || p.key?.value) === "authorized");
      const reasonProp = props?.find((p) => (p.key?.name || p.key?.value) === "reason");
      if (!authProp) return;
      const authVal = source.slice(authProp.value.start, authProp.value.end);
      if (authVal !== "!0") return;
      // Must NOT have a reason property (to distinguish from error returns)
      if (reasonProp) return;

      // Force the if-condition to !0 — but skip platform checks
      const test = inner.test;
      const testSrc = source.slice(test.start, test.end);
      if (testSrc === "!0") return;
      if (testSrc.includes("platform")) return;
      patches.push({
        id: "peer_auth_bypass",
        start: test.start,
        end: test.end,
        replacement: "!0",
        original: testSrc,
      });
    });
  });

  return patches;
}

// ── Target location ──

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = [];

  for (const plat of platforms) {
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;

    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");

      let dominated = false;

      // Rule 1: plugin auth — small file with chatgpt + !==
      if (src.includes("chatgpt") && src.includes("!==") && src.length < 5000) {
        targets.push({ platform: plat, path: fp, rules: ["auth"] });
        dominated = true;
      }

      // Rule 2: browser/computer-use availability hooks. These used to live
      // in dedicated use-*-availability chunks; they now ship inside
      // app-initial-*.js, so select by structure instead of filename.
      if (
        AVAILABILITY_FEATURE_RE.test(src) &&
        AVAILABILITY_GATE_HELPERS.some((h) => src.includes(h))
      ) {
        targets.push({ platform: plat, path: fp, rules: ["availgate"] });
      }

      // Rule 6: composer — goal gate bypass
      if (f.startsWith("composer-") && src.includes("goalSlashCommand")) {
        targets.push({ platform: plat, path: fp, rules: ["goal"] });
      }

      // Rule 1 fallback: other files with authMethod chatgpt patterns
      if (
        !dominated &&
        src.length < 10000 &&
        src.includes("chatgpt") &&
        (src.includes("authMethod") || src.includes("!=="))
      ) {
        targets.push({ platform: plat, path: fp, rules: ["auth"] });
      }
    }

    // Rule 4: main process — force default features
    const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (fs.existsSync(buildDir)) {
      for (const f of fs.readdirSync(buildDir)) {
        if (!f.startsWith("main-") || !f.endsWith(".js")) continue;
        const fp = path.join(buildDir, f);
        const src = fs.readFileSync(fp, "utf-8");
        if (src.includes("externalBrowserUseAllowed") && src.includes("computerUse")) {
          targets.push({ platform: plat, path: fp, rules: ["features"] });
        }
      }
    }
  }

  return targets;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No plugin auth or browser-use targets found");
    return;
  }

  // Merge rules for files selected by more than one criterion.
  const byPath = new Map();
  for (const t of targets) {
    if (!byPath.has(t.path)) {
      byPath.set(t.path, { ...t, rules: [...t.rules] });
      continue;
    }
    const existing = byPath.get(t.path);
    for (const rule of t.rules) {
      if (!existing.rules.includes(rule)) existing.rules.push(rule);
    }
  }
  const unique = [...byPath.values()];

  let failed = false;

  for (const bundle of unique) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024).toFixed(1)} KB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = [];
    const remainingBefore = bundle.rules.includes("availgate")
      ? findRemainingHookGateIds(ast, source)
      : [];
    if (bundle.rules.includes("auth")) patches.push(...findPluginAuthPatches(ast, source));
    if (bundle.rules.includes("availgate"))
      patches.push(...findAvailabilityGatePatches(ast, source));
    if (bundle.rules.includes("features"))
      patches.push(...findFeatureDefaultPatches(ast, source));
    if (bundle.rules.includes("goal"))
      patches.push(...findGoalGatePatches(ast, source));

    if (patches.length === 0) {
      if (remainingBefore.length > 0) {
        console.error(
          `   [x] availability hook still gated (${remainingBefore.join(", ")}); upstream shape changed?`,
        );
        failed = true;
      } else {
        console.log("   [ok] Already patched or no match");
      }
      continue;
    }

    const { kept, skipped } = selectNonOverlapping(patches);
    if (skipped.length > 0) {
      console.log(`   [!] skipped ${skipped.length} overlapping patch(es), kept outermost`);
      for (const p of skipped)
        console.log(`       - [${p.id}] offset ${p.start}-${p.end}`);
    }

    if (isCheck) {
      for (const p of kept)
        console.log(`   [?] [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      continue;
    }

    kept.sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of kept) {
      console.log(`   * [${p.id}] offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    // Never write output that no longer parses. This covers every rule, not
    // just the availability hooks.
    let afterAst;
    try {
      afterAst = parse(code, { ecmaVersion: "latest", sourceType: "module" });
    } catch (e) {
      console.error(`   [x] patched output failed to parse (${e.message}); file not written`);
      failed = true;
      continue;
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] ${kept.length} gates patched`);

    if (bundle.rules.includes("availgate")) {
      const remainingAfter = findRemainingHookGateIds(afterAst, code);
      if (remainingAfter.length > 0) {
        console.error(
          `   [x] availability hook still gated after patch (${remainingAfter.join(", ")})`,
        );
        failed = true;
      }
    }
  }

  if (failed) process.exit(1);
}

if (require.main === module) main();

module.exports = { findGoalGatePatches, selectNonOverlapping };
