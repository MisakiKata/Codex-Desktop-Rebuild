/**
 * 分块下载 MSIX：规避大文件整体 GET 被网络策略拦截的问题。
 * 按固定大小 Range 分片，可断点续传。
 *
 * 用法: node scripts/chunk-download.js <url> <dest> [totalBytes] [chunkMB]
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const MAX_REDIRECTS = 5;

const [, , urlStr, dest, totalStr, chunkMbStr] = process.argv;
if (!urlStr || !dest) {
  console.error("Usage: node chunk-download.js <url> <dest> [totalBytes] [chunkMB]");
  process.exit(1);
}

const TOTAL = Number(totalStr || 0);
const CHUNK = (Number(chunkMbStr || 8)) * 1024 * 1024;

function get(url, headers, redirects = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const protocol = new URL(url).protocol;
    const mod = protocol === "https:" ? https : protocol === "http:" ? http : null;
    if (!mod) return reject(new Error(`unsupported protocol: ${protocol}`));

    const req = mod.get(url, { headers, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error("too many redirects"));
        const next = new URL(res.headers.location, url).href;
        return resolve(get(next, headers, redirects - 1));
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function head() {
  const res = await get(urlStr, {});
  res.resume();
  return Number(res.headers["content-length"] || 0);
}

async function main() {
  let total = TOTAL;
  if (!total) total = await head();
  if (!total) {
    console.error("[x] cannot determine size");
    process.exit(1);
  }

  const totalChunks = Math.ceil(total / CHUNK);
  console.log(`[dl] ${(total / 1048576).toFixed(1)} MB in ${totalChunks} chunks of ${CHUNK / 1048576}MB`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, Buffer.alloc(0));

  let done = 0;
  let failed = [];

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK;
    const end = Math.min(start + CHUNK - 1, total - 1);
    let ok = false;

    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await get(urlStr, { Range: `bytes=${start}-${end}` });
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          res.resume();
          throw new Error(`HTTP ${res.statusCode}`);
        }
        const chunks = [];
        for await (const c of res) chunks.push(c);
        const buf = Buffer.concat(chunks);
        const expect = end - start + 1;
        if (buf.length !== expect) throw new Error(`short read ${buf.length}/${expect}`);

        const f = fs.openSync(dest, "r+");
        fs.writeSync(f, buf, 0, buf.length, start);
        fs.closeSync(f);
        ok = true;
        done++;
        const pct = (((i + 1) / totalChunks) * 100).toFixed(1);
        const mb = (end + 1) / 1048576;
        console.log(`  [${pct}%] chunk ${i + 1}/${totalChunks}  (${mb.toFixed(0)}/${(total / 1048576).toFixed(0)} MB)`);
      } catch (e) {
        if (attempt === 3) {
          failed.push(i);
          console.error(`  [x] chunk ${i + 1} failed: ${e.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
    }
  }

  const finalSize = fs.statSync(dest).size;
  console.log(`\n[ok] chunks ${done}/${totalChunks}  size ${(finalSize / 1048576).toFixed(1)} MB`);
  if (failed.length) {
    console.error(`[x] failed chunks: ${failed.join(",")}`);
    process.exit(1);
  }
  if (finalSize !== total) {
    console.error(`[x] size mismatch: ${finalSize} != ${total}`);
    process.exit(1);
  }
  console.log("[done] complete");
}

main().catch((e) => {
  console.error("[x]", e.message);
  process.exit(1);
});