// THE POSTGRES `LinkStore`. Four queries and a boundary.
//
// IT DOES NOT IMPORT A DRIVER. `createPgStore` takes a tagged-template query function, which is the
// shape `@neondatabase/serverless`'s `neon()` already has and the shape `postgres.js` and `pg`'s
// `sql` helpers have too. The one place that names Neon is the entry point in `/api`, which is one
// line and is the only file that should have an opinion about which Postgres this is.
//
// That is not decoupling for its own sake. It means this file — the file that decides whether a
// suppressed row can escape, whether a hash mismatch can serve bytes — is type-checked by
// `npm run typecheck` and reachable by `npm test` without a database, a container or a network. A
// store that can only be tested against real Postgres is a store whose policy is tested by
// production.
//
// EVERY VALUE CROSSES A BOUNDARY HERE. Rows come back as `Record<string, unknown>` and are coerced
// explicitly, one field at a time, with a throw on anything unexpected. A driver that starts
// returning `int8` as a string instead of a number (which is exactly what the HTTP driver does) must
// produce a loud failure at the seam and not a `NaN` three layers away.

import type { AvatarBytes, IngestTarget, LinkRow, LinkStore } from "./store.js";

export type SqlRow = Record<string, unknown>;

/** What this file needs from a Postgres client, and nothing more: run a parameterised statement,
 *  give me rows. Parameterisation is not optional and there is no string-concatenation path — the
 *  tagged template is the only way to call it, so a value can never become syntax. */
