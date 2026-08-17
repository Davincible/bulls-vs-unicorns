// PROVING FACT A: THIS BROWSER CONTROLS AN X ACCOUNT.
//
// One signature check against Privy's published public keys, and a careful read of the claims it
// covers. Nothing else in this feature is allowed to produce an `XIdentity`.
//
// ================================================================================================
// WHICH PRIVY VERIFICATION PATH THIS IS, AND WHY IT IS NOT THE SDK.
//
// Three roads lead to "the server knows this player's X handle". They were all walked before this file
// was written, and the decision is not close.
//
//   1. `@privy-io/server-auth`'s `verifyAuthToken`. THE BRIEF NAMED THIS PACKAGE AND IT IS DEPRECATED
//      — npm carries the notice in as many words, pointing at `@privy-io/node`. Worse, the method is
//      the wrong one regardless of package: `verifyAuthToken` verifies an ACCESS token, and an access
//      token's claims are `{app_id, issuer, issued_at, expiration, session_id, user_id}` — a Privy
//      DID and nothing else. The handle would then need `GET /v1/users/<did>` with `PRIVY_APP_SECRET`,
//      which means an outbound authenticated HTTPS call ON THE WRITE PATH: a second failure mode a
//      player can feel, a rate limit somebody else controls, and our app secret loaded into the most
//      attacker-exposed function we run. Privy's own docs are explicit that `verifyAuthToken` "will
//      not work on identity tokens".
//
//   2. `@privy-io/node`'s `verifyIdentityToken`. The current, correct SDK call, and it does exactly
//      what this file does. Rejected on WEIGHT AND ON WHERE THAT WEIGHT LANDS: 4.5 MB unpacked across
//      1,039 files, pulling `jose`, `svix`, `lru-cache`, two `@hpke/*` packages and `canonicalize`. It
//      would go into a Vercel Function whose dependency graph is walked file-by-file by `@vercel/nft`
//      with a documented `.js`→`.ts` resolution FALLBACK, three silent failure edges, and a README
//      section devoted to noticing when the graph has grown (`er-demo/api/README.md`). Spending a
//      thousand untraced files, in that graph, to obtain one ES256 signature check is not a trade this
//      directory should make. The install is also the whole `client()` surface — user deletion,
//      wallet creation, webhooks — reachable from a function that must only ever read.
//
//   3. VERIFY THE IDENTITY TOKEN OURSELVES, against Privy's public JWKS, with the platform's own
//      crypto. CHOSEN, and the reasons compound:
//
//      * THE IDENTITY TOKEN ALREADY CARRIES THE X ACCOUNT, signed. `linked_accounts` holds the
//        numeric id, the handle, the display name and the avatar. So one verified signature answers
//        the whole question and the write path makes NO outbound call to Privy at all beyond a
//        long-cached fetch of public keys. Compare road 1: two network dependencies and a credential.
//      * NO NEW DEPENDENCY. WebCrypto's `subtle.verify` does ECDSA P-256/SHA-256 natively, which is
//        precisely what ES256 is, and a JWS signature is already the raw `r||s` pair WebCrypto wants —
//        there is no DER unwrapping and no bignum arithmetic here, which is the part that would
//        otherwise justify a library.
//      * IT IS TESTABLE OFFLINE, WHICH THE OTHERS ARE NOT. `privyIdentity.test.ts` generates a P-256
//        keypair, publishes it as a JWKS through a fake `fetch` and MINTS REAL TOKENS. Every refusal
//        below — wrong issuer, wrong audience, expired, `alg: none`, a swapped key, a stale token, no
//        X account — is exercised against a genuine signature rather than a mocked verifier. A
//        vendored SDK plus a network call can only be tested by trusting it.
//      * NO APP SECRET. `PRIVY_APP_SECRET` is set in this project's environment and this path never
//        reads it. The JWKS endpoint is public and unauthenticated (probed: 200, no credentials), so
//        the write path holds no Privy credential of any kind and there is nothing here to leak.
//
// WHAT ROAD 3 COSTS, STATED PLAINLY: two behaviours of Privy's SDK are UNDOCUMENTED and are
// reimplemented here from the shipping source — the `linked_accounts` claim being a STRINGIFIED array,
// and the `pfp` field being a PATH FRAGMENT rather than a URL. If Privy changes either, this file
// mis-parses. The blast radius of that is bounded by design and the bound is worth naming: a
// mis-parsed handle fails `HANDLE_RE` and the link is REFUSED; a mis-expanded avatar fails the
// `avatar_url` CHECK in migration 0001 and is stored as NULL, which renders as the flat disc. Neither
// failure can produce a wrong identity or an outbound request to a host we did not intend, because in
// both cases the thing that catches it is a pattern the database enforces rather than a hope this file
// is current.
// ================================================================================================

