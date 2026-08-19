// WHERE THE CLOSE CURSOR STARTS — as properties, because the two ways to get this wrong are both
// silent and they are not the same size.
//
//   TOO HIGH   the cursor is put past a round that still exists. Nothing fails, nothing logs, and
//              that round's ~0.023497 SOL is never reclaimed and never reported — it simply stops
//              appearing in `/reclamation.json`'s stranded lists, which is the only place an operator
//              would ever learn of it. This is the expensive direction and most of the file is about
//              it.
//   TOO LOW    the cursor walks rounds it has already closed, one per pass. This is the DEFECT being
//              fixed rather than a new risk, so it costs only what it cost before — but "before" was
//              a published burn of 23.9M lamports/round against a healthy 420,000, a runway of 2.39
//              days against 128, and a brake that would stop a healthy arena if it ever armed on
//              those samples.
//
// The scan's whole safety argument is ONE INVARIANT: every round between `from` and the cursor it
// returns was OBSERVED ABSENT in a reply from the chain during this scan. Bounds, failures and
// degenerate inputs are all allowed to end the scan early; none of them is allowed to break that.
// Most tests below are that invariant asked in a different voice.

import { describe, expect, it } from "vitest";
import {
  CLOSE_CURSOR_PROBE_BATCH, findOldestLivingRound, probeIsWorthARead,
  type CloseCursorScanOptions,
} from "./closeCursor.ts";

/** The chain's retention window, written out rather than imported for the reason `reclamation.test.ts`
 *  gives about the constants it pins: a test that reads the same number the code reads asserts only
 *  that a constant equals itself. */
const RETENTION = 20;

/** THE LIVE ARENA OF 2026-08-19, which is the shape this whole mechanism was built against and the
 *  one a synthetic "first N rounds are closed" fixture would quietly not test.
 *
 *  `round_counter` 636, 612 rounds already closed, one genuinely stranded round at #295 (terminal but
 *  still owned by the Delegation Program), and the newest twenty inside the retention window. So the
 *  closed rounds are NOT a prefix: #295 is a hole with 294 closed rounds below it and 321 above. */
const LIVE_ROUND_COUNTER = 636n;
const LIVE_STRANDED = 295n;
const LIVE_THROUGH = LIVE_ROUND_COUNTER - BigInt(RETENTION); // 616 — the newest closeable round

/** An arena as a set of rounds whose accounts still exist, plus a probe that records how it was
 *  asked. The recording is not incidental: two of the properties below are about the SHAPE of the
 *  calls rather than the answer, and one of them is the rate-limit lesson `fundHouseBank` and the boot
 *  banner both learned by killing the process. */
function arena(existing: Iterable<bigint>) {
  const live = new Set(existing);
  const calls: bigint[][] = [];
  let inFlight = 0;
  let concurrent = false;
  let ms = 0;
  /** Milliseconds each probe consumes. Zero means the deadline can never bind. */
  let costMs = 0;
  return {
    calls,
    get concurrent() { return concurrent; },
    /** Every round the probe was ever asked about, in order, across all calls. */
    get asked(): bigint[] { return calls.flat(); },
    nowMs: () => ms,
    chargePerProbe(each: number) { costMs = each; },
    probe: async (roundNos: readonly bigint[]): Promise<readonly boolean[]> => {
      inFlight += 1;
      if (inFlight > 1) concurrent = true;
      calls.push([...roundNos]);
      await Promise.resolve();
      ms += costMs;
      inFlight -= 1;
      return roundNos.map((roundNo) => live.has(roundNo));
    },
  };
}

/** A range of round numbers, inclusive, as the fixtures want them. */
const range = (from: bigint, through: bigint): bigint[] => {
  const out: bigint[] = [];
  for (let n = from; n <= through; n += 1n) out.push(n);
  return out;
};

/** The scan with the bounds wide open, so a test that is not about a bound cannot accidentally be
 *  about one. Each test that IS about a bound narrows exactly the one it means. */
const scan = (over: Partial<CloseCursorScanOptions> & Pick<CloseCursorScanOptions, "probe" | "nowMs">) =>
  findOldestLivingRound({
    from: 1n,
    through: LIVE_THROUGH,
    budgetMs: Number.MAX_SAFE_INTEGER,
    maxBatches: Number.MAX_SAFE_INTEGER,
    ...over,
  });

