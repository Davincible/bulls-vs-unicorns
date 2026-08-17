// IS THE MAIN LOOP STILL TURNING? — the one question nothing in this keeper used to ask.
//
// THE INCIDENT. On 2026-08-16T08:53:38Z the keeper ran round #678 to completion, printed its
// `ROUND #678 COMPLETE` banner, and then emitted NO LOG OUTPUT OF ANY KIND FOR 22 HOURS. It never
// opened #679. A `fly machine restart` recovered it instantly and it has run normally since. For
// those 22 hours the arena was dead and every instrument this process owns reported health:
// `heartbeatAt` was 2-3 seconds old continuously, `stalledSince` was null, `notOpeningRounds` was
// null, `/health` returned 200, and `fly status` showed the machine started with 1/1 checks passing.
//
// EACH OF THOSE MISSED IT FOR ITS OWN REASON, AND NONE OF THEM WAS BROKEN. That is what makes this
// worth a module rather than a patch. `config.ts`'s `LOOP_STALL_PUBLISH_SECONDS` walks through all
// four; the short version is that the heartbeat is DOCUMENTED to prove only that the process is
// alive (it runs on its own `setInterval` precisely so a keeper waiting out a 60-second lobby keeps
// saying so), `STALL_AFTER_CONSECUTIVE_FAILURES` counts consecutive FAILED passes and a hung `await`
// produces none, and `/health` deliberately makes no chain calls so that a devnet blip cannot get a
// healthy keeper killed. Three correct designs with one shared blind spot: every one of them can be
// satisfied by a process whose main loop has stopped.
//
// So this module asserts the missing invariant, and only that one: A PASS COMPLETED RECENTLY.
//
// WHY THAT INVARIANT AND NOT "A ROUND ADVANCED RECENTLY". The loop iterates at ~1Hz whatever phase
// the round is in — it ticks a fight, it waits out a lobby, it holds a result — so pass completion
// is true at every instant of a healthy keeper's life. Round progress is not: a 60-second lobby, a
// 180-second fight and a hold-open are all legitimately quiet, and a watchdog on round progress
// would either fire during a healthy fight or be loosened until it fired at nothing.
//
// WHY THE MARK IS TAKEN ON THE ERROR PATH TOO. `passCompleted()` is called from the main loop's
// `catch` as well as after a clean pass. The invariant is THE LOOP WENT ROUND, not that it
// succeeded, and the distinction is the whole reason this is safe to point at `process.exit`. A
// keeper riding out a devnet outage is catching, backing off and retrying — it is iterating, so it
// keeps marking, so this never fires. That state already has an instrument (`stalledSince`, via
// `STALL_AFTER_CONSECUTIVE_FAILURES`), a restart does not fix it, and fly.toml says so in as many
// words. This watchdog is for the opposite signature: ZERO errors and zero progress.
//
// ---------------------------------------------------------------------------------------------
// THE MECHANISM, AND THE ONE THAT WAS REJECTED
// ---------------------------------------------------------------------------------------------
//
// Two stages, in this order, from the heartbeat timer:
//
//   1. at `LOOP_STALL_PUBLISH_SECONDS` — SAY SO. Publish `stalledSince` (so `keeper-status.json`
//      stops promising a round and the page's countdown stops), fail `/health` on loop liveness (so
//      `fly status` and any external monitor stop saying 1/1), and write one loud log line (so
//      `fly logs`, whose silence WAS the incident, carries the diagnosis).
//   2. at `LOOP_STALL_EXIT_SECONDS` — EXIT NON-ZERO, so Fly's `on-fail` restart policy replaces the
//      machine. A restart is the proven remedy: it is what recovered #679.
//
// STAGE 2 IS NOT OPTIONAL, AND THAT IS A CORRECTION TO THE OBVIOUS PLAN. The tempting design is
// stage 1 alone — publish, fail the health check, and let the platform do the killing. IT DOES NOT.
// On Fly Machines a failing health check does not restart or replace anything; Fly's docs say so
// outright ("your Machines won't automatically restart or stop due to failing their health checks,
// this needs to be done manually" — fly.io/docs/reference/health-checks/), and Fly's own staff
// recommend self-killing as the remedy. A failing `[[http_service.checks]]` only takes the machine
// out of fly-proxy's rotation, which on a ONE-MACHINE app (fly.toml rule 1) means the public
// endpoints 503 rather than that anything gets fixed. The check has teeth during a deploy and none
// afterwards. So `/health` here buys visibility, and only the exit buys self-correction.
//
// ---------------------------------------------------------------------------------------------
// WHY EXITING CANNOT DOUBLE-SEND, WHICH IS THE OBJECTION THIS DESIGN HAD TO ANSWER
// ---------------------------------------------------------------------------------------------
//
// The fear is concrete: kill the process between `sendRawTransaction` and the pass completing, and a
// transaction that landed is invisible to the keeper that comes back, which re-sends it. Four
// independent reasons that does not happen here, in ascending order of how much they settle:
//
//   1. THE KEEPER RE-DERIVES EVERYTHING FROM CHAIN, AND THIS CODEBASE HAS ALREADY ARGUED THAT THIS
//      IS THE SAFE RETRY. `READ_RETRY_DELAYS_MS`' own comment: "The main loop re-deriving from the
//      chain is a strictly better retry for sends: it cannot double-send, because it looks at what
//      the chain says happened before deciding what to do next." A restart is that re-derivation
//      with a cold cache. Nothing in this process decides an action from memory — `completedCounted`
//      is explicit that it is "NOT a 'did I already send close_round' flag", because the chain is
//      asked instead.
//   2. THE ONLY DUPLICATE THIS KEEPER CAN PRODUCE IS ALREADY NAMED AND ALREADY ROUTINE.
//      `driveSettled` says it in place: the undelegate commit reaches the base layer asynchronously,
//      so a slow one leaves the next pass looking at a Settled round that is still delegated, and
//      "that re-send is the one duplicate transaction this keeper can produce, it costs a
//      signature". It happens in normal operation, on a keeper nobody restarted. The in-process
//      guard against the harm — double-counting the round — is `completedCounted`, which a restart
//      loses; so the cost of a restart landing in that window is one signature (~5,000 lamports) and
//      one round possibly counted twice in a display counter. Against 22 hours of dead arena.
//   3. THE TIMING MAKES IT UNREACHABLE ANYWAY. A Solana transaction is valid for 150 slots — about
//      60 seconds — after its recent blockhash. By the time stage 2 fires, no pass has completed for
//      `LOOP_STALL_EXIT_SECONDS`, of which the last `LOOP_STALL_EXIT_SECONDS - LOOP_STALL_PUBLISH_SECONDS`
//      elapsed after we had already declared the loop hung: three blockhash lifetimes of silence.
//      Anything on the wire from before the first alarm can no longer land. The replacement machine
//      then spends tens of seconds booting (fly.toml's 90s `grace_period` exists because choosing an
//      ER validator and funding the house bank precede the first pass, and the funding is a CONFIRMED
//      base-layer transaction) before it reads anything at all.
//   4. AND THE RISK WAS ALREADY TAKEN, DELIBERATELY, BY THE PERSON WHO FIXED THIS. The recovery was
//      `fly machine restart` — a SIGTERM followed by a SIGKILL, from an arbitrary point in a hung
//      pass, with none of the three arguments above examined. This watchdog does not introduce a new
//      class of failure. It performs the same remedy, six minutes late instead of 22 hours late, and
//      after three stages of evidence the operator did not have. Any argument that stage 2 is too
//      dangerous is an argument that the recovery was too dangerous, and the recovery was right.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS IS DELIBERATELY NOT
// ---------------------------------------------------------------------------------------------
//
//   * NOT a new `NotOpeningReason`. `notOpeningRounds` is a closed vocabulary whose members name the
//     instrument that decided no further round is coming, and a hung loop qualifies — but
//     `stalledSince` ALREADY means "alive and not progressing", `isKeeperStalled` already reads it,
//     and the page already stops its countdown on it. Publishing both would be two alarms for one
//     fact, which `openNextRound` explicitly refuses one screen over ("a second, wrong, alarm on top
//     of the right one"). It would also couple this fix to a front-end deploy: `isNotOpeningReason`
//     refuses the WHOLE FILE on a reason it does not recognise, so a new member reaching an older
//     page turns the status to null. That is survivable — for a hung keeper "keeper is down" is even
//     true — but an incident fix has to be shippable on its own.
//   * NOT a second `setInterval`. The check runs from the heartbeat, which is the one component with
//     22 hours of proof that it kept running through the hang. A watchdog on a timer of its own
//     would be a new thing that can stop, watching a thing that stopped.
//   * NOT a clearer of `stalledSince`. This module SETS that field and never clears it. The main
//     loop clears it on a clean pass, which is the right condition for both detectors — and a
//     watchdog that cleared it on any pass would erase the failure counter's alarm the moment a
//     single read succeeded.
//   * NOT armed during shutdown. See `disarm`.