import type { XIdentity } from "./writeStore.js";

/**
 * WEBCRYPTO THROUGH THE GLOBAL `crypto`, NOT THROUGH `import { webcrypto } from "node:crypto"`, AND THE
 * DIFFERENCE IS NOT COSMETIC.
 *
 * The named import is `undefined` under vitest. Node itself exports it — `import("node:crypto")` in a
 * bare `node -e` gives an object with a `subtle` on it — but `crypto.webcrypto` is a LAZY GETTER on the
 * builtin's namespace, and vite's interop for node builtins does not carry it across. So
 * `webcrypto.subtle.verify` compiles, type-checks, passes review, and throws
 * `Cannot read properties of undefined (reading 'subtle')` the first time a test runs it. It was written
 * that way here and `privyIdentity.test.ts` caught it on its first run, which is the entire argument for
 * having a test that mints a real token rather than one that mocks a verifier.
 *
 * `globalThis.crypto` is the same `Crypto` instance, is a plain global in Node 18+ (this project pins
 * Node 24 in `/package.json`), works identically under vitest and on Vercel's runtime, and is the
 * spelling every non-Node runtime uses as well. `rateLimit.ts` keeps `import { createHmac } from
 * "node:crypto"` because THAT export is an ordinary function and is unaffected — the rule is narrow and
 * specific to the lazily-initialised `webcrypto` namespace.
 */
const subtle = globalThis.crypto.subtle;

/** Privy's `iss`, exactly. Not a URL — the SDK pins the literal string and so do we. */
export const PRIVY_ISSUER = "privy.io";

/** Where the JWKS lives. `api.privy.io` is what the current SDK builds (`${apiUrl}/v1/apps/${appId}/jwks.json`);
 *  `auth.privy.io/api/v1/...` serves the identical body and is the older spelling. One of them, chosen,
 *  not both attempted. */
export const DEFAULT_PRIVY_API_URL = "https://api.privy.io";

/** The one algorithm. ANY OTHER VALUE IS A REFUSAL, including `none`, including `HS256`: accepting a
 *  token's own word about how to verify it is the oldest hole in JWT and the only defence is a
 *  hardcoded allowlist of one. */
const REQUIRED_ALG = "ES256";

/** Keys are cached for an hour, matching what Privy's own SDK asks `jose` for (`cacheMaxAge: 60min`). */
export const JWKS_TTL_SECONDS = 3600;

/** …and a forced refetch on an unrecognised `kid` is allowed at most this often, matching the SDK's
 *  `cooldownDuration: 10min`. Without a cooldown, a stream of tokens carrying a junk `kid` is a stream
 *  of outbound requests to Privy — a rate limit we would be inflicting on ourselves. */
export const JWKS_COOLDOWN_SECONDS = 600;

const JWKS_FETCH_TIMEOUT_MS = 2_000;

/** Tolerance on `exp` and `iat`, for the ordinary case that our clock and Privy's differ by a moment.
 *  A minute is generous for two hosted clocks and negligible against a token lifetime measured in
 *  hours. */
export const CLOCK_SKEW_SECONDS = 60;

