// THE IN-MEMORY `LinkStore`. What the tests run against, and what `vercel dev` runs against when no
// `DATABASE_URL` is set.
//
// It is not a stub. It enforces every rule `pgStore.ts` enforces — the suppression filter, the
// exact-hash requirement, the "no upsert from ingest" rule, the all-or-nothing avatar columns —
// because a fake that is more permissive than the real thing is a fake that lets a bug through the
// gate and into production. Every difference between these two implementations is a place a test
// can be green about something that is false.
//
// The one thing it deliberately does NOT model is the unique constraint on `wallet` as a *conflict*:
// `seed()` throws on a duplicate rather than resolving it, because Stage 2 has no write path that
// can produce one (there is no link ceremony yet) and a hand-rolled conflict resolution here would
// be an untested guess at what §4.1 step 6 will do.

import type { AvatarBytes, IngestTarget, LinkRow, LinkStore } from "./store.ts";

/** A whole row, including the two columns the read path must never see. */
export interface MemoryRow {
  readonly xId: string;
  readonly wallet: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string;
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
  readonly avatarUrl?: string;
  readonly linkedAt?: number;
  readonly suppressed?: boolean;
}

const DEFAULT_AVATAR_URL = "https://pbs.twimg.com/profile_images/1/x_normal.jpg";

export class MemoryLinkStore implements LinkStore {
  /** Keyed by `x_id`, exactly as the table is. */
  private readonly rows = new Map<string, MemoryRow>();

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
      avatarUrl: row.avatarUrl ?? DEFAULT_AVATAR_URL,
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
    const r = this.rows.get(xId);
    if (r === undefined) return false;
    r.suppressed = suppressed;
    return true;
  }
}
