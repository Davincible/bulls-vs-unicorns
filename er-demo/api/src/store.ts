// THE SEAM. Four questions this feature asks of its storage, and nothing else.
//
// The handlers depend on this interface and never on a driver, which is what makes the whole
// serverless half of this feature testable with `npm test`, no database, no network and no
// container. That is not a convenience: the expensive defects here — a suppressed row that still
// renders, a house wallet wearing a face, a hash mismatch that serves bytes anyway — are all
// *policy* defects, and policy defects are exactly the class that a test needing Postgres never gets
// written for.
//
// DELIBERATELY NOT AN ORM AND DELIBERATELY NOT GENERIC. There is no `find`, no `where`, no `query`.
// Each method below is one question with one answer, phrased the way the caller asks it, so that
// reading this file tells you everything the feature can possibly do to its data. A generic
// interface would tell you nothing and would grow a fifth capability the first time somebody was in
// a hurry.

/** One row of `x_link`, as the API cares about it. Unix SECONDS throughout — the unit of `xLink.ts`
 *  and of the wire, converted once, in `pgStore.ts`, and never again. */
export interface LinkRow {
  readonly xId: string;
  readonly wallet: string;
  readonly handle: string;
  /** `""` for none. The wire has no null; see `LinkAttestation`. */
  readonly displayName: string;
  /** `null` until an ingest has succeeded — "linked, avatar in flight", §7.3's ordinary rung. */
  readonly avatarHash: string | null;
  /** Unix seconds. */
  readonly linkedAt: number;
}

/** What the ingest needs to know before it fetches. Separate from `LinkRow` because `avatarUrl` is
 *  the one column that must never reach a browser, and a type that cannot carry it to the read path
 *  is a stronger guarantee than remembering not to. */
export interface IngestTarget {
  readonly xId: string;
  /**
   * The upstream `pbs.twimg.com` URL. NEVER SERVED.
   *
   * `null` MEANS THE X ACCOUNT HAS NO PROFILE PICTURE AT ALL, which is a real state rather than a
   * missing value: X serves the default egg from `abs.twimg.com`, a host the column's CHECK may not
   * name and a picture we would refuse anyway, because the arena's own flat side-coloured disc (§7.3)
   * is both better looking and more honest than a grey silhouette. Migration 0002 carries the whole
   * argument and the reason this could not stay `NOT NULL`: under it, an otherwise perfectly proven
   * link could not be stored.
   *
   * Every consumer must therefore decide what to do with "there is nothing to fetch". There is exactly
   * one consumer (`scripts/xlink-ingest.ts`) and its answer is to skip the row, leaving
   * `avatar_hash` NULL — which is the same state as "avatar in flight" and renders identically.
   */
  readonly avatarUrl: string | null;
  readonly suppressed: boolean;
}

/** The bytes the proxy serves, already re-encoded and already named by their own hash. */
export interface AvatarBytes {
  readonly bytes: Uint8Array;
}

/**
 * The four questions.
 *
 * `suppressed` IS FILTERED BY THE STORE, NOT BY THE CALLER, for `findByWallets` and `findAvatar`.
 * That is a design choice worth naming: it means there is no way to write a handler that forgets,
 * and it means the in-memory implementation and the SQL implementation are both forced to
 * demonstrate the rule rather than inherit it. `findForIngest` is the one method that returns a
 * suppressed row, because the ingest must be able to *see* the suppression in order to refuse.
 */
export interface LinkStore {
  /**
   * `GET /api/links`. Returns a row for every wallet in the list that is linked AND not suppressed.
   * Wallets that are not linked are simply absent — the API does not emit "no" rows (`xLink.ts`,
   * `LinksResponse`).
   *
   * The caller has already validated every wallet and enforced `MAX_WALLETS_PER_QUERY`; this method
   * does not re-check, because a store that silently truncates a too-long list is a store that turns
   * a caller's bug into missing avatars instead of into an error.
   */
  findByWallets(wallets: readonly string[]): Promise<readonly LinkRow[]>;

  /**
   * The avatar proxy. Returns bytes only when the row exists, is not suppressed, and its
   * `avatar_hash` is EXACTLY the one asked for. A mismatch returns `null` and the caller 404s —
   * never the current bytes under a stale name, because the URL is `immutable`-shaped by content
   * hash and serving different bytes under one hash is how a CDN poisons itself.
   */
  findAvatar(xId: string, avatarHash: string): Promise<AvatarBytes | null>;

  /** What the ingest command needs before it fetches. `null` when the x_id is not linked at all. */
  findForIngest(xId: string): Promise<IngestTarget | null>;

  /**
   * Commit a successful ingest. Hash, bytes and timestamp land together or not at all — the table's
   * `x_link_avatar_all_or_nothing` constraint says so, and this signature is the same statement in
   * TypeScript.
   *
   * @returns `false` when the x_id does not exist. There is no upsert here on purpose: an ingest
   *   that can create a link is an ingest that can create a link, and the only thing allowed to do
   *   that is the ceremony in §4.1.
   */
  putAvatar(xId: string, avatarHash: string, bytes: Uint8Array, atSec: number): Promise<boolean>;

  /**
   * The kill switch (§7.4). Idempotent by nature — setting a suppressed row suppressed is a no-op
   * that still reports success, because an operator running the command twice during an incident
   * must not be told they failed.
   *
   * IT WRITES IN TWO PLACES AND THAT IS THE POINT. `x_link.suppressed` is what both read paths filter
   * on in SQL, so no handler can forget it; `x_link_suppressed` (migration 0003) is keyed on the x_id
   * and OUTLIVES THE ROW, because a player may delete their own row while suppressed (§6.2 says they
   * may, and they must) and the identity must still come back suppressed if they link again.
   * Implementations must keep both, and `unlink` must touch neither.
   *
   * @returns `false` only when the x_id does not exist, which is the one answer the operator needs
   *   distinguished: "I typed the wrong id" and "it is now suppressed" must not look alike.
   */
  setSuppressed(xId: string, suppressed: boolean): Promise<boolean>;
}
