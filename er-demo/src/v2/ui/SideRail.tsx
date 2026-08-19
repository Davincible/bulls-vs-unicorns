// The right-hand rail: one column, two tenants — the wallet/session panel and the fighter
// inspector. See the note in shell.css for why there is only one of them.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import {
  SIDE_TOKEN,
  STAKE_PRESETS,
  shortKey,
  TOKENS,
  usd,
  usdCompact,
  usdCompactSigned,
  usdToUnits,
  worth,
  type TokenKey,
} from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { useLinks } from "../data/useLinks.ts";
import { namePlate, plateText } from "../data/namePlate.ts";
import { ASSUMED_SESSION_TOP_UP_SOL, sessionPanelNote, sessionStatus } from "../data/autoSession.ts";
import { runwayNote, type AutoLimits } from "../data/autoPolicy.ts";
import type { HoldReason } from "../data/autoDeploy.ts";
import type { ToastKind } from "../data/types.ts";
import { ASSUMED_SESSION_MINUTES, type SessionLife } from "../data/sessionExpiry.ts";
import { CombatLog } from "./CombatLog.tsx";
import { ConnectPanel, XLinkPanel } from "./ConnectPanel.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { PaperTheme } from "./PaperTheme.tsx";
import { Bar, Dash, Mark, Seg, Tag } from "./primitives.tsx";
import { feeNote } from "../views/feeCopy.ts";
import { coverageFigure, coverageNote, coveragePhrase } from "../views/coverage.ts";
import { useShell, type Rail } from "./shell.ts";
import { useFocusTrap } from "./useFocusTrap.ts";
import { useFullscreenTarget } from "./useFullscreenTarget.ts";
import { NARROW, useMediaQuery } from "./useMediaQuery.ts";

/** The width at which `shell.css` takes `.rail` to `width: 100vw`. Below it the rail is not a panel
 *  beside the page, it IS the page — which is the only condition under which containing the keyboard
 *  inside it is honest. Same break as every other layout decision on this page. */

/** Simulated balances are plain numbers, not chain units — but they must still be FORMATTED by the
 *  one shared money formatter, or two panels end up disagreeing about what "$5" looks like. Compact:
 *  the rail is 420px wide and these grow without a ceiling — "+ $100 & $100" is one button press
 *  away, repeatable forever, and a balance sheet that has absorbed a hundred top-ups is not a
 *  hypothetical here the way a fixed on-chain stake is. */
function simUsd(amount: number): string {
  return usdCompact(usdToUnits(amount));
}

