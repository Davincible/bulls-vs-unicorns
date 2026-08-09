// REPEAT EVERY ROUND — the rule that spends money when nobody is watching.
//
// This is a POLICY, not a control. It used to live inside the Deploy panel, which meant the answer to
// "will this deposit my money into the next round?" depended on which tab of the app was on screen —
// switching to the Leaderboard unmounted the panel and silently disarmed the rule, and switching back
// re-armed nothing. That is not a rendering bug with a money-shaped symptom; it is a money rule that
// was accidentally scoped to a component. So it lives here, is held above the view switch, and this
// file contains no React at all.
//
// EVERY DECISION IS A PURE FUNCTION OF STATED INPUTS. `decideAutoDeploy` is the whole rule and it
// takes no clocks, no refs and no network — which is why the state machine is exercised in
// `autoDeploy.test.ts` across hundreds of round sequences rather than by watching a browser and
// hoping. A feature that spends money on its own has to be provable, and a browser proves one run.
//
// THE THREE THINGS THAT MADE THE OLD ONE UNRELIABLE, and what replaced each:
//
//   1. A FAILED DEPLOY WAS INDISTINGUISHABLE FROM A SKIPPED ONE. The old effect marked the round done
//      BEFORE awaiting the transaction, so any failure — an empty burner, an RPC blip, a lobby that
//      closed underneath it — silently dropped that round forever. Here an attempt is a record with
//      an outcome: it retries while the lobby is still open, and when it genuinely cannot be entered
//      the round is ABANDONED with a reason that gets said out loud. Silence is not an outcome.
//
//   2. `phase === "Lobby"` IS NOT "YOU CAN DEPOSIT". The program refuses `enter` at `lobby_closes_at`
//      but the phase only moves when an operator's `close_lobby_and_draw` lands, which is a separate
//      transaction sent at a human's pace. Every round therefore has a window — often longer than the
//      lobby itself — where the phase says Lobby and the chain says LobbyClosed. Deciding on the
//      phase alone is a coin toss, and a coin toss is exactly what "fires some rounds, not others"
//      looks like from the outside. `entriesOpen` (see contract.ts) is the input, not the phase.
//
//      AS OF WRITING THE DEADLINE IS NOT YET DEPLOYED. The lobby fields exist in `programs/bulls-
//      arena/src/lib.rs` and in the IDL, but the program on devnet is an earlier revision with no
//      deadline at all — verified against the deployed ELF and the 1077-byte round accounts, not
//      assumed. On that revision `Lobby` genuinely is the whole answer, `lobbyClosesAtMs` reads null,
//      and `entriesOpen` degrades to the phase check, which is correct THERE. So this rule is right
//      on both revisions, and the day the deadline ships it gets sharper without a line changing.
//
//   3. THE AMOUNT WAS NOT DURABLE. "Fixed $" read the panel's own stake field, so the same unmount
//      that disarmed the rule also reset a $100 repeat to the $5 default. The rule is snapshotted
//      when it is armed and travels with the state.

import {
  MIN_STAKE_USD,
  STAKE_CAP_USD,
  usd,
  usdToUnits,
  type PhaseName,
  type Side,
  type SimBalances,
} from "../contract.ts";

/** Attempts at one round before it is given up on. Three is enough to ride out a dropped request or a
 *  blockhash that expired in flight, and few enough that a genuinely broken setup (an unfunded
 *  burner) is reported within a few seconds instead of hammering the RPC for a whole lobby. */
export const MAX_TRIES = 3;

/** Between attempts. One round-poll interval: long enough that a retry is answering a NEW state of
 *  the world rather than re-asking the same question, short enough to fit three of them inside the
 *  shortest lobby the program allows (`MIN_LOBBY_SECONDS`, 30s). */
export const RETRY_BACKOFF_MS = 2000;

// ---------------------------------------------------------------------------------------------
// What is armed
// ---------------------------------------------------------------------------------------------

