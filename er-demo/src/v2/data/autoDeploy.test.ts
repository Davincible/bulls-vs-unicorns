// THE RULE THAT SPENDS MONEY WHEN NOBODY IS WATCHING, exercised without a browser.
//
// `QUEUE.md` carries two open bugs against the previous implementation of this feature — B4
// ("auto-deploy is unreliable — fires some rounds, not others") and B5 ("must always fire at the
// START of a round, not mid-lobby") — and B4 is the reason this file is the shape it is. "Fires some
// rounds" is not a verdict a single run can produce: it is a claim about a DISTRIBUTION, and the only
// honest way to check it is to run the state machine over many rounds, with the failures and the
// awkward timings deliberately dealt in, and assert on the whole sequence.
//
// So the centre of this file is `runRounds` — a driver that walks the rule through complete round
// lifecycles a tick at a time, exactly as `useAutoDeploy` does, with an injectable verdict for
// whether each transaction lands. Every scenario below is that same driver with a different world.
// A browser proves one run; this proves the rule.
//
// THE DRIVER LATER GREW A SECOND WORLD TO MODEL, and it is the one that costs money in a way B4 never
// did: HOW the deposit is signed. A play session lasts a fixed time, and once it ran out the old
// write path sent a doomed transaction every round and then raised two Phantom approvals to replace
// the session — at an empty chair, every round, indefinitely. So the world now carries a signing verdict
// and a session epoch, `tick` forks on a refusal that names a lapsed session exactly as the write
// path does, and the scenario that matters most in this file asserts a COUNT: after a lapse, exactly
// one transaction is ever sent while the same session is live.

import { describe, expect, it } from "vitest";
import { MIN_RETAINED_ROUNDS } from "../../chain/constants.ts";
import {
  ENTRY_CLOSE_GUARD_MS,
  MIN_STAKE_USD,
  STAKE_CAP_USD,
  entriesOpen,
  entrySecondsLeft,
  usdToUnits,
  type LiveRound,
  type PhaseName,
  type RoundPlayer,
  type RoundSummary,
  type Side,
} from "../contract.ts";
import {
  ARMED_BY_DEFAULT,
  INITIAL_AUTO_DEPLOY,
  MAX_TRIES,
  RETRY_BACKOFF_MS,
  abandonAttempt,
  abandonText,
  arm,
  armWith,
  attemptFailed,
  attemptLanded,
  beginAttempt,
  bookRunPnl,
  decideAutoDeploy,
  disarm,
  expireStaleAttempt,
  holdText,
  noteDeploy,
  noteRoundEntered,
  noteSessionRefused,
  resolveAmountUsd,
  setLimits,
  simBankrollUsd,
  type AbandonReason,
  type AutoDeployState,
  type HoldReason,
} from "./autoDeploy.ts";
import {
  DEFAULT_LIMITS,
  EMPTY_TALLY,
  readRunPnl,
  type AutoLimits,
  type RunPnlReading,
  type UnattendedBlock,
  type UnattendedSigning,
} from "./autoPolicy.ts";
import { classifyWalletError } from "./walletFault.ts";

// ---------------------------------------------------------------------------------------------
// A round, minimally but honestly
// ---------------------------------------------------------------------------------------------

/** Enough of a `LiveRound` for the two questions this module asks of one: which round is it, and can
 *  it still be deposited into. Built through the real type rather than a cast, so a field added to
 *  `LiveRound` fails here and gets a decision rather than a silent `undefined`. */
function round(over: {
  roundNo: bigint;
  phase: PhaseName;
  lobbyClosesAtMs: number | null;
  fighters?: LiveRound["fighters"];
}): LiveRound {
  return {
    roundNo: over.roundNo,
    phase: over.phase,
    winner: null,
    pot: 0n,
    fighters: over.fighters ?? [],
    seedHex: null,
    seedCommitHex: "00",
    fightStartedAtMs: null,
    lobbyClosesAtMs: over.lobbyClosesAtMs,
    tickCount: 0n,
    elapsedSec: 0,
    stepsNow: 0,
    resolvable: false,
    extractTerms: {
      penaltyBps: 0,
      freeAtStep: 0,
      stepsToFree: 0,
      secondsToFree: 0,
      decay: [],
      youKeep: null,
      youForfeit: null,
    },
  };
}

const YOU = {
  id: 0,
  wallet: "You111111111111111111111111111111111111111",
  short: "You…111",
  name: "you",
  side: 0 as Side,
  stake: 1_000_000n,
  hp: 1_000_000n,
  banked: 0n,
  dead: false,
  isYou: true,
  house: false,
};

// ---------------------------------------------------------------------------------------------
// The signing world, and the limits, when they are not what a scenario is about
// ---------------------------------------------------------------------------------------------

/** A live play session signing with no prompt — the arrangement this feature is built for, and the
 *  world every scenario is in unless it says otherwise. */
const SIGNS_SILENTLY: UnattendedSigning = { kind: "silent" };

/** One session has been opened in this tab. Not zero: zero means "none has ever been opened", and a
 *  scenario about anything else should not be sitting in that state by accident. */
const ONE_SESSION = 1;

/** DELIBERATELY NOT A CONSTRAINT. The limits are a subject of their own scenarios below, where they
 *  are set explicitly and to figures that bind; everywhere else they are set out of the way, so a
 *  test about retrying a lobby fails for a reason about retrying a lobby.
 *
 *  It matters that this is not `DEFAULT_LIMITS`: the shipped default budget is $250, which correctly
 *  stops a $25 run after ten rounds — that is asserted on its own further down, and it would
 *  otherwise silently truncate the fifty-round housekeeping run and turn one property's failure into
 *  another property's. */
const AMPLE_USD = 1_000_000;
const AMPLE_LIMITS: AutoLimits = {
  budgetUsd: AMPLE_USD,
  perRoundCapUsd: STAKE_CAP_USD,
  // Off, not "wide". A drawdown stop that is SET cannot be evaluated without a profit-and-loss
  // figure, and holding every scenario in this file on a P&L none of them is about would be the
  // limits deciding what the other tests prove.
  drawdownStopPct: null,
  maxRounds: null,
};

/** THE WALLET THE LOG'S ROWS ARE ABOUT — the same key `YOU` carries, because the rule finds itself
 *  in a settled round by wallet and a driver that used two spellings would prove nothing. */
const YOU_KEY = YOU.wallet;

/** A settled round as the log reports it. `pnlUsd` null means this player was not in it. */
function logRound(roundNo: bigint, pnlUsd: number | null): RoundSummary {
  const players: RoundPlayer[] =
    pnlUsd === null
      ? []
      : [{ ...YOU, short: YOU.short, name: YOU.name, wallet: YOU_KEY, stake: usdToUnits(25),
           final: usdToUnits(25 + pnlUsd), pnl: usdToUnits(pnlUsd), dead: false, isYou: true }];
  return {
    roundNo, phase: "Settled", winner: 0, pot: usdToUnits(50), fighterCount: players.length,
    tickCount: 0n, penaltiesCollected: 0n, feesCollected: 0n, players,
  };
}

/** A run that is neither up nor down, with nothing outstanding. Every `holdText` assertion below
 *  that is not ABOUT the ledger passes this, because the sentence a hold gets must not depend on a
 *  figure the hold is not about. */
const READABLE_FLAT: RunPnlReading = { kind: "known", usd: 0 };

/** Nothing has settled yet, and nobody has entered anything — the state every scenario below that is
 *  not about the drawdown stop is in. A run with no confirmed deposit is flat by definition, so an
 *  empty log here is a stated fact and not an absent one. */
const NO_LOG: RoundSummary[] = [];

/** The driver's own epoch-ms zero, shared so an arming stamp and the first tick agree. */
const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------------------------
// The driver — one tick of `useAutoDeploy`, with the network replaced by a verdict
// ---------------------------------------------------------------------------------------------

/** What one transaction did. Two nullable fields rather than a discriminated union because this
 *  project does not compile with `strictNullChecks`, and without it TypeScript will not narrow a
 *  union in the branch where the discriminant is false — a union here would be precision the compiler
 *  refuses to enforce, paid for with casts at every use. `error === null` means it landed. */
interface EnterVerdict {
  signature: string | null;
  error: string | null;
}

const landed = (signature = "sig"): EnterVerdict => ({ signature, error: null });
const failed = (error: string): EnterVerdict => ({ signature: null, error });

interface World {
  live: LiveRound | null;
  /** The round the write path targets. Defaults to `live.roundNo` — the two only differ during the
   *  poll window a real chain has and a test has to ask for explicitly. */
  targetRoundNo?: bigint | null;
  alreadyIn: boolean;
  entering: boolean;
  simWalletUsd: number;
  /** THE ROUND LOG, WINDOWED, exactly as the chain leaves it: the rule reads what settled out of
   *  this and accumulates it, and rounds that have aged out are gone for good. Handing the decision
   *  the log rather than a P&L is the point — the figure the drawdown stop enforces is derived
   *  inside the module that enforces it. */
  roundLog: RoundSummary[];
  youPubkey: string;
  /** Whether the next deposit could be signed with nobody watching. */
  signing: UnattendedSigning;
  /** How many sessions this tab has successfully opened. */
  sessionEpoch: number;
  nowMs: number;
}

interface TickResult {
  state: AutoDeployState;
  /** The round a transaction was sent for on this tick, if any. */
  sent: { roundNo: bigint; side: Side; amountUsd: number; attemptNo: number } | null;
  abandoned: { roundNo: bigint; reason: AbandonReason } | null;
}

