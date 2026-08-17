// THE POSTGRES WRITE STORE. Five statements and a boundary.
//
// `pgStore.ts`'s header applies unchanged and the same two claims are the reason this file exists at
// all: IT DOES NOT IMPORT A DRIVER (it takes the same tagged-template `SqlQuery`, so the one file that
// names Neon is still `neonStore.ts`), and EVERY VALUE CROSSES A BOUNDARY HERE (rows come back as
// `Record<string, unknown>` and are coerced one field at a time, with a throw on anything unexpected).
//
// ------------------------------------------------------------------------------------------------
// EVERY OPERATION HERE IS EXACTLY ONE STATEMENT, AND THAT IS THE DESIGN.
//
// The Neon HTTP driver has no session and therefore no multi-statement transaction: two `sql` calls
// are two independent transactions with a gap in the middle. Rather than reach for the driver's
// batching API — which would put a second shape of query into `SqlQuery`, the narrow interface
// `neonStore.ts` exists to keep narrow — every operation below is written so that one statement is
// enough:
//
//   * `consume` is a `DELETE ... RETURNING`, so "is it valid" and "nobody else gets it" are one act.
//     There is no read-check-write sequence to race.
//   * `link` is an `INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT DO UPDATE`, so the
//     both-directions-unique rule in §4.3 is enforced by the database in one shot rather than by two
//     statements and an apology.
//   * `hit` is a multi-row upsert, so all the rate subjects for one request cost one round trip.
//   * `put` folds housekeeping into a CTE, so the expired rows are swept by the write path and there
//     is no cron to stop running quietly.
//
// Where a single statement genuinely cannot express something, the answer here is to refuse rather
// than to sequence — see `link`'s note on the residual insert/insert race.
// ------------------------------------------------------------------------------------------------

import type { SqlQuery, SqlRow } from "./pgStore.js";
import type {
  Challenge,
  ChallengeStore,
  LinkWriteOutcome,
  LinkWriter,
  RateCounter,
  XIdentity,
} from "./writeStore.js";

// THESE FOUR COERCERS ARE A DELIBERATE DUPLICATE OF `pgStore.ts`'s, and the duplication is recorded
// rather than hidden. They differ in one thing that matters: the label in the error message names the
// table the value came from, and there are three tables on this side of the feature. Extracting a
// shared helper would mean a module whose only parameter exists to make the two call sites different,
// which is the wrong abstraction arriving early — this repo's own rule is three instances before an
// extraction, and this is the second. When a third store appears, merge them and delete this note.
function str(row: SqlRow, table: string, col: string): string {
  const v = row[col];
  if (typeof v !== "string") throw new TypeError(`${table}.${col}: expected string, got ${typeof v}`);
  return v;
}

function strOrNull(row: SqlRow, table: string, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new TypeError(`${table}.${col}: expected string|null, got ${typeof v}`);
  return v;
}

/** `extract(epoch …)::bigint` arrives as a string over the HTTP driver and a number over the
 *  WebSocket one. Both accepted, neither assumed, anything else throws. Same rule as `pgStore.ts`. */
function epoch(row: SqlRow, table: string, col: string): number {
  const v = row[col];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new TypeError(`${table}.${col}: expected an epoch, got ${String(v)}`);
  return Math.trunc(n);
}

/** `integer` arrives as a number over both drivers, but a `bigint` sum would arrive as a string, and
 *  `hits + 1` is one schema change away from being one. Accept both; refuse anything else. */
function int(row: SqlRow, table: string, col: string): number {
  const v = row[col];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isInteger(n)) throw new TypeError(`${table}.${col}: expected an integer, got ${String(v)}`);
  return n;
}

/** The two table names these coercers label their errors with. Named constants because a typo in a
 *  literal here would produce a message pointing at a table that does not exist, which is worse than
 *  no message at all. */
const CH = "x_link_challenge";
const RT = "x_link_rate";

/** How long a rate row is kept after its last use, before the housekeeping CTE sweeps it. A day is
 *  far longer than `WINDOW_SECONDS`, so a live counter is never at risk; the sweep is about the table
 *  not growing for ever, not about the limit. */
const RATE_ROW_TTL_SECONDS = 86_400;