import { error as logError, warn } from "./log.ts";

/** What `/health` needs to answer, as ONE value read in ONE call.
 *
 *  A record rather than two accessors, and not for tidiness. Read separately, `stalled` and
 *  `passAgeSeconds` can straddle a heartbeat — a request landing between them would report
 *  `stalled: true` beside a pass age of 0.1s, which is a body that contradicts itself about the only
 *  thing it exists to say. One call, one instant. */
export interface LoopLiveness {
  /** Seconds since the last completed pass, from a monotonic clock. */
  passAgeSeconds: number;
  /** Has the publish threshold been crossed without a pass since? */
  stalled: boolean;
}

export interface LoopWatchdogOptions {
  /** `LOOP_STALL_PUBLISH_SECONDS`. */
  publishAfterSeconds: number;
  /** `LOOP_STALL_EXIT_SECONDS`. */
  exitAfterSeconds: number;
  /** Publish the stall — `publisher.setStalledSince(...)` plus a write. Called ONCE per stall, on the
   *  heartbeat that detects it, and never called to clear: see this file's header. */
  onStall: () => void;
  /** How this process dies. REQUIRED RATHER THAN DEFAULTED TO `process.exit`, for two reasons that
   *  point the same way. A defaulted killer is one a test forgets to override, and the failure is a
   *  vitest run that vanishes mid-suite with no output — the same class of unexplained silence this
   *  whole module exists to end. And at the wiring site in `keeper.ts` it puts the ability to end the
   *  process in plain sight, on the line a reader checks when they ask what can kill this thing. */
  exit: (code: number) => void;
  /** A MONOTONIC millisecond clock. Defaults to `performance.now()`, which is the correct source and
   *  not merely a convenient one: every other timestamp in this keeper is wall-clock (`hostNowSeconds`
   *  plus a chain offset), and wall-clock time STEPS. An NTP correction inside a long-lived Firecracker
   *  VM can jump the clock forward by minutes, and a wall-clock watchdog would read that jump as a
   *  hung loop and restart a perfectly healthy keeper. A step backwards would be worse, because it is
   *  silent: the age goes negative, the watchdog never fires, and we are back to the 22 hours.
   *  `performance.now()` cannot step. Injected only so tests can drive it. */
  monotonicMs?: () => number;
}

