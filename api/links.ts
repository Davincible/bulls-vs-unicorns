// `GET /api/links` — the Vercel entry point, and ONLY the entry point.
//
// It does three things and nothing else: read the environment, construct the store, hand the request
// to `handleLinks`. Every rule this route enforces lives in `er-demo/api/src/linksHandler.ts`, where
// `npm test` can reach it without a database, a network or this platform. What is left here is the
// wiring, and wiring is the part that cannot be unit-tested anywhere — so there should be as little
// of it as possible.
//
// THIS IS THE ONLY FILE IN THE FEATURE THAT NAMES NEON. `createPgStore` takes a tagged-template
// query function; swapping to `pg`, to `postgres.js`, or to a different Postgres entirely is a
// change to the two lines below and to nothing else.
//
// ------------------------------------------------------------------------------------------------
// WHY THE ENTRY POINTS ARE HERE AND THE CODE IS IN `er-demo/api/`.
//
// Vercel only turns files under `/api` AT THE PROJECT ROOT into Functions. The `functions` key in
// `vercel.json` configures functions that were already detected; it cannot create one from a file
// outside that directory, and a glob that matches nothing fails the build with `unused_function`.
// This project's Root Directory is the repo root — it has to be, because that is where the
// `vercel.json` Vercel reads lives, and because `er-demo`'s own type-check reaches out to
// `engine/src` (see `.vercelignore`), which a narrower root directory would put out of scope.
//
// So the entry points must be here. The implementation must NOT be, because the gate that matters —
// `npm test` and `npm run typecheck`, both run from `er-demo/` — only sees files it can reach, and a
// directory of untested serverless code is exactly the thing this arrangement exists to prevent.
// Third-party dependencies resolve upward from either location into the repo-root `node_modules`
// that `/package.json` declares, which is the piece that makes both halves work at once.
// ------------------------------------------------------------------------------------------------

import { handleLinks } from "../er-demo/api/src/linksHandler.ts";
import { neonStore } from "../er-demo/api/src/neonStore.ts";
import { HouseListCache } from "../er-demo/api/src/houseWallets.ts";
import { keeperStatusUrl, loadAttestationKey } from "../er-demo/api/src/env.ts";

// MODULE SCOPE, DELIBERATELY. A missing or malformed signing key throws during cold start, which
// Vercel surfaces as a function error with the message intact, on the first request after the
// deploy, where somebody is looking. Deferred into the request handler it would instead produce a
// 500 per request — or worse, a caught exception and an empty `links` array, which renders exactly
// like "nobody has linked" and would never be noticed at all.
const key = loadAttestationKey(process.env);
const store = neonStore(process.env);

// One cache per worker, constructed once so it survives warm invocations — which is the only reason
// a 60-second TTL is worth anything. See `houseWallets.ts`.
const house = new HouseListCache({
  url: keeperStatusUrl(process.env),
  fetch: globalThis.fetch,
  nowSec: () => Math.floor(Date.now() / 1000),
});

export default {
  fetch(request: Request): Promise<Response> {
    return handleLinks(request, {
      store,
      key,
      house,
      nowSec: () => Math.floor(Date.now() / 1000),
    });
  },
};
