// THE WALK BACK THROUGH THE ROUND LOG, TESTED WITHOUT A CHAIN — which is the point of it being pure.
//
// Every case here is a shape of on-chain history the browser cannot be asked to produce on demand: a
// keeper that has closed everything it is allowed to, a keeper that is behind, a keeper that gave up
// on one round and left a hole in an otherwise contiguous prefix, an RPC that is failing some of the
// time. All four look identical from the outside — a page with rounds on it — and the way this scan
// gets them wrong is silent: history that simply isn't there, under a caption that doesn't say so.
//
// SO THE ASSERTIONS ARE ABOUT WHICH ROUND NUMBERS WERE REQUESTED, not only about what came back. "It
// stopped early" and "it truncated the log" produce the same `summaries` whenever the rounds past the
// stop were empty anyway; only the request log tells them apart.

import { describe, expect, it } from "vitest";
import { MIN_RETAINED_ROUNDS } from "../../chain/constants.ts";
import type { RoundSummary } from "../contract.ts";
import { BATCH, MAX_ROUNDS, STOP_AFTER_CONSECUTIVE_MISSES, scanRoundLog } from "./historyScan.ts";

/** The scan only ever asks one thing of a summary — whether there is one — so this carries nothing
 *  but the round number that identifies it. */
function summary(roundNo: bigint): RoundSummary {
  return {
    roundNo,
    phase: "Settled",
    winner: 0,
    pot: 0n,
    fighterCount: 0,
    tickCount: 0n,
    penaltiesCollected: 0n,
    feesCollected: 0n,
    players: [],
  };
}

interface Chain {
  read(roundNo: bigint): Promise<RoundSummary | null>;
  /** Every round number requested, in the order it was requested. */
  requested: bigint[];
}

/** An arena whose round accounts are decided by `state`: a summary, `null` for an account that never
 *  existed or whose rent has been reclaimed, or a thrown Error for a read that failed. */
function chainWhere(state: (roundNo: bigint) => "live" | "gone" | "throws"): Chain {
  const requested: bigint[] = [];
  return {
    requested,
    read: async (roundNo) => {
      requested.push(roundNo);
      const at = state(roundNo);
      if (at === "throws") throw new Error(`429 on round ${roundNo}`);
      return at === "live" ? summary(roundNo) : null;
    },
  };
}

const never = () => false;

/** The oldest round number the chain still guarantees is fetchable, for an arena at `newest`. */
function guaranteedFloor(newest: bigint): bigint {
  return newest - BigInt(MIN_RETAINED_ROUNDS) + 1n;
}

