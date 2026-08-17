// THE WATCHDOG ON THE MAIN LOOP — the tests for the thing that was missing on 2026-08-16.
//
// WHAT EACH TEST HERE IS ACTUALLY DEFENDING. This module's job is to fire on one condition and on no
// other, and both halves of that are expensive to get wrong in opposite directions:
//
//   * NOT FIRING is the incident. The keeper finished round #678 at 08:53:38Z, went silent for 22
//     hours, and every existing signal read healthy throughout. A watchdog that can be satisfied by a
//     hung process is the same 22 hours with more code.
//   * FIRING WRONGLY IS WORSE THAN THE INCIDENT, which is why more than half of these tests are
//     about the cases that must NOT trip it. Stage 2 calls `process.exit(1)`, Fly's `on-fail` policy
//     allows only 10 restarts in a 5-minute window, and `auto_start_machines = false` means a machine
//     that exhausts that budget is left `stopped` until a human notices. A watchdog that fired on a
//     devnet outage would convert a 22-hour outage into a permanent one.
//
// Time is injected, not faked globally: `monotonicMs` is a closure over a number these tests move by
// hand. That is not a convenience — the module's real clock is `performance.now()` deliberately (see
// `LoopWatchdogOptions.monotonicMs` on why wall-clock time is the wrong source for a watchdog), and
// a test that reached for `vi.useFakeTimers` would be testing a clock this module does not use.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DELEGATION_WAIT_SECONDS, ERROR_BACKOFF_MAX_SECONDS, LOOP_INTERVAL_SECONDS,
  LOOP_STALL_EXIT_SECONDS, LOOP_STALL_PUBLISH_SECONDS, READ_RETRY_DELAYS_MS,
  RESOLVE_RETRY_ATTEMPTS, RESOLVE_RETRY_WAIT_SECONDS, UNDELEGATE_WAIT_SECONDS,
} from "./config.ts";
import { createLoopWatchdog, type LoopWatchdog } from "./loopWatchdog.ts";

const PUBLISH_AFTER = 180;
const EXIT_AFTER = 360;

// SILENCED, NOT IGNORED. Tripping this watchdog writes twelve deliberate lines to stderr, and a
// suite that let them through would bury every real failure in the run under the sound of tests
// working correctly. They are still ASSERTED — see "logs the diagnosis at both stages", which reads
// this same spy — so muting them here costs no coverage.
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => { stderr = vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { stderr.mockRestore(); });

interface Harness {
  watchdog: LoopWatchdog;
  /** Make `onStall` throw, to exercise the two halves of stage 1 failing independently. */
  breakOnStall(): void;
  /** Move the injected monotonic clock forward. */
  advance(seconds: number): void;
  /** Run one heartbeat's worth of checking. */
  beat(): void;
  /** Advance in HEARTBEAT-SIZED STEPS, checking at each one, which is what production does. A test
   *  that jumped straight to the threshold and checked once would pass against an implementation
   *  that only fires on an exact equality — and the real heartbeat lands wherever it lands. */
  runFor(seconds: number, stepSeconds?: number): void;
  stalls: number;
  exits: number[];
}

function harness(over: { publishAfter?: number; exitAfter?: number } = {}): Harness {
  let ms = 1_000;
  const state = { stalls: 0, exits: [] as number[], stallThrows: false };
  const watchdog = createLoopWatchdog({
    publishAfterSeconds: over.publishAfter ?? PUBLISH_AFTER,
    exitAfterSeconds: over.exitAfter ?? EXIT_AFTER,
    onStall: () => {
      state.stalls += 1;
      if (state.stallThrows) throw new Error("the status file could not be written");
    },
    exit: (code) => { state.exits.push(code); },
    monotonicMs: () => ms,
  });
  const h: Harness = {
    watchdog,
    breakOnStall() { state.stallThrows = true; },
    advance(seconds) { ms += seconds * 1_000; },
    beat() { watchdog.check(); },
    runFor(seconds, stepSeconds = 2) {
      for (let elapsed = 0; elapsed < seconds; elapsed += stepSeconds) {
        h.advance(stepSeconds);
        watchdog.check();
      }
    },
    get stalls() { return state.stalls; },
    get exits() { return state.exits; },
  };
  return h;
}