describe("finding the oldest round that still exists", () => {
  it("lands on the stranded round the live arena actually had, not on the round after it", async () => {
    // THE CASE THE WHOLE DESIGN TURNS ON. #295 is terminal, still delegated, and 294 closed rounds
    // below it — so it is the oldest EXISTING round even though 612 rounds are closed. A cursor that
    // landed anywhere above it would never record it in `closer.stranded.stillDelegated`, and its
    // rent would stop being reclaimable on the day forced undelegation reaches this devnet
    // (COST-MODEL §4.3). This is the assertion that makes a bisection unimplementable here.
    const chain = arena([LIVE_STRANDED, ...range(617n, LIVE_ROUND_COUNTER)]);
    const found = await scan({ probe: chain.probe, nowMs: chain.nowMs });

    expect(found.cursor).toBe(LIVE_STRANDED);
    expect(found.stoppedBecause).toBe("found");
    expect(found.skipped).toBe(294);
    expect(found.catchUpAhead).toBe(false);
  });

  it("pays three reads for what used to cost 294 passes", async () => {
    // The number in the ticket. At a hundred rounds a read, #295 is inside the third window — and the
    // one-round-per-pass walk it replaces was measured on the live keeper at ~35 rounds a minute,
    // because `housekeepingIsWelcome` correctly yields to live fights. 294 passes is ~8 minutes of a
    // published 9.52 SOL/day on an arena spending 0.18.
    const chain = arena([LIVE_STRANDED, ...range(617n, LIVE_ROUND_COUNTER)]);
    const found = await scan({ probe: chain.probe, nowMs: chain.nowMs });

    expect(found.batches).toBe(3);
    expect(chain.calls.map((c) => c.length)).toEqual([100, 100, 100]);
    expect(chain.calls[0]![0]).toBe(1n);
    expect(chain.calls[2]![0]).toBe(201n);
  });

  it("stops at the first existing round in a window rather than the first in the reply", async () => {
    // An off-by-one here is invisible: both rounds are stranded, both would be reported, and only the
    // OLDER one's rent is at stake. `indexOf` on the window is the whole implementation; this is what
    // holds it.
    const chain = arena([248n, 250n, 251n]);
    const found = await scan({ probe: chain.probe, nowMs: chain.nowMs, batch: 10 });
    expect(found.cursor).toBe(248n);
  });

  it("never asks about a round outside [from, through]", async () => {
    // The upper bound is the RETENTION BOUNDARY, not `round_counter` — probing above it would find
    // the live round and hand back a cursor `isPastRetention` immediately refuses to act on. The
    // lower bound matters for the per-pass skip, which starts at the live cursor and must not walk
    // backwards over rounds already decided about.
    const chain = arena([]);
    await scan({ from: 200n, through: 355n, probe: chain.probe, nowMs: chain.nowMs });

    expect(chain.asked[0]).toBe(200n);
    expect(chain.asked.at(-1)).toBe(355n);
    expect(chain.asked.length).toBe(156);
    // The last window is SHORT, not padded up to a full batch — a padded one would ask about #356,
    // which is inside the retention window.
    expect(chain.calls.map((c) => c.length)).toEqual([100, 56]);
  });

  it("asks serially, never concurrently", async () => {
    // NOT A STYLE POINT. `Promise.all` over the batches would finish a long scan in one round trip's
    // wall clock and earn `429 Connection rate limits exceeded` from api.devnet.solana.com doing it —
    // the exact failure `fundHouseBank` records at 30 wallets and the boot banner records at 48, both
    // of which killed the process during boot before the HTTP server bound. Awaiting each read makes
    // the request rate the reciprocal of the round-trip time, so the limit is respected by
    // construction rather than by a semaphore somebody has to maintain.
    const chain = arena([1_000n]);
    await scan({ through: 1_000n, probe: chain.probe, nowMs: chain.nowMs });
    expect(chain.concurrent).toBe(false);
    expect(chain.calls.length).toBe(10);
  });

  it("never asks for more than the batch the RPC will accept", async () => {
    // `getMultipleAccounts` answers `-32602 Too many inputs provided` above 100, and
    // `chainClient.roundsExist` refuses a longer list rather than truncating it — so a chunker that
    // overshot would turn into a read failure naming nothing about round numbers. Swept across every
    // window rather than checked on the first, because the LAST window is the one built differently.
    const chain = arena([]);
    await scan({ through: 4_321n, probe: chain.probe, nowMs: chain.nowMs });
    for (const call of chain.calls) expect(call.length).toBeLessThanOrEqual(CLOSE_CURSOR_PROBE_BATCH);
  });
});

