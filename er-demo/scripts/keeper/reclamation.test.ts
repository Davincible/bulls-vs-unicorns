// THE BRAKE, AS PROPERTIES RATHER THAN EXAMPLES — because an example is a number somebody chose and
// the failures that matter here are the ones nobody chose.
//
// WHAT IS BEING PROTECTED. COST-MODEL.md §4: the arena costs ~0.178 SOL/day while rent reclamation
// works and ~10.14 SOL/day the moment it stops, which empties a 24 SOL balance in under three days.
// (Those first two numbers were ~0.030 and ~9.96 until the healthy side was measured rather than
// estimated — see §1.1 and the note on HEALTHY below. The RATIO barely moved, which is why every
// property in this file survived the correction unchanged except the three that pinned the literals.) `burnBrake` is what stops that, and it has exactly two ways to be wrong — both silent, and
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
  ROUND_RENT_LAMPORTS, burnBrake, recordBurnSample, serializeReclamationReport, summariseReclamation,
  sweepGapStop,
  type ReclamationState, type SweepGapVerdict,
} from "./reclamation.ts";

/** The three constants `config.ts` owns, as literals — this file must not import them, both because
 *  another agent is still settling their values and because a test that reads the same constant the
 *  code reads asserts only that one number equals itself. These are the shape of the intended
 *  configuration and the arithmetic below is checked against them by hand. */
const THRESHOLD = 5_000_000;      // MAX_BURN_LAMPORTS_PER_ROUND — 0.005 SOL
const ARM_AFTER = 45;             // BURN_ARM_AFTER_ROUNDS — 2 * ROUND_RETENTION + 5
const WINDOW = 20;                // BURN_SAMPLE_ROUNDS — one retention window
const STOP_AT_GAP = 25;           // SWEEP_GAP_STOP_ROUNDS — ROUND_RETENTION + 5 rounds of headroom

/** The chain's retention window, which is the floor `STOP_AT_GAP` is derived from. Written out for
 *  the same reason as the three above: the arithmetic below is checked against it by hand. */
const RETENTION = 20;

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Steady state with reclamation working: ~0.00042 SOL a round, MEASURED over 206 rounds of
 *  continuous running (COST-MODEL §1.1) rather than estimated.
 *
 *  THIS WAS 70_000 AND THE COMMENT SAID "fees only", AND BOTH WERE WRONG — the figure came from
 *  COST-MODEL §1 before it was found to have filed `DelegateRound` as float without subtracting what
 *  `ProcessUndelegation` returns. 405,000 lamports a round never comes back, so healthy burn is six
 *  times what this file used to assert.
 *
 *  It matters here specifically because these tests exist to prove the brake DOES NOT fire in steady
 *  state. Run against 70,000 they proved that about an arena which does not exist; the real margin —
 *  420,000 against a 5,000,000 threshold, 11.9x rather than 70x — was untested until now. */
const HEALTHY = 420_000;

/** Reclamation stopped: the round's rent leaves and nothing returns it, ON TOP of the ordinary burn.
 *  Summed rather than substituted — a broken round still pays everything a healthy one pays. */
const BROKEN = HEALTHY + ROUND_RENT_LAMPORTS;

/** `STRANDED_ALLOWANCE_ROUNDS` — how many permanently unsweepable rounds the sweep-gap stop excuses
 *  before it starts counting them against itself again. A literal here for the reason the four above
 *  are: this file checks the arithmetic by hand against the intended configuration.
 *
 *  IT IS THE SAME NUMBER AS `STOP_AT_GAP` AND THAT IS A COINCIDENCE OF JUDGEMENT, NOT A DERIVATION.
 *  25 is the retention window plus five; this 25 is what an operator will absorb in permanently dead
 *  rounds before a person has to look. They are written out separately so that a test which changes
 *  one does not silently move the other. */
const STRANDED_ALLOWANCE = 25;

const run = (value: number, count: number): number[] => Array.from({ length: count }, () => value);

// ---------------------------------------------------------------------------------------------
// The fixtures, shared by the stop and by the report
// ---------------------------------------------------------------------------------------------
//
// THEY LIVE UP HERE BECAUSE THE STOP READS THE WHOLE OBSERVED STATE NOW. It used to take a treasury
// snapshot and two numbers, so its tests could build their subject in one line; it takes the closer's
// stranded ledger as well, because the rounds nothing can ever sweep have to come out of the gap
// before it is compared against anything. One set of fixtures for both sections is what keeps the
// stop's tests and the report's tests arguing about the same keeper.

/** The keeper's own treasury snapshot, built the way `pollTreasury` builds it — both terms read at one
 *  instant, which is the property the staleness argument in `sweepGapStop` rests on. */
const polled = (roundCounter: number, roundsSwept: number | null, polledAtSec = 1_759_999_940) =>
  ({ roundCounter, roundsSwept, polledAtSec });

/** A poll showing exactly `gap` unswept rounds. */
const atGap = (gap: number, polledAtSec?: number) => polled(400 + gap, 400, polledAtSec);

/** A closer whose TOTALS AGREE WITH ITS LISTS, which is every run until a list fills. The totals
 *  default to the lengths so that a test about anything else does not have to restate them — and so
 *  that the one test where they DISAGREE says so in a single visible line, which is the whole subject
 *  of that test.
 *
 *  ITS CURSOR IS CAUGHT UP BY DEFAULT — 393 against the fixture arena's `round_counter` of 412 and a
 *  retention window of 20, which is where a healthy keeper's cursor actually sits. That makes the
 *  default stranded ledger COMPLETE, so a test that says nothing about the rebuild is not silently
 *  testing a suspended stop. The tests that care about the rebuild move the cursor back on purpose. */
const closer = (over: Partial<ReclamationState["closer"]> = {}): ReclamationState["closer"] => {
  const skipped = over.skipped ?? [];
  const neverTerminal = over.strandedNeverTerminal ?? [];
  const stillDelegated = over.strandedStillDelegated ?? [];
  return {
    cursor: 393,
    reclaimed: 371,
    skipped,
    strandedNeverTerminal: neverTerminal,
    strandedStillDelegated: stillDelegated,
    skippedTotal: skipped.length,
    strandedNeverTerminalTotal: neverTerminal.length,
    strandedStillDelegatedTotal: stillDelegated.length,
    closing: true,
    ...over,
  };
};

const state = (over: Partial<ReclamationState> = {}): ReclamationState => ({
  observedAtSec: 1_760_000_000,
  arena: { roundCounter: 412, roundsSwept: 409, polledAtSec: 1_759_999_940 },
  closer: closer(),
  burnSamplesLamports: run(HEALTHY, ARM_AFTER),
  burnSamplingSuspended: false,
  operatorLamports: 14_950_000_000,
  sweepStoppedSinceSec: null,
  ...over,
});

