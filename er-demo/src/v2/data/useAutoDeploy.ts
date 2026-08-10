// React's half of "repeat every round": hold the policy, evaluate it on a clock, and send the one
// transaction it asks for. Every rule lives next door in `autoDeploy.ts`; this file owns timing,
// the write, and telling the player what happened.
//
// IT IS MOUNTED IN THE PROVIDER, NOT IN THE PANEL. `App.tsx` swaps whole screens with a `switch`, so
// anything held inside the Deploy panel dies the moment someone opens the Leaderboard. That is how a
// money rule ends up "firing some rounds, not others" without a single line of it being wrong: it was
// simply not running. The checkbox in 00-3 is now a view of this state, not the home of it.
//
// WHY A CLOCK AND NOT A DEPENDENCY LIST. The old effect re-ran when its inputs changed, which sounds
// equivalent and is not: the inputs it needed (a lobby's on-chain deadline passing, a retry's backoff
// elapsing, a poll landing during a window the effect happened not to be subscribed to) include
// several that change with TIME rather than with React state, and an effect cannot depend on time. So
// the decision is simply re-asked once a second while armed. It is a pure function over a handful of
// primitives; asking it 60 times a minute costs nothing, and it removes the entire class of bug where
// the right moment came and went while nothing was listening.
//
// WHY A REF HOLDS THE STATE. Two attempts must never start for one round, and React 18's StrictMode
// double-invokes effects specifically to catch code that assumes otherwise. State set with
// `useState` is not visible to a second synchronous call in the same tick, so the guard would not
// hold; a ref is. The ref IS the state — `force` only asks React to repaint what the ref now says —
// so there is still exactly one source of truth, and the double-invoke is a genuine no-op rather
// than one that merely looks like one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SENDER IS `enterUnattended`, AND THIS HOOK CANNOT REACH ANY OTHER. That is the whole of the
// safety model arriving here, and it is worth being exact about what changed and why.
//
// This file used to call the page's ordinary `enter`, which routes through `runSigned`. `runSigned`
// is right for a player who has just pressed a button: when the chain refuses a session-signed
// deposit it REPLACES the session and sends again. Replacing a session is revoke-then-create — two
// Phantom approvals — and a play session lapses on a schedule, so the consequence was two dialogs
// raised at an empty chair, every round, for as long as the tab stayed open. `autoPolicy.ts`'s
// header is the full account. What lands here is the correction: the only sender this hook is given
// is one that cannot open a session, cannot renew one, and cannot fall back to a wallet signature.
//
// AND IT ENTERS, NEVER EXTRACTS (`SOCIAL.md` §5, §1.1 — a hard rule). The callback this hook holds
// takes a side and a stake, which is what an entry is; there is no shape in this file that could
// describe an extraction, and there must never be one. `enter` is a rule, decided in advance, and it
// loses nothing by being automatic. `extract` is a judgement made under time pressure against a live
// fight, racing whoever settles the round, and it is where the money actually is — so the absent
// player gets the default outcome and the present one gets the decision.
//
// ONE ERROR PER LOST ROUND, WHICHEVER PATH LOSES IT. That promise was made in this file's comments
// long before it was true: a round could be written off in three different places and only two of
// them said so. `lostRound` below is now the single place that notices, so the promise is kept by
// construction rather than by three call sites remembering. See its own note for which path was
// silent and why it was the one that mattered.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  entriesOpen,
  usd,
  usdToUnits,
  type FeeRate,
  type LiveRound,
  type RoundSummary,
  type Side,
} from "../contract.ts";
import {
  INITIAL_AUTO_DEPLOY,
  abandonText,
  abandonAttempt,
  arm as armState,
  armWith as armWithState,
  attemptFailed,
  attemptLanded,
  beginAttempt,
  bookRunPnl,
  decideAutoDeploy,
  disarm as disarmState,
  expireStaleAttempt,
  holdText,
  noteDeploy as noteDeployState,
  noteRoundEntered,
  noteSessionRefused,
  resolveAmountUsd,
  setLimits as setLimitsState,
  setRule as setRuleState,
  type AmountRule,
  type AutoDeployAttempt,
  type AutoDeployHandle,
  type AutoDeployState,
} from "./autoDeploy.ts";
import {
  isUnattendedRefusal,
  readRunPnl,
  runway as runwayOf,
  tallyReport,
  type AutoLimits,
  type Strategy,
  type UnattendedSigning,
} from "./autoPolicy.ts";
import type { ToastKind } from "./types.ts";
import { classifyWalletError } from "./walletFault.ts";

