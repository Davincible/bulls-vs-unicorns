// THE HOUSE WALLET DISCLOSURE, READ LIVE, AND WHAT TO DO WHEN IT CANNOT BE READ.
//
// `TWITTER-CONNECT.md` §6.3 states one hard rule: a house wallet must never wear a person's face.
// The keeper fields house fighters to keep a lobby from being empty; a house wallet rendering as
// `@someone` would not be a privacy leak (the list is already published to every browser and printed
// on the leaderboard) — it would be an actual misrepresentation, an automated process wearing a
// person's name in a game about money.
//
// FROM THE KEEPER'S LIVE ENDPOINT, NOT FROM `er-demo/public/keeper-status.json`. The committed
// snapshot is a build artefact: it is whatever the keeper happened to be publishing when someone
// last ran it locally, and it is already several program deploys out of date in this repo. A house
// wallet added after that build is a house wallet the snapshot does not know about, which is exactly
// and only the case the rule exists for.
//
// ------------------------------------------------------------------------------------------------
// WHICH WAY THIS FAILS, AND WHY THAT DIRECTION.
//
// If the keeper is unreachable we do not know whether a wallet is the house's. The two directions
// are not symmetric:
//
//   fail OPEN  — serve every link. Cost: a house wallet can wear a face, which is the one outcome
//                §6.3 calls out as unacceptable. It is also silent and indefinite.
//   fail CLOSED — serve nothing. Cost: the leaderboard renders exactly as it does for the ninety-odd
//                percent of players who never link (§8) — the flat disc and a `nameFor()` pseudonym.
//                Nothing shows an error, nothing is blocked, and no game action depends on it.
//
// So it fails closed, and the cost of failing closed is *the ordinary rendering of this page*. That
// is an unusually cheap safe direction and it should be taken without hesitation.
//
// But "closed" is scoped as narrowly as it can honestly be: a fetch failure falls back to the LAST
// GOOD LIST AT ANY AGE, because the set of house wallets changes on the order of never and a
// six-hour-old copy of it is a far better answer than no answer. Only a worker that has never once
// succeeded — a cold start during a keeper outage — actually returns "unknown", and only that case
// withholds every link.

const REFRESH_SECONDS = 60;
const FETCH_TIMEOUT_MS = 2_000;

export interface HouseList {
  /** Wallets the keeper publishes as its own. Empty AND `unknown: false` means the keeper genuinely
   *  publishes no house wallets, which is a different fact from not knowing. */
  readonly wallets: ReadonlySet<string>;
  /** `true` only when this worker has never successfully read the list. The caller must serve no
   *  links at all — see the header. */
  readonly unknown: boolean;
}

export const HOUSE_LIST_UNKNOWN: HouseList = { wallets: new Set(), unknown: true };

/** What a handler needs: one question, asked per request. Structural rather than the class itself,
 *  so `linksHandler.ts` has no way to reach the cache's internals and a test can answer the question
 *  directly instead of standing up a fake HTTP server to get one boolean across. */
export interface HouseListSource {
  get(): Promise<HouseList>;
}

interface Cached {
  readonly list: HouseList;
  readonly atSec: number;
}

/** Injectable so tests never touch the network and never wait on a clock. */
export interface HouseListDeps {
  readonly url: string;
  readonly fetch: typeof globalThis.fetch;
  readonly nowSec: () => number;
}

/**
 * Reads `house.wallets` out of a keeper status body — STRUCTURALLY, and without asserting the
 * schema version.
 *
 * `keeperStatus.ts` deliberately does the opposite: it demands an exact `schema` match and reports
 * "keeper down" for anything else, because it draws a countdown from that file and a half-understood
 * status becomes a confidently-wrong number in front of a player. The asymmetry is intentional and
 * worth stating, because a reader who knows that module will expect the same rule here.
 *
 * This module asks one question — "is this wallet the house's?" — and uses the answer only to
 * WITHHOLD. A keeper that bumps its schema for an unrelated field still answers that question
 * correctly, and pinning the version would mean a keeper deploy silently removes every avatar on the
 * site until this function is redeployed to agree with it. Half-understanding is dangerous when you
 * render from it and harmless when you only refuse from it.
 */
export function houseWalletsFrom(body: unknown): ReadonlySet<string> | null {
  if (typeof body !== "object" || body === null) return null;
  const house = (body as { house?: unknown }).house;
  if (typeof house !== "object" || house === null) return null;
  const wallets = (house as { wallets?: unknown }).wallets;
  if (!Array.isArray(wallets)) return null;
  // One bad entry invalidates the whole list rather than being skipped. A partially-parsed deny list
  // is a deny list with a hole in it, and the hole is invisible.
  const out = new Set<string>();
  for (const w of wallets) {
    if (typeof w !== "string" || w === "") return null;
    out.add(w);
  }
  return out;
}

/**
 * A ~60s-cached view of the house list, safe to call on every request.
 *
 * Instance-scoped rather than module-scoped state, so a test gets a clean cache without reaching
 * into module internals and so two entry points cannot accidentally share a poisoned one. The entry
 * points each construct exactly one at module scope, which is what makes the cache survive warm
 * invocations — the only reason it is worth having.
 */
export class HouseListCache implements HouseListSource {
  private cached: Cached | null = null;
  /** One in-flight refresh at a time. Without this, a burst on a warm worker fires a fetch per
   *  request at the keeper — a single machine, by `fly.toml` rule 1 — which is a self-inflicted load
   *  test on the one process that must not fall over. */
  private inflight: Promise<HouseList> | null = null;

  // A plain field rather than a parameter property: `erasableSyntaxOnly` is on across this repo's
  // tsconfigs, and a parameter property is the one class syntax that cannot be erased.
  private readonly deps: HouseListDeps;

  constructor(deps: HouseListDeps) {
    this.deps = deps;
  }

  async get(): Promise<HouseList> {
    const now = this.deps.nowSec();
    const c = this.cached;
    if (c !== null && now - c.atSec < REFRESH_SECONDS) return c.list;
    if (this.inflight !== null) return this.inflight;

    this.inflight = this.refresh(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(nowSec: number): Promise<HouseList> {
    const fetched = await this.fetchOnce();
    if (fetched !== null) {
      const list: HouseList = { wallets: fetched, unknown: false };
      this.cached = { list, atSec: nowSec };
      return list;
    }
    // Stale at any age beats nothing: the house set changes on the order of never, and the only
    // thing a stale copy can get wrong is failing to suppress a wallet added in the last few
    // minutes. Returning `unknown` here instead would blank every avatar on the site for one keeper
    // hiccup.
    if (this.cached !== null) return this.cached.list;
    return HOUSE_LIST_UNKNOWN;
  }

  private async fetchOnce(): Promise<ReadonlySet<string> | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.deps.fetch(this.deps.url, { signal: ctl.signal, redirect: "error" });
      if (!res.ok) return null;
      return houseWalletsFrom(await res.json());
    } catch {
      // Every failure is one failure: timeout, DNS, TLS, a redirect, malformed JSON, a shape we do
      // not recognise. There is nothing the caller could do differently for any of them, and the
      // handling above is identical.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
