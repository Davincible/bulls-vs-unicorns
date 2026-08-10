// SPENDING A STRANGER'S MONEY WHILE THEY ARE NOT IN THE ROOM — what auto-deploy is allowed to do
// with nobody watching, and the two things it must never do.
//
// THE DEFECT THIS MODULE EXISTS TO CLOSE. `decideAutoDeploy` picks the round; `autoSession.ts` picks
// the signer; until this file, neither asked the other anything. The consequence was not theoretical
// and it arrived on a schedule — once per session lifetime, for as long as the tab stayed open:
//
//   1. A play session lasts a fixed time and nothing in the app can read that expiry back — gum's
//      session object carries no timestamp — so `sessionManager.active` stays non-null past the end.
//   2. So `signingPlan` keeps answering `{kind:"session"}`: as far as it can see, a session key is
//      standing by to sign the next deposit with no prompt.
//   3. So the rule fires, `runSigned` sends, and the chain refuses it with `InvalidToken`.
//   4. So `afterRefusal` answers `renew-and-retry`, which is the RIGHT answer for a player who just
//      pressed Deploy and is watching — and the wrong one here, because replacing a session is
//      revoke-then-create: two Phantom dialogs, raised at an empty chair, every round after that.
//
// THE FIRST PRINCIPLE, enforced structurally below: AN UNATTENDED DEPOSIT MAY NEVER CAUSE A WALLET
// DIALOG. Not one, not ever. A rule that spends money with nobody in front of it has to be incapable
// of asking for permission, not merely disinclined to.
//
// THE SECOND PRINCIPLE: IT ENTERS, AND IT NEVER EXTRACTS. `SOCIAL.md` §1.1 argues this at length and
// calls it a hard rule for all later strategy work. `enter` is a RULE — a side and a size, decided in
// advance, losing nothing by being automatic. `extract` is a JUDGEMENT made against a live fight
// under time pressure, racing whoever settles the round, and it is where the money actually is. A
// robot that also extracted would be playing the whole game. So the absent player gets the default
// outcome and the present player gets the decision, and the gap between those two numbers is the
// product rather than a defect in it. That is why the only unattended sender here is
// `runUnattendedEntry`, why its payload type is an entry and cannot be anything else, and why the
// strategy seam at the bottom of this file is explicitly an ENTRY seam.
//
// HOW THE FIRST PRINCIPLE IS ENFORCED — two layers, and neither of them is a clock.
//
//   LAYER 1, THE PLAN (before sending). `unattendedSigning` is total over `SigningPlan` and sorts
//   every way this page can sign into "silent" and "costs an approval". `runUnattendedEntry` will
//   only send on a silent one. It is a SEPARATE function from `runSigned` rather than a flag on it,
//   and the absence of every recovery path — no open, no renew, no wallet fallback — IS the
//   specification. A flag would have left those paths one boolean away from an unattended dialog;
//   they are not in this function at all.
//
//   LAYER 2, THE CHAIN (the authority). A plan is an inference about a session nobody can read the
//   expiry of. The chain refusing a session-signed transaction is a fact. So the first deposit after
//   a lapse is sent, refused, and the refusal is LATCHED (`autoDeploy.ts`'s `deadSessionEpoch`); the
//   rule then holds, quietly, until the tab opens a new session. `SOCIAL.md` §5.4 lists that expiry
//   as one of the five limits and describes it as "the kill switch that does not depend on our code
//   being correct" — which is the whole argument for treating the refusal, not a countdown, as the
//   signal.
//
// WHY WE DELIBERATELY DO NOT PRE-EMPT WITH `sessionExpiry.ts`. That module can tell us a session is
// probably lapsed, and it is emphatic — read its header — that the inference must NEVER gate an
// action: the session's length is a mirrored copy of a private constant (`ASSUMED_SESSION_MINUTES`)
// that this workstream does not control and cannot read back. If that copy ever drifts long, a
// clock-gated rule would go on sending doomed transactions anyway, so the gate buys nothing; if it
// drifts short, the gate silently stops a rule whose session works perfectly, and the player's
// account of it is a deposit that never happened for a reason nobody can see. The authoritative
// signal costs exactly one refused transaction per lapse — lamports, paid by the session key's own
// top-up, not by the wallet — and then it costs nothing. That is the cheaper mistake, and it is the
// one that cannot be wrong.
//
// NOTHING HERE STATES HOW LONG A SESSION LASTS. Not in code, not in a sentence. The length is moving
// (`SOCIAL.md` §5.2: it is a chosen constant rather than a limit, gum caps it at a day, and the
// protocol bounds it only from below), `sessionExpiry.ts` is the single mirror of it, and every
// duration in this file's copy is phrased to survive the move — "when it runs out", never "for the
// hour".
//
// THE CONSEQUENCE OF A LONGER SESSION, and it is the reason the limits below are load-bearing: at the
// old length the session WAS the binding constraint on an unattended run and the money rarely got a
// chance to be. Lengthened, it is not, so the budget, the drawdown stop and the round ceiling are
// what bound the run. `SOCIAL.md` §5.5 puts the sharpest version of it: a session token has no spend cap
// and no instruction allowlist, so a longer-lived key is a longer unbounded delegation, and it is
// only harmless today because the program custodies nothing. `runway` therefore computes every bound
// and names whichever actually binds, rather than assuming either one dominates.
//
// PURE AND REACT-FREE, for the reason `autoSession.ts` and `historyScan.ts` are: this project has no
// browser harness, and a rule that spends money unattended has to be provable by a plain Node test
// rather than by watching a tab overnight and hoping.

import { MIN_RETAINED_ROUNDS } from "../../chain/constants.ts";
import {
  MIN_STAKE_USD,
  STAKE_CAP_USD,
  feeOn,
  unitsToUsd,
  usd,
  usdToUnits,
  type FeeRate,
  type PhaseName,
  type RoundSummary,
  type Side,
} from "../contract.ts";
import type { SigningPlan } from "./autoSession.ts";
// TYPE-ONLY, AND THEREFORE NOT A CYCLE. `autoDeploy.ts` imports values from this module; this import
// is erased at compile time by `verbatimModuleSyntax`, so nothing circular survives into the bundle.
// `AmountRule` stays where it is because it is the ARMED RULE's own type — the thing `arm` snapshots —
// and moving it here to flatten a diagram would put it a step away from the state it belongs to.
import type { AmountRule } from "./autoDeploy.ts";

// ---------------------------------------------------------------------------------------------
// Layer 1 — who can sign with nobody watching
// ---------------------------------------------------------------------------------------------

/** Why an unattended deposit cannot be signed. Each one is a hold, never an error: all four describe
 *  a world that changes on its own or with one deliberate press, and none of them is this rule's
 *  fault or the player's. */
export type UnattendedBlock =
  /** No session is open. Opening one costs an approval, so it is not something to do behind a back. */
  | "needs-session"
  /** The player pressed Stop. Every move would ask the wallet, which is exactly what Stop means. */
  | "session-stopped"
  /** Not enough devnet SOL to fund a session key, so every move would ask the wallet. */
  | "session-unaffordable"
  /** Nothing on this page can be signed at all yet — `playGate` has the better words for why. */
  | "no-signer";

export type UnattendedSigning = { kind: "silent" } | { kind: "blocked"; reason: UnattendedBlock };

/**
 * COULD THE NEXT MOVE BE SIGNED WITH NOBODY IN THE ROOM?
 *
 * Total over `SigningPlan` by construction: the switch has no `default`, so the day a new
 * `SessionOffReason` is added the build fails HERE and someone has to decide whether it is silent —
 * rather than it defaulting to silent and shipping a dialog nobody is there to answer.
 *
 * The three silent plans are silent for three different reasons, and it is worth being explicit about
 * the two that are not the obvious one: a `burner` signs with a local keypair and never had a wallet
 * to prompt, and a `fixture` signs nothing whatsoever because there is no chain behind it. Both are
 * developer paths, both are genuinely promptless, and excluding them would make the whole feature
 * untestable on exactly the two setups it can be tested on without a wallet.
 */
