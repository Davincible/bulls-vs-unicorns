// THE WRITE PATH'S CONFIGURATION. Stage 3, and a SEPARATE FILE from `env.ts` for one measured reason.
//
// IT WAS IN `env.ts` FIRST, AND THAT PUT THE PRIVY VERIFIER INSIDE THE AVATAR PROXY. `env.ts` is
// imported by all four functions, so its imports are everybody's imports — and `writeConfig` needs
// `privyJwksUrl` from `privyIdentity.ts` and `deriveBucketSecret` from `rateLimit.ts`. Vercel traces the
// import graph file by file with NO tree-shaking, so `npx vercel build` showed `privyIdentity.js` and
// `rateLimit.js` landing inside `api/links.func` and `api/avatar/[xId]/[hash].func`: two modules that
// parse tokens and derive secrets, shipped into two routes that only ever read a row.
//
// Nothing was broken by that and no test would have failed. It is still exactly the drift
// `er-demo/api/README.md` asks people to watch for, and the answer to drift is a boundary rather than a
// comment. So: `env.ts` holds the primitives every route needs (the signing key, the database URL, the
// roster URL and its token). This file holds the write path's own, composes them, and is imported by
// nothing except the two `/api/x/*` entry points. The dependency runs one way, `writeEnv` -> `env`, and
// the read functions' graphs are back to what they were before Stage 3 existed.
//
// `npx vercel build` and a look inside `.vercel/output/functions/api/links.func/` is how to check that
// claim. Do not take this paragraph's word for it.

import { keeperHouseUrl, requireHouseToken } from "./env.js";
import { DEFAULT_PRIVY_API_URL, privyJwksUrl } from "./privyIdentity.js";
import { deriveBucketSecret } from "./rateLimit.js";

// Every value below follows the rule `env.ts`'s header sets out — a missing one is a thrown cold start,
// never a default — with ONE structural addition: the whole write path is behind a gate that is OFF
// unless it is explicitly turned on.

/**
 * THE GATE. `TWITTER-CONNECT.md` §10, Stage 3: "behind a flag, on a preview deployment, with a small
 * tester allowlist."
 *
 * Must be the exact string `on`. Absent, empty, `1`, `true`, `yes`, `ON` — all of these are OFF, and
 * that is the same rule `parseLinksFlag` applies to `?links=`: "a mistyped flag must never silently
 * select a code path with different trust in it." A write path is the one place in this feature where
 * that sentence has money behind it.
 *
 * ------------------------------------------------------------------------------------------------
 * WHY THIS IS A SERVER VARIABLE AND NOT THE CLIENT'S `?links=` FLAG, WHICH IS THE OBVIOUS QUESTION.
 *
 * `src/v2/data/linkSource.ts` already gates every identity SURFACE on `?links=`, and this deliberately
 * does not add a second switch to that job: what a browser renders stays governed by `?links=`, and
 * nothing here changes it. But a query parameter cannot gate a WRITE. `?links=api` is a fact about one
 * browser's URL; a POST to `/api/x/link` can be made by anything, with any headers, from anywhere, and
 * a server that decided whether to write a row by reading a flag the caller controls has not got a
 * flag at all. So the two gates are answering two different questions — "should this page show
 * identities" and "may this deployment create them" — and the second one has to live where the caller
 * cannot reach it.
 *
 * The practical shape of Stage 3's instruction: set it in Vercel's PREVIEW environment only, and the
 * production functions keep refusing every write with a 503 while the preview ceremony is exercised.
 * Turning it on in production is one dashboard change and no deploy.
 * ------------------------------------------------------------------------------------------------
 */
export const LINK_WRITE_ENV = "XLINK_WRITE_ENABLED";

/**
 * The Privy app id — the `aud` every identity token must name, and half of the JWKS URL.
 *
 * NOT A SECRET. It is a public client id: it is compiled into the browser bundle (which is what the
 * `VITE_` prefix is for) and it appears in every request to `privy.io`. That is why this is the ONE
 * value in this file that may be read from a `VITE_`-prefixed variable, and why the fallback below is
 * safe where it would be indefensible for `KEEPER_HOUSE_URL` (see that constant: shipping either half
 * of a private channel in the bundle is precisely what the prefix rule exists to prevent).
 *
 * `PRIVY_APP_ID` is preferred; `VITE_PRIVY_APP_ID` is accepted because that is the name the client
 * needs and therefore the name that is already set. ONE VALUE, TWO ACCEPTABLE NAMES, and no third
 * option: two variables holding the same id in a dashboard is two things that can disagree, and the
 * disagreement would show up as every token failing `aud` — which looks exactly like "nobody links".
 */
export const PRIVY_APP_ID_ENV = "PRIVY_APP_ID";
export const PRIVY_APP_ID_VITE_ENV = "VITE_PRIVY_APP_ID";

/**
 * Where Privy's public keys are served from. Overridable ONLY so a test or a staging environment can
 * point somewhere else; there is no reason to set it in production.
 *
 * Defaulted, like `KEEPER_HOUSE_URL`, because it is an address rather than a credential — the JWKS
 * endpoint is public and unauthenticated, and this request carries nothing.
 */