/**
 * HOW OLD AN IDENTITY TOKEN MAY BE, and this is the one policy in this file that is ours rather than
 * Privy's.
 *
 * THE THREAT. The identity token is a BEARER PROOF of somebody's X identity. Whoever holds it can
 * present it with THEIR OWN wallet and put the victim's handle on it — the wallet signature protects
 * the wallet, not the handle, so this half of the ceremony has no second factor. Privy's default
 * lifetime is long (their docs say 1 hour in one place and 10 hours in another, and the value is
 * configurable in the dashboard), and every one of those hours is a window in which a token recovered
 * from a log, a proxy, or a compromised extension is an impersonation.
 *
 * WHY AN HOUR IS THE RIGHT CAP AND WHY IT DOES NOT COST A LEGITIMATE PLAYER ANYTHING. Privy mints a
 * FRESH identity token on authenticate, on link, on unlink and on page refresh. The natural client
 * flow — press "Connect X", authorise with X, read the token, sign — produces a token that is seconds
 * old. The only way to arrive here with an hour-old token is to have authorised X, walked away, and
 * come back; and for that case the client has `refreshUser()`, which mints a new one. So the cap is
 * paid by an attacker and not by a player.
 *
 * The client requirement this imposes is written down in `er-demo/api/README.md` rather than left for
 * somebody to discover from a `stale` rejection: OBTAIN THE TOKEN IMMEDIATELY BEFORE THE CEREMONY.
 *
 * REJECTED: honouring only `exp` and telling the operator to shorten the lifetime in the Privy
 * dashboard. It is a setting in somebody else's console that nothing in this repo can assert, and a
 * security property that depends on a dashboard nobody has checked is not a security property.
 */
export const MAX_IDENTITY_TOKEN_AGE_SECONDS = 3600;

/** X's own rules, and the same expression as `HANDLE_RE` in `xLink.ts` and the CHECK in migration
 *  0001. Three copies of one rule, in three places that cannot import each other. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_ID_RE = /^[0-9]{1,20}$/;

/** `display_name` is bounded at 100 CHARACTERS by migration 0001, and `char_length` in Postgres counts
 *  code points — so the truncation below must count code points too, not UTF-16 units. */
const MAX_DISPLAY_NAME_CODEPOINTS = 100;

/**
 * Why a token was not accepted. Every one of these is a REFUSAL TO LINK and none of them is ever
 * relayed to a browser verbatim: the handler maps the lot onto a small number of statuses, because a
 * caller who can distinguish "wrong audience" from "bad signature" is a caller being helped to forge
 * one.
 *
 * They exist for the log line and for the tests, which is where knowing exactly which rule refused is
 * worth a great deal.
 */
export type PrivyRejection =
  /** Not three segments, not base64url, not JSON, no `kid`, a `crit` header, or `alg` != ES256. */
  | "malformed"
  /** The `kid` is not in Privy's key set, even after a cooldown-limited refetch. */
  | "unknown-key"
  /** The key was found and the signature does not check out. */
  | "bad-signature"
  | "wrong-issuer"
  | "wrong-audience"
  /** `exp` has passed (or is missing). */
  | "expired"
  /** Older than `MAX_IDENTITY_TOKEN_AGE_SECONDS`, or `iat` is in the future beyond the skew. */
  | "stale"
  /** A valid token for a Privy user with no X account linked. The ordinary "they cancelled the OAuth
   *  popup" outcome, and the one a client should expect to see. */
  | "no-x-account"
  /** An X account is present but cannot be represented: no usable handle, a non-numeric id, or more
   *  than one X account on the user. */
  | "unusable-x-account"
  /** Privy's public keys could not be obtained at all. FAIL CLOSED: no keys, no links. */
  | "keys-unavailable";

export type PrivyVerification =
  | { readonly kind: "ok"; readonly identity: XIdentity }
  | { readonly kind: "rejected"; readonly reason: PrivyRejection };

/** What the handlers depend on. Structural rather than the class, so `challengeHandler.ts` cannot
 *  reach a cache's internals and a test can answer the question directly. Same arrangement as
 *  `HouseListSource` in `houseWallets.ts`, for the same reason. */
export interface PrivyVerifier {
  verify(token: string, nowSec: number): Promise<PrivyVerification>;
}

// ------------------------------------------------------------------------------------------------
// Decoding — all of it pure, none of it trusting
// ------------------------------------------------------------------------------------------------

/** base64url, strictly: the URL alphabet, no padding, no `+`, no `/`. Anchored, so a token segment
 *  with a plausible prefix is a rejection rather than a prefix. */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * `Uint8Array<ArrayBuffer>` RATHER THAN A BARE `Uint8Array`, AND THE ANNOTATION IS LOAD-BEARING.
 *
 * Since TypeScript 5.7 `Uint8Array` is generic over its backing buffer and defaults to
 * `Uint8Array<ArrayBufferLike>` — which includes `SharedArrayBuffer` and is therefore NOT assignable to
 * WebCrypto's `BufferSource`. So `subtle.verify(alg, key, signature, signingInput)` fails to compile
 * with "Uint8Array<ArrayBufferLike> is not assignable to BufferSource" even though the value is a plain
 * array of bytes this function just allocated. Pinning the parameter here fixes it at the source
 * instead of casting at the call site, which is the same class of error `/api/tsconfig.json` records for
 * `avatarHandler.ts`'s `new Response(bytes, …)` and the same resolution: make the type say what is
 * actually true rather than widen something to accommodate a wrong type.
 */