describe("an arena with nothing left to find", () => {
  it("reports an all-closed arena as caught up, one past the boundary", async () => {
    // Every round through the retention boundary is gone. There is nothing to drain and nothing was
    // skipped over unseen, so the cursor sits where `isPastRetention` will hold it until the arena
    // opens more rounds — and `catchUpAhead` is FALSE, because there is no unknown history in front
    // of a cursor that reached the end of the known history.
    const chain = arena([]);
    const found = await scan({ through: 250n, probe: chain.probe, nowMs: chain.nowMs });

    expect(found.cursor).toBe(251n);
    expect(found.stoppedBecause).toBe("caught-up");
    expect(found.skipped).toBe(250);
    expect(found.catchUpAhead).toBe(false);
  });

  it("reports an arena with no closeable round without touching the chain", async () => {
    // `round_counter` 0, or any arena younger than its own retention window: `through` comes out
    // below `from` and there is nothing to ask about. The cursor is #1 — the value that shipped —
    // and not a single read is spent establishing that a young arena is young.
    const chain = arena([]);
    const found = await findOldestLivingRound({
      from: 1n,
      through: 0n - BigInt(RETENTION),
      probe: chain.probe,
      nowMs: chain.nowMs,
      budgetMs: Number.MAX_SAFE_INTEGER,
      maxBatches: Number.MAX_SAFE_INTEGER,
    });

    expect(found.cursor).toBe(1n);
    expect(found.stoppedBecause).toBe("no-rounds");
    expect(found.batches).toBe(0);
    expect(chain.calls).toEqual([]);
    expect(found.catchUpAhead).toBe(false);
  });
});

describe("every way out keeps what the chain proved and invents nothing", () => {
  it("falls back to the round after the last one it PROVED was gone when a read is rejected", async () => {
    // The fail-safe, and the reason it is not a fallback to #1. Two windows came back all-absent
    // before the third was rejected, so 200 rounds are known closed and starting at #201 is correct
    // on exactly the same argument as a successful scan. Re-walking them would be a hundred passes
    // spent re-learning something the chain already said.
    let call = 0;
    const chain = arena([]);
    const boom = new Error("429 Connection rate limits exceeded");
    const found = await scan({
      nowMs: chain.nowMs,
      probe: async (roundNos) => {
        call += 1;
        if (call === 3) throw boom;
        return chain.probe(roundNos);
      },
    });

    expect(found.cursor).toBe(201n);
    expect(found.stoppedBecause).toBe("failed");
    expect(found.error).toBe(boom);
    expect(found.catchUpAhead).toBe(true);
  });

  it("falls back to #1 — the behaviour that shipped — when the FIRST read is rejected", async () => {
    // Nothing was proved, so nothing is assumed. This is the case the ticket names: a keeper that
    // will not boot because an optimisation failed is worse than a slow keeper, and a keeper that
    // skips rounds because an optimisation failed is worse than both.
    const chain = arena([]);
    const found = await scan({
      nowMs: chain.nowMs,
      probe: () => Promise.reject(new Error("getMultipleAccounts: connection reset")),
    });

    expect(found.cursor).toBe(1n);
    expect(found.skipped).toBe(0);
    expect(found.stoppedBecause).toBe("failed");
    // AND SAMPLING IS NOT SUSPENDED. `catchUpAhead` is evidence, not suspicion: a scan that proved
    // nothing must not be allowed to disarm the burn brake's input on an arena it knows nothing
    // about. See `KeeperContext.closeCatchUpAhead`.
    expect(found.catchUpAhead).toBe(false);
  });

  it("stops on the batch cap and says there is still history ahead", async () => {
    const chain = arena([9_999n]);
    const found = await scan({ through: 9_999n, probe: chain.probe, nowMs: chain.nowMs, maxBatches: 7 });

    expect(found.batches).toBe(7);
    expect(found.cursor).toBe(701n);
    expect(found.skipped).toBe(700);
    expect(found.stoppedBecause).toBe("batch-cap");
    expect(found.catchUpAhead).toBe(true);
  });

  it("stops on the deadline and says the same", async () => {
    const chain = arena([9_999n]);
    chain.chargePerProbe(250); // a hundred-key read against api.devnet.solana.com
    const found = await scan({ through: 9_999n, probe: chain.probe, nowMs: chain.nowMs, budgetMs: 1_000 });

    // Checked BEFORE each read, so four fit inside a 1,000ms budget at 250ms each and the fifth does
    // not start. A check after the read would spend one more than the budget allows, every time.
    expect(found.batches).toBe(4);
    expect(found.cursor).toBe(401n);
    expect(found.stoppedBecause).toBe("deadline");
    expect(found.catchUpAhead).toBe(true);
    expect(found.elapsedMs).toBe(1_000);
  });

  it("issues no read at all on a non-positive budget or cap, and gives `from` straight back", async () => {
    // A misconfigured optimisation does NOTHING rather than something wrong — the direction every
    // degenerate case in `reclamation.ts` takes, applied here. And `catchUpAhead` stays false: zero
    // reads is zero evidence.
    for (const over of [{ budgetMs: 0 }, { maxBatches: 0 }, { batch: 0 }]) {
      const chain = arena([]);
      const found = await scan({ probe: chain.probe, nowMs: chain.nowMs, ...over });
      expect(found.cursor, JSON.stringify(over)).toBe(1n);
      expect(found.batches, JSON.stringify(over)).toBe(0);
      expect(found.catchUpAhead, JSON.stringify(over)).toBe(false);
      expect(chain.calls, JSON.stringify(over)).toEqual([]);
    }
  });

  it("treats a reply shorter than the window as a failed read, not as closed rounds", async () => {
    // `getMultipleAccountsInfo` returns one entry per key, so this cannot happen against a healthy
    // RPC. It is held anyway because the cursor is money and the failure is the expensive direction:
    // believing an empty reply would step the cursor a hundred rounds forward over accounts nothing
    // ever looked at. Only the prefix both sides agree on is believed, and a prefix of nothing is not
    // an answer.
    const chain = arena([]);
    const found = await scan({ probe: () => Promise.resolve([]), nowMs: chain.nowMs });

    expect(found.cursor).toBe(1n);
    expect(found.stoppedBecause).toBe("failed");
    expect(found.error).toBeInstanceOf(Error);
  });

  it("believes only the prefix of a reply that is short but not empty", async () => {
    const chain = arena([]);
    const found = await scan({
      nowMs: chain.nowMs,
      // Forty answers to a hundred questions. The forty are usable; the sixty are not.
      probe: (roundNos) => Promise.resolve(roundNos.slice(0, 40).map(() => false)),
      maxBatches: 1,
    });
    expect(found.cursor).toBe(41n);
  });
});

