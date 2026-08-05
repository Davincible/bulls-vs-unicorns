// Tiny static server for the web/ folder — for local play.  Run:  node serve-web.mjs
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
const PORT = 8123;
// charset matters: without it the browser guesses latin-1 and every emoji renders as "ðŸ"
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".png":"image/png", ".svg":"image/svg+xml", ".json":"application/json; charset=utf-8" };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); res.end(d);
  });
}).listen(PORT, () => console.log(`\n  ▶  Open  http://localhost:${PORT}/?engine=ws://localhost:8090\n     (start the engine first:  cd engine && npm start)\n`));
