// THE TWO DECISIONS `useLinks.ts` MAKES THAT ARE NOT REACT — what we ask about, and what comes back.
//
// The hook itself is not exercised here. This project has no React harness (vitest, oxlint and
// typescript are the entire devDependency list), which is why the two functions below are exported at
// all — the same arrangement `useActions.ts` and `useAutoDeploy.ts` already use, and for the same
// reason: a decision left inside a `useMemo` is a decision nothing can ever assert.
//
// WHAT `rosterKey` IS FOR, and it is not tidiness. `LiveRound` is rebuilt on every poll and every
// 250ms clock tick, so `live.fighters` is a fresh array four times a second even when nothing about
// it moved. An effect keyed on that array re-fetches four times a second, forever, against a service
// whose whole job is to be unnoticeable. Keyed on the sorted join it fetches when the ROSTER changes.
// Two properties carry that: the sort (same players in a different order is the same key) and the
// non-mutation (it is handed an array derived from `live.fighters`, and `.sort()` applied in place
// would reorder the roster the canvas draws — where positional ids name the parties in every hit).
//
// WHAT `fetchLinks` IS FOR. It holds the ONE place the mock and production diverge, and a divergence
// nothing can test is where two things quietly stop agreeing. The load-bearing case is the reverse of
// the one you would write first: not "does the mock branch sign" but **does the api branch leave the
// body alone**. A future edit that signed on the api path would mint records the client then trusts —
// it would take the server's inability to invent a link (`TWITTER-CONNECT.md` §5, the entire property
// this feature buys) and hand it back. So the api branch is pinned by object identity.
//
// And the shape of "nothing to ask about" is pinned too, because it is not `null`: `linkMapFrom` reads
// null as a malformed response and warns about it, and "there was nobody on screen" is an answer, not
// a fault.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLinks, rosterKey } from "./useLinks.ts";
import { trustedKeysFor } from "./linkSource.ts";
import { linkMapFrom, MAX_WALLETS_PER_QUERY } from "./xLink.ts";

/** Base58, 44 characters, distinct per index — the alphabet excludes `0`, `O`, `I` and `l`, and
 *  `verifyAttestation` enforces it. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const walletAt = (i: number) =>
  `Wa11et${B58[Math.floor(i / 58) % 58]}${B58[i % 58]}`.padEnd(44, "q");
const roster = (n: number) => Array.from({ length: n }, (_, i) => walletAt(i));

/** A deterministic shuffle, so "the same players in a different order" is a different order every
 *  time this file is read and never accidentally the same one. */