describe("when a batched read is worth spending, which is where the expensive bug was", () => {
  // THIS GUARD LIVED IN keeper.ts AS `closeAttempts > 0` AND WAS WRONG IN THE ONE REGIME THAT MATTERS.
  // It is here, as a pure function with its own tests, because that is the seam both bugs found in
  // review sat in — and because the failure it now prevents is a 1Hz storm of hundred-key reads
  // against api.devnet.solana.com during the exact outage the burn brake exists to survive.

  it("refuses to probe a round the closer has already seen an account for", async () => {
    // THE BUG. `closeOneFinishedRound` parks the cursor on a terminal UNSWEPT round on purpose —
    // `sweep-first` is the one case it can fix, so it returns to the same round next pass — and
    // `closeAttempts` is never touched on that path. If sweeping is broken the cursor stays parked
    // while `round_counter` climbs, so within ~100 rounds the "is there a batch of work ahead"
    // condition goes true and STAYS true. The old guard let a hundred-key read fire on every idle
    // pass, at 1Hz, for the life of the fault.
    expect(probeIsWorthARead(400n, 400n, 9_999n)).toBe(false);
    // The failing-close case the old guard DID cover still has to be covered.
    expect(probeIsWorthARead(400n, 400n, 401n)).toBe(false);
  });

  it("probes when the round under the cursor has not been seen, or was seen at a different round", async () => {
    // The marker is a ROUND NUMBER rather than a boolean precisely so that it invalidates itself when
    // the cursor advances. A stale marker from the previous round must not suppress the next probe —
    // that is the drift a boolean would have introduced at whichever of keeper.ts's four cursor
    // advances somebody forgot to clear it at.
    expect(probeIsWorthARead(400n, null, 9_999n)).toBe(true);
    expect(probeIsWorthARead(400n, 399n, 9_999n)).toBe(true);
    expect(probeIsWorthARead(400n, 401n, 9_999n)).toBe(true);
  });

  it("spends a read only when a full batch of work is actually ahead", async () => {
    // In steady state the cursor sits a round or two behind the retention boundary, so this is false
    // and the per-pass skip costs nothing at all. Firing on a smaller run would spend a batched read
    // to save a handful of one-second passes.
    expect(probeIsWorthARead(1n, null, BigInt(CLOSE_CURSOR_PROBE_BATCH))).toBe(true);
    expect(probeIsWorthARead(1n, null, BigInt(CLOSE_CURSOR_PROBE_BATCH) - 1n)).toBe(false);
    expect(probeIsWorthARead(617n, null, 616n)).toBe(false);
  });

  it("says no on an arena younger than its own retention window", async () => {
    // `through` is NEGATIVE there — `round_counter` 4 against a retention of 20. These are bigints, so
    // it does not wrap; the comparison is simply false, and `isPastRetention`'s warning about the
    // subtraction form does not bite on a bound that only feeds a threshold.
    expect(probeIsWorthARead(1n, null, 4n - BigInt(RETENTION))).toBe(false);
  });
});