/** How often the rule is re-asked while armed. See this file's header for why it is a clock at all.
 *  One second is well under the shortest lobby the program allows (`MIN_LOBBY_SECONDS`, 30s) and well
 *  over the cost of a pure function over eight primitives. */
const EVALUATE_MS = 1000;

// ---------------------------------------------------------------------------------------------
// The decisions, kept pure so they can be proved
// ---------------------------------------------------------------------------------------------

/** What a failed unattended send means for the round it was sent into. */
export type SendFailure =
  /** The chain refused the deposit because the session signing it is gone. Terminal for this round:
   *  a second attempt is a second certain refusal, and the recovery costs two approvals nobody is
   *  here to give. */
  | "session-lapsed"
  /** Anything else. Another go inside the same lobby might work, so it gets one. */
  | "retry";

/**
 * WHY THE SEND FAILED, IN THE ONLY TWO TERMS THIS RULE CAN ACT ON.
 *
 * THE SESSION CASE IS THE WHOLE POINT OF THIS FUNCTION, and treating it as an ordinary failure is
 * the defect it closes: three retries into a dead session buys three identical refusals, each one a
 * real devnet fee, to learn a fact the first one already established. It is answered by
 * `noteSessionRefused`, which ends the round AND latches the refusal, so the rounds after it cost
 * nothing at all.
 *
 * IT CLASSIFIES THE MESSAGE `useActions` PRODUCES, NOT ONLY THE CHAIN'S. A session refusal reaches
 * this page as `InvalidToken` and is rewritten by `useActions`'s `rethrow` into the sentence a
 * player reads. `classifyWalletError` is total over both — it matches the rewritten copy as well as
 * the raw error — and `useAutoDeploy.test.ts` pins that round trip, because the coupling is real and
 * would otherwise be broken by an innocent edit to a paragraph of copy.
 *
 * A REFUSAL TO SEND IS NOT A FAILED SEND, and it is called out here even though it lands on the same
 * arm. `runUnattendedEntry` throws when the plan it is handed would cost an approval, which means
 * NOTHING WAS SENT and nothing was spent — so the round has not been damaged and there is nothing to
 * report. `retry` is the right answer for it: the ladder asks how the deposit would be signed BEFORE
 * anything can write a round off, so the next evaluation holds on that reason and says so, and the
 * round is never abandoned for a failure that never happened.
 */
export function classifySendFailure(e: unknown): SendFailure {
  if (isUnattendedRefusal(e)) return "retry";
  return classifyWalletError(e).code === "session-expired" ? "session-lapsed" : "retry";
}

/**
 * THE ROUND THIS TRANSITION JUST WROTE OFF, or null if it wrote none off.
 *
 * IT EXISTS BECAUSE "ONE ERROR PER LOST ROUND, ALWAYS" WAS NOT TRUE. A round can be abandoned by
 * three different paths — the decision ladder returning `abandon`, `noteSessionRefused` ending a
 * round on a lapsed session, and `expireStaleAttempt` closing the books on a round the chain has
 * moved past — and only the first of them used to say anything. The silent one was the one that
 * mattered most: `round-moved-on` is produced by `expireStaleAttempt` and by nothing else, and its
 * realistic trigger is precisely the case this whole feature exists for — a suspended or
 * backgrounded tab that wakes up several rounds later. So the rounds lost while nobody was watching
 * were exactly the rounds nobody was ever told about.
 *
 * ASKED OF THE TRANSITION RATHER THAN OF THE CALL SITE, so a fourth path added later is reported
 * without anybody remembering to report it. The comparison is on the round AND the outcome: a state
 * that already carried an abandoned round 41 and still does has lost nothing new, while a fresh
 * abandonment of round 42 has.
 */
export function lostRound(before: AutoDeployState, after: AutoDeployState): AutoDeployAttempt | null {
  const lost = after.attempt;
  if (lost === null || lost.outcome !== "abandoned") return null;
  const prior = before.attempt;
  if (prior !== null && prior.roundNo === lost.roundNo && prior.outcome === "abandoned") return null;
  return lost;
}

/** The sentence a lost round gets, in one place because it is said from one place. `abandonText`
 *  owns the reason; this owns the frame around it. */
export function lostRoundText(attempt: AutoDeployAttempt): string {
  return `Repeat missed round ${attempt.roundNo} — ${abandonText(attempt.abandonedBecause, attempt.error)}`;
}