export function unattendedSigning(plan: SigningPlan): UnattendedSigning {
  // A live session key signs with no prompt. That is the entire point of it, and it is the only
  // arrangement this rule is really built for.
  if (plan.kind === "session") return { kind: "silent" };
  // Opening one costs a Phantom approval. The move that opens a session belongs to a player who
  // pressed a button a second ago, not to a timer.
  if (plan.kind === "open-then-session") return { kind: "blocked", reason: "needs-session" };

  switch (plan.reason) {
    case "burner":
    case "fixture":
      return { kind: "silent" };
    case "stopped":
      return { kind: "blocked", reason: "session-stopped" };
    case "unaffordable":
      return { kind: "blocked", reason: "session-unaffordable" };
    case "blocked":
      return { kind: "blocked", reason: "no-signer" };
  }
}

/** Thrown by `runUnattendedEntry` when it refuses to send. A named constant rather than an ad-hoc
 *  string because the caller has to tell a refusal-to-ask apart from a chain error: the first is a
 *  hold with a reason already on screen, the second is a failed attempt that earns a retry. Compare
 *  with `isUnattendedRefusal` so the comparison exists in exactly one place. */
export const UNATTENDED_REFUSED = "auto-deploy will not open a wallet dialog nobody is watching";

export function isUnattendedRefusal(e: unknown): boolean {
  return e instanceof Error && e.message === UNATTENDED_REFUSED;
}

/**
 * THE ONLY THING THIS PAGE EVER SENDS UNATTENDED: a deposit into one round.
 *
 * IT IS A TYPE, AND THAT IS THE POINT. `SOCIAL.md` §1.1's hard rule is "never ship auto-extract", and
 * a rule written only in prose is one hurried afternoon from being wired around. So the unattended
 * sender takes THIS and passes THIS to its callback: an extract has no side and no stake, it names a
 * fighter and a moment, and it cannot be expressed here. `AutoDeployDecision`'s `fire` arm is built
 * from this same type for the same reason — the rule is structurally incapable of asking for
 * anything but an entry.
 */
export interface UnattendedEntry {
  roundNo: bigint;
  side: Side;
  /** Dollars, already through `clampToLimits`. */
  amountUsd: number;
}

/**
 * SEND AN ENTRY WITH NOBODY WATCHING — the unattended twin of `runSigned`.
 *
 * DELIBERATELY A SEPARATE FUNCTION rather than a flag on that one, and the absence of everything is
 * the specification. `runSigned` opens a session when there is none, replaces one the chain refused,
 * and falls back to a wallet signature when the optional half fails. Each of those is a Phantom
 * dialog, each is right when a player has just pressed a button, and each is a bug here. They are not
 * behind a condition in this function — they are not in it. There is one attempt, or a refusal.
 *
 * IT ALSO REFUSES A PLAN IT CANNOT HONOUR. `{kind:"session"}` with no session handed in would mean
 * signing with the wallet instead, which is the popup this exists to prevent, so it throws instead.
 * The plan is an inference from `sessionActive`; the handle is the fact; where they disagree, the
 * fact wins and nothing is sent.
 *
 * THE NAME CARRIES THE CONSTRAINT. There is no `runUnattended`, and there must never be a
 * `runUnattendedExtract` — see `UnattendedEntry` and `SOCIAL.md` §1.1.
 */
export async function runUnattendedEntry<S, R>(
  plan: SigningPlan,
  session: S | null,
  entry: UnattendedEntry,
  send: (entry: UnattendedEntry, session: S | null) => Promise<R>,
): Promise<R> {
  if (unattendedSigning(plan).kind === "blocked") throw new Error(UNATTENDED_REFUSED);
  if (plan.kind === "session") {
    if (session === null) throw new Error(UNATTENDED_REFUSED);
    return send(entry, session);
  }
  // A burner or a fixture: `null` means "sign it directly", which for both of those is a local
  // keypair or nothing at all. No wallet is reachable from here.
  return send(entry, null);
}

// ---------------------------------------------------------------------------------------------
// The limits
// ---------------------------------------------------------------------------------------------

/**
 * THE BOUNDS AN UNATTENDED RUN IS UNDER — `SOCIAL.md` §5.4's five, of which three are knobs, one is
 * the chain, and one is a press.
 *
 *   1. A BUDGET (`budgetUsd`). Committed at arm time, decremented per round, hard stop at zero, and
 *      it never tops itself up. §5.4: "the budget is the budget."
 *   2. A PER-ROUND CAP (`perRoundCapUsd`), on top of the arena's own `STAKE_CAP_USD`.
 *   3. A DRAWDOWN STOP (`drawdownStopPct`) — stop when losses reach a share of the committed budget.
 *      §5.4 flags this as the only one of the five that is new mechanism rather than new copy.
 *   4. TIME. The session expires and the chain refuses the next transaction. Not a knob and nothing
 *      to build: it is `deadSessionEpoch` in `autoDeploy.ts`, and §5.4 calls it "the kill switch that
 *      does not depend on our code being correct".
 *   5. A ROUND CEILING (`maxRounds`), optional, for people who think in rounds rather than hours.
 *
 * There is deliberately no absolute bankroll floor. An earlier draft carried one beside the drawdown
 * stop, and two knobs that protect the same thing are one knob too many: the drawdown stop scales
 * itself to whatever was committed, which is the version a player can set once and have mean the
 * same thing at every budget.
 *
 * READONLY, AND NOT AS A STYLE. The budget's defining property is that it only ever goes DOWN — the
 * run drains it and nothing refills it. Fields that cannot be assigned mean the only way a budget can
 * move is a new `AutoLimits` from a deliberate player action through `setLimits`, which is a thing
 * they did rather than a thing that happened.
 */
export interface AutoLimits {
  readonly budgetUsd: number;
  /** Most it will put into any one round — ours, on top of the arena's own `STAKE_CAP_USD`. */
  readonly perRoundCapUsd: number;
  /** Percent of the COMMITTED BUDGET this run may lose before it stops, or null for no stop. Null is
   *  a deliberate setting and not a default: with it set, an unknown P&L holds the rule rather than
   *  reading as no loss (see `limitBlock`), so turning the stop off is also the one press that
   *  releases a run whose ledger has a hole in it. */
  readonly drawdownStopPct: number | null;
  /** Rounds this run may ENTER before it stops, or null for no ceiling. */
  readonly maxRounds: number | null;
}

/**
 * THE DEFAULTS, and the argument for each.
 *
 * `budgetUsd: 250` — the only invented number here, so it is worth defending. It is ten rounds at the
 * $25 the presets on this page sit around. It was chosen when a session lasted an hour and the hour
 * was the real bound; now that a session can last a day, THIS is the bound, which is an argument for
 * keeping it small rather than for growing it. A default that funded a whole night unattended would
 * be this page choosing how much of a stranger's money to risk while they sleep, which is not a
 * choice it is entitled to make. Raising it is one deliberate edit.
 *
 * `perRoundCapUsd: STAKE_CAP_USD` — the arena's own per-side cap. Anything larger would be a limit
 * that never binds, which is a control that lies about existing.
 *
 * `drawdownStopPct: 50` — `SOCIAL.md` §5.4's default. Half the committed budget is a loss a player
 * would want to hear about before it became all of it, and a stop at a share of the budget means the
 * setting keeps its meaning when the budget changes.
 *
 * `maxRounds: null` — off. A ceiling is a preference about how somebody thinks (rounds rather than
 * money), not a safety property, and the budget already bounds the run. Inventing a number here would
 * stop a working rule for a reason the player never asked for.
 */
export const DEFAULT_LIMITS: AutoLimits = {
  budgetUsd: 250,
  perRoundCapUsd: STAKE_CAP_USD,
  drawdownStopPct: 50,
  maxRounds: null,
};

/** Which limit has stopped the rule, or null. Its own union rather than `HoldReason` because nothing
 *  in this module may import `autoDeploy.ts` for a value — see the type-only note at the top. */