/** ONE EVALUATION, wired exactly as the hook wires it — same order, same transitions. If this drifts
 *  from `useAutoDeploy`'s effect the tests stop meaning anything, so it is deliberately a short,
 *  literal transcription of it and nothing more. */
function tick(state: AutoDeployState, world: World, enter: (roundNo: bigint) => EnterVerdict): TickResult {
  let s = expireStaleAttempt(state, world.live?.roundNo ?? null);
  // The other half of "close the books on what the chain has finished with", and it is here for the
  // same reason the line above it is: the hook calls both before every decision, and a driver that
  // skipped this one would prove a rule nobody runs.
  s = bookRunPnl(s, world.roundLog, world.youPubkey);

  const decision = decideAutoDeploy({
    state: s,
    roundNo: world.live?.roundNo ?? null,
    targetRoundNo: world.targetRoundNo === undefined ? (world.live?.roundNo ?? null) : world.targetRoundNo,
    phase: world.live?.phase ?? null,
    entriesOpen: entriesOpen(world.live, world.nowMs),
    alreadyIn: world.alreadyIn,
    entering: world.entering,
    amountUsd: resolveAmountUsd(s.rule, world.simWalletUsd),
    signing: world.signing,
    sessionEpoch: world.sessionEpoch,
    roundLog: world.roundLog,
    youPubkey: world.youPubkey,
    nowMs: world.nowMs,
  });

  if (decision.kind === "hold") return { state: s, sent: null, abandoned: null };

  if (decision.kind === "abandon") {
    return {
      state: abandonAttempt(s, decision.roundNo, decision.reason),
      sent: null,
      abandoned: { roundNo: decision.roundNo, reason: decision.reason },
    };
  }

  s = beginAttempt(s, decision.roundNo);
  const verdict = enter(decision.roundNo);
  const sent = {
    roundNo: decision.roundNo,
    side: decision.side,
    amountUsd: decision.amountUsd,
    attemptNo: decision.attemptNo,
  };

  if (verdict.error === null) {
    return {
      state: attemptLanded(s, decision.roundNo, verdict.signature, decision.amountUsd, world.youPubkey),
      sent,
      abandoned: null,
    };
  }

  // THE WRITE PATH'S OWN FORK, transcribed rather than approximated. `useActions` classifies every
  // thrown value through `classifyWalletError`, and the one code that is NOT a retry is
  // `session-expired`: the session is lapsed for the rest of its life, so a second attempt buys a
  // second certain refusal, and the recovery a watching player would get costs two Phantom
  // approvals. Classifying here rather than matching a string keeps this driver honest about which
  // errors the real path can actually tell apart.
  if (classifyWalletError(verdict.error).code === "session-expired") {
    return {
      state: noteSessionRefused(s, decision.roundNo, world.sessionEpoch),
      sent,
      abandoned: { roundNo: decision.roundNo, reason: "session-lapsed" },
    };
  }

  return { state: attemptFailed(s, decision.roundNo, verdict.error, world.nowMs), sent, abandoned: null };
}

// ---------------------------------------------------------------------------------------------
// The driver — complete round lifecycles, a second at a time
// ---------------------------------------------------------------------------------------------

interface RoundShape {
  /** How long the chain accepts deposits for. `MIN_LOBBY_SECONDS` on chain is 30. */
  lobbySeconds: number;
  /** THE WINDOW THAT BREAKS EVERYTHING NAIVE. `enter` is refused from `lobby_closes_at`, but the
   *  phase stays `Lobby` until an operator's `close_lobby_and_draw` lands — so for this many seconds
   *  every round says "Lobby" while the chain refuses deposits. Defaulted to a realistic value
   *  because a driver that left it at zero would never reproduce B4. */
  deadWindowSeconds: number;
  drawingSeconds: number;
  fightSeconds: number;
  settledSeconds: number;
}

const NORMAL_ROUND: RoundShape = {
  lobbySeconds: 45,
  deadWindowSeconds: 12,
  drawingSeconds: 4,
  fightSeconds: 20,
  settledSeconds: 6,
};

interface RunOptions {
  state: AutoDeployState;
  rounds: number;
  firstRoundNo?: bigint;
  shape?: RoundShape;
  simWalletUsd?: number;
  /** Verdict per transaction. Called with the round and the attempt number (1-based). Defaults to
   *  "everything lands". */
  enter?: (roundNo: bigint, attemptNo: number) => EnterVerdict;
  /** Seconds after a round opens before this tab notices it at all — the arena counter poll plus the
   *  round fetch. Real, and the difference between comfortably making a lobby and missing it. */
  discoverySeconds?: number;
  /** WHAT THE LOG WILL SAY THIS PLAYER MADE IN A ROUND, once it settles — asked per round so a
   *  scenario can walk a run into its drawdown stop. Null means the round's record never reaches the
   *  log at all, which is what a failed read or a reclaimed account looks like from here. Defaults to
   *  a flat evening. */
  roundPnlFor?: (roundNo: bigint) => number | null;
  /** How the next deposit could be signed, asked per round so a session can go away mid-run.
   *  Defaults to a live session signing silently for the whole run. */
  signingFor?: (roundNo: bigint) => UnattendedSigning;
  /** How many sessions this tab has opened by the time this round comes around — the identity the
   *  lapse latch compares. Defaults to one session for the whole run; a renewal advances it. */
  sessionEpochFor?: (roundNo: bigint) => number;
  /** Called once per simulated second, so a scenario can arm, disarm or change the rule mid-run. */
  onTick?: (ctx: { state: AutoDeployState; roundNo: bigint; phase: PhaseName; secondInPhase: number }) => AutoDeployState;
}

interface RunResult {
  state: AutoDeployState;
  /** `secondInRound` is WHEN, counted from the instant the round opened — the half of B5 ("must
   *  always fire at the START of a round, not mid-lobby") that a count of transactions cannot check.
   *  Without it, a rule that fired at second 50 of a 57-second Lobby satisfied every assertion in
   *  this file. */
  sent: { roundNo: bigint; side: Side; amountUsd: number; attemptNo: number; secondInRound: number }[];
  abandoned: { roundNo: bigint; reason: AbandonReason }[];
  /** Rounds a deposit CONFIRMED into — the only measure that matters. */
  landedRounds: bigint[];
  /** What the chain still held when the run finished — the newest `MIN_RETAINED_ROUNDS` rounds and
   *  nothing older. Returned so a scenario can assert what the rule could still READ, which is a
   *  different question from what it had already accounted for. */
  roundLog: RoundSummary[];
}

/**
 * WALK N COMPLETE ROUNDS, one simulated second per tick.
 *
 * Models the four things a real tab is actually up against, all of which the previous implementation
 * ignored: a round is not seen the instant it opens, `Lobby` outlives the deposit deadline, a
 * confirmed entry shows up in the roster a beat later, and transactions fail.
 *
 * WHAT IT DELIBERATELY CANNOT MODEL, stated so nobody reads its coverage as wider than it is: every
 * verdict resolves synchronously inside the tick that sent it, and `entering` is always false. So no
 * attempt is ever still `sending` when the round number advances, and the `busy` hold is never
 * reached. Those two states are real — a confirmation can outlive a lobby — and they are the states
 * in which a deposit could be lost from the books entirely, so they are covered directly against
 * `decideAutoDeploy` instead ("will not open a second round while its own transaction is still in
 * flight"). A driver that could hold a send pending across a boundary would be better; a driver that
 * quietly implied it already did would be worse.
 */