export interface SqlQuery {
  (strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<SqlRow[]>;
}

function str(row: SqlRow, col: string): string {
  const v = row[col];
  if (typeof v !== "string") throw new TypeError(`x_link.${col}: expected string, got ${typeof v}`);
  return v;
}

function strOrNull(row: SqlRow, col: string): string | null {
  const v = row[col];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new TypeError(`x_link.${col}: expected string|null, got ${typeof v}`);
  return v;
}

/** `extract(epoch …)::bigint` arrives as a string over the HTTP driver and as a number over the
 *  WebSocket one. Both are accepted, neither is assumed, and anything else throws. */
function epoch(row: SqlRow, col: string): number {
  const v = row[col];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new TypeError(`x_link.${col}: expected an epoch, got ${String(v)}`);
  return Math.trunc(n);
}

function bytesFromBase64(row: SqlRow, col: string): Uint8Array {
  const b64 = str(row, col);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function createPgStore(sql: SqlQuery): LinkStore {
  return {
    async findByWallets(wallets: readonly string[]): Promise<readonly LinkRow[]> {
      // ONE ROUND TRIP FOR UP TO 64 WALLETS. `= ANY($1)` rather than 64 statements or an `IN` list
      // built by hand: it uses the UNIQUE index on `wallet`, it is one parameter regardless of the
      // list length, and there is no arrangement of it in which a wallet becomes syntax.
      //
      // `NOT suppressed` is in the WHERE clause and not in the caller, so §7.4's kill switch cannot
      // be forgotten by a handler. See `store.ts`.
      const rows = await sql`
        SELECT x_id,
               wallet,
               handle,
               display_name,
               avatar_hash,
               extract(epoch from linked_at)::bigint AS linked_at
          FROM x_link
         WHERE wallet = ANY(${wallets}::text[])
           AND NOT suppressed
      `;
      return rows.map((r) => ({
        xId: str(r, "x_id"),
        wallet: str(r, "wallet"),
        handle: str(r, "handle"),
        displayName: str(r, "display_name"),
        avatarHash: strOrNull(r, "avatar_hash"),
        linkedAt: epoch(r, "linked_at"),
      }));
    },

    async findAvatar(xId: string, avatarHash: string): Promise<AvatarBytes | null> {
      // The hash is part of the WHERE clause, not something compared afterwards, so "wrong hash" and
      // "no such account" are one code path and cannot drift apart. `encode(...,'base64')` keeps the
      // bytea decoding in SQL where it is the same under every driver, rather than depending on
      // whichever of hex-string / Buffer / Uint8Array this month's client returns.
      const rows = await sql`
        SELECT encode(avatar_bytes, 'base64') AS avatar_b64
          FROM x_link
         WHERE x_id = ${xId}
           AND avatar_hash = ${avatarHash}
           AND avatar_bytes IS NOT NULL
           AND NOT suppressed
      `;
      if (rows.length === 0) return null;
      return { bytes: bytesFromBase64(rows[0], "avatar_b64") };
    },

    async findForIngest(xId: string): Promise<IngestTarget | null> {
      // Returns suppressed rows ON PURPOSE — the ingest must be able to see the suppression in order
      // to refuse it, and a store that hid it would leave the ingest fetching pictures for accounts
      // an operator has already taken down.
      const rows = await sql`
        SELECT x_id, avatar_url, suppressed
          FROM x_link
         WHERE x_id = ${xId}
      `;
      if (rows.length === 0) return null;
      const r = rows[0];
      // `strOrNull` for `avatar_url`, not `str`: since migration 0002 the column is nullable, and null
      // means "this X account has no profile picture" rather than "a value went missing". `store.ts`
      // carries the argument. Coercing it with `str` would throw at the seam on a row the ceremony is
      // entitled to write.
      return {
        xId: str(r, "x_id"),
        avatarUrl: strOrNull(r, "avatar_url"),
        suppressed: r.suppressed === true,
      };
    },

    async putAvatar(xId: string, avatarHash: string, bytes: Uint8Array, atSec: number): Promise<boolean> {
      // AN UPDATE, NEVER AN UPSERT. An ingest that can create a row is an ingest that can create a
      // link, and the only thing allowed to do that is the ceremony in §4.1 — where a wallet
      // signature proves the other half of the identity. The table's own
      // `x_link_avatar_all_or_nothing` constraint is the second half of this statement's guarantee:
      // the three columns land together or the statement fails.
      const rows = await sql`
        UPDATE x_link
           SET avatar_hash  = ${avatarHash},
               avatar_bytes = decode(${toBase64(bytes)}, 'base64'),
               avatar_at    = to_timestamp(${atSec})
         WHERE x_id = ${xId}
        RETURNING x_id
      `;
      return rows.length === 1;
    },

    async setSuppressed(xId: string, suppressed: boolean): Promise<boolean> {
      // ------------------------------------------------------------------------------------------
      // TWO PLACES, ONE STATEMENT. `x_link.suppressed` is the copy both read paths filter on in SQL;
      // `x_link_suppressed` is the durable record that survives the player deleting their own row.
      // Migration 0003 carries the whole argument, including the three-step bypass this closes:
      // suppress, unlink (allowed, and must stay allowed), relink — which used to return an identity
      // to the leaderboard because the flag lived on the row the player had just deleted.
      //
      // The CTE writes a different TABLE from the one the main statement updates, which is the rule
      // `pgWriteStore.ts` follows for the same reason: a data-modifying CTE touching the main
      // statement's own table can hand it a tuple the same command has already changed.
      //
      // `RETURNING` rather than a row count, so "no such x_id" is distinguishable from "already in
      // that state". An operator typing an id wrong during an incident must not be told it worked.
      // ------------------------------------------------------------------------------------------
      if (suppressed) {
        // The tombstone is written ONLY for an id that is actually in the register — `SELECT … FROM
        // updated` yields nothing when the UPDATE matched nothing — so a mistyped id leaves no trace
        // to puzzle over later.
        const rows = await sql`
          WITH updated AS (
            UPDATE x_link SET suppressed = TRUE WHERE x_id = ${xId} RETURNING x_id
          ), tombstoned AS (
            INSERT INTO x_link_suppressed (x_id)
            SELECT x_id FROM updated
            ON CONFLICT (x_id) DO NOTHING
          )
          SELECT x_id FROM updated
        `;
        return rows.length === 1;
      }
      // Un-suppressing removes the tombstone UNCONDITIONALLY, not only when a row exists. An operator
      // must be able to undo a suppression whose `x_link` row the player has since deleted; otherwise
      // the identity could never link again and nothing would explain why.
      const rows = await sql`
        WITH untombstoned AS (
          DELETE FROM x_link_suppressed WHERE x_id = ${xId}
        )
        UPDATE x_link
           SET suppressed = FALSE
         WHERE x_id = ${xId}
        RETURNING x_id
      `;
      return rows.length === 1;
    },
  };
}