export type LimitBlock =
  /** Losses have reached the share of the committed budget the player set. */
  | "drawdown-stopped"
  /** A drawdown stop is set and nothing on this page can say what the run is down.
   *
   *  ONE MEMBER AND NOT TWO, and it is worth recording that the first draft had two. A run whose
   *  ledger has an unrecoverable hole in it is a genuinely different fact from one whose log has not
   *  loaded yet — the first never clears — and it earns a different SENTENCE, which `holdText` writes
   *  off the `RunPnlReading` itself. It does not earn a different member here. Every consumer that
   *  switches on a hold files both under the same answer ("armed, and nothing will be deposited until
   *  something changes"), and this project compiles without `strict` and without
   *  `noImplicitReturns` — so a `default`-less switch over this union does NOT fail the build when a
   *  member is added, whatever the comments beside those switches promise. It silently returns
   *  `undefined` and throws while rendering. A member that buys no branch anywhere and costs a white
   *  screen is not a distinction worth encoding in this type. */
  | "drawdown-unknown"
  /** The committed budget is spent. It does not top itself up. */
  | "budget-spent"
  /** The run has entered as many rounds as it was told to. */
  | "round-ceiling";

/**
 * The loss, in dollars, that trips the stop — or null when no stop is set OR when the figures it
 * would be computed from are not numbers. One expression, shared by the rule and by the sentence the
 * player reads, because a status line quoting a different threshold from the one being enforced is
 * worse than no status line.
 *
 * A NON-FINITE THRESHOLD IS "NO THRESHOLD I CAN STATE", NOT "A THRESHOLD OF NaN", and the difference
 * is the whole reason for the `Number.isFinite` here. Every comparison against a NaN is false, so a
 * NaN threshold returned from this function would sail through `limitBlock`'s `>=` and disable the
 * drawdown stop in total silence — the exact failure the stop exists to prevent, arriving through the
 * one input nothing was inspecting. Returning null routes it to `drawdown-unknown` instead, which
 * holds the rule and says so.
 *
 * IT IS A SHARE OF THE BUDGET AS IT STANDS NOW, and that has a consequence worth stating plainly
 * rather than discovering: raising `budgetUsd` mid-run through `setLimits` also raises the dollar loss
 * this tolerates, in proportion. That is the meaning of "half of what I committed" when a player
 * commits more — but it is a second effect of a control that names only the budget, so `setLimits`
 * says so too, and the panel that offers both is owed the same sentence.
 */
export function drawdownStopUsd(limits: AutoLimits): number | null {
  if (limits.drawdownStopPct === null) return null;
  if (!Number.isFinite(limits.drawdownStopPct) || !Number.isFinite(limits.budgetUsd)) return null;
  return (limits.budgetUsd * limits.drawdownStopPct) / 100;
}

// ---------------------------------------------------------------------------------------------
// What the run is up or down — a running total the rule keeps, not a figure it re-derives
// ---------------------------------------------------------------------------------------------

/**
 * THE RUN'S OWN PROFIT AND LOSS, ACCUMULATED AS ITS ROUNDS SETTLE.
 *
 * THE WRONG TURN THIS REPLACES, recorded because both halves of it were individually right and the
 * defect only existed where they met. The first version derived this figure on demand: re-scan the
 * round log from the run's first round to the newest, sum this player's `pnl`, and refuse to answer
 * unless the log covered that span WITHOUT A HOLE. Refusing on a hole is correct — `scanRoundLog`
 * drops a round whose fetch was rate-limited and reports the partial read as a success, so a single
 * 429 on the batch holding the round somebody lost $80 in would have made the run read as less down
 * than it was, intermittently, and the drawdown stop would have quietly stopped binding. Refusing to
 * read an unknown P&L as zero loss is correct for the same reason: a safety limit that silently
 * evaluates as satisfied is a no-op at exactly the moment it matters.
 *
 * WHAT NEITHER OF THEM NOTICED IS THAT THE LOG IS A WINDOW. `close_round_account` reclaims rent on
 * everything but the newest `MIN_RETAINED_ROUNDS`, so against a keeper that is keeping up the log
 * reaches back about twenty rounds — half an hour. A run that outlived that could no longer be
 * measured over its own span, the figure went permanently unknown, and the drawdown stop held the
 * rule forever. With the default stop set, an overnight run stopped after about twenty rounds, and
 * the player could not tell a working pause from a broken one. The whole point of a day-long session
 * is that an unattended run can last a night; a measurement that forgets after thirty minutes caps
 * the feature it was written to protect.
 *
 * SO IT IS A RUNNING TOTAL, AND THE LOG IS A BACKFILL. A round's realised outcome is final the
 * moment it settles, so it is read ONCE, added, and never needed again — after which it may fall out
 * of the window without costing anything. The log's remaining job is to answer for the rounds that
 * settled since the last look, which is exactly what a twenty-round window is good for.
 *
 * BOUNDED, AND FOR THE SAME REASON `AutoDeployState.attempt` IS ONE SLOT AND NOT A SET. A 24-hour run
 * is about 950 rounds and a per-round record would be 950 entries in memory and in every future
 * persisted copy of this state. Round numbers only ever increase, so a CURSOR does the whole job:
 * everything at or below `bookedThrough` is accounted for, and nothing above `lastEnteredRound` is
 * owed. Three fields, whatever the run's length.
 *
 * EXACTLY-ONCE FALLS OUT OF THE CURSOR rather than out of call sites being careful. The log is
 * re-read every time `round_counter` moves, so a settled round is shown to this code over and over;
 * it is added on the single evaluation where the cursor crosses it and is below the cursor from then
 * on. Nothing here has to remember whether it has seen a round before.
 */
export interface RunPnl {
  /** CHAIN UNITS, NOT DOLLARS, and exact for that reason. This is a sum over hundreds of rounds; in
   *  floating-point dollars a night's worth of additions accumulates representation error into the
   *  one figure a safety limit is compared against. The conversion happens once, at the edge, in
   *  `readRunPnl`. */
  readonly settledUnits: bigint;
  /** THE ACCOUNTING CURSOR. Every round at or below this is in `settledUnits` — either because it
   *  settled and was read, or because the run demonstrably entered nothing between two of its own
   *  rounds (see `pnlEntered`). Null before the run's first confirmed deposit. */
  readonly bookedThrough: bigint | null;
  /**
   * THE ACCOUNT THESE ROWS WERE SUMMED FROM, captured when the run made its first deposit. `""` until
   * then, which is "no owner yet" and not a wallet — no wallet is ever the empty string.
   *
   * IT IS HERE BECAUSE OF THE ONE WAY THIS FIGURE CAN READ A REAL LOSS AS NO LOSS AND NEVER CORRECT
   * ITSELF. `ChainArena` does not remount when Phantom's account changes: `youPubkey` simply becomes
   * a different string while this register keeps every byte of its state. `bookSettledRounds` would
   * then find the run's outstanding round settled, look for the NEW wallet in it, find no row, book
   * the round as zero and advance the cursor past a loss that really happened — permanently, because
   * a booked round is never revisited. Every other way this figure can be wrong is transient; that
   * one is not.
   *
   * THE RUN IS ALSO DISARMED ON A WALLET SWAP (`useAutoDeploy`'s `walletSwapped`), and this field is
   * deliberately NOT made redundant by that. A React effect runs after the commit that changed the
   * prop, and the rule is evaluated on a one-second interval that does not wait for it — so there is
   * a window, however narrow, in which a poll could book a round under an account that did not make
   * the deposit. A window that small will not be found by testing and does not close by itself, so
   * it is closed by the register refusing to answer for a wallet it is not about. The disarm is what
   * tells the player; this is what makes it safe.
   */
  readonly wallet: string;
  /** THE NEWEST ROUND THIS RUN ENTERED. It is the top of the outstanding range, and it is what makes
   *  a long hold cheap: after a lapsed session or a suspended tab the rule may resume hundreds of
   *  rounds later, and every round it did not enter owes this figure nothing. Null until the first
   *  confirmed deposit. */
  readonly lastEnteredRound: bigint | null;
}

export const EMPTY_RUN_PNL: RunPnl = {
  settledUnits: 0n,
  bookedThrough: null,
  lastEnteredRound: null,
  wallet: "",
};

