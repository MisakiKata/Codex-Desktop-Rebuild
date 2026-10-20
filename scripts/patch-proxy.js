#!/usr/bin/env node
/**
 * Post-build patch: Network proxy support
 *
 * Injects proxy configuration into the Electron entry point
 * (`.vite/build/early-bootstrap.js`) so ONE config drives BOTH network layers:
 *
 *   ① Chromium stack  → main process + renderer
 *      electron.commandLine.appendSwitch('proxy-server', url)
 *      electron.commandLine.appendSwitch('proxy-bypass-list', bypass)
 *
 *   ② Child processes → codex.exe (Rust), shell (git/curl), ...
 *      process.env.HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY
 *      Upstream already forwards these to spawned children via its env
 *      allow-lists in application-network-startup and startup-requirements.
 *
 * Config lives in the existing Codex config file — no extra file needed:
 *   ~/.codex/config.toml      (or %CODEX_HOME%\config.toml)
 *
 *   [network]
 *   proxy_enabled = true
 *   proxy_server = "127.0.0.1:10809"
 *   proxy_protocol = "http"        # http | socks5 | socks5h | socks4
 *   proxy_bypass = ["localhost", "127.0.0.1", "<local>"]
 *
 * CODEX_HOME is resolved by the caller; this hook runs before that happens,
 * so we mirror the same default (~/.codex) and honour an explicit CODEX_HOME.
 *
 * Injection point: the module top-level of early-bootstrap.js, right after
 * `require("electron")`. This runs BEFORE app.whenReady(), which is the only
 * window where Chromium accepts proxy switches.
 *
 * Missing section or disabled proxy degrades silently to a direct connection.
 *
 * Usage:
 *   node scripts/patch-proxy.js [platform]        # Apply patch
 *   node scripts/patch-proxy.js [platform] --check # Dry-run
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

const MARKER = "[CodexProxy]";
const MARKER_VERSION = "v4";
const CURRENT_MARKER = `${MARKER} ${MARKER_VERSION}`;

// ──────────────────────────────────────────────
//  Injected payload
// ──────────────────────────────────────────────

const PAYLOAD = `
/* ${MARKER} ${MARKER_VERSION} — network proxy from the Codex config.toml [network] section */
(function(){
  try{
    var fs=require("fs"),p=require("path"),os=require("os"),e=require("electron");
    // Strip a TOML comment (# outside quoted strings) before parsing a line.
    function stripComment(v){
      var q=null;
      for(var i=0;i<v.length;i++){
        var ch=v.charAt(i);
        if(q){
          if(q==='"'&&ch.charCodeAt(0)===92){i++;continue;}
          if(ch===q)q=null;
        }else if(ch==='"'||ch==="'"){q=ch;}
        else if(ch==="#"){return v.slice(0,i).trim();}
      }
      return v.trim();
    }
    // Candidate config locations, in priority order. Nothing is hardcoded to a
    // specific user or machine: CODEX_HOME wins if set, otherwise we follow the
    // same rule upstream uses (\${CODEX_HOME:-\$HOME/.codex}).
    var home=process.env.CODEX_HOME&&process.env.CODEX_HOME.trim()
      ?process.env.CODEX_HOME.trim():null;
    if(!home){
      var base=e.app&&e.app.getPath?null:(os.homedir()||"");
      try{base=e.app.getPath("home")||base}catch(_){}
      home=p.join(base||os.homedir(),".codex");
    }
    var f=p.join(home,"config.toml");
    if(!fs.existsSync(f))return;
    var txt=fs.readFileSync(f,"utf-8");
    // Minimal TOML section reader: we only need scalars and string arrays
    // inside [network]; anything else in the file is ignored.
    var sec={},cur=null;
    for(var line of txt.split(/\\r?\\n/)){
      var t=stripComment(line.trim());
      if(!t)continue;
      var sm=t.match(/^\\[([^\\]]+)\\]$/);
      if(sm){cur=sm[1].trim();continue;}
      if(cur!=="network")continue;
      var m=t.match(/^([A-Za-z0-9_-]+)\\s*=\\s*(.+)$/);
      if(!m)continue;
      var key=m[1],val=m[2].trim();
      var qm=val.match(/^"(.*)"$/)||val.match(/^'(.*)'$/);
      if(qm){sec[key]=qm[1];continue}
      var am=val.match(/^\\[(.*)\\]$/);
      if(am){
        sec[key]=am[1].split(",").map(function(s){return s.trim().replace(/^["']|["']$/g,"")}).filter(Boolean);
        continue
      }
      if(val==="true")sec[key]=true;
      else if(val==="false")sec[key]=false;
      else sec[key]=val;
    }
    // No [network] section, proxy disabled, or incomplete — stay on direct.
    if(sec.proxy_enabled!==true)return;
    if(typeof sec.proxy_server!=="string"||sec.proxy_server.length===0)return;
    var proto=["socks5","socks5h","socks4"].indexOf(sec.proxy_protocol)>=0
      ?sec.proxy_protocol:"http";
    var url=proto+"://"+sec.proxy_server;
    var by=Array.isArray(sec.proxy_bypass)&&sec.proxy_bypass.length
      ?sec.proxy_bypass:["localhost","127.0.0.1","<local>"];
    // Chromium stack: main process + renderer
    e.app.commandLine.appendSwitch("proxy-server",url);
    e.app.commandLine.appendSwitch("proxy-bypass-list",by.join(";"));
    // Child processes (codex.exe, shell tools) inherit these at spawn time
    process.env.HTTP_PROXY=url;
    process.env.HTTPS_PROXY=url;
    process.env.ALL_PROXY=url;
    process.env.NO_PROXY=by.join(",");
  }catch(err){
    try{console.error("${MARKER} failed:",err&&err.message)}catch(_){}
  }
})();
`.trim();

// ──────────────────────────────────────────────
//  AST matching
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visitor);
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

/**
 * early-bootstrap.js is tiny and minified. Anchor on the top-level
 * `require("electron")` call, which is guaranteed to be present (the whole
 * module is built on Electron's app/commandLine API).
 *
 * The bundler emits it as `let r=require("electron");` — a VariableDeclaration
 * whose declarators[0].init is the require call — but handle the bare
 * expression form too.
 */
function collectPatches(ast, source) {
  if (source.includes(CURRENT_MARKER)) {
    return [{ alreadyPatched: true }];
  }

  // Upgrade an older injected payload in place instead of stacking a second IIFE.
  const oldStart = source.indexOf(`/* ${MARKER} v`);
  if (oldStart >= 0) {
    const endIdx = source.indexOf("})();", oldStart);
    if (endIdx < 0) return [{ unpatchable: true }];
    return [
      {
        start: oldStart,
        end: endIdx + "})();".length,
        replacement: PAYLOAD,
        original: `${MARKER} legacy payload`,
      },
    ];
  }

  const isElectronRequire = (node) => {
    if (!node) return false;
    if (node.type !== "CallExpression") return false;
    if (node.callee?.type !== "Identifier" || node.callee.name !== "require") return false;
    if (node.arguments?.length !== 1) return false;
    const arg = node.arguments[0];
    const val =
      arg.type === "Literal"
        ? arg.value
        : arg.type === "TemplateLiteral" &&
          arg.expressions.length === 0 &&
          arg.quasis.length === 1
          ? arg.quasis[0].value.cooked
          : null;
    return val === "electron";
  };

  const patches = [];

  for (const stmt of ast.body) {
    let anchorEnd = -1;

    if (stmt.type === "VariableDeclaration") {
      if (stmt.declarations.some((d) => isElectronRequire(d.init))) {
        // Insert after the whole declaration, never mid-declarator.
        anchorEnd = stmt.end;
      }
    } else if (stmt.type === "ExpressionStatement") {
      if (isElectronRequire(stmt.expression)) {
        anchorEnd = stmt.end;
      }
    }

    if (anchorEnd >= 0) {
      patches.push({
        start: anchorEnd,
        end: anchorEnd,
        replacement: ";\n" + PAYLOAD,
        original: "",
      });
      break;
    }
  }

  return patches;
}

// ──────────────────────────────────────────────
//  Config bootstrap (--init)
// ──────────────────────────────────────────────

const TOML_BLOCK = `
[network]
proxy_enabled = true
proxy_server = "127.0.0.1:10809"
proxy_protocol = "http"
proxy_bypass = ["localhost", "127.0.0.1", "<local>"]
`;

/**
 * Resolve the Codex home directory the same way the injected hook does.
 * Nothing user- or machine-specific is baked in.
 */
function codexHome() {
  const env = process.env.CODEX_HOME && process.env.CODEX_HOME.trim();
  if (env) return path.resolve(env.trim());
  return path.join(os.homedir(), ".codex");
}

/**
 * Add (or replace) the [network] section in the Codex config.toml.
 * Existing content is preserved; a .bak copy is written first.
 */
function writeSample() {
  const dir = codexHome();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.toml");

  console.log(`  [home] ${dir}`);

  let original = "";
  if (fs.existsSync(file)) {
    original = fs.readFileSync(file, "utf-8");
    fs.writeFileSync(file + ".bak", original, "utf-8");
    console.log(`  [ok] backup written: ${file}.bak`);

    // Strip any pre-existing [network] section so we don't duplicate keys.
    const lines = original.split(/\r?\n/);
    const out = [];
    let skipping = false;
    for (const line of lines) {
      const t = line.trim();
      const sm = t.match(/^\[([^\]]+)\]$/);
      if (sm) {
        if (sm[1].trim() === "network") { skipping = true; continue; }
        skipping = false;
      }
      if (!skipping) out.push(line);
    }
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    original = out.join("\n");
    if (original && !original.endsWith("\n")) original += "\n";
  }

  const next = original + TOML_BLOCK;
  fs.writeFileSync(file, next, "utf-8");
  console.log(`  [ok] updated ${file}`);
  console.log("");
  console.log("    " + TOML_BLOCK.trim().split("\n").join("\n    "));
  return file;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--init")) {
    console.log("\n== Proxy config init ==\n");
    writeSample();
    console.log("");
    return;
  }

  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  // The entry point is `early-bootstrap.js`, not the hashed main-*.js.
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", ".vite", "build")),
      );

  const targets = [];
  for (const plat of platforms) {
    const dir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
    if (!fs.existsSync(dir)) continue;
    const file = path.join(dir, "early-bootstrap.js");
    if (fs.existsSync(file)) targets.push({ platform: plat, path: file });
  }

  if (targets.length === 0) {
    console.log("[skip] early-bootstrap.js not found (nothing to patch)");
    return;
  }

  let total = 0;
  let failed = false;

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${source.length} bytes`);

    const t0 = Date.now();
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
    } catch (e) {
      console.error(`   [x] parse failed: ${e.message}`);
      failed = true;
      continue;
    }
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches[0]?.unpatchable) {
      console.error(`   [x] legacy ${MARKER} payload found but its end could not be located`);
      failed = true;
      continue;
    }

    if (patches.length === 0) {
      console.error("   [x] require(\"electron\") anchor not found");
      failed = true;
      continue;
    }

    if (patches[0].alreadyPatched) {
      console.log(`   [ok] already patched (${CURRENT_MARKER})`);
      continue;
    }

    if (isCheck) {
      const action = patches[0].start === patches[0].end ? "insert" : "replace legacy payload";
      console.log(`   [?] Matches: ${patches.length}`);
      console.log(`     > ${action} ${patches[0].replacement.length} bytes at offset ${patches[0].start}`);
      continue;
    }

    // Replace from the end (descending) so earlier offsets stay valid.
    const ordered = [...patches].sort((a, b) => b.start - a.start);
    let code = source;
    for (const p of ordered) {
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    try {
      parse(code, { ecmaVersion: "latest", sourceType: "script" });
    } catch (e) {
      console.error(`   [x] patched file failed to parse: ${e.message}`);
      failed = true;
      continue;
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] proxy injection added (${code.length - source.length >= 0 ? "+" : ""}${code.length - source.length} bytes)`);
    total += patches.length;
  }

  console.log(`\n== Total: ${total} file(s) patched ==`);
  if (total > 0 && !isCheck) {
    console.log("   Config: <CODEX_HOME or~/.codex>/config.toml  ([network] section)");
    console.log("   Run `node scripts/patch-proxy.js --init` to create a sample.");
  }

  if (failed) process.exit(1);
}

main();