function runRounds(opts: RunOptions): RunResult {
  const shape = opts.shape ?? NORMAL_ROUND;
  const discovery = opts.discoverySeconds ?? 3;
  const simWalletUsd = opts.simWalletUsd ?? 500;
  const enterFn = opts.enter ?? (() => landed() as EnterVerdict);
  const roundPnlFor = opts.roundPnlFor ?? (() => 0);
  // THE LOG IS A WINDOW, AND THE DRIVER MODELS IT AS ONE. `close_round_account` reclaims everything
  // but the newest `MIN_RETAINED_ROUNDS`, so a run longer than that cannot be measured by re-reading
  // its own span — which is the whole defect the running total closes. A driver that kept every
  // round would have gone on passing after the fix was reverted.
  let roundLog: RoundSummary[] = [];
  const settleIntoLog = (roundNo: bigint, entered: boolean) => {
    if (roundLog.some((r) => r.roundNo === roundNo)) return;
    const pnlUsd = roundPnlFor(roundNo);
    if (!entered || pnlUsd === null) {
      // A round nobody in this run was in still exists on chain; a round whose read failed does not
      // reach the log at all. The first is a row with no fighter of ours, the second is an absence.
      if (pnlUsd !== null) roundLog.push(logRound(roundNo, null));
    } else {
      roundLog.push(logRound(roundNo, pnlUsd));
    }
    roundLog = roundLog.filter((r) => r.roundNo > roundNo - BigInt(MIN_RETAINED_ROUNDS));
  };
  const signingFor = opts.signingFor ?? (() => SIGNS_SILENTLY);
  const sessionEpochFor = opts.sessionEpochFor ?? (() => ONE_SESSION);

  let state = opts.state;
  const sent: RunResult["sent"] = [];
  const abandoned: RunResult["abandoned"] = [];
  const landedRounds: bigint[] = [];

  let nowMs = T0;
  let roundNo = opts.firstRoundNo ?? 1n;

  for (let r = 0; r < opts.rounds; r++) {
    const openedAtMs = nowMs;
    const lobbyClosesAtMs = openedAtMs + shape.lobbySeconds * 1000;
    // A confirmed entry only becomes visible in the roster on the next poll.
    let inRosterFrom: number | null = null;
    const phases: [PhaseName, number][] = [
      ["Lobby", shape.lobbySeconds + shape.deadWindowSeconds],
      ["Drawing", shape.drawingSeconds],
      ["Fight", shape.fightSeconds],
      ["Settled", shape.settledSeconds],
    ];

    let secondInRound = 0;
    for (const [phase, seconds] of phases) {
      for (let s = 0; s < seconds; s++, secondInRound++, nowMs += 1000) {
        // Before discovery the tab is still reading the PREVIOUS round, or nothing at all.
        const seen = secondInRound >= discovery;
        const live = seen ? round({ roundNo, phase, lobbyClosesAtMs, fighters: [] }) : null;
        const alreadyIn = inRosterFrom !== null && nowMs >= inRosterFrom;
        if (live !== null && alreadyIn) live.fighters = [YOU];

        // THE ROUND'S RESULT REACHES THE LOG WHEN IT SETTLES, and drops out of it twenty rounds
        // later. Everything the rule knows about what came back has to be picked up inside that
        // window or not at all, which is the constraint the running total exists to live under.
        if (phase === "Settled" && s === 0) {
          settleIntoLog(roundNo, landedRounds.includes(roundNo));
        }

        if (opts.onTick && live !== null) {
          state = opts.onTick({ state, roundNo, phase, secondInPhase: s });
        }

        const result = tick(
          state,
          {
            live,
            alreadyIn,
            entering: false,
            simWalletUsd,
            roundLog,
            youPubkey: YOU_KEY,
            signing: signingFor(roundNo),
            sessionEpoch: sessionEpochFor(roundNo),
            nowMs,
          },
          (rn) => {
            const prior = sent.filter((x) => x.roundNo === rn).length;
            return enterFn(rn, prior + 1);
          },
        );
        state = result.state;
        if (result.sent) {
          sent.push({ ...result.sent, secondInRound });
          if (state.attempt?.outcome === "landed" && state.attempt.roundNo === result.sent.roundNo) {
            landedRounds.push(result.sent.roundNo);
            inRosterFrom = nowMs + 1500;
          }
        }
        if (result.abandoned) abandoned.push(result.abandoned);
      }
    }
    roundNo += 1n;
  }

  return { state, sent, abandoned, landedRounds, roundLog };
}

/** Armed, with a side already known — the state a player is in after one manual deploy. Limits set
 *  out of the way; see `AMPLE_LIMITS` for why that is not the shipped default. */
function armed(over: Partial<AutoDeployState> = {}): AutoDeployState {
  return {
    ...arm(noteDeploy(INITIAL_AUTO_DEPLOY, 1), {
      rule: { kind: "fixed", usd: 25 },
      visibleRoundNo: null,
      nowMs: T0,
    }),
    limits: AMPLE_LIMITS,
    ...over,
  };
}

// =============================================================================================
// B4 — "fires some rounds, not others"
// =============================================================================================

describe("B4: one deposit per round, every round", () => {
  it("lands exactly one deposit in each of ten consecutive rounds", () => {
    const run = runRounds({ state: armed(), rounds: 10, firstRoundNo: 40n });

    expect(run.landedRounds).toEqual([40n, 41n, 42n, 43n, 44n, 45n, 46n, 47n, 48n, 49n]);
    // Not merely "at least one" — a second deposit into a round the rule already entered is the
    // opposite failure and just as expensive.
    expect(run.sent).toHaveLength(10);
    expect(run.abandoned).toEqual([]);
  });

  it("survives a lobby short enough that discovery eats most of it", () => {
    // 30s is `MIN_LOBBY_SECONDS`, the shortest the program permits, and 8s of discovery is a bad
    // arena poll landing badly. It still has to make every round.
    const run = runRounds({
      state: armed(),
      rounds: 5,
      shape: { ...NORMAL_ROUND, lobbySeconds: 30, deadWindowSeconds: 20 },
      discoverySeconds: 8,
    });
    expect(run.landedRounds).toHaveLength(5);
  });

  it("still enters every round when a third of the transactions fail", () => {
    // THE B4 SCENARIO ITSELF. The old code marked the round done before awaiting, so any failure
    // dropped that round for good — from the player's seat, "it fires some rounds and not others".
    // Here a failure is a retry, and the lobby is long enough to absorb it.
    let n = 0;
    const run = runRounds({
      state: armed(),
      rounds: 9,
      enter: () => (++n % 3 === 0 ? failed("blockhash not found") : landed()),
    });

    expect(run.landedRounds).toHaveLength(9);
    expect(run.abandoned).toEqual([]);
    // Some rounds took two goes; none took more than the cap.
    expect(run.sent.length).toBeGreaterThan(9);
    for (const s of run.sent) expect(s.attemptNo).toBeLessThanOrEqual(MAX_TRIES);
  });

  it("retries in the same lobby rather than writing the round off", () => {
    const run = runRounds({
      state: armed(),
      rounds: 1,
      enter: (_r, attemptNo) =>
        attemptNo === 1 ? failed("RPC timeout") : landed("sig-2"),
    });

    expect(run.sent.map((s) => s.attemptNo)).toEqual([1, 2]);
    expect(run.landedRounds).toEqual([1n]);
    expect(run.state.attempt?.outcome).toBe("landed");
  });

  it("waits out the backoff between tries instead of hammering the RPC", () => {
    const state = attemptFailed(beginAttempt(armed(), 7n), 7n, "boom", 10_000);
    const world = (nowMs: number) => ({
      state,
      roundNo: 7n,
      targetRoundNo: 7n,
      phase: "Lobby" as const,
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs,
    });

    expect(decideAutoDeploy(world(10_000 + RETRY_BACKOFF_MS - 1)).kind).toBe("hold");
    expect(decideAutoDeploy(world(10_000 + RETRY_BACKOFF_MS)).kind).toBe("fire");
  });
});

describe("B4: the failure it cannot fix is still reported", () => {
  it("gives up after the cap and says which round and why", () => {
    const run = runRounds({
      state: armed(),
      rounds: 1,
      enter: () => failed("insufficient lamports"),
    });

    expect(run.landedRounds).toEqual([]);
    expect(run.sent).toHaveLength(MAX_TRIES);
    expect(run.abandoned).toEqual([{ roundNo: 1n, reason: "retries-exhausted" }]);
    // The chain's own words survive to the report — a player reading "3 attempts failed" and nothing
    // else cannot tell an empty wallet from a broken RPC.
    expect(abandonText("retries-exhausted", run.state.attempt?.error ?? null)).toContain(
      "insufficient lamports",
    );
  });

  it("never loses a round silently — every round is either entered or reported", () => {
    // The property that makes this feature acceptable at all: over a long run with failures of every
    // kind, the count of rounds entered plus the count of rounds reported missed is EVERY round.
    let n = 0;
    const run = runRounds({
      state: armed(),
      rounds: 12,
      firstRoundNo: 100n,
      enter: () => {
        n += 1;
        // A long, ugly failure streak in the middle: rounds that cannot be entered at all.
        return n >= 5 && n <= 16 ? failed("lobby closed") : landed();
      },
    });

    const accounted = new Set([...run.landedRounds, ...run.abandoned.map((a) => a.roundNo)].map(String));
    for (let r = 100n; r < 112n; r++) expect(accounted.has(r.toString())).toBe(true);
    expect(accounted.size).toBe(12);
  });

  it("reports the round the operator drew before this tab ever saw the lobby", () => {
    // A tab that was asleep, throttled, or simply slow. It cannot enter the round — but it must not
    // pretend the round did not happen.
    const run = runRounds({ state: armed(), rounds: 1, discoverySeconds: 60 });

    expect(run.landedRounds).toEqual([]);
    expect(run.abandoned).toEqual([{ roundNo: 1n, reason: "phase-moved-on" }]);
  });
});

