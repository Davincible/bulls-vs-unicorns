// THE IN-MEMORY `LinkStore`. What the tests run against, and what `vercel dev` runs against when no
// `DATABASE_URL` is set.
//
// It is not a stub. It enforces every rule `pgStore.ts` enforces — the suppression filter, the
// exact-hash requirement, the "no upsert from ingest" rule, the all-or-nothing avatar columns —
// because a fake that is more permissive than the real thing is a fake that lets a bug through the
// gate and into production. Every difference between these two implementations is a place a test
// can be green about something that is false.
//
// IT IS ALSO THE `LinkWriter` NOW, and that paragraph replaces one that said the opposite. The old
// text read: "The one thing it deliberately does NOT model is the unique constraint on `wallet` as a
// *conflict*: `seed()` throws on a duplicate rather than resolving it, because Stage 2 has no write
// path that can produce one (there is no link ceremony yet) and a hand-rolled conflict resolution here
// would be an untested guess at what §4.1 step 6 will do." It is no longer a guess — the ceremony
// exists, `pgWriteStore.ts#link` decides both conflict directions in one statement, and `link()` below
// mirrors that decision rather than inventing one. `seed()` keeps its throw, because a test building an
// impossible world by hand should still be stopped.
//
// THE TABLE'S CHECK CONSTRAINTS ARE ENFORCED HERE TOO, and that is the point of the exercise rather
// than diligence for its own sake. `avatar_url ~ '^https://pbs\.twimg\.com/'` is the anti-SSRF control
// in migration 0001; a fake that accepted any URL would let a test be green about a write the database
// would have refused, and the write path's whole job on that column is to produce something the
// database will take. So a bad value THROWS here, exactly as Postgres would, and
// `linkWriteHandler.test.ts` can prove the ceremony never produces one without a database.

import type { AvatarBytes, IngestTarget, LinkRow, LinkStore } from "./store.ts";
import type { LinkWriteOutcome, LinkWriter, XIdentity } from "./writeStore.ts";

/** A whole row, including the two columns the read path must never see. */
export interface MemoryRow {
  readonly xId: string;
  readonly wallet: string;
  readonly handle: string;
  readonly displayName: string;
  /** `null` when the X account has no profile picture — a real state since migration 0002. See
   *  `store.ts#IngestTarget.avatarUrl`. */
  readonly avatarUrl: string | null;
  avatarHash: string | null;
  avatarBytes: Uint8Array | null;
  avatarAt: number | null;
  readonly linkedAt: number;
  suppressed: boolean;
}

/** Everything a seeded row needs; the avatar columns start empty, which is the state a fresh link is
 *  actually in. */
export interface SeedRow {
  readonly xId: string;
  readonly wallet: string;
  readonly handle: string;
  readonly displayName?: string;
  /** Omitted takes `DEFAULT_AVATAR_URL`, which is what a linked account normally has. Pass `null`
   *  explicitly for the account-with-no-picture case — the two are different worlds and a test that
   *  wants the second one has to say so. */
  readonly avatarUrl?: string | null;
  readonly linkedAt?: number;
  readonly suppressed?: boolean;
}

const DEFAULT_AVATAR_URL = "https://pbs.twimg.com/profile_images/1/x_normal.jpg";

/** The table's CHECK constraints, transcribed from `0001_x_link.sql`. One place, so a drift between
 *  the fake and the schema is one edit rather than four. */
const X_ID_RE = /^[0-9]{1,20}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AVATAR_URL_PREFIX = "https://pbs.twimg.com/";

/** Throws what Postgres would refuse. The message names the constraint so a failing test reads like
 *  the database talking. */