/** HOW MUCH, snapshotted at the moment of arming.
 *
 *  `pct` is a percentage of the SIMULATED wallet, and it is worth being blunt about what that means:
 *  the program custodies nothing, so there is no on-chain balance to take a percentage of. The rule
 *  models the original product's bankroll sizing against `simLedger.ts`, and the transaction it sizes
 *  is real. It therefore constrains nothing — a drained simulated wallet does not stop a real
 *  deposit, it only makes the rule resolve to a figure too small to send, which is a refusal and is
 *  reported as one (see `resolveAmountUsd`). Every surface offering this rule carries the `SIM`
 *  marker for the same reason. */
export type AmountRule =
  | { kind: "fixed"; usd: number }
  | { kind: "pct"; pct: number };

export type AttemptOutcome =
  /** A transaction is in flight for this round right now. */
  | "sending"
  /** Confirmed. This round is done and will not be touched again. */
  | "landed"
  /** A try failed and another is scheduled. */
  | "retrying"
  /** This round will not be entered. Terminal, and always carries a reason. */
  | "abandoned";

export type AbandonReason =
  /** The lobby's on-chain deadline passed before a deposit could land. */
  | "entries-closed"
  /** The round left Lobby — drawn, fighting or settled — before a deposit could land. */
  | "phase-moved-on"
  /** Every try failed. `error` carries the last one, verbatim from the chain. */
  | "retries-exhausted"
  /** A newer round appeared while this one was still being tried. */
  | "round-moved-on";

export interface AutoDeployAttempt {
  roundNo: bigint;
  outcome: AttemptOutcome;
  /** Transactions actually sent for this round, not including the one currently in flight until it
   *  resolves. */
  tries: number;
  /** Epoch ms; set only while `retrying`. */
  nextTryAtMs: number | null;
  /** Set only when `landed` — the confirmed signature, which is the only proof worth keeping. */
  signature: string | null;
  /** The chain's own last error message, kept verbatim. Set while `retrying` and on an `abandoned`
   *  round that ran out of tries. */
  error: string | null;
  abandonedBecause: AbandonReason | null;
}

export interface AutoDeployState {
  armed: boolean;
  /** The side the next automatic deposit goes to — whichever side was deployed to last, by any
   *  surface. Null until this browser has deployed once, which is what "arms after your first
   *  deploy" means. */
  side: Side | null;
  rule: AmountRule;
  /** THE ROUND THAT WAS ALREADY IN PROGRESS WHEN THIS WAS ARMED, and which it therefore leaves alone.
   *
   *  Ticking a box must never spend money on the spot. The round on screen at that moment is one the
   *  player has already had the chance to enter by hand — the Deploy buttons are directly above the
   *  checkbox — so arming applies from the NEXT round onward, and the panel names that round.
   *
   *  Null means no round was in progress when it was armed (nothing had opened yet, or the page was
   *  on the fixture), in which case there is no in-progress round to protect and the first round seen
   *  is eligible. */
  floorRound: bigint | null;
  /** The one round being worked on, or the last one that was. Exactly one record, never a growing
   *  set: round numbers only ever increase, so anything older than the current round is history that
   *  no decision can depend on. */
  attempt: AutoDeployAttempt | null;
}

export const INITIAL_AUTO_DEPLOY: AutoDeployState = {
  armed: false,
  side: null,
  rule: { kind: "fixed", usd: 5 },
  floorRound: null,
  attempt: null,
};

// ---------------------------------------------------------------------------------------------
// How much
// ---------------------------------------------------------------------------------------------

/**
 * The dollar figure this rule would send right now, or NULL if it would not send anything.
 *
 * Null is the important half. The old rule clamped its result up to a one-cent floor, so a percentage
 * of a simulated wallet that had run dry did not stop — it quietly became a $0.01 deposit, every
 * round, forever, each one paying a real devnet fee to stake a tenth of a cent. A rule that cannot
 * name an amount worth sending must decline and say so, not round its way to a transaction nobody
 * chose.
 */