export function createPgChallengeStore(sql: SqlQuery): ChallengeStore {
  return {
    async put(challenge: Challenge): Promise<void> {
      // The identity columns are all-or-nothing with `purpose`, enforced by
      // `x_link_challenge_identity_matches_purpose` in migration 0002. Spreading it out here rather
      // than building an object means the two branches of the union are visibly the two shapes the
      // constraint allows.
      const identity: XIdentity | null = challenge.purpose === "link" ? challenge.identity : null;

      // ONE STATEMENT, AND THE RATE-ROW HOUSEKEEPING RIDES ALONG. Folded in rather than given its own
      // endpoint or a Vercel cron, because a sweep that has to be invoked is a sweep that stops being
      // invoked.
      //
      // IT SWEEPS THE **OTHER** TABLE, AND THE PAIRING IS DELIBERATE — `hit` sweeps expired challenges,
      // and this sweeps stale rate rows. Two reasons, in order:
      //
      //   1. A data-modifying CTE must not delete from the table the main statement upserts into. The
      //      CTE and the main query run in one snapshot but uniqueness checks use a dirty one, so an
      //      `ON CONFLICT DO UPDATE` can be handed a tuple the same command has already deleted, which
      //      Postgres reports as "tuple to be updated was already modified by an operation triggered by
      //      the current command". Sweeping across tables cannot reach that state.
      //   2. It puts each sweep behind the more frequent event. Review pointed out the original
      //      arrangement swept expired CHALLENGES here — on the one operation an abuser never reaches,
      //      since `hit` runs first and refuses them. Expired challenge rows are the ones a stranger can
      //      cause, so their sweep belongs on the path every request takes.
      await sql`
        WITH swept_rate AS (
          DELETE FROM x_link_rate
           WHERE window_start < to_timestamp(${challenge.issuedAtSec - RATE_ROW_TTL_SECONDS})
        )
        INSERT INTO x_link_challenge
               (nonce, purpose, wallet, x_id, handle, display_name, avatar_url, message,
                issued_at, expires_at)
        VALUES (${challenge.nonce},
                ${challenge.purpose},
                ${challenge.wallet},
                ${identity === null ? null : identity.xId},
                ${identity === null ? null : identity.handle},
                ${identity === null ? null : identity.displayName},
                ${identity === null ? null : identity.avatarUrl},
                ${challenge.message},
                to_timestamp(${challenge.issuedAtSec}),
                to_timestamp(${challenge.expiresAtSec}))
      `;
    },

    async consume(nonce: string, nowSec: number): Promise<Challenge | null> {
      // SINGLE USE AND EXPIRY ARE ONE PREDICATE IN ONE STATEMENT. A replay finds no row because the
      // first redemption deleted it; an expired challenge finds no row because the `expires_at`
      // comparison is in the same WHERE clause. Neither can be forgotten by a caller and neither can
      // be won twice: two concurrent calls both run this DELETE, and exactly one of them gets the
      // `RETURNING` row.
      //
      // `to_timestamp($n)` rather than `now()` so that the clock is the request's single injected
      // instant. A test can then expire a challenge without waiting, and every timestamp in one
      // request tells one story.
      const rows = await sql`
        DELETE FROM x_link_challenge
         WHERE nonce = ${nonce}
           AND expires_at > to_timestamp(${nowSec})
        RETURNING nonce,
                  purpose,
                  wallet,
                  x_id,
                  handle,
                  display_name,
                  avatar_url,
                  message,
                  extract(epoch from issued_at)::bigint  AS issued_at,
                  extract(epoch from expires_at)::bigint AS expires_at
      `;
      if (rows.length === 0) return null;
      const r = rows[0];

      const base = {
        nonce: str(r, CH, "nonce"),
        wallet: str(r, CH, "wallet"),
        message: str(r, CH, "message"),
        issuedAtSec: epoch(r, CH, "issued_at"),
        expiresAtSec: epoch(r, CH, "expires_at"),
      };

      const purpose = str(r, CH, "purpose");
      if (purpose === "unlink") return { purpose: "unlink", ...base };
      if (purpose !== "link") {
        // The column has a CHECK, so this is unreachable through the database. It is still a throw
        // rather than a `return null`, because the one way to get here is that somebody added a third
        // purpose to the constraint and not to this file, and a silent `null` would present that as
        // "your challenge expired" to every player of the new ceremony.
        throw new TypeError(`x_link_challenge.purpose: unknown purpose ${purpose}`);
      }
      return {
        purpose: "link",
        ...base,
        identity: {
          xId: str(r, CH, "x_id"),
          handle: str(r, CH, "handle"),
          displayName: str(r, CH, "display_name"),
          avatarUrl: strOrNull(r, CH, "avatar_url"),
        },
      };
    },
  };
}

