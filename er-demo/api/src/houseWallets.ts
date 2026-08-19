// THE HOUSE WALLET LIST, READ LIVE OVER AN AUTHENTICATED CHANNEL, AND WHAT TO DO WHEN IT CANNOT BE
// READ.
//
// `TWITTER-CONNECT.md` §6.3 states one hard rule: a house wallet must never wear a person's face.
// The keeper fields house fighters to keep a lobby from being empty; a house wallet rendering as
// `@someone` is an actual misrepresentation — an automated process wearing a person's name in a game
// about money.
//
// THIS FILE USED TO SAY THE OPPOSITE OF WHAT IT NOW SAYS, AND THE INVERSION IS THE POINT. It argued
// that such a rendering "would not be a privacy leak — the list is already published to every browser
// and printed on the leaderboard". That is no longer true and is no longer wanted. The arena's house
// wallets are ANONYMOUS: the keeper does not publish the list, `KEEPER_STATUS_SCHEMA` 5 removed the
// `house` field from the status file entirely, and no browser ever sees which fighters are the
// house's. The list did not go away — the keeper still uses it internally to tell a house fighter
// from a real one — it went PRIVATE. What is preserved below is the rule and its fail direction;
// what changed is where the list comes from and who is allowed to ask for it.
//
// FROM THE KEEPER'S LIVE ENDPOINT, NOT FROM `er-demo/public/keeper-status.json`, and now for two
// reasons rather than one. The old reason still holds: the committed snapshot is a build artefact,
// whatever the keeper happened to be publishing when someone last ran it locally, already several
// program deploys out of date in this repo — and a house wallet added after that build is a house
// wallet the snapshot does not know about, which is exactly and only the case the rule exists for.
// The new reason is blunter: the snapshot does not contain the list at all any more, at any age.
//
// ------------------------------------------------------------------------------------------------
// WHY AN AUTHENTICATED KEEPER ENDPOINT AND NOT A COPY.
//
// Two cheaper designs were evaluated and both were rejected for the same defect. A build-time env
// var holding the wallet list, and a static list committed to this repo, are both COPIES — and the
// bank GROWS. `scripts/keeper/extendHouseBank.ts` exists precisely to grow it, and production
// already runs 48 wallets against a code default of 10. A baked-in copy goes stale at the exact
// moment a wallet is added, which is the exact moment the §6.3 check has something to do. A house
// wallet the API does not know about is the only case this whole module exists for; a design whose
// failure mode is "does not know about the newest wallet" fails at its one job.
//
// So: one source of truth, read live, over a channel the browser cannot use. The keeper is the only
// process that knows its own bank, and `Authorization: Bearer` is what lets it hand that knowledge
// to this API without handing it to everyone.
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
//                percent of players who never link (§8) — the flat disc and a truncated wallet address.
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
  /** Wallets the keeper reports as its own. Empty AND `unknown: false` means the keeper genuinely
   *  has no house wallets, which is a different fact from not knowing. */
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
  /** The keeper's `KEEPER_HOUSE_TOKEN`. A constructor argument rather than a `process.env` read, for
   *  the same reason the other three are: this class must be answerable in a unit test, and a module
   *  that reaches for the environment on its own can only be tested by mutating it. */
  readonly token: string;
  readonly fetch: typeof globalThis.fetch;
  readonly nowSec: () => number;
}

/**
 * Reads the top-level `wallets` array out of a house-list body: `{"wallets":["<base58>", …]}`.
 *
 * THERE IS NO SCHEMA VERSION TO ARGUE ABOUT ANY MORE, and the paragraph that used to stand here is
 * gone rather than merely edited. It explained at length why this function did NOT pin the keeper's
 * `schema` field the way `keeperStatus.ts` does — that a half-understood status becomes a
 * confidently-wrong countdown in front of a player, whereas this module asks one question and uses
 * the answer only to WITHHOLD, so tolerating an unrecognised version was the safer half of a real
 * asymmetry. That asymmetry is now MOOT, not resolved: the endpoint this reads carries no `schema`
 * field and nothing else besides `wallets`.
 *
 * What replaces it is narrower and duller. This body has exactly one shape. A body that is not that
 * shape is not a newer dialect to be tolerated — it is unreadable, and unreadable takes the
 * fail-closed path in the header. There is no version skew to be generous about because there is no
 * version.
 */
export function houseWalletsFrom(body: unknown): ReadonlySet<string> | null {
  if (typeof body !== "object" || body === null) return null;
  const wallets = (body as { wallets?: unknown }).wallets;
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
      const res = await this.deps.fetch(this.deps.url, {
        signal: ctl.signal,
        // `redirect: "error"` was already right and now it is load-bearing. Following a redirect
        // means re-sending the `Authorization` header to whatever host the redirect names — a
        // bearer token handed to somebody nobody vetted, on the strength of a 302 from a machine we
        // are already failing to reach correctly. Refusing costs a fetch that returns null and
        // falls back to the last good list; the alternative cost is the credential itself.
        redirect: "error",
        headers: { Authorization: `Bearer ${this.deps.token}` },
      });
      if (res.status === 401) {
        // THE ONE FAILURE HERE THAT EARNS A LOG LINE, and the reason is that it is the only one that
        // will never fix itself. Every other failure below is transient by nature — a timeout, a
        // deploy, a DNS blip — and is answered correctly by returning the last good list and trying
        // again in a minute; logging those would be noise proportional to the keeper's worst day.
        // A 401 is not transient. It means the token this function was deployed with and the
        // keeper's `KEEPER_HOUSE_TOKEN` secret disagree, which no amount of retrying resolves, and
        // whose only outward symptom is that every avatar on the leaderboard is quietly missing —
        // the exact silence §6.3's fail-closed path is designed to be indistinguishable from. So it
        // gets said out loud, once per occurrence, to the one audience that can act on it.
        //
        // NOT deduplicated behind a "have I warned already" flag. The cache TTL and the in-flight
        // collapse already bound this to at most one line per refresh interval per worker, and a
        // one-shot flag would make a permanently broken deployment look like a single startup
        // hiccup to anyone who opened the logs a minute late. Repetition is the signal.
        console.warn(
          `[houseWallets] ${this.deps.url} returned 401. KEEPER_HOUSE_TOKEN does not match the ` +
            `keeper's secret; every X link is being withheld until it does.`,
        );
        // Fail closed anyway. A rejected token is not a reason to start trusting a list we did not
        // manage to read.
        return null;
      }
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
