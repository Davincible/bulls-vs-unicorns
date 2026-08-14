// `GET /api/avatar/<x_id>/<avatar_hash>.webp` — the Vercel entry point.
//
// THE FILENAME IS A ROUTING ARTEFACT AND NOTHING MORE. `[xId]` and `[hash]` are how Vercel is told
// that these two path segments vary; the handler ignores the parameters the platform injects and
// parses the pathname itself (see `avatarHandler.ts` for why). The `.webp` suffix in the request URL
// is absorbed by the `[hash]` segment — a dynamic segment matches the whole segment including its
// extension — and `cleanUrls: true` does not touch it, because `cleanUrls` strips `.html` and
// `.htm` from STATIC files and has no bearing on function routes.
//
// No `sharp` here, and no outbound request. This function reads one row and returns bytes. The
// fetching and re-encoding live in `avatarIngest.ts` and run at write time; that file's header is
// the argument for why, and it is really an argument about where "the last good bytes" have to live.
// The practical consequence is that the one function a browser can reach carries no native image
// decoder, makes no network call it did not initiate, and has nothing in it that could be pointed at
// an internal host.

// `.js` SPECIFIERS FOR `.ts` FILES — deliberate, and `api/links.ts` carries the full argument and the
// three rejected alternatives. The short version: Vercel transpiles this function's dependencies to
// `.js` without rewriting the specifiers that name them, so a `.ts` here is a module Node cannot find
// at runtime. This route was broken in exactly the same way and by the same commit as `/api/links`,
// which is worth knowing because nothing distinguished the two — there is no test that runs either
// file, and there cannot be while they are the wiring that only Vercel executes.
import { handleAvatar } from "../../../er-demo/api/src/avatarHandler.js";
import { neonStore } from "../../../er-demo/api/src/neonStore.js";

// Cold start, not per request — see `api/links.ts`.
const store = neonStore(process.env);

export default {
  fetch(request: Request): Promise<Response> {
    return handleAvatar(request, { store });
  },
};
