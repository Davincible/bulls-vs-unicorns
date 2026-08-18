// THE BROWSER'S HALF OF FACT A: obtaining the proof that this browser controls an X account.
//
// One export the ceremony calls — `identityProof()` — and it returns the exact artefact the server
// verifies and nothing else. The two halves have to agree about that artefact, so here is the contract
// in one place, with the file that enforces each half named:
//
//   WHAT THE SERVER ACCEPTS  (`er-demo/api/src/privyIdentity.ts`, reached from `/api/x/challenge`)
//     A PRIVY IDENTITY TOKEN: a compact ES256 JWS, three base64url segments, verified against Privy's
//     public JWKS at `https://api.privy.io/v1/apps/<appId>/jwks.json`. It must carry `iss: "privy.io"`,
//     an `aud` equal to our app id, a `sub`, an unexpired `exp`, an `iat` NO MORE THAN AN HOUR OLD, and
//     a `linked_accounts` claim — a STRINGIFIED JSON array — containing a `twitter_oauth` entry with a
//     numeric `subject` and a usable `username`.
//
//   WHAT THIS RETURNS
//     That token, verbatim, as a string. Never a fragment of it, never a rewrapped version, never a
//     different token. This module does not parse it, does not validate its claims and does not decide
//     whether it is good — the server does all of that, and a second opinion here would be a second
//     place for the two halves to disagree.
//
// ================================================================================================
// WHY THIS FILE IS REACHED WITH `await import()` AND MUST STAY THAT WAY.
//
// `useXCeremony.ts` imports it INSIDE the press handler, and that is deliberate: the identity feature
// is off unless somebody asks for it with `?links=`, the unlinked path is the main path
// (`TWITTER-CONNECT.md` §8), and an identity provider's SDK in the main chunk is paid for on every
// visit by the large majority who will never link anything. Vite gives this module its own chunk;
// only a player who actually presses `Connect X` — after reading the consent screen — downloads it.
//
// So: nothing may import this file statically. `xLinkCeremony.ts` deliberately does not, not even for
// the error type below, which is why the ceremony recognises that error BY NAME rather than with
// `instanceof` (a type-only import would be fine, but a value import would pull this chunk back into
// the main bundle and nobody would notice until a bundle report).
//
// ================================================================================================
// HOW THE TOKEN REACHES THE BROWSER. READ THIS BEFORE DEBUGGING.
//
// It reaches it because `xPrivy.ts` — the login trigger, imported below — sends the player to Privy,
// has them authorise X, and brings the result back inside the same promise this function returns. The
// SDK is `@privy-io/js-sdk-core`; the argument for that package, for a popup rather than a redirect,
// and for the ordering that keeps the popup openable, is written out there rather than repeated here.
//
// THIS FILE STOPPED BEING A PURE READER WHEN THAT LANDED, AND KEPT ITS CONTRACT. `identityProof()`
// still returns the artefact at the top of this file, verbatim, or `null`, or throws — and every
// caller is unchanged. What was added underneath is the part that makes there be something to return.
//
// ------------------------------------------------------------------------------------------------
// WHAT THIS FILE USED TO SAY ABOUT PRIVY'S STORAGE, AND WHY IT IS WORTH RECORDING THAT IT WAS WRONG.
//
// Until the SDK was actually installed and read, this header stated that Privy writes the identity
// token to `localStorage` under `privy:<appId>:id-token`. IT DOES NOT, and the mistake is instructive
// enough to leave visible. Read out of the shipped bundle
// (`node_modules/@privy-io/js-sdk-core/dist/esm/index.mjs`, `storeIdentityTokenForUser`), what it
// actually does on every successful authentication is write the token FOUR times:
//
//     localStorage  privy:<privyUserId>:id-token   scoped by the PRIVY USER DID, not by the app id
//     localStorage  privy:id-token                 unscoped, written unconditionally beside it
//     cookie        privy-<privyUserId>-id-token   secure, sameSite=Strict
//     cookie        privy-id-token                 unscoped, written unconditionally beside it
//
// So `identityTokenKeys()`'s app-scoped key has never matched anything and never will, and the
// unscoped key it offers as a "fallback" is in fact the primary. The reads below worked only through
// the branch that was documented as the backstop — which is the exact failure mode this codebase
// keeps warning about: a thing that works for a reason nobody wrote down.
//
// A SECOND, QUIETER ERROR IN THE SAME PLACE: the SDK's `LocalStorage` JSON-ENCODES what it stores
// (`put(k, v) { localStorage.setItem(k, JSON.stringify(v)) }`), so the raw localStorage value is a
// QUOTED string — `"eyJhbGci…"` — which the compact-JWS shape check below rejects. Read directly, the
// token therefore failed the shape test and this module fell through to the cookie, where js-cookie
// stores it unquoted. Both halves of that are now handled explicitly: `tokenFromStoredValue()` strips
// the quoting, and the SDK's own `getIdentityToken()` (which decodes properly) is tried first.
//
// ------------------------------------------------------------------------------------------------
// THE ONE FAILURE THAT IS STILL NOT THIS CODE'S TO FIX: THE DASHBOARD TOGGLE.
//
// "Return user data in an identity token" is OFF by default on a Privy app. Until an operator turns it
// on, Privy issues NO identity token at all — the login succeeds, the user exists, and the artefact
// the server needs is simply never minted. `er-demo/api/README.md` lists this first among the settings
// that cannot be set from this repo.
//
// It is reported by throwing, loudly, with a message that names it. That is the whole reason this
// module is more than a one-liner: the README warns that a misconfigured app makes the ceremony
// "silently do nothing", and silence is exactly what a `return null` here would produce — the ceremony
// reads `null` as "the player closed the window", which would tell a developer the opposite of what
// happened.
//
// ================================================================================================
// REJECTED ALTERNATIVES.
//
//   *Import `@privy-io/react-auth` and call its standalone `getIdentityToken()`.* Rejected, and this
//   is now a decision rather than a deferral. It is ~628 KB gzip against `js-sdk-core`'s far smaller
//   footprint, it carries viem, WalletConnect and the Coinbase SDK as HARD dependencies for an app
//   that touches none of them, and it wants `<PrivyProvider>` at the app root — which puts an identity
//   SDK in the MAIN chunk for every visitor, and the whole shape of this seam exists to prevent that.
//   The full comparison is in `xPrivy.ts`.
//
//   *Keep this file a pure reader and put the login somewhere else — a provider, a route, an effect.*
//   Rejected: every version of that has to run for people who will never link anything, which is the
//   cost this design refuses. A login that only exists inside the press handler is a login that is
//   never downloaded by anybody who does not press.
//
//   *Return `""` or `null` when there is no token and let the server refuse it.* Rejected: the server
//   would answer `bad-proof`, the player would read "X linking is unavailable right now. Try again in a
//   minute", and the actual cause — a dashboard switch nobody has flipped — would be invisible to
//   everybody, for ever. A configuration failure must not be dressed as a transient one.
//
//   *Fall back to asking the player for their handle.* There is no such path anywhere in this feature
//   and there must not be one. `web/index.html:2900` answered every OAuth failure that way and wrote
//   the answer through the same message as a proven one, which is the defect this whole feature exists
//   to delete. `LinkRequest` has no handle field to put it in.
// ================================================================================================

