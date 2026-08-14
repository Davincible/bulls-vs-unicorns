// THE BRAKE, AS PROPERTIES RATHER THAN EXAMPLES — because an example is a number somebody chose and
// the failures that matter here are the ones nobody chose.
//
// WHAT IS BEING PROTECTED. COST-MODEL.md §4: the arena costs ~0.030 SOL/day while rent reclamation
// works and ~9.96 SOL/day the moment it stops, which empties a 14.95 SOL balance in about thirty-six
// hours. `burnBrake` is what stops that, and it has exactly two ways to be wrong — both silent, and
// they are not the same size:
//
//   FALSE NEGATIVE   the brake stays open through a real outage. Costs SOL, at a rate a human is
//                    watching, in a report they already have open, with `sweepGap` beside it saying
//                    the same thing from the chain's side.
//   FALSE POSITIVE   the brake stops a healthy arena. Costs the arena — and, worse, presents
//                    IDENTICALLY to the fault it was built to detect, so the operator concludes
//                    reclamation is broken when it is working exactly as designed. A brake whose
//                    false alarm is indistinguishable from the fire is worse than no brake.
//
// Every test below is chosen for which of those two it pins.

import { describe, expect, it } from "vitest";
import {
  ROUND_RENT_LAMPORTS, burnBrake, serializeReclamationReport, summariseReclamation,
  type ReclamationState,
} from "./reclamation.ts";

/** The three constants `config.ts` owns, as literals — this file must not import them, both because
 *  another agent is still settling their values and because a test that reads the same constant the
 *  code reads asserts only that one number equals itself. These are the shape of the intended
 *  configuration and the arithmetic below is checked against them by hand. */
const THRESHOLD = 5_000_000;      // MAX_BURN_LAMPORTS_PER_ROUND — 0.005 SOL
const ARM_AFTER = 45;             // BURN_ARM_AFTER_ROUNDS — 2 * ROUND_RETENTION + 5
const WINDOW = 20;                // BURN_SAMPLE_ROUNDS — one retention window

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Steady state with reclamation working: fees only, ~0.00007 SOL a round (COST-MODEL §1). */
const HEALTHY = 70_000;

/** Reclamation stopped: the round's rent leaves and nothing returns it. */
const BROKEN = ROUND_RENT_LAMPORTS;

const run = (value: number, count: number): number[] => Array.from({ length: count }, () => value);

describe("the brake will not have an opinion before it is entitled to one", () => {
  it("is not armed below armAfter, whatever the samples say", () => {
    // THE CASE THAT WOULD STOP A HEALTHY YOUNG ARENA. Rent comes back MIN_RETAINED_ROUNDS rounds
    // after it leaves, so an arena's first twenty rounds legitimately pay the full rent and get none
    // of it back — samples that are, to a balance watcher, indistinguishable from a total outage.
    // Whatever the window reads, an unarmed brake must not trip on it.
    for (let observed = 0; observed < ARM_AFTER; observed += 1) {
      const verdict = burnBrake(run(BROKEN, observed), THRESHOLD, ARM_AFTER, WINDOW);
      expect(verdict.armed).toBe(false);
      expect(verdict.tripped).toBe(false);
    }
  });

  it("reports the mean it is not yet acting on", () => {
    // Reported rather than withheld: the operator watching the first hour needs to see the number
    // forming, and `armed: false` beside it is what says the brake will not act on it. Hiding it
    // until arming would make the report useless in exactly the window it is most read.
    const verdict = burnBrake(run(BROKEN, 5), THRESHOLD, ARM_AFTER, WINDOW);
    expect(verdict.armed).toBe(false);
    expect(verdict.meanLamportsPerRound).toBe(BROKEN);
    expect(verdict.samples).toBe(5);
  });

  it("arms exactly at armAfter, not one sample before", () => {
    expect(burnBrake(run(HEALTHY, ARM_AFTER - 1), THRESHOLD, ARM_AFTER, WINDOW).armed).toBe(false);
    expect(burnBrake(run(HEALTHY, ARM_AFTER), THRESHOLD, ARM_AFTER, WINDOW).armed).toBe(true);
  });

  it("never arms on a misconfigured brake rather than arming on everything", () => {
    // A non-positive armAfter or window is a configuration error, and the safe reading of one is the
    // brake that does nothing: the false positive costs an arena and the false negative costs SOL a
    // human is watching. Same asymmetry that makes the whole mechanism safe to wire to a stop.
    expect(burnBrake(run(BROKEN, 100), THRESHOLD, 0, WINDOW).armed).toBe(false);
    expect(burnBrake(run(BROKEN, 100), THRESHOLD, -1, WINDOW).tripped).toBe(false);
    expect(burnBrake(run(BROKEN, 100), THRESHOLD, ARM_AFTER, 0).tripped).toBe(false);
  });
});

