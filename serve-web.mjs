// Tiny static server for the web/ folder — for local play.  Run:  node serve-web.mjs
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const PORT = 8123;
// charset matters: without it the browser guesses latin-1 and every emoji renders as "ðŸ"
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".png":"image/png", ".svg":"image/svg+xml", ".json":"application/json; charset=utf-8" };
http.createServer((req, res) => {
  // SECURITY: decode FIRST, then confirm the resolved path is still inside web/. Without this,
  // an encoded traversal (`/..%2fengine%2f.vault-keypair.json`) decodes to `../` only after the
  // client has skipped normalising it, and path.join happily walks out of ROOT — which served the
  // VAULT PRIVATE KEY over HTTP. Never trust a decoded URL as a path.
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); }
  catch { res.writeHead(400); res.end("400"); return; }         // malformed %-escape
  if (p.includes("\0")) { res.writeHead(400); res.end("400"); return; }
  if (p === "/") p = "/index.html";
  const f = path.resolve(ROOT, "." + path.posix.normalize(p));
  if (f !== ROOT && !f.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end("403"); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); res.end(d);
  });
}).listen(PORT, () => console.log(`\n  ▶  Open  http://localhost:${PORT}/?engine=ws://localhost:8090\n     (start the engine first:  cd engine && npm start)\n`));