// A STATIC IMPORT, INSIDE A CHUNK NOTHING IMPORTS STATICALLY — which is why it does not undo the
// laziness. `useXCeremony.ts` reaches this module with `await import()`, so everything this module
// pulls in lives in that dynamic subgraph and is fetched at the same moment: on a press, by a player
// who has read the consent screen. The rule the header states — "nothing may import THIS file
// statically" — is unchanged, and it is the rule that does the work.
import { identityTokenViaPrivy, type PrivyProofOutcome } from "./xPrivy.ts";

/** The cookie Privy's SDK sets alongside its access token. Named once, here. */
export const IDENTITY_TOKEN_COOKIE = "privy-id-token";

/**
 * Where to look for the identity token in `localStorage`, in order.
 *
 * THE SECOND KEY IS THE REAL ONE. The header explains what was read out of the shipped SDK: it scopes
 * by the PRIVY USER DID (`privy:<did:privy:…>:id-token`), not by the app id, and it writes the
 * unscoped `privy:id-token` beside it unconditionally. So the unscoped key is the one that is always
 * present, and the app-scoped key this function puts first has never matched anything.
 *
 * IT IS KEPT ANYWAY, and only because it is free — one extra `getItem` on a key that is absent, on a
 * path that is itself only a fallback for the SDK's own accessor. Removing it would be a change to a
 * pinned public function for no behavioural gain; what was actually wrong was the sentence that used
 * to be here, claiming this key isolated two Privy apps sharing an origin. It does not. Privy's own
 * isolation is per-user, and two apps on one origin DO share `privy:id-token` — which is Privy's
 * design and not something this function can fix.
 *
 * `VITE_PRIVY_APP_ID` is the same public client id the server compares every token's `aud` against
 * (`api/src/writeEnv.ts` accepts it under that name for exactly this reason: one value, two acceptable
 * spellings, so the two halves cannot disagree).
 */