function Block({ title, tools, children }: { title: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <div className="blk">
      <div className="blk-h">
        <span className="u u--ink">{title}</span>
        {tools ? <span className="push">{tools}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span className="u fact-n">{name}</span>
      <span className="fact-v num">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tenant 1 — wallet, session, and the simulated cashier
// ---------------------------------------------------------------------------------------------

/**
 * A SPAN OF MINUTES, IN WORDS THAT STAY SENSIBLE AT ANY SCALE — because the scale moves underneath
 * this file and has already moved once.
 *
 * THE DEFECT IT FIXES, verbatim from the line below it: `roughly ${life.minutesLeft} minutes left`.
 * That was written when a play session was short enough for minutes to be the unit anybody would
 * think in, and it read perfectly. The session's length is a private const this workstream does not
 * own (`sessionExpiry.ts` is the single mirror of it and explains why); it then grew by more than an
 * order of magnitude, and the same sentence started printing a four-figure minute count —
 * arithmetically true, useless to read, and the exact shape of copy that survives the change that
 * invalidates it because nobody re-reads a working sentence.
 *
 * So no unit is chosen here in advance: minutes while minutes are the unit somebody thinks in, hours
 * past that, days past that. It takes minutes because that is what `SessionLife` counts in, and it
 * commits to no period at all, which is the property that has to hold whatever the constant becomes
 * next. Everything it produces is approximate — it is rendering an inference, not a deadline.
 */
function spanOfMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return "under a minute";
  if (m < 120) return `${m} ${m === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(m / 60);
  if (hours < 48) return `about ${hours} hours`;
  const days = Math.round(hours / 24);
  return `about ${days} ${days === 1 ? "day" : "days"}`;
}

/** HOW LONG THE SESSION HAS LEFT, in words — every one of them hedged, and none of them a deadline.
 *
 *  `sessionExpiry.ts` counts forward from a MIRRORED constant (the length lives as a private const in
 *  `chain/session/useSessionKeyManager.ts`), so this is an inference and is written as one. Nothing
 *  here is an instruction any more: a lapsed session is replaced by the next move on its own (see
 *  `autoSession.ts`'s `afterRefusal`). It is here so a player who opens this panel can SEE what is
 *  signing for them and roughly how long it has, not so they can be told to go and fix something.
 *
 *  NO SENTENCE HERE NAMES A PERIOD, and that is a rule rather than a preference — see `spanOfMinutes`
 *  for the incident. "Past its hour" was the other half of the same defect and is now "past its
 *  expiry": it was a claim about a constant this file does not own, printed as a fact.
 *
 *  `{ known: false }` is a real and common answer, not an error: a session restored from a previous
 *  visit has no local record of when it began. Saying so beats inventing a clock. */
function sessionAge(life: SessionLife): string {
  if (!life.known) {
    return "Started in an earlier visit, so its age is unknown here. If the chain refuses a move on it, the next move replaces it — you do not have to do anything.";
  }
  if (life.lapsed) {
    return "Probably past its expiry. It may still work — the chain decides, not this page — and if the chain refuses it, the next move replaces it for you.";
  }
  const elapsed = Math.max(0, ASSUMED_SESSION_MINUTES - life.minutesLeft);
  // `minutesLeft` is rounded up, so the first minute of a session reported "Started about 0 minutes
  // ago" — a number doing no work in a sentence that reads better without it.
  const age =
    elapsed < 1
      ? `Started just now · roughly ${spanOfMinutes(life.minutesLeft)} left.`
      : `Started about ${spanOfMinutes(elapsed)} ago · roughly ${spanOfMinutes(life.minutesLeft)} left.`;
  // The nudge is a description, not a chore: the renewal happens on the next move whether or not
  // anybody reads this. Worth saying only because it costs two approvals rather than the usual none,
  // and a player who would rather take that between rounds than mid-fight can now choose to.
  return life.lapsing ? `${age} When it runs out the next move replaces it — two approvals.` : age;
}

// ---------------------------------------------------------------------------------------------
// Auto-deploy — the account of a rule that spends money with nobody in the room, and the stops
// ---------------------------------------------------------------------------------------------

/** The budgets offered as one press. Presets rather than a free field for the reason every other
 *  money control on this page is: this is a decision made once, in a 420px column, and a number box
 *  mid-edit is a NaN that `limitBlock` and `clampToLimits` both have to defend against. The list
 *  brackets `DEFAULT_LIMITS.budgetUsd`, which has to be IN it — a Seg whose current value is not one
 *  of its options renders four unpressed buttons and reads as a control with no setting. */
const BUDGET_PRESETS_USD = [50, 100, 250, 500];

/** `null` is a real setting for both of these — "no drawdown stop", "no round ceiling" — and it is
 *  not the same as zero. A 0% drawdown stop means "the moment I am down at all", which `limitBlock`
 *  implements deliberately; a 0 round ceiling would mean a run that may enter no rounds. So the OFF
 *  choice is carried as an id of its own rather than as a sentinel number, and the two conversions
 *  below are the only place the mapping exists. */
const OFF = "off";
const DRAWDOWN_OPTIONS = [
  { id: OFF, label: "Off" },
  { id: "25", label: "25%" },
  { id: "50", label: "50%" },
  { id: "75", label: "75%" },
];
const CEILING_OPTIONS = [
  { id: OFF, label: "None" },
  { id: "10", label: "10" },
  { id: "25", label: "25" },
  { id: "100", label: "100" },
];

function limitId(value: number | null): string {
  return value === null ? OFF : String(value);
}

function limitValue(id: string): number | null {
  return id === OFF ? null : Number(id);
}

/** WHAT THE RULE IS, IN A HEADLINE — the `Status` row, which is a category and never a paraphrase.
 *
 *  `autoDeploy.status` is the sentence, it is already written, and it is already tested next to the
 *  rule that produces it (`holdText`). Nothing here restates it. What a `Fact` row needs and a
 *  paragraph cannot be is the answer at a glance to the one question a player opening this rail is
 *  actually holding: is money still going out, and if it has stopped, is it stopped because it is
 *  between rounds or because it is waiting on me?
 *
 *  EVERY `HoldReason` GETS ITS OWN CASE, ON PURPOSE. Each new one is a new decision about which of
 *  those two a player is in, and quietly filing it under "running" would report a rule that has
 *  STOPPED as one that is merely between rounds — the single most expensive thing this surface could
 *  get wrong.
 *
 *  This comment used to say the switch had no `default` and that "the build fails here instead". The
 *  first half was true and the second was not, which made it worse than saying nothing: it advertised
 *  a guarantee nobody had checked. `tsconfig.app.json` does not set `strict` or `noImplicitReturns`,
 *  so a missing member fell out of the bottom as `undefined` and the caller's `standing.word` threw —
 *  a white screen, of the same class as commit 6d83f0a. There is now a real `default` at the foot of
 *  the switch carrying a `never` assignment, which fails the build for the reason this paragraph
 *  always claimed, plus a runtime fallback for the paths a compiler cannot see.
 *
 *  `sessionHold` exists because of where this block sits. It is directly beneath `Play session`, and
 *  every one of these four reasons is answered by that block — so the copy points at it rather than
 *  describing a panel the reader is already looking at. `no-signer` is deliberately not one of them:
 *  its sentence points at the WALLET, which is a different block again. */
function standingOf(
  armed: boolean,
  hold: HoldReason | null,
): { word: string; sessionHold: boolean } {
  // `hold` is null exactly when a deposit is being sent right now — see `AutoDeployHandle.hold`.
  if (hold === null) return { word: armed ? "DEPOSITING NOW" : "OFF", sessionHold: false };

  switch (hold) {
    case "disarmed":
      return { word: "OFF", sessionHold: false };

    // Between rounds, mid-attempt, or waiting on a poll. Every one of these lifts by itself, with
    // nothing to press and no round lost.
    case "no-round":
    case "round-changing":
    case "waiting-for-next-round":
    case "deployed-this-round":
    case "missed-this-round":
    case "sending":
    case "already-in":
    case "busy":
    case "backing-off":
      return { word: "ARMED AND RUNNING", sessionHold: false };

    // Armed, and nothing will be deposited until something changes that this page cannot change on
    // its own. The sentence under this row names the one press in every case.
    case "no-side":
    case "amount-unusable":
    case "drawdown-stopped":
    case "drawdown-unknown":
    case "budget-spent":
    case "round-ceiling":
    case "no-signer":
      return { word: "ARMED BUT HELD", sessionHold: false };
    case "session-lapsed":
    case "needs-session":
    case "session-stopped":
    case "session-unaffordable":
      return { word: "ARMED BUT HELD", sessionHold: true };
    default: {
      // THE EXHAUSTIVENESS PROMISE ABOVE THIS FUNCTION WAS NOT KEPT, AND THIS IS WHERE IT IS KEPT.
      //
      // The comment claimed "the build fails here instead" for an unhandled `HoldReason`. It did not:
      // `tsconfig.app.json` sets `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly` and
      // `noFallthroughCasesInSwitch`, and deliberately NOT `strict` or `noImplicitReturns` — so a
      // switch that misses a member falls out of the bottom, returns `undefined`, and the caller's
      // `standing.word` throws. That is a WHITE SCREEN, not a wrong label, and it is the same class as
      // commit 6d83f0a where a failed session took the whole app down. An agent adding a
      // twenty-second `HoldReason` this session hit it, backed the member out, and routed around the
      // rail rather than arming the mine further.
      //
      // TWO GUARDS, because they fail at different times and one of them is not enough. The `never`
      // assignment is a COMPILE error the moment a member is added without a case here, and it works
      // without `strict` — assigning a non-`never` to `never` is an error in any mode, which is
      // exactly why this idiom is worth having in a project that has not turned strict on. The
      // returned value is the RUNTIME half, for the paths a compiler cannot see: a stale bundle, a
      // value cast through `any`, a hold string arriving from somewhere this type does not govern.
      //
      // "ARMED BUT HELD" is the honest fallback rather than "OFF". An unknown hold is still a hold —
      // the rule is not running — and telling a player their unattended money-spending rule is OFF
      // when it might not be is the one direction this must never be wrong in.
      const unhandled: never = hold;
      void unhandled;
      return { word: "ARMED BUT HELD", sessionHold: false };
    }
  }
}

/**
 * AUTO-DEPLOY, IN THE ONE PLACE THAT IS ALWAYS REACHABLE.
 *
 * WHY IT IS IN THIS RAIL AT ALL, given that 00-3 already has the full arm control. Because the arm
 * control is four screens down inside one tab, and a rule that spends money unattended has to be
 * answerable and stoppable from wherever the player happens to be standing. The rail is one press
 * from every screen. Everything here is either an ACCOUNT of what the rule did while nobody was
 * watching, or a way to stop it.
 *
 * IT SITS DIRECTLY UNDER `Play session`, AND THAT ADJACENCY IS LOAD-BEARING RATHER THAN TIDY. The
 * session is the entire reason unattended play is possible — it is what signs without a dialog — and
 * it is also the thing whose lapse stops the rule. So when the rule holds for a session reason, this
 * block points one block up instead of describing a panel the reader is already looking at.
 *
 * NOTHING HERE ARMS ANYTHING, deliberately. Arming is a decision made beside the stake and the side,
 * which is 00-3, and a second arm control would be a second place for the same state to be described
 * differently. What this owns is the half that has to survive the player walking away: the limits
 * committed to a run, the account of it, and the two stops.
 */
function AutoDeployBlock() {
  const { autoDeploy, fee, session, toasts } = useArena();
  const { armed, hold, limits, nextAmountUsd, side, status } = autoDeploy;
  const standing = standingOf(armed, hold);

  /** One limit at a time, with the others carried through — `setLimits` takes the whole set, applies
   *  it mid-run without restarting it, and is a no-op on an unchanged set by identity. */
  const setLimit = (patch: Partial<AutoLimits>) => autoDeploy.setLimits({ ...limits, ...patch });

  // WHY REVOKE MIGHT NOT BE PRESSABLE, in the same shape and from the same evidence as the Stop
  // button one block above — SPEC.md: a control a player cannot press must say why, and what would
  // make it pressable. `work` covers the whole of an open/replace/close, including the wallet dialogs
  // in the middle of it, which is precisely the window in which `busy` drops momentarily to false.
  const revokeBlocked =
    session.work !== null || session.busy
      ? "Revoke comes back the moment the play session finishes opening, replacing or closing."
      : !session.auto
        ? "Already revoked — play sessions are stopped, so nothing can sign for you without your wallet. Start, in the block above, turns them back on."
        : null;

  /** WHY ONE OF THE TWO STOPS CANNOT BE PRESSED, or null when both can — the block's only other line
   *  of visible prose, and the one class of sentence this rail will not put behind a disclosure.
   *
   *  REVOKE'S REASON WINS WHEN BOTH ARE BLOCKED, which is the order the old expression had and is
   *  worth keeping deliberately: `revokeBlocked` describes a state that is about to CHANGE on its own
   *  (a session mid-open) or that the reader just caused (already revoked), while Pause being dark is
   *  a standing condition. The transient one is the one a reader is holding a question about.
   *
   *  NULL IS THE COMMON CASE AND IT RENDERS NOTHING. It used to render a sentence explaining why the
   *  Revoke control appears on two blocks — see the note at the call site for why that is now a code
   *  comment instead. */
  const disabledWhy =
    revokeBlocked ??
    (armed
      ? null
      : "Nothing is armed, so there is nothing to pause — the Repeat every round box in 00-3 Deploy is what arms one. Revoke still works, and stops this page signing anything without your wallet.");

  return (
    <Block title="Auto-deploy">
      <Fact name="Status">{standing.word}</Fact>
      <Fact name="Next deposit">
        {nextAmountUsd === null ? <Dash /> : usdCompact(usdToUnits(nextAmountUsd))}
      </Fact>
      <Fact name="Side">
        {side === null ? (
          <Dash />
        ) : (
          <>
            <Mark side={side} /> {SIDE_TOKEN[side].name}
          </>
        )}
      </Fact>

      {/* THE SENTENCE, FROM THE RULE, AND IT IS THIS BLOCK'S ACTIONABLE LINE.
          `holdText`/`abandonText` are written beside the state machine and covered by its tests, so
          this renders them and adds nothing — one wording per outcome, everywhere it appears. It is
          here armed or not: a rule that can spend money is owed a status line that never reads as
          nothing, and it is the line that names the one press that would unhold the rule.

          THIS BLOCK IS THE RAIL'S ONE EXCEPTION TO "ONE PARAGRAPH VISIBLE", and it keeps three at
          most, each earning its place under a different clause of the rule: this one is actionable,
          the stop distinction below is the safety claim `SOCIAL.md` §5.4 requires be made honestly
          before a choice is made rather than after, and `disabledWhy` appears only while a control on
          screen is dark. It is the only block here that spends money with nobody in the room.

          THE SESSION POINTER IS THE SAME PARAGRAPH NOW, not a second one under it. It was a `<p>` of
          its own, which made a one-clause aside look like a second finding; it is one sentence
          completing the sentence above it, so it is set as one. No words changed. */}
      <p className="lede" style={{ marginTop: 10, fontSize: 12 }}>
        {status}
        {standing.sessionHold ? " That is the Play session block directly above this one." : ""}
      </p>

      {/* THE TWO KILL SWITCHES — `SOCIAL.md` §5.4, and the distinction between them is the most
          important thing on this surface.

          FIRST, AND NOT LAST. The brief puts them at the foot of the block; they are here at the top
          because a stop control below four rows of budget presets is not "one click from wherever
          you are standing", it is one click plus a scroll, and the whole argument for putting
          auto-deploy in this rail was that the stop must never be hunted for.

          NEITHER GETS A CONFIRM DIALOG. A confirmation step on a stop button is a defect, not a
          safety feature: the player is trying to stop money going out, every extra press is another
          round's stake, and "are you sure" is the page asking a question at the one moment it has no
          right to. Both are one press, both do exactly what their label says. */}
      <div className="line line--wrap" style={{ marginTop: 14, gap: 8 }}>
        <button
          type="button"
          className="btn btn--sm"
          disabled={!armed}
          title="Stops this page sending the next deposit. It does not close your session key."
          onClick={autoDeploy.disarm}
        >
          Pause
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={revokeBlocked !== null}
          title="Closes the session key on chain, so it cannot enter another round at all."
          onClick={pressSession(toasts.push, session.end)}
        >
          Revoke session
        </button>
      </div>
      {/* THE COPY THAT MUST NOT FLATTER PAUSE. `SOCIAL.md` §5.4 is explicit that revoking is "the one
          that works even if our server is compromised, our client is wrong, or we are unreachable"
          and that it "must be described honestly as the real one". Pause is this page choosing to
          stop; revoking removes the key's ability to act. A player picking between two stop buttons
          is entitled to know which one survives us being wrong, and there is no wording of Pause that
          earns the word "guarantee".

          SPLIT IN TWO, AND THE SPLIT IS THE MOST CAREFUL DECISION IN THIS WHOLE PASS. Ninety words
          under two buttons is a paragraph nobody reads, and an unread safety claim is not a safety
          claim — it is a compliance artefact. But collapsing the whole thing behind a click would
          mean the choice between two stop buttons gets made, by default, by a reader with no idea
          which one holds. So the DISTINCTION stays open, in one sentence, naming both controls by
          the labels the reader can see; the full account of what each one costs and what it does not
          promise is one press away, under a summary that names exactly that. Nothing is deleted.
          §5.4's requirement is that revoke "must be described honestly as the real one" — the
          visible sentence is where that is done, and it is the shortest true form of it. It is also
          the ONLY sentence this pass added to the screen; everything else here moved or went. */}
      <p className="lede" style={{ marginTop: 10, fontSize: 12 }}>
        Revoke is the one that holds if this page is wrong — it closes the key on chain. Pause is
        this page choosing not to send the next deposit.
      </p>
      <Disclosure summary="What Pause and Revoke actually do">
        <p className="lede">
          Pause is instant: no transaction, no approval, and it takes effect before the next round.
          It is worth exactly as much as our code being correct. Revoke closes the session key on
          chain, so the key that has been signing for you cannot enter another round at all — that
          one still works if this client is wrong, our server is compromised, or we are unreachable,
          which is why it is the real one. It costs one approval in Phantom and sends the key&apos;s
          unspent SOL back. Neither asks you to confirm.
        </p>
      </Disclosure>

      {/* WHY A CONTROL CANNOT BE PRESSED — SPEC.md's rule, and the one class of sentence that is NOT
          allowed behind a disclosure anywhere in this rail. A disabled button whose explanation is
          one click away is a disabled button with no explanation.

          WHAT WAS DELETED HERE, AND WHY IT IS NOT HIDING SOMEWHERE. The armed branch used to read
          "Revoke is the same control as Stop in the block above; it is repeated here because this is
          where the choice between the two gets made." That sentence explains a RENDERING decision —
          why one control appears on two blocks — to a reader who has not asked and cannot act on the
          answer. It is not a claim about the system, nothing in SPEC or SOCIAL requires it, and the
          argument it makes is exactly the argument the `AutoDeployBlock` header comment already makes
          to the next engineer, which is who it was really written for. So it moved from the screen
          into this file, and nothing on screen replaces it: when everything is pressable, this
          paragraph is absent entirely.

          The unarmed branch stays, verbatim and visible, because it is the other kind of sentence: it
          says why `Pause` is greyed and names the one control that would make it pressable. */}
      {disabledWhy === null ? null : (
        <p className="lede" style={{ marginTop: 8, fontSize: 12 }}>
          {disabledWhy}
        </p>
      )}

      {/* SAID ONCE, PLAINLY, AND NOWHERE ELSE ON THE PAGE. Somebody leaving this running overnight is
          entitled to know what their deposit actually does to a round, and it is not what the phrase
          "join a round" implies: the keeper holds a lobby open for a PERSON rather than for a clock
          (`keeperStatus.ts`'s `waiting-for-players`), so an unattended entry is itself the thing that
          closes entries and starts the fight, and the rest of the board arrives after that rather
          than before it. That is a surprising enough sequence to be worth a paragraph.

          IT DESCRIBES THE MECHANISM AND NEVER THE ROOM. An earlier version said an automatic entry
          was "usually the only real one in the round" and went on to name what the keeper had seated
          in there. Both were claims about who the OTHER fighters were, and this page has no basis for
          any such claim — the arena's own wallets are not published anywhere a browser can read them
          (`keeperStatus.ts`, schema 5). What survives is the half that was always about the reader:
          their deposit, its timing, and what it sets off.

          NO OPPONENT COUNT, AND THAT IS THE POINT OF THE LAST SENTENCE. At lobby time the board is
          not drawn, so any figure for "who you would be fighting" would be invented — which SPEC
          forbids outright. The honest version is the mechanism in words, and that closing sentence is
          more true now than when it was written, not less.

          CLOSED, BECAUSE ITS OWN FIRST THREE WORDS SAY WHEN IT MATTERS. "Worth knowing before you
          leave one running" is a sentence for somebody about to walk away, not for somebody reading
          a status row — so the summary names the subject and the paragraph waits for the reader who
          wants it. The summary must NOT be softer than the paragraph, which is why it says what the
          deposit does rather than "about auto-deploy". */}
      <Disclosure summary="What an automatic entry does to a round">
        <p className="lede">
          Worth knowing before you leave one running: the keeper holds a lobby open for a person
          rather than a clock, so your deposit is what closes entries and starts the fight — and the
          rest of the board is filled in around you, after you are in. Who that turns out to be is
          not knowable at lobby time, so this page will not put a number on it.
        </p>
      </Disclosure>

      {/* THE ACCOUNT OF THE RUN — what it did, and how far it can still go. Two headed paragraphs
          that are now one disclosure, and merging them is deliberate rather than tidy: they answer
          the same question from either side of now, and a reader who opens one wants the other.
          Neither is actionable — `report` describes what already happened and `runwayNote` projects
          what has not — so under this rail's rule neither may sit open. Both are kept in full.

          `tallyReport` says something true before the first round as well as after the hundredth,
          which is why the disclosure is rendered unconditionally rather than only once something has
          happened: a run that has done nothing yet is a fact somebody is entitled to read.

          `runwayNote` computes both money bounds off the live `FeeRate` and names whichever of the
          money, the session and the ceiling actually binds — which is the half that matters now: at
          the old session length the SESSION was what ended an unattended run, and at the length it is
          now the budget or the drawdown stop almost always gets there first. Rendering
          `runway.binding`'s own sentence rather than asserting either one is what keeps this true the
          next time the constant moves. */}
      <Disclosure summary="What this run has done, and how far it can go">
        <p className="lede">{autoDeploy.report}</p>
        <p className="lede" title={feeNote(fee)}>
          {/* A RUNWAY PRICED AT NOTHING IS NOT A PROJECTION, IT IS AN ARTEFACT. `runway` is computed
              from `nextAmountUsd ?? 0`, so a rule that resolves to no sendable amount produces "funds
              0 rounds if every fight is lost" — a figure with nothing behind it, in a sentence a
              player would size a night's budget against. SPEC's rule is that we never invent a
              number, so the projection is withheld and the reason for withholding it is what prints
              instead. */}
          {nextAmountUsd === null
            ? "Nothing to project yet: the rule does not currently resolve to an amount worth sending, and a runway priced at nothing would be a made-up number. The status above says what would change that."
            : runwayNote(autoDeploy.runway)}
        </p>
      </Disclosure>

      {/* THE BOUNDS, AS PRESETS. `Seg` because that is this page's control for a choice among a few
          named values (the cashier's token picker above, 00-3's stake presets, the repeat sizing) —
          a new control vocabulary for the one panel that spends money unattended would be the worst
          possible place to introduce one. Applied through `setLimits`, which takes effect mid-run
          without restarting it: raising a spent budget resumes the run at the next round, because
          `budget-spent` is a derived hold rather than a flag. */}
      <div className="line line--wrap" style={{ marginTop: 18 }}>
        <span className="u">Limits</span>
        <span className="push">
          <Tag kind="sim" />
        </span>
      </div>

      <div className="line line--wrap" style={{ marginTop: 12 }}>
        <span className="u">Budget for this run</span>
        <Seg<number>
          ariaLabel="Budget for this run"
          value={limits.budgetUsd}
          onChange={(budgetUsd) => setLimit({ budgetUsd })}
          options={BUDGET_PRESETS_USD.map((b) => ({ id: b, label: usd(usdToUnits(b), 0) }))}
        />
      </div>

      <div className="line line--wrap" style={{ marginTop: 12 }}>
        <span className="u">Most in any one round</span>
        <Seg<number>
          ariaLabel="Most it will put into any one round"
          value={limits.perRoundCapUsd}
          onChange={(perRoundCapUsd) => setLimit({ perRoundCapUsd })}
          options={STAKE_PRESETS.map((p) => ({ id: p, label: usd(usdToUnits(p), 0) }))}
        />
      </div>

      <div className="line line--wrap" style={{ marginTop: 12 }}>
        <span className="u">Stop if down by</span>
        <Seg<string>
          ariaLabel="Drawdown stop, as a share of the budget"
          value={limitId(limits.drawdownStopPct)}
          onChange={(id) => setLimit({ drawdownStopPct: limitValue(id) })}
          options={DRAWDOWN_OPTIONS}
        />
      </div>

      <div className="line line--wrap" style={{ marginTop: 12 }}>
        <span className="u">Rounds at most</span>
        <Seg<string>
          ariaLabel="Round ceiling for this run"
          value={limitId(limits.maxRounds)}
          onChange={(id) => setLimit({ maxRounds: limitValue(id) })}
          options={CEILING_OPTIONS}
        />
      </div>

      {/* WHAT THE `SIM` MARKER ABOVE ACTUALLY MEANS HERE, because "simulated" is doing a narrower and
          more important job than it does over the cashier. These are not readings of a simulated
          ledger — they are bounds this TAB enforces on real transactions, and the program knows
          nothing about any of them. It custodies no tokens, so there is no committed capital anywhere
          for a budget to be a budget OF, and nothing on chain would stop a second tab.

          AND THE SECOND SENTENCE IS REQUIRED RATHER THAN HELPFUL: `setLimits`' own note says a panel
          offering both the budget and the drawdown stop is owed it. The stop is a percentage of what
          is committed, so raising the budget raises the dollar loss it tolerates, in proportion —
          which is what "half of what I put in" means when somebody puts more in, and is not what a
          player pressing one control necessarily has in mind.

          CLOSED, AND THE `sim` MARKER ABOVE IS WHAT MAKES THAT SAFE. The paragraph is required to
          EXIST — it is the only place the page says who enforces these numbers — but it is not
          required to be the last thing under four segmented controls, unread. The marker beside the
          `Limits` heading already carries the headline in one glyph, everywhere on this page it
          appears; the summary names precisely which question the paragraph answers, and a reader who
          wants to know who is holding these bounds is one press from the full answer rather than
          nought presses from a wall. */}
      <Disclosure summary="Who enforces these limits, and what the drawdown stop is a share of">
        <p className="lede">
          These bounds are enforced by this tab, not by the program — the arena custodies no tokens,
          so nothing on chain knows a budget exists, and closing this tab ends the run rather than
          settling it. The drawdown stop is a share of the budget, so raising the budget also raises
          the loss it will sit through, in proportion.
        </p>
      </Disclosure>
    </Block>
  );
}

/**
 * THE SESSION BUTTONS THREW INTO NOTHING, and the message they threw was the one written to unblock
 * the person pressing them.
 *
 * `createSession` (`chain/session/useSessionKeyManager.ts`) pre-flights the balance itself and throws
 * "wallet has X SOL but starting a session needs about 0.021 (it funds the session key so IT can pay
 * for enter/extract)". That throw never reaches gum, so `session.error` — which is gum's channel —
 * stays null and the panel rendered nothing at all. `void session.start()` then dropped it as an
 * unhandled rejection into the console.
 *
 * IT IS REACHABLE, NOT THEORETICAL: `playGate` blocks at a balance of exactly zero, and the session
 * top-up is 0.02 SOL. A wallet holding 0.005 devnet SOL passes the gate, gets an enabled Start
 * button, presses it, and nothing whatsoever happens. `src/ui/SessionButton.tsx` solved the same
 * problem in the legacy app for the same reason; a toast is this page's equivalent of its local error
 * state.
 *
 * MODULE-LEVEL because two blocks in this rail now press session controls: the Play session block's
 * Start/Stop, and the auto-deploy block's Revoke, which is the same `session.end` reached from the
 * place the decision to use it is actually made. A second inline copy of this wrapper would be a
 * second chance to forget it, and forgetting it is silent by construction — the symptom is a button
 * that does nothing at all.
 */
function pressSession(
  push: (text: string, kind?: ToastKind) => void,
  fn: () => Promise<void>,
): () => void {
  return () => {
    void (async () => {
      try {
        await fn();
      } catch (e) {
        push(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  };
}

/**
 * THE WALLET RAIL, AND THE RULE THAT NOW GOVERNS EVERY WORD IN IT.
 *
 * THE COMPLAINT, verbatim: "The wallet side panel is a fucking mess. Wayyyy too much text. Very
 * unnecessary. No one is going to read that, bad UX." It was right, and it was right about something
 * this file did to itself honestly: every paragraph in here was added for a good reason, argued for
 * in the comment above it, and correct. Eleven of them, stacked in one 420px column. Each was worth
 * its place against the paragraph before it and none was worth its place against all ten others.
 *
 * ================================================================================================
 * THE RULE: IN THIS RAIL, AT MOST ONE PARAGRAPH OF PROSE IS VISIBLE BY DEFAULT PER BLOCK, AND ONLY
 * WHEN IT IS ACTIONABLE — it tells the player what to do next, or it says why a control they can see
 * is disabled. Everything else goes behind a `<Disclosure>` or is deleted.
 * ================================================================================================
 *
 * WHAT "ACTIONABLE" BUYS, AND WHY IT IS NOT "IMPORTANT". Importance is the test that produced eleven
 * paragraphs — every one of them is important, which is why every one of them was written. Actionable
 * is a test a sentence can fail: `autoDeploy.status` names the press that would unhold the rule, so it
 * stays open; the custody paragraph under Simulated balances is true whether or not anyone reads it
 * and changes nothing about what a reader does next, so it closes. SPEC.md's rule about disabled
 * controls falls out of this rather than being an exception to it: "Can't start one yet — {short}" and
 * `revokeBlocked` explain a control the reader can SEE and cannot press, so they are always open.
 * A disabled button whose explanation is one click away is a disabled button with no explanation.
 *
 * NOTHING LOAD-BEARING WAS DELETED. Every honesty claim this repo argues for is still rendered, in
 * full, in the same words — the pause/revoke distinction (`SOCIAL.md` §5.4), what an unattended entry
 * does to a lobby, who enforces the auto-deploy bounds, what the simulated balances are. They are one
 * press away instead of nought presses away, under summaries that name them. Two sentences WERE
 * deleted, both in the X block, and both are written up where they used to live (`data/xConsent.ts`)
 * rather than in a commit message: one was about to become false, one is now said by the layout.
 *
 * THE COUNT, in the steady state (wallet connected, no gate, session active, `?links=` off):
 * eleven paragraphs before, three after — `autoDeploy.status`, the one-sentence stop distinction,
 * and, only while something is actually disabled, the sentence saying why.
 */
function WalletTenant() {
  const { wallet, session, sim, toasts, gate } = useArena();
  const [amount, setAmount] = useState(50);
  const [token, setToken] = useState<TokenKey>("ansem");
  const [convertTo, setConvertTo] = useState<TokenKey>("uwu");

  const burner = wallet.mode === "burner";
  const connected = wallet.status === "connected";
  /** What the ADDRESS is, for the copy toast — "Wallet address copied" is what a reader who just
   *  pressed Copy expects to see confirmed, whatever the block above it happens to be headed. */
  const noun = burner ? "Burner" : "Wallet";
  /** What the BLOCK is, which is not the same word. The rail's own head already says "Wallet" (it is
   *  the panel's identity, and it is also the fighter inspector's alternative), so a block headed
   *  "Wallet" underneath it printed the word twice in two lines and read as a rendering fault.
   *  Each state names itself instead: the key you were given, the account you connected, or the
   *  thing this block is currently for. */
  const blockTitle = burner ? "Burner key" : connected ? "Account" : "Connect";

  // THE GATE, MINUS THE ONE STATE THAT IS NOT ABOUT THE WALLET. `no-program` is the page still
  // fetching the IDL — true, blocking, and nothing to do with whose key is connected. Rendering it
  // inside a panel headed "Wallet" would send a reader hunting for a wallet fault that does not
  // exist. Every other block genuinely belongs here, and the dock still shows all of them.
  const walletGate = gate !== null && gate.code !== "no-program" ? gate : null;

  const copy = () => {
    navigator.clipboard?.writeText(wallet.pubkey).then(
      () => toasts.push(`${noun} address copied`),
      () => toasts.push("Clipboard refused the copy", "error"),
    );
  };

  /** See `pressSession` — the whole account of why these two buttons need a wrapper at all. */
  const runSession = (fn: () => Promise<void>) => pressSession(toasts.push, fn);

  return (
    <>
      <Block
        title={blockTitle}
        tools={
          connected ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={copy}>
              Copy
            </button>
          ) : null
        }
      >
        {/* NOTHING IS RENDERED FOR AN ABSENT WALLET. `wallet.pubkey` is `""` when nobody is
            connected, and an empty `.key` paragraph over a `—` balance reads as a figure that failed
            to load rather than as an account that does not exist yet. */}
        {connected ? (
          <>
            <p className="key" style={{ margin: "0 0 10px" }}>
              {wallet.pubkey}
            </p>
            {/* WHO THIS KEY IS, TO EVERYONE ELSE — directly under the key itself, because the link is
                about THIS wallet and a player asking what this site knows about them is looking at
                exactly this string. `SOCIAL.md` §4.0. It renders nothing at all unless `?links=` was
                asked for, so the deployed page is unchanged; see `XLinkPanel`. */}
            <XLinkPanel />
            <Fact name="SOL (devnet)">
              {wallet.solBalance === null ? <Dash /> : wallet.solBalance.toFixed(4)} <Tag kind="live" />
            </Fact>
            <div className="line" style={{ marginTop: 12, gap: 8 }}>
              {/* THE IN-PAGE AIRDROP IS A DEVELOPER TOOL AND STAYS ONE. Devnet's public faucet
                  rate-limits `requestAirdrop` to uselessness — five consecutive 429s, measured — so
                  offering it to a visitor would be a button that reliably fails, which is worse than
                  no button. A developer on their own machine may well have a fresh IP and a reason
                  to try, so the burner path keeps it unchanged. */}
              {burner ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={wallet.airdropping}
                  onClick={() => void wallet.airdrop()}
                >
                  {wallet.airdropping ? "Requesting…" : "Airdrop 1 SOL"}
                </button>
              ) : null}
              <button type="button" className="btn btn--sm btn--ghost" onClick={wallet.refresh}>
                Refresh
              </button>
              {burner ? null : (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => void wallet.disconnect()}>
                  Disconnect
                </button>
              )}
            </div>
            {/* WHAT THIS WALLET IS EVER ASKED FOR — kept in full, and closed.
                Nothing in it is actionable: it is a standing description of what the page will and
                will not do with a key that is already connected, true whether or not it is read, and
                unchanged by anything the reader might press. Under this rail's rule that is exactly
                the shape that goes behind a summary, and the summary is the question it answers.

                IT USED TO ASSERT A NEGATIVE THAT THE BUTTON EIGHT LINES BELOW DISPROVES: "this page
                never asks it for anything else". Starting a session signs a transfer of 0.02 SOL
                out of the wallet and into the session key (`SESSION_TOP_UP_LAMPORTS`) — twenty
                times a typical fee, and a transfer rather than a fee. Naming it is cheap; the
                alternative was the same class of claim this codebase refuses everywhere else.

                IT ALSO USED TO SAY "once an hour at most", WHICH WAS A DURATION STATED AS A FACT.
                How often that top-up is asked for is exactly how long a session lasts, which is a
                private const this workstream does not own and which has already moved (see
                `spanOfMinutes`). The honest and change-proof form is the RULE — once per session,
                and only when there isn't one — which stays true at every length. */}
            <Disclosure summary="What this wallet pays for">
              <p className="lede">
                {burner
                  ? "Devnet only. This key is generated in your browser and pays the fees for your own entries."
                  : `Devnet only. Your wallet pays the devnet fees for your own entries. The only other thing it is ever asked for is ${ASSUMED_SESSION_TOP_UP_SOL} SOL to fund a play session key — once per session, and only when there isn't one — and revoking a session sends the unspent part back.`}
              </p>
            </Disclosure>
          </>
        ) : null}

        {/* Shown BESIDE a connected account as well as instead of one: a connected wallet holding no
            devnet SOL is blocked, and the way out of that is the same panel. */}
        {walletGate !== null ? (
          <div style={{ marginTop: connected ? 16 : 0 }}>
            <ConnectPanel block={walletGate} density="full" />
          </div>
        ) : null}
      </Block>

      {/* THE MANUAL CONTROLS, AND NOBODY HAS TO FIND THEM. A session now opens itself on the first
          deploy or extract and renews itself when the chain says it has lapsed, so this block is not
          a step in anybody's flow — it is here for the player who wants to decide explicitly, and
          for the one who wants to see what is signing for them. */}
      <Block title="Play session">
        <Fact name="Status">{sessionStatus(session.plan)}</Fact>
        {session.error ? (
          <p className="key" style={{ color: "var(--hot)", margin: "10px 0 0" }}>
            {session.error}
          </p>
        ) : null}
        <div className="line" style={{ marginTop: 12, gap: 8 }}>
          {/* ENABLED WITH A SESSION IN HAND, and that is a fix rather than a loosening. gum reuses
              its session keypair, so pressing Start while one exists used to build a `create_session`
              aimed at an account that already exists and fail — in exactly the state (a stale
              session) that sends a player looking for this button. `start` now replaces what is
              there; the label says so.

              BOTH BUTTONS SHUT ON `work`, NOT ON `busy` ALONE, and that half is load-bearing. gum
              revokes a session by calling its own send helper inside its own loading wrapper, so
              `busy` drops to FALSE for the length of the balance sweep — with the revoke still
              running and a session still on the manager. These two controls therefore re-enabled in
              the middle of a renewal, and a press there sent a second `revoke_session` for a token
              already being revoked: a wallet dialog with no possible explanation. `work` is ours and
              spans both calls. `busy` stays in the expression because it is never wrongly HIGH — it
              only fails to be high — so it costs nothing and covers plain session signing. */}
          <button
            type="button"
            className="btn btn--sm"
            disabled={session.work !== null || session.busy || gate !== null}
            onClick={runSession(session.start)}
          >
            {session.active ? "Renew" : "Start"}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={session.work !== null || session.busy || !session.auto}
            onClick={runSession(session.end)}
          >
            Stop
          </button>
        </div>
        {/* SPEC.md: a control a player cannot press must say why, and what would make it pressable.
            Starting a session is itself a transaction that funds the session key, so every reason
            the page cannot act is a reason this cannot either — and it is the same reason, from the
            same verdict, rather than a second opinion assembled here. */}
        {!session.active && gate !== null ? (
          <p className="lede" style={{ marginTop: 10, fontSize: 12 }}>
            Can&apos;t start one yet — {gate.short}.
          </p>
        ) : null}
        {/* FROM THE PLAN, exactly like the Status row above it. Branching on `auto` alone put "the
            first move you make opens it" under a status line reading NOT NEEDED — THE BURNER KEY
            SIGNS SILENTLY, and under NOT USED IN FIXTURE MODE, and under NEEDS ABOUT 0.021 SOL. One
            input, one story.

            CLOSED, AND THE `Status` ROW IS WHY IT CAN BE. Every actionable word in `sessionPanelNote`
            is already in the Fact row above it in the form a glance can take: `NEEDS ABOUT 0.021 SOL`
            is the whole of the unaffordable branch's instruction, `STOPPED` and `OPENS ON YOUR NEXT
            MOVE` are the whole of theirs. What the paragraph adds is the ARGUMENT — why a session key
            exists, what it costs to open, and why a wallet popup mid-extract costs you the round —
            which is worth having and is not worth having unasked, four times a visit, in the column
            an operator called a mess.

            `sessionAge` MOVED IN HERE TOO, and it belongs beside this rather than above it. Both
            answer "what is signing for me, and for how long", it is an INFERENCE from a mirrored
            constant rather than a deadline (see the function), and its own copy says outright that a
            lapsed session needs nothing from the reader — "you do not have to do anything" is the
            definition of a line that does not need to be open. It renders only with a session in
            hand, exactly as it did. */}
        <Disclosure summary="What a play session is signing for you">
          {session.active ? <p className="lede">{sessionAge(session.life)}</p> : null}
          <p className="lede">{sessionPanelNote(session.plan)}</p>
        </Disclosure>
      </Block>

      {/* DIRECTLY UNDER THE SESSION, and above the money. The session is what makes unattended play
          possible at all and its lapse is what stops the rule, so the block that explains itself by
          pointing one block up has to be the one immediately below it. See `AutoDeployBlock`. */}
      <AutoDeployBlock />

      <Block
        title="Simulated balances"
        tools={<Tag kind="sim" />}
      >
        {(["ansem", "uwu", "sol"] as TokenKey[]).map((k) => (
          <Fact key={k} name={TOKENS[k].name}>
            {simUsd(sim.ledger.balances[k])}
          </Fact>
        ))}
        {/* CLOSED, AND THE `sim` MARKER IN THE BLOCK HEAD IS WHY. The paragraph is a custody claim
            and stays in full — "the arena program custodies no tokens" is the fact the whole `sim`
            vocabulary exists to carry, and SPEC forbids a money-shaped figure without it. But the
            marker is ALREADY BESIDE THE HEADING, in the same glyph this page uses on every simulated
            figure it prints, and the three rows under it are the least surprising numbers in the
            rail. Restating the marker in forty words, permanently, under three balances that nobody
            can spend is precisely the kind of paragraph the operator was looking at. The summary
            names what is inside, and the marker keeps doing what it has always done at a glance. */}
        <Disclosure summary="What these balances are">
          <p className="lede">
            The arena program custodies no tokens: there are no deposits, no withdrawals and no house
            balance on chain. These are localStorage numbers modelling the original game&apos;s
            cashier, and they buy nothing.
          </p>
        </Disclosure>
      </Block>

      <Block title="Simulated cashier" tools={<Tag kind="sim" />}>
        <label className="u" htmlFor="rail-amt">
          Amount (USD)
        </label>
        <input
          id="rail-amt"
          type="number"
          min={1}
          step={1}
          value={amount}
          onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
        />
        <div className="line" style={{ marginTop: 12, gap: 0 }}>
          <div className="seg">
            {(["ansem", "uwu", "sol"] as TokenKey[]).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={token === k}
                onClick={() => {
                  setToken(k);
                  if (convertTo === k) setConvertTo(k === "ansem" ? "uwu" : "ansem");
                }}
              >
                {TOKENS[k].name}
              </button>
            ))}
          </div>
        </div>
        <div className="line line--wrap" style={{ marginTop: 12, gap: 8 }}>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => sim.actions.deposit(token, amount)}
          >
            Deposit
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={sim.ledger.balances[token] < amount}
            onClick={() => sim.actions.withdraw(token, amount)}
          >
            Withdraw
          </button>
        </div>

        <div className="line line--wrap" style={{ marginTop: 16, gap: 8 }}>
          <span className="u">Convert {TOKENS[token].name} →</span>
          <div className="seg">
            {(["ansem", "uwu", "sol"] as TokenKey[])
              .filter((k) => k !== token)
              .map((k) => (
                <button key={k} type="button" aria-pressed={convertTo === k} onClick={() => setConvertTo(k)}>
                  {TOKENS[k].name}
                </button>
              ))}
          </div>
          <button
            type="button"
            className="btn btn--sm"
            disabled={sim.ledger.balances[token] < amount}
            onClick={() => sim.actions.convert(token, convertTo, amount)}
          >
            Convert
          </button>
        </div>

        <div className="line line--wrap" style={{ marginTop: 20, gap: 8 }}>
          <button type="button" className="btn btn--sm btn--ghost" onClick={sim.actions.topUp}>
            + $100 &amp; $100
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={sim.actions.reset}>
            Reset ledger
          </button>
        </div>
      </Block>

      {/* Last, and deliberately below the money: it is the only thing in this rail that is about the
          page rather than about the player, and while it is being reviewed it should be the easiest
          thing here to walk past. */}
      <PaperTheme />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Tenant 2 — the fighter inspector
