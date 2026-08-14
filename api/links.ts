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
//
// ------------------------------------------------------------------------------------------------
// WHY THESE FOUR IMPORTS END IN `.js` WHEN EVERY FILE THEY NAME IS A `.ts` ON DISK.
//
// They used to end in `.ts` — the house style everywhere else in this repo, and the reason
// `er-demo/tsconfig.api.json` turns `allowImportingTsExtensions` on. It type-checked clean, `npm test`
// was green, the deploy reported success, and every single request to this route returned a 500:
//
//   Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/er-demo/api/src/linksHandler.ts'
//   imported from /var/task/api/links.js
//
// THE MECHANISM, READ OFF THE BUILD OUTPUT RATHER THAN GUESSED AT. Run `npx vercel build` and look in
// `.vercel/output/functions/api/links.func/`. Vercel does NOT bundle these functions: it transpiles
// this file to `api/links.js`, walks the import graph with `@vercel/nft`, and transpiles every `.ts`
// it reaches into a `.js` beside it. `er-demo/api/src/linksHandler.js` is genuinely in the deployed
// bundle. What that step does NOT do is rewrite the specifiers — so the emitted `links.js` asks Node
// for `linksHandler.ts`, the only file at that path is `linksHandler.js`, and Node is correct to
// refuse. The dependency was shipped AND unreachable, which is why this failed as a hard 500 behind a
// build that reported success: nothing in the pipeline compares the two halves of that sentence.
//
// `.js` specifiers cost nothing at type-check time. TypeScript resolves `./x.js` to `./x.ts` under
// `moduleResolution: "bundler"` (and under `nodenext`), so `npm run typecheck` still covers this
// directory exactly as `tsconfig.api.json`'s header insists it must, and `allowImportingTsExtensions`
// stays on for the rest of the repo. The rule is narrow and has a boundary worth stating: the
// SERVERLESS IMPORT GRAPH writes `.js`, everything the browser bundle imports still writes `.ts`.
// `er-demo/api/README.md` lists the ten files that graph covers and how to tell if it has grown.
//
// REJECTED, each recorded because each is the obvious answer from some angle:
//
//   *Ship the `.ts` files and let Node 24 strip the types.* Node can import TypeScript directly now,
//   so this nearly works. But Vercel emits the `.js` beside it regardless, so the bundle would carry
//   both copies of every module and which one Node resolves depends on flags nobody here sets. That
//   is the same class of defect as the one being fixed — resolution decided somewhere you cannot see
//   — only harder to spot, because it would work until it didn't.
//
//   *Force a real bundle so specifiers stop mattering.* `@vercel/node` exposes no `bundle` switch,
//   and `includeFiles` copies matched files VERBATIM into the output — it would place untranspiled
//   `.ts` sources in the bundle, which is the previous paragraph with extra steps.
//
//   *Move the shared modules to `/api/_lib/` so they sit inside the function root.* Vercel does treat
//   `_`-prefixed directories as non-routes, so the layout is legal — and it fixes nothing, because
//   the specifier problem between two files inside `_lib/` is identical. It also costs the exact
//   thing the split above exists to buy: `npm test` and `npm run typecheck` run from `er-demo/`, so
//   moving the code out of that tree means vitest's default `include` stops sweeping it and the eight
//   `er-demo/api/src/*.test.ts` files quietly stop running. Trading a live test suite for a prettier
//   import path is the wrong trade in both directions.
// ------------------------------------------------------------------------------------------------

import { handleLinks } from "../er-demo/api/src/linksHandler.js";
import { neonStore } from "../er-demo/api/src/neonStore.js";
import { HouseListCache } from "../er-demo/api/src/houseWallets.js";
import { keeperHouseUrl, loadAttestationKey, requireHouseToken } from "../er-demo/api/src/env.js";

// MODULE SCOPE, DELIBERATELY. A missing or malformed signing key throws during cold start, which
// Vercel surfaces as a function error with the message intact, on the first request after the
// deploy, where somebody is looking. Deferred into the request handler it would instead produce a
// 500 per request — or worse, a caught exception and an empty `links` array, which renders exactly
// like "nobody has linked" and would never be noticed at all.
const key = loadAttestationKey(process.env);
const store = neonStore(process.env);
// Same rule, same reason: a missing house token makes every list read a 401, the fail-closed path
// withholds every row, and the page renders as though nobody had ever linked. Read here rather than
// inside the fetch so the throw lands during cold start alongside the other two.
const houseToken = requireHouseToken(process.env);

// One cache per worker, constructed once so it survives warm invocations — which is the only reason
// a 60-second TTL is worth anything. It reads the keeper's AUTHENTICATED house-list endpoint, not
// the public status file, which no longer carries the list at all. See `houseWallets.ts`.
const house = new HouseListCache({
  url: keeperHouseUrl(process.env),
  token: houseToken,
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