function assertRowIsStorable(wallet: string, identity: XIdentity): void {
  if (!X_ID_RE.test(identity.xId)) throw new Error(`x_link_x_id_check: ${identity.xId}`);
  if (!HANDLE_RE.test(identity.handle)) throw new Error(`x_link_handle_check: ${identity.handle}`);
  if (!WALLET_RE.test(wallet)) throw new Error(`x_link_wallet_check: ${wallet}`);
  if (identity.displayName.length > 100) throw new Error("x_link_display_name_check");
  // THE ANTI-SSRF CONSTRAINT. `null` is permitted — a CHECK is satisfied by NULL in SQL, and migration
  // 0002 relies on exactly that — and any string that is not on X's image CDN is not.
  if (identity.avatarUrl !== null && !identity.avatarUrl.startsWith(AVATAR_URL_PREFIX)) {
    throw new Error("x_link_avatar_url_check");
  }
}

export class MemoryLinkStore implements LinkStore, LinkWriter {
  /** Keyed by `x_id`, exactly as the table is. */
  private readonly rows = new Map<string, MemoryRow>();

  /**
   * `x_link_suppressed` (migration 0003) — the durable half of the §7.4 kill switch.
   *
   * SEPARATE FROM `rows` FOR THE REASON THE TABLE IS SEPARATE FROM `x_link`: it has to survive
   * `unlink()`. A fake that kept suppression only on the row would be green about the exact bypass 0003
   * exists to close — suppress, unlink, relink, and the identity is back — which is why this is modelled
   * rather than approximated.
   */
  private readonly suppressedXIds = new Set<string>();

  /** Test/dev fixture entry point. Enforces both unique constraints so a test cannot accidentally
   *  build a world the database would have refused. */
  seed(row: SeedRow): this {
    if (this.rows.has(row.xId)) throw new Error(`x_id already linked: ${row.xId}`);
    for (const existing of this.rows.values()) {
      if (existing.wallet === row.wallet) throw new Error(`wallet already linked: ${row.wallet}`);
    }
    this.rows.set(row.xId, {
      xId: row.xId,
      wallet: row.wallet,
      handle: row.handle,
      displayName: row.displayName ?? "",
      // `=== undefined` rather than `??`, and the difference is the whole point of the field's type:
      // `??` would fold an explicit `null` — "this account has no picture" — back into the default URL,
      // silently making the one case migration 0002 exists for untestable.
      avatarUrl: row.avatarUrl === undefined ? DEFAULT_AVATAR_URL : row.avatarUrl,
      avatarHash: null,
      avatarBytes: null,
      avatarAt: null,
      linkedAt: row.linkedAt ?? 1_700_000_000,
      suppressed: row.suppressed ?? false,
    });
    return this;
  }

  async findByWallets(wallets: readonly string[]): Promise<readonly LinkRow[]> {
    const wanted = new Set(wallets);
    const out: LinkRow[] = [];
    for (const r of this.rows.values()) {
      if (!wanted.has(r.wallet)) continue;
      if (r.suppressed) continue; // §7.4 — the store filters, so no handler can forget.
      out.push({
        xId: r.xId,
        wallet: r.wallet,
        handle: r.handle,
        displayName: r.displayName,
        avatarHash: r.avatarHash,
        linkedAt: r.linkedAt,
      });
    }
    return out;
  }

  async findAvatar(xId: string, avatarHash: string): Promise<AvatarBytes | null> {
    const r = this.rows.get(xId);
    if (r === undefined || r.suppressed) return null;
    // Exact hash or nothing. Not `startsWith`, not case-insensitive: the hash is the cache key and
    // the integrity claim at once.
    if (r.avatarHash === null || r.avatarHash !== avatarHash || r.avatarBytes === null) return null;
    return { bytes: r.avatarBytes };
  }

  async findForIngest(xId: string): Promise<IngestTarget | null> {
    const r = this.rows.get(xId);
    if (r === undefined) return null;
    return { xId: r.xId, avatarUrl: r.avatarUrl, suppressed: r.suppressed };
  }

  async putAvatar(xId: string, avatarHash: string, bytes: Uint8Array, atSec: number): Promise<boolean> {
    const r = this.rows.get(xId);
    if (r === undefined) return false; // No upsert. Only the ceremony creates links.
    r.avatarHash = avatarHash;
    r.avatarBytes = bytes;
    r.avatarAt = atSec;
    return true;
  }

