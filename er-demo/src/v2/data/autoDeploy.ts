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
//
// AND THE FOURTH THING, ADDED LATER AND THE MOST EXPENSIVE OF THEM: THIS RULE WAS BLIND TO HOW ITS
// DEPOSIT WOULD BE SIGNED. A play session lasts a fixed time, nothing in the app can read that expiry
// back, so once it ran out every round sent one doomed transaction and then raised two Phantom
// dialogs to replace the session — at an empty chair, every round, indefinitely. `autoPolicy.ts` is
// the whole account of that defect and of the two layers that close it; this file consumes them.
// What lands HERE is the shape of the ladder: how the deposit will be signed is asked BEFORE the
// round is written off for anything else, and the answer is never a dialog.
//
// IT ENTERS AND IT NEVER EXTRACTS (`SOCIAL.md` §1.1, a hard rule). That shows up in this file as a
// type: the only decision this rule can reach is `fire`, and `fire` IS an `UnattendedEntry` — a
// round, a side and a stake. There is no shape in here that could describe an extraction.

import {
  MIN_STAKE_USD,
  STAKE_CAP_USD,
  usd,
  usdToUnits,
  type PhaseName,
  type RoundSummary,
  type Side,
  type SimBalances,
} from "../contract.ts";
import { ASSUMED_SESSION_TOP_UP_SOL } from "./autoSession.ts";
import {
  DEFAULT_LIMITS,
  EMPTY_RUN_PNL,
  EMPTY_TALLY,
  bookSettledRounds,
  chooseSide,
  clampToLimits,
  drawdownStopUsd,
  limitBlock,
  pnlEntered,
  readRunPnl,
  tallyEntered,
  tallyMissed,
  type AutoLimits,
  type RunPnl,
  type RunPnlReading,
  type RunTally,
  type Runway,
  type SideRule,
  type Strategy,
  type UnattendedEntry,
  type UnattendedSigning,
} from "./autoPolicy.ts";

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
  | "round-moved-on"
  /** The chain refused the deposit because the play session signing it had lapsed. Terminal for this
   *  round BY DESIGN and unlike every other failure here: the recovery for a lapsed session is to
   *  replace it, replacing it costs two Phantom approvals, and there is nobody here to give them. So
   *  the round ends, the lapse is latched (`deadSessionEpoch`), and the rule goes quiet instead of
   *  paying for the same refusal every round. */
  | "session-lapsed";

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
  /** WHICH SIDE, asked through `chooseSide` rather than read off `side` directly — see that function
   *  for why the seam exists before the strategies do. */
  sideRule: SideRule;
  /** The bounds this run may not exceed, snapshotted at arming for the same reason the amount rule is:
   *  a limit read live from a control that a screen change can unmount is not a limit. */
  limits: AutoLimits;
  /** What this run has done so far. Also the enforcement input for `budgetUsd` — `tally.spentUsd` is
   *  confirmed dollars, so the budget is spent against what landed, never against what was tried. */
  tally: RunTally;
  /** WHAT CAME BACK, accumulated as the rounds this run entered settle. The enforcement input for
   *  `drawdownStopPct`, and the other half of the tally beside it: that one is what the run spent,
   *  this one is what it got for it, and neither is derivable from the other. It is a RUNNING TOTAL
   *  and not a figure re-read on demand, for the reason `RunPnl`'s own header sets out at length —
   *  the round log forgets after about twenty rounds and the runs this feature exists for last all
   *  night. */
  pnl: RunPnl;
  /**
   * THE SESSION THE CHAIN HAS ALREADY REFUSED, remembered so the same lapse is not paid for twice.
   *
   * A COUNTER, NOT AN IDENTITY, and the identity is the interesting part because it is the design
   * that was tried first and is wrong. The obvious key is the session token PDA — it is derived from
   * the program, the session signer and the authority, and `sessionExpiry.ts` keys its own records on
   * exactly that. It does not work HERE: gum reuses the same session signer keypair across a
   * renewal (`scripts/verify-session-renewal.mjs` exists to prove it, and is why renewal has to be
   * revoke-then-create at all — a second `create_session` on the same signer fails because the token
   * account still exists). A reused signer means a STABLE PDA across renewals, so a latch keyed on it
   * would never see the world change and auto-deploy would stay dead for the rest of the tab's life —
   * the exact opposite of the self-clearing property this whole design is built on.
   *
   * So the identity is an app-owned monotonic count of the sessions this tab has successfully opened,
   * which depends on no gum internals whatsoever. The hold lifts the moment the count advances. There
   * is no reset call and no flag anybody can leave stuck; 0 means "no session has ever been opened
   * here" and null means "nothing has been refused", and those two can never be mistaken for each
   * other because null is not a number.
   */
  deadSessionEpoch: number | null;
}

