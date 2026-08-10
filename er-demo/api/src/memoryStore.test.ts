// The in-memory store is what every other test in this directory runs against, so its own fidelity
// is load-bearing: a fake that is MORE PERMISSIVE than the real thing is a fake that lets a bug
// through the gate and into production. These tests pin the four behaviours where a shortcut would
// have been easiest and the consequence largest.

import { describe, expect, it } from "vitest";
import { MemoryLinkStore } from "./memoryStore.ts";
import { wallet } from "./testKit.ts";

describe("MemoryLinkStore enforces what Postgres enforces", () => {
  it("refuses a second row for one x_id", () => {
    // The PRIMARY KEY. A test that could seed two rows for one X account would be a test of a world
    // the database refuses to represent.
    const s = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "a" });
    expect(() => s.seed({ xId: "1", wallet: wallet(2), handle: "b" })).toThrow(/x_id/);
  });

  it("refuses a second row for one wallet", () => {
    // The UNIQUE constraint in the other direction — the one that makes "one X account on two
    // fighters" unrepresentable.
    const s = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "a" });
    expect(() => s.seed({ xId: "2", wallet: wallet(1), handle: "b" })).toThrow(/wallet/);
  });

  it("filters suppressed rows in the store, not in the caller", async () => {
    const s = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "a", suppressed: true });
    expect(await s.findByWallets([wallet(1)])).toEqual([]);
    expect(await s.findAvatar("1", "x")).toBeNull();
  });

  it("still shows a suppressed row to the ingest, which must see it to refuse it", async () => {
    // Otherwise the ingest goes on fetching pictures for accounts an operator has already taken
    // down.
    const s = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "a", suppressed: true });
    expect(await s.findForIngest("1")).toMatchObject({ xId: "1", suppressed: true });
  });

  it("starts a fresh link with no avatar, because that is the state a fresh link is in", async () => {
    const s = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "a" });
    expect((await s.findByWallets([wallet(1)]))[0].avatarHash).toBeNull();
  });

  it("requires an exact hash match, and moves hash and bytes together", async () => {
    const s = new MemoryLinkStore().seed({ xId: "1", wallet: wallet(1), handle: "a" });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await s.putAvatar("1", "hh", bytes, 10)).toBe(true);
    expect(await s.findAvatar("1", "hh")).toEqual({ bytes });
    expect(await s.findAvatar("1", "HH")).toBeNull();
    expect(await s.findAvatar("1", "other")).toBeNull();
    expect((await s.findByWallets([wallet(1)]))[0].avatarHash).toBe("hh");
  });

  it("will not create a row from an ingest", async () => {
    // No upsert. Only the ceremony creates links.
    const s = new MemoryLinkStore();
    expect(await s.putAvatar("nope", "hh", new Uint8Array([1]), 1)).toBe(false);
    expect(await s.findForIngest("nope")).toBeNull();
  });

  it("reports a missing x_id from the kill switch instead of pretending", async () => {
    const s = new MemoryLinkStore();
    expect(await s.setSuppressed("nope", true)).toBe(false);
  });
});