export const PRIVY_API_URL_ENV = "PRIVY_API_URL";

/** A Privy app id as Privy actually spells them: a cuid2-ish lowercase alphanumeric string. Checked
 *  for SHAPE only, because the real check is that tokens verify against it — but a value with a
 *  newline or a stray quote in it would go into a URL, and a URL is worth being strict about. */
const PRIVY_APP_ID_RE = /^[a-z0-9]{16,40}$/;

/**
 * Is the link ceremony enabled on this deployment? See `LINK_WRITE_ENV`.
 *
 * A BOOLEAN AND NOT A THROW, which makes it the one loader in this file that does not refuse to start.
 * That is the whole design of the gate: the function must BOOT while disabled so it can answer 503 and
 * say so, and while disabled it must not require any of the other write-path configuration — a
 * deployment that has deliberately not enabled the ceremony should not be failing cold starts over a
 * Privy app id it has no use for. The entry points therefore read this FIRST and load nothing else
 * when it is off.
 */
export function linkWriteEnabled(env: Record<string, string | undefined>): boolean {
  return env[LINK_WRITE_ENV] === "on";
}

/**
 * The Privy app id, or a thrown cold start. Called only when the gate is on.
 *
 * The same argument as every other loader here, arriving through the audience claim: with no app id
 * there is no `aud` to compare and no JWKS URL to fetch, so every identity token would be refused and
 * every link would fail — while `/api/links` kept answering 200 with an empty list, which is what the
 * page looks like when nobody has linked. A 500 at cold start is the only version of that a human
 * notices.
 */
export function requirePrivyAppId(env: Record<string, string | undefined>): string {
  const raw = env[PRIVY_APP_ID_ENV] ?? env[PRIVY_APP_ID_VITE_ENV];
  const trimmed = raw === undefined ? "" : raw.trim();
  if (trimmed === "") {
    throw new Error(
      `${PRIVY_APP_ID_ENV} (or ${PRIVY_APP_ID_VITE_ENV}) is not set, and ${LINK_WRITE_ENV} is "on". ` +
        `The app id is the audience every Privy identity token must name and half of the JWKS URL; ` +
        `without it every link is refused while the read path keeps answering 200 with an empty list, ` +
        `which is indistinguishable from "nobody has linked".`,
    );
  }
  if (!PRIVY_APP_ID_RE.test(trimmed)) {
    throw new Error(
      `${PRIVY_APP_ID_ENV} does not look like a Privy app id (lowercase alphanumeric, 16-40 chars). ` +
        `Got ${trimmed.length} characters. It goes into a URL and into an audience comparison, so it ` +
        `is checked for shape rather than trusted.`,
    );
  }
  return trimmed;
}

/** Privy's API origin. Defaulted, because it is an address and not a credential. The default itself
 *  lives in `privyIdentity.ts` beside the URL-building function that consumes it, so the literal
 *  exists once. */
export function privyApiUrl(env: Record<string, string | undefined>): string {
  const raw = env[PRIVY_API_URL_ENV];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_PRIVY_API_URL;
}

/** Everything the write path needs from the environment, resolved once. */
export interface WriteConfig {
  readonly privyAppId: string;
  readonly privyJwksUrl: string;
  readonly houseUrl: string;
  readonly houseToken: string;
  /** Derived from `houseToken`; see `rateLimit.ts#deriveBucketSecret` for why that input. Never
   *  logged, never returned to a caller, and only ever used as an HMAC key. */
  readonly bucketSecret: Uint8Array;
}

/**
 * THE WRITE PATH'S CONFIGURATION, OR NOTHING AT ALL.
 *
 * `null` means the gate is off, and the entry points must then construct no store, no cache and no
 * verifier and answer `disabled()`. A THROW means the gate is on and the deployment is not ready — a
 * cold-start failure, on the first request after the deploy, where somebody is looking.
 *
 * WHY THIS IS A FUNCTION IN A TESTED MODULE RATHER THAN SIX LINES IN EACH ENTRY POINT. The two rules
 * worth being sure of — "off means nothing is required" and "on means everything is required" — are
 * exactly the rules that cannot be checked by reading, because their failure is silent in one direction
 * (a disabled deployment that throws on a variable it does not need) and catastrophic in the other (an
 * enabled deployment that starts without a house token and cannot enforce §6.3). `env.test.ts` asserts
 * both. What is left in `/api/x/*.ts` is object assembly.
 *
 * Note the ORDER of the loads: the gate first, so a disabled deployment reads nothing else; then the
 * app id; then the house token. The house token is last because it is the one whose absence is also
 * checked at runtime by `HouseListCache`, so it has a second line of defence and the other two do not.
 */
export function writeConfig(env: Record<string, string | undefined>): WriteConfig | null {
  if (!linkWriteEnabled(env)) return null;

  const privyAppId = requirePrivyAppId(env);
  const houseToken = requireHouseToken(env);
  return {
    privyAppId,
    privyJwksUrl: privyJwksUrl(privyApiUrl(env), privyAppId),
    houseUrl: keeperHouseUrl(env),
    houseToken,
    bucketSecret: deriveBucketSecret(houseToken),
  };
}
