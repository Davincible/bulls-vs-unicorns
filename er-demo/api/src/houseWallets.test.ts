import { describe, expect, it, vi } from "vitest";
import { HouseListCache, houseWalletsFrom } from "./houseWallets.ts";
import { wallet } from "./testKit.ts";

/** The keeper's authenticated house-list body, which is a bare wallet list and nothing else. */
const rosterBody = (wallets: string[], extra: Record<string, unknown> = {}): unknown => ({
  wallets,
  ...extra,
});

/** The PUBLIC keeper status body, kept here for exactly one purpose: to be rejected. */
const keeperStatusBody = (wallets: string[]): unknown => ({
  schema: 5,
  house: { wallets, disclosure: "…" },
});

function fetcher(steps: Array<{ body?: unknown; status?: number; throws?: boolean }>) {
  let i = 0;
  const calls = { n: 0, inits: [] as Array<RequestInit | undefined> };
  const fn = (async (_url: string, init?: RequestInit) => {
    calls.n += 1;
    calls.inits.push(init);
    const step = steps[Math.min(i++, steps.length - 1)];
    if (step.throws) throw new Error("keeper unreachable");
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

describe("houseWalletsFrom", () => {
  it("reads a TOP-LEVEL wallets array, ignoring anything else on the body", () => {
    // The endpoint's contract is `{"wallets":[…]}` and nothing more. Tolerating unknown siblings is
    // not version-tolerance — there is no version — it is just refusing to break on a field that
    // cannot affect the one question this module asks.
    expect(houseWalletsFrom(rosterBody([wallet(1)], { note: "…" }))).toEqual(new Set([wallet(1)]));
  });

  it("REFUSES a keeper STATUS body, so the public file can never become the source again", () => {
    // WHAT THIS PINS, and it is the whole point of the change this test was written for. The house
    // list is now internal: the API reads it from an authenticated endpoint, and the public status
    // file no longer carries it (`KEEPER_STATUS_SCHEMA` 5 removed the `house` field). If a keeper
    // ever regressed and started republishing the list under `house.wallets`, this parser must NOT
    // quietly start accepting it — a silent re-entry of the public file as the API's source of truth
    // would undo the privacy change without a single test going red anywhere.
    //
    // The old shape is therefore not merely unsupported. It is rejected, on purpose, by a named test.
    expect(houseWalletsFrom(keeperStatusBody([wallet(1)]))).toBeNull();
  });

  it("returns null — never a partial list — for anything it does not recognise", () => {
    // A partially-parsed deny list is a deny list with a hole in it, and the hole is invisible.
    for (const bad of [
      null,
      "a string",
      {},
      { wallets: null },
      { wallets: "not-an-array" },
      { wallets: [wallet(1), 42] },
      { wallets: [wallet(1), ""] },
    ]) {
      expect(houseWalletsFrom(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("distinguishes an empty list from an unreadable one", () => {
    // A keeper with zero house wallets is a fact. Not knowing is a different fact, and the two must
    // not collapse — one of them means "serve everything" and the other means "serve nothing".
    expect(houseWalletsFrom(rosterBody([]))).toEqual(new Set());
  });
});

describe("HouseListCache", () => {
  const TOKEN = "a".repeat(32);
  const deps = (fetch: typeof globalThis.fetch, clock: { t: number }) => ({
    url: "https://keeper.example/house-wallets.json",
    token: TOKEN,
    fetch,
    nowSec: () => clock.t,
  });

  it("sends the bearer token, without which the keeper answers 401 and nothing renders", async () => {
    // The list is INTERNAL now. The keeper serves it to an authenticated caller and to nobody else,
    // so the header is not an optimisation or a nicety — it is the entire difference between this
    // API having a house list and this API withholding every avatar on the site.
    const clock = { t: 1000 };
    const { fn, calls } = fetcher([{ body: rosterBody([wallet(1)]) }]);
    await new HouseListCache(deps(fn, clock)).get();

    const init = calls.inits[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    // Following a redirect would re-send that token to whatever host the redirect names.
    expect(init?.redirect).toBe("error");
  });

  it("fetches once and serves the cached list for 60 seconds", async () => {
    // Without this the keeper — a single machine by `fly.toml` rule 1 — takes one request per page
    // poll from every worker. That is a self-inflicted load test on the one process that must not
    // fall over.
    const clock = { t: 1000 };
    const { fn, calls } = fetcher([{ body: rosterBody([wallet(1)]) }]);
    const cache = new HouseListCache(deps(fn, clock));

    expect((await cache.get()).wallets).toEqual(new Set([wallet(1)]));
    clock.t += 59;
    await cache.get();
    expect(calls.n).toBe(1);

    clock.t += 2; // past the TTL
    await cache.get();
    expect(calls.n).toBe(2);
  });

  it("collapses concurrent refreshes into one request", async () => {
    // A burst on a warm worker must not become a burst at the keeper.
    const clock = { t: 1000 };
    const { fn, calls } = fetcher([{ body: rosterBody([wallet(1)]) }]);
    const cache = new HouseListCache(deps(fn, clock));
    await Promise.all([cache.get(), cache.get(), cache.get(), cache.get()]);
    expect(calls.n).toBe(1);
  });

  it("keeps serving the last good list at ANY age when the keeper goes away", async () => {
    // The set of house wallets changes on the order of never. A six-hour-old copy is a far better
    // answer than no answer, and returning "unknown" here would blank every avatar on the site for
    // one keeper hiccup.
    const clock = { t: 1000 };
    const { fn } = fetcher([{ body: rosterBody([wallet(1)]) }, { throws: true }]);
    const cache = new HouseListCache(deps(fn, clock));
    await cache.get();

    clock.t += 6 * 60 * 60;
    const stale = await cache.get();
    expect(stale.unknown).toBe(false);
    expect(stale.wallets).toEqual(new Set([wallet(1)]));
  });

  it("reports UNKNOWN when it has never once succeeded", async () => {
    // A cold worker during a keeper outage. This is the only case that makes `/api/links` withhold
    // every row — the narrowest possible scope for failing closed.
    const clock = { t: 1000 };
    const { fn } = fetcher([{ throws: true }]);
    const cache = new HouseListCache(deps(fn, clock));
    const list = await cache.get();
    expect(list.unknown).toBe(true);
    expect(list.wallets.size).toBe(0);
  });

  it("treats a non-200, malformed JSON and an unrecognised shape identically", async () => {
    // There is nothing a caller could do differently for any of them. The third case is the keeper
    // status body: over this channel it is not a fallback, it is simply not the document we asked
    // for.
    for (const step of [{ status: 500 }, { body: "not json" }, { body: keeperStatusBody([wallet(1)]) }]) {
      const clock = { t: 1000 };
      const { fn } = fetcher([step]);
      expect((await new HouseListCache(deps(fn, clock)).get()).unknown).toBe(true);
    }
  });

  it("fails CLOSED on a 401 with a cold cache, and says so out loud", async () => {
    // A rejected token means the deployed `KEEPER_HOUSE_TOKEN` and the keeper's secret disagree.
    // That is a configuration error: it will never fix itself, and its only symptom is every avatar
    // quietly missing. So it is the one failure in this module that earns a log line — every other
    // failure here is transient and deliberately silent.
    //
    // It still fails closed. A token the keeper refused is not a reason to start trusting a list we
    // never read.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const clock = { t: 1000 };
      const { fn } = fetcher([{ status: 401 }]);
      const list = await new HouseListCache(deps(fn, clock)).get();
      expect(list.unknown).toBe(true);
      expect(list.wallets.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("401");
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to the last good list when a 401 arrives on a WARM cache", async () => {
    // A token rotated on the keeper but not yet on Vercel. The list itself is still true — the set
    // of house wallets changes on the order of never — so blanking the leaderboard over a
    // credential mismatch would be a second failure caused by the first. Same stale-at-any-age rule
    // as a timeout, because from this module's side it is the same situation: no fresh answer.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const clock = { t: 1000 };
      const { fn } = fetcher([{ body: rosterBody([wallet(1)]) }, { status: 401 }]);
      const cache = new HouseListCache(deps(fn, clock));
      await cache.get();

      clock.t += 61;
      const stale = await cache.get();
      expect(stale.unknown).toBe(false);
      expect(stale.wallets).toEqual(new Set([wallet(1)]));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("recovers on the next refresh after the keeper comes back", async () => {
    const clock = { t: 1000 };
    const { fn } = fetcher([{ throws: true }, { body: rosterBody([wallet(2)]) }]);
    const cache = new HouseListCache(deps(fn, clock));
    expect((await cache.get()).unknown).toBe(true);
    clock.t += 61;
    const back = await cache.get();
    expect(back.unknown).toBe(false);
    expect(back.wallets).toEqual(new Set([wallet(2)]));
  });
});