export function createPgLinkWriter(sql: SqlQuery): LinkWriter {
  return {
    async link(wallet: string, identity: XIdentity, linkedAtSec: number): Promise<LinkWriteOutcome> {
      // ------------------------------------------------------------------------------------------
      // ONE STATEMENT THAT ENFORCES BOTH HALVES OF §4.3'S UNIQUENESS, IN OPPOSITE DIRECTIONS.
      //
      // `WHERE NOT EXISTS (... wallet = $w AND x_id <> $x)` — this wallet must not already wear a
      //   DIFFERENT X account. If it does, the SELECT yields nothing, nothing is inserted, `RETURNING`
      //   is empty and the caller gets `wallet-taken`. That refusal is the strict direction and
      //   `writeStore.ts#LinkWriter.link` carries the argument for why: whoever can sign this link can
      //   sign the unlink, so nobody is stranded, and it buys the much simpler invariant that a link
      //   write never deletes a row.
      //
      // `ON CONFLICT (x_id) DO UPDATE` — this X account MAY move between wallets, in place, so
      //   §4.3's "relinking X account X from wallet W1 to W2 must remove W1's row in the same
      //   transaction" is satisfied by there being one row that changed its wallet. No window, no
      //   second statement, and no state in which one X account is on two fighters.
      //
      // WHAT THE UPDATE DELIBERATELY DOES NOT TOUCH:
      //   * `suppressed` — an operator's kill switch (§7.4) must survive a relink or the ceremony is a
      //     moderation bypass. A suppressed identity may re-link; it stays suppressed and the row
      //     stays invisible on both read paths. Refusing instead would tell the caller they are
      //     suppressed, and the kill switch is not a conversation.
      //   * `avatar_hash` / `avatar_bytes` / `avatar_at` — the picture belongs to the `x_id`, not to
      //     the wallet, and §7.2's "serve the last good bytes" is worth more than a flat disc while a
      //     re-ingest catches up. If `avatar_url` changed, the stored bytes are one ingest behind; that
      //     is the same staleness §7.5 already accepts for a renamed handle.
      //
      //     WITH ONE EXCEPTION, WHICH REVIEW FOUND: when the new `avatar_url` is NULL and the old one
      //     was not, the three columns are cleared TOGETHER. That is the player who deleted their X
      //     profile picture. Keeping the bytes there would leave a row advertising `avatar_hash` with no
      //     URL left to refresh from — so `/api/links` would keep serving the old face and the ingest
      //     could never replace it. "Last good bytes while a re-ingest catches up" would become "for
      //     ever", against the wishes of the person in the picture. `x_link_avatar_all_or_nothing`
      //     requires all three to move together, and they do.
      //
      // `linked_at` MOVES ONLY WHEN THE WALLET DOES. "linked 8 Aug" is a fact about a player and a
      // wallet, not about the last time somebody pressed a button, so a re-link of an unchanged pair
      // (which is also the refresh path for a renamed handle or a new picture) keeps the original.
      //
      // THE RESIDUAL RACE, STATED. Two `link` calls for the same wallet with two different `x_id`s,
      // overlapping inside this statement, can both pass their `NOT EXISTS` guard and the loser then
      // violates the UNIQUE index on `wallet` — a raised exception, which the handler turns into a
      // generic 503 and a retry resolves deterministically. It is not caught and mapped to
      // `wallet-taken` on purpose: catching it would mean this file inspecting a driver-specific error
      // code, and `pgStore.ts`'s whole arrangement is that no file here knows which Postgres this is.
      // Reaching that race requires one wallet's own key holder to run two ceremonies for two
      // different X accounts in the same millisecond.
      // ------------------------------------------------------------------------------------------
      const rows = await sql`
        INSERT INTO x_link
               (x_id, wallet, handle, display_name, avatar_url, linked_at, refreshed_at, suppressed)
        SELECT ${identity.xId}::text,
               ${wallet}::text,
               ${identity.handle}::text,
               ${identity.displayName}::text,
               ${identity.avatarUrl}::text,
               to_timestamp(${linkedAtSec}),
               to_timestamp(${linkedAtSec}),
               -- THE KILL SWITCH IS INHERITED, NOT RESET. A fresh INSERT would otherwise take the
               -- column default of FALSE, which is how suppress -> unlink -> relink used to return a
               -- suppressed identity to the leaderboard: the flag lived on the row the player had just
               -- deleted. x_link_suppressed (migration 0003) is keyed on the x_id and outlives it.
               -- The write still SUCCEEDS -- section 7.4's "the kill switch is not a conversation".
               EXISTS (SELECT 1 FROM x_link_suppressed s WHERE s.x_id = ${identity.xId})
         WHERE NOT EXISTS (
                 SELECT 1 FROM x_link
                  WHERE wallet = ${wallet}
                    AND x_id <> ${identity.xId}
               )
        ON CONFLICT (x_id) DO UPDATE
           SET wallet       = EXCLUDED.wallet,
               handle       = EXCLUDED.handle,
               display_name = EXCLUDED.display_name,
               avatar_url   = EXCLUDED.avatar_url,
               avatar_hash  = CASE WHEN EXCLUDED.avatar_url IS NULL
                                   THEN NULL ELSE x_link.avatar_hash END,
               avatar_bytes = CASE WHEN EXCLUDED.avatar_url IS NULL
                                   THEN NULL ELSE x_link.avatar_bytes END,
               avatar_at    = CASE WHEN EXCLUDED.avatar_url IS NULL
                                   THEN NULL ELSE x_link.avatar_at END,
               linked_at    = CASE WHEN x_link.wallet = EXCLUDED.wallet
                                   THEN x_link.linked_at
                                   ELSE EXCLUDED.linked_at END,
               refreshed_at = EXCLUDED.refreshed_at
        RETURNING x_id
      `;
      return rows.length === 1 ? { kind: "linked" } : { kind: "wallet-taken" };
    },

    async unlink(wallet: string): Promise<string | null> {
      // A DELETE, NOT A FLAG (§6.2, in as many words). The avatar bytes are columns of this row, so
      // they leave with it: `/api/links` stops emitting the identity on its next read and
      // `/api/avatar/<x_id>/<hash>.webp` starts 404ing, with no second call, no cache to purge and no
      // way for one to succeed without the other.
      //
      // Not restricted to un-suppressed rows. A player's revocation must work on a row an operator has
      // already taken down — the two operations answer to different people and neither is allowed to
      // block the other.
      const rows = await sql`
        DELETE FROM x_link
         WHERE wallet = ${wallet}
        RETURNING x_id
      `;
      return rows.length === 1 ? str(rows[0], "x_link", "x_id") : null;
    },
  };
}