/** OFF UNTIL SOMEBODY ASKS FOR IT, and named so that changing the answer is one line rather than a
 *  literal buried in an object.
 *
 *  The argument for `false`: arming this is a decision to let a page spend money with nobody watching
 *  it, and a default that made that decision on a visitor's behalf would be this product deciding how
 *  much of a stranger's bankroll it may put at risk before they have read a word about it. Every other
 *  default on this page can be undone by pressing something; this one cannot. */
export const ARMED_BY_DEFAULT = false;

export const INITIAL_AUTO_DEPLOY: AutoDeployState = {
  armed: ARMED_BY_DEFAULT,
  side: null,
  rule: { kind: "fixed", usd: 5 },
  floorRound: null,
  attempt: null,
  sideRule: { kind: "repeat" },
  limits: DEFAULT_LIMITS,
  tally: EMPTY_TALLY,
  pnl: EMPTY_RUN_PNL,
  deadSessionEpoch: null,
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
  | "backing-off"
  // ── How the deposit would have to be signed. Every one of these means "sending this would put a
  //    wallet dialog in front of a chair nobody is sitting in", and every one lifts on its own.
  /** The chain has refused this session once already, and no newer one has been opened since. */
  | "session-lapsed"
  /** `UnattendedBlock`, one for one — see `autoPolicy.ts`. Repeated as literals rather than spread
   *  from that type because a hold reason is a promise that `holdText` has a sentence for it, and the
   *  switch there is what enforces that promise. */
  | "needs-session"
  | "session-stopped"
  | "session-unaffordable"
  | "no-signer"
  // ── The bounds the player set. `LimitBlock`, one for one.
  | "drawdown-stopped"
  | "drawdown-unknown"
  | "budget-spent"
  | "round-ceiling";

export type AutoDeployDecision =
  /** THE ONLY THING THIS RULE CAN ASK FOR, and it is an `UnattendedEntry` by construction rather
   *  than by resemblance. `SOCIAL.md` §1.1's hard rule is that auto-play enters and never extracts;
   *  written into the type, that rule needs no discipline to keep — a round, a side and a stake
   *  cannot describe an extraction, and `runUnattendedEntry` accepts nothing else. `attemptNo` is
   *  bookkeeping about the try, not part of what is sent. */
  | ({ kind: "fire"; attemptNo: number } & UnattendedEntry)
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
  /** `unattendedSigning(signingPlan(...))` — whether the next move could be signed with nobody
   *  watching, and if not, why. The INFERENCE half of the two layers; `sessionEpoch` below carries
   *  the authoritative half. */
  signing: UnattendedSigning;
  /** How many sessions this tab has successfully opened. See `AutoDeployState.deadSessionEpoch` for
   *  why it is a count and not the session's own address. */
  sessionEpoch: number;
  /**
   * THE ROUND LOG, from which the outstanding half of the run's P&L is read. Every round that has
   * already settled is in `state.pnl` and no longer needs to be here at all — see `bookRunPnl` and
   * `RunPnl`'s header for why that inversion is the whole fix.
   *
   * A RAW INPUT RATHER THAN A FIGURE, and that is a deliberate move of the boundary. This used to
   * take `realisedPnlUsd: number | null`, computed by the caller, which put the most consequential
   * number in the feature outside the module that enforces it — and the caller's derivation was
   * correct in isolation and wrong in composition, which is the hardest kind of defect to see from
   * either side. The rule now reads the evidence itself, so `decideAutoDeploy` is a pure function of
   * stated inputs all the way down to the chain's own rows and there is no second opinion for anyone
   * to hand it.
   */
  roundLog: RoundSummary[];
  /** Whose rows in the log are this player's. `""` when nobody is connected, which reads as "cannot
   *  say" rather than as a flat run — see `readRunPnl`. */
  youPubkey: string;
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
  const { state, roundNo, targetRoundNo, phase, entriesOpen, alreadyIn, entering, amountUsd, signing,
    sessionEpoch, roundLog, youPubkey, nowMs } = input;

  if (!state.armed) return hold("disarmed");
  // Asked of the strategy rather than read off the field, so the day a second side rule exists this
  // line does not change. Null is "nothing has been deployed yet", not a default we picked.
  const side = chooseSide(state.sideRule, state.side);
  if (side === null) return hold("no-side");
  if (roundNo === null) return hold("no-round");
  if (targetRoundNo === null || targetRoundNo !== roundNo) return hold("round-changing");
  if (state.floorRound !== null && roundNo <= state.floorRound) return hold("waiting-for-next-round");

  // Bookkeeping for THIS round only. An attempt against any other round is history.
  const attempt = state.attempt !== null && state.attempt.roundNo === roundNo ? state.attempt : null;
  if (attempt?.outcome === "landed") return hold("deployed-this-round");
  if (attempt?.outcome === "abandoned") return hold("missed-this-round");
  if (attempt?.outcome === "sending") return hold("sending");

  // WITH ONE EXCEPTION, WHICH IS THE ONE THAT LOSES MONEY. An attempt for an OLDER round is history
  // for every purpose except this one: while its transaction is still in flight, starting a second
  // one holds the whole record hostage. There is a single attempt slot, so `beginAttempt` for the new
  // round would overwrite the old one, and the in-flight transaction's own `attemptLanded` would then
  // find a record for a different round and return unchanged (see that function's guard) — leaving a
  // deposit that was made, confirmed and paid for accounted as neither entered nor missed, and never
  // charged against the budget.
  //
  // `entering` below would normally have held first, because a deposit in flight anywhere on the page
  // sets it. But that is an invariant of `ArenaProvider`'s wiring, and this module is the one making
  // the promise about never losing a round — so it holds on its own evidence rather than on somebody
  // else's. The hold lifts on the next evaluation after the transaction resolves, which is well
  // inside a lobby.
  if (state.attempt !== null && state.attempt.outcome === "sending") return hold("sending");

  if (alreadyIn) return hold("already-in");

  // CAN THIS BE SIGNED WITH NOBODY WATCHING? Asked here — after the per-round bookkeeping and before
  // anything can write the round off — and the position is deliberate on both sides.
  //
  // AFTER the bookkeeping, because "you are already in this round" stays the more useful truth than
  // "your session ran out", and because a round we are already in must never be reported as lost to a
  // lapse it was not lost to.
  //
  // BEFORE the abandon clauses, because these are HOLDS and the clauses below are endings. A rule
  // that cannot sign is not missing rounds — it is standing still, correctly, and will start again by
  // itself. Asking the lobby deadline first would turn a quiet, self-clearing pause into an error
  // toast per round saying the deadline was missed, which is both the wrong reason and a claim the
  // player would act on.
  //
  // THE LATCH IS ASKED BEFORE THE PLAN because it is the authority and the plan is only an inference.
  // `signingPlan` cannot see that a session has lapsed — gum carries no expiry — so it will go on
  // answering `{kind:"session"}` indefinitely after the fact. The chain's own refusal cannot be wrong,
  // and it is what this remembers. See `AutoDeployState.deadSessionEpoch`.
  if (state.deadSessionEpoch !== null && state.deadSessionEpoch === sessionEpoch) {
    return hold("session-lapsed");
  }
  if (signing.kind === "blocked") return hold(signing.reason);

  // DECLINING IS NOT MISSING, and this block sits above the abandon clauses for that one reason.
  //
  // A round the rule declines to spend on — its budget is gone, its drawdown stop has fired, the
  // amount resolves to nothing worth sending — was never a round it was going to enter. Below the
  // clauses, every one of those rounds reached the deposit deadline still holding and was written off
  // as `entries-closed`: an error toast per round, for as long as the limit held, saying the lobby
  // deadline was missed. That is the wrong reason, it is a claim a player would act on, and at a
  // budget that can outlive a whole night it is the wrong reason several hundred times. The rounds a
  // rule DECIDES not to enter are not losses and are not reported as any.
  //
  // (`busy` and `backing-off` stay below the clauses, and the distinction is the same one read the
  // other way: those two describe a round this rule is actively trying to get into, so a lobby that
  // closes underneath them genuinely did lose it one.)
  //
  // THE LIMITS, AND THE FIGURE, IN THAT ORDER. `limitBlock` names which bound has been reached so the
  // status line can say it; `clampToLimits` then produces what may actually be sent, which is often
  // LESS than the armed amount — the last round of a budget is a partial one, not a refused one. A
  // null out of the clamp with no limit reached is the same fact `amount-unusable` already carries:
  // whatever the room is, there is not a cent of it worth sending.
  //
  // THE LIMITS ARE ASKED BEFORE THE AMOUNT, and the order is not the obvious one. A percentage rule
  // against a drained simulated wallet AND a spent budget are both true at once, and the ladder used
  // to answer with the wallet: "10% of the simulated wallet is under $0.01 — nothing will be
  // deposited until it is topped up", to a player whose budget was the thing that had run out.
  // Topping the wallet up would not have restarted the run; raising the budget would. The limits are
  // the more specific truth and they name the control that changes them.
  // READ, NOT BOOKED. `bookRunPnl` is the transition that moves settled rounds into the running
  // total; this reads that total plus whatever the log can currently say about the rounds above it,
  // and it must stay side-effect free — the panel evaluates this same ladder on every render, and a
  // decision function that advanced a cursor would make the run's books depend on how often the page
  // repainted.
  const limited = limitBlock(state.limits, state.tally, readRunPnl(state.pnl, roundLog, youPubkey));
  if (limited !== null) return hold(limited);
  if (amountUsd === null) return hold("amount-unusable");
  const sendableUsd = clampToLimits(amountUsd, state.limits, state.tally.spentUsd);
  if (sendableUsd === null) return hold("amount-unusable");

  // Past this line the intent is settled: this round is one we mean to enter. Anything that makes
  // that PERMANENTLY impossible ends the round with a reason rather than holding silently until the
  // round number changes and the whole episode disappears without ever being reported.
  if (phase !== "Lobby") return { kind: "abandon", roundNo, reason: "phase-moved-on" };
  if (!entriesOpen) return { kind: "abandon", roundNo, reason: "entries-closed" };
  if (attempt !== null && attempt.tries >= MAX_TRIES) {
    return { kind: "abandon", roundNo, reason: "retries-exhausted" };
  }

  // Temporary reasons to wait. Every one of these resolves on its own; none of them loses the round.
  if (entering) return hold("busy");
  if (attempt !== null && attempt.nextTryAtMs !== null && nowMs < attempt.nextTryAtMs) {
    return hold("backing-off");
  }

  return { kind: "fire", roundNo, side, amountUsd: sendableUsd, attemptNo: (attempt?.tries ?? 0) + 1 };
}

