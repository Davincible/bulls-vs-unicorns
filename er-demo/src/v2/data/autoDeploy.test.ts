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

import { describe, expect, it } from "vitest";
import {
  ENTRY_CLOSE_GUARD_MS,
  MIN_STAKE_USD,
  STAKE_CAP_USD,
  entriesOpen,
  entrySecondsLeft,
  type LiveRound,
  type PhaseName,
  type Side,
} from "../contract.ts";
import {
  INITIAL_AUTO_DEPLOY,
  MAX_TRIES,
  RETRY_BACKOFF_MS,
  abandonAttempt,
  abandonText,
  arm,
  attemptFailed,
  attemptLanded,
  beginAttempt,
  decideAutoDeploy,
  disarm,
  expireStaleAttempt,
  holdText,
  noteDeploy,
  noteRoundEntered,
  resolveAmountUsd,
  simBankrollUsd,
  type AbandonReason,
  type AutoDeployState,
} from "./autoDeploy.ts";

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
};

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

  const decision = decideAutoDeploy({
    state: s,
    roundNo: world.live?.roundNo ?? null,
    targetRoundNo: world.targetRoundNo === undefined ? (world.live?.roundNo ?? null) : world.targetRoundNo,
    phase: world.live?.phase ?? null,
    entriesOpen: entriesOpen(world.live, world.nowMs),
    alreadyIn: world.alreadyIn,
    entering: world.entering,
    amountUsd: resolveAmountUsd(s.rule, world.simWalletUsd),
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
  s =
    verdict.error === null
      ? attemptLanded(s, decision.roundNo, verdict.signature)
      : attemptFailed(s, decision.roundNo, verdict.error, world.nowMs);

  return {
    state: s,
    sent: {
      roundNo: decision.roundNo,
      side: decision.side,
      amountUsd: decision.amountUsd,
      attemptNo: decision.attemptNo,
    },
    abandoned: null,
  };
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
  /** Called once per simulated second, so a scenario can arm, disarm or change the rule mid-run. */
  onTick?: (ctx: { state: AutoDeployState; roundNo: bigint; phase: PhaseName; secondInPhase: number }) => AutoDeployState;
}

interface RunResult {
  state: AutoDeployState;
  sent: { roundNo: bigint; side: Side; amountUsd: number; attemptNo: number }[];
  abandoned: { roundNo: bigint; reason: AbandonReason }[];
  /** Rounds a deposit CONFIRMED into — the only measure that matters. */
  landedRounds: bigint[];
}

/**
 * WALK N COMPLETE ROUNDS, one simulated second per tick.
 *
 * Models the four things a real tab is actually up against, all of which the previous implementation
 * ignored: a round is not seen the instant it opens, `Lobby` outlives the deposit deadline, a
 * confirmed entry shows up in the roster a beat later, and transactions fail.
 */
function runRounds(opts: RunOptions): RunResult {
  const shape = opts.shape ?? NORMAL_ROUND;
  const discovery = opts.discoverySeconds ?? 3;
  const simWalletUsd = opts.simWalletUsd ?? 500;
  const enterFn = opts.enter ?? (() => landed() as EnterVerdict);

  let state = opts.state;
  const sent: RunResult["sent"] = [];
  const abandoned: RunResult["abandoned"] = [];
  const landedRounds: bigint[] = [];

  let nowMs = 1_700_000_000_000;
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

        if (opts.onTick && live !== null) {
          state = opts.onTick({ state, roundNo, phase, secondInPhase: s });
        }

        const result = tick(state, { live, alreadyIn, entering: false, simWalletUsd, nowMs }, (rn) => {
          const prior = sent.filter((x) => x.roundNo === rn).length;
          return enterFn(rn, prior + 1);
        });
        state = result.state;
        if (result.sent) {
          sent.push(result.sent);
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

  return { state, sent, abandoned, landedRounds };
}

/** Armed, with a side already known — the state a player is in after one manual deploy. */
function armed(over: Partial<AutoDeployState> = {}): AutoDeployState {
  return {
    ...arm(noteDeploy(INITIAL_AUTO_DEPLOY, 1), { rule: { kind: "fixed", usd: 25 }, visibleRoundNo: null }),
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
          ? arm(noteDeploy(state, 1), { rule: { kind: "fixed", usd: 10 }, visibleRoundNo: roundNo })
          : state,
    });

    expect(run.landedRounds).toEqual([21n, 22n, 23n]);
    // And round 20 is not reported as missed either — it was never this rule's round to enter.
    expect(run.abandoned).toEqual([]);
  });

  it("names the round it will start from, so arming has no unstated consequence", () => {
    const s = arm(INITIAL_AUTO_DEPLOY, { rule: { kind: "fixed", usd: 10 }, visibleRoundNo: 20n });
    expect(s.floorRound).toBe(20n);
    expect(holdText("waiting-for-next-round", s, 20n)).toContain("round 21");
  });

  it("takes the very next round when nothing was open at the moment of arming", () => {
    // There was no round in progress to protect the player from, so waiting a whole extra round
    // would be the surprise instead.
    const run = runRounds({
      state: arm(noteDeploy(INITIAL_AUTO_DEPLOY, 0), {
        rule: { kind: "fixed", usd: 10 },
        visibleRoundNo: null,
      }),
      rounds: 2,
      firstRoundNo: 7n,
    });
    expect(run.landedRounds).toEqual([7n, 8n]);
  });

  it("deposits in the opening seconds of the lobby, not at some point during it", () => {
    // The other half of B5's wording: when it does fire, it fires at the start. The only delay is
    // the tab noticing the round exists.
    const run = runRounds({ state: armed(), rounds: 1, discoverySeconds: 3 });
    expect(run.sent).toHaveLength(1);
    // Sent on the first tick that could see the round — nothing later.
    expect(run.state.attempt?.outcome).toBe("landed");
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
      nowMs: 1_700_000_000_000,
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
    const run = runRounds({
      state: armed(),
      rounds: 3,
      firstRoundNo: 60n,
      onTick: ({ state }) => state,
      // The player deploys into round 61 themselves, five seconds in.
      enter: () => landed(),
    });
    // Baseline: three rounds, three deposits.
    expect(run.sent).toHaveLength(3);

    const decision = decideAutoDeploy({
      state: armed(),
      roundNo: 61n,
      targetRoundNo: 61n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: true,
      entering: false,
      amountUsd: 25,
      nowMs: 0,
    });
    expect(decision).toEqual({ kind: "hold", reason: "already-in" });
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
    // Not a miss to report either: nothing failed and nothing was lost — the rule declined. The
    // panel's status line carries the reason for as long as it is true.
    expect(run.abandoned.every((a) => a.reason === "entries-closed")).toBe(true);
    expect(holdText("amount-unusable", armed({ rule: { kind: "pct", pct: 10 } }), 1n)).toContain(
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
    expect(Object.keys(run.state).sort()).toEqual(["armed", "attempt", "floorRound", "rule", "side"]);
  });

  it("closes the books on a round overtaken mid-retry", () => {
    const retrying = attemptFailed(beginAttempt(armed(), 8n), 8n, "timeout", 0);
    const next = expireStaleAttempt(retrying, 9n);
    expect(next.attempt).toMatchObject({ roundNo: 8n, outcome: "abandoned", abandonedBecause: "round-moved-on" });
  });

  it("leaves a finished round's record alone", () => {
    const done = attemptLanded(beginAttempt(armed(), 8n), 8n, "sig");
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
    const landedLate = attemptLanded(sending, 8n, "sig-late");
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
    const s = arm(INITIAL_AUTO_DEPLOY, { rule: { kind: "fixed", usd: 5 }, visibleRoundNo: null });
    expect(decideAutoDeploy({
      state: s,
      roundNo: 1n,
      targetRoundNo: 1n,
      phase: "Lobby",
      entriesOpen: true,
      alreadyIn: false,
      entering: false,
      amountUsd: 5,
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
      nowMs: 0,
    })).toEqual({ kind: "hold", reason: "disarmed" });
  });
});

describe("every state the panel can be in has words for it", () => {
  it("describes every hold reason without falling through to a blank", () => {
    const reasons = [
      "disarmed", "no-side", "no-round", "round-changing", "waiting-for-next-round",
      "deployed-this-round", "missed-this-round", "sending", "already-in", "amount-unusable",
      "busy", "backing-off",
    ] as const;
    for (const r of reasons) {
      const text = holdText(r, armed(), 9n);
      expect(text.length).toBeGreaterThan(8);
      expect(text).not.toContain("undefined");
    }
  });

  it("describes every way a round can be lost", () => {
    const reasons: AbandonReason[] = [
      "entries-closed", "phase-moved-on", "retries-exhausted", "round-moved-on",
    ];
    for (const r of reasons) {
      expect(abandonText(r, null).length).toBeGreaterThan(8);
      expect(abandonText(r, null)).not.toContain("undefined");
    }
  });
});
