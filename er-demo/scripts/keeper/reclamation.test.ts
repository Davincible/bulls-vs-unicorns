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
  type ReclamationState,
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

const run = (value: number, count: number): number[] => Array.from({ length: count }, () => value);

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

/** The keeper's own snapshot shape, built the way `pollTreasury` builds it — both terms read at one
 *  instant, which is the property the staleness argument in `sweepGapStop` rests on. */
const polled = (roundCounter: number, roundsSwept: number | null, polledAtSec = 1_759_999_940) =>
  ({ roundCounter, roundsSwept, polledAtSec });

/** A poll showing exactly `gap` unswept rounds. */
const atGap = (gap: number, polledAtSec?: number) => polled(400 + gap, 400, polledAtSec);

describe("the sweep-gap stop, below its threshold", () => {
  it("does nothing at the gap a healthy arena actually runs at", () => {
    // ONE, not zero: the live round is opened and is not swept until it settles, so a perfectly
    // healthy arena reads 1 forever. The live endpoint read exactly this against the deployed arena.
    expect(sweepGapStop(atGap(1), STOP_AT_GAP, false)).toEqual({ gap: 1, tripped: false });
  });

  it("does nothing anywhere inside the retention window, where the rent is not due back yet", () => {
    // THE FLOOR OF THE DERIVATION, walked rather than asserted at one point. `close_round_account`
    // refuses every round inside `MIN_RETAINED_ROUNDS` with `RoundTooRecent` whether or not it was
    // swept, so an unswept round in here has cost nothing: there is no close it prevented. A stop
    // that fired in this range would be stopping a keeper that had lost precisely zero.
    for (let gap = 0; gap <= RETENTION; gap += 1) {
      expect(sweepGapStop(atGap(gap), STOP_AT_GAP, false).tripped, `gap ${gap}`).toBe(false);
    }
  });

  it("does nothing through the headroom above the window, so a brief backlog is not an outage", () => {
    // THE FIVE ROUNDS THAT SEPARATE "OVERDUE" FROM "STOPPED". A backlog drains at 1 Hz through
    // `closeOneFinishedRound`'s sweep-first branch — twenty-five rounds clear in about twenty-five
    // seconds — so these are the rounds in which a queue that is MOVING gets to finish moving.
    for (let gap = RETENTION + 1; gap < STOP_AT_GAP; gap += 1) {
      expect(sweepGapStop(atGap(gap), STOP_AT_GAP, false).tripped, `gap ${gap}`).toBe(false);
    }
  });
});