/** The chain's own words where there are any. `String(e)` on a plain object yields "[object Object]",
 *  which is not text and would end up quoted back to a player as the reason a round was missed —
 *  `walletFault.ts` records the same lesson at length. */
function messageOf(e: unknown): string {
  if (e instanceof Error && e.message.trim() !== "") return e.message;
  return classifyWalletError(e).short;
}

/**
 * WHAT ONE UNATTENDED SEND DID TO THE RUN — the whole fork, as a plain function of stated inputs.
 *
 * IT IS OUT HERE RATHER THAN INSIDE THE EFFECT because it is the most consequential decision in this
 * file and it was the one thing left unprovable: `classifySendFailure` could be tested, but what it
 * was WIRED to could not, and the wiring is where the money is. It takes the epoch and the round as
 * arguments for the same reason — they are captured at send time by the caller, and a function that
 * re-read them would re-introduce exactly the staleness they are captured to avoid.
 *
 * THE EPOCH IS THE ONE THAT WAS LIVE WHEN THE TRANSACTION WENT OUT, not the one live now, and the
 * difference is a run that dies holding a working key. A refused deposit latches "the session that
 * refused this" — but a player pressing Start while the refusal is still in flight opens a NEW
 * session and advances the count, and latching THAT would tell the rule its brand-new session was
 * already dead. Latching the captured one instead simply never matches, so the hold never engages,
 * which is the correct outcome for a lapse that has already been repaired.
 *
 * A LAPSE IS NOT A RETRY. Every other failure earns another go inside the same lobby because another
 * go might work; this one cannot — the session is gone for the rest of its life, so a second attempt
 * is a second certain refusal, and the recovery a watching player would get costs two Phantom
 * approvals nobody is here to give. The round ends, the lapse is latched, and the rounds after it
 * cost nothing at all until a fresh session is opened.
 */
/**
 * HAS THE ACCOUNT UNDER THIS RUN BEEN SWAPPED FOR A DIFFERENT ONE?
 *
 * A PLAIN FUNCTION FOR THE REASON EVERYTHING ELSE IN THIS SECTION IS ONE: the effect that acts on it
 * cannot be exercised — this project's devDependencies are vitest, oxlint and typescript, and there
 * is no React harness — so a rule that lived only inside the effect would be a rule nothing could
 * ever assert. The consequence of getting it wrong is a run whose books belong to somebody else, so
 * it is the last decision here that should be unprovable.
 *
 * A DISCONNECT IS NOT A SWITCH. `""` is how this page spells "nobody" (`ArenaContextValue.you`), and
 * a wallet that drops and reconnects is the same player with the same books — the run holds
 * harmlessly on `no-signer` in between and picks up where it was. Treating that as a switch would
 * end a perfectly good overnight run on one dropped provider event, which is the same class of
 * mistake as gating on a clock nobody can read.
 */
export function walletSwapped(previous: string, next: string): boolean {
  return previous !== "" && next !== "" && previous !== next;
}

/**
 * A DEPOSIT CONFIRMED ON THIS PAGE — from any surface, by any means — as the rule should record it.
 *
 * TWO THINGS, and the second is where a shipped defect lived. The side is what a repeat follows, and
 * it is set unconditionally: every confirmed deposit is evidence of which side this browser plays.
 * The ROUND is marked as had, so that a player who deploys by hand at the top of a lobby does not
 * get a second, automatic deposit landing on top of theirs in the second before the roster poll
 * catches up.
 *
 * IT STANDS ASIDE WHILE THE RULE'S OWN TRANSACTION IS IN FLIGHT, and that is the fix. This runs from
 * the page-wide confirmed-enter callback, which fires BEFORE `attemptLanded` for the rule's own
 * deposit. When the two disagreed about the round — which they do whenever a confirmation outlives
 * the round it entered — `noteRoundEntered` overwrote the single attempt slot first, `attemptLanded`
 * then found a record for a different round and returned the state UNCHANGED (see its guard), and
 * `tallyEntered` never ran. A confirmed, paid-for deposit was never charged against `budgetUsd`,
 * while the toast beside it said "Repeat deployed $25 into round 42" and the run's own statement
 * said $0.00 into 0 rounds. That is the double-booking `tallyEntered`'s cursor exists to prevent,
 * defeated from outside it.
 *
 * Standing aside costs nothing: `attemptLanded` is about to book the same round with the amount the
 * transaction actually carried, and `decideAutoDeploy` is already holding on `sending`, so the second
 * deposit this guard protects against cannot be sent either way.
 *
 * `roundNo` MUST BE THE ROUND THE TRANSACTION WAS WRITTEN TO — `targetRoundNo`, which `roundPda` is
 * derived from — and not the round the poll last read. Null where no round is knowable, in which
 * case only the side is recorded.
 */