export interface LoopWatchdog {
  /** START WATCHING — called by `keeper.ts` immediately before the `while`, and nowhere else.
   *
   *  THE WATCHDOG IS BUILT DISARMED, AND THE TWO EVENTS ARE SEPARATE BECAUSE THEY HAPPEN AT
   *  DIFFERENT TIMES. `startStatusServer` needs `liveness` as a REQUIRED dependency and is started
   *  early on purpose — before choosing an ER validator and before funding the house bank, so that
   *  Fly's check has something to answer during the slow half of boot. That is minutes before the
   *  loop exists. A watchdog that started its clock at construction would count all of that boot work
   *  as an overdue pass and could 503 a keeper that is starting normally, or on a bad enough devnet
   *  exit(1) on it — and it would do so under a log line reading "LOOP STALLED", about a loop that
   *  had not started. Wrong message, wrong verdict, both from one line in the wrong place.
   *
   *  ARMING RATHER THAN LETTING THE FIRST `passCompleted()` DO IT IMPLICITLY, which was the tidier
   *  version and is wrong: it leaves pass one unwatched, and pass one is exactly the pass that hangs
   *  after a restart into a bad validator. The hole would be invisible and would only ever open
   *  during an incident. */
  arm(): void;
  /** THE MARK. Called by the main loop at the end of every pass, success OR failure — see this
   *  file's header on why the error path counts. */
  passCompleted(): void;
  /** For `/health`. In-process arithmetic only: one subtraction of two numbers already in memory, no
   *  RPC, no filesystem. `/health`'s no-chain-calls contract is not negotiable and this does not
   *  touch it.
   *
   *  BEFORE `arm()` IT REPORTS A PASS AGE OF ZERO, which is the honest answer rather than a
   *  convenient one: no pass is overdue, because the loop has not started. Reporting the time since
   *  construction instead would put a number in front of an operator that looks like a pass age,
   *  grows like a pass age, and is not one.
   *
   *  AFTER `disarm()` IT KEEPS ANSWERING TRUTHFULLY, AND `stalled` IS NOT RESET. What disarming stops
   *  is the ACTING, not the measuring: the pass age keeps growing, so a shutdown that overruns is
   *  visible for what it is. And a stall that was already published STAYS published — `/health` goes
   *  on returning 503 for the rest of the shutdown, which is correct, because a keeper that hung and
   *  was then sent a SIGTERM did not stop being hung when somebody asked it to stop. Clearing the
   *  flag there would let the last thing an operator sees during an incident be a healthy 200. */
  liveness(): LoopLiveness;
  /** ONE CHECK, driven by the heartbeat timer. Publishes at the first threshold and exits at the
   *  second; a single call can do both, which is what happens if the heartbeat itself was starved
   *  long enough to skip past stage 1. */
  check(): void;
  /** STOP WATCHING — called when a stop has been signalled.
   *
   *  Without it, this watchdog would kill the graceful shutdown it is supposed to leave alone. A
   *  SIGTERM sets `stopSignalled` and the loop then FINISHES ITS CURRENT STEP before falling out,
   *  and that step can legitimately be a `close_round` send followed by `waitForUndelegation` at
   *  `UNDELEGATE_WAIT_SECONDS` — during which no pass completes. On a slow enough shutdown this would
   *  cross the exit threshold and `process.exit(1)` in the middle of an orderly stop, turning a clean
   *  deploy into a crash and a non-zero code Fly would restart from.
   *
   *  A shutdown that then hangs is NOT this module's problem, and that division is deliberate: Fly
   *  already sends SIGKILL after its own grace period, so the platform owns that timeout. Two
   *  watchdogs on one shutdown is one too many. */
  disarm(): void;
}