// ---------------------------------------------------------------------------------------------

function FighterTenant({ wallet }: { wallet: string }) {
  const { live, standings, source, logCoverage } = useArena();
  const prov = source === "chain" ? "live" : "fixture";
  const f = live?.fighters.find((x) => x.wallet === wallet) ?? null;
  const record = standings.find((s) => s.wallet === wallet) ?? null;
  // READ, NEVER WAITED ON — `useLinks.ts`'s standing rule. The inspector opens and fills immediately;
  // an identity, where there is one, arrives when the feed does.
  const { map } = useLinks();

  if (!f && !record) {
    return (
      <p className="lede">
        This wallet isn&apos;t in the round on screen and has no settled rounds behind it yet.
      </p>
    );
  }

  // One of the two is non-null: the early return above is the case where neither is. The final
  // fallback is unreachable and exists because that is a fact about control flow the compiler cannot
  // see; it is `shortKey` rather than a literal so an unreachable branch cannot render as a lie.
  const short = f?.short ?? record?.short ?? shortKey(wallet);

  const pnl = f ? worth(f) - f.stake : null;
  const status = f ? (f.dead ? (f.banked > 0n ? "OUT — BANKED" : "DEAD") : "ALIVE") : "NOT IN THIS ROUND";

  return (
    <>
      <div className="line" style={{ gap: 8, marginBottom: 4 }}>
        {f ? <Mark side={f.side} dead={f.dead} /> : null}
        {/* THE HEADING IS THE PANEL'S ONE IDENTITY SLOT, so an unlinked fighter is named here by
            their truncated address rather than by nothing — a titleless panel reads as a panel that
            failed to load. The full key on the line below is not a duplicate of it: this is the
            LABEL, at heading weight, and that is the checkable fact, at key weight, which is the
            same pairing `.h` and `.key` have everywhere else on this rail.

            `"beside"`, because `· you` is printed immediately to the right — so a linked reader sees
            their own `@handle` here, exactly as they do on the leaderboards. See `namePlate.ts`. */}
        <span className="h sr-who">
          {plateText(namePlate(map, wallet, f?.isYou === true ? "beside" : "unmarked"), short)}
        </span>
        {f?.isYou ? <span className="u u--ink">· you</span> : null}
      </div>
      <p className="key" style={{ margin: "0 0 4px" }}>
        {wallet}
      </p>

      {/* This whole block sits in a `.fact` row of a 420px rail — the narrowest money surface on
          the page besides the dock — so every figure in it compacts. */}
      {f ? (
        <Block title={`This round · ${SIDE_TOKEN[f.side].name}`} tools={<Tag kind={prov} />}>
          <Fact name="Status">{status}</Fact>
          <Fact name="Stake (net of fee)">{usdCompact(f.stake)}</Fact>
          <Fact name="In the ring">{usdCompact(f.hp)}</Fact>
          <Fact name="Banked">{f.banked > 0n ? usdCompact(f.banked) : <Dash />}</Fact>
          <Fact name="Worth now">{usdCompact(worth(f))}</Fact>
          <Fact name="P/L">
            {pnl === null ? (
              <Dash />
            ) : (
              <span className={pnl > 0n ? "pos" : pnl < 0n ? "neg" : undefined}>{usdCompactSigned(pnl)}</span>
            )}
          </Fact>
          <div style={{ marginTop: 12 }}>
            <Bar value={f.hp} max={f.stake} side={f.side} large />
            <div className="line" style={{ marginTop: 6 }}>
              <span className="u">Health</span>
              <span className="u push">
                {f.stake > 0n ? `${Math.round((Number(f.hp) / Number(f.stake)) * 100)}%` : "—"}
              </span>
            </div>
          </div>
        </Block>
      ) : null}

      {/* WHO TOOK IT. The block above says how much this fighter has left; it has never said where
          the difference went, which is the question a player opens this panel holding. Directly
          under the figures rather than at the foot of the panel, because it is the explanation of
          them — the all-time record below is a different subject entirely.
          Scoped to the LIVE round: `useArena().combat` is a window over the fight on screen, and
          a settled round's exchanges would have to be replayed from its own account. Twelve rows is
          what a 420px rail holds without the panel becoming a scroll of its own. */}
      {f ? (
        <Block title="Exchanges · this round" tools={<Tag kind={prov} />}>
          <CombatLog wallet={wallet} limit={12} />
        </Block>
      ) : null}

      {/* THE LAST SCREEN STILL CLAIMING "ALL TIME" OVER A WINDOW. `record` is one row out of
          `standings`, which is derived from `history.rounds` — the newest N round accounts, short a
          round wherever a read failed, and (since v7's `close_round_account`) permanently missing
          every round whose rent the authority has reclaimed. The three data views were taught to say
          what they actually cover; this rail was not, so it went on asserting the strongest version
          of the claim in the one place a player reads their OWN numbers. `coveragePhrase` is the
          same wording those views use, and it is allowed to say "all time" on the days that is true.
          The footnote had the identical bug in its own words — "every round account that exists" is
          precisely what a reclaimed round is not — so it now states the mechanism instead. */}
      <Block title={record ? `Your record · ${coverageFigure(logCoverage)}` : "Your record"} tools={<Tag kind={prov} />}>
        {record ? (
          <>
            <Fact name="Rounds">{record.rounds}</Fact>
            <Fact name="Rounds on the winning side">{record.wins}</Fact>
            <Fact name="Staked">{usdCompact(record.staked)}</Fact>
            <Fact name="Returned">{usdCompact(record.returned)}</Fact>
            <Fact name="P/L">
              <span className={record.pnl > 0n ? "pos" : record.pnl < 0n ? "neg" : undefined}>
                {usdCompactSigned(record.pnl)}
              </span>
            </Fact>
            <Fact name="Return on stake">
              {record.roi === null ? <Dash /> : `${(record.roi * 100).toFixed(0)}%`}
            </Fact>
            <Fact name="Best round">{record.best > 0n ? usdCompactSigned(record.best) : <Dash />}</Fact>
          </>
        ) : (
          <p className="u" style={{ padding: "8px 0" }}>
            No settled rounds for this wallet yet
          </p>
        )}
        <p className="lede" style={{ marginTop: 12, fontSize: 12 }} title={coverageNote(logCoverage)}>
          Counted {coveragePhrase(logCoverage)}, from the round accounts themselves — never from a
          live balance.
        </p>
      </Block>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

export function SideRail() {
  const { rail, setRail } = useShell();
  const [shown, setShown] = useState<Rail>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);

  // Hold the last tenant through the close transition, so the rail slides out with its content
  // intact rather than emptying first.
  useEffect(() => {
    if (rail) setShown(rail);
  }, [rail]);

  useEffect(() => {
    if (!rail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rail, setRail]);

  const open = rail !== null;
  const tenant = rail ?? shown;

  // TRAPPED ONLY WHERE IT IS THE WHOLE SCREEN. On a desktop this rail is a complementary landmark
  // 420px wide, beside a page that is still visible and still legitimately operable — trapping the
  // keyboard in it would be pretending it is a dialogue when a reader can plainly see it is not.
  // Below `shell.css`'s one layout break the same element is `width: 100vw` and covers everything,
  // and "tab behind it" means "tab to controls nobody can see". So the trap follows the width, from
  // the same query the rest of the page breaks at.
  const fullScreen = useMediaQuery(NARROW);

  // FOCUS IS RESTORED AT BOTH WIDTHS, and that half is not optional anywhere. Closing used to set
  // `aria-hidden` on an <aside> that still contained the focused element and then let CSS take it to
  // `visibility: hidden` — so focus was destroyed rather than moved, and the reader was dropped back
  // at the top of the document having lost the row they opened the rail from. The hook captures the
  // opener on open and puts focus back on close — after the commit, which for this component is
  // load-bearing rather than incidental: React re-focuses whatever was focused before a commit if it
  // is still in the document, and a rail that stays mounted to slide out always is. See the note at
  // the top of useFocusTrap.ts; it was measured here.
  useFocusTrap(railRef, {
    active: open,
    trapTab: fullScreen,
    initialFocus: closeRef,
    // `rail`, not `open`: the panel head is re-focused on every tenant swap, which is what this
    // component did before the hook took the focus over.
    refocusKey: rail,
  });

  // THE RAIL FOLLOWS THE FIELD INTO FULLSCREEN. A fullscreen element paints nothing outside its own
  // subtree, and clicking a fighter on the field is how this panel is opened — so with the frame
  // holding the screen, every click on the canvas opened a profile nobody could see. Portalled
  // rather than re-styled: `position: fixed` resolves against the viewport either way, so it lands on
  // exactly the same pixels. See `useFullscreenTarget.ts`.
  const fullscreenTarget = useFullscreenTarget();

  const panel = (
    <aside
      ref={railRef}
      className={`rail${open ? " rail--open" : ""}`}
      aria-label={tenant?.kind === "fighter" ? "Fighter profile" : "Wallet and session"}
      aria-hidden={!open}
    >
      <div className="rail-head">
        <span className="idx">[{tenant?.kind === "fighter" ? "F" : "W"}]</span>
        <span className="h h--sm">{tenant?.kind === "fighter" ? "Fighter" : "Wallet"}</span>
        <button ref={closeRef} type="button" className="rail-x" aria-label="Close panel" onClick={() => setRail(null)}>
          ✕
        </button>
      </div>
      {tenant?.kind === "fighter" ? <FighterTenant wallet={tenant.wallet} /> : <WalletTenant />}
    </aside>
  );

  return fullscreenTarget === null ? panel : createPortal(panel, fullscreenTarget);
}