describe("B4's actual mechanism: Lobby is not the same fact as 'deposits open'", () => {
  it("abandons the round when the deposit deadline passes under a phase that still says Lobby", () => {
    // The program refuses `enter` from `lobby_closes_at`; the phase only moves when an operator's
    // transaction lands. Deciding on the phase alone is how a rule ends up sending doomed
    // transactions for a whole window of every round.
    const late = round({ roundNo: 3n, phase: "Lobby", lobbyClosesAtMs: 5_000 });
    const decision = decideAutoDeploy({
      state: armed(),
      roundNo: 3n,
      targetRoundNo: 3n,
      phase: "Lobby",
      entriesOpen: entriesOpen(late, 9_000),
      alreadyIn: false,
      entering: false,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 9_000,
    });
    expect(decision).toEqual({ kind: "abandon", roundNo: 3n, reason: "entries-closed" });
  });

  it("does not race the deadline it cannot see the far side of", () => {
    const live = round({ roundNo: 1n, phase: "Lobby", lobbyClosesAtMs: 100_000 });
    expect(entriesOpen(live, 100_000 - ENTRY_CLOSE_GUARD_MS - 1)).toBe(true);
    expect(entriesOpen(live, 100_000 - ENTRY_CLOSE_GUARD_MS)).toBe(false);
    // Still open by the phase, and correctly refused by the deadline.
    expect(entriesOpen(live, 99_999)).toBe(false);
  });

  it("falls back to the phase on a program revision that has no deadline", () => {
    // The deadline arrived in a later revision of the program than the one deployed. A round opened
    // by the earlier one takes deposits for the whole of its Lobby phase, so `Lobby` IS the answer
    // there — and a client that insisted on the field would stop working the moment it ran ahead of
    // the chain, which during a migration is every deploy.
    const noDeadline = round({ roundNo: 1n, phase: "Lobby", lobbyClosesAtMs: null });
    expect(entriesOpen(noDeadline, 0)).toBe(true);
    expect(entriesOpen(noDeadline, 9_999_999_999_999)).toBe(true);
    expect(entriesOpen({ ...noDeadline, phase: "Fight" }, 0)).toBe(false);
    // And no countdown is invented from a client-side constant — there is nothing to count down.
    expect(entrySecondsLeft(noDeadline, 0)).toBeNull();
  });

  it("still enters every round on a program with no deadline", () => {
    const run = runRounds({
      state: armed(),
      rounds: 4,
      // The whole Lobby phase accepts deposits, so there is no dead window to dodge.
      shape: { ...NORMAL_ROUND, deadWindowSeconds: 0 },
    });
    expect(run.landedRounds).toHaveLength(4);
    expect(run.abandoned).toEqual([]);
  });

  it("counts the deposit window down, and only during a lobby", () => {
    const live = round({ roundNo: 1n, phase: "Lobby", lobbyClosesAtMs: 60_000 });
    expect(entrySecondsLeft(live, 0)).toBe(60);
    expect(entrySecondsLeft(live, 59_500)).toBe(1);
    expect(entrySecondsLeft(live, 70_000)).toBe(0);
    expect(entrySecondsLeft(round({ roundNo: 1n, phase: "Fight", lobbyClosesAtMs: 60_000 }), 0)).toBeNull();
    expect(entrySecondsLeft(null, 0)).toBeNull();
  });
});

// =============================================================================================
// B5 — "must fire at the START of a round, not mid-lobby"
// =============================================================================================

describe("B5: ticking the box never spends money on the round already on screen", () => {
  it("skips the round that was open when it was armed, and takes every round after", () => {
    const run = runRounds({
      state: INITIAL_AUTO_DEPLOY,
      rounds: 4,
      firstRoundNo: 20n,
      onTick: ({ state, roundNo, phase, secondInPhase }) =>
        // Arm halfway through round 20's lobby, the way a player would: they have deployed by hand,
        // they are watching the round they are in, and they tick the box.
        roundNo === 20n && phase === "Lobby" && secondInPhase === 20 && !state.armed
          ? arm(noteDeploy(state, 1), { rule: { kind: "fixed", usd: 10 }, visibleRoundNo: roundNo, nowMs: T0 })
          : state,
    });

    expect(run.landedRounds).toEqual([21n, 22n, 23n]);
    // And round 20 is not reported as missed either — it was never this rule's round to enter.
    expect(run.abandoned).toEqual([]);
  });

  it("names the round it will start from, so arming has no unstated consequence", () => {
    const s = arm(INITIAL_AUTO_DEPLOY, { rule: { kind: "fixed", usd: 10 }, visibleRoundNo: 20n, nowMs: T0 });
    expect(s.floorRound).toBe(20n);
    expect(holdText("waiting-for-next-round", s, 20n, READABLE_FLAT)).toContain("round 21");
  });

  it("takes the very next round when nothing was open at the moment of arming", () => {
    // There was no round in progress to protect the player from, so waiting a whole extra round
    // would be the surprise instead.
    const run = runRounds({
      state: arm(noteDeploy(INITIAL_AUTO_DEPLOY, 0), {
        rule: { kind: "fixed", usd: 10 },
        visibleRoundNo: null,
        nowMs: T0,
      }),
      rounds: 2,
      firstRoundNo: 7n,
    });
    expect(run.landedRounds).toEqual([7n, 8n]);
  });

  it("deposits on the first tick that can see the round, not at some point during the lobby", () => {
    // THE OTHER HALF OF B5'S WORDING, and it needs a clock rather than a count. This test used to
    // assert only that one transaction was sent and that it landed, which a rule firing at second 50
    // of a 57-second Lobby satisfies exactly as well as one firing at the top — so it was named for a
    // property it did not check. `secondInRound` is when.
    for (const discoverySeconds of [0, 3, 8]) {
      const run = runRounds({ state: armed(), rounds: 1, discoverySeconds });
      expect(run.sent).toHaveLength(1);
      // Not "early" — the FIRST tick on which the round was visible at all. The only delay this rule
      // is allowed is the tab noticing the round exists.
      expect(run.sent[0].secondInRound).toBe(discoverySeconds);
      expect(run.state.attempt?.outcome).toBe("landed");
    }
  });

  it("still fires at the top of the round after a lobby it had to retry through", () => {
    // The retry path must not turn into a slow start on the NEXT round: each round's first attempt is
    // still its first visible second.
    const run = runRounds({
      state: armed(),
      rounds: 3,
      enter: (_roundNo, attemptNo) => (attemptNo === 1 ? failed("RPC timeout") : landed()),
    });
    const firstTryPerRound = run.sent.filter((s) => s.attemptNo === 1);
    expect(firstTryPerRound.map((s) => s.secondInRound)).toEqual([3, 3, 3]);
  });
});

// =============================================================================================
// Double-firing, in all the ways it can happen
// =============================================================================================

describe("exactly one transaction per round", () => {
  it("holds while its own transaction is in flight — StrictMode's double invoke is a no-op", () => {
    // React 18 runs mount effects twice, back to back, in one tick. The previous version claimed to
    // handle this by marking the round done BEFORE awaiting, which did stop the double send and is
    // also precisely what made a failure unrecoverable. Marking it as SENDING costs nothing and
    // gives up nothing.
    const world = {
      live: round({ roundNo: 5n, phase: "Lobby" as const, lobbyClosesAtMs: 1_700_000_100_000 }),
      alreadyIn: false,
      entering: false,
      simWalletUsd: 500,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      nowMs: T0,
    };
    // The hook commits `beginAttempt` synchronously, before the await, so a second evaluation in the
    // same tick sees `sending`. Modelled here by never resolving the first enter.
    const first = tick(armed(), world, () => landed());
    const midFlight = beginAttempt(armed(), 5n);
    const second = tick(midFlight, world, () => {
      throw new Error("a second transaction was sent for one round");
    });

    expect(first.sent?.roundNo).toBe(5n);
    expect(second.sent).toBeNull();
  });

  it("does not top up a round the player already entered by hand", () => {
    // The scaffolding that used to open this test — a no-op `onTick`, the default `enter`, and a
    // comment claiming the player deployed by hand at round 61 — did none of those things and
    // asserted a baseline three other suites already hold. Deleted; what remains is the subject.
    const decision = decideAutoDeploy({
      state: armed(),
      roundNo: 61n,
      targetRoundNo: 61n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: true,
      entering: false,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    });
    expect(decision).toEqual({ kind: "hold", reason: "already-in" });
  });

  it("will not open a second round while its own transaction is still in flight", () => {
    // THE ONE CASE WHERE AN OLD ATTEMPT IS NOT HISTORY, and the only one in this rule that can lose a
    // deposit that actually happened. There is a single attempt slot: if round 41's send is still in
    // flight when round 42 opens, starting 42 overwrites 41's record, and when 41's transaction
    // confirms `attemptLanded` finds a record for another round and returns unchanged. A deposit that
    // was made, confirmed and paid for would be accounted as neither entered nor missed, and never
    // charged against the budget.
    //
    // In production `entering` would normally hold first — but that is an invariant of
    // `ArenaProvider`'s wiring, and this module is the one promising never to lose a round, so it
    // holds on its own evidence. Note `entering: false` here: that is the point of the test.
    const inFlight = beginAttempt(armed(), 41n);
    const decision = decideAutoDeploy({
      state: inFlight,
      roundNo: 42n,
      targetRoundNo: 42n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    });

    expect(decision).toEqual({ kind: "hold", reason: "sending" });
    // And it says which round it is depositing into — 41, the one with a transaction in flight, not
    // 42, the one on screen it has not touched.
    expect(holdText("sending", inFlight, 42n, READABLE_FLAT)).toContain("round 41");
  });

  it("takes the new round as soon as the in-flight transaction resolves", () => {
    // The guard above is a hold, not an ending: it lifts on the next evaluation, which is a second
    // later and well inside a lobby.
    const resolved = attemptLanded(beginAttempt(armed(), 41n), 41n, "sig", 25, YOU_KEY);
    expect(
      decideAutoDeploy({
        state: resolved,
        roundNo: 42n,
        targetRoundNo: 42n,
        phase: "Lobby",
        entriesOpen: true,
        alreadyIn: false,
        entering: false,
        amountUsd: 25,
        signing: SIGNS_SILENTLY,
        sessionEpoch: ONE_SESSION,
        roundLog: NO_LOG,
      youPubkey: YOU_KEY,
        nowMs: 0,
      }).kind,
    ).toBe("fire");
  });

  it("does not deposit on top of a manual deploy the roster has not shown yet", () => {
    // `alreadyIn` is read off a poll and arrives up to 1.5s late. In that window the old rule would
    // send a second deposit on top of one the player had just made by hand: two transactions, two
    // fees, twice the stake, for one round they meant to enter once.
    const justDeployed = noteRoundEntered(armed(), 30n);
    expect(
      decideAutoDeploy({
        state: justDeployed,
        roundNo: 30n,
        targetRoundNo: 30n,
        phase: "Lobby",
        entriesOpen: true,
        // The chain has not caught up — this is precisely the window in question.
        alreadyIn: false,
        entering: false,
        amountUsd: 25,
        signing: SIGNS_SILENTLY,
        sessionEpoch: ONE_SESSION,
        roundLog: NO_LOG,
      youPubkey: YOU_KEY,
        nowMs: 0,
      }),
    ).toEqual({ kind: "hold", reason: "deployed-this-round" });
    // The record is honest about not having sent it: no signature of ours.
    expect(justDeployed.attempt).toMatchObject({ roundNo: 30n, outcome: "landed", signature: null, tries: 0 });
  });

  it("does not retry into a round a manual deploy already covered", () => {
    // The rule's own transaction can fail AFTER a manual deposit has landed in the same round.
    // Retrying then would deposit twice into a round the player is demonstrably already in.
    const sending = beginAttempt(armed(), 30n);
    const covered = noteRoundEntered(sending, 30n);
    expect(attemptFailed(covered, 30n, "blockhash expired", 0)).toBe(covered);
  });

  it("will not deposit while the round being read and the round being written disagree", () => {
    // The window where the arena's counter has advanced but the round fetch has not landed. Acting
    // here would enter a different round from the one the decision was made about.
    const decision = decideAutoDeploy({
      state: armed(),
      roundNo: 12n,
      targetRoundNo: 13n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    });
    expect(decision).toEqual({ kind: "hold", reason: "round-changing" });
  });

  it("stands aside while a deposit from anywhere else on the page is in flight", () => {
    const decision = decideAutoDeploy({
      state: armed(),
      roundNo: 1n,
      targetRoundNo: 1n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: true,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    });
    expect(decision).toEqual({ kind: "hold", reason: "busy" });
  });
});