const THRESHOLDS = {
  burnLamportsPerRound: THRESHOLD,
  armAfterSamples: ARM_AFTER,
  windowSamples: WINDOW,
  stopAtGapRounds: STOP_AT_GAP,
  strandedAllowanceRounds: STRANDED_ALLOWANCE,
  retentionRounds: RETENTION,
};

const ROUNDS_PER_DAY = 424;

const summarise = (s: ReclamationState) => summariseReclamation(s, THRESHOLDS, ROUNDS_PER_DAY);

/** The ring the keeper builds, built the way the keeper builds it: one sample at a time, through the
 *  function under test, folding its own return value back in. Never by constructing the array
 *  directly — that would exercise `slice` and assert nothing about the accumulation, and the
 *  accumulation is where every regression in this mechanism lives. */
function ringOf(cap: number, samples: readonly number[]): number[] {
  let ring: number[] = [];
  for (const sample of samples) ring = recordBurnSample(ring, sample, cap);
  return ring;
}

describe("the ring the brake reads, which nothing used to be able to reach", () => {
  // WHY THIS BLOCK EXISTS AT ALL. This was two lines of push-and-shift inside `openNextRound`, between
  // a balance read and a transaction send, so no test in this repo could execute it — a keeper and a
  // chain were the only instruments that would. Every plausible slip there is silent AND permanent:
  // nothing throws, no transaction fails, and the report goes on rendering a brake that will never have
  // an opinion. The tests below are chosen one per slip.

  it("holds every sample until it is full, and never more than cap after that", () => {
    // The `<` for `>` regression, which grows the ring without bound. It costs nothing visible — the
    // mean is taken over the window either way — so the only thing that would ever catch it is a
    // length assertion, and the only place to make one is here.
    for (let fed = 0; fed <= 2 * WINDOW; fed += 1) {
      const ring = ringOf(WINDOW, run(HEALTHY, fed));
      expect(ring.length).toBe(Math.min(fed, WINDOW));
    }
  });

  it("drops the OLDEST sample and keeps the NEWEST", () => {
    // `pop` for `shift`, and it is the most expensive one-character mistake available here. A ring that
    // dropped the newest would freeze on a run's FIRST samples — the pre-turnover rounds that
    // legitimately pay full rent and read exactly like a total reclamation outage — so the brake would
    // arm on schedule and then trip on a keeper that was working. That is the false positive this whole
    // mechanism is built to avoid, arriving through the one line nothing was watching.
    //
    // The values are named rather than counted, because both mistakes produce a ring of length three.
    expect(ringOf(3, [1, 2, 3, 4, 5])).toEqual([3, 4, 5]);
  });

  it("reaches the arming threshold at BURN_ARM_AFTER_ROUNDS and can never reach it at BURN_SAMPLE_ROUNDS", () => {
    // THE LOAD-BEARING TEST IN THIS FILE, because it is the only one that asserts the two constants are
    // not interchangeable. `burnBrake` arms on `samples.length >= armAfter` and only then averages the
    // last `windowSamples`, so the ring must be capped at the LARGER of the two. Cap it at the window
    // and the length can never reach the threshold — the brake never forms an opinion, for the life of
    // the process, and the report says `armed: false` beside a sample count that has quietly stopped
    // growing, which is indistinguishable from a young arena that is simply still counting.
    //
    // Both halves are asserted because only the pair is a claim. The first alone passes under a ring
    // that is uncapped, unshifted, or capped at anything at least as large; the second is what says the
    // cap has to be this constant and not the one two lines above it in `config.ts`.
    const armable = ringOf(ARM_AFTER, run(HEALTHY, ARM_AFTER));
    expect(armable.length).toBe(ARM_AFTER);
    expect(burnBrake(armable, THRESHOLD, ARM_AFTER, WINDOW).armed).toBe(true);

    // Fed far past the arming threshold and still stuck at the window, which is what "never" means
    // here: no amount of running gets this keeper a brake.
    const stunted = ringOf(WINDOW, run(HEALTHY, 20 * ARM_AFTER));
    expect(stunted.length).toBe(WINDOW);
    expect(burnBrake(stunted, THRESHOLD, ARM_AFTER, WINDOW).armed).toBe(false);
  });

  it("leaves the array it was handed alone", () => {
    // The purity the caller depends on: `openNextRound` assigns the return value back onto the keeper
    // context, so a version that also mutated in place would double-append the moment anything else
    // held the same array — and the reclamation report is handed exactly that reference every pass.
    const before = run(HEALTHY, 3);
    const copy = [...before];
    recordBurnSample(before, BROKEN, 10);
    expect(before).toEqual(copy);
  });

  it("keeps nothing at a non-positive cap", () => {
    // Same direction every degenerate case in this mechanism takes. An empty ring cannot arm, and a
    // brake that cannot arm stays open — so a misconfiguration costs SOL a human is watching rather
    // than stopping an arena that was working.
    expect(recordBurnSample(run(BROKEN, 5), BROKEN, 0)).toEqual([]);
    expect(recordBurnSample(run(BROKEN, 5), BROKEN, -1)).toEqual([]);
  });
});

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
    // AN ORDER OF MAGNITUDE OF HEADROOM, and this assertion used to say fifty. It read
    // `HEALTHY * 50 < THRESHOLD` and passed only because HEALTHY was wrong by 6x — the real margin is
    // 11.9x, not 70x (COST-MODEL §1.1, and the corrected block on MAX_BURN_LAMPORTS_PER_ROUND). Ten is
    // asserted rather than eleven so an ordinary retune of the threshold does not red this test for a
    // margin that is still comfortable; anything at or below 10x should be a deliberate decision.
    expect(HEALTHY * 10).toBeLessThan(THRESHOLD);
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
// The sweep-gap stop — the one that is armed while the brake above is still counting
// ---------------------------------------------------------------------------------------------
//
// WHAT IS BEING PROTECTED, AND IT IS NOT THE SAME THING THE BRAKE PROTECTS. The brake needs 45
// samples held in process memory and so has no opinion for ~2.6 hours after every restart — verified
// in production, where two restarts in one day left the live endpoint reading
// `armed: false, samplesObserved: 0 of 45` while the arena ran ~430 rounds/day. This stop is a
// subtraction over chain state, so it is right on the first poll. Its two failure directions are the
// brake's, with the same asymmetry and therefore the same verdict about which tests matter:
//
//   FALSE NEGATIVE   the stop stays open through a real sweep outage. Costs SOL at a rate a human is
//                    watching, with the burn brake arming behind it as a second chance.
//   FALSE POSITIVE   the stop LATCHES a healthy arena shut, and a latched stop needs a person and a
//                    restart to clear. There is no second chance in that direction.

