// The avatar proxy, which is mostly a list of things it refuses to do.
//
// The single property worth the most here: THERE IS NO INPUT THAT MAKES IT FETCH ANYTHING. The tests
// below pass no `fetch` at all — the handler's dependency list has no room for one — so "could this
// be pointed at an internal host" is a question with no code to ask it of.

import { describe, expect, it } from "vitest";
import { avatarPathFor } from "../../src/v2/data/xLink.ts";
import { handleAvatar } from "./avatarHandler.ts";
import { MemoryLinkStore } from "./memoryStore.ts";
import { hash } from "./testKit.ts";
import { wallet } from "./testKit.ts";

const ORIGIN = "https://bullsvsunicorns.fun";
const H = hash("bytes");
const PIXELS = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

async function linkedStore(): Promise<MemoryLinkStore> {
  const store = new MemoryLinkStore().seed({ xId: "1234567890", wallet: wallet(1), handle: "alice" });
  await store.putAvatar("1234567890", H, PIXELS, 1_800_000_000);
  return store;
}

const get = (path: string): Request => new Request(`${ORIGIN}${path}`);

describe("GET /api/avatar/<x_id>/<hash>.webp", () => {
  it("serves the stored bytes for a linked account at the right hash", async () => {
    const store = await linkedStore();
    const res = await handleAvatar(get(avatarPathFor("1234567890", H)), { store });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PIXELS);
  });

  it("asserts the content type rather than echoing anything from upstream", async () => {
    // The bytes were produced by our own re-encode, so this is the only thing they can be. Combined
    // with `X-Content-Type-Options: nosniff` (applied to every path in `vercel.json`), a browser has
    // no route to treating them as anything else.
    const store = await linkedStore();
    const res = await handleAvatar(get(avatarPathFor("1234567890", H)), { store });
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Content-Length")).toBe(String(PIXELS.byteLength));
  });

  it("caches for 24 hours rather than immutably, so a revocation is bounded", async () => {
    // §6.2. By content hash this URL is immutable in the strict sense and everything argues for a
    // year — except that the bytes are a person's face and the UI promises "may persist for up to 24
    // hours". A year-long cache would make that sentence a lie with no way to make it true again.
    const store = await linkedStore();
    const res = await handleAvatar(get(avatarPathFor("1234567890", H)), { store });
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400, stale-while-revalidate=604800");
    expect(res.headers.get("Cache-Control")).not.toContain("immutable");
    expect(res.headers.get("ETag")).toBe(`"${H}"`);
  });

  it("404s on a hash mismatch", async () => {
    // NOT "here is the current picture". This URL is cached by content hash; serving different bytes
    // under one hash is how a CDN poisons itself, and it is also how a revoked picture comes back.
    const store = await linkedStore();
    const res = await handleAvatar(get(avatarPathFor("1234567890", hash("different"))), { store });
    expect(res.status).toBe(404);
  });

  it("404s for an unknown x_id", async () => {
    const store = await linkedStore();
    expect((await handleAvatar(get(avatarPathFor("999", H)), { store })).status).toBe(404);
  });

  it("404s for a linked account whose avatar has never been ingested", async () => {
    // §7.3's "linked + avatar in flight". `/api/links` will not have emitted a path for this row, so
    // nothing should be asking — but if something does, the answer is the same 404 as every other
    // refusal.
    const store = new MemoryLinkStore().seed({ xId: "77", wallet: wallet(2), handle: "bob" });
    expect((await handleAvatar(get(avatarPathFor("77", H)), { store })).status).toBe(404);
  });

  it("404s once the operator throws the kill switch, and serves again when it is cleared", async () => {
    // §7.4, on the second of the two read paths. `/api/links` dropping the row is what makes
    // suppression immediate; this is what makes it complete.
    const store = await linkedStore();
    const path = avatarPathFor("1234567890", H);
    expect((await handleAvatar(get(path), { store })).status).toBe(200);
    await store.setSuppressed("1234567890", true);
    expect((await handleAvatar(get(path), { store })).status).toBe(404);
    await store.setSuppressed("1234567890", false);
    expect((await handleAvatar(get(path), { store })).status).toBe(200);
  });

  it("404s for a reserved fixture x_id even when a row somehow exists for it", async () => {
    // Belt and braces against the `?links=mock` ids, which ship real static images at this exact
    // path shape. The register should never contain one; if it does, this route still will not serve
    // it.
    const store = new MemoryLinkStore().seed({ xId: "9990000000000001", wallet: wallet(3), handle: "mock_kestrel" });
    await store.putAvatar("9990000000000001", H, PIXELS, 1);
    const res = await handleAvatar(get(avatarPathFor("9990000000000001", H)), {
      store,
      reservedXIds: new Set(["9990000000000001"]),
    });
    expect(res.status).toBe(404);
  });

  it("does not cache a 404", async () => {
    // A 404 today is usually "not ingested yet". Cached for a day, it would outlive the ingest and
    // hold the flat disc in place long after the picture was ready.
    const store = await linkedStore();
    const res = await handleAvatar(get(avatarPathFor("999", H)), { store });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses every path shape that is not exactly the route", async () => {
    // The path IS the input validation. Note what is rejected that "starts with /api/avatar/" would
    // not: traversal, an uppercase hash (the hash is lowercase hex by definition, and accepting both
    // cases would give one picture two cache keys), a wrong extension, and a missing segment.
    const store = await linkedStore();
    for (const bad of [
      `/api/avatar/1234567890/${H}.png`,
      `/api/avatar/1234567890/${H}`,
      `/api/avatar/1234567890/${H.toUpperCase()}.webp`,
      `/api/avatar/1234567890/../${H}.webp`,
      `/api/avatar/${H}.webp`,
      `/api/avatar/12a34/${H}.webp`,
      `/api/avatar//${H}.webp`,
      `/api/avatar/1234567890/${H}.webp/extra`,
    ]) {
      expect((await handleAvatar(get(bad), { store })).status, bad).toBe(404);
    }
  });

  it("refuses a write method", async () => {
    const store = await linkedStore();
    const res = await handleAvatar(
      new Request(`${ORIGIN}${avatarPathFor("1234567890", H)}`, { method: "DELETE" }),
      { store },
    );
    expect(res.status).toBe(405);
  });

  it("reads the route from the pathname, not from an injected query parameter", async () => {
    // Prevents this handler's correctness depending on an undocumented detail of one host's router.
    // A query parameter claiming a different account must change nothing.
    const store = await linkedStore();
    const res = await handleAvatar(
      get(`${avatarPathFor("1234567890", H)}?xId=999&hash=${hash("other")}`),
      { store },
    );
    expect(res.status).toBe(200);
  });
});

describe("the route shape agrees with the client's verifier", () => {
  it("serves exactly what avatarPathFor builds", async () => {
    // `xLink.ts` validates `avatarPath` against an anchored regex and rejects a correctly-signed
    // record whose path is any other shape. If this route and that regex drift, every avatar is
    // rejected client-side and the failure is invisible — the flat disc, again.
    const store = await linkedStore();
    const built = avatarPathFor("1234567890", H);
    expect(built).toBe(`/api/avatar/1234567890/${H}.webp`);
    expect((await handleAvatar(get(built), { store })).status).toBe(200);
  });
});
