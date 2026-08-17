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
// HOW THE TOKEN REACHES THE BROWSER, AND THE PART THAT IS NOT YET BUILT. READ THIS BEFORE DEBUGGING.
//
// Privy's SDK, on a successful authentication, writes the identity token to TWO places on the app's own
// origin: `localStorage` under `privy:<appId>:id-token` (falling back to `privy:id-token`), and a cookie
// named `privy-id-token` set with `secure` and `sameSite=Strict`. Both are written by JavaScript in the
// page — which is what makes them readable here, and is why this module can be a reader rather than an
// integration. It reads localStorage first because that is the SDK's own primary store; the cookie is
// the fallback.
//
// IT DOES NOT PERFORM THE OAUTH ROUND TRIP. There is no Privy SDK in this bundle and
// `@privy-io/react-auth` is not a dependency of this project.
//
// WHICH MEANS THE CEREMONY CANNOT YET SUCCEED END TO END, and this file is the honest place to say so
// rather than the place to paper over it. Two things are missing and both are outside this module:
//
//   1. THE LOGIN TRIGGER. Something has to send the player to Privy, have them authorise X, and come
//      back — after which the cookie exists. That is the SDK integration (or the raw
//      `auth.privy.io/api/v1/oauth/*` round trip the previous build hand-rolled), and it is a separate
//      piece of work with a dependency decision attached to it.
//   2. THE DASHBOARD TOGGLE. "Return user data in an identity token" is OFF by default on a Privy app.
//      Until an operator turns it on, Privy issues NO identity token at all, so the cookie never
//      appears however well the login works. `er-demo/api/README.md` lists this first among the
//      settings that cannot be set from this repo.
//
// Both failures land in the same place — no cookie — and both are reported by throwing, loudly, with a
// message that names them. That is the whole reason this module exists as more than a one-liner: the
// README warns that a misconfigured app makes the ceremony "silently do nothing", and silence is
// exactly what a `return null` here would produce (the ceremony reads `null` as "the player closed the
// window", which would tell a developer the opposite of what happened).
//
// WHEN THE SDK LANDS, THIS FUNCTION GETS ONE LINE AND KEEPS ITS CONTRACT. `@privy-io/react-auth`
// exports `getIdentityToken(): Promise<string | null>` as a STANDALONE function — not a hook — which is
// exactly the shape this imperative seam needs, callable from inside a press handler with no React
// context of its own. The reads below become its fallback rather than its replacement:
//
//     const token = await getIdentityToken();          // the sanctioned accessor
//     if (token !== null) return token;                // …then the two reads below, then throw
//
// Nothing else in the ceremony changes when that happens, which is the point of this seam: the login
// trigger and the token accessor are one file's problem, and the thing they produce is fixed by the
// contract at the top of this file.
//
// ================================================================================================
// REJECTED ALTERNATIVES.
//
//   *Import `@privy-io/react-auth` here and call `getIdentityToken()`.* Rejected FOR NOW because it is
//   a dependency decision, not an implementation detail: the SDK wants `<PrivyProvider>` at the app
//   root, which is a change to the main bundle and to the app's shape, and it is exactly the kind of
//   thing that should be decided with its install size and peer dependencies on the table rather than
//   arrived at from inside a leaf module. When it lands, it lands HERE, behind this same function.
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

/** The cookie Privy's SDK sets alongside its access token. Named once, here. */
export const IDENTITY_TOKEN_COOKIE = "privy-id-token";

/**
 * Where the SDK keeps the identity token in `localStorage`. The app id is part of the key so that two
 * Privy apps on one origin — production and a preview app, which is Privy's own recommendation for
 * `*.vercel.app` deployments, since that hostname cannot be allowlisted — cannot read each other's
 * token.
 *
 * `VITE_PRIVY_APP_ID` is the same public client id the server compares every token's `aud` against
 * (`api/src/writeEnv.ts` accepts it under that name for exactly this reason: one value, two acceptable
 * spellings, so the two halves cannot disagree). When it is unset at build time the unscoped key is the
 * SDK's own fallback and is tried too.
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
 * The proof, or a thrown explanation.
 *
 * RETURNS `null` FOR NOTHING. The ceremony reads `null` as "the player closed the X window" and tells
 * them so; this function has no way to observe that, because it never opens one. Everything it can
 * observe is a configuration fault, and those throw.
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

  // localStorage FIRST — the SDK's primary store — then the cookie. Wrapped because a browser with
  // storage disabled (Safari's Lockdown mode, a hardened profile) throws on the property access itself
  // rather than returning null, and that would surface as a chunk-load failure instead of as the
  // configuration problem it is.
  try {
    for (const key of identityTokenKeys(import.meta.env?.VITE_PRIVY_APP_ID)) {
      const stored = window.localStorage.getItem(key);
      if (stored !== null && COMPACT_JWS.test(stored)) return stored;
    }
  } catch {
    // Fall through to the cookie, which does not need storage permission.
  }

  const token = proofFromCookie(document.cookie);
  if (token !== null) return token;

  // SAID OUT LOUD, ONCE, BEFORE THROWING. The ceremony's `catch` around `getProof` cannot tell this
  // apart from a player closing an OAuth window, so without this line the only trace of a
  // misconfigured Privy app would be a player being told they cancelled something they never started —
  // which is the exact silence `er-demo/api/README.md` warns about. The message names causes only; the
  // token is never logged, and on this path there is no token to log.
  console.error(
    "[xlink] no Privy identity token. The login flow is not wired into this build, and/or the Privy " +
      'app\'s "Return user data in an identity token" setting is off.',
  );

  throw new ProofUnavailableError(
    // Both causes, in the order they are worth checking, because the second is invisible from inside
    // the browser and the first is invisible from inside the Privy dashboard.
    `No Privy identity token (cookie "${IDENTITY_TOKEN_COOKIE}") is present. Either this browser has ` +
      `not authorised X through Privy yet — the login flow is not wired into this build — or the ` +
      `Privy app's "Return user data in an identity token" setting is off, in which case Privy issues ` +
      `no identity token at all. See er-demo/api/README.md, "What the operator has to do by hand".`,
  );
}