/** A CLOSER THAT HAS CAUGHT UP WITH WHATEVER ARENA IT IS HANDED — its cursor one round past the
 *  retention boundary, which is where a healthy keeper's cursor actually sits and is the position
 *  that makes its stranded ledger COMPLETE.
 *
 *  DERIVED FROM THE ARENA RATHER THAN A LARGE CONSTANT, because the tests below move `round_counter`
 *  from 400 to 900 and a fixed cursor would silently fall behind partway through the table — turning
 *  a test about the THRESHOLD into a test about a rebuild, and passing for the wrong reason. */
const caughtUp = (arena: ReclamationState["arena"], over: Partial<ReclamationState["closer"]> = {}) =>
  closer({ cursor: (arena?.roundCounter ?? 1) - RETENTION + 1, ...over });

/** ONE CALL OF THE STOP against a closer that has caught up with the arena it is given, so that a
 *  test which says nothing about the rebuild is not silently testing one. `ledger` is the stranded
 *  bookkeeping under test; `over` is anything else about the keeper (the latch, mostly). */
const stop = (
  arena: ReclamationState["arena"],
  ledger: Partial<ReclamationState["closer"]> = {},
  over: Partial<ReclamationState> = {},
  thresholds = THRESHOLDS,
) => sweepGapStop(state({ arena, closer: caughtUp(arena, ledger), ...over }), thresholds);

/** The whole verdict, defaulted to the healthy answer so that each test states only what it is about.
 *  WRITTEN OUT RATHER THAN MATCHED LOOSELY: `toMatchObject` would pass on a verdict that had quietly
 *  stopped reporting a field, and three of these six exist so an operator can audit a subtraction that
 *  weakens a safety device. A field that stops being published is exactly the failure worth catching. */
const verdict = (over: Partial<SweepGapVerdict> = {}): SweepGapVerdict => ({
  gap: null, allowance: 0, allowanceCapped: false, ledgerComplete: true, effectiveGap: null,
  tripped: false, ...over,
});

/** A keeper that has ALREADY STOPPED — the latch, as the keeper records it. It is a chain second and
 *  not a boolean because that is what crosses the boundary; `sweepGapStop` reads the same field the
 *  report publishes, so there is one fact rather than two that have to agree. */
const LATCHED: Partial<ReclamationState> = { sweepStoppedSinceSec: 1_759_999_000 };

describe("the sweep-gap stop, below its threshold", () => {
  it("does nothing at the gap a healthy arena actually runs at", () => {
    // ONE, not zero: the live round is opened and is not swept until it settles, so a perfectly
    // healthy arena reads 1 forever. The live endpoint read exactly this against the deployed arena.
    expect(stop(atGap(1))).toEqual(verdict({ gap: 1, effectiveGap: 1 }));
  });

  it("does nothing anywhere inside the retention window, where the rent is not due back yet", () => {
    // THE FLOOR OF THE DERIVATION, walked rather than asserted at one point. `close_round_account`
    // refuses every round inside `MIN_RETAINED_ROUNDS` with `RoundTooRecent` whether or not it was
    // swept, so an unswept round in here has cost nothing: there is no close it prevented. A stop
    // that fired in this range would be stopping a keeper that had lost precisely zero.
    for (let gap = 0; gap <= RETENTION; gap += 1) {
      expect(stop(atGap(gap)).tripped, `gap ${gap}`).toBe(false);
    }
  });

  it("does nothing through the headroom above the window, so a brief backlog is not an outage", () => {
    // THE FIVE ROUNDS THAT SEPARATE "OVERDUE" FROM "STOPPED". A backlog drains at 1 Hz through
    // `closeOneFinishedRound`'s sweep-first branch — twenty-five rounds clear in about twenty-five
    // seconds — so these are the rounds in which a queue that is MOVING gets to finish moving.
    for (let gap = RETENTION + 1; gap < STOP_AT_GAP; gap += 1) {
      expect(stop(atGap(gap)).tripped, `gap ${gap}`).toBe(false);
    }
  });
});

describe("the sweep-gap stop, at and above its threshold", () => {
  it("stops AT the threshold, not one round past it", () => {
    // `>=`, unlike `burnBrake`'s strict `>`, and the boundary is asserted from both sides because the
    // pair is the claim. The brake compares a mean — a continuous quantity where sitting exactly on
    // the ceiling is a real state in which nothing has gone wrong. This compares a COUNT OF ROUNDS:
    // there is no fractional round between 24 and 25, so reaching the count is the event.
    expect(stop(atGap(STOP_AT_GAP - 1)).tripped).toBe(false);
    expect(stop(atGap(STOP_AT_GAP)).tripped).toBe(true);
  });

  it("stays stopped as the gap runs away, and reports the gap it stopped on", () => {
    // The gap is monotonic while the cause persists, so everything past the threshold is the same
    // verdict — and the number is carried out rather than swallowed, because "stopped" and "stopped
    // 500 rounds behind" are the same decision and very different incidents.
    for (const gap of [STOP_AT_GAP + 1, 50, 500]) {
      expect(stop(atGap(gap))).toEqual(verdict({ gap, effectiveGap: gap, tripped: true }));
    }
  });
});

describe("the sweep-gap stop latches, because its input recovers on its own and the leak does not", () => {
  it("stays tripped once latched, even at a gap of one", () => {
    // THE LOAD-BEARING TEST IN THIS BLOCK, and the one failure that is unique to this stop. The burn
    // brake latches by physics — samples are taken at `open_round`, a stopped keeper opens nothing,
    // the mean freezes. THIS input keeps moving: the treasury is still polled, `round_counter` is
    // frozen because nothing is opening, and `rounds_swept` can still rise as the closer sweeps what
    // it can reach. So the gap falls back toward healthy BECAUSE the keeper stopped, and a verdict
    // recomputed from the gap alone would read that recovery as the problem being fixed, reopen the
    // arena, and let the gap climb to the threshold again — an arena flapping between stopped and
    // spending, which is the leak with a duty cycle rather than a brake.
    expect(stop(atGap(1), {}, LATCHED).tripped).toBe(true);
    expect(stop(atGap(0), {}, LATCHED).tripped).toBe(true);
  });

  it("stays tripped when the evidence disappears entirely", () => {
    // A treasury poll that starts failing, or a program that answers with no treasury at all, must
    // not release a stop that has already fired. "I can no longer see the problem" is not "the
    // problem is fixed" — and this is the direction that matters, because the same two nulls are
    // exactly what must never CAUSE a trip (see the block below). The latch is what makes those two
    // positions consistent rather than contradictory.
    expect(stop(null, {}, LATCHED)).toEqual(verdict({
      gap: null, effectiveGap: null, ledgerComplete: false, tripped: true,
    }));
    expect(stop(polled(412, null), {}, LATCHED).tripped).toBe(true);
  });

  it("stays tripped under a threshold no gap could ever reach", () => {
    // The latch is deliberately not conditioned on the configuration being sane. A latch a
    // misconfiguration could release is not a latch — and an operator raising
    // KEEPER_SWEEP_GAP_STOP_ROUNDS is expected to restart, which is the assertion that somebody
    // looked, rather than to have a running keeper quietly resume on the new number.
    expect(stop(atGap(1), {}, LATCHED, { ...THRESHOLDS, stopAtGapRounds: Number.MAX_SAFE_INTEGER }).tripped).toBe(true);
    expect(stop(atGap(1), {}, LATCHED, { ...THRESHOLDS, stopAtGapRounds: 0 }).tripped).toBe(true);
  });
});