describe("a loop that keeps completing passes", () => {
  it("never trips the watchdog, over an hour of ordinary 1Hz passes", () => {
    const h = harness();
    h.watchdog.arm();
    // An hour at the real cadence. `LOOP_INTERVAL_SECONDS` is 1, so 3,600 passes — comfortably past
    // both thresholds several times over, which is the point: the watchdog must be measuring the GAP
    // between passes and not the time since arming.
    for (let pass = 0; pass < 3_600; pass++) {
      h.advance(LOOP_INTERVAL_SECONDS);
      h.watchdog.check();
      h.watchdog.passCompleted();
    }
    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
    expect(h.watchdog.liveness().stalled).toBe(false);
  });

  it("does not trip on the worst legitimate pass — the round transition", () => {
    // THE PASS THAT BROKE THE FIRST VERSION OF THIS THRESHOLD, modelled here from the code path
    // rather than from the estimate, because the estimate is exactly what was wrong.
    //
    // The first derivation priced the worst pass at ~120s: `readChainState`, one `close_round` at
    // blockhash expiry, and `waitForUndelegation`. It set the threshold at 180 and it was UNDER a
    // pass the keeper takes at the top of EVERY ROUND. What it missed, traced through `driveSettled`
    // with the round home and the hold expired:
    //
    //   * `sweepHouseTake` runs FIRST and SWALLOWS its failure on purpose — the take stays on the
    //     round and anyone can sweep it later. So a `sweep_house_take` that runs all the way to
    //     blockhash expiry costs its full window AND THE PASS CARRIES ON. That is the term the first
    //     derivation had no line for at all.
    //   * `openNextRound` then follows IN THE SAME PASS: `open_round`, `delegate_round` plus
    //     `waitForDelegation`, and `fundHouseBank`, which at HOUSE_WALLET_COUNT = 48 is
    //     `ceil(48/15)` = four SEQUENTIAL confirmed base-layer transactions.
    //   * those all THROW on expiry, so at most one of them reaches the wire before the pass unwinds
    //     — which is the only reason this is bounded at two stacked expiries and not five.
    //
    // Built from the real constants, so it re-derives when they move instead of restating a number
    // somebody typed. `BLOCKHASH_EXPIRY` is the one figure that is not a config value, because it is
    // not ours: 150 slots is a Solana protocol constant, ~60s, taken at 90 for an unwell devnet.
    const BLOCKHASH_EXPIRY = 90;
    const readChainState = READ_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 1_000 * 3;
    const worstLegitimatePass =
      readChainState                          // the read at the top of the pass
      + BLOCKHASH_EXPIRY                      // sweep_house_take, expiring, SWALLOWED — pass continues
      + BLOCKHASH_EXPIRY                      // one throwing send in openNextRound, expiring
      + DELEGATION_WAIT_SECONDS               // waitForDelegation, bounded
      + readChainState;                       // the refreshAfterStep re-read

    // The corrected figure is ~220s, which is why the threshold is 300 and not 180. Asserted against
    // the SHIPPING constant, not against `PUBLISH_AFTER`, so retuning the env default has to come
    // back through this test.
    expect(worstLegitimatePass).toBeGreaterThan(180);
    expect(LOOP_STALL_PUBLISH_SECONDS).toBeGreaterThan(worstLegitimatePass);

    // And the watchdog genuinely sits through it without firing.
    const h = harness({ publishAfter: LOOP_STALL_PUBLISH_SECONDS, exitAfter: LOOP_STALL_EXIT_SECONDS });
    h.watchdog.arm();
    h.runFor(worstLegitimatePass);
    h.watchdog.passCompleted();

    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it("does not trip on that same worst pass followed by a full error backoff", () => {
    // The two worst terms in sequence, which is the widest gap between two marks that a HEALTHY
    // keeper can produce: a maximally slow transition pass whose last send then throws, so the
    // `catch` marks and sleeps out ERROR_BACKOFF_MAX_SECONDS before the next pass begins.
    const BLOCKHASH_EXPIRY = 90;
    const readChainState = READ_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) / 1_000 * 3;
    const worstGap = readChainState + BLOCKHASH_EXPIRY * 2 + DELEGATION_WAIT_SECONDS
      + readChainState + ERROR_BACKOFF_MAX_SECONDS;

    expect(LOOP_STALL_PUBLISH_SECONDS).toBeGreaterThan(worstGap);

    const h = harness({ publishAfter: LOOP_STALL_PUBLISH_SECONDS, exitAfter: LOOP_STALL_EXIT_SECONDS });
    h.watchdog.arm();
    h.runFor(worstGap);
    h.watchdog.passCompleted();
    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it("does not trip on a keeper backing off through a devnet outage", () => {
    // THE CASE THAT MATTERS MOST, and the one that decides whether this watchdog is safe to point at
    // `process.exit`. A loop failing every pass is ALIVE and ITERATING — it catches, records, sleeps
    // up to ERROR_BACKOFF_MAX_SECONDS and goes round again — and a restart does not fix devnet. So
    // the main loop marks a completed pass on the ERROR path too, and this is what that buys.
    //
    // Firing here would restart the machine on a condition the replacement inherits, on repeat, until
    // Fly's 10-restarts-in-5-minutes budget was spent and the machine left `stopped` for good with
    // `auto_start_machines = false`. That is a permanent outage manufactured out of a transient one.
    const h = harness();
    h.watchdog.arm();
    // Two hours of nothing but failing passes: a failing pass burns its read-retry budget (~15s) and
    // is then followed by a full backoff sleep.
    const failingPassSeconds = 15 + ERROR_BACKOFF_MAX_SECONDS;
    expect(failingPassSeconds).toBeLessThan(PUBLISH_AFTER);
    for (let pass = 0; pass < 7_200 / failingPassSeconds; pass++) {
      h.runFor(failingPassSeconds);
      h.watchdog.passCompleted(); // the `catch` branch's mark
    }
    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it("recovers: a pass that lands after the stall was published clears the stall", () => {
    const h = harness();
    h.watchdog.arm();
    h.runFor(PUBLISH_AFTER + 10);
    expect(h.watchdog.liveness().stalled).toBe(true);

    h.watchdog.passCompleted();
    expect(h.watchdog.liveness().stalled).toBe(false);
    // And it never reaches the exit, because the clock is measured from the LAST pass and not from
    // the stall. A keeper that comes back on its own must not be killed for having been late — the
    // total elapsed time here is well past `EXIT_AFTER`, and the only thing that saved it is the one
    // pass in the middle.
    h.runFor(EXIT_AFTER - 20);
    expect(h.exits).toEqual([]);
  });
});

describe("a loop that stops", () => {
  it("publishes the stall at the threshold and not before", () => {
    const h = harness();
    h.watchdog.arm();

    // Just short of it — `runFor` steps in heartbeat-sized ticks, so it lands ON `PUBLISH_AFTER - 2`
    // rather than somewhere before it. Nothing has happened yet.
    h.runFor(PUBLISH_AFTER - 2);
    expect(h.stalls).toBe(0);
    expect(h.watchdog.liveness().stalled).toBe(false);

    // Cross it.
    h.runFor(4);
    expect(h.stalls).toBe(1);
    expect(h.watchdog.liveness().stalled).toBe(true);
    // AND STAGE 1 DOES NOT KILL. The whole reason the mechanism has two stages is that publishing is
    // free and exiting is not; a stall that went straight to `exit(1)` would restart the machine
    // before anybody could see why.
    expect(h.exits).toEqual([]);
  });

  it("still exits at stage 2 when publishing the stall throws", () => {
    // The two halves of stage 1 fail independently on purpose. If `onStall` throws — a status file on
    // a full disk, a publisher in a bad state — the log line, the `/health` 503 and the exit must all
    // still happen, because none of them depends on it. Losing the alarm AND the remedy to one failed
    // write would be the incident with a new cause.
    const h = harness();
    h.breakOnStall();
    h.watchdog.arm();

    h.runFor(PUBLISH_AFTER + 4);
    expect(h.watchdog.liveness().stalled).toBe(true);
    expect(stderr.mock.calls.flat().join("\n")).toContain("could not be published");

    h.runFor(EXIT_AFTER);
    expect(h.exits).toEqual([1]);
  });

  it("publishes ONCE, not on every heartbeat for the next three minutes", () => {
    // The heartbeat fires every HEARTBEAT_INTERVAL_SECONDS. An unguarded threshold would re-publish
    // and re-log ninety times between the two stages, burying the one line that matters — the same
    // mistake `publishSafely` already refuses to make about status-file write failures.
    const h = harness();
    h.watchdog.arm();
    h.runFor(EXIT_AFTER - 10);
    expect(h.stalls).toBe(1);
  });

  it("exits 1 at the exit threshold, and only once", () => {
    // A LOOP THAT WAS GENUINELY RUNNING AND THEN STOPPED, which is the incident's actual shape —
    // round #678 ran to completion first. The passes below are what distinguish this from the
    // first-pass case further down: the clock has to be measured from the LAST mark, so a watchdog
    // that timed from `arm()` would fire early here and this test would catch it.
    const h = harness();
    h.watchdog.arm();
    for (let pass = 0; pass < 60; pass++) {
      h.advance(LOOP_INTERVAL_SECONDS);
      h.watchdog.check();
      h.watchdog.passCompleted();
    }
    expect(h.exits).toEqual([]);

    h.runFor(EXIT_AFTER - 2);
    expect(h.exits).toEqual([]);

    h.runFor(4);
    // ONE, AND NON-ZERO. Fly's restart policy with no `[[restart]]` block is `on-fail`: a non-zero
    // exit is restarted, a CLEAN one is not and leaves the machine stopped. Exiting 0 here would turn
    // a 22-hour outage into a permanent one.
    expect(h.exits).toEqual([1]);

    // The real `process.exit` does not return; an injected one does, and the module must not hand a
    // second exit to the next heartbeat.
    h.runFor(600);
    expect(h.exits).toEqual([1]);
  });

  it("still says why, when the heartbeat itself was starved past both thresholds in one step", () => {
    // If the timer is delayed long enough to skip stage 1 entirely, the restart must not arrive with
    // no explanation anywhere. Stage 2 is deliberately not an `else`.
    const h = harness();
    h.watchdog.arm();
    h.advance(EXIT_AFTER + 100);
    h.beat();
    expect(h.stalls).toBe(1);
    expect(h.exits).toEqual([1]);
  });

  it("logs the diagnosis at both stages, because log silence WAS the incident", () => {
    // Round #678 produced no log output of any kind for 22 hours. A watchdog that published a status
    // field but wrote nothing to stderr would leave `fly logs` — the first place anybody looks —
    // exactly as empty as it was on the day.
    const h = harness();
    h.watchdog.arm();
    h.runFor(PUBLISH_AFTER + 4);
    expect(stderr.mock.calls.flat().join("\n")).toContain("LOOP STALLED");

    h.runFor(EXIT_AFTER);
    expect(stderr.mock.calls.flat().join("\n")).toContain("EXITING 1");
  });

  it("catches a loop whose FIRST pass hangs, not just its thousandth", () => {
    // The pass-one hole. If arming were left to the first `passCompleted()`, a keeper that restarted
    // into a validator it can never talk to would hang before its first mark and never be watched —
    // and that is precisely the keeper that most needs replacing. `arm()` seeds the clock itself.
    const h = harness();
    h.watchdog.arm();
    h.runFor(EXIT_AFTER + 4);
    expect(h.exits).toEqual([1]);
  });
});

describe("what the watchdog refuses to act on", () => {
  it("does nothing at all before it is armed", () => {
    // `startStatusServer` needs `liveness` as a required dependency and starts minutes before the
    // loop — while an ER validator is chosen and the house bank is funded. Counting that boot work as
    // an overdue pass would 503 a keeper that is starting normally, under a log line reading
    // "LOOP STALLED" about a loop that has not started.
    const h = harness();
    h.runFor(EXIT_AFTER * 3);
    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it("reports a pass age of zero before arming rather than the time since construction", () => {
    const h = harness();
    h.advance(500);
    expect(h.watchdog.liveness()).toEqual({ passAgeSeconds: 0, stalled: false });
  });

  it("stops acting once a stop has been signalled", () => {
    // A SIGTERM leaves the loop finishing its current step, which can legitimately be a `close_round`
    // send followed by `waitForUndelegation` at UNDELEGATE_WAIT_SECONDS. Exiting 1 during an orderly
    // stop would turn a clean deploy into a crash Fly then restarts from.
    const h = harness();
    h.watchdog.arm();
    h.watchdog.disarm();
    h.runFor(EXIT_AFTER * 2);
    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it("keeps MEASURING after a disarm, so a slow shutdown is still visible on /health", () => {
    // Disarming stops the acting, not the observing. An operator watching a deploy that will not
    // finish should be able to see how long it has been. Run PAST the publish threshold, so this
    // proves the measurement continues rather than merely that nothing happened yet.
    const h = harness();
    h.watchdog.arm();
    h.watchdog.disarm();
    h.runFor(PUBLISH_AFTER + 60);
    expect(h.watchdog.liveness().passAgeSeconds).toBeGreaterThan(PUBLISH_AFTER);
    // Not stalled: the keeper was asked to stop, it did not hang. Nothing fired, and nothing will.
    expect(h.watchdog.liveness().stalled).toBe(false);
    expect(h.stalls).toBe(0);
    expect(h.exits).toEqual([]);
  });

  it("does NOT withdraw a stall it already published when a stop is signalled", () => {
    // THE ORDER THAT MATTERS AND THE ONE THE DOC COMMENT AND THE CODE HAVE TO AGREE ON. A keeper that
    // hung, was detected, and was THEN sent a SIGTERM did not stop being hung because somebody asked
    // it to stop — so `/health` must go on failing for the rest of the shutdown. Clearing the flag on
    // disarm would let the last thing an operator sees during an incident be a healthy 200.
    const h = harness();
    h.watchdog.arm();
    h.runFor(PUBLISH_AFTER + 4);
    expect(h.watchdog.liveness().stalled).toBe(true);

    h.watchdog.disarm();
    expect(h.watchdog.liveness().stalled).toBe(true);
    // But it is disarmed, so it never escalates to the exit — the shutdown is Fly's SIGKILL to own.
    h.runFor(EXIT_AFTER * 2);
    expect(h.exits).toEqual([]);
  });
});

describe("the configured thresholds", () => {
  // These assert the DERIVATION, not the numbers. Each one is a property that has to survive anybody
  // retuning `KEEPER_LOOP_STALL_*`, and each has a specific failure behind it.
  //
  // A FIRST VERSION OF THIS BLOCK WAS WORSE THAN NOTHING AND IS RECORDED HERE SO IT IS NOT REWRITTEN.
  // It asserted `LOOP_STALL_PUBLISH_SECONDS > worstLegitimatePass * 1.25` against a
  // `worstLegitimatePass` the test itself defined as a literal — so both sides were numbers the
  // author had chosen, and the assertion was `180 > 150`. It restated the estimate instead of
  // checking it, and it passed cheerfully while that estimate was undercounting the round-transition
  // pass by nearly a hundred seconds (see `LOOP_STALL_PUBLISH_SECONDS` for what it missed). A test
  // over a number you also wrote proves the two agree, not that either is right.
  //
  // What replaces it is a bound over something the code cannot drift away from: every send in this
  // keeper is capped by blockhash expiry, so the threshold is stated in units of that.

  it("allows at least three full blockhash expiries inside one legitimate pass", () => {
    // The structural bound. A send cannot outlive its blockhash (150 slots, ~60s, call it 90 on an
    // unwell devnet), and only the deliberately-swallowed sends can stack — a throwing one ends the
    // pass. Two can stack today, in `driveSettled`'s transition pass. Three is the headroom, and
    // stating it this way means the threshold stays honest if somebody adds a fourth send tomorrow.
    const BLOCKHASH_LIFETIME_SECONDS = 90;
    expect(LOOP_STALL_PUBLISH_SECONDS).toBeGreaterThanOrEqual(BLOCKHASH_LIFETIME_SECONDS * 3);
  });

  it("clears every bounded wait the phase machine can hold inside one pass", () => {
    // Not a claim about the worst pass — a floor under it. These are the waits the loop takes with
    // NO transaction involved at all, so a threshold below their sum would fire on a keeper doing
    // nothing but waiting exactly as designed.
    const boundedWaits = UNDELEGATE_WAIT_SECONDS + DELEGATION_WAIT_SECONDS
      + RESOLVE_RETRY_ATTEMPTS * RESOLVE_RETRY_WAIT_SECONDS;
    expect(LOOP_STALL_PUBLISH_SECONDS).toBeGreaterThan(boundedWaits * 2);
  });

  it("cannot be tripped by a keeper sleeping out its maximum error backoff", () => {
    // Enforced in `config.ts` too, at boot. Asserted here as well because it is the property that
    // keeps a devnet outage from becoming a restart loop, and a boot-time throw only protects the
    // deployment that happens to restart.
    expect(LOOP_STALL_PUBLISH_SECONDS).toBeGreaterThan(ERROR_BACKOFF_MAX_SECONDS);
  });

  it("publishes before it kills, with a gap of at least three blockhash lifetimes", () => {
    // A Solana transaction is valid for 150 slots — about 60 seconds — after its recent blockhash. The
    // gap between the two stages is what guarantees nothing this process put on the wire can still
    // land when it exits, so the keeper that boots next re-derives from final state.
    const BLOCKHASH_LIFETIME_SECONDS = 60;
    expect(LOOP_STALL_EXIT_SECONDS).toBeGreaterThan(LOOP_STALL_PUBLISH_SECONDS);
    expect(LOOP_STALL_EXIT_SECONDS - LOOP_STALL_PUBLISH_SECONDS)
      .toBeGreaterThanOrEqual(BLOCKHASH_LIFETIME_SECONDS * 3);
  });

  it("cannot exhaust Fly's restart budget and leave the machine stopped for good", () => {
    // THE PROPERTY THIS NUMBER EXISTS FOR. Fly's `on-fail` policy — the default with no `[[restart]]`
    // block — allows up to 10 restarts within a 5-minute window and then leaves the machine
    // `stopped`; and fly.toml sets `auto_start_machines = false`, so `stopped` is terminal until a
    // human intervenes. At an exit threshold longer than that window, two restarts can never fall
    // inside one, let alone ten. The budget is unreachable by construction rather than by luck, and
    // this is the floor to preserve if anyone retunes the threshold downward.
    const FLY_RESTART_WINDOW_SECONDS = 300;
    expect(LOOP_STALL_EXIT_SECONDS).toBeGreaterThan(FLY_RESTART_WINDOW_SECONDS);
  });

  it("is a rounding error against the outage it exists to end", () => {
    // The only "upper bound" that is honestly available. A tighter one was tried — "shorter than one
    // round (~204s)", borrowed from STALL_AFTER_CONSECUTIVE_FAILURES — and it had to be given up,
    // because a single transition pass can legitimately outlast a nominal round. See
    // `LOOP_STALL_PUBLISH_SECONDS`. What is left is the comparison that actually motivated the work:
    // detection in minutes against a failure that ran for 22 hours.
    const INCIDENT_SECONDS = 22 * 60 * 60;
    expect(LOOP_STALL_EXIT_SECONDS / INCIDENT_SECONDS).toBeLessThan(0.01);
  });
});
