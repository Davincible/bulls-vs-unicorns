// THE WRITE SEAM. Five questions the ceremony asks of its storage, and nothing else.
//
// `store.ts`'s header applies here word for word and is worth restating rather than cross-referencing:
// the handlers depend on these interfaces and never on a driver, which is what lets every rule on the
// write path be tested by `npx vitest run` with no database, no network and no Vercel. The expensive
// defects on a write path are all POLICY defects — a nonce that can be replayed, an expired challenge
// that still redeems, a house wallet that gets a face, a rate limit that counts the wrong subject —
// and policy defects are exactly the class nobody writes a test for when the test needs Postgres
// first.
//
// DELIBERATELY NOT AN ORM AND DELIBERATELY NOT GENERIC, for the same reason as `store.ts`. Reading
// this file tells you everything the ceremony can possibly do to the database. There is no `query`,
// no `where`, and no method that takes SQL.
//
// ------------------------------------------------------------------------------------------------
// WHY THREE INTERFACES AND NOT ONE `WriteStore`.
//
// They have three different failure meanings, and a single interface would hide that.
//
//   * `ChallengeStore` failing means one ceremony did not happen. The player retries.
//   * `LinkWriter` failing means the register did not change. Nothing is half-written; every method
//     is one statement.
//   * `RateCounter` failing means we CANNOT COUNT, and the handler must then refuse the request
//     rather than let it through — the one place on this path where "the database is down" has to
//     become "no" instead of "sorry". A method sitting on the same interface as the two above invites
//     exactly the `catch { /* best effort */ }` that turns a rate limit into a suggestion.
//
// The pg implementation returns all three from one factory, because they share one `sql` function.
// The types stay apart because the arguments about them are apart.

/**
 * A VERIFIED X identity: the fields `api/src/privyIdentity.ts` extracted from a Privy identity token
 * whose signature checked out against Privy's JWKS.
 *
 * There is no unverified counterpart of this type, and there must not be one. The old build's defect
 * (`xLink.ts`'s header; `web/index.html:2900`) was a typed handle travelling through the same
 * structure as an OAuth-proven one, so this feature's rule is that a handle only ever exists inside a
 * value that could not have been constructed without a proof. `privyIdentity.ts` is the only producer.
 */
export interface XIdentity {
  /** X's immutable numeric account id, decimal digits. THE identity — see 0001's primary key note. */
  readonly xId: string;
  /** Current handle, no leading `@`, matching `HANDLE_RE` in `xLink.ts` and the table's CHECK. */
  readonly handle: string;
  /** `""` for none. The wire has no null (`LinkAttestation`) and neither does the column. */
  readonly displayName: string;
  /** The upstream `pbs.twimg.com` picture, or `null` when the account has no profile picture at all.
   *  NEVER SERVED — see migration 0002 for why null is a real state and not a gap. */
  readonly avatarUrl: string | null;
}

/**
 * Which ceremony a challenge belongs to.
 *
 * A STRING DISCRIMINANT for the reason `wallets.ts` spells out at length: this repo's tsconfigs do
 * not enable `strictNullChecks`, so a union discriminated by a boolean does not narrow, and the
 * natural fix for the resulting compile error is a cast — which turns a union that made a mistake
 * impossible into a union that hides it.
 */
export type ChallengePurpose = "link" | "unlink";

interface ChallengeBase {
  /** 32 bytes of CSPRNG as lowercase hex. */
  readonly nonce: string;
  /** The only wallet whose signature can redeem this challenge. */
  readonly wallet: string;
  /** The exact bytes handed to the browser and, later, to ed25519.verify. Never recomposed. */
  readonly message: string;
  /** Unix SECONDS. Also the instant `message` prints as `Issued:`, which is why it is carried rather
   *  than derived from `expiresAtSec` minus a TTL: the row and the words a player read must agree. */
  readonly issuedAtSec: number;
  /** Unix SECONDS. */
  readonly expiresAtSec: number;
}

/** A challenge that will CREATE a link. Carries the X identity, because the message binds it. */
export interface LinkChallenge extends ChallengeBase {
  readonly purpose: "link";
  readonly identity: XIdentity;
}

/**
 * A challenge that will DELETE a link. Carries no identity, and that is a deliberate asymmetry.
 *
 * An unlink requires no X credential of any kind. A player who lost access to their X account, or
 * deleted it, must still be able to take their face off this site — revocation cannot depend on the
 * identity provider the player is walking away from. §6.2 asks for "a fresh wallet signature over a
 * fresh nonce" and that is all this is. Migration 0002's
 * `x_link_challenge_identity_matches_purpose` makes the absence structural: an unlink challenge
 * cannot hold an identity, so no code path can promote one into a link.
 */
export interface UnlinkChallenge extends ChallengeBase {
  readonly purpose: "unlink";
}

export type Challenge = LinkChallenge | UnlinkChallenge;

export interface ChallengeStore {
  /**
   * Write one challenge. The nonce is fresh, so this cannot conflict; a conflict is a broken CSPRNG
   * and belongs in a stack trace rather than in a return value.
   *
   * Implementations may fold housekeeping (sweeping expired rows) into this statement. That is why
   * there is no `purgeExpired()` on this interface: a sweep that has its own method is a sweep that
   * needs a cron, and a cron is a thing that stops running quietly.
   */
  put(challenge: Challenge): Promise<void>;

  /**
   * Redeem a nonce, ONCE.
   *
   * The contract is the strong part: this must be a single atomic operation that either returns the
   * challenge and destroys it, or returns `null`. Two concurrent calls with one nonce must not both
   * receive it. `null` covers "no such nonce", "already redeemed" and "expired" as ONE answer,
   * deliberately — the caller has nothing different to do for any of them, and three distinguishable
   * answers would be three states for a client to leak information about.
   *
   * @param nowSec unix SECONDS, injected rather than read from the database's clock so that expiry is
   *   testable and so one instant governs a whole request.
   */
  consume(nonce: string, nowSec: number): Promise<Challenge | null>;
}