// ---------------------------------------------------------------------------------------------
// Transitions — every one a plain function from state to state
// ---------------------------------------------------------------------------------------------

/**
 * ARMING IS THE START OF A RUN, and it captures everything that run is: the whole strategy, the
 * bounds, and the round to start after. All of them are decisions the player is making at that
 * instant, and none of them should ever be re-read from a control that a screen change can unmount —
 * which is precisely how a $100 repeat became a $5 one in the version this replaces.
 *
 * IT ALSO CLEARS TWO THINGS, and both are the point of arming rather than housekeeping:
 *
 *   · THE TALLY AND THE P&L, because a run's account and a run's budget are the same number read two
 *     ways, and a run's drawdown is measured against the budget it committed. A new run that
 *     inherited the last one's spend would arrive with its budget already gone, and the statement a
 *     player read would describe two evenings as one; one that inherited last night's losses would
 *     arrive with its drawdown stop already tripped. Clearing the P&L is also the press that releases
 *     a run stopped by an unrecoverable hole in its ledger — see `readRunPnl`.
 *   · THE LAPSED-SESSION LATCH, because arming is the most explicit statement of intent this feature
 *     has. It is not a reset button for the latch — the latch clears on its own when a session is
 *     opened — it is simply that a run which has just begun has had nothing refused.
 */