describe("scanRoundLog", () => {
  it("stops a handful past the last live round rather than walking to MAX_ROUNDS", async () => {
    // The state a caught-up keeper leaves behind: rounds 81..100 live (the retention window), every
    // older account reclaimed. The old scan read 250; this must read barely more than the window.
    const newest = 100n;
    const chain = chainWhere((n) => (n >= guaranteedFloor(newest) ? "live" : "gone"));

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(scan.summaries).toHaveLength(MIN_RETAINED_ROUNDS);
    expect(chain.requested.length).toBeLessThanOrEqual(
      MIN_RETAINED_ROUNDS + STOP_AFTER_CONSECUTIVE_MISSES + BATCH - 1,
    );
    expect(chain.requested.length).toBeLessThan(MAX_ROUNDS);
    expect(scan.firstError).toBeNull();
  });

  it("reads past an isolated hole rather than truncating the log at it", async () => {
    // The keeper skips a round it has failed to close CLOSE_ATTEMPTS_PER_ROUND times, so a reclaimed
    // range is a contiguous prefix in practice and not by guarantee. An exit on the first miss would
    // cut every round below this one out of the log.
    const newest = 100n;
    const hole = 60n;
    const chain = chainWhere((n) => (n === hole ? "gone" : "live"));

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(scan.summaries.map((s) => s.roundNo)).toContain(hole - 1n);
    expect(scan.summaries).toHaveLength(Number(newest) - 1);
  });

  it("stops once it has seen STOP_AFTER_CONSECUTIVE_MISSES absences in a row", async () => {
    const newest = 100n;
    const lastLive = 50n;
    const chain = chainWhere((n) => (n > lastLive ? "live" : "gone"));

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(scan.summaries).toHaveLength(Number(newest - lastLive));
    const oldestRequested = chain.requested[chain.requested.length - 1];
    expect(oldestRequested).toBeGreaterThan(lastLive - BigInt(STOP_AFTER_CONSECUTIVE_MISSES + BATCH));
  });

  it("treats a read that threw as evidence of nothing and keeps walking past it", async () => {
    // A rejection is not an absence. If it counted toward the run, a rate-limited RPC would end the
    // scan early and the page would show a truncated log with no error on it at all.
    const newest = 100n;
    const flaky = new Set([70n, 69n, 68n, 67n, 66n]);
    const chain = chainWhere((n) => (flaky.has(n) ? "throws" : "live"));

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(chain.requested).toHaveLength(Number(newest));
    expect(scan.summaries).toHaveLength(Number(newest) - flaky.size);
    expect(scan.firstError).toContain("429");
  });

  it("reports the first error and no summaries when every read fails", async () => {
    const chain = chainWhere(() => "throws");

    const scan = await scanRoundLog({ newest: 100n, read: chain.read, cancelled: never });

    expect(scan.summaries).toHaveLength(0);
    expect(scan.succeeded).toBe(0);
    expect(scan.firstError).toContain("429 on round 100");
  });

  it("keeps the rounds that arrived when only some reads fail, and the caller's total-failure rule stays false", async () => {
    const newest = 40n;
    const chain = chainWhere((n) => (n % 2n === 0n ? "throws" : "live"));

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(scan.summaries).toHaveLength(Number(newest) / 2);
    expect(scan.succeeded).toBeGreaterThan(0);   // `succeeded === 0` is the only thing that banners
    expect(scan.firstError).not.toBeNull();
  });

  it("never stops inside the chain's retention window, even if every round in it is missing", async () => {
    // `close_round_account` refuses to touch the newest MIN_RETAINED_ROUNDS rounds, so a null in
    // there is an anomaly rather than the end of history — and an anomaly must not be able to hide
    // the real rounds underneath it.
    const newest = 100n;
    const floor = guaranteedFloor(newest);
    const chain = chainWhere((n) => (n >= floor ? "gone" : "live"));

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(chain.requested).toContain(floor - 1n);
    expect(scan.summaries).toHaveLength(Number(floor) - 1);
  });

  it("caps a long arena at MAX_ROUNDS when nothing has been reclaimed at all", async () => {
    // A keeper that has never run leaves every round readable, so the run-of-misses rule never fires
    // and the cap is the only thing bounding the page load.
    const newest = 5_000n;
    const chain = chainWhere(() => "live");

    const scan = await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(chain.requested).toHaveLength(MAX_ROUNDS);
    expect(scan.summaries).toHaveLength(MAX_ROUNDS);
    expect(scan.summaries[0]?.roundNo).toBe(newest);
    expect(scan.summaries[MAX_ROUNDS - 1]?.roundNo).toBe(newest - BigInt(MAX_ROUNDS) + 1n);
  });

  it("stops between batches once cancelled, so a superseded fetch stops paying for reads", async () => {
    const chain = chainWhere(() => "live");
    let done = false;

    const scan = await scanRoundLog({
      newest: 5_000n,
      read: chain.read,
      cancelled: () => {
        const cancelled = done;
        done = true;   // let exactly the first batch through, then cancel
        return cancelled;
      },
    });

    expect(chain.requested).toHaveLength(BATCH);
    expect(scan.summaries).toHaveLength(BATCH);
  });

  it("reads an arena shorter than the retention window down to round 1 and no further", async () => {
    const newest = 5n;
    const chain = chainWhere(() => "live");

    await scanRoundLog({ newest, read: chain.read, cancelled: never });

    expect(chain.requested).toEqual([5n, 4n, 3n, 2n, 1n]);
  });

  it("reads exactly round 1 on a one-round arena", async () => {
    const chain = chainWhere(() => "live");

    const scan = await scanRoundLog({ newest: 1n, read: chain.read, cancelled: never });

    expect(chain.requested).toEqual([1n]);
    expect(scan.summaries.map((s) => s.roundNo)).toEqual([1n]);
  });
});