/**
 * What the register write can end in. `wallet-taken` is a refusal, not an error, and the distinction
 * matters: it is the one outcome the player can act on themselves.
 */
export type LinkWriteOutcome =
  | { readonly kind: "linked" }
  /** This wallet already wears a DIFFERENT X account. See `LinkWriter.link` for why this refuses
   *  instead of silently unbinding the other one. */
  | { readonly kind: "wallet-taken" };

export interface LinkWriter {
  /**
   * Create or move a link, atomically.
   *
   * THE TWO CONFLICT DIRECTIONS ARE NOT SYMMETRIC, AND THE ASYMMETRY IS THE WHOLE DESIGN OF THIS
   * METHOD. Both are reachable only by somebody who has just proved control of `wallet` (an ed25519
   * signature) and of `identity` (a Privy identity token), so neither is an attack; the question is
   * only which existing row a proven pair is allowed to disturb.
   *
   *   X ACCOUNT ALREADY LINKED TO ANOTHER WALLET  ->  the row MOVES. `ON CONFLICT (x_id) DO UPDATE`,
   *     one statement, so §4.3's "relinking X account X from wallet W1 to W2 must remove W1's row in
   *     the same transaction" is satisfied by there being one row that changed its wallet. The claim
   *     being made — "this X account belongs to this wallet now" — is the X account owner's to make,
   *     and refusing it would permanently strand anyone who lost the key to W1, who by construction
   *     cannot sign the unlink that would release it.
   *
   *   WALLET ALREADY LINKED TO ANOTHER X ACCOUNT  ->  REFUSED as `wallet-taken`. `SOCIAL.md` §2.3
   *     says "linking an X account already bound to another wallet unbinds the other one", and this
   *     is deliberately stricter in this one direction, because nobody is stranded by the strictness:
   *     whoever can sign this link can sign `DELETE /api/x/link` for the same wallet, so the remedy
   *     is one explicit, signed, consented step away. What it buys is that A LINK WRITE NEVER DELETES
   *     A ROW — the only thing that removes a link is a player asking for it (§6.2), which is a much
   *     easier sentence to keep true than "removes exactly the row you would expect".
   *
   * `suppressed` IS NEVER TOUCHED BY THIS METHOD. An operator's kill switch (§7.4) must survive a
   * relink, or the ceremony is a moderation bypass: link, get taken down, link again, reappear. A
   * suppressed identity may still re-link — the write succeeds and the row stays suppressed — because
   * refusing would tell the caller they are suppressed, and the kill switch is not a conversation.
   *
   * The avatar columns are also left alone: the picture belongs to the `x_id`, not to the wallet, and
   * §7.2's "serve the last good bytes" is worth more than a flat disc while a re-ingest catches up.
   *
   * @param linkedAtSec unix SECONDS. Used only when the pair is new to the register; an existing row
   *   whose wallet is unchanged keeps its original `linked_at`, because "linked 8 Aug" is a fact
   *   about the player and not about the last time they pressed a button.
   */
  link(wallet: string, identity: XIdentity, linkedAtSec: number): Promise<LinkWriteOutcome>;

  /**
   * Remove whatever link this wallet has. A DELETE, not a flag (§6.2 is explicit: "Deletes the row.
   * Not a flag; a delete").
   *
   * The avatar bytes live in the same row, so they leave with it and the proxy starts 404ing with no
   * second call and no cache to invalidate. That is the whole of "it must actually remove the ability
   * to display that identity".
   *
   * @returns the `x_id` that was removed, or `null` when this wallet had no link. Distinguished
   *   because an unlink of nothing is a success the client should not celebrate, not a failure — and
   *   because the log line for "somebody unlinked a wallet that was not linked" is worth being able
   *   to tell from "somebody unlinked".
   */
  unlink(wallet: string): Promise<string | null>;
}

export interface RateCounter {
  /**
   * Count one request against every bucket at once and return the new totals for the current window.
   *
   * ALL THE BUCKETS IN ONE CALL, DELIBERATELY. Every request on this path is counted against at least
   * two subjects (an IP network and a wallet), and the pg implementation turns this into a single
   * multi-row upsert — one round trip instead of one per subject. Latency on a serverless path is
   * paid by the player standing in front of a wallet prompt, and a rate limiter that costs 60ms per
   * subject is a rate limiter somebody will eventually be tempted to skip.
   *
   * THE RETURN VALUE IS THE COUNTS AND NOT A BOOLEAN, so the policy — which limit, which window, what
   * to do at the edge — lives in `rateLimit.ts` where it is readable and testable, and the store stays
   * a counter. A store that answered "allowed / denied" would be a store with an opinion about a
   * number nobody can see.
   *
   * MUST THROW RATHER THAN RETURN A GUESS. A counter that cannot count has to make the handler
   * refuse; see this file's header.
   *
   * @param buckets opaque digests from `rateLimit.ts#bucketKey`. Must be DISTINCT — two identical
   *   keys in one statement is a caller bug, and Postgres says so ("ON CONFLICT DO UPDATE command
   *   cannot affect row a second time") rather than silently counting once.
   * @param windowStartSec unix SECONDS at the start of the current fixed window, computed by the
   *   caller so that the window arithmetic is one pure function with tests rather than SQL.
   * @returns one count per bucket, IN THE SAME ORDER as the argument. The order is the contract: SQL
   *   `RETURNING` has no guaranteed row order, so the implementation must restore it rather than hope.
   */
  hit(buckets: readonly string[], windowStartSec: number): Promise<readonly number[]>;
}