export function bookConfirmedDeposit(
  state: AutoDeployState,
  side: Side,
  roundNo: bigint | null,
): AutoDeployState {
  const withSide = noteDeployState(state, side);
  if (roundNo === null || state.attempt?.outcome === "sending") return withSide;
  return noteRoundEntered(withSide, roundNo);
}

export function applySendOutcome(
  state: AutoDeployState,
  outcome: {
    roundNo: bigint;
    /** What the transaction actually carried, not what the rule would resolve to now — the tally is
     *  what the budget is enforced against. */
    amountUsd: number;
    sessionEpochAtSend: number;
    /** The account that sent it, captured beside the epoch and for the same reason: a confirmation
     *  outlives the render it started in, and the run's P&L belongs to whoever actually paid. */
    walletAtSend: string;
    /** Set exactly when it confirmed; `error` is what it failed with otherwise. */
    signature: string | null;
    error: unknown;
    nowMs: number;
  },
): AutoDeployState {
  if (outcome.signature !== null) {
    return attemptLanded(state, outcome.roundNo, outcome.signature, outcome.amountUsd, outcome.walletAtSend);
  }
  if (classifySendFailure(outcome.error) === "session-lapsed") {
    return noteSessionRefused(state, outcome.roundNo, outcome.sessionEpochAtSend);
  }
  return attemptFailed(state, outcome.roundNo, messageOf(outcome.error), outcome.nowMs);
}

// WHERE THE RUN'S P&L USED TO BE COMPUTED, AND WHY THERE IS NOTHING HERE NOW.
//
// This file held `runPnlUsd`: given the round log, this player's key and the run's first round, sum
// the player's `pnl` over `[sinceRound, newest]` and return null unless the log covered that span
// with no hole in it. Both of its rules were right. Refusing on a hole is right because `scanRoundLog`
// drops a rate-limited fetch and reports the partial read as a success, so one 429 on the wrong batch
// would have made a run read as less down than it was and the drawdown stop would have quietly
// stopped binding. Refusing to read an unknown P&L as no loss is right for the same reason.
//
// The defect was that the log is a WINDOW — the chain keeps about `MIN_RETAINED_ROUNDS` — so a run
// that lasted more than half an hour could no longer be measured over its own span at all. Against a
// caught-up keeper that is roughly twenty rounds; with the default drawdown stop set, every overnight
// run this feature exists for stopped after about thirty minutes, silently, with a status line a
// player could not tell from a working pause. Two correct functions, meeting.
//
// A run's realised P&L is a RUNNING TOTAL, not a re-derivation from a source that forgets. It now
// lives in `autoPolicy.ts` as `RunPnl` — accumulated by `bookRunPnl` as the rounds the run entered
// settle, read by `readRunPnl`, and owned by the same module that enforces the limit it feeds. What
// this file keeps is the wiring: call the transition on the same clock everything else here runs on,
// and hand the decision the log rather than a figure derived from it.

// ---------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------