/** WHAT A PERCENTAGE RULE IS A PERCENTAGE OF: the smaller of the two sides' simulated balances, so
 *  the figure it produces is deployable to EITHER side. The rule follows whichever side was played
 *  last, and that side can change between rounds — sizing off the larger balance would sometimes
 *  produce an amount the side it actually deploys to could not cover. */
export function simBankrollUsd(balances: SimBalances): number {
  return Math.min(balances.ansem, balances.uwu);
}

export function resolveAmountUsd(rule: AmountRule, simWalletUsd: number): number | null {
  const raw = rule.kind === "fixed" ? rule.usd : (simWalletUsd * rule.pct) / 100;
  if (!Number.isFinite(raw)) return null;
  // TESTED BEFORE ROUNDING, deliberately. Rounding first would let a half-cent rule round UP to the
  // one-cent floor and become sendable — which is the same silent degradation this function exists to
  // stop, arriving by a slightly politer route.
  if (raw < MIN_STAKE_USD) return null;
  return Math.min(STAKE_CAP_USD, Math.round(raw * 100) / 100);
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

export type HoldReason =
  | "disarmed"
  /** Nothing has been deployed yet, so there is no side to repeat. */
  | "no-side"
  | "no-round"
  /** The round being read and the round that would be written to disagree — the poll has not caught
   *  up with a newly opened round yet. Deciding here could deposit into a different round from the
   *  one the decision was made about. */
  | "round-changing"
  | "waiting-for-next-round"
  | "deployed-this-round"
  | "missed-this-round"
  | "sending"
  /** There is already a fighter of yours in this round — deployed by hand, or by an earlier try whose
   *  confirmation this is only now seeing. */
  | "already-in"
  | "amount-unusable"
  /** Another deposit is in flight from somewhere else on the page. */
  | "busy"
  | "backing-off";

export type AutoDeployDecision =
  | { kind: "fire"; roundNo: bigint; side: Side; amountUsd: number; attemptNo: number }
  | { kind: "abandon"; roundNo: bigint; reason: AbandonReason }
  | { kind: "hold"; reason: HoldReason };

export interface AutoDeployInput {
  state: AutoDeployState;
  /** The round being READ — `live.roundNo`. */
  roundNo: bigint | null;
  /** The round that would be WRITTEN — the PDA `enter()` actually targets. */
  targetRoundNo: bigint | null;
  phase: PhaseName | null;
  /** Whether a deposit sent this instant would be accepted: `entriesOpen(live, nowMs)`. NOT the
   *  phase. See this file's header, point 2. */
  entriesOpen: boolean;
  /** A fighter of yours is already in this round. */
  alreadyIn: boolean;
  /** A deposit is in flight from any surface on the page. */
  entering: boolean;
  /** `resolveAmountUsd(state.rule, simWalletUsd)`. */
  amountUsd: number | null;
  nowMs: number;
}

const hold = (reason: HoldReason): AutoDeployDecision => ({ kind: "hold", reason });

/**
 * THE WHOLE RULE. Read it top to bottom: each line is a reason not to send money, and the last line
 * is the only way to send any.
 *
 * The ladder is ordered so that the reason it returns is the most useful TRUE thing, not merely the
 * first true thing — "you are already in this round" is a better answer than "the lobby has closed"
 * to someone who deployed by hand thirty seconds ago, so it is asked first.
 */
export function decideAutoDeploy(input: AutoDeployInput): AutoDeployDecision {
  const { state, roundNo, targetRoundNo, phase, entriesOpen, alreadyIn, entering, amountUsd, nowMs } =
    input;

  if (!state.armed) return hold("disarmed");
  if (state.side === null) return hold("no-side");
  if (roundNo === null) return hold("no-round");
  if (targetRoundNo === null || targetRoundNo !== roundNo) return hold("round-changing");
  if (state.floorRound !== null && roundNo <= state.floorRound) return hold("waiting-for-next-round");

  // Bookkeeping for THIS round only. An attempt against any other round is history.
  const attempt = state.attempt !== null && state.attempt.roundNo === roundNo ? state.attempt : null;
  if (attempt?.outcome === "landed") return hold("deployed-this-round");
  if (attempt?.outcome === "abandoned") return hold("missed-this-round");
  if (attempt?.outcome === "sending") return hold("sending");
  if (alreadyIn) return hold("already-in");

  // Past this line the intent is settled: this round is one we mean to enter. Anything that makes
  // that PERMANENTLY impossible ends the round with a reason rather than holding silently until the
  // round number changes and the whole episode disappears without ever being reported.
  if (phase !== "Lobby") return { kind: "abandon", roundNo, reason: "phase-moved-on" };
  if (!entriesOpen) return { kind: "abandon", roundNo, reason: "entries-closed" };
  if (attempt !== null && attempt.tries >= MAX_TRIES) {
    return { kind: "abandon", roundNo, reason: "retries-exhausted" };
  }

  // Temporary reasons to wait. Every one of these resolves on its own; none of them loses the round.
  if (amountUsd === null) return hold("amount-unusable");
  if (entering) return hold("busy");
  if (attempt !== null && attempt.nextTryAtMs !== null && nowMs < attempt.nextTryAtMs) {
    return hold("backing-off");
  }

  return { kind: "fire", roundNo, side: state.side, amountUsd, attemptNo: (attempt?.tries ?? 0) + 1 };
}

// ---------------------------------------------------------------------------------------------
// Transitions — every one a plain function from state to state
// ---------------------------------------------------------------------------------------------

/** Arming captures BOTH the rule and the round to start after, because both are decisions the player
 *  is making at that instant and neither should be re-read from a control that may not exist later. */
export function arm(
  state: AutoDeployState,
  args: { rule: AmountRule; visibleRoundNo: bigint | null },
): AutoDeployState {
  return { ...state, armed: true, rule: args.rule, floorRound: args.visibleRoundNo, attempt: null };
}

export function disarm(state: AutoDeployState): AutoDeployState {
  // The attempt record is kept: "round 41 was missed because the lobby closed" is still the truth
  // about round 41 after the box is unticked, and clearing it would erase the one report of a
  // failure at the exact moment a player might be unticking the box BECAUSE of it.
  return { ...state, armed: false };
}

export function sameRule(a: AmountRule, b: AmountRule): boolean {
  if (a.kind === "fixed" && b.kind === "fixed") return a.usd === b.usd;
  if (a.kind === "pct" && b.kind === "pct") return a.pct === b.pct;
  return false;
}

/** Changing the amount while armed adopts the new rule and leaves the floor alone — the player is
 *  editing how much, not restarting when.
 *
 *  IDENTITY IS PART OF THE CONTRACT here, not an optimisation. The panel pushes its controls down
 *  through an effect, so a `setRule` that returned a fresh object for an unchanged rule would commit,
 *  re-render, re-run the effect and call itself again — a render loop dressed up as a state update.
 *  A no-op has to BE a no-op. */
export function setRule(state: AutoDeployState, rule: AmountRule): AutoDeployState {
  return sameRule(state.rule, rule) ? state : { ...state, rule };
}

/** Every CONFIRMED deposit, from any surface, sets the side a repeat would follow. This is what "it
 *  repeats the side you last played" means, and routing it through the confirmed-enter callback is
 *  what makes it durable — the old version tracked it in component state that a tab switch erased. */
export function noteDeploy(state: AutoDeployState, side: Side): AutoDeployState {
  return state.side === side ? state : { ...state, side };
}

/**
 * A DEPOSIT LANDED IN THIS ROUND — by hand, from the dock, or from this rule. Either way the rule is
 * finished with the round.
 *
 * `alreadyIn` is the same fact read off the chain, and it is the authority — but it arrives up to a
 * poll late. Without this, a player who deploys by hand at the top of a lobby has a second, automatic
 * deposit sent on top of theirs during the second or so before the roster catches up: two
 * transactions, two fees, twice the stake, for one round they only meant to enter once. The rule
 * knows a deposit confirmed before any poll can tell it, so it records it and stops.
 */
export function noteRoundEntered(state: AutoDeployState, roundNo: bigint): AutoDeployState {
  const prior = state.attempt !== null && state.attempt.roundNo === roundNo ? state.attempt : null;
  if (prior?.outcome === "landed") return state;
  return {
    ...state,
    attempt: {
      roundNo,
      outcome: "landed",
      tries: prior?.tries ?? 0,
      nextTryAtMs: null,
      // Null for a deposit this rule did not send. `attemptLanded` fills it in when the rule's own
      // transaction confirms, and a null here is the honest answer to "which transaction was yours".
      signature: prior?.signature ?? null,
      error: null,
      abandonedBecause: null,
    },
  };
}

export function beginAttempt(state: AutoDeployState, roundNo: bigint): AutoDeployState {
  const prior = state.attempt !== null && state.attempt.roundNo === roundNo ? state.attempt : null;
  return {
    ...state,
    attempt: {
      roundNo,
      outcome: "sending",
      tries: prior?.tries ?? 0,
      nextTryAtMs: null,
      signature: null,
      error: prior?.error ?? null,
      abandonedBecause: null,
    },
  };
}

export function attemptLanded(
  state: AutoDeployState,
  roundNo: bigint,
  signature: string,
): AutoDeployState {
  if (state.attempt === null || state.attempt.roundNo !== roundNo) return state;
  return {
    ...state,
    attempt: {
      ...state.attempt,
      outcome: "landed",
      tries: state.attempt.tries + 1,
      nextTryAtMs: null,
      signature,
      error: null,
    },
  };
}

export function attemptFailed(
  state: AutoDeployState,
  roundNo: bigint,
  error: string,
  nowMs: number,
): AutoDeployState {
  if (state.attempt === null || state.attempt.roundNo !== roundNo) return state;
  // A round that has ALREADY had a deposit is finished, whoever sent it. This rule's own transaction
  // failing afterwards is not a reason to try again — that would deposit twice into a round the
  // player is demonstrably already in. See `noteRoundEntered`.
  if (state.attempt.outcome === "landed") return state;
  return {
    ...state,
    attempt: {
      ...state.attempt,
      outcome: "retrying",
      tries: state.attempt.tries + 1,
      nextTryAtMs: nowMs + RETRY_BACKOFF_MS,
      error,
    },
  };
}

export function abandonAttempt(
  state: AutoDeployState,
  roundNo: bigint,
  reason: AbandonReason,
): AutoDeployState {
  const prior = state.attempt !== null && state.attempt.roundNo === roundNo ? state.attempt : null;
  return {
    ...state,
    attempt: {
      roundNo,
      outcome: "abandoned",
      tries: prior?.tries ?? 0,
      nextTryAtMs: null,
      signature: null,
      error: prior?.error ?? null,
      abandonedBecause: reason,
    },
  };
}

/**
 * CLOSE THE BOOKS ON A ROUND THAT HAS BEEN OVERTAKEN.
 *
 * `decideAutoDeploy` holds on `round-changing` while the poll catches up to a newly opened round,
 * which is right — but it means a round still mid-retry when the next one appears would otherwise
 * have its record quietly overwritten and never be reported as missed. Called before every decision,
 * so an unfinished attempt always ends with a stated reason.
 */
export function expireStaleAttempt(state: AutoDeployState, roundNo: bigint | null): AutoDeployState {
  const a = state.attempt;
  if (a === null || roundNo === null || a.roundNo >= roundNo) return state;
  // ONLY A RETRY IS EXPIRED HERE. A `sending` attempt has a transaction in flight, and that
  // transaction gets to decide its own outcome — writing it off because a newer round appeared would
  // report a round as missed while the deposit into it was landing, which is the worst kind of wrong:
  // a report that contradicts the chain. If it fails it becomes `retrying`, and the next call
  // collects it. `landed` and `abandoned` are already settled.
  if (a.outcome !== "retrying") return state;
  return abandonAttempt(state, a.roundNo, "round-moved-on");
}

// ---------------------------------------------------------------------------------------------
// What the page gets to see
// ---------------------------------------------------------------------------------------------

/** THE WHOLE FEATURE, as every surface sees it. Declared beside the rule rather than beside the hook
 *  so `data/types.ts` can name it without importing React — the same reason `ArenaContextValue` lives
 *  apart from the provider that builds it. */
export interface AutoDeployHandle {
  armed: boolean;
  side: Side | null;
  rule: AmountRule;
  /** What the next automatic deposit would send, in dollars, or null if the rule currently resolves
   *  to nothing worth sending. The panel shows this figure; it is never a guess. */
  nextAmountUsd: number | null;
  /** The first round this will act on — `floorRound + 1`, or null when it will take the next round to
   *  open whatever its number turns out to be. Shown so arming never has an unstated consequence. */
  firesFromRound: bigint | null;
  /** Why it is not depositing at this instant, already worded. */
  status: string;
  /** The raw reason behind `status`. Null exactly when a deposit is being sent right now. */
  hold: HoldReason | null;
  /** The round being worked on, or the last one that was — including a missed one, which stays on
   *  screen until the next round replaces it. */
  attempt: AutoDeployAttempt | null;
  arm(rule: AmountRule): void;
  disarm(): void;
  setRule(rule: AmountRule): void;
  /** Called from the confirmed-enter path for EVERY deposit, by hand or automatic, so the side a
   *  repeat follows survives a screen change. */
  noteDeploy(side: Side): void;
}

// ---------------------------------------------------------------------------------------------
// Saying it out loud
// ---------------------------------------------------------------------------------------------

/** WHY A ROUND WAS NOT ENTERED, in the words a player would use. Lives here rather than in the panel
 *  so there is one wording per outcome and it is covered by the same tests as the rule that produces
 *  it — a feature this quiet earns its trust entirely through what it says afterwards. */
export function abandonText(reason: AbandonReason, error: string | null): string {
  switch (reason) {
    case "entries-closed":
      return "the lobby's deposit deadline passed before it could get in";
    case "phase-moved-on":
      return "the round had already left the lobby when this tab first saw it";
    case "retries-exhausted":
      return `${MAX_TRIES} attempts failed${error === null ? "" : ` — ${error}`}`;
    case "round-moved-on":
      return "a newer round opened while it was still retrying";
  }
}

/** WHAT IT IS DOING RIGHT NOW. The panel shows this permanently, armed or not: a rule that spends
 *  money is owed a status line that never reads as nothing. */
export function holdText(reason: HoldReason, state: AutoDeployState, roundNo: bigint | null): string {
  switch (reason) {
    case "disarmed":
      return "Off — deposits are yours to make by hand";
    case "no-side":
      return "Waiting for your first deploy — it repeats the side you last played";
    case "no-round":
      return "Waiting for a round to open";
    case "round-changing":
      return "Reading the new round";
    case "waiting-for-next-round":
      return `Waiting for round ${(state.floorRound ?? 0n) + 1n} — the round on screen was already open when this was armed`;
    case "deployed-this-round":
      return `Deployed into round ${roundNo ?? "—"} — waiting for the next one`;
    case "missed-this-round":
      return `Round ${roundNo ?? "—"} was missed — waiting for the next one`;
    case "sending":
      return `Depositing into round ${roundNo ?? "—"}…`;
    case "already-in":
      return `You are already in round ${roundNo ?? "—"} — waiting for the next one`;
    case "amount-unusable":
      return state.rule.kind === "pct"
        ? `${state.rule.pct}% of the simulated wallet is under ${usd(usdToUnits(MIN_STAKE_USD))} — nothing will be deposited until it is topped up`
        : `The amount is under ${usd(usdToUnits(MIN_STAKE_USD))} — nothing will be deposited`;
    case "busy":
      return "Waiting for another deposit to confirm";
    case "backing-off":
      return `Retrying round ${roundNo ?? "—"}…`;
  }
}