export function armWith(
  state: AutoDeployState,
  args: {
    strategy: Strategy;
    limits: AutoLimits;
    visibleRoundNo: bigint | null;
    nowMs: number;
  },
): AutoDeployState {
  return {
    ...state,
    armed: true,
    rule: args.strategy.amount,
    sideRule: args.strategy.side,
    limits: args.limits,
    floorRound: args.visibleRoundNo,
    attempt: null,
    tally: { ...EMPTY_TALLY, armedAtMs: args.nowMs },
    pnl: EMPTY_RUN_PNL,
    deadSessionEpoch: null,
  };
}

/** THE ONE-CONTROL ARM the checkbox in the Deploy panel has always called: change the amount rule,
 *  keep whatever side rule and limits are already set. Expressed through `armWith` rather than beside
 *  it so there is exactly one thing that starts a run and exactly one list of what a run resets. */
export function arm(
  state: AutoDeployState,
  args: { rule: AmountRule; visibleRoundNo: bigint | null; nowMs: number },
): AutoDeployState {
  return armWith(state, {
    strategy: { amount: args.rule, side: state.sideRule },
    limits: state.limits,
    visibleRoundNo: args.visibleRoundNo,
    nowMs: args.nowMs,
  });
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

function sameLimits(a: AutoLimits, b: AutoLimits): boolean {
  return (
    a.budgetUsd === b.budgetUsd &&
    a.perRoundCapUsd === b.perRoundCapUsd &&
    a.drawdownStopPct === b.drawdownStopPct &&
    a.maxRounds === b.maxRounds
  );
}

/** Changing a limit mid-run adopts it immediately and touches nothing else — a player tightening a
 *  budget is not restarting the run, and re-arming to apply a limit would reset the very tally the
 *  budget is enforced against.
 *
 *  A RAISED BUDGET THEREFORE RESUMES A RUN THAT HAD SPENT ITS OLD ONE, with no other press, because
 *  `budget-spent` is a derived hold rather than a flag — the same property that makes every pause in
 *  this feature lift by itself.
 *
 *  IT ALSO WIDENS THE DRAWDOWN STOP IN PROPORTION, which is a second effect of a control that names
 *  only the budget, and is therefore said out loud here and owed a sentence on any panel offering
 *  both. The stop is a percentage of what is committed (`drawdownStopUsd`), so committing more money
 *  means tolerating a proportionally larger loss — which is what "half of what I put in" means when
 *  somebody puts more in, but is not what a player pressing one control necessarily has in mind.
 *
 *  Identity is part of the contract here for the reason it is in `setRule`: the panel pushes its
 *  controls down through an effect, and a no-op that returned a fresh object would commit, re-render,
 *  re-run the effect and call itself again. */
export function setLimits(state: AutoDeployState, limits: AutoLimits): AutoDeployState {
  return sameLimits(state.limits, limits) ? state : { ...state, limits };
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
 *
 * ROUNDS ONLY EVER INCREASE, AND THIS GUARD BECAME NECESSARY THE DAY `noteDeploy` STARTED CARRYING
 * THE TRUE ROUND. While the caller derived the round from the current poll it could not hand in an
 * old one, so there was nothing to guard; taking the round the transaction was actually written to —
 * which is the whole point of that change — makes a stale one reachable for the first time. The path
 * is a confirmation that outlives `SEND_PATIENCE_MS`: `useActions` stops waiting, the rule moves on
 * and is working round N, and then the abandoned transaction resolves and books round N-3.
 *
 * WITHOUT THE GUARD THAT COSTS A ROUND AND THEN COSTS A STAKE. The single attempt slot would be
 * overwritten with the old round, so `decideAutoDeploy` would stop seeing `deployed-this-round` for
 * N and — while the roster poll was still catching up — send a SECOND deposit into a round it had
 * already entered. `tallyEntered` would then drop that second confirmation as a duplicate of the
 * first, so the second real stake would never be charged against `budgetUsd`: the double-booking the
 * tally's cursor exists to prevent, defeated from outside it, exactly as `bookConfirmedDeposit`'s own
 * header describes for the case it guards. A booking for a round older than the one in hand is
 * history, and history does not get to overwrite the present.
 */
export function noteRoundEntered(state: AutoDeployState, roundNo: bigint): AutoDeployState {
  if (state.attempt !== null && roundNo < state.attempt.roundNo) return state;
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

/**
 * THIS RULE'S OWN DEPOSIT CONFIRMED. The only place a dollar is ever added to the run's spend, and
 * `amountUsd` is a parameter for that reason: the tally is what the budget is enforced against, so
 * the figure it books has to be the one the transaction actually carried rather than whatever the
 * rule would resolve to when somebody later asks.
 *
 * A HAND DEPLOY IS DELIBERATELY NOT BOOKED HERE, and `noteRoundEntered` — which is the path every
 * manual deposit takes — does not book one either. This is the RULE's account of itself. A player who
 * deploys $100 by hand has not spent a penny of the budget they gave this rule, and charging them for
 * it would stop an armed run early for a reason no status line could honestly explain.
 */
export function attemptLanded(
  state: AutoDeployState,
  roundNo: bigint,
  signature: string,
  amountUsd: number,
  /** THE ACCOUNT THAT MADE THIS DEPOSIT, read at SEND time — never at confirmation time, for the
   *  reason `sessionEpochAtSend` is captured the same way. It is what the run's P&L is claimed for;
   *  see `RunPnl.wallet` for the permanent, silent mis-booking it prevents. */
  wallet: string,
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
    // Idempotent per round by construction — see `tallyEntered`. It has to be: this and
    // `noteRoundEntered` both fire for one automatic deposit, from two callbacks that do not know
    // about each other, in an order nothing guarantees.
    tally: tallyEntered(state.tally, roundNo, amountUsd),
    // THE SAME EVENT, BOOKED IN THE OTHER LEDGER, and it is here rather than anywhere else for the
    // reason the line above it is: this is the single point at which a round becomes one the run's
    // BUDGET paid for, and the drawdown stop measures what came back from exactly those rounds. A
    // hand deploy reaching `noteRoundEntered` charges neither, which is the same rule read twice.
    pnl: pnlEntered(state.pnl, roundNo, wallet),
  };
}

/**
 * TAKE WHATEVER THE ROUND LOG CAN NOW ANSWER FOR — the only path by which a settled round reaches the
 * run's P&L, and the reason the drawdown stop keeps working past the log's memory.
 *
 * CALLED BEFORE EVERY DECISION, beside `expireStaleAttempt`, and for a related reason: both close the
 * books on something the chain has already moved past, and both exist because the alternative is a
 * fact quietly going missing. `useHistory` re-reads the whole log each time `round_counter` moves —
 * about once a round — so this runs with fresh evidence roughly as often as there is any, and a
 * settled round is booked within a round of settling and cannot then be lost when the chain reclaims
 * it twenty rounds later.
 *
 * A NO-OP RETURNS THE STATE IT WAS GIVEN, which the hook's `commit` depends on: it compares by
 * identity and repaints on a change, so an equal-but-fresh object once a second would be a render
 * loop with a running total inside it.
 */
export function bookRunPnl(
  state: AutoDeployState,
  roundLog: RoundSummary[],
  youPubkey: string,
): AutoDeployState {
  const pnl = bookSettledRounds(state.pnl, roundLog, youPubkey);
  return pnl === state.pnl ? state : { ...state, pnl };
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
    // EVERY LOST ROUND IS COUNTED HERE, whatever lost it — this is the single choke point through
    // which a round is written off (`expireStaleAttempt` and `noteSessionRefused` both come through
    // it), so a miss cannot be reported to the player without also reaching the statement they read
    // long after the fact.
    tally: tallyMissed(state.tally, roundNo),
  };
}

/**
 * THE CHAIN REFUSED A SESSION-SIGNED DEPOSIT — the authoritative half of the two layers, and the only
 * signal in this feature that a play session is gone.
 *
 * IT IS NOT A RETRY, and that is the whole difference from `attemptFailed`. Every other failure here
 * earns another go inside the same lobby because another go might work. This one cannot: the session
 * is lapsed for the rest of its life, so a second attempt is a second certain refusal, and the
 * recovery a watching player would get — replace the session, send again — costs two Phantom
 * approvals that nobody is here to give. So the round ends, and the refused session is remembered so
 * the next round does not buy the same answer again.
 *
 * ONE REFUSED TRANSACTION PER LAPSE IS THE ENTIRE PRICE of not gating on a clock we do not control.
 * See `autoPolicy.ts`'s header for why that is the trade worth making.
 */
export function noteSessionRefused(
  state: AutoDeployState,
  roundNo: bigint,
  sessionEpoch: number,
): AutoDeployState {
  return { ...abandonAttempt(state, roundNo, "session-lapsed"), deadSessionEpoch: sessionEpoch };
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
  /** The bounds this run is under. Rendered beside the arm control, because a limit a player cannot
   *  see is a limit they cannot rely on. */
  limits: AutoLimits;
  tally: RunTally;
  /** The account of the run, already worded. Always safe to render — it says something true before
   *  anything has happened as well as after. */
  report: string;
  /** How far this can go: the two money bounds, the session, the ceiling, and which of them runs out
   *  first. Never one invented number. */
  runway: Runway;
  arm(rule: AmountRule): void;
  /** The whole strategy and the bounds at once — what the fuller arm control commits. */
  armWith(strategy: Strategy, limits: AutoLimits): void;
  disarm(): void;
  setRule(rule: AmountRule): void;
  /** Applies mid-run without restarting it: raising a spent budget resumes the run at the next round,
   *  because `budget-spent` is a derived hold and not a flag. */
  setLimits(limits: AutoLimits): void;
  /**
   * Called from the confirmed-enter path for EVERY deposit, by hand or automatic, so the side a
   * repeat follows survives a screen change.
   *
   * `roundNo` IS THE ROUND THE TRANSACTION WAS WRITTEN TO — the round `roundPda` was derived from,
   * captured at send time — and it is a parameter because deriving it on the far side of a
   * confirmation is not possible without getting it wrong. This method used to take only a side, so
   * the listener had to read the round back off the poll; `live.roundNo` is whatever the round poll
   * last FETCHED, and it lags by up to a poll whenever a new round opens. A deposit confirming inside
   * that window was booked against a round it never touched, `attemptLanded`'s round guard then found
   * a record for a different round and returned the state unchanged, and `tallyEntered` never ran —
   * a real, paid-for deposit never charged against the budget, with the toast beside it saying it had
   * landed. `useAutoDeploy.ts` narrowed that to the manual path from its side and recorded the rest as
   * a residual it could not close, because closing it needed this signature. This is that signature.
   *
   * NULL IS ALLOWED AND MEANS "NO ROUND IS KNOWABLE" — no open round, or a surface with no round
   * behind it at all. Only the side is recorded then, which is the honest half of what is known.
   */
  noteDeploy(side: Side, roundNo: bigint | null): void;
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
    case "session-lapsed":
      // Not "it failed". The transaction did exactly what it was going to do, and the honest account
      // of the round is that the session ran out — which the reader can fix in one press, and which this
      // says rather than leaving them to infer from `InvalidToken`.
      return (
        "your play session ran out, and it will not raise a wallet dialog you are not there to " +
        "answer — open a fresh session and it starts again at the next round"
      );
  }
}

