// THE RATE LIMIT ON THE WRITE PATH. What is counted, against whom, and what a table full of counters
// is allowed to know about the people it counted.
//
// `TWITTER-CONNECT.md` §10 Stage 4 lists "rate limits per IP and per wallet on /start and /link" and
// the reason is arithmetic rather than principle: `/api/x/challenge` and `/api/x/link` are
// unauthenticated in the sense that anyone can reach them, and each one costs a database round trip
// and — for a challenge — a signature verification against Privy's public keys. An endpoint with
// those properties and no limiter is a bill and a spam vector, and the spam is not even the expensive
// half: the challenge table is the only place in this system where a stranger can cause a row to be
// written.
//
// ================================================================================================
// THE TABLE MUST NOT BECOME THE THING IT IS PROTECTING.
//
// The naive limiter writes `(ip, count)` and `(wallet, count)` rows from the same request, seconds
// apart, in one table. That is an IP-to-wallet correlation log — a deanonymisation database, and a
// worse one than the link register, because the register only holds identities people CHOSE to
// publish while this would hold a fact nobody consented to about everybody who tried.
//
// So two things are true of every row `x_link_rate` ever holds:
//
//   1. THE SUBJECT IS COARSE. `clientNetwork.ts` truncates an address to its /24 or /48 before this
//      module ever sees it, so no individual IP is hashed, stored, or recoverable — not by us, and
//      not by somebody holding both a dump and this module's secret.
//   2. THE KEY IS AN HMAC UNDER A SECRET THAT IS NOT IN THE TABLE. Plain `sha256(wallet)` would be
//      no protection at all: wallets are enumerable from the chain, so a dump plus a chain scrape
//      recovers every subject by brute force in minutes, and a /24 space is 2^24 candidates, which is
//      seconds. The secret is what makes the digests opaque to anyone who only has the data.
// ================================================================================================
//
// ------------------------------------------------------------------------------------------------
// WHERE THE SECRET COMES FROM, AND WHY IT IS NOT A NEW ENVIRONMENT VARIABLE.
//
// `deriveBucketSecret` is HMAC-SHA-256 of a fixed domain-separation label under `KEEPER_HOUSE_TOKEN`.
// Three candidates were weighed:
//
//   * A NEW `XLINK_RATE_SECRET` var. Rejected, narrowly. It is the textbook answer, and the cost is
//     that every environment variable this feature requires is another way for a deploy to be
//     silently wrong (`env.ts`'s header is an essay on that exact failure), and the operator has to
//     set it in three environments before the write path will start. The property it buys over the
//     option below is nil: both are 32 bytes of secret that live in the same process.
//
//   * `XLINK_ATTESTATION_SECRET`, which the read path already loads. REJECTED, AND THIS ONE MATTERS.
//     That is the ed25519 key that signs every attestation the client believes. The write path is the
//     most attacker-exposed code in this feature — it parses a JWT, a signature, a JSON body and a
//     handful of headers from strangers — and handing it the signing key would mean a compromise
//     there escalates from "can write junk rows, which the read path filters and the client can see"
//     to "can mint an attestation for any wallet wearing any handle", which is the one failure §5 is
//     built to make impossible. The write path does not sign attestations and therefore must not hold
//     the key that does. This is the whole reason `linkWriteHandler.ts`'s deps do not include an
//     `AttestationKey`.
//
//   * `KEEPER_HOUSE_TOKEN`. CHOSEN. The write path already holds it, unavoidably: it has to ask the
//     keeper which wallets are the arena's own before it may write a link (§6.3), and that endpoint is
//     bearer-authenticated. So this adds no secret to the process, no variable to the dashboard and no
//     new thing to rotate. HMAC with a distinct label is the standard way to take a second,
//     independent key from one input: the derived value cannot be run backwards to the token, and no
//     other use of the token can be confused with this one.
//
// The derived secret never leaves the process, is never logged, and appears in storage only as the
// output of an HMAC over a coarse subject.
// ------------------------------------------------------------------------------------------------

import { createHmac } from "node:crypto";
import type { RateCounter } from "./writeStore.js";

/**
 * TEN MINUTES, fixed window.
 *
 * Fixed rather than sliding, because a sliding window needs a row per event and a fixed window needs a
 * row per subject; the worst case of a fixed window is twice the nominal rate across a boundary,
 * which at "a handful of ceremonies per ten minutes" is not a distinction with a cost attached.
 *
 * Ten minutes rather than a minute or an hour: it has to be at least a couple of ceremonies long
 * (`CHALLENGE_TTL_SECONDS` is five minutes, so a single slow attempt can span a shorter window and
 * be counted twice), and it has to be short enough that a player who genuinely hit the limit is not
 * locked out past their patience.
 */