export interface AutoDeployParams {
  live: LiveRound | null;
  /** The round `enter()` would actually write to — the PDA the chain layer has resolved, which lags
   *  or leads `live.roundNo` by up to one poll when a new round opens. The rule refuses to act while
   *  the two disagree; see `decideAutoDeploy`'s `round-changing`. */
  targetRoundNo: bigint | null;
  /** A deposit is in flight from any surface on the page. */
  entering: boolean;
  /**
   * THE ONLY WAY THIS HOOK CAN SPEND MONEY, and the narrowest callback that can do the job.
   *
   * It is `useActions`' `enterUnattended`, never its `enter`: the difference is that this one cannot
   * open a session, renew one, or fall back to a wallet signature, which is the entire safety model
   * (see this file's header and `autoPolicy.ts`). It takes a side and a stake because that is what
   * an entry is — an extraction names a fighter and a moment and cannot be expressed through this
   * signature, which is how "never ship auto-extract" is kept by the compiler rather than by memory.
   */
  enterUnattended(side: Side, stakeUnits: bigint): Promise<string>;
  /** The simulated bankroll a percentage rule is a percentage OF. Simulated, and labelled as such
   *  everywhere it is shown — see `AmountRule`. */
  simWalletUsd: number;
  /** `unattendedSigning(plan)` — could the next deposit be signed with nobody watching, and if not,
   *  why. The INFERENCE half of the two layers; `sessionEpoch` carries the authoritative half. */
  signing: UnattendedSigning;
  /** How many sessions this tab has successfully opened — see `ArenaContextValue.session.epoch` for
   *  why the latch is keyed on a count and not on the session's own address. */
  sessionEpoch: number;
  /** Minutes left on the session, or null when this tab has no record of when it began. Advisory,
   *  and it reaches only the runway's copy — nothing is ever gated on it (`sessionExpiry.ts`). */
  sessionMinutesLeft: number | null;
  /** THE LIVE RATE, off the Arena account — never `FEE_BPS`. A projection of somebody's whole night
   *  computed against a build-time copy of a rate the authority can move mid-round is the same
   *  defect `FEE_BPS`'s own comment records, with a night's worth of money behind it. */
  fee: FeeRate;
  /** The round log — the BACKFILL for the run's P&L, never the source of it. What has already
   *  settled is in `AutoDeployState.pnl` and is not re-read; this answers for the rounds that have
   *  settled since the last look, which is the one thing a twenty-round window is good for. See
   *  `RunPnl` in `autoPolicy.ts` for the whole argument. */
  roundLog: RoundSummary[];
  /** `""` when nobody is connected. Only used to find this player's rows in the log. */
  youPubkey: string;
  push(text: string, kind?: ToastKind): void;
}