/**
 * WHAT THIS RUN IS UP OR DOWN, AND THE TWO WAYS THAT QUESTION CAN FAIL — which are different facts
 * about the world and are owed different sentences.
 *
 * The distinction `limitBlock` acts on is NOT "known or unknown". It is between a figure that is
 * missing because the world has not finished happening yet, a figure that is missing because a read
 * failed and will be retried, and a figure that is missing because the chain has thrown the evidence
 * away. Only the last is permanent, and only the last is worth telling a player they must act on.
 */
export type RunPnlReading =
  /** A number, in dollars. Negative is a loss. Rounds still fighting contribute their mark-to-market
   *  and rounds not yet read contribute nothing — see `readRunPnl` for both, and for why neither is
   *  a reason to stop. */
  | { kind: "known"; usd: number }
  /** Nothing on this page can say what the WHOLE run is down, RIGHT NOW: no wallet is connected, the
   *  log has not loaded, or a round the run entered is inside the chain's retention window but
   *  missing from this read (a rate-limited batch). Every one of those clears on a later poll without
   *  anybody doing anything. */
  | { kind: "unreadable"; bookedUsd: number }
  /** A round this run entered settled unseen and the chain no longer keeps it. This does not clear.
   *  `fromRound` is the oldest such round — the first one the cursor cannot get past. */
  | { kind: "gap"; fromRound: bigint; bookedUsd: number };

/**
 * WHAT THE RUN IS PROVABLY DOWN, in dollars, whatever else it cannot say. Zero or a profit reads as
 * zero: only losses count against a stop.
 *
 * BOTH INCOMPLETE ANSWERS STILL CARRY A FLOOR, and using it is the difference between a useful stop
 * and a shrug. `settledUnits` is exact and final for every round already accounted for, so a run that
 * has BOOKED a loss past its threshold is over — whether or not some later round is unreadable. The
 * first draft threw that figure away and reported only the inability, which told a player their
 * ledger had a hole when the truer and more actionable sentence was that their run was down more
 * than they had said they would accept.
 *
 * IT IS A FLOOR AND NOT AN ESTIMATE. The unaccounted rounds could have gone either way, so this
 * NEVER lets a stop pass — it can only make one fire that would otherwise have been reported as an
 * inability, which is the direction a protective limit is allowed to err in.
 */
export function provenLossUsd(pnl: RunPnlReading): number {
  const usd = pnl.kind === "known" ? pnl.usd : pnl.bookedUsd;
  return Number.isFinite(usd) ? Math.max(0, -usd) : 0;
}

/** A round whose result can never change again. BOTH terminal phases, and `Abandoned` is not an
 *  afterthought: a lobby that reached its deadline holding fewer than two fighters is finished for
 *  good, and treating only `Settled` as final would stall the cursor on one forever — until it aged
 *  out of the window and turned a perfectly ordinary empty lobby into an unrecoverable gap. */
function roundIsFinal(phase: PhaseName): boolean {
  return phase === "Settled" || phase === "Abandoned";
}

/** This player's realised movement in one round, in units. `RoundSummary.players[].pnl` is
 *  `final - stake` — the same definition every leaderboard on this page prints, so the figure the
 *  drawdown stop enforces and the figure a player reads are one number. Summed rather than found
 *  because a wallet can hold more than one fighter in a round. */
function playerUnits(round: RoundSummary, youPubkey: string): bigint {
  let units = 0n;
  for (const player of round.players) if (player.wallet === youPubkey) units += player.pnl;
  return units;
}

/**
 * THE RUN ENTERED A ROUND — called for a CONFIRMED deposit this rule sent, beside `tallyEntered` and
 * under the same guard, because the money it will get back is owed to the same budget the stake came
 * out of.
 *
 * IT ALSO MOVES THE CURSOR OVER ROUNDS THE RUN DID NOT ENTER, and that is the line that makes a long
 * pause survivable. Consider a run that enters round 40, has its session lapse, and picks up again at
 * round 300 when the player opens a fresh one — which is not a hypothetical, it is the advertised
 * shape of an overnight run. Rounds 41 to 299 were never entered and owe this figure nothing, but a
 * cursor that had to walk them would stall on the first one that had aged out of the window and
 * report an unrecoverable gap over rounds this rule never touched. So when the books are SQUARE —
 * every round entered so far is already accounted — a new entry carries the cursor to the round
 * before it. When they are not square something is genuinely outstanding below, and the cursor stays
 * put so that the walk can still reach it.
 *
 * A HAND DEPLOY DOES NOT COME THROUGH HERE, for the reason `attemptLanded` gives for not charging one
 * against the budget: this is the RULE's account of itself, and a deposit the player made is not the
 * run's to answer for in either direction.
 *
 * ROUNDS ONLY INCREASE, so a booking at or below `lastEnteredRound` is a repeat of one already
 * recorded and is dropped — the same guard, for the same reason, as `tallyEntered`'s.
 *
 * `wallet` IS THE ACCOUNT THAT MADE THE DEPOSIT, read at SEND time by the caller for the same reason
 * `sessionEpochAtSend` is: a confirmation outlives the render it was started in. The first entry
 * claims the register for that account; a later entry from a different one is refused rather than
 * mixed in, because two accounts' rounds added together is not a figure about either of them. See
 * `RunPnl.wallet` for the failure that makes this structural rather than advisory.
 */
export function pnlEntered(p: RunPnl, roundNo: bigint, wallet: string): RunPnl {
  if (p.wallet !== "" && p.wallet !== wallet) return p;
  if (p.lastEnteredRound !== null && roundNo <= p.lastEnteredRound) return p;
  const square = p.bookedThrough === p.lastEnteredRound;
  return {
    ...p,
    wallet,
    bookedThrough: square ? roundNo - 1n : p.bookedThrough,
    lastEnteredRound: roundNo,
  };
}

/**
 * TAKE EVERYTHING THE LOG CAN NOW ANSWER FOR, AND CLOSE THE BOOKS ON IT.
 *
 * The walk is forward from the cursor and stops at the first round it cannot finish — a round still
 * fighting, or one this read did not return. It cannot skip: a round that has not been accounted for
 * may not be stepped over, because stepping over it would be reading a missing settlement as no loss,
 * which is the one thing this whole figure exists not to do.
 *
 * ROUNDS INSIDE THE RANGE THAT THE RUN DID NOT ENTER COST NOTHING AND ARE NOT SKIPPED EITHER. They
 * are read from the log like any other and contribute whatever the log says the player did in them,
 * which is zero unless they deployed by hand. That is the same imprecision the derived version
 * carried and it is stated in the same terms: the log records that a wallet was in a round, not whose
 * press put it there. It is now bounded to the run's OWN span — between two rounds this rule entered
 * — rather than to every round since the run began, which is strictly less of it.
 *
 * IDENTITY IS PART OF THE CONTRACT. This runs once a second while armed and the state it belongs to
 * is committed through a ref that repaints on change, so a pass that books nothing must return the
 * object it was given rather than an equal copy.
 */
export function bookSettledRounds(p: RunPnl, rounds: RoundSummary[], youPubkey: string): RunPnl {
  if (p.lastEnteredRound === null) return p;
  // `""` is how this page spells "nobody" (see `ArenaContextValue.you`). With no wallet there are no
  // rows to attribute, and booking a round as zero because we cannot see ourselves in it would be the
  // silent no-op this figure is built to refuse.
  if (youPubkey === "") return p;
  // NOT THE ACCOUNT THIS RUN IS ABOUT. Booking on would sum a different player's rows — in practice
  // no rows at all, which is the silent zero `RunPnl.wallet` exists to refuse.
  if (p.wallet !== "" && p.wallet !== youPubkey) return p;
  const from = (p.bookedThrough ?? p.lastEnteredRound - 1n) + 1n;
  if (from > p.lastEnteredRound) return p;

  const byRound = new Map<bigint, RoundSummary>();
  for (const round of rounds) byRound.set(round.roundNo, round);

  let units = p.settledUnits;
  let through = p.bookedThrough;
  for (let r = from; r <= p.lastEnteredRound; r += 1n) {
    const round = byRound.get(r);
    if (round === undefined || !roundIsFinal(round.phase)) break;
    units += playerUnits(round, youPubkey);
    through = r;
  }
  if (through === p.bookedThrough) return p;
  return { ...p, settledUnits: units, bookedThrough: through };
}