export function createLoopWatchdog(options: LoopWatchdogOptions): LoopWatchdog {
  const { publishAfterSeconds, exitAfterSeconds, onStall, exit } = options;
  const monotonicMs = options.monotonicMs ?? (() => performance.now());

  // DISARMED, AND THE MARK UNSET, UNTIL `arm()` — see that method for why construction and the start
  // of watching are two events rather than one. `null` rather than a seeded timestamp so that a
  // missing `arm()` cannot degrade quietly into "watching from an arbitrary earlier instant"; it
  // degrades into "not watching", which is the pre-incident behaviour and is at least honest about
  // itself in `/health`.
  let lastPassAtMs: number | null = null;
  let stalled = false;
  let armed = false;

  const passAgeSeconds = (): number => (lastPassAtMs === null ? 0 : (monotonicMs() - lastPassAtMs) / 1_000);

  return {
    arm() {
      // The mark is seeded here, not left null, so the first threshold is measured from the instant
      // the loop began rather than from its first completed pass. That is what closes the pass-one
      // hole this method's doc comment describes.
      lastPassAtMs = monotonicMs();
      stalled = false;
      armed = true;
    },

    passCompleted() {
      lastPassAtMs = monotonicMs();
      // Cleared here and only here. A loop that has gone round is not a stalled loop, whether the
      // pass succeeded or threw — `/health` therefore comes back the moment iteration resumes, which
      // is the correct behaviour for a keeper backing off through a devnet outage. The status file's
      // `stalledSince` is NOT cleared from here; see this file's header.
      stalled = false;
    },

    liveness: () => ({ passAgeSeconds: passAgeSeconds(), stalled }),

    check() {
      if (!armed) return;
      const age = passAgeSeconds();

      // STAGE 1, ONCE. Guarded on `stalled` rather than on an exact crossing, because the heartbeat
      // fires every `HEARTBEAT_INTERVAL_SECONDS` and an un-guarded threshold would re-publish and
      // re-log this every two seconds for three minutes — ninety lines burying the one that matters,
      // which is the same mistake `publishSafely` already refuses to make about write failures.
      if (age >= publishAfterSeconds && !stalled) {
        stalled = true;
        logError(`LOOP STALLED — no main-loop pass has completed in ${age.toFixed(0)}s.`);
        logError(`  The process is alive: this line comes from the heartbeat timer, which is running.`);
        logError(`  The loop is not. It is inside an await that has not returned, so it is producing no`);
        logError(`  errors — which is why the consecutive-failure counter has not fired and cannot.`);
        logError(`  keeper-status.json now publishes stalledSince and /health now fails on loop`);
        logError(`  liveness. If no pass completes within ${exitAfterSeconds}s of the last one, this`);
        logError(`  process exits non-zero and Fly replaces the machine. A restart is the proven fix.`);
        // GUARDED, AND THE LATCH IS ALREADY SET ABOVE IT, WHICH IS THE ORDERING TO KEEP. If `onStall`
        // throws, the two halves of stage 1 degrade differently and both degrade the safe way: the
        // published half is lost, while the log line, the `/health` 503 and — decisively — stage 2's
        // exit all still happen, because none of them depends on it. Latching AFTER the call would
        // look more careful and be worse: `onStall` would be retried on every heartbeat, and so would
        // the six log lines above it, so a persistently failing publish would emit three lines a
        // second for five minutes and bury its own diagnosis.
        //
        // Caught HERE rather than left to `statusFile.ts`'s heartbeat guard, even though that guard
        // would also hold. The message matters: from there it reads as "the heartbeat hook threw",
        // which says nothing about which half of the alarm was lost.
        try {
          onStall();
        } catch (e) {
          logError(
            `  (the stall could not be published to the status file — the log line above and the ` +
            `/health 503 stand, and the exit at ${exitAfterSeconds}s is unaffected: ` +
            `${e instanceof Error ? e.message : String(e)})`,
          );
        }
      }

      // STAGE 2. Deliberately not an `else` — a heartbeat starved past both thresholds must still
      // say why before it goes, or the restart arrives with no explanation anywhere.
      if (age >= exitAfterSeconds) {
        logError(`LOOP STALLED FOR ${age.toFixed(0)}s — EXITING 1 so the machine is replaced.`);
        logError(`  A failing health check does not restart a Fly Machine; only a non-zero exit does.`);
        logError(`  Nothing this process sent can still land: a blockhash is valid for ~60s and the`);
        logError(`  loop has been silent for far longer, so the keeper that boots next re-derives`);
        logError(`  every decision from chain state that is final with respect to this one.`);
        // NO FINAL PUBLISH AND NO HEARTBEAT BUMP ON THE WAY OUT, both on purpose. The stall was
        // published at stage 1 and the file still says so; writing again here would only refresh
        // `heartbeatAt`, and a status file claiming a live process is exactly what `main()`'s own
        // exit path refuses to leave behind. Letting the heartbeat go stale is the honest signal and
        // it arrives on its own within `STALE_AFTER_SECONDS`.
        exit(1);
        // Reached only under an injected `exit` that returns (i.e. in tests). Disarming keeps a test
        // double from being handed a second exit on the next heartbeat, which would make "exits once"
        // untestable.
        armed = false;
      }
    },

    disarm() {
      armed = false;
      // `stalled` AND THE MARK ARE BOTH LEFT AS THEY STAND, not reset — see `liveness`. What stops
      // here is the acting; the measuring continues, so a shutdown that overruns stays visible and a
      // stall that was already published is not quietly withdrawn on the way out.
      warn("loop watchdog disarmed — a keeper that was asked to stop is not a keeper that hung");
    },
  };
}