export function base64UrlToBytes(segment: string): Uint8Array<ArrayBuffer> | null {
  if (segment === "" || !B64URL_RE.test(segment)) return null;
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (segment.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function jsonFrom(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

interface DecodedJwt {
  readonly kid: string;
  readonly payload: Record<string, unknown>;
  /** `header.payload` as ASCII bytes — exactly what the signature covers. `Uint8Array<ArrayBuffer>`
   *  for the reason `base64UrlToBytes` documents: WebCrypto's `BufferSource` does not accept the wider
   *  default. */
  readonly signingInput: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
}

/**
 * Split and decode, refusing everything that is not a well-formed ES256 JWS.
 *
 * `alg` IS CHECKED HERE, BEFORE ANY KEY IS FETCHED, and it is checked against one literal. The
 * canonical JWT attack is to hand the verifier a token whose header says `none` (or `HS256`, so a
 * public key gets used as an HMAC secret) and let the library follow instructions from the thing it is
 * verifying. There is no arrangement of this file in which that works, because the algorithm is never
 * read from the token for any purpose other than refusing it.
 *
 * A `crit` header is also a refusal: it means "you must understand this extension or reject", and we
 * understand none.
 */
export function decodeJwt(token: string): DecodedJwt | null {
  if (typeof token !== "string") return null;
  // A bound before any parsing. A real identity token is ~1 KB; anything past 8 KB is not one, and
  // there is no reason to base64-decode a megabyte to find that out.
  if (token.length === 0 || token.length > 8192) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const headerBytes = base64UrlToBytes(parts[0]);
  const payloadBytes = base64UrlToBytes(parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  if (headerBytes === null || payloadBytes === null || signature === null) return null;
  // ES256 signatures are exactly r||s, 32 bytes each. Checked before the key lookup so a malformed
  // signature costs no network.
  if (signature.length !== 64) return null;

  const header = jsonFrom(headerBytes);
  const payload = jsonFrom(payloadBytes);
  if (typeof header !== "object" || header === null) return null;
  if (typeof payload !== "object" || payload === null) return null;

  const h = header as Record<string, unknown>;
  if (h.alg !== REQUIRED_ALG) return null;
  if (h.crit !== undefined) return null;
  if (typeof h.kid !== "string" || h.kid === "") return null;

  // `header.payload`, the exact ASCII the signer signed. Rebuilt from the original segments rather
  // than re-encoded from the parsed objects — re-encoding would re-serialise JSON and produce
  // different bytes for the same token.
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  return { kid: h.kid, payload: payload as Record<string, unknown>, signingInput, signature };
}

/**
 * `pfp` -> a `pbs.twimg.com` URL, or `null`.
 *
 * PRIVY STORES THIS COMPRESSED AND THE EXPANSION IS UNDOCUMENTED. The value in the token is not a URL:
 * it is the tail of one, with the host and the fixed path stripped to keep the JWT small. Their SDK
 * reinflates it with three branches, and this reproduces them:
 *
 *   `default…`            -> `https://abs.twimg.com/sticky/default_profile_images/…`
 *   already `https://…`   -> verbatim
 *   anything else         -> `https://pbs.twimg.com/profile_images/…`
 *
 * X'S DEFAULT EGG IS DELIBERATELY MAPPED TO `null` RATHER THAN TO ITS URL. It lives on
 * `abs.twimg.com`, a host `avatar_url`'s CHECK does not admit, and it is a picture we would decline
 * even if it did: §7.3's flat side-coloured disc is both better looking and more honest than a grey
 * silhouette, and ingesting the egg would spend a fetch, 6 KiB of `bytea` and a moderation surface to
 * end up worse off. `null` is the state migration 0002 exists to make storable.
 *
 * THE OUTPUT IS RE-CHECKED AGAINST THE `pbs.twimg.com` PREFIX at the end, which is what makes
 * reimplementing somebody's undocumented encoding safe rather than merely convenient: whatever this
 * function is handed, the only thing it can return is a URL on X's image CDN or nothing. `_normal` is
 * NOT rewritten here — `avatarIngest.ts#upgradeAvatarUrl` already owns that rule and doing it twice is
 * how two files come to disagree about one URL.
 */
export function expandTwitterAvatarUrl(pfp: unknown): string | null {
  if (typeof pfp !== "string") return null;
  const raw = pfp.trim();
  if (raw === "" || raw.length > 300) return null;

  // X's default profile images. Not stored — see above.
  if (raw.startsWith("default")) return null;

  const candidate = raw.startsWith("https://") ? raw : `https://pbs.twimg.com/profile_images/${raw}`;

  // A conservative shape for the whole URL. The fragment Privy sends is `<id>/<name>_normal.jpg`, so
  // this admits that and refuses anything carrying a character that could matter to a URL parser —
  // no `@` (which could move the authority), no whitespace, no control characters, nothing
  // percent-encoded. Belt and braces beside the prefix check: the prefix is what guarantees the host,
  // and this is what guarantees there is nothing surprising after it.
  if (!/^https:\/\/pbs\.twimg\.com\/[A-Za-z0-9._\-/]+$/.test(candidate)) return null;
  // No empty path segments. `//evil.example/x.png` expands to
  // `https://pbs.twimg.com/profile_images///evil.example/x.png`, whose host is still X's CDN and which is
  // therefore harmless — but it is also not a picture, and a URL this function returns should be one it
  // believes in rather than one it merely cannot be hurt by. Refusing keeps the output set to "URLs of
  // the shape X actually serves".
  if (candidate.includes("//", "https://".length)) return null;
  return candidate;
}

/** Truncate to `MAX_DISPLAY_NAME_CODEPOINTS` code points. `Array.from` iterates code points, so a
 *  surrogate pair is never split — a lone surrogate would be a string that cannot be encoded as UTF-8
 *  and would fail somewhere further down with a message about bytes. */
export function clampDisplayName(name: unknown): string {
  if (typeof name !== "string") return "";
  const points = Array.from(name.trim());
  return points.length <= MAX_DISPLAY_NAME_CODEPOINTS
    ? points.join("")
    : points.slice(0, MAX_DISPLAY_NAME_CODEPOINTS).join("");
}

/**
 * Pull the X identity out of a VERIFIED payload.
 *
 * `linked_accounts` IS A STRINGIFIED JSON ARRAY, not an array. That is undocumented and is what
 * Privy's own SDK does (`JSON.parse(payload.linked_accounts)`), and it is the first thing a
 * hand-rolled parser gets wrong. The entries are also ABBREVIATED relative to their REST
 * counterparts: an X account arrives as
 * `{type:"twitter_oauth", subject, username, name, pfp, lv}` — there is no `profile_picture_url`
 * here, and `subject` is the only field that can be relied on to exist.
 *
 * MORE THAN ONE X ACCOUNT IS A REFUSAL rather than a choice. Privy allows one account per type today,
 * so this should be unreachable; if it ever is reachable, picking the first would mean the register
 * silently records whichever identity happened to be serialised earliest, and there is no way for the
 * player to see or correct that. Refusing is the answer that cannot be wrong.
 */
export function xIdentityFromClaims(payload: Record<string, unknown>): PrivyVerification {
  const raw = payload.linked_accounts;
  // ABSENT AND WRONG-TYPED ARE DIFFERENT ANSWERS, and the distinction is the only defence this file has
  // against Privy changing the encoding under it. Absent is an ordinary event with an actionable
  // message: a verified Privy user who has linked nothing (or a token minted before they authorised X).
  // Present-but-not-a-string is not a user state at all — it is the day `linked_accounts` stops being a
  // stringified array — and calling that "you have not authorised X" would send every player to a
  // popup that cannot fix it while the real cause read as ordinary traffic. `malformed` is the honest
  // answer and it is the one that looks like a bug in the logs.
  if (raw === undefined || raw === null) return { kind: "rejected", reason: "no-x-account" };
  if (typeof raw !== "string") return { kind: "rejected", reason: "malformed" };

  let accounts: unknown;
  try {
    accounts = JSON.parse(raw);
  } catch {
    return { kind: "rejected", reason: "malformed" };
  }
  if (!Array.isArray(accounts)) return { kind: "rejected", reason: "malformed" };

  const x = accounts.filter(
    (a): a is Record<string, unknown> =>
      typeof a === "object" && a !== null && (a as { type?: unknown }).type === "twitter_oauth",
  );
  if (x.length === 0) return { kind: "rejected", reason: "no-x-account" };
  if (x.length > 1) return { kind: "rejected", reason: "unusable-x-account" };

  const entry = x[0];
  const xId = typeof entry.subject === "string" ? entry.subject.trim() : "";
  const handle = typeof entry.username === "string" ? entry.username.trim() : "";

  // BOTH OF THESE ARE HARD REQUIREMENTS AND THE HANDLE IS THE INTERESTING ONE. §4.4's answer to
  // display-name impersonation is one rule — "always render the @handle" — and X's own display policy
  // demands the same. An identity with no handle is an identity this product cannot render honestly,
  // so it is not stored at all. `username` really is nullable in Privy's own types, which is why this
  // is a checked case rather than a defensive one.
  if (!X_ID_RE.test(xId)) return { kind: "rejected", reason: "unusable-x-account" };
  if (!HANDLE_RE.test(handle)) return { kind: "rejected", reason: "unusable-x-account" };

  return {
    kind: "ok",
    identity: {
      xId,
      handle,
      displayName: clampDisplayName(entry.name),
      avatarUrl: expandTwitterAvatarUrl(entry.pfp),
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Privy's public keys
// ------------------------------------------------------------------------------------------------

/** The public half of one ES256 signing key, in the only four fields WebCrypto needs. Narrowed on
 *  purpose: `alg`, `use` and `kid` are dropped before import, because a JWK carrying a field
 *  WebCrypto disagrees with is an import error rather than a verification, and none of them affect
 *  the maths. */
interface EcPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
}

export type KeyLookup =
  | { readonly kind: "ok"; readonly jwk: EcPublicJwk }
  | { readonly kind: "unknown-key" }
  | { readonly kind: "keys-unavailable" };

/** `${apiUrl}/v1/apps/${appId}/jwks.json` — the shape Privy's SDK builds. Public and
 *  unauthenticated; there is no credential in this request and there must never be one, because a
 *  credential attached to a key fetch is a credential sent to whatever a redirect names. */
export function privyJwksUrl(apiUrl: string, appId: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/apps/${encodeURIComponent(appId)}/jwks.json`;
}

/** Reads `{"keys":[{kty,crv,x,y,kid,…}]}`. One malformed key invalidates the whole document rather
 *  than being skipped: a partially-parsed key set is a key set with a hole in it, and the hole is
 *  invisible until a rotation lands on it. Same rule as `houseWalletsFrom`. */
export function jwksFrom(body: unknown): Map<string, EcPublicJwk> | null {
  if (typeof body !== "object" || body === null) return null;
  const keys = (body as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;

  const out = new Map<string, EcPublicJwk>();
  for (const k of keys) {
    if (typeof k !== "object" || k === null) return null;
    const key = k as Record<string, unknown>;
    // Only P-256 signing keys are of any use here, and a set containing something else is not a
    // reason to refuse the ones we can read — Privy could publish an encryption key tomorrow. Skipped
    // rather than rejected, and skipped on a POSITIVE test of what we accept.
    if (key.kty !== "EC" || key.crv !== "P-256") continue;
    if (key.use !== undefined && key.use !== "sig") continue;
    if (typeof key.kid !== "string" || key.kid === "") return null;
    if (typeof key.x !== "string" || typeof key.y !== "string") return null;
    out.set(key.kid, { kty: "EC", crv: "P-256", x: key.x, y: key.y });
  }
  return out.size === 0 ? null : out;
}

export interface PrivyJwksDeps {
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
  readonly nowSec: () => number;
}

/**
 * An hour-cached view of Privy's key set, safe to call per request.
 *
 * Modelled on `HouseListCache` deliberately — instance-scoped state, one in-flight fetch at a time,
 * constructed once per worker at module scope — and it differs in ONE way that matters: this cache
 * DOES NOT SERVE A STALE SET WHEN IT CANNOT REFRESH, it keeps serving the last good set for its full
 * TTL and then refuses. The difference is what the two lists are for. A stale house list can only fail
 * to suppress a wallet added in the last few minutes; a stale key set would mean accepting tokens
 * signed by a key Privy has retired, which is exactly the event a rotation exists to end.
 *
 * THAT PARAGRAPH WAS A CLAIM THIS CLASS DID NOT HONOUR UNTIL REVIEW CAUGHT IT. `keyFor` fell through to
 * `refresh`'s last-good-set fallback once the TTL had passed, so a Privy outage extended the life of a
 * retired key indefinitely. `keyFor` now refuses when the set is still stale after an attempted refresh,
 * and the attempt itself is behind the cooldown so an outage costs one fetch per ten minutes rather than
 * one per request. `privyIdentity.test.ts` advances the clock past the TTL with a failing fetch and
 * asserts the refusal, which is the test that was missing when the comment was written.
 */
export class PrivyJwksCache {
  private keys: Map<string, EcPublicJwk> | null = null;
  private fetchedAtSec = 0;
  private lastAttemptSec = 0;
  private inflight: Promise<Map<string, EcPublicJwk> | null> | null = null;

  // A plain field rather than a parameter property: `erasableSyntaxOnly` is on across this repo's
  // tsconfigs and a parameter property is the one class syntax that cannot be erased.
  private readonly deps: PrivyJwksDeps;

  constructor(deps: PrivyJwksDeps) {
    this.deps = deps;
  }

  /** Has the cached set passed its TTL? Also true when there has never been one. */
  private isStale(nowSec: number): boolean {
    return this.keys === null || nowSec - this.fetchedAtSec >= JWKS_TTL_SECONDS;
  }

  async keyFor(kid: string): Promise<KeyLookup> {
    const now = this.deps.nowSec();
    const cooledDown = now - this.lastAttemptSec >= JWKS_COOLDOWN_SECONDS;

    if (this.isStale(now)) {
      // ------------------------------------------------------------------------------------------
      // PAST THE TTL, AND THIS BLOCK IS THE FIX FOR A REAL DEFECT FOUND IN REVIEW.
      //
      // It used to be `keys = await this.refresh(now)` and then a null check — and `refresh` returns
      // the LAST GOOD SET when a fetch fails (see its own note, which is correct for the case it is
      // written about). The consequence was that once the TTL had passed and Privy became
      // unreachable, this cache went on verifying tokens against a key set of unbounded age: exactly
      // the "accepting tokens signed by a key Privy has retired" that this class's header claims it
      // refuses to do, and the one event a rotation exists to end. It also refetched on EVERY
      // request while Privy was down, paying `JWKS_FETCH_TIMEOUT_MS` each time in front of a player's
      // wallet prompt, because the cooldown only guarded the unknown-`kid` branch below.
      //
      // Now: attempt at most one refresh per cooldown, and if the set is STILL past its TTL
      // afterwards, refuse. `keys-unavailable` becomes a 503 and no link is created — the
      // fail-closed direction, and the one this class already promised in writing.
      // ------------------------------------------------------------------------------------------
      if (cooledDown || this.keys === null) await this.refresh(now);
      if (this.isStale(now)) return { kind: "keys-unavailable" };
    } else if (!this.keys.has(kid) && cooledDown) {
      // AN UNRECOGNISED `kid` IS THE ROTATION SIGNAL, and it is the only reason to fetch inside a TTL.
      // Privy publishes two keys and can add a third at any moment; without this branch, a rotation
      // would break every link for up to an hour. The cooldown is what stops a stream of junk `kid`s
      // becoming a stream of requests to Privy.
      await this.refresh(now);
    }

    // Read through the field rather than a local: a refresh above may have replaced it, and a local
    // captured before the await is how a cache comes to answer from the set it was about to discard.
    if (this.keys === null) return { kind: "keys-unavailable" };
    const jwk = this.keys.get(kid);
    return jwk === undefined ? { kind: "unknown-key" } : { kind: "ok", jwk };
  }

  private async refresh(nowSec: number): Promise<Map<string, EcPublicJwk> | null> {
    if (this.inflight !== null) return this.inflight;
    this.lastAttemptSec = nowSec;
    this.inflight = this.fetchOnce()
      .then((fetched) => {
        if (fetched !== null) {
          this.keys = fetched;
          this.fetchedAtSec = nowSec;
          return fetched;
        }
        // A failed refresh does NOT clear a live set: the TTL check above already decides when a set
        // has stopped being usable, and dropping it here would turn one blip at Privy into a refusal
        // of every link until the next successful fetch.
        return this.keys;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchOnce(): Promise<Map<string, EcPublicJwk> | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(this.deps.url, {
        signal: ctl.signal,
        // `redirect: "error"`, as in `houseWallets.ts`. There is no bearer token to leak here, and the
        // reason is stronger rather than weaker: following a redirect on a KEY fetch means taking
        // verification keys from whatever host a 302 named. The keys are the whole trust anchor.
        redirect: "error",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      return jwksFrom(await res.json());
    } catch {
      // Timeout, DNS, TLS, a redirect, malformed JSON, an unrecognised shape — one failure, one
      // handling. Nothing here is worth a log line: the outcome is visible to the caller as
      // `keys-unavailable`, which the handler turns into a refusal a player is told about.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// The verifier
// ------------------------------------------------------------------------------------------------

/** `aud` may be a string or, per the JWT spec, an array. Privy sends a string; both are accepted,
 *  because refusing the array form would be an outage the day they change it and accepting it costs
 *  one line and no strength — the app id must still be there. */
function audienceMatches(aud: unknown, appId: string): boolean {
  if (typeof aud === "string") return aud === appId;
  if (Array.isArray(aud)) return aud.some((a) => a === appId);
  return false;
}

export interface PrivyVerifierDeps {
  /** The public Privy app id. Not a secret — it ships in the browser bundle — and it is the `aud`
   *  every token must name. */
  readonly appId: string;
  readonly jwks: { keyFor(kid: string): Promise<KeyLookup> };
}

/**
 * The whole of fact A, in order, refusing at the first failure.
 *
 * THE ORDER IS CHEAPEST-AND-MOST-STRUCTURAL FIRST, and it is not only about speed: shape, algorithm
 * and claim checks happen BEFORE the key fetch, so a stranger cannot make this API call Privy by
 * posting rubbish. The signature is checked BEFORE the claims are read for content, so no field of an
 * unverified token is ever used for anything except deciding to refuse it.
 */
export function createPrivyVerifier(deps: PrivyVerifierDeps): PrivyVerifier {
  return {
    async verify(token: string, nowSec: number): Promise<PrivyVerification> {
      const decoded = decodeJwt(token);
      if (decoded === null) return { kind: "rejected", reason: "malformed" };

      const { payload } = decoded;

      if (payload.iss !== PRIVY_ISSUER) return { kind: "rejected", reason: "wrong-issuer" };
      if (!audienceMatches(payload.aud, deps.appId)) return { kind: "rejected", reason: "wrong-audience" };
      // `sub` is required to be present and is deliberately NOT STORED anywhere. It is Privy's DID for
      // this user, and keeping it would put a broker-specific identifier in our register — one more
      // identifier about a person, and one more thing to migrate if we ever leave. The register is
      // keyed on X's own id, which outlives whichever broker vouched for it.
      if (typeof payload.sub !== "string" || payload.sub === "") {
        return { kind: "rejected", reason: "malformed" };
      }

      if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
        return { kind: "rejected", reason: "expired" };
      }
      if (payload.exp + CLOCK_SKEW_SECONDS <= nowSec) return { kind: "rejected", reason: "expired" };

      if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
        return { kind: "rejected", reason: "stale" };
      }
      if (payload.iat - CLOCK_SKEW_SECONDS > nowSec) return { kind: "rejected", reason: "stale" };
      if (nowSec - payload.iat > MAX_IDENTITY_TOKEN_AGE_SECONDS) {
        return { kind: "rejected", reason: "stale" };
      }

      const lookup = await deps.jwks.keyFor(decoded.kid);
      if (lookup.kind === "keys-unavailable") return { kind: "rejected", reason: "keys-unavailable" };
      if (lookup.kind === "unknown-key") return { kind: "rejected", reason: "unknown-key" };

      let ok = false;
      try {
        const key = await subtle.importKey(
          "jwk",
          lookup.jwk,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["verify"],
        );
        ok = await subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          decoded.signature,
          decoded.signingInput,
        );
      } catch {
        // An unimportable key or a malformed point. Indistinguishable from a bad signature as far as
        // the answer goes, and it must be: the alternative is a code path where "we could not check"
        // is not "no".
        return { kind: "rejected", reason: "bad-signature" };
      }
      if (!ok) return { kind: "rejected", reason: "bad-signature" };

      // ONLY NOW is any claim read for its content.
      return xIdentityFromClaims(payload);
    },
  };
}