describe("what a missing or stale poll is allowed to do, which is nothing", () => {
  it("does not trip when the treasury has never been polled", () => {
    // NOT COMPUTED IS NOT ZERO AND IT IS CERTAINLY NOT A LEAK. This is the state every process is in
    // for its first `TREASURY_POLL_SECONDS`, and a stop that fired here would stop every keeper on
    // every boot.
    // `ledgerComplete: false` — with no poll there is no boundary to show the cursor has caught up
    // with — but the allowance is ZERO rather than the provisional cap, because there is no gap to
    // provision against. A keeper that has not looked publishes nothing it has not claimed.
    expect(stop(null)).toEqual(verdict({ gap: null, effectiveGap: null, ledgerComplete: false }));
  });

  it("does not trip on a program with no Treasury account", () => {
    // `init_treasury` runs on the first sweep, so an arena can legitimately be several rounds old
    // before there is anything to read. A null `roundsSwept` differenced as zero would publish a gap
    // equal to the whole of that arena's history and stop it instantly — which is why `sweepGapOf`
    // answers null rather than defaulting, and why that null is checked here as well as there.
    // The allowance reads 0 rather than the provisional cap here, unlike the never-polled case above:
    // the poll LANDED, so the cursor can be compared against a boundary and the ledger is complete.
    // Only the treasury account is missing, which is what nulls the gap.
    expect(stop(polled(412, null))).toEqual(verdict({ gap: null, effectiveGap: null }));
    // Including at a round count far past the threshold, which is the case that would have fired.
    expect(stop(polled(9_999, null)).tripped).toBe(false);
  });

  it("reads the same at any poll age, because both terms come from one snapshot", () => {
    // THE FAILURE THIS PINS IS THE ONE THAT WAS DESIGNED OUT UPSTREAM, pinned here because nothing
    // else would notice it coming back. If the gap were ever computed from a FRESH `round_counter`
    // against a STALE `rounds_swept`, it would grow without bound purely from a telemetry read
    // failing — the keeper would stop over a problem that was never about money, on an arena that was
    // sweeping perfectly. `pollTreasury` snapshots both terms at one instant, so an ageing reading
    // FREEZES rather than drifts, and this function has no clock in its signature with which to do
    // anything else. A healthy poll stays healthy however old it gets.
    for (const age of [0, 30, 600, 86_400]) {
      const arena = atGap(1, 1_760_000_000 - age);
      expect(stop(arena), `age ${age}s`).toEqual(verdict({ gap: 1, effectiveGap: 1 }));
    }
  });
});