// =============================================================================================
// The amount
// =============================================================================================

describe("the amount rule declines rather than degrades", () => {
  it("returns nothing at all when a percentage of an empty simulated wallet is unsendable", () => {
    // The old rule clamped to a one-cent floor, so a drained wallet did not stop the feature — it
    // quietly turned it into a $0.01 deposit every round, each one paying a real fee.
    expect(resolveAmountUsd({ kind: "pct", pct: 25 }, 0)).toBeNull();
    expect(resolveAmountUsd({ kind: "pct", pct: 5 }, 0.1)).toBeNull();
    expect(resolveAmountUsd({ kind: "fixed", usd: 0 }, 500)).toBeNull();
    expect(resolveAmountUsd({ kind: "fixed", usd: Number.NaN }, 500)).toBeNull();
  });

  it("sends nothing, and keeps saying so, while the rule resolves to nothing", () => {
    const run = runRounds({ state: armed({ rule: { kind: "pct", pct: 10 } }), rounds: 3, simWalletUsd: 0 });
    expect(run.sent).toEqual([]);
    // NOT A MISS TO REPORT EITHER: nothing failed and nothing was lost — the rule declined. The
    // panel's status line carries the reason for as long as it is true.
    //
    // This assertion used to be `every(a => a.reason === "entries-closed")`, which was vacuously
    // satisfied and was hiding the opposite behaviour: a declining rule held through each lobby,
    // reached the deposit deadline, and was written off as having missed it — an error toast per
    // round, with the wrong reason, for as long as the wallet stayed empty. Stated as the empty list
    // it always should have been, and see `decideAutoDeploy`'s "declining is not missing".
    expect(run.abandoned).toEqual([]);
    expect(holdText("amount-unusable", armed({ rule: { kind: "pct", pct: 10 } }), 1n, READABLE_FLAT)).toContain(
      "simulated wallet",
    );
  });

  it("takes the percentage off the smaller side, so either side can cover it", () => {
    expect(simBankrollUsd({ ansem: 400, uwu: 120, sol: 40 })).toBe(120);
    expect(resolveAmountUsd({ kind: "pct", pct: 25 }, 120)).toBe(30);
  });

  it("never exceeds the arena's per-side cap", () => {
    expect(resolveAmountUsd({ kind: "pct", pct: 25 }, 100_000)).toBe(STAKE_CAP_USD);
    expect(resolveAmountUsd({ kind: "fixed", usd: 5_000 }, 500)).toBe(STAKE_CAP_USD);
  });

  it("sends the amount that was armed, not whatever a panel happens to hold later", () => {
    // The old "Fixed $" rule read the Deploy panel's own stake field, so the same screen change that
    // stopped the rule running also reset a $100 repeat to the $5 default.
    const run = runRounds({ state: armed({ rule: { kind: "fixed", usd: 100 } }), rounds: 3 });
    expect(run.sent.map((s) => s.amountUsd)).toEqual([100, 100, 100]);
  });

  it("accepts exactly the minimum", () => {
    expect(resolveAmountUsd({ kind: "fixed", usd: MIN_STAKE_USD }, 0)).toBe(MIN_STAKE_USD);
  });
});

// =============================================================================================
// Housekeeping the old version got wrong
// =============================================================================================

describe("the record stays bounded and stays truthful", () => {
  it("holds exactly one attempt after fifty rounds", () => {
    // The old version kept a Set entry per round, forever, in a tab that can be left open all day.
    // Round numbers only increase, so one record is all a decision can ever depend on.
    const run = runRounds({ state: armed(), rounds: 50 });
    expect(run.landedRounds).toHaveLength(50);
    expect(run.state.attempt?.roundNo).toBe(50n);
    expect(Object.keys(run.state).sort()).toEqual([
      "armed", "attempt", "deadSessionEpoch", "floorRound", "limits", "pnl", "rule", "side",
      "sideRule", "tally",
    ]);
    // The run's ACCOUNT grows with the run; its shape does not. Fifty rounds are five counters and a
    // span, not fifty records — the same property, one level up, that the single attempt record
    // holds for the decision itself.
    expect(run.state.tally).toEqual({
      armedAtMs: T0,
      entered: 50,
      spentUsd: 50 * 25,
      missed: 0,
      firstRound: 1n,
      lastRound: 50n,
      lastOutcome: "entered",
    });
    // AND THE SAME PROPERTY FOR WHAT CAME BACK, which is the register most likely to have been
    // written as a growing set: the obvious way to add a settled round exactly once is to remember
    // every round already added, and that is 950 entries over a night. It is a total and two cursors,
    // at fifty rounds exactly as at one.
    expect(run.state.pnl).toEqual({
      settledUnits: 0n, bookedThrough: 50n, lastEnteredRound: 50n, wallet: YOU_KEY,
    });
  });

  it("closes the books on a round overtaken mid-retry", () => {
    const retrying = attemptFailed(beginAttempt(armed(), 8n), 8n, "timeout", 0);
    const next = expireStaleAttempt(retrying, 9n);
    expect(next.attempt).toMatchObject({ roundNo: 8n, outcome: "abandoned", abandonedBecause: "round-moved-on" });
  });

  it("leaves a finished round's record alone", () => {
    const done = attemptLanded(beginAttempt(armed(), 8n), 8n, "sig", 25, YOU_KEY);
    expect(expireStaleAttempt(done, 9n)).toBe(done);
  });

  it("never writes off a round whose transaction is still in flight", () => {
    // A deposit sent into round 8 has not failed just because round 9 appeared — it may be landing
    // this second. Reporting it missed here would put a claim on screen that the chain contradicts.
    const sending = beginAttempt(armed(), 8n);
    expect(expireStaleAttempt(sending, 9n)).toBe(sending);
    // Once it does fail it becomes a retry, and only then is it collected.
    const after = attemptFailed(sending, 8n, "timeout", 0);
    expect(expireStaleAttempt(after, 9n).attempt).toMatchObject({
      roundNo: 8n,
      outcome: "abandoned",
      abandonedBecause: "round-moved-on",
    });
  });

  it("records a confirmation that arrives after the round has moved on", () => {
    // The mirror of the above: the deposit landed late, and the record must say so rather than being
    // frozen at `sending` forever.
    const sending = beginAttempt(armed(), 8n);
    const landedLate = attemptLanded(sending, 8n, "sig-late", 25, YOU_KEY);
    expect(landedLate.attempt).toMatchObject({ roundNo: 8n, outcome: "landed", signature: "sig-late" });
  });

  it("keeps the report of a missed round after the box is unticked", () => {
    // Unticking the box is exactly what a player does when they have just been told a round was
    // missed. Erasing the reason at that moment would be the worst possible time to erase it.
    const missed = abandonAttempt(armed(), 4n, "entries-closed");
    const off = disarm(missed);
    expect(off.armed).toBe(false);
    expect(off.attempt).toEqual(missed.attempt);
  });

  it("stops entirely once disarmed", () => {
    const run = runRounds({
      state: armed(),
      rounds: 4,
      firstRoundNo: 30n,
      onTick: ({ state, roundNo }) => (roundNo === 32n ? disarm(state) : state),
    });
    expect(run.landedRounds).toEqual([30n, 31n]);
  });

  it("follows the side of the most recent deposit, whichever surface made it", () => {
    let s = noteDeploy(armed(), 0);
    expect(s.side).toBe(0);
    s = noteDeploy(s, 1);
    expect(s.side).toBe(1);
    // Same side twice is not a state change — it must not churn a memo or a render.
    expect(noteDeploy(s, 1)).toBe(s);
  });

  it("has nothing to repeat before the first deposit", () => {
    const s = arm(INITIAL_AUTO_DEPLOY, { rule: { kind: "fixed", usd: 5 }, visibleRoundNo: null, nowMs: T0 });
    expect(decideAutoDeploy({
      state: s,
      roundNo: 1n,
      targetRoundNo: 1n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 5,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    })).toEqual({ kind: "hold", reason: "no-side" });
  });

  it("does nothing at all while disarmed, whatever else is true", () => {
    expect(decideAutoDeploy({
      state: INITIAL_AUTO_DEPLOY,
      roundNo: 1n,
      targetRoundNo: 1n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 50,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    })).toEqual({ kind: "hold", reason: "disarmed" });
  });
});