export const WINDOW_SECONDS = 600;

/**
 * PER WALLET **ON ONE NETWORK**, per window. A whole ceremony is two requests — one challenge, one link
 * — so this is ten complete attempts in ten minutes.
 *
 * Sized against a real person having a bad time rather than against an attacker: every retry needs a
 * FRESH challenge (the nonce is single-use, `writeStore.ts#consume`), so a player who fumbles a
 * wallet prompt five times has spent ten requests without doing anything wrong. Ten attempts is
 * comfortably past that and still bounds one actor to twenty rows and twenty token verifications per
 * ten minutes.
 *
 * ------------------------------------------------------------------------------------------------
 * THE SUBJECT IS (NETWORK, WALLET) AND NOT THE WALLET ALONE. THIS WAS A REAL DEFECT, FOUND IN REVIEW.
 *
 * A bare wallet subject is one counter per wallet SHARED BY THE WHOLE INTERNET, and the wallet is an
 * unauthenticated field in a request body at the moment it is counted — nothing has been proved yet, and
 * on the unlink leg there is no credential to prove (`challengeHandler.ts` takes no proof for an
 * unlink, deliberately, so that revocation never depends on the identity provider). So twenty-one
 * requests of
 *
 *     POST /api/x/challenge {"wallet":"<any wallet on the chain>","purpose":"unlink"}
 *
 * from any stranger would exhaust that wallet's budget and lock its owner out of BOTH endpoints for the
 * rest of the window — including `DELETE /api/x/link`. That is not "a player waits": §6.2 promises
 * revocation is immediate, and wallets are enumerable from the chain, so it is a way to keep a chosen
 * player from taking their own face off the board, indefinitely, for twenty-one requests per window.
 *
 * Binding the subject to the caller's own network closes it: an attacker outside the victim's /24 can no
 * longer spend the victim's budget, and one player still has a bounded budget. The residual is that
 * same-subnet neighbours can interfere with each other — which is the residual `clientNetwork.ts`
 * already accepts for the network counter itself, and an attacker in the victim's /24 can exhaust the
 * network budget anyway, so it adds no new capability.
 *
 * REJECTED: counting only after a proof (the wallet signature on the link leg, the Privy `sub` on the
 * challenge leg). It is the most faithful answer and it leaves the expensive work — a JWKS fetch, a
 * signature verification, a challenge row — in front of the limiter, which is the thing the limiter
 * exists to bound. The network counter is the honest bound before proof; this one is the honest bound
 * after identifying the caller as narrowly as an unauthenticated request permits.
 * ------------------------------------------------------------------------------------------------
 */
export const LIMIT_PER_WALLET = 20;

/**
 * PER IP NETWORK (/24 or /48), per window. Three times the wallet limit, because the subject is
 * genuinely shared: a campus, an office or a mobile carrier's CGNAT range is one /24, and thirty
 * requests is fifteen ceremonies from a subnet in ten minutes.
 *
 * The asymmetry is the point. The wallet limit is the tight one because a wallet is one person; the
 * network limit is the loose one because a network is a crowd, and its job is only to bound the cost
 * of somebody who has not got a wallet to spend.
 */
export const LIMIT_PER_NETWORK = 60;

/** The domain-separation label. Versioned, so that if this derivation is ever changed the old buckets
 *  simply stop being addressed rather than being reinterpreted under a new scheme. */
const BUCKET_SECRET_LABEL = "bulls-arena.xlink.rate-bucket.v1";

/**
 * A 32-byte key for `bucketKey`, derived from the keeper house token. See this file's header for why
 * that input and not another.
 *
 * @param houseToken the value of `KEEPER_HOUSE_TOKEN`. Never logged, never returned, never compared
 *   against anything but itself.
 */
export function deriveBucketSecret(houseToken: string): Uint8Array {
  if (houseToken.trim() === "") {
    // Cannot happen through the entry points — `requireHouseToken` throws at cold start first — and
    // it is checked anyway, because the failure it prevents is silent: HMAC under an empty key is a
    // perfectly valid HMAC, and every bucket in the table would then be recoverable by anyone with a
    // dump and this file.
    throw new Error("deriveBucketSecret: refusing to derive a rate-limit key from an empty token");
  }
  return new Uint8Array(createHmac("sha256", houseToken).update(BUCKET_SECRET_LABEL).digest());
}