export function identityTokenKeys(appId: string | undefined): readonly string[] {
  const scoped = appId === undefined || appId.trim() === "" ? [] : [`privy:${appId.trim()}:id-token`];
  return [...scoped, "privy:id-token"];
}

/**
 * Thrown when no proof can be obtained. Carries no token and no cookie contents — only a sentence
 * about configuration.
 *
 * THE NAME IS PART OF THE CONTRACT. `xLinkCeremony.ts` distinguishes this from a player closing the
 * popup by reading `error.name`, because importing this class as a value would drag this chunk into
 * the main bundle (see the header). Renaming the class therefore changes behaviour in another file;
 * `xProof.test.ts` pins the string so that cannot happen quietly.
 */
export class ProofUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofUnavailableError";
  }
}

/**
 * A compact JWS, shape only: three non-empty base64url segments.
 *
 * NOT A VALIDATION, and deliberately not one. The server verifies the signature, the issuer, the
 * audience, the age and the claims (`privyIdentity.ts`), and anything this file checked beyond
 * "plausibly a token" would be a rule living in two places that can disagree. What this does catch is
 * a cookie that holds something else entirely — a session id, a JSON blob, an empty string — which is
 * worth refusing here because sending it would spend one of the player's rate-limited attempts to be
 * told `bad-proof`.
 */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Pull the identity token out of a `document.cookie` string.
 *
 * PURE, AND EXPORTED FOR THAT REASON: it is the only part of this module with a decision in it, and
 * this repository's testing discipline is that decisions live in pure functions that `npx vitest run`
 * can reach without a DOM (there is no component-test harness here, by design — see the `.test.ts`
 * files beside this one).
 *
 * Splitting on `"; "` is not enough: a cookie header is `name=value` pairs separated by `;` with
 * OPTIONAL whitespace, values may contain `=` (a JWS does not, but a future value might), and a name
 * that merely ENDS with ours — `not-privy-id-token` — must not match.
 */
export function proofFromCookie(cookieHeader: string): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader === "") return null;

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== IDENTITY_TOKEN_COOKIE) continue;

    // `decodeURIComponent` because a cookie value is percent-encoded by anything that follows the
    // spec. A JWS has no characters that require encoding, so this is almost always a no-op — and it
    // is the almost that matters: an encoded value passed through raw would fail the shape check below
    // and be reported as a configuration fault rather than as the token it is.
    const raw = pair.slice(separator + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    return COMPACT_JWS.test(value) ? value : null;
  }
  return null;
}

/**
 * A token out of a raw `localStorage` value, or `null` if that value is not one.
 *
 * PURE, AND EXPORTED FOR THAT REASON, like `proofFromCookie` above and for the same discipline.
 *
 * WHY THERE IS UNWRAPPING TO DO AT ALL. The SDK's `LocalStorage` writes through `JSON.stringify`, so
 * the stored value of a string is a QUOTED string — `"eyJhbGci…"`, five extra bytes that make the
 * compact-JWS check below fail. Reading it back with `JSON.parse` is the SDK's own inverse and is what
 * `getIdentityToken()` does; this function is what happens when we are reading past the SDK rather
 * than through it, which is the only situation this fallback exists for.
 *
 * IT ACCEPTS BOTH FORMS. A bare token is returned as-is, because that is what an older SDK, a
 * hand-written test fixture, or a value copied out of the cookie looks like — and refusing it would
 * mean this fallback failed in exactly the case somebody reached for it. Anything that parses to a
 * non-string (an object, a number, `null`) is not a token and is refused.
 */
export function tokenFromStoredValue(raw: string | null): string | null {
  if (typeof raw !== "string" || raw === "") return null;

  let value = raw;
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "string") return null;
      value = parsed;
    } catch {
      return null;
    }
  }
  return COMPACT_JWS.test(value) ? value : null;
}

/**
 * Turn the login trigger's outcome into this module's contract.
 *
 * PURE, AND THE ONE PLACE THE DISTINCTION IS MADE. `xPrivy.ts` deliberately returns an outcome rather
 * than throwing, precisely so that this mapping is a decision somebody wrote down instead of a
 * consequence of which error class happened to escape a leaf function. The distinction it protects is
 * the one `xLinkCeremony.ts` acts on:
 *
 *   `cancelled`   -> `null`                  -> "You cancelled before X confirmed."
 *   `unavailable` -> `ProofUnavailableError` -> "X linking is unavailable right now."
 *
 * A player who closes the OAuth window must land in the first row and a misconfigured app in the
 * second, and getting that backwards is how a configuration fault becomes invisible for ever.
 *
 * THE REASON IS LOGGED, THE TOKEN NEVER IS. `xPrivy.ts` builds `why` from causes only — it wraps calls
 * that run before any token exists — and the console line is the only trace an operator gets, because
 * the sentence the player reads is deliberately the same for every failure of this kind.
 */
