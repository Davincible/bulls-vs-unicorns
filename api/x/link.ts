// `POST /api/x/link` and `DELETE /api/x/link` — the Vercel entry point, and ONLY the entry point.
//
// ONE FILE FOR BOTH METHODS, because Vercel routes by PATH: a file at `api/x/link.ts` is the function
// for `/api/x/link` whatever the verb, and there is no arrangement in which `DELETE` gets a file of its
// own. `handleLinkWrite` dispatches on `request.method` and 405s everything else with an `Allow` header.
//
// Everything else about this file — why the entry point is at the repo root while the implementation is
// under `er-demo/api/src`, why every relative import below ends in `.js` when every file it names is a
// `.ts` on disk, and what module scope is for — is argued in `api/links.ts` and in `api/x/challenge.ts`.
// The short version of the import rule, because it cost this repo a live outage: Vercel transpiles these
// files without rewriting the specifiers between them, so a `.ts` import names a file that does not
// exist at runtime and the route serves `ERR_MODULE_NOT_FOUND` behind a green build.

import { writeConfig } from "../../er-demo/api/src/writeEnv.js";
import { handleLinkWrite } from "../../er-demo/api/src/linkWriteHandler.js";
import { neonSql } from "../../er-demo/api/src/neonStore.js";
import { disabled, guarded } from "../../er-demo/api/src/writeHttp.js";
import { createWriteDeps, nowSeconds } from "../../er-demo/api/src/writeWiring.js";

const config = writeConfig(process.env);

const deps = config === null ? null : createWriteDeps({
  config,
  sql: neonSql(process.env),
  fetch: globalThis.fetch,
  nowSec: nowSeconds,
});

export default {
  fetch(request: Request): Promise<Response> {
    if (deps === null) return Promise.resolve(disabled());
    return guarded("x/link", () => handleLinkWrite(request, deps.link));
  },
};
