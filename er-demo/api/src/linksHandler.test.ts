// `GET /api/links`, end to end, with no database and no network.
//
// Every assertion below is about a rule that has a person on the other end of it: a suppressed
// picture that must stop being served, an automated wallet that must not wear a face, a signature a
// browser must be able to check. All of them fail SILENTLY in production — the page renders as
// "nobody has linked", which is what it renders for most players anyway — so a test is the only
// place any of them can be observed going wrong.

import { describe, expect, it } from "vitest";
import { verifyAttestation, type LinksResponse } from "../../src/v2/data/xLink.ts";
import { handleLinks, type LinksDeps } from "./linksHandler.ts";
import { MemoryLinkStore } from "./memoryStore.ts";
import { houseSource, NOW, TEST_KEY, wallet } from "./testKit.ts";

const url = (wallets: string[]): string =>
  `https://bullsvsunicorns.fun/api/links?wallets=${wallets.join(",")}`;

function deps(store: MemoryLinkStore, over: Partial<LinksDeps> = {}): LinksDeps {
  return {
    store,
    key: TEST_KEY,
    house: houseSource([]),
    nowSec: () => NOW,
    ...over,
  };
}

async function body(res: Response): Promise<LinksResponse> {
  return (await res.json()) as LinksResponse;
}