describe("the brake against a working arena and a broken one", () => {
  it("does not trip on a run of healthy rounds", () => {
    const verdict = burnBrake(run(HEALTHY, ARM_AFTER), THRESHOLD, ARM_AFTER, WINDOW);
    expect(verdict.armed).toBe(true);
    expect(verdict.tripped).toBe(false);
    expect(verdict.meanLamportsPerRound).toBe(HEALTHY);
    // Two orders of magnitude of headroom. The threshold is not a hair's breadth from steady state,
    // which is why a healthy arena's ordinary noise cannot reach it.
    expect(HEALTHY * 50).toBeLessThan(THRESHOLD);
  });

  it("trips on a run of broken rounds", () => {
    const verdict = burnBrake(run(BROKEN, ARM_AFTER), THRESHOLD, ARM_AFTER, WINDOW);
    expect(verdict.armed).toBe(true);
    expect(verdict.tripped).toBe(true);
  });

  it("does not trip on a single wedged round inside an otherwise healthy window", () => {
    // THE MEAN IS THE POINT. One round that could not be closed is 0.023497 SOL and a log line; it is
    // not an outage, and stopping the arena over it would be the expensive mistake made for the cheap
    // reason. A brake that fired on any single bad round would fire on the first `still-delegated`
    // round of every ER validator restart.
    const samples = [...run(HEALTHY, ARM_AFTER - 1), BROKEN];
    const verdict = burnBrake(samples, THRESHOLD, ARM_AFTER, WINDOW);
    expect(verdict.tripped).toBe(false);
    // And the arithmetic is what makes that true rather than luck: one broken round spread over the
    // twenty-sample window is about a quarter of the threshold.
    expect(verdict.meanLamportsPerRound!).toBeLessThan(THRESHOLD);
  });

  it("trips once enough of the window is broken, and not before", () => {
    // The boundary, walked rather than asserted at one point: with a 20-sample window, a threshold of
    // 0.005 SOL and a broken round at 0.023497, it takes five broken rounds in the window to cross.
    for (let broken = 0; broken <= WINDOW; broken += 1) {
      const samples = [...run(HEALTHY, ARM_AFTER - broken), ...run(BROKEN, broken)];
      const expected = (broken * BROKEN + (WINDOW - broken) * HEALTHY) / WINDOW > THRESHOLD;
      expect(burnBrake(samples, THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(expected);
    }
  });

  it("does not trip at exactly the threshold — a ceiling has to be crossed, not reached", () => {
    expect(burnBrake(run(THRESHOLD, ARM_AFTER), THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(false);
    expect(burnBrake(run(THRESHOLD + 1, ARM_AFTER), THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(true);
  });
});

describe("a top-up is asymmetric: it can suppress a trip and can never cause one", () => {
  it("cannot cause a trip — a big negative sample only pulls the mean down", () => {
    // An `airdrop` or a manual transfer into the operator shows up as a NEGATIVE sample: the balance
    // went UP across that round. There is no arrangement of a refill that raises the mean, so there
    // is no way for a human topping the wallet up to stop the arena.
    const topUp = -10 * LAMPORTS_PER_SOL;
    const healthy = run(HEALTHY, ARM_AFTER);
    const withTopUp = [...healthy.slice(0, -1), topUp];
    expect(burnBrake(healthy, THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(false);
    expect(burnBrake(withTopUp, THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(false);
    expect(burnBrake(withTopUp, THRESHOLD, ARM_AFTER, WINDOW).meanLamportsPerRound!)
      .toBeLessThan(burnBrake(healthy, THRESHOLD, ARM_AFTER, WINDOW).meanLamportsPerRound!);
  });

  it("CAN suppress one — and that is the direction this mechanism is allowed to be wrong in", () => {
    // The other half of the same asymmetry, asserted rather than left implied. A refill large enough
    // to mask a genuine outage for one window is a real hole and it is the ACCEPTABLE hole: a false
    // negative costs SOL a human is already watching, with `sweepGap` in the same report saying the
    // same thing from the chain's side. A false positive stops an arena that was working, and looks
    // exactly like the fault it claims to have found.
    const broken = run(BROKEN, ARM_AFTER);
    expect(burnBrake(broken, THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(true);
    const masked = [...broken.slice(0, -1), -WINDOW * BROKEN];
    expect(burnBrake(masked, THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(false);
  });
});

describe("the window is bounded", () => {
  it("reads at most the last `windowSamples`, so an old outage cannot keep the brake tripped", () => {
    // A brake that averaged everything it had ever seen would stay tripped long after the arena
    // recovered, and would need a restart to clear — which is the same class of failure as a health
    // check that fails for a reason a restart cannot fix, pointed the other way.
    const samples = [...run(BROKEN, 500), ...run(HEALTHY, WINDOW)];
    const verdict = burnBrake(samples, THRESHOLD, ARM_AFTER, WINDOW);
    expect(verdict.samples).toBe(WINDOW);
    expect(verdict.meanLamportsPerRound).toBe(HEALTHY);
    expect(verdict.tripped).toBe(false);
  });

  it("does not go blind to an outage that begins after a long healthy run", () => {
    // The mirror of the above, which is the assertion that stops somebody "fixing" the bound by
    // widening it: a window that is bounded is also a window that fills with the present.
    const samples = [...run(HEALTHY, 500), ...run(BROKEN, WINDOW)];
    expect(burnBrake(samples, THRESHOLD, ARM_AFTER, WINDOW).tripped).toBe(true);
  });

  it("voids the mean on a sample that is not a finite number rather than dropping it", () => {
    // `getBalance` cannot produce this; arithmetic against something that was `undefined` can. A
    // brake that silently discards the samples it cannot read is measuring something other than what
    // it says, and one that fires on a NaN fires at random.
    const verdict = burnBrake([...run(HEALTHY, ARM_AFTER - 1), Number.NaN], THRESHOLD, ARM_AFTER, WINDOW);
    expect(verdict.meanLamportsPerRound).toBeNull();
    expect(verdict.armed).toBe(false);
    expect(verdict.tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const ROUNDS_PER_DAY = 424;

/** A closer whose TOTALS AGREE WITH ITS LISTS, which is every run until a list fills. The totals
 *  default to the lengths so that a test about anything else does not have to restate them — and so
 *  that the one test where they DISAGREE says so in a single visible line, which is the whole subject
 *  of that test. */
const closer = (over: Partial<ReclamationState["closer"]> = {}): ReclamationState["closer"] => {
  const skipped = over.skipped ?? [];
  const neverTerminal = over.strandedNeverTerminal ?? [];
  const stillDelegated = over.strandedStillDelegated ?? [];
  return {
    cursor: 392,
    reclaimed: 371,
    skipped,
    strandedNeverTerminal: neverTerminal,
    strandedStillDelegated: stillDelegated,
    skippedTotal: skipped.length,
    strandedNeverTerminalTotal: neverTerminal.length,
    strandedStillDelegatedTotal: stillDelegated.length,
    ...over,
  };
};

const state = (over: Partial<ReclamationState> = {}): ReclamationState => ({
  observedAtSec: 1_760_000_000,
  arena: { roundCounter: 412, roundsSwept: 409, polledAtSec: 1_759_999_940 },
  closer: closer(),
  burnSamplesLamports: run(HEALTHY, ARM_AFTER),
  operatorLamports: 14_950_000_000,
  ...over,
});

const summarise = (s: ReclamationState) =>
  summariseReclamation(s, THRESHOLD, ARM_AFTER, WINDOW, ROUNDS_PER_DAY);

describe("the sweep gap, which COST-MODEL names as the health metric", () => {
  it("is round_counter minus rounds_swept", () => {
    expect(summarise(state()).sweepGap).toBe(3);
  });

  it("is NULL, not zero, when the treasury has not been read", () => {
    // THE ONE PLACE NULL AND ZERO MUST NOT BE CONFUSED. A treasury nobody has read and a treasury
    // perfectly caught up both look like nothing is wrong; only one of them is evidence. Defaulting
    // to zero here would publish "reclamation is healthy" on the strength of never having looked.
    expect(summarise(state({ arena: null })).sweepGap).toBeNull();
    expect(summarise(state({ arena: null })).arena).toBeNull();
    const unswept = state({ arena: { roundCounter: 412, roundsSwept: null, polledAtSec: 1_759_999_940 } });
    expect(summarise(unswept).sweepGap).toBeNull();
    expect(summarise(unswept).arena?.roundCounter).toBe(412);
  });

  it("publishes how old the poll behind it is", () => {
    // The treasury is read on its own slower interval. A gap of zero read ten minutes ago is a fact
    // about the past, and a reader comparing it against a round counter that has moved since would
    // be reading it as a fact about now.
    expect(summarise(state()).arena?.pollAgeSec).toBe(60);
  });
});

describe("what the closer lost, in the unit that makes it actionable", () => {
  it("turns skipped rounds into the SOL that is never coming back", () => {
    // "2 rounds skipped" and "0.047 SOL you are never getting back" are the same fact and only one of
    // them makes anybody do something.
    const report = summarise(state({ closer: closer({ skipped: [17, 233] }) }));
    expect(report.closer.skipped.rounds).toEqual([17, 233]);
    expect(report.closer.skipped.count).toBe(2);
    expect(report.closer.skipped.lamports).toBe(String(2 * ROUND_RENT_LAMPORTS));
    expect(report.closer.skipped.sol).toBeCloseTo(0.046994, 6);
  });

  it("keeps stranded rent separate from skipped rent rather than summing them", () => {
    // Different kinds of loss. A skipped round was closeable and was given up on after
    // CLOSE_ATTEMPTS_PER_ROUND failures. A still-delegated one is not even certainly lost — forced
    // undelegation exists in the delegation program's v3.1.0 API and is merely not deployed on this
    // devnet (COST-MODEL §4.3). One total would turn a number that might come back into a number that
    // never will.
    const report = summarise(state({
      closer: closer({ skipped: [17], strandedNeverTerminal: [4, 9], strandedStillDelegated: [188] }),
    }));
    expect(report.closer.skipped.count).toBe(1);
    expect(report.closer.stranded.count).toBe(3);
    expect(report.closer.stranded.neverTerminal).toEqual([4, 9]);
    expect(report.closer.stranded.stillDelegated).toEqual([188]);
    expect(report.closer.stranded.lamports).toBe(String(3 * ROUND_RENT_LAMPORTS));
  });

  it("counts every lost round, not the fifty the sample kept — the loss is largest exactly when the list is full", () => {
    // THE BUG THIS PINS. `count`, `lamports` and `sol` were read off the ARRAY, and the array is
    // bounded at CLOSE_LOSS_SAMPLE. So a run that had skipped two hundred rounds published fifty and
    // ~1.17 SOL against a true ~4.70 — understating a permanent loss by 4x, silently, with every
    // published number still agreeing with every other, on the one endpoint whose entire job is to
    // answer "how much have I permanently lost". The bound has to fall on the LIST and never on the
    // COUNT.
    const sample = Array.from({ length: 50 }, (_, i) => 151 + i);
    const report = summarise(state({
      closer: closer({ skipped: sample, skippedTotal: 200 }),
    }));

    expect(report.closer.skipped.count).toBe(200);
    expect(report.closer.skipped.lamports).toBe(String(200 * ROUND_RENT_LAMPORTS));
    expect(report.closer.skipped.sol).toBeCloseTo(4.6994, 4);

    // And the sample is still served, still whole, still fifty — the round numbers are what an
    // operator goes and looks at, and `listed` is what tells them the fifty is a sample rather than a
    // payload that lost a hundred and fifty entries somewhere.
    expect(report.closer.skipped.rounds).toEqual(sample);
    expect(report.closer.skipped.listed).toBe(50);
  });

  it("counts stranded rounds past the bound too, across both lists at once", () => {
    // The same bug, in the block where it is harder to see: `stranded.count` sums TWO capped lists, so
    // a reader cannot check it against one array length by eye. `listed` is published for exactly that
    // reason and must sum the two the same way the count's totals do.
    const report = summarise(state({
      closer: closer({
        strandedNeverTerminal: [4, 9],
        strandedStillDelegated: [188],
        strandedNeverTerminalTotal: 61,
        strandedStillDelegatedTotal: 12,
      }),
    }));
    expect(report.closer.stranded.count).toBe(73);
    expect(report.closer.stranded.lamports).toBe(String(73 * ROUND_RENT_LAMPORTS));
    expect(report.closer.stranded.listed).toBe(3);
  });
});

describe("the burn, in the unit the question was asked in", () => {
  it("reports lamports per round AND SOL per day, so nobody has to multiply", () => {
    const report = summarise(state());
    expect(report.burn.meanLamportsPerRound).toBe(String(HEALTHY));
    expect(report.burn.solPerDay).toBeCloseTo(HEALTHY * ROUNDS_PER_DAY / LAMPORTS_PER_SOL, 6);
    // ~0.030 SOL/day — the headline figure in COST-MODEL §0, arrived at from the other direction.
    expect(report.burn.solPerDay!).toBeCloseTo(0.0297, 4);
    expect(report.burn.thresholdSolPerDay).toBeCloseTo(2.12, 2);
    expect(report.burn.tripped).toBe(false);
  });

  it("says both how many samples exist and how many the mean was taken over", () => {
    const report = summarise(state({ burnSamplesLamports: run(HEALTHY, ARM_AFTER + 7) }));
    expect(report.burn.samplesObserved).toBe(ARM_AFTER + 7);
    expect(report.burn.samplesInWindow).toBe(WINDOW);
    expect(report.burn.armAfterSamples).toBe(ARM_AFTER);
    expect(report.burn.windowSamples).toBe(WINDOW);
  });

  it("carries the outage through to SOL/day at the rate that empties the wallet", () => {
    const report = summarise(state({ burnSamplesLamports: run(BROKEN, ARM_AFTER) }));
    expect(report.burn.tripped).toBe(true);
    // COST-MODEL §0's 9.96 SOL/day, which is the whole reason this endpoint exists.
    expect(report.burn.solPerDay!).toBeCloseTo(9.96, 2);
  });
});

describe("runway, the number the endpoint exists to show", () => {
  it("is the balance divided by the daily burn", () => {
    const report = summarise(state({ burnSamplesLamports: run(BROKEN, ARM_AFTER) }));
    // 14.95 SOL against 9.96 SOL/day — COST-MODEL's "about 36 hours", stated as a number the reader
    // does not have to compute.
    expect(report.runwayDays!).toBeCloseTo(1.5, 1);
  });

  it("is NULL rather than Infinity on a non-positive burn", () => {
    // A window containing a top-up nets negative, and no number of days is the right answer to that.
    // `JSON.stringify(Infinity)` emits `null` anyway, so the choice is between a null that was
    // decided and a null that arrived through a serializer — and a healthy arena reporting
    // "runway: 1e308" is noise a reader learns to skip, which is fatal for the one field that must be
    // read on the day it says something.
    expect(summarise(state({ burnSamplesLamports: run(0, ARM_AFTER) })).runwayDays).toBeNull();
    expect(summarise(state({ burnSamplesLamports: run(-1_000, ARM_AFTER) })).runwayDays).toBeNull();
  });

  it("is null when the burn or the balance is unknown", () => {
    expect(summarise(state({ burnSamplesLamports: [] })).runwayDays).toBeNull();
    expect(summarise(state({ operatorLamports: null })).runwayDays).toBeNull();
    expect(summarise(state({ operatorLamports: null })).operator.lamports).toBeNull();
  });

  it("is computed whether or not the brake is armed", () => {
    // "This is what you are spending right now" is true and useful in the first hour, which is
    // exactly when somebody is watching. Whether the brake will ACT on it is a different question and
    // `armed` answers it separately.
    const young = summarise(state({ burnSamplesLamports: run(BROKEN, 3) }));
    expect(young.burn.armed).toBe(false);
    expect(young.runwayDays).not.toBeNull();
  });
});

describe("how the payload writes numbers", () => {
  it("writes every lamport figure as a whole-number decimal string", () => {
    // Lamports are u64s and a JSON number cannot hold one without silently rounding it — the rule
    // `pot` and `KeeperLowBalance` already follow. Asserted over the SERIALIZED BYTES rather than the
    // object, because the object could hold a `number` that only looks right until it is large:
    // `"14950000000"` and `14950000000` are indistinguishable in a `toEqual`, and the whole point is
    // which one reaches the wire.
    const report = summarise(state({
      // 2^53 — the first integer a JSON number cannot be trusted past. Exactly representable as a
      // double, so this test is checking the FORMAT and not the arithmetic that produced it.
      operatorLamports: 9_007_199_254_740_992,
      closer: closer({ cursor: 1, reclaimed: 0, skipped: [3] }),
    }));
    const parsed = JSON.parse(serializeReclamationReport(report));
    for (const value of [
      parsed.operator.lamports,
      parsed.closer.skipped.lamports,
      parsed.closer.stranded.lamports,
      parsed.burn.meanLamportsPerRound,
      parsed.burn.thresholdLamportsPerRound,
    ]) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^-?\d+$/);
    }
    // A balance past 2^53 survives the round trip, which is the entire reason for the rule.
    expect(parsed.operator.lamports).toBe("9007199254740992");
  });

  it("writes SOL, days and counts as JSON numbers", () => {
    const parsed = JSON.parse(serializeReclamationReport(summarise(state())));
    expect(typeof parsed.operator.sol).toBe("number");
    expect(typeof parsed.burn.solPerDay).toBe("number");
    expect(typeof parsed.runwayDays).toBe("number");
    expect(typeof parsed.sweepGap).toBe("number");
    expect(typeof parsed.closer.skipped.count).toBe("number");
  });

  it("carries no schema field, and ends in a newline", () => {
    // No version, for the same reason `HOUSE_PATH` carries none: zero programmatic consumers and one
    // human with `curl`. The trailing newline is for that human's terminal.
    const bytes = serializeReclamationReport(summarise(state()));
    expect(JSON.parse(bytes).schema).toBeUndefined();
    expect(bytes.endsWith("\n")).toBe(true);
  });

  it("copies the round-number lists rather than aliasing the keeper's own arrays", () => {
    // The report is a value the HTTP layer holds until the next publish. Handing out the keeper's
    // live arrays would let a served body change under a reader as the closer appends to them.
    const s = state();
    const report = summarise(s);
    s.closer.skipped.push(999);
    expect(report.closer.skipped.rounds).toEqual([]);
  });
});