/**
 * THE FIGURE, OR THE HONEST ACCOUNT OF WHY THERE ISN'T ONE.
 *
 * NOT-YET-SETTLED IS NOT MISSING, and separating those two is the correction this reading exists to
 * make. A round the run entered thirty seconds ago has no realised outcome yet; the old test — "is
 * the whole span readable" — could not tell that apart from a round whose record had been reclaimed,
 * so a perfectly healthy run in the middle of its own fight read as unmeasurable. Here a round that
 * is present and unfinished, or newer than anything the log has returned, is simply pending: it holds
 * nothing up, and the figure is what has settled so far.
 *
 * A ROUND STILL FIGHTING CONTRIBUTES ITS MARK-TO-MARKET, unchanged from the derived version and for
 * the same reason: `hp + banked` is what the account says right now, so the figure is early rather
 * than wrong, and early is the direction a protective stop should err in. It is added transiently
 * here rather than booked, because a mid-fight number is not a fact yet — booking it would freeze a
 * guess into a running total that can never be corrected.
 *
 * THE TWO FAILURES ARE TOLD APART BY THE CHAIN'S RETENTION RULE, not by whether this read happened to
 * return the round. `close_round_account` refuses to touch the newest `MIN_RETAINED_ROUNDS`, so a
 * round inside that window is guaranteed to exist and its absence is a failed read — `scanRoundLog`
 * drops a rate-limited fetch silently, which is common enough on devnet to be the normal case. That
 * is `unreadable`, it clears on the next poll, and it must not be reported as permanent. Below the
 * window the account may genuinely be gone, and no later read will bring it back: that is `gap`.
 *
 * THE WINDOW IS MEASURED FROM THE NEWEST ROUND THE LOG RETURNED, which is a lower bound on the
 * arena's `round_counter` and therefore places the retention edge no HIGHER than it really is. The
 * error is one-directional and lands on the side of calling a lost round merely `unreadable` —
 * claiming a pause will clear when it will not is the milder of the two lies, and the run stops
 * either way.
 */
export function readRunPnl(p: RunPnl, rounds: RoundSummary[], youPubkey: string): RunPnlReading {
  // Nothing has been deposited, so there is nothing this run could be down. Zero is a fact here, not
  // an absence of one, and it is what lets a freshly armed run take its first round.
  if (p.lastEnteredRound === null) return { kind: "known", usd: 0 };
  // What is already booked is exact whatever else cannot be read, so every incomplete answer carries
  // it — see `provenLossUsd` for the one thing a floor is allowed to do.
  const bookedUsd = unitsToUsd(p.settledUnits);
  if (youPubkey === "") return { kind: "unreadable", bookedUsd };
  // A DIFFERENT ACCOUNT CANNOT BE TOLD WHAT THIS RUN IS DOWN, and it is an inability rather than a
  // zero: the rounds are real and the loss is real, it simply is not this reader's. The run is
  // disarmed on a wallet swap anyway; this is what holds it in the window before that lands.
  if (p.wallet !== "" && p.wallet !== youPubkey) return { kind: "unreadable", bookedUsd };

  const next = (p.bookedThrough ?? p.lastEnteredRound - 1n) + 1n;
  // Every round the run entered is accounted for and nothing above it is owed. This is the ordinary
  // state of a healthy run between rounds, and it needs no log at all — which is the whole point: it
  // stays true for round 950 exactly as it was for round 3.
  if (next > p.lastEnteredRound) return { kind: "known", usd: bookedUsd };

  let newest: bigint | null = null;
  let nextIsReadable = false;
  // Readable but not booked: the outstanding round's mark-to-market, plus anything above it the log
  // can already answer for. It is added here and not in `settledUnits` because the cursor cannot pass
  // the outstanding round, and a total that jumped when the cursor caught up would be two different
  // answers to one question.
  //
  // IT IS BEST-EFFORT, AND ONLY THE CURSOR ROUND DECIDES WHETHER THERE IS AN ANSWER AT ALL. A round
  // ABOVE the cursor that this read happened to drop is simply absent from this sum for one poll —
  // it is not booked, nothing is lost by it, and the cursor will meet it and judge it properly when
  // it gets there. Holding the whole run unreadable because a round two above the cursor was
  // rate-limited would stop the rule on the strength of a figure it was not going to enforce yet.
  let openUnits = 0n;
  for (const round of rounds) {
    if (newest === null || round.roundNo > newest) newest = round.roundNo;
    if (round.roundNo === next) nextIsReadable = true;
    if (round.roundNo >= next && round.roundNo <= p.lastEnteredRound) {
      openUnits += playerUnits(round, youPubkey);
    }
  }
  // An empty log is not an empty history. It is a log that has not loaded, or one whose every read
  // failed — and `useHistory` only surfaces an error in the second case, so this is the only place
  // the first one can be noticed at all.
  if (newest === null) return { kind: "unreadable", bookedUsd };

  const pending = unitsToUsd(p.settledUnits + openUnits);
  // Present, and therefore unfinished — `bookSettledRounds` would have taken it otherwise. Pending.
  if (nextIsReadable) return { kind: "known", usd: pending };
  // Newer than anything read: the log refreshes when `round_counter` moves, so it trails the chain by
  // a round. A round nobody has read yet has not settled as far as anything here can tell.
  if (next > newest) return { kind: "known", usd: pending };

  const guaranteed = newest > BigInt(MIN_RETAINED_ROUNDS) ? newest - BigInt(MIN_RETAINED_ROUNDS) + 1n : 1n;
  if (next >= guaranteed) return { kind: "unreadable", bookedUsd };
  return { kind: "gap", fromRound: next, bookedUsd };
}

/**
 * WHY NOTHING WILL BE SENT, when the answer is one of the limits.
 *
 * It exists so that `clampToLimits` does not have to answer two questions at once. That function
 * returns a FIGURE or nothing, and "nothing" has several different causes with different sentences
 * owed to the player. A single null could not tell them apart, and a status line that says "held"
 * without saying which limit is a status line this codebase treats as a defect.
 *
 * THE ORDER IS BY WHAT A READER MOST NEEDS TO KNOW, and it is three tiers rather than a list.
 *
 *   1. A PROTECTIVE STOP THAT HAS FIRED, because it is news: "this run is down more than you said you
 *      would accept" is a different sort of thing from "it played the rounds you paid for", and a
 *      player owed both should be told that one.
 *   2. A RUN THAT IS SIMPLY FINISHED — budget spent, ceiling reached. Definite, and it did what it
 *      was told.
 *   3. AN INABILITY, last. It is not a fact about the run, it is a fact
 *      about what this page can read, and it must not be reported over either of the above: telling
 *      somebody their drawdown cannot be checked when their budget ran out an hour ago sends them
 *      chasing a ledger for a run that had already finished. WHICH KIND of inability it is — a poll
 *      that will answer, or a settlement the chain has thrown away — is a difference in the sentence
 *      rather than in the verdict; `holdText` writes it, and `LimitBlock`'s own note says why it is
 *      not a second member here.
 *
 * AN UNKNOWN P&L IS NOT ZERO LOSS, and that invariant is older than this signature and survives it.
 * If a stop is set and the figure cannot be had, the stop cannot be evaluated, and a safety limit
 * that silently reads as satisfied is a no-op at exactly the moment it matters. So it still holds the
 * rule, at tier 3.
 *
 * WHAT DID CHANGE IS THAT "CANNOT BE HAD" USED TO BE ALMOST EVERYTHING. This took a `number | null`
 * derived by re-scanning the round log over the run's whole span, and the log is a window about
 * twenty rounds wide — so every run that lasted more than half an hour arrived here as null and was
 * held, permanently, by the limit that was meant to protect it. `RunPnlReading` is what replaced it:
 * the figure is now a running total the rule owns (`RunPnl`), and the three answers it can give are
 * a number, a pause that will lift, and a hole that will not. This function's job is to keep the
 * invariant while telling those last two apart out loud.
 */