/** WHAT IT IS DOING RIGHT NOW. The panel shows this permanently, armed or not: a rule that spends
 *  money is owed a status line that never reads as nothing. */
export function holdText(
  reason: HoldReason,
  state: AutoDeployState,
  roundNo: bigint | null,
  pnl: RunPnlReading,
): string {
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
      // THE ATTEMPT'S ROUND, NOT THE ONE ON SCREEN. They are the same in the ordinary case and differ
      // in exactly the one that matters: a transaction still in flight when the next round opens.
      // Naming the round on screen there would say it was depositing into a round it has not touched.
      return `Depositing into round ${state.attempt?.roundNo ?? roundNo ?? "—"}…`;
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

    // THE SIGNING HOLDS. Each one names a thing that is true, one press that changes it, and when the
    // rule comes back — which is always "the next round", because a hold here loses nothing and there
    // is nothing to recover. None of them says "error", because none of them is one.
    case "session-lapsed":
      return (
        "Your play session ran out, so nothing can be deposited without asking your wallet — which " +
        "this will not do while you are away. Start a fresh session in the wallet panel (two " +
        "approvals in Phantom) and it picks up again at the next round"
      );
    case "needs-session":
      return (
        "No play session is open, and opening one needs an approval in Phantom — which this will not " +
        "ask for on its own. Deploy once by hand, or press Start in the wallet panel, and it takes " +
        "over from the next round"
      );
    case "session-stopped":
      return (
        "Play sessions are stopped, so every deposit would ask Phantom to approve it. Press Start in " +
        "the wallet panel and this resumes at the next round"
      );
    case "session-unaffordable":
      return (
        `Not enough devnet SOL to open a play session — it funds a key with ${ASSUMED_SESSION_TOP_UP_SOL} SOL so that ` +
        "key can sign for you — so every deposit would ask Phantom to approve it. Top up and this " +
        "resumes at the next round"
      );
    case "no-signer":
      return (
        "Nothing can be signed on this page yet — the wallet panel says what is missing. This starts " +
        "at the next round to open once that clears"
      );

    // THE LIMITS. Each is the rule doing exactly what it was told, so each reads as a completed
    // instruction rather than a fault, and each names the control that changes it.
    // IT MAY BE SAID OFF A FLOOR RATHER THAN OFF A FINAL FIGURE, and that is worth being exact
    // about. `limitBlock` fires this on the loss already BOOKED, which is exact for the rounds it
    // covers but is not the whole ledger when a round is still unreadable — so if that unread round
    // turns out to have been a large win, this sentence will have told a player their run was down
    // more than they accepted while it was in fact up. The alternative was to report the inability
    // instead, which held the rule identically and said something vaguer and less alarming about a
    // run that had demonstrably blown through its stop. It errs toward stopping and toward telling,
    // it self-corrects the moment the ledger reads complete, and a stop is the one control on this
    // page allowed to err that way.
    case "drawdown-stopped":
      return (
        `This run is down more than the ${state.limits.drawdownStopPct ?? 0}% of its ${usd(usdToUnits(state.limits.budgetUsd))} budget you said you ` +
        `would accept — ${usd(usdToUnits(drawdownStopUsd(state.limits) ?? 0))} — so it has stopped depositing. Widen the ` +
        "drawdown stop, or arm a fresh run, and it starts again at the next round"
      );
    // ONE HOLD, TWO SENTENCES, AND THE DIFFERENCE IS WHETHER WAITING WILL HELP. Every other pause in
    // this feature is derived from a world that changes on its own, and this one usually is too — a
    // log that has not loaded, a wallet that is not connected, a batch the RPC rate-limited. But it
    // has a second cause that never clears: a round this run entered settled while the tab was not
    // reading the chain, and the chain has since reclaimed the record. Telling that reader to wait
    // for a figure that is never coming would leave them watching a run that had already finished,
    // so the gap gets its own words, names the round, and gives the two presses that end it.
    //
    // WHY THIS IS A SENTENCE AND NOT A SECOND `HoldReason`: see `LimitBlock`'s note. Nothing that
    // switches on a hold would branch differently, and this project's tsconfig does not make such a
    // switch exhaustive — so the member would buy nothing and cost a blank status line.
    case "drawdown-unknown":
      if (pnl.kind === "gap") {
        return (
          `Round ${pnl.fromRound} settled while this tab was not reading the chain, and the chain no longer keeps ` +
          "a record of it — so what this run is down cannot be worked out, and it will not become " +
          "readable later. A drawdown stop that cannot be checked is not one, so nothing more will " +
          "be deposited. Arm a fresh run to start the count again, or turn the drawdown stop off to " +
          "carry on with this one"
        );
      }
      return (
        "Your drawdown stop cannot be checked right now — nothing here can say what this run is up " +
        "or down — and a safety limit that cannot be checked is not one, so nothing will be " +
        "deposited. It resumes at the next round as soon as the figure is readable, or straight " +
        "away if you turn the drawdown stop off"
      );
    case "budget-spent":
      return (
        `This run has deposited its whole ${usd(usdToUnits(state.limits.budgetUsd))} budget, and a budget never tops itself ` +
        "up. Raise it and it carries on at the next round; leave it and nothing more will be sent"
      );
    case "round-ceiling":
      return (
        `This run has played the ${state.limits.maxRounds ?? 0} rounds you set it. Raise the ceiling and it takes the ` +
        "next round; leave it and it is finished"
      );
  }
}