export function proofFromOutcome(outcome: PrivyProofOutcome): string | null {
  if (outcome.kind === "proof") return outcome.token;
  if (outcome.kind === "cancelled") return null;

  console.error(`[xlink] no Privy identity token — ${outcome.why}`);
  throw new ProofUnavailableError(
    `No Privy identity token could be obtained: ${outcome.why} See er-demo/api/README.md, `
      + `"What the operator has to do by hand".`,
  );
}

/**
 * The proof, or a thrown explanation.
 *
 * RETURNS `null` FOR EXACTLY ONE THING: the player closed the X window, or left it unanswered. The
 * ceremony reads `null` as that and tells them so. Everything else this can observe is a fault nobody
 * standing at the keyboard caused, and those throw.
 *
 * NEVER LOGS THE TOKEN, and never includes it in the error. It is a bearer proof of somebody's X
 * identity for as long as it lives — whoever holds it can present it with their own wallet — so it
 * exists in this program only as a return value that goes straight into a request body over TLS.
 */
export async function identityProof(): Promise<string | null> {
  // `document` is guarded rather than assumed: this module is dynamically imported, and an import that
  // throws a `ReferenceError` during module evaluation is a chunk-load failure, which the ceremony
  // reports as the generic outage rather than as the specific thing that is wrong.
  if (typeof document === "undefined") {
    throw new ProofUnavailableError(
      "X linking needs a browser. There is no document to read Privy's identity token from.",
    );
  }

  // THE LOGIN TRIGGER FIRST — it is the only path that can produce a token that did not already
  // exist, and on the path where one does exist it re-mints it so the age the server checks is known
  // rather than assumed (`xPrivy.ts`, "FRESHNESS").
  //
  // WRAPPED, EVEN THOUGH `identityTokenViaPrivy` IS WRITTEN NOT TO THROW. That rule is worth having
  // and is not worth trusting: it is a property of every line of another file, and it has already
  // been broken once (an unwrapped `getIdentityToken()` — which reads storage, and therefore throws
  // in a browser that will not open it). The cost of it breaking again is not a stack trace, it is a
  // WRONG SENTENCE: `xLinkCeremony.ts` reads any escaped error that is not `ProofUnavailableError`
  // as the player cancelling, so a storage fault would be reported as somebody's own choice.
  //
  // So the rule is enforced HERE, at the boundary that owns the `null` vs `ProofUnavailableError`
  // distinction, rather than asserted in a comment in the file it constrains.
  let outcome: PrivyProofOutcome;
  try {
    outcome = await identityTokenViaPrivy();
  } catch (e) {
    outcome = {
      kind: "unavailable",
      why: `the login trigger threw instead of reporting: ${
        e instanceof Error && e.message !== "" ? e.message : "unknown error"
      }.`,
    };
  }
  if (outcome.kind !== "unavailable") return proofFromOutcome(outcome);

  // THE RAW READS ARE A BACKSTOP, NOT A SECOND OPINION, and they only run when the SDK produced
  // nothing. They are what is left when the SDK path is broken but a token from an earlier press is
  // still sitting on this origin: a network that has since gone away, a Privy API that is refusing
  // requests, an `allowed_domains` change. In that state a token this browser already holds is still
  // exactly what the server accepts, and sending it costs nothing to try.
  //
  // Wrapped because a browser with storage disabled (Safari's Lockdown mode, a hardened profile)
  // throws on the property access itself rather than returning null, and that would surface as a
  // chunk-load failure instead of as the configuration problem it is.
  try {
    for (const key of identityTokenKeys(import.meta.env?.VITE_PRIVY_APP_ID)) {
      const stored = tokenFromStoredValue(window.localStorage.getItem(key));
      if (stored !== null) return stored;
    }
  } catch {
    // Fall through to the cookie, which does not need storage permission.
  }

  const token = proofFromCookie(document.cookie);
  if (token !== null) return token;

  // Nothing anywhere. `proofFromOutcome` says why, once, and throws.
  return proofFromOutcome(outcome);
}
