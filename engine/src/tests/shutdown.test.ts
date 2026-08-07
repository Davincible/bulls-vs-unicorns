// SHUTDOWN ORDERING. persist() serialises the live ledger into the snapshot; flush() only writes
// whatever was already staged. The shutdown handler called refundOpenRounds() then flush() with no
// persist() between them, so every restart computed the refund correctly, applied it to the
// in-memory accounts, and then threw it away on exit — the stakes came back to nobody.
//
// It hid because no money is LOST: the coin never leaves the vault, so the ledger just stops
// claiming it and the rebalance re-credits the house from chain minutes later. That is the
// oscillation — claim collapsing on restart, then restored in one large correction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** Minimal model of the snapshot pipeline: a staging slot and a disk. */
function pipeline() {
  const live = { alice: 0 };
  let staged: any = null, disk: any = null;
  return {
    live,
    refund: (n: number) => { live.alice += n; },
    persist: () => { staged = { ...live }; },
    flush: () => { if (staged) disk = { ...staged }; },
    disk: () => disk,
  };
}

test("flush without persist loses the refund — the bug", () => {
  const p = pipeline();
  p.persist(); p.flush();          // a normal earlier save, alice at 0
  p.refund(19);                    // restart refunds an open stake
  p.flush();                       // shutdown: flush only, no persist
  assert.equal(p.live.alice, 19, "the refund did happen in memory");
  assert.equal(p.disk()!.alice, 0, "but the disk never saw it — that is the loss");
});

test("persist before flush keeps it — the fix", () => {
  const p = pipeline();
  p.persist(); p.flush();
  p.refund(19);
  p.persist(); p.flush();
  assert.equal(p.disk()!.alice, 19, "the refund survives the restart");
});

test("the loss is silent — nothing throws, the money just stops being claimed", () => {
  const p = pipeline();
  p.persist(); p.flush();
  p.refund(19);
  assert.doesNotThrow(() => p.flush());
  assert.notEqual(p.live.alice, p.disk()!.alice,
    "memory and disk disagree with no error raised — why this survived so long");
});

test("shutdown source order: refund, then persist, then flush", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const h = src.slice(src.indexOf('for (const sig of ["SIGINT", "SIGTERM"]'));
  const iRefund = h.indexOf("refundOpenRounds()");
  const iPersist = h.indexOf("persist()");
  const iFlush = h.indexOf("flush()");
  assert.ok(iRefund >= 0 && iPersist >= 0 && iFlush >= 0, "all three must be present");
  assert.ok(iRefund < iPersist, "refund must happen before the snapshot is staged");
  assert.ok(iPersist < iFlush, "the snapshot must be staged before it is written");
});