describe("the sweep-gap stop, at and above its threshold", () => {
  it("stops AT the threshold, not one round past it", () => {
    // `>=`, unlike `burnBrake`'s strict `>`, and the boundary is asserted from both sides because the
    // pair is the claim. The brake compares a mean — a continuous quantity where sitting exactly on
    // the ceiling is a real state in which nothing has gone wrong. This compares a COUNT OF ROUNDS:
    // there is no fractional round between 24 and 25, so reaching the count is the event.
    expect(sweepGapStop(atGap(STOP_AT_GAP - 1), STOP_AT_GAP, false).tripped).toBe(false);
    expect(sweepGapStop(atGap(STOP_AT_GAP), STOP_AT_GAP, false).tripped).toBe(true);
  });

  it("stays stopped as the gap runs away, and reports the gap it stopped on", () => {
    // The gap is monotonic while the cause persists, so everything past the threshold is the same
    // verdict — and the number is carried out rather than swallowed, because "stopped" and "stopped
    // 500 rounds behind" are the same decision and very different incidents.
    for (const gap of [STOP_AT_GAP + 1, 50, 500]) {
      expect(sweepGapStop(atGap(gap), STOP_AT_GAP, false)).toEqual({ gap, tripped: true });
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
    expect(sweepGapStop(atGap(1), STOP_AT_GAP, true).tripped).toBe(true);
    expect(sweepGapStop(atGap(0), STOP_AT_GAP, true).tripped).toBe(true);
  });

  it("stays tripped when the evidence disappears entirely", () => {
    // A treasury poll that starts failing, or a program that answers with no treasury at all, must
    // not release a stop that has already fired. "I can no longer see the problem" is not "the
    // problem is fixed" — and this is the direction that matters, because the same two nulls are
    // exactly what must never CAUSE a trip (see the block below). The latch is what makes those two
    // positions consistent rather than contradictory.
    expect(sweepGapStop(null, STOP_AT_GAP, true)).toEqual({ gap: null, tripped: true });
    expect(sweepGapStop(polled(412, null), STOP_AT_GAP, true).tripped).toBe(true);
  });

  it("stays tripped under a threshold no gap could ever reach", () => {
    // The latch is deliberately not conditioned on the configuration being sane. A latch a
    // misconfiguration could release is not a latch — and an operator raising
    // KEEPER_SWEEP_GAP_STOP_ROUNDS is expected to restart, which is the assertion that somebody
    // looked, rather than to have a running keeper quietly resume on the new number.
    expect(sweepGapStop(atGap(1), Number.MAX_SAFE_INTEGER, true).tripped).toBe(true);
    expect(sweepGapStop(atGap(1), 0, true).tripped).toBe(true);
  });
});

describe("what a missing or stale poll is allowed to do, which is nothing", () => {
  it("does not trip when the treasury has never been polled", () => {
    // NOT COMPUTED IS NOT ZERO AND IT IS CERTAINLY NOT A LEAK. This is the state every process is in
    // for its first `TREASURY_POLL_SECONDS`, and a stop that fired here would stop every keeper on
    // every boot.
    expect(sweepGapStop(null, STOP_AT_GAP, false)).toEqual({ gap: null, tripped: false });
  });

  it("does not trip on a program with no Treasury account", () => {
    // `init_treasury` runs on the first sweep, so an arena can legitimately be several rounds old
    // before there is anything to read. A null `roundsSwept` differenced as zero would publish a gap
    // equal to the whole of that arena's history and stop it instantly — which is why `sweepGapOf`
    // answers null rather than defaulting, and why that null is checked here as well as there.
    expect(sweepGapStop(polled(412, null), STOP_AT_GAP, false)).toEqual({ gap: null, tripped: false });
    // Including at a round count far past the threshold, which is the case that would have fired.
    expect(sweepGapStop(polled(9_999, null), STOP_AT_GAP, false).tripped).toBe(false);
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
      expect(sweepGapStop(arena, STOP_AT_GAP, false), `age ${age}s`)
        .toEqual({ gap: 1, tripped: false });
    }
  });
});

describe("a misconfigured sweep stop does nothing rather than everything", () => {
  it("never trips on a non-positive threshold", () => {
    // `config.ts` refuses such a value at module load, so this is the second of two lines that make
    // it unreachable — and it takes the direction every degenerate case in this file takes, for the
    // reason `burnBrake` argues: a false positive latches an arena that was working, and looks
    // exactly like the fault it claims to have found.
    expect(sweepGapStop(atGap(500), 0, false).tripped).toBe(false);
    expect(sweepGapStop(atGap(500), -1, false).tripped).toBe(false);
  });

  it("never trips on a gap that is not a finite number", () => {
    // It cannot come from `getAccountInfo`; it can come from arithmetic against something that was
    // `undefined`. A stop that fired on a NaN would fire at random, and this one latches.
    expect(sweepGapStop(polled(Number.NaN, 400), STOP_AT_GAP, false).tripped).toBe(false);
    expect(sweepGapStop(polled(400, Number.NaN), STOP_AT_GAP, false).tripped).toBe(false);
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
};

const summarise = (s: ReclamationState) => summariseReclamation(s, THRESHOLDS, ROUNDS_PER_DAY);

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
    expect(report.sweep).toEqual({ tripped: false, stopAtGapRounds: STOP_AT_GAP, stoppedSinceSec: null });
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
    const wide = state({ arena: atGap(STOP_AT_GAP), sweepStoppedSinceSec: null });
    expect(summarise(wide).sweep.tripped).toBe(true);
    expect(summarise(wide).sweep.stoppedSinceSec).toBeNull();
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