export function limitBlock(
  limits: AutoLimits,
  tally: RunTally,
  pnl: RunPnlReading,
): LimitBlock | null {
  const stopUsd = drawdownStopUsd(limits);
  const stopSet = limits.drawdownStopPct !== null;
  // A NON-FINITE FIGURE IS NOT A FIGURE, checked here as well as at the type. `readRunPnl` converts
  // from exact chain units and cannot produce a NaN, but this function is total over any caller's
  // reading — and every comparison against a NaN is false, so one arriving as `known` would sail
  // through the `>=` below and disable the stop in silence. `drawdownStopUsd` guards its own inputs
  // for exactly this reason; this is the same guard on the other operand.
  const knownUsd = pnl.kind === "known" && Number.isFinite(pnl.usd) ? pnl.usd : null;
  // THE LOSS ALREADY PROVED — the whole figure when the ledger is complete, and the booked floor when
  // it is not.
  //
  // A STOP MAY FIRE ON AN INCOMPLETE LEDGER, and it took a second pass to see that it should. The
  // first draft reported only the inability whenever anything was missing, so a run that had already
  // BOOKED $200 of loss against a $125 stop was told its ledger had a hole in it — true, less useful,
  // and considerably less alarming than the sentence it had earned. What is booked is exact and
  // final, and the rounds nobody can read can only make the answer worse, so a proven breach is
  // reported as the breach it is. An UNPROVEN one still holds at tier 3: the floor may fire a stop,
  // never pass one.
  const lostUsd = provenLossUsd(pnl);

  // `lostUsd > 0` is not redundant, and it is the only thing that makes a 0% stop mean what a player
  // reading the control means. Without it, `0 >= 0` fires at a flat or profitable ledger and the run
  // stops before it has deposited anything, over a status line reading "this run is down more than
  // the 0% you said you would accept — $0.00". With it, a 0% stop means "the moment I am down at
  // all", which is a coherent instruction, and every positive threshold is unaffected.
  if (stopUsd !== null && lostUsd > 0 && lostUsd >= stopUsd) return "drawdown-stopped";

  // A BOUND THAT IS NOT A NUMBER IS NOT A BOUND, and the answer is to stop rather than to sail past
  // it. Every comparison against a NaN is false, so a NaN budget left below as `NaN < MIN_STAKE_USD`
  // would read as "plenty of room" and a NaN ceiling as "not reached yet" — a run with no limits at
  // all, in total silence, from a control mid-edit or a stored value that is no longer a number.
  // `clampToLimits` has defended against exactly this since it was written; this is the same guard on
  // the function whose whole job is the limits.
  const budgetLeftUsd = limits.budgetUsd - tally.spentUsd;
  // THE THRESHOLD IS `MIN_STAKE_USD`, NOT ZERO, on purpose. A budget with half a cent left in it is
  // spent: there is nothing sendable in it, and reporting it as "still running" would be true in
  // arithmetic and false in every way a reader cares about.
  if (!Number.isFinite(budgetLeftUsd) || budgetLeftUsd < MIN_STAKE_USD) return "budget-spent";
  if (limits.maxRounds !== null && !(tally.entered < limits.maxRounds)) return "round-ceiling";

  // Last, because an inability is a fact about what this page can read rather than about the run.
  if (stopSet && (stopUsd === null || knownUsd === null)) return "drawdown-unknown";
  return null;
}

/**
 * THE DOLLARS THAT MAY ACTUALLY BE SENT THIS ROUND, or NULL for "nothing may be".
 *
 * NULL IS THE IMPORTANT HALF, and `resolveAmountUsd`'s note applies here verbatim: this function must
 * never round its way UP to a sendable amount. A rule whose room has shrunk to half a cent has to
 * decline and say so, not become a one-cent deposit that pays a real devnet fee to stake a tenth of a
 * cent, every round, forever. So the minimum is tested against the RAW room, before any rounding
 * touches it.
 *
 * The rounding that follows is a floor to whole cents rather than the nearer one, for a smaller
 * reason that is still worth being exact about: `Math.round` could carry the figure a fraction of a
 * cent back OVER the very budget it was just clamped to, and a budget that is exceeded by half a cent
 * is a budget somebody has to explain. Written as a step-down from the rounded value instead of
 * `Math.floor(room * 100)` because that expression loses a whole cent to float representation on
 * ordinary inputs (0.29 * 100 is 28.999999999999996), and a rule that quietly shaves a cent off every
 * deposit is worse than one that occasionally rounds.
 */
export function clampToLimits(amountUsd: number, limits: AutoLimits, spentUsd: number): number | null {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

  const room = Math.min(
    amountUsd,
    limits.perRoundCapUsd,
    limits.budgetUsd - spentUsd,
    // The arena's own per-side cap, applied again here even though `resolveAmountUsd` already
    // applies it. This function is total over any caller's numbers, including a hand-set
    // `perRoundCapUsd` above the arena's cap, and a deposit the product refuses is not something to
    // send and find out about.
    STAKE_CAP_USD,
  );
  // A NaN anywhere in the limits (a control mid-edit, a stored value that is no longer a number)
  // arrives here as a NaN room, and the answer to "how much should I send" on a NaN is nothing.
  if (!Number.isFinite(room)) return null;
  if (room < MIN_STAKE_USD) return null;

  let cents = Math.round(room * 100);
  if (cents / 100 > room) cents -= 1;
  return cents / 100;
}

// ---------------------------------------------------------------------------------------------
// The tally — what happened while you were away
// ---------------------------------------------------------------------------------------------

/**
 * THE ACCOUNT OF ONE RUN. A player who arms this and closes the laptop is owed a statement when they
 * come back, and "the status line says it is waiting for the next round" is not one — it describes an
 * instant, and they were gone all night.
 *
 * `spentUsd` IS CONFIRMED DOLLARS, NEVER ATTEMPTED ONES. A retried transaction that failed twice and
 * landed once cost one stake, and a tally that counted attempts would tell a player they had spent
 * three times what they did — a number they would reasonably act on. It is also what the budget is
 * enforced against, so counting attempts would additionally cut the run short.
 *
 * IT DOES NOT CARRY A PROFIT AND LOSS, and that absence is deliberate: a tally knows what was STAKED
 * and nothing whatever about what came back, and deriving one from the other would be inventing it.
 * What came back is `RunPnl`'s job — a separate register, fed by the round log, next to this one in
 * `AutoDeployState` — and the two are kept apart precisely so that neither can be mistaken for
 * evidence of the other.
 */
export interface RunTally {
  armedAtMs: number;
  /** Rounds a deposit CONFIRMED into. */
  entered: number;
  /** Dollars confirmed, never attempted. */
  spentUsd: number;
  /** Rounds abandoned for any reason. */
  missed: number;
  /** The span of rounds this run has ACCOUNTED for — entered or missed. Not "rounds that happened":
   *  a round the player entered by hand is neither of those and is deliberately absent, because this
   *  is the rule's account of itself and their deposit was not its doing. */
  firstRound: bigint | null;
  /** Also the accounting cursor — see `tallyEntered`. */
  lastRound: bigint | null;
  /** What `lastRound` was booked AS. The second half of the cursor, and it exists so that a
   *  confirmation arriving after its round was written off can correct the books rather than be
   *  discarded — see `tallyEntered`. */
  lastOutcome: "entered" | "missed" | null;
}

export const EMPTY_TALLY: RunTally = {
  // Zero rather than a clock read, because this module takes no clocks: `armWith` stamps it at the
  // moment of arming, from the caller's `nowMs`, and a tally that has never been armed reports its
  // duration as unknown rather than as fifty-six years.
  armedAtMs: 0,
  entered: 0,
  spentUsd: 0,
  missed: 0,
  firstRound: null,
  lastRound: null,
  lastOutcome: null,
};