describe("the per-pass skip, which is the same routine with a cap of one", () => {
  it("collapses the closed rounds ABOVE a hole, which is what boot alone cannot do", async () => {
    // The second half of the live arena. Boot correctly parks the cursor on #295; the ordinary walk
    // then has #296-#616 — 321 closed rounds — in front of it, which one round per pass is ~10
    // minutes of exactly the distorted samples the fast-forward exists to stop. Four idle passes of
    // this instead.
    const chain = arena([...range(617n, LIVE_ROUND_COUNTER)]);
    let cursor = LIVE_STRANDED + 1n;
    let passes = 0;
    while (cursor <= LIVE_THROUGH) {
      const step = await findOldestLivingRound({
        from: cursor,
        through: LIVE_THROUGH,
        probe: chain.probe,
        nowMs: chain.nowMs,
        budgetMs: Number.MAX_SAFE_INTEGER,
        maxBatches: 1,
      });
      passes += 1;
      expect(step.batches).toBe(1);
      // NEVER BACKWARDS. The per-pass skip runs against a cursor another function is advancing, so
      // "only ever moves forward" — `KeeperContext.closeCursor`'s stated invariant — has to hold for
      // this caller too or the closer would re-decide rounds it has already recorded losses for.
      expect(step.cursor).toBeGreaterThanOrEqual(cursor);
      cursor = step.cursor;
    }
    expect(cursor).toBe(LIVE_THROUGH + 1n);
    expect(passes).toBe(4);
  });

  it("hands the cursor straight back when the round under it still exists", async () => {
    // What `skipClosedRoundsAhead` relies on for its `closeAttempts > 0` guard to be a pure saving
    // rather than a behaviour change: a probe that starts on a living round finds it at index zero.
    const chain = arena([400n]);
    const found = await findOldestLivingRound({
      from: 400n,
      through: LIVE_THROUGH,
      probe: chain.probe,
      nowMs: chain.nowMs,
      budgetMs: Number.MAX_SAFE_INTEGER,
      maxBatches: 1,
    });
    expect(found.cursor).toBe(400n);
    expect(found.skipped).toBe(0);
    expect(found.stoppedBecause).toBe("found");
    // AND IT SAYS SO, which is what `probeIsWorthARead` uses to stop asking. The read is wasted; the
    // point of the guard is that it is never spent in the first place.
    expect(found.catchUpAhead).toBe(false);
  });

  it("reports a whole batch of absent rounds as history still ahead, so the caller can suspend sampling", async () => {
    // THE EVIDENCE THE BOOT SCAN CANNOT GATHER. The closed stretch ABOVE a stranded round is only
    // discoverable mid-flight, and it is walked with the brake armed unless this comes back true.
    // Same three-condition rule as at boot: did not reach a living round, proved something, stopped
    // short of the boundary.
    const chain = arena([...range(9_000n, 9_999n)]);
    const step = await findOldestLivingRound({
      from: 296n,
      through: 9_999n,
      probe: chain.probe,
      nowMs: chain.nowMs,
      budgetMs: Number.POSITIVE_INFINITY,
      maxBatches: 1,
    });
    expect(step.cursor).toBe(396n);
    expect(step.catchUpAhead).toBe(true);
  });
});