describe("a misconfigured sweep stop does nothing rather than everything", () => {
  it("never trips on a non-positive threshold", () => {
    // `config.ts` refuses such a value at module load, so this is the second of two lines that make
    // it unreachable — and it takes the direction every degenerate case in this file takes, for the
    // reason `burnBrake` argues: a false positive latches an arena that was working, and looks
    // exactly like the fault it claims to have found.
    expect(stop(atGap(500), {}, {}, { ...THRESHOLDS, stopAtGapRounds: 0 }).tripped).toBe(false);
    expect(stop(atGap(500), {}, {}, { ...THRESHOLDS, stopAtGapRounds: -1 }).tripped).toBe(false);
  });

  it("never trips on a gap that is not a finite number", () => {
    // It cannot come from `getAccountInfo`; it can come from arithmetic against something that was
    // `undefined`. A stop that fired on a NaN would fire at random, and this one latches.
    expect(stop(polled(Number.NaN, 400)).tripped).toBe(false);
    expect(stop(polled(400, Number.NaN)).tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The stranded-round allowance — the rounds that are IN the gap and can never come out of it
// ---------------------------------------------------------------------------------------------
//
// THE DEFECT, WITH THE LIVE NUMBERS. Round #295 is terminal and still owned by the Delegation
// Program. Nothing can sweep it and nothing can close it, so `Treasury.rounds_swept` can never catch
// `Arena.round_counter` again: `roundCounter 669, roundsSwept 667` — a gap of 2 where healthy is 1,
// for the life of the program. Twenty-three of the twenty-four rounds of headroom between healthy and
// the stop are left, every future stranded round takes another, and when they run out the stop
// latches a perfectly healthy arena. That is the false positive this file's header calls worse than
// no brake, on a schedule, with nothing to trigger it.
//
// THE FIX HAS ITS OWN TWO DIRECTIONS AND THEY ARE THE SAME SHAPE AS THE STOP'S:
//
//   TOO STINGY   a legitimately stranded round still counts, and the treadmill continues — the defect
//                above, delayed rather than removed.
//   TOO GENEROUS   an OUTAGE is filed as an allowance. A validator that stops returning rounds strands
//                every round in flight, so a total failure arrives as a growing pile of stranded
//                rounds — the same shape as the history being forgiven. If the excuse grows with the
//                gap the stop never fires at all, which is worse than the defect it replaced: the
//                first stops a working arena, the second lets a broken one run.
//
// Every test below is chosen for which of those two it pins.

describe("a round nothing can ever sweep does not count against the stop", () => {
  it("reads the live arena's permanently stranded round as the healthy gap of 1", () => {
    // THE ARENA AS IT ACTUALLY IS, on the day this was written: 669 rounds opened, 667 swept, one
    // round (#295) stranded under the Delegation Program. The raw gap is 2 and will never be 1 again;
    // what the stop is asked about is 1, which is exactly what a healthy arena reads.
    const live = stop(polled(669, 667), { strandedStillDelegated: [295] });
    expect(live.gap).toBe(2);
    expect(live.allowance).toBe(1);
    expect(live.effectiveGap).toBe(1);
    expect(live.tripped).toBe(false);
  });

  it("does not latch a healthy arena that has accumulated a stop's worth of dead rounds", () => {
    // THE DEFECT, EXECUTED. Twenty-four permanently unsweepable rounds plus the live round that is
    // unswept until it settles IS a raw gap of 25 — the threshold, reached with nothing wrong and
    // nothing that any keeper anywhere could have done about it. Before the allowance this stopped the
    // arena and needed a person and a restart to clear.
    const dead = Array.from({ length: 24 }, (_, i) => 100 + i);
    const healthy = stop(atGap(25), { strandedNeverTerminal: dead });
    expect(healthy.gap).toBe(STOP_AT_GAP);
    expect(healthy.effectiveGap).toBe(1);
    expect(healthy.tripped).toBe(false);
  });

  it("counts both kinds of stranding, because neither kind can ever be swept", () => {
    // `never-terminal` needs `Settled` or `Abandoned` and will never have one; `still-delegated` is an
    // account the program cannot read, so `sweep_house_take` fails its owner check exactly as
    // `close_round_account` does. Different prospects for the RENT — forced undelegation may yet
    // return one of them — but identical for the GAP, which is what this stop measures.
    const both = stop(atGap(25), {
      strandedNeverTerminal: [11, 12], strandedStillDelegated: [295],
      strandedNeverTerminalTotal: 12, strandedStillDelegatedTotal: 12,
    });
    expect(both.allowance).toBe(24);
    expect(both.effectiveGap).toBe(1);
  });

  it("still fires on rounds that are merely SLOW to be swept, which is the whole point", () => {
    // THE TEST THAT KEEPS THE FIX HONEST. A backlog of terminal, sweepable, unswept rounds is the
    // outage — `sweep_house_take` is the precondition of every close, so rent stops coming back at the
    // rate rounds are opened. Nothing about it is structural and nothing about it is excused.
    expect(stop(atGap(STOP_AT_GAP)).allowance).toBe(0);
    expect(stop(atGap(STOP_AT_GAP)).tripped).toBe(true);
  });

  it("never excuses a SKIPPED round, which was swept before anything gave up on it", () => {
    // THE ONE WAY THIS ARITHMETIC COULD HAND OUT FREE HEADROOM. `decideClose` answers `sweep-first`
    // before it ever answers `close`, so a round that got as far as being skipped after
    // CLOSE_ATTEMPTS_PER_ROUND failed closes HAD been swept — it is already inside `rounds_swept` and
    // contributes nothing to the gap. Excusing it would subtract a round from the gap that was never
    // in it, which is a stop quietly moved from 25 to 225 by a loss that has nothing to do with
    // sweeping.
    const gaveUp = stop(atGap(STOP_AT_GAP), { skipped: [17, 233], skippedTotal: 200 });
    expect(gaveUp.allowance).toBe(0);
    expect(gaveUp.tripped).toBe(true);
  });

  it("prices the allowance off the totals and never off the fifty-round sample", () => {
    // The lists are capped at CLOSE_LOSS_SAMPLE (50) and the totals are not. AT THE DEFAULT ALLOWANCE
    // OF 25 THE TWO CAN NEVER DISAGREE — the allowance's own cap binds long before the sample bound
    // does — so this is a property that costs nothing today and is the whole difference between a
    // working allowance and a silently wrong one the moment an operator raises
    // KEEPER_STRANDED_ALLOWANCE_ROUNDS past fifty. Asserted at a raised cap for exactly that reason:
    // the version of this bug that already shipped once (`ReclamationReport`'s `count`, read off a
    // bounded list) was invisible until the list filled, and by then it understated by 4x.
    const sample = Array.from({ length: 50 }, (_, i) => 151 + i);
    const many = stop(
      atGap(61),
      { strandedNeverTerminal: sample, strandedNeverTerminalTotal: 60 },
      {},
      { ...THRESHOLDS, strandedAllowanceRounds: 100 },
    );
    expect(many.allowance).toBe(60);
    expect(many.effectiveGap).toBe(1);
    expect(many.tripped).toBe(false);
  });
});

describe("the allowance is capped, so an outage cannot file itself as an excuse", () => {
  it("stops excusing past the cap, and says so", () => {
    const atCap = stop(atGap(26), { strandedNeverTerminalTotal: STRANDED_ALLOWANCE });
    expect(atCap.allowance).toBe(STRANDED_ALLOWANCE);
    expect(atCap.allowanceCapped).toBe(false);
    expect(atCap.effectiveGap).toBe(1);

    // One past it: the allowance is pinned and the extra round starts counting against the stop again,
    // exactly as it did before this mechanism existed. `capped` is the operator's warning that the
    // arena is back on the old treadmill and the decision is now about the program, not a keeper knob.
    const past = stop(atGap(27), { strandedNeverTerminalTotal: STRANDED_ALLOWANCE + 1 });
    expect(past.allowance).toBe(STRANDED_ALLOWANCE);
    expect(past.allowanceCapped).toBe(true);
    expect(past.effectiveGap).toBe(2);
  });

  it("trips on an unbounded pile of stranded rounds, which is what a total outage looks like", () => {
    // A validator that stops returning rounds strands every round in flight, so the pile and the gap
    // grow together. The cap is the only thing that makes the difference between them grow too.
    const outage = stop(atGap(201), { strandedStillDelegatedTotal: 200 });
    expect(outage.allowance).toBe(STRANDED_ALLOWANCE);
    expect(outage.effectiveGap).toBe(176);
    expect(outage.tripped).toBe(true);
  });

  it("fires ~50 rounds into a total stranding outage, walked round by round", () => {
    // THE LOAD-BEARING TEST OF THE CAP, because the danger is not one wide reading — it is the
    // TRAJECTORY. At outage round k the gap is 1 + k, and the closer cannot have recorded a round
    // until its cursor reached it, which it never does inside ROUND_RETENTION: the ledger trails by
    // exactly twenty. So the effective gap PLATEAUS at 21 — four short of the stop — until the
    // allowance saturates, and only the cap ends the plateau.
    const outageAtRound = (k: number, cap = STRANDED_ALLOWANCE) => stop(
      atGap(1 + k),
      { strandedStillDelegatedTotal: Math.max(0, k - RETENTION) },
      {},
      { ...THRESHOLDS, strandedAllowanceRounds: cap },
    );

    // The plateau, at four separate points, so that a change which merely moves it is not mistaken
    // for a change that removes it.
    for (const k of [RETENTION, 24, 44, 45]) {
      expect(outageAtRound(k).effectiveGap, `round ${k}`).toBe(21);
      expect(outageAtRound(k).tripped, `round ${k}`).toBe(false);
    }
    // And where the cap ends it: 49 rounds, ~2.7 hours at ~201s a round, ~1.15 SOL of rent stranded on
    // the way. Against ~25 rounds and ~0.59 SOL with no allowance at all — that half-SOL is what not
    // stopping a healthy arena costs, and 49 beside BURN_ARM_AFTER_ROUNDS's 45 means the burn brake is
    // forming its first opinion at about the same moment rather than being left to do this alone.
    expect(outageAtRound(48).tripped).toBe(false);
    expect(outageAtRound(49).tripped).toBe(true);

    // THE COUNTERFACTUAL, WHICH IS WHY THE CAP EXISTS AT ALL. Uncapped, the same outage never trips —
    // not at a hundred rounds, not at five hundred, not ever. The gap and the excuse grow together and
    // the arena strands 0.023497 SOL a round for as long as it runs, reporting a healthy 21.
    for (const k of [49, 100, 500]) {
      const uncapped = outageAtRound(k, Number.MAX_SAFE_INTEGER);
      expect(uncapped.effectiveGap, `uncapped round ${k}`).toBe(21);
      expect(uncapped.tripped, `uncapped round ${k}`).toBe(false);
    }
  });

  it("excuses nothing at all when the cap is zero or unreadable", () => {
    // ZERO IS THE OPERATOR'S OFF SWITCH and it must mean the stop that shipped before the allowance —
    // the raw gap, compared straight. The unreadable cases go the same way rather than the way every
    // other degenerate case in this file goes, and the asymmetry is deliberate: those protect a
    // safety device from firing on a healthy arena, and this is not the device, it is the thing that
    // WEAKENS it. A weakening nobody can read is not applied.
    const dead = { strandedNeverTerminalTotal: 50 };
    for (const cap of [0, Number.NaN, -5]) {
      const off = stop(atGap(STOP_AT_GAP), dead, {}, { ...THRESHOLDS, strandedAllowanceRounds: cap });
      expect(off.allowance, `cap ${cap}`).toBe(0);
      expect(off.effectiveGap, `cap ${cap}`).toBe(STOP_AT_GAP);
      expect(off.tripped, `cap ${cap}`).toBe(true);
    }
  });

  it("publishes a negative effective gap rather than clamping one away", () => {
    // The only visible symptom of the allowance over-counting — a stranded round the chain nonetheless
    // recorded as swept, so it was never in the gap. Clamping at zero would delete the evidence of the
    // one way this arithmetic can be too generous. A negative number trips nothing.
    const over = stop(atGap(1), { strandedNeverTerminalTotal: 3 });
    expect(over.effectiveGap).toBe(-2);
    expect(over.tripped).toBe(false);
  });
});

describe("the stranded ledger is process state, and a restart must not read as an outage", () => {
  // THE WINDOW. `closer.stranded` lives on `KeeperContext` and starts EMPTY on every boot; the rounds
  // it describes do not. So for the minutes a fresh keeper spends re-walking history, the raw gap is
  // its full self and the RECORDED allowance is zero — and an arena with two dozen dead rounds would
  // latch its stop on the first `open_round` after every restart. Same class of defect as the
  // close-cursor walk in 9d53b99, where transient process state made a healthy arena publish a
  // 2.39-day runway.
  //
  // WHAT THE KEEPER DOES ABOUT IT IS THE SUBJECT OF THIS BLOCK, and the first four tests are one
  // argument: while it has not finished looking it grants the WHOLE CAP rather than the little it has
  // counted, and goes on deciding. It does not wait for the closer. The last two are why.

  /** A keeper that has just booted: cursor at #1, nothing recorded, nothing walked yet. */
  const rebuilding = (over: Partial<ReclamationState["closer"]> = {}) =>
    closer({ cursor: 1, closing: true, ...over });

  const midRebuild = (arena: ReclamationState["arena"], over: Partial<ReclamationState> = {}) =>
    sweepGapStop(state({ arena, closer: rebuilding(), ...over }), THRESHOLDS);

  it("does not trip on an arena whose gap its own dead rounds could explain", () => {
    // The defect, on the pass it would have happened. Twenty-four dead rounds plus the live one is a
    // raw gap of 25 and the ledger is empty, so a stop reading the recorded allowance would compare
    // 25 against 25 and latch. The cap is granted instead: 25 − 25 = 0.
    const justBooted = midRebuild(atGap(25));
    expect(justBooted.ledgerComplete).toBe(false);
    expect(justBooted.allowance).toBe(STRANDED_ALLOWANCE);  // granted, not counted
    expect(justBooted.effectiveGap).toBe(0);
    expect(justBooted.tripped).toBe(false);

    // AND THE PROVISION NEVER EXCEEDS THE GAP IT IS PROVISIONED AGAINST. On the live arena — raw gap
    // 2 — a flat grant of the cap would publish `effectiveGap: -23` for the first minutes of every
    // restart. A negative effective gap is a real signal (the allowance over-counting), and one that
    // fires on every ordinary restart is a signal nobody reads on the day it means something.
    const ordinary = midRebuild(polled(669, 667));
    expect(ordinary.allowance).toBe(2);
    expect(ordinary.effectiveGap).toBe(0);
  });

  it("reads the same arena the same way once the walk has finished", () => {
    // The same keeper a couple of minutes later, on an arena that has not changed: the cursor has
    // caught up, the twenty-four dead rounds are in the ledger, and the answer is the 1 it always was.
    // The provision was replaced by the count and the verdict did not move — which is the property
    // that makes granting the cap up front safe rather than merely convenient.
    const walked = stop(atGap(25), { strandedNeverTerminalTotal: 24 });
    expect(walked.ledgerComplete).toBe(true);
    expect(walked.allowance).toBe(24);
    expect(walked.effectiveGap).toBe(1);
    expect(walked.tripped).toBe(false);
  });

  it("STILL trips mid-rebuild on a gap no amount of further looking could excuse", () => {
    // THE TEST THAT KEEPS THE PROVISION HONEST. The cap is the most the ledger could ever add, so a
    // gap still past the threshold after granting all of it is a gap that is not about stranded
    // rounds. The keeper does not have to finish walking to know that, and it does not wait.
    const outage = midRebuild(atGap(STOP_AT_GAP + STRANDED_ALLOWANCE));
    expect(outage.ledgerComplete).toBe(false);
    expect(outage.effectiveGap).toBe(STOP_AT_GAP);
    expect(outage.tripped).toBe(true);
  });

  it("costs the same 25 rounds it costs everywhere else, and never more", () => {
    // THE WORST CASE IS UNIFORM, which is what makes the bound in config.ts the bound in every state
    // rather than in the lucky one. A keeper that never finishes its walk — see the two tests below —
    // trips exactly `cap` rounds later than one that has, and `cap` is the number the operator already
    // accepted. One round below the line, and one round over it.
    expect(midRebuild(atGap(STOP_AT_GAP + STRANDED_ALLOWANCE - 1)).tripped).toBe(false);
    expect(midRebuild(atGap(STOP_AT_GAP + STRANDED_ALLOWANCE)).tripped).toBe(true);
  });

  it("cannot be switched off by a closer that has stopped walking, which was the first design", () => {
    // THE DEFECT IN THE VERSION THIS REPLACED, PINNED SO IT CANNOT COME BACK. That version refused to
    // trip at all while the ledger was incomplete — and "incomplete" is a state a BROKEN keeper sits
    // in permanently: `closeOneFinishedRound` awaits `fetchRound` and `isDelegated` outside any
    // `try`, and `withReadRetry` rethrows, so one round below the retention boundary that cannot be
    // read wedges the cursor there for the life of the process. Under a veto that arena's stop was
    // disabled while it went on spending. Here the cursor is stuck at #300 with an empty ledger and a
    // runaway gap, and the stop fires.
    const wedged = sweepGapStop(state({
      arena: atGap(500), closer: rebuilding({ cursor: 300 }),
    }), THRESHOLDS);
    expect(wedged.ledgerComplete).toBe(false);
    expect(wedged.tripped).toBe(true);
  });

  it("is not fooled by one pass of ordinary housekeeping in the middle of a rebuild", () => {
    // THE OTHER HALF OF THE SAME MISTAKE. The rejected design also treated "the cursor did not advance
    // this pass" as proof the closer had finished — so a `sweep-first` (which is one pass of
    // housekeeping on a healthy arena: swept now, closed next pass) or a single close failure (which
    // CLOSE_ATTEMPTS_PER_ROUND exists to ride out) would have declared an EMPTY ledger complete and
    // handed the raw gap of 26 straight to the threshold. Nothing about a single pass is an input to
    // this any more: what the closer is doing right now cannot change the verdict, only how far it has
    // WALKED can.
    const stalled = sweepGapStop(state({
      arena: atGap(26), closer: rebuilding({ cursor: 300 }),
    }), THRESHOLDS);
    expect(stalled.effectiveGap).toBe(1);
    expect(stalled.tripped).toBe(false);
  });

  it("grants nothing to a keeper whose closer is not running at all", () => {
    // No `--close-rounds`, or an IDL with no `close_round_account`. The cursor will never move and the
    // ledger will never fill, so there is nothing to provision FOR — the allowance is permanently zero
    // and this is exactly the stop that shipped before it existed. Correct, and not a regression: a
    // keeper that closes nothing is not reclaiming rent at all.
    const noCloser = sweepGapStop(state({
      arena: atGap(25), closer: closer({ cursor: 1, closing: false }),
    }), THRESHOLDS);
    expect(noCloser.ledgerComplete).toBe(true);
    expect(noCloser.allowance).toBe(0);
    expect(noCloser.tripped).toBe(true);
  });

  it("is complete immediately on an arena younger than its own retention window", () => {
    // There is no history to re-walk. `isPastRetention`'s underflow argument in `roundCloser.ts`, in
    // this file's terms: a cursor at #1 against a `round_counter` of 4 has already seen everything
    // there is, and the comparison is written as addition so it says so rather than going negative.
    const young = sweepGapStop(state({
      arena: polled(4, 3), closer: closer({ cursor: 1 }),
    }), THRESHOLDS);
    expect(young.ledgerComplete).toBe(true);
    expect(young.gap).toBe(1);
  });

  it("turns the allowance off completely at a cap of zero, in BOTH ledger states", () => {
    // The operator's kill switch has to be a kill switch. `config.ts` promises that zero means "the
    // stop compares the raw gap, exactly as it did before this existed" — and a version of that
    // promise that held only once the closer had caught up would leave half the mechanism running in
    // the window an operator reaching for the switch is most likely to be in.
    const off = { ...THRESHOLDS, strandedAllowanceRounds: 0 };
    const walked = stop(atGap(STOP_AT_GAP), { strandedNeverTerminalTotal: 50 }, {}, off);
    const booting = sweepGapStop(state({ arena: atGap(STOP_AT_GAP), closer: rebuilding() }), off);
    for (const [name, v] of [["caught up", walked], ["rebuilding", booting]] as const) {
      expect(v.allowance, name).toBe(0);
      expect(v.effectiveGap, name).toBe(STOP_AT_GAP);
      expect(v.tripped, name).toBe(true);
      // AND `capped` STAYS FALSE, because there was no ceiling to reach. It reads "the allowance was
      // working and ran out", which is a thing to act on; an operator who set the knob to zero already
      // knows what they did, and a permanently-true alert field is one nobody reads.
      expect(v.allowanceCapped, name).toBe(false);
    }
  });

  it("cannot release a latch, whatever the ledger says", () => {
    // Both new inputs, against the rule that outranks them. A stop that could be un-fired by an
    // allowance that grew after the fact — and it does keep growing, because the closer keeps walking
    // after the keeper stops — would be an arena flapping between stopped and spending, which is the
    // leak with a duty cycle rather than a brake.
    const generous = stop(atGap(1), { strandedNeverTerminalTotal: 500 }, LATCHED);
    expect(generous.effectiveGap).toBeLessThan(0);
    expect(generous.tripped).toBe(true);

    const booting = midRebuild(atGap(1), LATCHED);
    expect(booting.ledgerComplete).toBe(false);
    expect(booting.tripped).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

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

  it("publishes the stop beside the gap, with the threshold a reader would otherwise guess", () => {
    // The threshold is published for `staleAfterSeconds`' reason: the keeper is the only party that
    // knows what it stops at, and a reader inventing one would be reading a healthy gap as a near
    // miss or vice versa.
    const report = summarise(state());
    expect(report.sweep).toEqual({
      tripped: false,
      stopAtGapRounds: STOP_AT_GAP,
      // THE THREE NUMBERS OF ONE DECISION, PUBLISHED SEPARATELY. The raw gap is the top-level
      // `sweepGap` (3 here); the allowance is what was taken off it for rounds nothing can sweep; the
      // effective gap is what the threshold above was actually compared against. An operator handed
      // any two of them has to do the third in their head during an incident, which is where a factor
      // of a thousand comes from in the burn block and where a wrong "the stop is broken" comes from
      // here. `capped` and `ledgerComplete` are the two ways the allowance can be lying by omission,
      // so they are published beside it rather than left to be inferred from `closer.stranded`.
      effectiveGap: 3,
      allowance: {
        rounds: 0, capRounds: STRANDED_ALLOWANCE, capped: false, ledgerComplete: true,
      },
      stoppedSinceSec: null,
    });
  });

  it("says TRIPPED off the keeper's latch and not off the gap it is looking at", () => {
    // THE DISTINCTION THIS BLOCK EXISTS FOR, and the one place `sweep` reads differently from `burn`.
    // The brake's samples freeze when it stops, so recomputing `burn.tripped` from them IS its latch.
    // This stop's input recovers on its own the moment the keeper stops opening rounds — so a report
    // that recomputed `tripped` from the gap would say `false` about a keeper that is stopped, on the
    // one endpoint somebody opens to find out why it stopped.
    const stopped = state({ arena: atGap(1), sweepStoppedSinceSec: 1_759_999_000 });
    expect(stopped.arena!.roundCounter - stopped.arena!.roundsSwept!).toBe(1); // a healthy-looking gap
    expect(summarise(stopped).sweepGap).toBe(1);
    expect(summarise(stopped).sweep.tripped).toBe(true);
    expect(summarise(stopped).sweep.stoppedSinceSec).toBe(1_759_999_000);
  });

  it("reports the stop as tripped on a wide gap even before the keeper has latched it", () => {
    // The pass in which it first fires: the verdict is true from the gap alone, and the keeper writes
    // its latch on the strength of it. Without this the test above would pass on a report that only
    // ever echoed the latch back and had stopped reading the chain at all.
    const wide = state({
      arena: atGap(STOP_AT_GAP), closer: caughtUp(atGap(STOP_AT_GAP)), sweepStoppedSinceSec: null,
    });
    expect(summarise(wide).sweep.tripped).toBe(true);
    expect(summarise(wide).sweep.stoppedSinceSec).toBeNull();
  });

  it("shows the raw gap, the allowance and the effective gap as three separate numbers", () => {
    // AN ALLOWANCE NOBODY CAN SEE IS ONE NOBODY CAN AUDIT. This subtraction deliberately weakens a
    // safety stop, so the endpoint has to show the number the chain reported, the number the keeper
    // took off it, and the number it actually compared — a reader given any two of the three has to do
    // the arithmetic in their head during an incident. The raw gap stays at the top level, where it is
    // the only figure in this report that can be checked against `getAccountInfo` by hand.
    const report = summarise(state({
      arena: polled(669, 667), closer: caughtUp(polled(669, 667), { strandedStillDelegated: [295] }),
    }));
    expect(report.sweepGap).toBe(2);
    expect(report.sweep.allowance.rounds).toBe(1);
    expect(report.sweep.effectiveGap).toBe(1);
    expect(report.sweep.tripped).toBe(false);
  });

  it("says when the allowance has hit its cap, which is the field to alert on", () => {
    // From here every further stranded round spends real headroom again and this stop is back on the
    // treadmill the allowance removed. It is a different conversation from the one `capped: false`
    // supports — about the program rather than about a keeper knob — so it is published rather than
    // inferred from comparing two other numbers.
    const report = summarise(state({
      arena: atGap(80), closer: caughtUp(atGap(80), { strandedNeverTerminalTotal: 79 }),
    }));
    expect(report.sweep.allowance).toEqual({
      rounds: STRANDED_ALLOWANCE, capRounds: STRANDED_ALLOWANCE, capped: true, ledgerComplete: true,
    });
    expect(report.sweep.effectiveGap).toBe(55);
    expect(report.sweep.tripped).toBe(true);
  });

  it("says when the allowance is a PROVISION rather than a count, which is a different number", () => {
    // `burn.samplingSuspended`'s reason, applied to the other stop: it is why a published number is
    // not what a reader expects. Here `allowance.rounds` is 25 while the closer has recorded NOTHING —
    // the keeper has not finished looking and is assuming the worst case for itself. Without
    // `ledgerComplete` beside it, that renders identically to "the keeper found 25 dead rounds", and
    // this endpoint's whole audience is somebody reading it during an incident minutes after a
    // restart.
    const report = summarise(state({
      arena: atGap(30), closer: closer({ cursor: 1, strandedNeverTerminalTotal: 0 }),
    }));
    expect(report.sweep.allowance.ledgerComplete).toBe(false);
    expect(report.sweep.allowance.rounds).toBe(STRANDED_ALLOWANCE);
    expect(report.closer.stranded.count).toBe(0);   // and nothing is claimed to have been FOUND
    expect(report.sweep.effectiveGap).toBe(5);
    expect(report.sweep.tripped).toBe(false);
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
    // ~0.178 SOL/day — the CORRECTED headline in COST-MODEL §0, arrived at from the other direction.
    // Was 0.0297 here, matching a §0 that was wrong by 6x; both moved together, which is the point of
    // pinning a document's number in a test at all.
    expect(report.burn.solPerDay!).toBeCloseTo(0.178, 3);
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

  it("says when the keeper is holding samples back on purpose", () => {
    // THE THIRD THING `samplesObserved: 0 of 45` CAN MEAN, and the reason it is published rather than
    // inferred. A young arena, a keeper that has just restarted, and a keeper that is deliberately not
    // sampling all render identically without this field — and this endpoint's entire audience is
    // somebody reading it during an incident. `KeeperContext.closeCatchUpAhead` in keeper.ts owns the
    // predicate: sampling is suspended only while the closer is walking rounds it has already closed,
    // across which no rent comes back and every sample reads as a total outage.
    expect(summarise(state()).burn.samplingSuspended).toBe(false);
    const held = summarise(state({ burnSamplesLamports: [], burnSamplingSuspended: true }));
    expect(held.burn.samplingSuspended).toBe(true);
    expect(held.burn.samplesObserved).toBe(0);
    expect(held.burn.armed).toBe(false);
  });

  it("does not let a suspension null out or alter a measurement that exists", () => {
    // The suspension explains a HISTORY, not a number. Samples taken before it are still true about
    // the rounds they were taken across, and hiding them would delete evidence at the one moment
    // somebody is reading for it. Nothing in `summariseReclamation` may branch on this field.
    const running = summarise(state({ burnSamplesLamports: run(HEALTHY, ARM_AFTER) }));
    const suspended = summarise(state({
      burnSamplesLamports: run(HEALTHY, ARM_AFTER), burnSamplingSuspended: true,
    }));
    expect(suspended.burn.meanLamportsPerRound).toBe(running.burn.meanLamportsPerRound);
    expect(suspended.burn.armed).toBe(running.burn.armed);
    expect(suspended.burn.tripped).toBe(running.burn.tripped);
    expect(suspended.runwayDays).toBe(running.runwayDays);
  });

  it("carries the outage through to SOL/day at the rate that empties the wallet", () => {
    const report = summarise(state({ burnSamplesLamports: run(BROKEN, ARM_AFTER) }));
    expect(report.burn.tripped).toBe(true);
    // COST-MODEL §0's outage rate, which is the whole reason this endpoint exists. ~10.14 rather than
    // the 9.96 asserted before: a broken round pays the ordinary burn AND the unreturned rent, and
    // BROKEN is now the sum rather than the rent alone. The risk is unchanged — what moved is the
    // healthy side, not the outage.
    expect(report.burn.solPerDay!).toBeCloseTo(10.14, 2);
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