/**
 * EACH ROUND IS BOOKED EXACTLY ONCE, and the cursor — `lastRound` plus `lastOutcome` — is what makes
 * that true rather than a promise about call sites.
 *
 * The double-booking hazard is real and specific: a deposit this rule sends is reported to the state
 * twice, by two paths that do not know about each other — `attemptLanded` when the transaction
 * confirms, and `noteRoundEntered` from the page-wide confirmed-enter callback that fires for EVERY
 * deposit however it was made. Either can arrive first. A tally that trusted its callers would double
 * the spend figure, and the spend figure is what the budget is enforced against, so it would also
 * halve the run.
 *
 * A CONFIRMATION SUPERSEDES A MISS FOR THE SAME ROUND, and that exception is not a softening of the
 * rule — it is the rule applied to the stronger fact. The sequence is ordinary on devnet: a deposit
 * is sent, the client's confirmation times out ("Transaction was not confirmed in 30.00 seconds"),
 * the lobby deadline passes and the round is written off `entries-closed` — and then the transaction
 * turns out to have landed. Booked first-writer-wins, the run would carry a missed round whose stake
 * it had actually spent: the attempt record on screen would say the round landed while the statement
 * beside it said $0.00 into 0 rounds, and — worse than the contradiction — the budget would never be
 * charged for it, so the run would outspend what it was given by one stake every time it happened.
 * The chain confirming is the strongest fact available about a round, so it corrects the books.
 *
 * The reverse is refused: `tallyMissed` will not downgrade a round already booked as entered. Nothing
 * can un-spend a confirmed deposit.
 *
 * ROUNDS ONLY EVER INCREASE, so a booking for a round older than the cursor is history the books have
 * already closed over. It is dropped rather than guessed at — the alternative is a tally that grows a
 * record per round, which is the unbounded structure this whole feature was built to be rid of.
 */
export function tallyEntered(t: RunTally, roundNo: bigint, amountUsd: number): RunTally {
  if (t.lastRound !== null && roundNo < t.lastRound) return t;
  const correctingAMiss = t.lastRound === roundNo && t.lastOutcome === "missed";
  if (t.lastRound === roundNo && !correctingAMiss) return t;
  return {
    ...t,
    entered: t.entered + 1,
    missed: correctingAMiss ? t.missed - 1 : t.missed,
    spentUsd: t.spentUsd + (Number.isFinite(amountUsd) ? amountUsd : 0),
    firstRound: t.firstRound ?? roundNo,
    lastRound: roundNo,
    lastOutcome: "entered",
  };
}

