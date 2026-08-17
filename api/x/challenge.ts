// `POST /api/x/challenge` — the Vercel entry point, and ONLY the entry point.
//
// Read the environment, build the dependencies, hand the request over. Every rule this route enforces
// lives in `er-demo/api/src/challengeHandler.ts`, where `npx vitest run` reaches it without a database,
// a network or this platform. `api/links.ts`'s header carries the full argument for this split, the
// reason the entry points must be at the repo root, and the reason the implementation must not be.
//
// ------------------------------------------------------------------------------------------------
// EVERY RELATIVE IMPORT BELOW ENDS IN `.js` AND EVERY FILE IT NAMES IS A `.ts` ON DISK.
//
// This is not a mistake and it is not the house style. Vercel does not bundle these functions: it
// transpiles each `.ts` it reaches into a `.js` beside it and DOES NOT REWRITE THE SPECIFIERS, so a
// `.ts` import is a path with no file at it and every request to the route becomes
// `ERR_MODULE_NOT_FOUND` behind a build that reported success. That happened here, to both existing
// routes, and `api/links.ts` records the mechanism, the evidence (`npx vercel build`, then look inside
// `.vercel/output/functions/api/links.func/`) and the alternatives that were rejected.
// `er-demo/api/README.md` lists the files the deployed graph covers and how to tell when it has grown —
// this route adds eleven of them.
// ------------------------------------------------------------------------------------------------
//
// ------------------------------------------------------------------------------------------------
// WHAT MODULE SCOPE DOES AND DOES NOT DO HERE, WHICH IS A DEPARTURE FROM `links.ts` WORTH READING.
//
// `links.ts` loads its configuration at module scope so that a missing secret throws during cold start
// rather than degrading into an empty response nobody can see. That rule still applies — but this route
// has a state `links.ts` does not: DELIBERATELY DISABLED.
//
// So the gate is read FIRST and nothing else is read at all when it is off. A deployment that has not
// enabled the ceremony must not fail its cold start over a Privy app id it has no use for; it must boot,
// answer 503, and say so (`writeHttp.ts#disabled` argues 503 over 404). Once the gate IS on, every other
// value is mandatory and its absence is a thrown cold start, exactly as it is next door —
// `writeEnv.ts#writeConfig` is the one function that expresses both halves of that rule, and it is tested.
// ------------------------------------------------------------------------------------------------

import { handleChallenge } from "../../er-demo/api/src/challengeHandler.js";
import { writeConfig } from "../../er-demo/api/src/writeEnv.js";
import { neonSql } from "../../er-demo/api/src/neonStore.js";
import { disabled, guarded } from "../../er-demo/api/src/writeHttp.js";
import { createWriteDeps, nowSeconds } from "../../er-demo/api/src/writeWiring.js";

// `null` when `XLINK_WRITE_ENABLED` is not exactly `on`. A throw when it is on and something else is
// missing — during cold start, where Vercel surfaces it as a function error with the message intact.
const config = writeConfig(process.env);

// CONSTRUCTED ONCE PER WORKER so that the JWKS cache (an hour) and the house-list cache (a minute)
// survive warm invocations, which is the only reason either is worth having. `neonSql` is inside this
// branch rather than above it because it demands `DATABASE_URL`, and a disabled deployment has no
// business requiring a database.
const deps = config === null ? null : createWriteDeps({
  config,
  sql: neonSql(process.env),
  fetch: globalThis.fetch,
  nowSec: nowSeconds,
});

export default {
  fetch(request: Request): Promise<Response> {
    if (deps === null) return Promise.resolve(disabled());
    // `guarded` turns a thrown store call into the same 503 every other reason of ours produces, and
    // logs the error's NAME only — never a message, which can carry a row, and never anything from this
    // request, which has a Privy identity token in it.
    return guarded("x/challenge", () => handleChallenge(request, deps.challenge));
  },
};