  async setSuppressed(xId: string, suppressed: boolean): Promise<boolean> {
    // Un-suppressing clears the durable record even when there is no row to update, exactly as
    // `pgStore.ts` does — an operator must be able to undo a suppression whose row the player has since
    // deleted.
    if (!suppressed) this.suppressedXIds.delete(xId);
    const r = this.rows.get(xId);
    if (r === undefined) return false;
    // Suppressing writes the tombstone only for an id that is really in the register, matching the
    // `SELECT … FROM updated` in the real statement.
    if (suppressed) this.suppressedXIds.add(xId);
    r.suppressed = suppressed;
    return true;
  }

  // ----------------------------------------------------------------------------------------------
  // `LinkWriter` — the ceremony's two writes, mirroring `pgWriteStore.ts` statement for statement.
  // ----------------------------------------------------------------------------------------------

  async link(wallet: string, identity: XIdentity, linkedAtSec: number): Promise<LinkWriteOutcome> {
    assertRowIsStorable(wallet, identity);

    // `WHERE NOT EXISTS (... wallet = $w AND x_id <> $x)` — this wallet must not already wear a
    // different X account. The strict direction, argued in `writeStore.ts#LinkWriter.link`: a link
    // write never deletes a row, and the holder of this wallet can always unlink first.
    for (const existing of this.rows.values()) {
      if (existing.wallet === wallet && existing.xId !== identity.xId) return { kind: "wallet-taken" };
    }

    const current = this.rows.get(identity.xId);
    if (current === undefined) {
      this.rows.set(identity.xId, {
        xId: identity.xId,
        wallet,
        handle: identity.handle,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        avatarHash: null,
        avatarBytes: null,
        avatarAt: null,
        linkedAt: linkedAtSec,
        // INHERITED FROM THE DURABLE RECORD, never defaulted to `false`. This is the line that makes
        // suppress -> unlink -> relink keep the identity down; see migration 0003.
        suppressed: this.suppressedXIds.has(identity.xId),
      });
      return { kind: "linked" };
    }

    // `ON CONFLICT (x_id) DO UPDATE`. The X account moves to this wallet in place, which is how §4.3's
    // "removes W1's row in the same transaction" is satisfied without there ever being two rows.
    //
    // WHAT IS NOT TOUCHED, and both omissions are load-bearing: `suppressed`, because an operator's
    // kill switch must survive a relink or the ceremony is a moderation bypass; and the three avatar
    // columns, because the picture belongs to the x_id and §7.2 prefers the last good bytes to a flat
    // disc while a re-ingest catches up. `linked_at` moves only when the wallet does.
    const walletChanged = current.wallet !== wallet;
    // The one case where the avatar columns DO move: the upstream picture is gone, so the bytes go with
    // it. Keeping them would leave a row advertising a hash with no URL left to refresh from — the old
    // face served for ever, against the wishes of the person in it. All three together, because
    // `x_link_avatar_all_or_nothing` says so.
    const pictureGone = identity.avatarUrl === null;
    this.rows.set(identity.xId, {
      ...current,
      wallet,
      handle: identity.handle,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      avatarHash: pictureGone ? null : current.avatarHash,
      avatarBytes: pictureGone ? null : current.avatarBytes,
      avatarAt: pictureGone ? null : current.avatarAt,
      linkedAt: walletChanged ? linkedAtSec : current.linkedAt,
    });
    return { kind: "linked" };
  }

  async unlink(wallet: string): Promise<string | null> {
    // A DELETE, not a flag (§6.2). The avatar bytes are fields of this row, so they go with it — which
    // is what makes `findAvatar` start answering `null` with no second call.
    for (const [xId, row] of this.rows) {
      if (row.wallet !== wallet) continue;
      this.rows.delete(xId);
      return xId;
    }
    return null;
  }
}
