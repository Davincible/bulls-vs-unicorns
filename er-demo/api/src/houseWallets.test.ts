import { describe, expect, it } from "vitest";
import { HouseListCache, houseWalletsFrom } from "./houseWallets.ts";
import { wallet } from "./testKit.ts";

const statusBody = (wallets: string[], extra: Record<string, unknown> = {}): unknown => ({
  schema: 4,
  house: { wallets, disclosure: "…" },
  ...extra,
});

function fetcher(steps: Array<{ body?: unknown; status?: number; throws?: boolean }>) {
  let i = 0;
  const calls = { n: 0 };
  const fn = (async () => {
    calls.n += 1;
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
  it("reads house.wallets without asserting the keeper's schema version", () => {
    // DELIBERATELY UNLIKE `keeperStatus.ts`, which demands an exact schema match. That module draws
    // a COUNTDOWN from the file, and a half-understood status becomes a confidently-wrong number in
    // front of a player. This one asks a single question and uses the answer only to WITHHOLD, so a
    // keeper that bumps its schema for an unrelated field still answers it correctly. Pinning the
    // version here would mean a keeper deploy silently removes every avatar on the site.
    expect(houseWalletsFrom(statusBody([wallet(1)], { schema: 99 }))).toEqual(new Set([wallet(1)]));
  });

  it("returns null — never a partial list — for anything it does not recognise", () => {
    // A partially-parsed deny list is a deny list with a hole in it, and the hole is invisible.
    for (const bad of [
      null,
      "a string",
      {},
      { house: null },
      { house: {} },
      { house: { wallets: "not-an-array" } },
      { house: { wallets: [wallet(1), 42] } },
      { house: { wallets: [wallet(1), ""] } },
    ]) {
      expect(houseWalletsFrom(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("distinguishes an empty published list from an unreadable one", () => {
    // A keeper that publishes zero house wallets is a fact. Not knowing is a different fact, and the
    // two must not collapse — one of them means "serve everything" and the other means "serve
    // nothing".
    expect(houseWalletsFrom(statusBody([]))).toEqual(new Set());
  });
});

describe("HouseListCache", () => {
  const deps = (fetch: typeof globalThis.fetch, clock: { t: number }) => ({
    url: "https://keeper.example/keeper-status.json",
    fetch,
    nowSec: () => clock.t,
  });

  it("fetches once and serves the cached list for 60 seconds", async () => {
    // Without this the keeper — a single machine by `fly.toml` rule 1 — takes one request per page
    // poll from every worker. That is a self-inflicted load test on the one process that must not
    // fall over.
    const clock = { t: 1000 };
    const { fn, calls } = fetcher([{ body: statusBody([wallet(1)]) }]);
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
    const { fn, calls } = fetcher([{ body: statusBody([wallet(1)]) }]);
    const cache = new HouseListCache(deps(fn, clock));
    await Promise.all([cache.get(), cache.get(), cache.get(), cache.get()]);
    expect(calls.n).toBe(1);
  });

  it("keeps serving the last good list at ANY age when the keeper goes away", async () => {
    // The set of house wallets changes on the order of never. A six-hour-old copy is a far better
    // answer than no answer, and returning "unknown" here would blank every avatar on the site for
    // one keeper hiccup.
    const clock = { t: 1000 };
    const { fn } = fetcher([{ body: statusBody([wallet(1)]) }, { throws: true }]);
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
    // There is nothing a caller could do differently for any of them.
    for (const step of [{ status: 500 }, { body: "not json" }, { body: { schema: 4 } }]) {
      const clock = { t: 1000 };
      const { fn } = fetcher([step]);
      expect((await new HouseListCache(deps(fn, clock)).get()).unknown).toBe(true);
    }
  });

  it("recovers on the next refresh after the keeper comes back", async () => {
    const clock = { t: 1000 };
    const { fn } = fetcher([{ throws: true }, { body: statusBody([wallet(2)]) }]);
    const cache = new HouseListCache(deps(fn, clock));
    expect((await cache.get()).unknown).toBe(true);
    clock.t += 61;
    const back = await cache.get();
    expect(back.unknown).toBe(false);
    expect(back.wallets).toEqual(new Set([wallet(2)]));
  });
});