// =============================================================================================
// The session that signs it runs out — the popup storm, and the latch that ends it
// =============================================================================================

/** What the chain says when a session token has lapsed. `verify-session-base.mjs` step 5 proves an
 *  expired token fails exactly this way, and `walletFault.ts` is what turns it into a code — so the
 *  scenarios below fail for the reason the real path would, not because a test agreed with itself
 *  about a string. */
const SESSION_LAPSED_ERROR = "custom program error: InvalidToken";

describe("a lapsed play session stops it dead instead of raising dialogs at an empty chair", () => {
  it("sends exactly one transaction after the session lapses, and never another on that session", () => {
    // THE POPUP-STORM REGRESSION, and the assertion that matters is a COUNT. Gum's session object
    // carries no expiry, so `signingPlan` goes on answering `{kind:"session"}` for as long as the tab
    // is open; the old write path therefore sent a doomed deposit every round and answered each
    // refusal with `renew-and-retry`, which is revoke-then-create — two Phantom approvals, once a
    // round, at a screen nobody is watching. The chain's refusal is the only authority on this, so it
    // is paid for exactly once and then remembered.
    const run = runRounds({
      state: armed(),
      rounds: 6,
      firstRoundNo: 40n,
      enter: (roundNo) => (roundNo >= 42n ? failed(SESSION_LAPSED_ERROR) : landed()),
    });

    expect(run.landedRounds).toEqual([40n, 41n]);
    expect(run.sent.filter((s) => s.roundNo >= 42n)).toHaveLength(1);
    // Three transactions for six rounds: two that landed, one that bought the answer.
    expect(run.sent).toHaveLength(3);
    expect(run.state.deadSessionEpoch).toBe(ONE_SESSION);
  });

  it("does not retry the round the session was refused on, however much lobby is left", () => {
    // Every other failure in this file earns another go inside the same lobby. This one cannot: the
    // session is lapsed for the rest of its life, so a second try is a second certain refusal.
    const run = runRounds({
      state: armed(),
      rounds: 1,
      enter: () => failed(SESSION_LAPSED_ERROR),
    });

    expect(run.sent).toHaveLength(1);
    expect(run.sent[0].attemptNo).toBe(1);
    expect(run.abandoned).toEqual([{ roundNo: 1n, reason: "session-lapsed" }]);
  });

  it("reports the round it lost and then goes quiet, rather than reporting one a round", () => {
    // The second half of the storm, and the reason the signing checks sit ABOVE the abandon clauses:
    // a rule that cannot sign is standing still, not missing lobbies. Held below them it would have
    // reached the deposit deadline every round and pushed an error toast saying the deadline was
    // missed — the wrong reason, once a round, to somebody who is not there to read it.
    const run = runRounds({
      state: armed(),
      rounds: 5,
      firstRoundNo: 70n,
      enter: (roundNo) => (roundNo >= 71n ? failed(SESSION_LAPSED_ERROR) : landed()),
    });

    expect(run.abandoned).toEqual([{ roundNo: 71n, reason: "session-lapsed" }]);
    expect(run.state.tally.missed).toBe(1);
  });

  it("resumes on a renewed session with no reset call anywhere", () => {
    // The self-clearing property the whole design rests on. Nothing in this scenario clears the
    // latch — there is no call that could — and the rule starts again anyway, because the hold is
    // derived from a comparison rather than stored as a flag somebody has to remember to unset.
    const run = runRounds({
      state: armed(),
      rounds: 6,
      firstRoundNo: 40n,
      // A fresh session is opened between rounds 43 and 44: the second this tab has opened.
      sessionEpochFor: (roundNo) => (roundNo >= 44n ? 2 : 1),
      enter: (roundNo) => (roundNo >= 42n && roundNo < 44n ? failed(SESSION_LAPSED_ERROR) : landed()),
    });

    expect(run.landedRounds).toEqual([40n, 41n, 44n, 45n]);
    // Still recorded as refused, and no longer holding. The latch was never cleared; the world moved
    // past it.
    expect(run.state.deadSessionEpoch).toBe(1);
  });

  it("lifts on a session count that advanced, not on anything the session's own address could say", () => {
    // THE REFUTED DESIGN, kept because it is worth more written down than deleted. The obvious key
    // for this latch is the session token PDA — it IS the session's identity, and `sessionExpiry.ts`
    // keys its records on exactly that. It does not work here: gum reuses the same session signer
    // across a renewal (which is why renewal has to be revoke-then-create at all — see
    // `scripts/verify-session-renewal.mjs`), the PDA is derived from that signer, so the address is
    // STABLE across the renewal. A latch keyed on it would see no change and auto-deploy would stay
    // dead for the rest of the tab's life.
    //
    // This asserts both halves of that: an unchanged identity — which is what a renewal would have
    // handed a PDA-keyed latch — still holds, and only the app's own count lifts it.
    const refused = noteSessionRefused(armed(), 9n, 1);
    const world = (sessionEpoch: number) => ({
      // Round 10, a fresh lobby: everything about the round is fine, so the only thing under test is
      // the latch.
      state: refused,
      roundNo: 10n,
      targetRoundNo: 10n,
      phase: "Lobby" as const,
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 25,
      signing: SIGNS_SILENTLY,
      sessionEpoch,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    });

    expect(decideAutoDeploy(world(1))).toEqual({ kind: "hold", reason: "session-lapsed" });
    expect(decideAutoDeploy(world(2)).kind).toBe("fire");
  });

  it("holds on the latch even while the plan still insists a session is live", () => {
    // Which is the ordinary case, not an edge one: nothing in the app can read a session's expiry
    // back, so `signingPlan` goes on answering `{kind:"session"}` long after it stopped being true. The chain
    // has already settled it, and the chain outranks the inference.
    expect(
      decideAutoDeploy({
        state: noteSessionRefused(armed(), 4n, ONE_SESSION),
        roundNo: 5n,
        targetRoundNo: 5n,
        phase: "Lobby",
        entriesOpen: true,
        alreadyIn: false,
        entering: false,
        amountUsd: 25,
        signing: SIGNS_SILENTLY,
        sessionEpoch: ONE_SESSION,
        roundLog: NO_LOG,
      youPubkey: YOU_KEY,
        nowMs: 0,
      }),
    ).toEqual({ kind: "hold", reason: "session-lapsed" });
  });

  it("still reports a round it is already in rather than blaming the lapse for it", () => {
    // Ladder order, and it is a claim about honesty rather than about precedence: a round the player
    // is demonstrably in was not lost to anything.
    expect(
      decideAutoDeploy({
        state: noteSessionRefused(armed(), 4n, ONE_SESSION),
        roundNo: 5n,
        targetRoundNo: 5n,
        phase: "Lobby",
        entriesOpen: true,
        alreadyIn: true,
        entering: false,
        amountUsd: 25,
        signing: SIGNS_SILENTLY,
        sessionEpoch: ONE_SESSION,
        roundLog: NO_LOG,
      youPubkey: YOU_KEY,
        nowMs: 0,
      }),
    ).toEqual({ kind: "hold", reason: "already-in" });
  });
});

// =============================================================================================
// A deposit that would cost an approval is not sent at all
// =============================================================================================

describe("it never sends anything that would put a wallet dialog in front of nobody", () => {
  const BLOCKED: UnattendedBlock[] = [
    "needs-session",
    "session-stopped",
    "session-unaffordable",
    "no-signer",
  ];

  for (const reason of BLOCKED) {
    it(`sends nothing, and loses nothing, while signing is blocked on ${reason}`, () => {
      const run = runRounds({
        state: armed(),
        rounds: 4,
        firstRoundNo: 10n,
        signingFor: () => ({ kind: "blocked", reason }),
      });

      expect(run.sent).toEqual([]);
      // Nothing reported missed either. These are holds, and a hold loses no round: the moment the
      // wallet panel clears whatever it is, the next round is entered with no further press.
      expect(run.abandoned).toEqual([]);
      expect(run.state.tally).toEqual({ ...EMPTY_TALLY, armedAtMs: T0 });
      expect(holdText(reason, armed(), 10n, READABLE_FLAT).length).toBeGreaterThan(20);
    });
  }

  it("takes the next round the instant a session appears, with nothing to re-arm", () => {
    const run = runRounds({
      state: armed(),
      rounds: 4,
      firstRoundNo: 10n,
      // The player deploys by hand at round 12, which is what opens the session.
      signingFor: (roundNo) => (roundNo >= 12n ? SIGNS_SILENTLY : { kind: "blocked", reason: "needs-session" }),
    });

    expect(run.landedRounds).toEqual([12n, 13n]);
  });
});