export function createPgRateCounter(sql: SqlQuery): RateCounter {
  return {
    async hit(buckets: readonly string[], windowStartSec: number): Promise<readonly number[]> {
      if (buckets.length === 0) return [];
      // ONE ROUND TRIP FOR EVERY SUBJECT. `unnest($1::text[])` is the same trick `findByWallets` uses
      // for `= ANY($1)`: one parameter regardless of how many buckets, and no arrangement of it in
      // which a bucket becomes syntax.
      //
      // The `CASE` is the whole of the fixed-window logic. A row whose `window_start` is the current
      // window is incremented; a row from any older window is RESET to 1 and re-dated. That is why the
      // window is not part of the bucket key: one row per subject, reused for ever, instead of one row
      // per subject per window accumulating until somebody notices.
      //
      // THE EXPIRED-CHALLENGE SWEEP RIDES HERE, on the one statement every write request runs — see
      // `put`'s note for why the two sweeps are crossed over. `window_start` rather than a separate
      // clock: it is the only instant this method is given, it is never in the future, and a challenge
      // that expired inside the current window simply waits for the next one. Housekeeping does not need
      // to be prompt; it needs to happen without being asked.
      const rows = await sql`
        WITH swept_challenges AS (
          DELETE FROM x_link_challenge WHERE expires_at < to_timestamp(${windowStartSec})
        )
        INSERT INTO x_link_rate (bucket, window_start, hits)
        SELECT b, to_timestamp(${windowStartSec}), 1
          FROM unnest(${buckets}::text[]) AS t(b)
        ON CONFLICT (bucket) DO UPDATE
           SET hits         = CASE WHEN x_link_rate.window_start = to_timestamp(${windowStartSec})
                                   THEN x_link_rate.hits + 1
                                   ELSE 1 END,
               window_start = to_timestamp(${windowStartSec})
        RETURNING bucket, hits
      `;

      // `RETURNING` HAS NO GUARANTEED ROW ORDER, so the order is restored rather than assumed. Getting
      // this wrong would compare a wallet's count against a network's limit, which is a bug that only
      // shows up as "the limit is three times too loose" and never as an error.
      const byBucket = new Map<string, number>();
      for (const r of rows) byBucket.set(str(r, RT, "bucket"), int(r, RT, "hits"));

      return buckets.map((b) => {
        const hits = byBucket.get(b);
        if (hits === undefined) {
          // Unreachable: every row in the `unnest` is either inserted or updated, and both branches
          // return. A throw rather than a default, because the only default that could go here is a
          // number, and a made-up number in a rate limiter is a rate limiter that is off.
          throw new TypeError(`x_link_rate: no count returned for a bucket that was counted`);
        }
        return hits;
      });
    },
  };
}

/** Everything the write path needs from Postgres, from one `sql`. Assembled here so the entry points
 *  in `/api` stay three lines of wiring, exactly as `neonStore.ts` keeps `links.ts` short. */
export interface PgWriteStore {
  readonly challenges: ChallengeStore;
  readonly links: LinkWriter;
  readonly rate: RateCounter;
}

export function createPgWriteStore(sql: SqlQuery): PgWriteStore {
  return {
    challenges: createPgChallengeStore(sql),
    links: createPgLinkWriter(sql),
    rate: createPgRateCounter(sql),
  };
}