export function useAutoDeploy(params: AutoDeployParams): AutoDeployHandle {
  // The ref is the state; see the header. `version` exists only to repaint.
  const stateRef = useRef<AutoDeployState>(INITIAL_AUTO_DEPLOY);
  const [version, force] = useState(0);

  const commit = useCallback((next: AutoDeployState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    force((n) => n + 1);
  }, []);

  // Everything the rule reads, kept current without making it an effect dependency — the effect
  // restarts on arm/disarm and nothing else, so a poll landing mid-second cannot tear the interval
  // down and rebuild it.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  /** Commit a transition and, if it wrote a round off, say so — exactly once. Every path that can
   *  lose a round goes through here; see `lostRound` for why that is a fix rather than a tidy-up. */
  const commitLosing = useCallback(
    (next: AutoDeployState) => {
      const lost = lostRound(stateRef.current, next);
      commit(next);
      if (lost !== null) paramsRef.current.push(lostRoundText(lost), "error");
    },
    [commit],
  );

  const state = stateRef.current;

  const arm = useCallback(
    (rule: AmountRule) => {
      commit(
        armState(stateRef.current, {
          rule,
          visibleRoundNo: paramsRef.current.live?.roundNo ?? null,
          nowMs: Date.now(),
        }),
      );
    },
    [commit],
  );
  const armWith = useCallback(
    (strategy: Strategy, limits: AutoLimits) => {
      commit(
        armWithState(stateRef.current, {
          strategy,
          limits,
          visibleRoundNo: paramsRef.current.live?.roundNo ?? null,
          nowMs: Date.now(),
        }),
      );
    },
    [commit],
  );
  const disarm = useCallback(() => commit(disarmState(stateRef.current)), [commit]);
  const setRule = useCallback((rule: AmountRule) => commit(setRuleState(stateRef.current, rule)), [commit]);
  const setLimits = useCallback(
    (limits: AutoLimits) => commit(setLimitsState(stateRef.current, limits)),
    [commit],
  );
  // Called from the confirmed-enter path for EVERY deposit on the page. It records two things, and
  // the second one is not decoration: which side to follow next time, and that THIS round has now had
  // a deposit. Without the second, a player who deploys by hand at the top of a lobby gets a second,
  // automatic deposit landing on top of theirs in the second before the roster poll catches up.
  //
  // WHAT REACHES IT IS THE PROVIDER'S BUSINESS, and it got that wrong once in a way worth naming
  // here: a deploy on the FIXTURE was wired to this, so a press on invented data configured the rule
  // that spends real money. See `ArenaProvider.tsx`'s `useOnEntered`. This callback is right to be
  // total over "every confirmed deposit"; the fix belonged at the wiring.
  //
  // THE ROUND IS HANDED IN, AND THAT IS THE CORRECTION. Every deposit on this page is written to
  // `roundPda`, which is derived from the round the write path was targeting WHEN IT SENT;
  // `live.roundNo` is whatever the round poll last FETCHED, and it lags by up to a poll whenever a
  // new round opens. Reading the round back off the poll on the far side of a confirmation credited a
  // real deposit to a round it never touched — and `decideAutoDeploy` refuses to FIRE in that window
  // (`round-changing`) while nothing stopped this from BOOKING in it.
  //
  // AN EARLIER TURN THAT WAS ONLY HALF RIGHT, recorded rather than quietly replaced. This callback
  // took a side alone and derived the round itself, from `params.targetRoundNo` falling back to
  // `live.roundNo`. That fixed the AUTOMATIC path, because a rule that is mid-send holds the round in
  // its own attempt slot — but it could not fix the manual one: a hand deposit that confirms after
  // its round has closed reads a `targetRoundNo` that has already moved on, and was booked against
  // the new round. The number that was actually correct lived in `useActions`' `targetRoundNoRef`,
  // captured at send time, and the only thing stopping it being handed over was
  // `AutoDeployHandle.noteDeploy`'s signature. That signature is now `(side, roundNo)`, so the round
  // travels with the deposit that earned it and nothing on this side derives anything.
  //
  // What it then DOES with that round is `bookConfirmedDeposit`'s business, and the guard it applies
  // — standing aside while the rule's own transaction is in flight — is the money half.
  const noteDeploy = useCallback(
    (side: Side, roundNo: bigint | null) => {
      commit(bookConfirmedDeposit(stateRef.current, side, roundNo));
    },
    [commit],
  );

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // A DIFFERENT WALLET INHERITS NOTHING — the same principle `useSessionController` applies to the
  // session, applied to the run, and it is a correctness rule rather than a courtesy.
  //
  // `ChainArena` does not remount when Phantom's account changes: `youPubkey` simply becomes a
  // different non-empty string while this hook keeps every byte of its state. An armed run would
  // carry straight on under the new account with the OLD account's books — a budget already spent by
  // somebody else, a side learned from somebody else's deposit, and worst of all a running P&L whose
  // settled total was accumulated for a wallet that is no longer playing. That last one is not
  // merely stale, it is silently wrong in the dangerous direction: `bookSettledRounds` would find the
  // run's outstanding round present and final, see no row for the NEW wallet, book it as zero, and
  // advance the cursor past a real loss. Permanently, because a booked round is never revisited. Of
  // all the ways this figure could read a loss as no loss, that is the only one that cannot correct
  // itself, so it is closed here at the source rather than patched downstream.
  //
  // A DISCONNECT IS NOT A SWITCH, and the two are deliberately treated differently. `""` is how this
  // page spells "nobody"; a wallet that drops and comes back is the SAME player and the same books,
  // and the run holds harmlessly on `no-signer` in between. Only an arrival at a different non-empty
  // key ends the run — and it ends it by disarming rather than by editing the books, because arming
  // is what resets them and arming is a press the new player has not made.
  const runWalletRef = useRef(params.youPubkey);
  useEffect(() => {
    const previous = runWalletRef.current;
    runWalletRef.current = params.youPubkey;
    if (!walletSwapped(previous, params.youPubkey)) return;
    if (!stateRef.current.armed) return;
    commit(disarmState(stateRef.current));
    // SAID OUT LOUD, because a run stopping is exactly the class of event this feature has promised
    // never to let happen in silence — and a player who switched accounts has no reason to guess that
    // it did.
    paramsRef.current.push(
      "Auto-deploy stopped because you switched wallets — a run's budget and its profit and loss " +
        "belong to the account that armed it. Arm it again to start a fresh run on this one.",
      "info",
    );
  }, [params.youPubkey, commit]);
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!state.armed) return;

    const evaluate = () => {
      const p = paramsRef.current;
      // THE ACCOUNT CHANGED AND THE RUN HAS NOT BEEN STOPPED YET. `paramsRef` is assigned during
      // RENDER while the effect that disarms on a wallet swap is passive and flushes on a later
      // task, and this interval is synchronised with neither — so there is a window in which a tick
      // fires holding the new key and a run that is still armed. It is not harmless: `useHistory`
      // keeps the OLD `rounds` array until its refetch resolves, so the run's outstanding round is
      // still present and still final in the log, and `bookSettledRounds` would book it as zero
      // under a wallet that has no row in it and advance the cursor past it. A booked round is never
      // revisited, so that is the one mis-booking in this design that cannot heal.
      //
      // `RunPnl.wallet` refuses the same booking from inside the register, and this line is not
      // therefore redundant: that one keeps the FIGURE honest, this one keeps the tick from acting at
      // all — including sending a deposit — on behalf of a run whose owner has just left. Two cheap
      // guards on a window narrow enough that no test will ever find it is the right number.
      // `runWalletRef` is written inside the effect, so until it flushes this still reads the old key.
      if (p.youPubkey !== runWalletRef.current) return;
      const nowMs = Date.now();
      const roundNo = p.live?.roundNo ?? null;

      // Close the books on anything the chain has already moved past, so no round is ever silently
      // dropped between one round number and the next — and say so when it happens, which is the
      // half this used to be missing.
      commitLosing(expireStaleAttempt(stateRef.current, roundNo));
      // AND ON EVERY ROUND THE CHAIN HAS FINISHED. Same idea, other ledger: a settled round's outcome
      // is final and the chain reclaims the record about twenty rounds later, so it is taken now and
      // kept. A no-op returns the same object, so on the great majority of ticks — nothing new has
      // settled — this commits nothing and repaints nothing.
      commit(bookRunPnl(stateRef.current, p.roundLog, p.youPubkey));

      const decision = decideAutoDeploy({
        state: stateRef.current,
        roundNo,
        targetRoundNo: p.targetRoundNo,
        phase: p.live?.phase ?? null,
        entriesOpen: entriesOpen(p.live, nowMs),
        alreadyIn: (p.live?.fighters ?? []).some((f) => f.isYou),
        entering: p.entering,
        amountUsd: resolveAmountUsd(stateRef.current.rule, p.simWalletUsd),
        signing: p.signing,
        sessionEpoch: p.sessionEpoch,
        roundLog: p.roundLog,
        youPubkey: p.youPubkey,
        nowMs,
      });

      if (decision.kind === "hold") return;

      if (decision.kind === "abandon") {
        commitLosing(abandonAttempt(stateRef.current, decision.roundNo, decision.reason));
        return;
      }

      // Marked as sending BEFORE the await, synchronously, on the ref — a second evaluation in the
      // same tick (StrictMode's double invoke, or a 1s timer landing on top of one) sees it and
      // holds. Unlike the version this replaces, this is a claim about a transaction that IS in
      // flight, not a claim that the round is finished with.
      const { roundNo: target, side, amountUsd } = decision;
      // THE EPOCH AS IT IS RIGHT NOW, captured beside the round and for the same reason. If this
      // transaction is refused, what must be latched is the session that was refused — and a press
      // on Start while the refusal was in flight would otherwise have this latch the FRESH session
      // instead, killing an auto-deploy run with a perfectly good session key in hand. A captured
      // epoch that no longer matches simply never blocks anything, which is the correct outcome.
      const sessionEpochAtSend = p.sessionEpoch;
      // AND THE ACCOUNT, for the same reason and at the same instant. If this deposit confirms after
      // the player has switched wallets, what it proves is what the OLD account spent — booking it
      // under whoever happens to be connected by then would put one player's round into another
      // player's ledger. See `RunPnl.wallet`.
      const walletAtSend = p.youPubkey;
      commit(beginAttempt(stateRef.current, target));

      // BOTH ARMS GO THROUGH ONE FUNCTION, and through `commitLosing`, so that a round this send
      // ends is reported by the same path as a round the ladder ends. `applySendOutcome` owns every
      // judgement about what happened; what is left here is the toast for the one outcome that is
      // not a loss.
      const settle = (signature: string | null, error: unknown) => {
        commitLosing(
          applySendOutcome(stateRef.current, {
            roundNo: target,
            amountUsd,
            sessionEpochAtSend,
            walletAtSend,
            signature,
            error,
            nowMs: Date.now(),
          }),
        );
      };
      void p.enterUnattended(side, usdToUnits(amountUsd)).then(
        (signature) => {
          settle(signature, null);
          p.push(`Repeat deployed ${usd(usdToUnits(amountUsd))} into round ${target}`, side === 0 ? "a" : "b");
        },
        (e: unknown) => settle(null, e),
      );
    };

    evaluate();
    const id = setInterval(evaluate, EVALUATE_MS);
    return () => clearInterval(id);
  }, [state.armed, commit, commitLosing]);

  const nextAmountUsd = resolveAmountUsd(state.rule, params.simWalletUsd);

  // Recomputed rather than remembered from the last evaluation: the panel must describe the state of
  // the world at THIS render, not at the last tick of a one-second timer.
  const roundNo = params.live?.roundNo ?? null;
  const renderNowMs = Date.now();
  // READ ONCE AND USED TWICE — by the ladder, through `decideAutoDeploy`'s own call, and by the
  // sentence below. They are the same pure function of the same three inputs, so the figure being
  // enforced and the figure being described cannot come apart; computing it here as well is what
  // lets `holdText` tell an unreadable ledger from an unrecoverable one without the reason enum
  // having to carry the difference. See `LimitBlock`'s note for why it does not.
  const pnl = readRunPnl(state.pnl, params.roundLog, params.youPubkey);
  const decision = decideAutoDeploy({
    state,
    roundNo,
    targetRoundNo: params.targetRoundNo,
    phase: params.live?.phase ?? null,
    entriesOpen: entriesOpen(params.live, renderNowMs),
    alreadyIn: (params.live?.fighters ?? []).some((f) => f.isYou),
    entering: params.entering,
    amountUsd: nextAmountUsd,
    signing: params.signing,
    sessionEpoch: params.sessionEpoch,
    // THE SAME READ THE TIMER MAKES, AND SIDE-EFFECT FREE FOR THAT REASON. A render may land between
    // a round settling and the tick that books it; `readRunPnl` adds the readable-but-unbooked rounds
    // transiently, so the figure this paints and the figure the rule enforces are the same number
    // either side of that moment.
    roundLog: params.roundLog,
    youPubkey: params.youPubkey,
    nowMs: renderNowMs,
  });
  const hold = decision.kind === "hold" ? decision.reason : null;

  // EVERY VERDICT GETS ITS OWN TRUE SENTENCE, including the two that only exist for an instant. A
  // render can land between the timer's tick and the state it produces, and defaulting those two to
  // "Depositing…" would put a sentence about spending money on screen at the exact moment the rule
  // had decided NOT to spend any.
  const status =
    decision.kind === "hold"
      ? holdText(decision.reason, state, roundNo, pnl)
      : decision.kind === "fire"
        ? `Depositing into round ${decision.roundNo}…`
        : `Round ${decision.roundNo} was not entered — ${abandonText(decision.reason, state.attempt?.error ?? null)}`;

  const report = tallyReport(state.tally, renderNowMs);
  // HOW FAR THIS CAN GO, priced at what the next deposit would actually send and at the arena's
  // CURRENT rate. `nextAmountUsd` is the same figure the panel prints, so the projection and the
  // number beside it can never disagree; null means the rule cannot name an amount at all, which
  // makes every bound below it zero rounds — which is the honest projection of a rule that would
  // deposit nothing.
  //
  // MEMOISED ON ITS INPUTS, unlike `status` and `report` beside it: those two are strings and
  // compare by value, while this is a fresh object literal that would change identity on every
  // render and take the handle's own memo down with it. That memo does NOT stop the context from
  // churning — `ArenaProvider` rebuilds `value` as an object literal every render regardless — so
  // what it buys is a stable `autoDeploy` for consumers that hold or compare it, which is worth the
  // one line and is not worth overstating.
  const runway = useMemo(
    () =>
      runwayOf({
        stakeUsd: nextAmountUsd ?? 0,
        fee: params.fee,
        limits: state.limits,
        tally: state.tally,
        sessionMinutesLeft: params.sessionMinutesLeft,
      }),
    [nextAmountUsd, params.fee, state.limits, state.tally, params.sessionMinutesLeft],
  );

  return useMemo<AutoDeployHandle>(
    () => ({
      armed: state.armed,
      side: state.side,
      rule: state.rule,
      nextAmountUsd,
      firesFromRound: state.floorRound === null ? null : state.floorRound + 1n,
      status,
      hold,
      attempt: state.attempt,
      limits: state.limits,
      tally: state.tally,
      report,
      runway,
      arm,
      armWith,
      disarm,
      setRule,
      setLimits,
      noteDeploy,
    }),
    // `version` is the ref's change signal — see the header. It is a real dependency of everything
    // read off `state` below it, and the linter cannot see that through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, state, nextAmountUsd, status, hold, report, runway, arm, armWith, disarm, setRule, setLimits, noteDeploy],
  );
}