// =============================================================================================
// The bounds it was armed with
// =============================================================================================

/** The limits with one figure moved. Everything not named stays out of the way, so a scenario about
 *  the budget cannot fail on the drawdown stop. */
const limits = (over: Partial<AutoLimits>): AutoLimits => ({ ...AMPLE_LIMITS, ...over });

describe("the limits stop it, and stop it honestly", () => {
  it("spends its budget to the last cent and not one past it", () => {
    // The final round of a run is a PARTIAL one, not a refused one: $10 of a $60 budget is left, so
    // $10 goes in. A rule that refused the remainder would leave money it was told it could spend,
    // and one that sent the full $25 would spend money it was told it could not.
    const run = runRounds({ state: armed({ limits: limits({ budgetUsd: 60 }) }), rounds: 5 });

    expect(run.sent.map((s) => s.amountUsd)).toEqual([25, 25, 10]);
    expect(run.state.tally.spentUsd).toBe(60);
    expect(run.state.tally.entered).toBe(3);
    // And it does not top itself up: the rounds after it send nothing at all.
    expect(holdText("budget-spent", armed({ limits: limits({ budgetUsd: 60 }) }), 4n, READABLE_FLAT)).toContain(
      "never tops itself up",
    );
  });

  it("stops a $25 repeat after ten rounds on the limits it ships with", () => {
    // What `DEFAULT_LIMITS` actually means to somebody who arms this and walks away: $250, which is
    // ten rounds at the stake this page's presets sit around. Every other scenario in this file sets
    // the limits out of the way, so this is where the shipped figure is held to account — and it
    // matters more than it used to, because a play session no longer runs out first.
    const run = runRounds({
      state: armed({ limits: { ...DEFAULT_LIMITS, drawdownStopPct: null } }),
      rounds: 14,
    });

    expect(run.landedRounds).toHaveLength(10);
    expect(run.state.tally.spentUsd).toBe(DEFAULT_LIMITS.budgetUsd);
  });

  it("stops when the run is down more than the drawdown stop allows", () => {
    // `SOCIAL.md` §5.4's stop, and the only one of the five that is new mechanism. Half of a $200
    // budget is $100, so a run that is $100 down stops — before the budget is spent, which is the
    // whole point of having it as well as a budget.
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 200, drawdownStopPct: 50 }) }),
      rounds: 6,
      // Every round this run enters settles $25 down.
      roundPnlFor: () => -25,
    });

    // Rounds 1-4 are entered; by round 5 the run is $100 down and it stops with $100 of budget still
    // unspent. A budget alone would have played twice as long.
    expect(run.landedRounds).toEqual([1n, 2n, 3n, 4n]);
    expect(run.state.tally.spentUsd).toBe(100);
    expect(holdText("drawdown-stopped", armed({ limits: limits({ budgetUsd: 200, drawdownStopPct: 50 }) }), 5n, READABLE_FLAT))
      .toContain("$100");
  });

  it("does not treat a profitable run as a small loss", () => {
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 200, drawdownStopPct: 50 }) }),
      rounds: 3,
      roundPnlFor: () => 400,
    });
    expect(run.landedRounds).toEqual([1n, 2n, 3n]);
  });

  it("refuses to deposit again while a drawdown stop cannot be checked", () => {
    // THE FAILURE THAT WOULD BE INVISIBLE. A P&L nothing can read is not a P&L of zero, and a stop
    // that silently passes on an unreadable number is a no-op at exactly the moment it is supposed to
    // fire. So it holds — loudly, with a sentence — and clears itself the moment the figure returns.
    //
    // IT TAKES ITS FIRST ROUND, AND THAT IS THE CORRECTION rather than a weakening. A run that has
    // not deposited a cent cannot be down anything, so zero is a fact about it and not a guess; the
    // derived version answered null there too and held a freshly armed rule forever on a ledger it
    // had not yet written a line in. The hold engages the moment there IS something outstanding,
    // which is from the second round on.
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 200, drawdownStopPct: 50 }) }),
      rounds: 3,
      roundPnlFor: () => null,
    });

    expect(run.landedRounds).toEqual([1n]);
    expect(run.abandoned).toEqual([]);
    expect(readRunPnl(run.state.pnl, run.roundLog, YOU_KEY)).toEqual({ kind: "unreadable", bookedUsd: 0 });
    expect(holdText("drawdown-unknown", armed(), 1n, READABLE_FLAT)).toContain("cannot be checked");
  });

  it("does not need a profit and loss at all when no drawdown stop is set", () => {
    // Turning the stop off is a real setting, not a way to break the rule: with no stop there is
    // nothing to evaluate and an unreadable ledger stops nothing.
    const run = runRounds({
      state: armed({ limits: limits({ drawdownStopPct: null }) }),
      rounds: 3,
      roundPnlFor: () => null,
    });
    expect(run.landedRounds).toEqual([1n, 2n, 3n]);
  });

  it("keeps depositing long after the round log has forgotten where the run started", () => {
    // THE REGRESSION FOR THE DEFECT THIS RULE WAS BUILT AROUND. The run's P&L used to be re-derived
    // by re-reading the log over the run's whole span, and the chain keeps about
    // `MIN_RETAINED_ROUNDS`. So a run longer than that could not be measured at all: the figure went
    // permanently unknown, the drawdown stop held the rule, and an overnight run stopped after about
    // half an hour with a status line a player could not tell from a working pause. Forty rounds is
    // twice the window; under the derived version this run lands twenty deposits and then goes quiet.
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 10_000, drawdownStopPct: 50 }) }),
      rounds: 40,
      roundPnlFor: () => -1,
    });

    expect(run.landedRounds).toHaveLength(40);
    expect(run.roundLog).toHaveLength(MIN_RETAINED_ROUNDS);
    // Every round accounted for, out of a log that never held more than twenty of them.
    expect(readRunPnl(run.state.pnl, run.roundLog, YOU_KEY)).toEqual({ kind: "known", usd: -40 });
  });

  it("stops with its own words when a round it entered settled unseen and aged off the chain", () => {
    // THE INVARIANT THE OLD CODE WAS RIGHT ABOUT, kept where it belongs. Round 1's record never
    // reaches this tab, and once it is outside the retention window no later read will bring it
    // back — so what that round did is unknowable, and an unknowable settlement may never be counted
    // as no loss. It holds; unlike every other pause in this feature it will not lift by itself, and
    // that is exactly what its sentence says.
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 10_000, drawdownStopPct: 50 }) }),
      rounds: 24,
      roundPnlFor: (roundNo) => (roundNo === 1n ? null : -1),
    });

    expect(run.landedRounds).toEqual([1n]);
    const reading = readRunPnl(run.state.pnl, run.roundLog, YOU_KEY);
    expect(reading).toEqual({ kind: "gap", fromRound: 1n, bookedUsd: 0 });

    // ONE VERDICT, TWO SENTENCES. The hold is `drawdown-unknown` because nothing that switches on a
    // hold would branch differently — see `LimitBlock`'s note — but the words a player acts on are
    // not the same words, and this is the assertion that keeps them apart. The transient sentence
    // tells them to wait; the permanent one must not, because waiting will never help.
    const stopped = armed({ limits: limits({ budgetUsd: 10_000, drawdownStopPct: 50 }), pnl: run.state.pnl });
    const gapText = holdText("drawdown-unknown", stopped, 24n, reading);
    expect(gapText).toContain("Round 1");
    expect(gapText).toContain("will not become");
    expect(gapText).toContain("Arm a fresh run");
    expect(holdText("drawdown-unknown", stopped, 24n, READABLE_FLAT)).not.toContain("Round 1");
  });

  it("plays the number of rounds it was told and then stops", () => {
    // §5.4's optional ceiling, "for people who think in rounds rather than hours". It counts rounds
    // ENTERED, not rounds that went by — a round the lobby closed on is not one this played.
    const run = runRounds({ state: armed({ limits: limits({ maxRounds: 3 }) }), rounds: 6 });

    expect(run.landedRounds).toEqual([1n, 2n, 3n]);
    expect(holdText("round-ceiling", armed({ limits: limits({ maxRounds: 3 }) }), 4n, READABLE_FLAT)).toContain("3 rounds");
  });

  it("carries on at the next round when the budget is raised, without restarting the run", () => {
    // `budget-spent` is a derived hold, so raising the budget lifts it with no re-arm — which
    // matters because re-arming would reset the tally, and the tally is the account of the night.
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 50 }) }),
      rounds: 5,
      onTick: ({ state, roundNo }) =>
        roundNo === 4n ? setLimits(state, limits({ budgetUsd: 150 })) : state,
    });

    expect(run.landedRounds).toEqual([1n, 2n, 4n, 5n]);
    // One run, not two: the same arming stamp, and rounds 1 and 5 still its two ends.
    expect(run.state.tally.armedAtMs).toBe(T0);
    expect(run.state.tally.firstRound).toBe(1n);
    expect(run.state.tally.lastRound).toBe(5n);
  });

  it("counts what confirmed, never what was attempted", () => {
    // A round that took three transactions to land cost one stake. A budget enforced against
    // attempts would tell a player they had spent three times what they did, and then stop early on
    // the strength of it.
    const run = runRounds({
      state: armed({ limits: limits({ budgetUsd: 60 }) }),
      rounds: 2,
      enter: (_roundNo, attemptNo) => (attemptNo < 3 ? failed("RPC timeout") : landed()),
    });

    expect(run.sent.length).toBeGreaterThan(2);
    expect(run.state.tally.spentUsd).toBe(50);
    expect(run.state.tally.entered).toBe(2);
  });

  it("says the budget ran out rather than blaming the wallet, when both are true", () => {
    // TWO TRUE THINGS AND ONE OF THEM IS USELESS. A percentage rule against a drained simulated
    // wallet and a spent budget are both true at once; the ladder used to answer with the wallet —
    // "10% of the simulated wallet is under $0.01, nothing will be deposited until it is topped up" —
    // to somebody whose budget was the thing that had run out. Topping the wallet up would not have
    // restarted the run. The limits are asked first because they name the control that would.
    const decision = decideAutoDeploy({
      state: armed({ rule: { kind: "pct", pct: 10 }, limits: limits({ budgetUsd: 25 }), tally: { ...EMPTY_TALLY, spentUsd: 25, entered: 1, firstRound: 1n, lastRound: 1n, lastOutcome: "entered" } }),
      roundNo: 9n,
      targetRoundNo: 9n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      // The simulated wallet is empty too, so `resolveAmountUsd` has already declined.
      amountUsd: null,
      signing: SIGNS_SILENTLY,
      sessionEpoch: ONE_SESSION,
      roundLog: NO_LOG,
      youPubkey: YOU_KEY,
      nowMs: 0,
    });
    expect(decision).toEqual({ kind: "hold", reason: "budget-spent" });
  });

  it("does not charge the budget for a deposit the player made themselves", () => {
    // `noteRoundEntered` is the page-wide confirmed-enter path and fires for every deposit however it
    // was made. This tally is the RULE's account of itself: charging a hand deploy to the budget the
    // player gave the rule would stop an armed run early for a reason no status line could explain.
    const byHand = noteRoundEntered(armed(), 3n);
    expect(byHand.tally.spentUsd).toBe(0);
    expect(byHand.tally.entered).toBe(0);
  });

  it("books one automatic deposit once, whichever of the two callbacks arrives first", () => {
    // Both fire for one automatic deposit, from callbacks that do not know about each other, in an
    // order nothing guarantees: `attemptLanded` when the transaction confirms, `noteRoundEntered`
    // from the page-wide enter path. A double count would halve the run.
    const sending = beginAttempt(armed(), 3n);
    const landedFirst = noteRoundEntered(attemptLanded(sending, 3n, "sig", 25, YOU_KEY), 3n);
    const notedFirst = attemptLanded(noteRoundEntered(sending, 3n), 3n, "sig", 25, YOU_KEY);

    expect(landedFirst.tally.spentUsd).toBe(25);
    expect(landedFirst.tally.entered).toBe(1);
    expect(notedFirst.tally.spentUsd).toBe(25);
    expect(notedFirst.tally.entered).toBe(1);
  });
});