/** What is being counted. The kind is part of the HMAC input, so a wallet and a network can never
 *  collide into one bucket even if their subjects were somehow the same string. */
export type BucketKind = "wallet" | "network";

/**
 * The opaque row key for one subject. Lowercase hex of HMAC-SHA-256, which is the shape migration
 * 0002's CHECK on `x_link_rate.bucket` constrains.
 *
 * NOTE WHAT IS NOT IN THE INPUT: the window. One row per subject is reused and its `window_start` is
 * rewritten when the window rolls over, so the table's size is the number of distinct subjects that
 * have ever reached the write path rather than that times the number of windows. Putting the window
 * in the key would be simpler by one CASE expression and would grow the table for ever.
 */
export function bucketKey(secret: Uint8Array, kind: BucketKind, subject: string): string {
  return createHmac("sha256", secret).update(`${kind}:${subject}`).digest("hex");
}

/** The start of the fixed window containing `nowSec`. Pure arithmetic, so the boundary behaviour is a
 *  test rather than a claim about SQL. */
export function windowStart(nowSec: number): number {
  return nowSec - (nowSec % WINDOW_SECONDS);
}

export type RateVerdict =
  | { readonly kind: "ok" }
  /** `retryAfterSec` is the time to the end of the current window — an honest number, because a fixed
   *  window really does forgive everything at once. */
  | { readonly kind: "limited"; readonly retryAfterSec: number };

export interface RateLimitDeps {
  readonly counter: RateCounter;
  /** From `deriveBucketSecret`. */
  readonly secret: Uint8Array;
}

/**
 * Count this request and decide.
 *
 * COUNTED FIRST, JUDGED SECOND, and the ordering is deliberate: a refused request still increments,
 * so somebody hammering the endpoint stays refused for the rest of the window instead of oscillating
 * across the limit and getting one request through per response.
 *
 * BOTH SUBJECTS ARE ALWAYS COUNTED, even when the first one already fails. Skipping the second would
 * make one subject's counter depend on another's, so a wallet could stay under its own limit for ever
 * by being on a network that is always over — which is exactly backwards.
 *
 * THIS FUNCTION DOES NOT CATCH. If the counter throws, the exception reaches the handler, which turns
 * it into a refusal. A `catch` here that returned `{kind:"ok"}` would be the single most damaging line
 * on this path: a database blip would silently disable every limit at once, and nothing on any screen
 * would show it. See `writeStore.ts`'s header on why `RateCounter` is its own interface.
 */
export async function enforceRateLimit(
  deps: RateLimitDeps,
  subjects: { readonly wallet: string; readonly network: string },
  nowSec: number,
): Promise<RateVerdict> {
  const start = windowStart(nowSec);
  // THE TIGHT SUBJECT IS THE PAIR. See `LIMIT_PER_WALLET` for the attack a bare wallet subject allowed:
  // twenty-one requests from any stranger locked a chosen player out of their own unlink. The separator
  // cannot appear in either half — a network is `<digits>.<digits>.<digits>.0/24` or
  // `<hex>:<hex>:<hex>::/48` and a wallet is base58 — so no two distinct pairs can collide into one key.
  const walletBucket = bucketKey(deps.secret, "wallet", `${subjects.network}|${subjects.wallet}`);
  const networkBucket = bucketKey(deps.secret, "network", subjects.network);

  const counts = await deps.counter.hit([walletBucket, networkBucket], start);
  if (counts.length !== 2) {
    // A counter that answered with the wrong number of counts has not counted. Thrown rather than
    // tolerated, because `strictNullChecks` is off across this repo (see `wallets.ts`) — so a short array
    // would make `undefined > LIMIT` evaluate to `false`, which is "allowed", which is the one
    // fail-OPEN this module's header says must not exist anywhere in it.
    throw new Error(`rate limiter: expected 2 counts, got ${counts.length}`);
  }
  const [walletHits, networkHits] = counts;

  if (walletHits > LIMIT_PER_WALLET || networkHits > LIMIT_PER_NETWORK) {
    return { kind: "limited", retryAfterSec: Math.max(1, start + WINDOW_SECONDS - nowSec) };
  }
  return { kind: "ok" };
}