function shuffled(items: readonly string[]): string[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const FIXTURE = {
  identities: [
    {
      xId: "9990000000000001",
      handle: "mock_kestrel",
      displayName: "Kestrel",
      avatarHash: "a".repeat(64),
    },
    {
      xId: "9990000000000002",
      handle: "mock_otter",
      displayName: "Otter",
      avatarHash: "b".repeat(64),
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What `fetchLinks` hands to `fetch` — declared, so a test can read back the URL and the signal
 *  rather than indexing into an untyped call record. */
type FetchInit = { readonly signal: AbortSignal };

/** Stand in for `fetch`, answering with one body. Returns the spy so a test can ask what was asked. */
function stubFetch(body: unknown, ok = true, status = 200) {
  const spy = vi.fn(async (_url: string, _init: FetchInit) => ({
    ok,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** A fetch whose body is not JSON at all — a proxy's HTML error page, a truncated file. */
function stubUnparseableFetch() {
  const spy = vi.fn(async (_url: string, _init: FetchInit) => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const signal = () => new AbortController().signal;

describe("rosterKey", () => {
  it("answers the same thing for the same players in a different order", () => {
    // THE RE-FETCH GUARD. `/api/links` does not care about order and several views re-sort the
    // roster, so an order-sensitive key would refetch the whole board every time a view changed the
    // sort — and, worse, would do it while the round was running.
    const wallets = roster(20);
    expect(rosterKey(shuffled(wallets))).toEqual(rosterKey(wallets));
    // The hook keys its effect on the JOIN of this, which is the value that actually has to match.
    expect(rosterKey(shuffled(wallets)).join(",")).toBe(rosterKey(wallets).join(","));
  });

  it("does not touch the array it was handed", () => {
    // `.sort()` sorts IN PLACE. Applied to the caller's array this would reorder a list derived from
    // `live.fighters` — where the hit stream names its parties by index — so a mis-sorted roster
    // would silently repoint every hit in the fight. The bug would be in the canvas, and the cause
    // would be in the identity feed.
    const wallets = shuffled(roster(20));
    const before = [...wallets];
    rosterKey(wallets);
    expect(wallets).toEqual(before);
  });

  it("caps the query at what the server will answer", () => {
    // A full round is 48 fighters plus the asker, comfortably inside the cap. If that stopped being
    // true, an over-long query would be rejected WHOLESALE and every player on the board would render
    // unlinked — so truncating trades a few missing faces for not losing all of them at once.
    const asked = rosterKey(roster(200));
    expect(asked.length).toBe(MAX_WALLETS_PER_QUERY);
  });

  it("keeps the wallets the CALLER asked for first, not the ones that sort lowest", () => {
    // DEDUPE, THEN SLICE IN CALLER ORDER, THEN SORT — and the middle step is the one with a decision
    // in it. The caller hands these over in priority order: the fighters in the round on screen, then
    // the connected player, then the leaderboard's rows. Sorting before slicing would hand the
    // available slots to whoever sorts lowest in base58, which is a meaningless criterion — it would
    // drop fighters who are on the board right now in favour of arbitrary past players, and the
    // feature's whole point is the faces in the current fight.
    //
    // The sort still happens, last, so the KEY is stable; it just no longer decides membership.
    const wallets = roster(200);
    const expected = [...wallets].slice(0, MAX_WALLETS_PER_QUERY).sort();
    expect(rosterKey(wallets)).toEqual(expected);
  });

  it("truncates stably, so faces do not blink in and out between polls", () => {
    // The risk the caller-order slice introduces, pinned: if the caller's order were unstable the
    // truncated set would reshuffle every poll and the tail of the board would flicker. The caller's
    // order IS stable (a round's fighter list is entry order; standings move slowly), so the same
    // input must always produce the same members — and re-asking with the same list must not churn.
    const wallets = roster(200);
    expect(rosterKey(wallets)).toEqual(rosterKey(wallets));
    // A different ORDER is a different request by design — that is what caller priority means — so
    // this asserts what is actually guaranteed: same order in, same members out.
    expect(rosterKey([...wallets])).toEqual(rosterKey(wallets));
  });

  it("dedupes before it counts, so a repeated wallet cannot cost somebody else a slot", () => {
    // The connected player is appended to the round's roster and is usually already in it. Without
    // the dedupe that duplicate would occupy one of the capped slots, silently costing the last
    // fighter their face.
    const wallets = roster(10);
    expect(rosterKey([...wallets, wallets[0], wallets[1]])).toEqual([...wallets].sort());
  });

  it("keeps every wallet at exactly the cap", () => {
    // The off-by-one: a `slice(0, MAX - 1)` or a `< MAX` guard would drop the last fighter of a room
    // that exactly fits, which is the hardest kind of missing face to notice.
    const wallets = roster(MAX_WALLETS_PER_QUERY);
    expect(rosterKey(wallets).length).toBe(MAX_WALLETS_PER_QUERY);
    expect(rosterKey(wallets)).toEqual([...wallets].sort());
  });

  it("answers empty for an empty round", () => {
    // The hook treats the empty join as "do not fetch at all", so this is the value that keeps a page
    // with no round from asking a server about nobody.
    expect(rosterKey([])).toEqual([]);
    expect(rosterKey([]).join(",")).toBe("");
  });
});

describe("fetchLinks when there is nobody to ask about", () => {
  it("makes no request at all when the feature is off", async () => {
    // `?links=off` is the default for every visitor. It must cost zero requests — not one that is
    // fetched and discarded, and not one that tells a server which wallets are on somebody's screen.
    const spy = stubFetch({ links: [] });
    await expect(fetchLinks("off", roster(4), walletAt(0), signal())).resolves.toEqual({ links: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("makes no request when the roster is empty", async () => {
    // There is no enumeration route (§6.4): the wallet list IS the query, so an empty list is not
    // "ask about everyone".
    const spy = stubFetch({ links: [] });
    await expect(fetchLinks("api", [], null, signal())).resolves.toEqual({ links: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers with an empty body rather than null, so nothing logs it as malformed", async () => {
    // The reason the shape is `{ links: [] }`. `linkMapFrom(null)` reports `malformed` and the hook
    // warns on it — so a null here would put "1 record(s) not shown: malformed" in the console of
    // every page that has no round yet, on every poll, describing a fault that did not happen.
    for (const body of [
      await fetchLinks("off", roster(4), null, signal()),
      await fetchLinks("api", [], null, signal()),
    ]) {
      const { links, rejected } = linkMapFrom(body, trustedKeysFor("api"), 1_800_000_000);
      expect(rejected).toEqual([]);
      expect(links.size).toBe(0);
    }
  });
});

describe("fetchLinks on the api path", () => {
  it("returns the parsed body untouched", () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE, and it is an assertion about what does NOT happen.
    // `TWITTER-CONNECT.md` §5's whole property is that a compromised API cannot invent a link — it
    // can withhold one, it cannot forge one — and that property holds only while the client signs
    // nothing on this path. An edit that reached for `mockAttestations` here (to "make api work like
    // mock", to fill a gap during a backend outage) would mint records the client then verifies
    // against its own key and trusts completely. Object identity is the cheapest way to pin it:
    // whatever came back is the body itself, not something rebuilt from it.
    const body = { links: [{ wallet: "not even verified", handle: "someone" }] };
    stubFetch(body);
    return expect(fetchLinks("api", roster(3), null, signal())).resolves.toBe(body);
  });

  it("asks the endpoint for exactly the wallets it was given", async () => {
    const spy = stubFetch({ links: [] });
    const wallets = [walletAt(1), walletAt(2)];
    await fetchLinks("api", wallets, null, signal());
    expect(spy).toHaveBeenCalledTimes(1);
    const [url] = spy.mock.calls[0];
    expect(new URL(url, "https://arena.example").searchParams.get("wallets")).toBe(wallets.join(","));
  });

  it("gives the request a deadline of its own rather than the caller's bare signal", async () => {
    // `fetch` has no default timeout. A server that accepts the connection and never answers — a
    // stalled edge node, a captive portal, a phone changing networks — leaves the await pending for
    // the lifetime of the tab, and the retry is scheduled AFTER that await, so nothing reschedules:
    // the refresh loop stops forever, silently. That is worse here than an ordinary hang because
    // `REFRESH_MS` is the REVOCATION delay — a player who unlinks keeps their face on every stalled
    // tab until the attestation expires, seven days instead of about a minute.
    //
    // NOT ASSERTED HERE, and said plainly rather than faked: that the deadline actually fires at its
    // ten seconds. The constant is module-private, and `AbortSignal.timeout` is driven by Node's
    // internal timers rather than the global `setTimeout` that vitest's fake timers replace — so the
    // only honest versions are a ten-second unit test or a fake-timer test that passes without
    // proving anything. What is provable is that a deadline was composed in at all, which is the part
    // an edit would delete.
    const spy = stubFetch({ links: [] });
    const s = signal();
    await fetchLinks("api", roster(3), null, s);
    const [, init] = spy.mock.calls[0];
    expect(init.signal).not.toBe(s);
    expect(init.signal.aborted).toBe(false);
  });

  it("still lets the caller's abort stop the request through that deadline", async () => {
    // The other half, and the one composing a signal could silently break: the caller's abort is what
    // stops a poll for a roster that has already changed from landing on top of a fresh map — a face
    // from the previous round, on the wrong board. A deadline that REPLACED the caller's signal
    // instead of joining it would leave every superseded poll running to completion.
    let captured: AbortSignal | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: FetchInit) => {
        captured = init.signal;
        await new Promise(() => {}); // a server that accepts and never answers
      }),
    );
    const controller = new AbortController();
    void fetchLinks("api", roster(3), null, controller.signal);
    await Promise.resolve();
    expect(captured).not.toBeNull();
    expect((captured as unknown as AbortSignal).aborted).toBe(false);
    controller.abort();
    expect((captured as unknown as AbortSignal).aborted).toBe(true);
  });

  it("throws on a response that is not ok", async () => {
    // So the caller's `catch` runs. That branch deliberately does NOT clear the map: the records it
    // already holds are self-certifying and inside their seven days, and they did not become less
    // true because a fetch failed. A `fetchLinks` that swallowed a 503 and returned an empty body
    // would strip every face on the board on the first hiccup — withholding is the API's only power
    // and there is no reason to help it.
    stubFetch({ links: [] }, false, 503);
    await expect(fetchLinks("api", roster(3), null, signal())).rejects.toThrow("503");
  });

  it("throws rather than half-answering when the body is not JSON", async () => {
    // A proxy's HTML error page, a truncated response. Same destination: the caller catches, the
    // board renders unlinked, nothing on screen says anything.
    stubUnparseableFetch();
    await expect(fetchLinks("api", roster(3), null, signal())).rejects.toThrow(SyntaxError);
  });
});

describe("fetchLinks on the mock path", () => {
  const wallets = roster(24);
  const you = wallets[0];

  it("signs the fixture into records that verify through the real path", async () => {
    // THE COMPOSITION THIS SEAM EXISTS TO PIN. `parseMockFixture` -> `assignMockIdentities` ->
    // `signAttestation`, wrapped in the shape `linkMapFrom` expects. Each half is proven in
    // `mockLinks.test.ts`; what is proven here is that they are wired together, at the real current
    // time, into something the production verifier accepts. If this branch ever produced a shape
    // `linkMapFrom` reads as malformed, `?links=mock` would render an unlinked board — which is
    // exactly what a correctly-working unlinked board looks like, so nothing would report it.
    stubFetch(FIXTURE);
    const body = await fetchLinks("mock", wallets, you, signal());
    const { links, rejected } = linkMapFrom(
      body,
      trustedKeysFor("mock"),
      Math.floor(Date.now() / 1000),
    );
    expect(rejected).toEqual([]);
    expect(links.size).toBeGreaterThan(0);
    for (const record of links.values()) expect(record.handle).toMatch(/^mock_/);
  });

  it("reads the fixture from the static file, with no wallet list in the request", async () => {
    const spy = stubFetch(FIXTURE);
    await fetchLinks("mock", wallets, you, signal());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("/links.mock.json");
  });

  it("links the connected wallet, which is the whole point of the flag for a developer", async () => {
    // Also the cheapest check that `wallets` and `you` reached `assignMockIdentities` in their right
    // roles: `you` is the one wallet the rate check does not get a say over.
    stubFetch(FIXTURE);
    const body = await fetchLinks("mock", wallets, you, signal());
    const { links } = linkMapFrom(body, trustedKeysFor("mock"), Math.floor(Date.now() / 1000));
    expect(links.has(you)).toBe(true);
  });

  it("produces records the production key set refuses", async () => {
    // The mock key signs faces into the browser that asked for `?links=mock` and nowhere else. Its
    // seed is printed in `linkSource.ts`, so this is the line between "a fake face in your own tab"
    // and "any handle on any wallet on the live site".
    stubFetch(FIXTURE);
    const body = await fetchLinks("mock", wallets, you, signal());
    const { links, rejected } = linkMapFrom(body, trustedKeysFor("api"), Math.floor(Date.now() / 1000));
    expect(links.size).toBe(0);
    expect(new Set(rejected)).toEqual(new Set(["untrusted-key"]));
  });

  it("yields no links, rather than throwing, for a fixture that is not a fixture", async () => {
    // The file is hand-editable by design and lives in `public/`, so it can also be replaced by a 404
    // page or emptied by a bad regeneration. Every one of these is an answer of "nobody is linked",
    // which is the main path — never an exception thrown inside a poll.
    for (const body of [{}, null, [], "nonsense", 42, { identities: "not a list" }, { links: [] }]) {
      stubFetch(body);
      const out = await fetchLinks("mock", wallets, you, signal());
      expect(out, JSON.stringify(body) ?? "undefined").toEqual({ links: [] });
      const { links, rejected } = linkMapFrom(out, trustedKeysFor("mock"), Math.floor(Date.now() / 1000));
      expect(links.size).toBe(0);
      expect(rejected).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("throws when the fixture file is not JSON at all", async () => {
    // Stated separately from the case above because they are different paths and the peer request
    // that asked for this conflated them: a fixture that PARSES to the wrong shape is handled and
    // yields no links; a fixture with a syntax error rejects out of `res.json()` before this function
    // ever sees it. Both end at the same place for a player — everybody unlinked, nothing said — but
    // only the first is a value this function returns.
    stubUnparseableFetch();
    await expect(fetchLinks("mock", wallets, you, signal())).rejects.toThrow(SyntaxError);
  });
});
