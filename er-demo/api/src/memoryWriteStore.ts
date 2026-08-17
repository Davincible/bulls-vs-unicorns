// THE IN-MEMORY CHALLENGE STORE AND RATE COUNTER. What the write-path tests run against.
//
// `memoryStore.ts`'s header applies word for word: these are not stubs. They enforce every rule the
// Postgres implementations enforce — the single-use delete, the expiry predicate, the fixed-window
// reset, and the CHECK constraints migration 0002 puts on `x_link_challenge` — because a fake that is
// more permissive than the real thing is a fake that lets a bug through the gate and into production.
// Every difference between these two implementations would be a place a test can be green about
// something that is false.
//
// Not deployed: nothing under `/api` imports this, so its relative imports keep the repo's ordinary
// `.ts` house style rather than the deployed graph's `.js` (see `er-demo/api/README.md`).

import type {
  Challenge,
  ChallengeStore,
  RateCounter,
} from "./writeStore.ts";

/** Transcribed from `0002_x_link_write.sql`. One place, so the fake and the schema drift together or
 *  not at all. */
const NONCE_RE = /^[0-9a-f]{64}$/;
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const X_ID_RE = /^[0-9]{1,20}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const AVATAR_URL_PREFIX = "https://pbs.twimg.com/";

/** Throws what Postgres would refuse, naming the constraint so a failing test reads like the database
 *  talking. */
function assertChallengeIsStorable(c: Challenge): void {
  if (!NONCE_RE.test(c.nonce)) throw new Error(`x_link_challenge_nonce_check: ${c.nonce}`);
  if (!WALLET_RE.test(c.wallet)) throw new Error(`x_link_challenge_wallet_check: ${c.wallet}`);
  if (c.message === "" || c.message.length > 2000) throw new Error("x_link_challenge_message_check");
  if (c.expiresAtSec <= c.issuedAtSec) throw new Error("x_link_challenge_expires_after_issue");

  // `x_link_challenge_identity_matches_purpose`. The half that matters is the second one: an unlink
  // challenge carrying an identity would be a link that skipped the identity proof, and the database
  // refuses to hold one.
  if (c.purpose === "link") {
    if (!X_ID_RE.test(c.identity.xId)) throw new Error(`x_link_challenge_x_id_check: ${c.identity.xId}`);
    if (!HANDLE_RE.test(c.identity.handle)) {
      throw new Error(`x_link_challenge_handle_check: ${c.identity.handle}`);
    }
    if (c.identity.displayName.length > 100) throw new Error("x_link_challenge_display_name_check");
    if (c.identity.avatarUrl !== null && !c.identity.avatarUrl.startsWith(AVATAR_URL_PREFIX)) {
      throw new Error("x_link_challenge_avatar_url_check");
    }
  } else if ("identity" in c) {
    throw new Error("x_link_challenge_identity_matches_purpose");
  }
}

export class MemoryChallengeStore implements ChallengeStore {
  private readonly rows = new Map<string, Challenge>();

  /** How many challenges are currently in flight. For tests that assert the housekeeping side of
   *  things — a redeemed nonce must leave nothing behind. */
  get size(): number {
    return this.rows.size;
  }

  async put(challenge: Challenge): Promise<void> {
    assertChallengeIsStorable(challenge);
    // The nonce is the primary key. A duplicate is a broken CSPRNG rather than a case to handle, and
    // the real store would raise a unique violation — so this does too.
    if (this.rows.has(challenge.nonce)) throw new Error("x_link_challenge_pkey");
    this.rows.set(challenge.nonce, challenge);
  }

  async consume(nonce: string, nowSec: number): Promise<Challenge | null> {
    const row = this.rows.get(nonce);
    if (row === undefined) return null;
    // ONE PREDICATE, ONE ACT, mirroring `DELETE ... WHERE nonce = $1 AND expires_at > to_timestamp($2)
    // RETURNING …`. Note the row is deleted ONLY when it is also unexpired: an expired row stays until
    // the housekeeping sweep, exactly as it does in Postgres, so a test cannot accidentally prove
    // single-use by relying on expiry cleaning up after it.
    if (row.expiresAtSec <= nowSec) return null;
    this.rows.delete(nonce);
    return row;
  }
}

interface Counted {
  windowStart: number;
  hits: number;
}

export class MemoryRateCounter implements RateCounter {
  private readonly buckets = new Map<string, Counted>();

  async hit(buckets: readonly string[], windowStartSec: number): Promise<readonly number[]> {
    // The real statement is a multi-row upsert, and Postgres refuses a duplicate key inside one
    // ("ON CONFLICT DO UPDATE command cannot affect row a second time"). `writeStore.ts` documents
    // distinctness as the caller's contract, so the fake enforces it rather than quietly counting once.
    if (new Set(buckets).size !== buckets.length) {
      throw new Error("x_link_rate: ON CONFLICT DO UPDATE cannot affect row a second time");
    }
    return buckets.map((b) => {
      const current = this.buckets.get(b);
      // The `CASE` from the real statement: same window increments, any older window RESETS to 1.
      const next: Counted =
        current === undefined || current.windowStart !== windowStartSec
          ? { windowStart: windowStartSec, hits: 1 }
          : { windowStart: windowStartSec, hits: current.hits + 1 };
      this.buckets.set(b, next);
      return next.hits;
    });
  }
}

/** A counter that cannot count. The handler's only correct response is to refuse the request, and
 *  `rateLimit.ts` never catches — so this is how a test proves that a database outage closes the write
 *  path instead of opening it. */
export const BROKEN_RATE_COUNTER: RateCounter = {
  hit(): Promise<readonly number[]> {
    return Promise.reject(new Error("connection refused"));
  },
};