export function tallyMissed(t: RunTally, roundNo: bigint): RunTally {
  if (t.lastRound !== null && roundNo <= t.lastRound) return t;
  return {
    ...t,
    missed: t.missed + 1,
    firstRound: t.firstRound ?? roundNo,
    lastRound: roundNo,
    lastOutcome: "missed",
  };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function forHowLong(t: RunTally, nowMs: number): string | null {
  if (t.armedAtMs <= 0 || nowMs < t.armedAtMs) return null;
  const minutes = Math.floor((nowMs - t.armedAtMs) / 60_000);
  if (minutes < 1) return "in the last minute";
  if (minutes < 60) return `over the last ${plural(minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  return `over the last ${plural(hours, "hour")}`;
}

function roundSpan(t: RunTally): string {
  if (t.firstRound === null || t.lastRound === null) return "";
  return t.firstRound === t.lastRound
    ? `, in round ${t.firstRound}`
    : `, across rounds ${t.firstRound} to ${t.lastRound}`;
}

/**
 * THE STATEMENT A PLAYER READS WHEN THEY COME BACK. SPEC's three-part copy rule binds here with extra
 * force, because this is the only sentence on the page written for somebody who was not present for
 * any of what it describes: what is true now, what they can do, and when it changes.
 *
 * WHAT IT DOES NOT SAY, and why. It does not name the reason the rule is held at this instant. The
 * tally does not know it — a hold is a fact about the world right now, not about the run — and a
 * report that guessed at one would be inventing. That sentence exists, is already worded, and is
 * always on screen beside this one: `holdText`. This report points at it rather than paraphrasing it,
 * which is the same discipline that keeps one wording per outcome everywhere else in this feature.
 *
 * IT ALSO DOES NOT SAY WHAT THE RUN IS WORTH. `SOCIAL.md` §1.1's card — "entered 31 rounds and
 * returned −$12.40" — is a richer thing than this and needs a P&L this module deliberately does not
 * hold. What is here is what can be said honestly from the rule's own record.
 */
export function tallyReport(t: RunTally, nowMs: number): string {
  // "since it was armed" when the clock is unknown — which is the honest fallback and not a rare one:
  // a tally restored into a state that was never stamped has no duration, and inventing "the last
  // hour" from a zero would be a number with nothing behind it.
  const since = forHowLong(t, nowMs) ?? "since it was armed";

  if (t.entered === 0 && t.missed === 0) {
    return (
      `Nothing has been deposited and no round has been missed ${since}. It acts on the next round ` +
      "that opens; the line above says what it is waiting on, and Pause stops it at any time."
    );
  }

  const missed =
    t.missed === 0
      ? " and missed none"
      : `, and missed ${plural(t.missed, "round")} — each one said why at the time`;

  return (
    `It has deposited ${usd(usdToUnits(t.spentUsd))} into ${plural(t.entered, "round")}${missed}` +
    `${roundSpan(t)}, ${since}. It keeps going one round at a time until you turn it off or it runs ` +
    "into one of its limits; the line above says what it is doing right now."
  );
}

// ---------------------------------------------------------------------------------------------
// Runway — how far this can go, and which bound gets there first
// ---------------------------------------------------------------------------------------------

/**
 * ROUND CADENCE, for turning a session's remaining minutes into a number of ROUNDS — which is the
 * unit a player armed this in.
 *
 * DERIVED, NOT MEASURED, and marked as assumed for the same reason `ASSUMED_SESSION_MINUTES` is: the
 * operator decides how long a lobby stays open and when the next round starts, and neither is a
 * constant this page can read. 90 seconds is the shape the test harness's `NORMAL_ROUND` models — a
 * 45s lobby, the dead window after it, the draw, a fight and the settle — rounded to a figure nobody
 * will mistake for a measurement.
 *
 * NOTHING IS GATED ON IT. It only ever produces the word "about" in a sentence about how far a
 * session might stretch. A drifted cadence makes that sentence imprecise; it cannot stop a deposit.
 */
export const ASSUMED_ROUND_SECONDS = 90;

/** WHICH BOUND RUNS OUT FIRST. Named rather than left to a reader comparing three numbers, because
 *  the whole point of a runway is the answer to "what stops this, and when". */
export type RunwayBound =
  /** The committed budget, in its worst case — every fight lost. */
  | "money"
  /** The play session, at the observed cadence. */
  | "session"
  /** The round ceiling the player set. */
  | "rounds";

export interface Runway {
  /** What the door certainly takes per round at this stake and the arena's CURRENT rate. */
  feePerRoundUsd: number;
  /** Rounds the budget funds if the fights break even — budget left ÷ fee. The optimistic bound.
   *  Null when the door takes NOTHING AT THIS STAKE, which is two different worlds with one answer: a
   *  rate of zero, and a stake small enough that the program's floor division truncates the fee to
   *  nothing. Neither bounds the run, and neither divides by anything. */
  roundsIfBreakEven: number | null;
  /** Rounds it funds if every single one is lost — budget left ÷ stake. The pessimistic bound, and
   *  the only one of the two that is CERTAIN, which is why `binding` is computed from it. */
  roundsIfAllLost: number;
  /** Rounds the CURRENT session can still cover at the assumed cadence, or null when its remaining
   *  life is not known here (a session restored from a previous visit has no local record of when it
   *  began — see `sessionExpiry.ts`). */
  roundsThisSession: number | null;
  /** Rounds left under the player's round ceiling, or null when they set none. */
  roundsToCeiling: number | null;
  /**
   * WHICHEVER OF THE ABOVE RUNS OUT FIRST, compared on the bounds that are CERTAIN: the money's worst
   * case, the session, the ceiling. If the fights go better than the worst case the money lasts
   * longer, which can only move this away from `"money"` and never towards it.
   *
   * When the session's remaining life is unknown it takes no part in the comparison and the copy
   * hedges in words instead — a bound nobody can see is not a bound this may quietly assume away.
   */
  binding: RunwayBound;
}

function finiteOrZero(n: number): number {
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * HOW FAR THIS CAN GO — and it reads the LIVE `FeeRate`, never `FEE_BPS`.
 *
 * THAT IS NOT A STYLE PREFERENCE, it is the incident recorded on `FEE_BPS` itself: the rate was moved
 * 20 → 100 on devnet while the site was serving, and every surface holding the constant told players
 * entry cost 0.20% while the chain charged 1.00% until the next build. `fee_bps` is read off the
 * Arena account on the poll that is already running, `set_fee_bps` can move it against players
 * standing in a lobby, and a projection of somebody's whole night computed against a build-time copy
 * of it is the same defect with a night's worth of money behind it. The fee is priced through
 * `feeOn`, which is the program's own floor division, so the figure here is the one `split_entry`
 * will actually take rather than a rounded guess at it.
 *
 * THE MONEY BOUNDS COME OFF THE COMMITTED BUDGET, not off the bankroll. A budget is capital committed
 * at arm time that drains and never tops itself up (`SOCIAL.md` §5.4), so what is left of it is
 * exactly what this run has left to spend — and a runway quoted off the wallet would count money the
 * player did not commit.
 */
export function runway(args: {
  stakeUsd: number;
  fee: FeeRate;
  limits: AutoLimits;
  tally: RunTally;
  sessionMinutesLeft: number | null;
}): Runway {
  const stakeUsd = finiteOrZero(args.stakeUsd);
  const feePerRoundUsd = unitsToUsd(feeOn(usdToUnits(stakeUsd), args.fee));
  const budgetLeftUsd = finiteOrZero(args.limits.budgetUsd - args.tally.spentUsd);

  const roundsIfAllLost = stakeUsd <= 0 ? 0 : Math.floor(budgetLeftUsd / stakeUsd);
  const roundsThisSession =
    args.sessionMinutesLeft === null
      ? null
      : Math.floor(finiteOrZero(args.sessionMinutesLeft * 60) / ASSUMED_ROUND_SECONDS);
  const roundsToCeiling =
    args.limits.maxRounds === null ? null : Math.max(0, args.limits.maxRounds - args.tally.entered);

  // Ties go to the earlier entry, which is deliberate: when the money and something else run out on
  // the same round, the money is the one with consequences a player cares about.
  let binding: RunwayBound = "money";
  let least = roundsIfAllLost;
  if (roundsToCeiling !== null && roundsToCeiling < least) {
    binding = "rounds";
    least = roundsToCeiling;
  }
  if (roundsThisSession !== null && roundsThisSession < least) binding = "session";

  return {
    feePerRoundUsd,
    roundsIfBreakEven: feePerRoundUsd <= 0 ? null : Math.floor(budgetLeftUsd / feePerRoundUsd),
    roundsIfAllLost,
    roundsThisSession,
    roundsToCeiling,
    binding,
  };
}

/**
 * TWO BOUNDS, STATED AS BOUNDS. Never one invented number.
 *
 * The temptation is a single figure — "about 40 rounds" — and it would be a fabrication, because the
 * distance between the two honest answers is not a rounding error: at a $25 stake and a 1% door, a
 * $500 budget funds 20 rounds if every fight is lost and 2,000 if they break even. Nothing on this
 * page knows which, `SPEC`'s non-negotiable is that we never invent a number, and a player who sized
 * a night's budget off a made-up midpoint would have been misled by us specifically.
 *
 * IT NAMES WHICHEVER BOUND ACTUALLY BINDS rather than assuming one does. An earlier draft presented
 * the play session as the ceiling, which was true while a session lasted an hour and stopped being
 * true the day it lasted a day — the sort of sentence that survives the change that invalidates it
 * because nobody re-reads copy. `Runway.binding` is computed; this only says it.
 *
 * THE SESSION PROMISE IS IN EVERY BRANCH, because it is the one thing a player leaving a machine
 * unattended most needs to be sure of: when the session runs out, this stops. It does not wake them
 * up with a dialog.
 */
export function runwayNote(r: Runway): string {
  // "AT THIS STAKE", NOT "THE ARENA IS CHARGING NOTHING", and the distinction is one the copy got
  // wrong first time round. A zero fee per round has two causes: a rate of zero, and a stake small
  // enough that `feeOn`'s floor division truncates the take to nothing. Only the first is a statement
  // about the arena, and making it about the arena told a reader the door was free while `fee.bps`
  // said 1bp. This sentence is true in both worlds, which is the only sentence worth printing when a
  // figure cannot tell them apart.
  const fee =
    r.feePerRoundUsd <= 0
      ? "At this stake the door takes nothing at all, so a round only costs what you put in."
      : `At this stake the door takes ${usd(usdToUnits(r.feePerRoundUsd))} a round at the arena's current rate.`;

  const money =
    r.roundsIfBreakEven === null
      ? `What is left of the budget funds ${plural(r.roundsIfAllLost, "round")} if every fight is lost, and — with nothing going to the door — as many as it survives if they break even.`
      : `What is left of the budget funds somewhere between ${plural(r.roundsIfAllLost, "round")}, if every fight is lost, and about ${r.roundsIfBreakEven}, if they break even. Nothing here knows which, so it is stated as the range it is.`;

  const binds =
    r.binding === "session"
      ? `Your play session is the first thing to run out: about ${plural(r.roundsThisSession ?? 0, "round")}.`
      : r.binding === "rounds"
        ? `The round ceiling you set gets there first: ${plural(r.roundsToCeiling ?? 0, "round")} left, and then it stops.`
        : "The budget is the first thing to run out, and it never tops itself up — raising it is a thing you do, not a thing that happens.";

  const unseenSession =
    r.roundsThisSession === null
      ? " How much of your play session is left is not known in this tab, so it may get there before any of that."
      : "";

  return (
    `${fee} ${money} ${binds}${unseenSession} When the session does run out this stops depositing ` +
    "rather than asking you to approve anything, and picks up at the next round once a fresh one is " +
    "open."
  );
}

// ---------------------------------------------------------------------------------------------
// The strategy seam — for ENTRY, and only for entry
// ---------------------------------------------------------------------------------------------

/**
 * WHICH SIDE THE NEXT DEPOSIT GOES TO. One arm today, and the seam is the point.
 *
 * THIS IS BUILT AS A SEAM RATHER THAN AS STRATEGIES because the strategies are not yet decided and
 * writing them now would be inventing product. What IS decided is where they attach: the decision
 * ladder asks `chooseSide` instead of reading `state.side`, so "always Bulls" or "alternate" is one
 * arm here and one control in the panel, and nothing else in the feature moves. A ladder that read
 * the field directly would put the same edit in the rule, the hook, the handle and the panel — which
 * is the shape this feature was in when it lived inside the Deploy panel, and is the reason it was
 * unreliable.
 *
 * IT IS AN ENTRY SEAM, AND THAT IS NOT AN OVERSIGHT. Everything that plugs in here is a parameter of
 * a DEPOSIT: which side, how much, how often. There is no exit rule here and none is coming through
 * this door — `SOCIAL.md` §1.1 makes "never ship auto-extract" a hard rule for exactly this work,
 * because an automatic extraction is the judgement the player came back to make. The honest version
 * of an exit rule, if one is ever wanted, is a stop-loss framed as damage control and priced as
 * deliberately worse than being awake; it is a decision the owner has not made, and reading this seam
 * as an invitation to make it would be reading it backwards.
 */
export type SideRule = { kind: "repeat" };

export interface Strategy {
  amount: AmountRule;
  side: SideRule;
}

/** Null means there is nothing to deposit on yet — the rule has no side to repeat because this
 *  browser has not deployed once. That is a hold with its own words (`no-side`), not a default: a
 *  side picked for a player who never chose one is money placed on a coin toss we made for them. */
export function chooseSide(rule: SideRule, lastSide: Side | null): Side | null {
  switch (rule.kind) {
    case "repeat":
      return lastSide;
  }
}