// =============================================================================================
// Arming a run
// =============================================================================================

describe("arming starts a run rather than resuming one", () => {
  it("is off until somebody asks for it", () => {
    // A default that armed this would be the page deciding how much of a stranger's bankroll it may
    // put at risk before they have read a word about it.
    expect(ARMED_BY_DEFAULT).toBe(false);
    expect(INITIAL_AUTO_DEPLOY.armed).toBe(false);
  });

  it("starts the account and the budget from zero, and drops a stale lapse", () => {
    const spent = noteSessionRefused(
      attemptLanded(beginAttempt(armed(), 3n), 3n, "sig", 25, YOU_KEY),
      4n,
      ONE_SESSION,
    );
    expect(spent.tally.spentUsd).toBe(25);

    const again = armWith(spent, {
      strategy: { amount: { kind: "pct", pct: 10 }, side: { kind: "repeat" } },
      limits: { budgetUsd: 400, perRoundCapUsd: 50, drawdownStopPct: 25, maxRounds: 30 },
      visibleRoundNo: 9n,
      nowMs: T0 + 60_000,
    });

    expect(again.tally).toEqual({ ...EMPTY_TALLY, armedAtMs: T0 + 60_000 });
    expect(again.rule).toEqual({ kind: "pct", pct: 10 });
    expect(again.limits.budgetUsd).toBe(400);
    expect(again.floorRound).toBe(9n);
    // A run that has just begun has had nothing refused. It is not a reset button for the latch —
    // that clears on its own when a session is opened — it is simply true.
    expect(again.deadSessionEpoch).toBeNull();
  });

  it("keeps the limits and the side rule when only the amount is being armed", () => {
    // The checkbox in the Deploy panel commits one control. Everything it does not name is a setting
    // the player made elsewhere and did not just change.
    const withLimits = setLimits(armed(), limits({ budgetUsd: 90, perRoundCapUsd: 30 }));
    const re = arm(withLimits, { rule: { kind: "fixed", usd: 7 }, visibleRoundNo: null, nowMs: T0 });
    expect(re.limits).toEqual(limits({ budgetUsd: 90, perRoundCapUsd: 30 }));
    expect(re.sideRule).toEqual({ kind: "repeat" });
    expect(re.rule).toEqual({ kind: "fixed", usd: 7 });
  });

  it("treats an unchanged limit as a no-op, because the panel pushes it down every render", () => {
    // Same contract as `setRule`: a fresh object for an unchanged value commits, re-renders, re-runs
    // the effect and calls itself again — a render loop dressed as a state update.
    const s = armed();
    expect(setLimits(s, { ...s.limits })).toBe(s);
    expect(setLimits(s, { ...s.limits, budgetUsd: s.limits.budgetUsd + 1 })).not.toBe(s);
  });
});

describe("every state the panel can be in has words for it", () => {
  it("describes every hold reason without falling through to a blank", () => {
    // A RECORD RATHER THAN A LIST, so the compiler is what keeps this exhaustive. As a list it was a
    // dozen strings somebody had to remember to extend, and the cost of forgetting is a status line
    // that renders `undefined` at the moment a player is asking why their money is not moving.
    const everyHold: Record<HoldReason, true> = {
      "disarmed": true, "no-side": true, "no-round": true, "round-changing": true,
      "waiting-for-next-round": true, "deployed-this-round": true, "missed-this-round": true,
      "sending": true, "already-in": true, "amount-unusable": true, "busy": true,
      "backing-off": true, "session-lapsed": true, "needs-session": true, "session-stopped": true,
      "session-unaffordable": true, "no-signer": true, "drawdown-stopped": true,
      "drawdown-unknown": true, "budget-spent": true, "round-ceiling": true,
    };
    for (const r of Object.keys(everyHold) as HoldReason[]) {
      const text = holdText(r, armed(), 9n, READABLE_FLAT);
      expect(text.length).toBeGreaterThan(8);
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("NaN");
    }
  });

  it("tells a held player what to do about it, not merely what is true", () => {
    // SPEC's copy rule, on the states this feature added: every one of them is a thing the player
    // can change, so every one of them names the change. A status line that describes the situation
    // and stops is the exact pattern that rule exists to forbid.
    const state = armed({ limits: limits({ budgetUsd: 250, drawdownStopPct: 50, maxRounds: 40 }) });
    expect(holdText("session-lapsed", state, 9n, READABLE_FLAT)).toMatch(/wallet panel/);
    expect(holdText("needs-session", state, 9n, READABLE_FLAT)).toMatch(/by hand|Start/);
    expect(holdText("session-stopped", state, 9n, READABLE_FLAT)).toMatch(/Start/);
    expect(holdText("session-unaffordable", state, 9n, READABLE_FLAT)).toMatch(/Top up/);
    expect(holdText("no-signer", state, 9n, READABLE_FLAT)).toMatch(/wallet panel/);
    expect(holdText("drawdown-stopped", state, 9n, READABLE_FLAT)).toMatch(/Widen the drawdown stop/);
    expect(holdText("drawdown-unknown", state, 9n, READABLE_FLAT)).toMatch(/turn the drawdown stop off/);
    expect(holdText("round-ceiling", state, 9n, READABLE_FLAT)).toMatch(/Raise the ceiling/);
    expect(holdText("budget-spent", state, 9n, READABLE_FLAT)).toMatch(/Raise it/);
    // And each says when it comes back, because "it stopped" without "it starts again at the next
    // round" reads as a fault rather than a pause.
    for (const r of ["session-lapsed", "needs-session", "session-stopped", "session-unaffordable",
      "no-signer", "drawdown-stopped", "drawdown-unknown", "budget-spent", "round-ceiling"] as HoldReason[]) {
      expect(holdText(r, state, 9n, READABLE_FLAT)).toContain("next round");
    }
  });

  it("describes every way a round can be lost", () => {
    const everyLoss: Record<AbandonReason, true> = {
      "entries-closed": true, "phase-moved-on": true, "retries-exhausted": true,
      "round-moved-on": true, "session-lapsed": true,
    };
    for (const r of Object.keys(everyLoss) as AbandonReason[]) {
      expect(abandonText(r, null).length).toBeGreaterThan(8);
      expect(abandonText(r, null)).not.toContain("undefined");
    }
  });

  it("says a lapsed session ran out rather than that the transaction failed", () => {
    // The chain's word for it is `InvalidToken`, which names a symptom and hides both the cause and
    // the one press that fixes it.
    const text = abandonText("session-lapsed", "custom program error: InvalidToken");
    expect(text).toContain("session");
    expect(text).not.toContain("InvalidToken");
  });
});