describe("GET /api/links", () => {
  it("returns a signed row per linked wallet, and the client's verifier accepts it", () => {
    const store = new MemoryLinkStore()
      .seed({ xId: "1", wallet: wallet(1), handle: "alice", displayName: "Alice" })
      .seed({ xId: "2", wallet: wallet(2), handle: "bob" });

    return handleLinks(new Request(url([wallet(1), wallet(2)])), deps(store))
      .then(async (res) => {
        expect(res.status).toBe(200);
        const { links } = await body(res);
        expect(links).toHaveLength(2);
        for (const a of links) {
          expect(verifyAttestation(a, [TEST_KEY.publicKey], NOW).kind).toBe("ok");
        }
      });
  });

  it("omits wallets that are not linked rather than emitting 'no' rows", () => {
    // `LinksResponse` says so: there is nothing to sign about an absence, and a signed absence would
    // be a promise we cannot keep between polls.
    const store = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "alice" });
    return handleLinks(new Request(url([wallet(1), wallet(9)])), deps(store)).then(async (res) => {
      const { links } = await body(res);
      expect(links.map((l) => l.wallet)).toEqual([wallet(1)]);
    });
  });

  it("NEVER returns a suppressed row", async () => {
    // §7.4's kill switch, on the read path. "A moderation capability you have to build during the
    // incident is not a capability" — and one that exists but is not honoured is worse, because
    // somebody will believe it worked.
    const store = new MemoryLinkStore()
      .seed({ xId: "1", wallet: wallet(1), handle: "alice" })
      .seed({ xId: "2", wallet: wallet(2), handle: "troll", suppressed: true });

    const res = await handleLinks(new Request(url([wallet(1), wallet(2)])), deps(store));
    const { links } = await body(res);
    expect(links.map((l) => l.wallet)).toEqual([wallet(1)]);
  });

  it("stops returning a row the moment the kill switch is thrown", async () => {
    // Revocation is IMMEDIATE at the API (§6.2). The 30-second private cache header is the only
    // delay, and it is a browser's own copy.
    const store = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "alice" });
    expect((await body(await handleLinks(new Request(url([wallet(1)])), deps(store)))).links).toHaveLength(1);

    await store.setSuppressed("1", true);
    expect((await body(await handleLinks(new Request(url([wallet(1)])), deps(store)))).links).toHaveLength(0);

    // And it is reversible, which is what makes it a moderation tool rather than a delete.
    await store.setSuppressed("1", false);
    expect((await body(await handleLinks(new Request(url([wallet(1)])), deps(store)))).links).toHaveLength(1);
  });

  it("NEVER returns a wallet on the keeper's house list", async () => {
    // §6.3's hard rule: a house wallet wearing a person's face is an automated process
    // misrepresenting itself as a person, in a game about money.
    //
    // This comment used to add "not a privacy leak — the list is already printed on the
    // leaderboard". It is not printed anywhere any more: the house wallets are anonymous and the
    // list reaches this API only over an authenticated channel (see `houseWallets.ts`). The rule
    // this test pins is unchanged; the reason it is not ALSO a disclosure question is what changed.
    const store = new MemoryLinkStore()
      .seed({ xId: "1", wallet: wallet(1), handle: "alice" })
      .seed({ xId: "2", wallet: wallet(2), handle: "housebot" });

    const res = await handleLinks(
      new Request(url([wallet(1), wallet(2)])),
      deps(store, { house: houseSource([wallet(2)]) }),
    );
    const { links } = await body(res);
    expect(links.map((l) => l.wallet)).toEqual([wallet(1)]);
  });

  it("serves NOTHING when the house list cannot be read at all", async () => {
    // FAIL CLOSED. We cannot tell a house wallet from a player's, so we withhold — and the cost of
    // withholding is the ordinary rendering of this page. The header is for whoever is looking at an
    // incident; the player is told nothing, because there is nothing they could do.
    const store = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "alice" });
    const res = await handleLinks(
      new Request(url([wallet(1)])),
      deps(store, { house: houseSource([], true) }),
    );
    expect(res.status).toBe(200);
    // `X-XLink-Suppression`, not `X-XLink-House-List`: the header must tell an operator that rows
    // are being withheld without telling every reader of every response that a house list exists.
    expect(res.headers.get("X-XLink-Suppression")).toBe("unavailable");
    expect(res.headers.get("X-XLink-House-List")).toBeNull();
    expect((await body(res)).links).toEqual([]);
  });

  it("never mints an attestation for a reserved fixture x_id", async () => {
    // The `?links=mock` ids ship static images at the same path shape. An id that exists in both
    // worlds is an id where "this is a demo" and "this is a person" are the same string.
    const store = new MemoryLinkStore().seed({ xId: "9990000000000001", wallet: wallet(1), handle: "mock_kestrel" });
    const res = await handleLinks(
      new Request(url([wallet(1)])),
      deps(store, { reservedXIds: new Set(["9990000000000001"]) }),
    );
    expect((await body(res)).links).toEqual([]);
  });

  it("caches privately for 30 seconds and never in a shared cache", async () => {
    // `s-maxage` absent is the assertion that matters: a CDN entry would serve a revoked identity to
    // strangers, and would buy nothing, because the cache key is an arbitrary permutation of 48
    // wallets.
    const store = new MemoryLinkStore();
    const res = await handleLinks(new Request(url([wallet(1)])), deps(store));
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toBe("private, max-age=30");
    expect(cc).not.toContain("s-maxage");
    expect(cc).not.toContain("public");
  });

  it("rejects a request with no wallets parameter, and does not enumerate", async () => {
    // The route has no representation for "all". See `wallets.ts`.
    const store = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "alice" });
    const res = await handleLinks(new Request("https://bullsvsunicorns.fun/api/links"), deps(store));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(wallet(1));
  });

  it("rejects a wallet list that is too long or not base58", async () => {
    const store = new MemoryLinkStore();
    expect((await handleLinks(new Request(url(["nope"])), deps(store))).status).toBe(400);
    const many = Array.from({ length: 65 }, (_, i) => wallet(i + 1));
    expect((await handleLinks(new Request(url(many)), deps(store))).status).toBe(400);
  });

  it("does not become an oracle: a 400 says nothing about who is linked", async () => {
    // A refusal answers "is this request well-formed", never "is this wallet in the register".
    const store = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "alice" });
    const res = await handleLinks(new Request(url(["nope"])), deps(store));
    const text = await res.text();
    expect(text).not.toContain("alice");
    expect(text).not.toContain(wallet(1));
  });

  it("refuses a write method", async () => {
    // There is no write path on this route and there never will be — §4.1's ceremony is a different
    // endpoint with a wallet signature on it.
    const res = await handleLinks(
      new Request(url([wallet(1)]), { method: "POST" }),
      deps(new MemoryLinkStore()),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD");
  });

  it("signs one batch with one instant", async () => {
    // Prevents 48 attestations in one response carrying 48 different `issuedAt` values, which would
    // make the response non-deterministic and its expiries ragged for no reason.
    const store = new MemoryLinkStore()
      .seed({ xId: "1", wallet: wallet(1), handle: "alice" })
      .seed({ xId: "2", wallet: wallet(2), handle: "bob" });
    let ticks = 0;
    const res = await handleLinks(
      new Request(url([wallet(1), wallet(2)])),
      deps(store, { nowSec: () => NOW + ticks++ }),
    );
    const { links } = await body(res);
    expect(new Set(links.map((l) => l.issuedAt)).size).toBe(1);
  });
});
