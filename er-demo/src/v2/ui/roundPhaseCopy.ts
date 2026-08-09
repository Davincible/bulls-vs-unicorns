// WHAT THE ROUND IS DOING, IN WORDS — the single source of the phase sentence, for every surface
// that shows one.
//
// It exists because there were two of them. The dock (`ui/StakeDock.tsx`) and the deploy section
// (`views/ArenaView.tsx`) each carried their own hand-written ladder of phase strings, and both
// ladders ended in the same line:
//
//     "This round has settled. Deposits reopen at the next lobby."
//
// which is the sentence SPEC.md's "every state answers 'what now?'" section was written against. It
// reads as informative and answers nothing: HOW does a player get into the next lobby, WHEN is it,
// and must they do something or wait? It leaves the reader with more questions than they arrived
// with, which is worse than saying nothing, because it looks like an answer.
//
// THE TEST EVERY STATE HERE IS WRITTEN TO. Three things, in this order:
//
//   1. `now`    — what is true this instant. One clause, no hedging.
//   2. `action` — what the player can do about it, or plainly that there is nothing right now.
//   3. `timing` — when it changes: a REAL number where one exists (`countdown`), and an honest
//                 "waiting on X" where one genuinely does not (`waiting`). Never a countdown to an
//                 event with no cause — that is the same class of lie as an unbacked money figure,
//                 and this page refuses those everywhere else.
//
// It is a pure function of the round and the clock, so the wording is testable without a browser
// (`roundPhaseCopy.test.ts`) and cannot drift between the two surfaces that render it.
//
// IT ALSO DECIDES WHICH CONTROL THE STATE WANTS (`control`), because that decision is the same
// decision. The dock used to derive its body from `phase === "Lobby"`, which offers a Deploy button
// through the whole window between `lobby_closes_at` and the operator's `close_lobby_and_draw` — a
// button the chain would refuse. `entriesOpen()` is the only correct way to ask, and now one answer
// drives both the words and the buttons.

import {
  FIGHT_TIMEOUT_SECONDS,
  clock,
  entriesOpen,
  entrySecondsLeft,
  type LiveRound,
} from "../contract.ts";
import type { PlayBlock } from "../data/playGate.ts";
import type { Cadence } from "./keeperCadence.ts";

/**
 * A one-clause `short` from `playGate.ts`/`walletFault.ts`, promoted to a standalone sentence.
 *
 * Those modules write `short` lower-case and unpunctuated ON PURPOSE — its contract is to be dropped
 * inside a sentence the CALLER owns (`Unavailable — ${short}.`). This page has two callers that own a
 * standalone sentence instead (this module and `ConnectPanel.tsx`), so the transform lives here, once,
 * rather than as a second differently-punctuated copy of every string in `playGate.ts`.
 *
 * An existing terminal stop is left alone, which is not fussiness: the `unknown` fault's `short` is a
 * chain error message reproduced VERBATIM (see `walletFault.ts`'s header) and arrives already
 * punctuated. Capitalising a first letter is typography; adding a second full stop to someone else's
 * sentence is editing it.
 */
export function asSentence(clause: string): string {
  if (clause === "") return "";
  const head = clause.charAt(0).toUpperCase() + clause.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/** When the state changes, in the only two honest shapes there are.
 *
 *  `countdown` renders its seconds through `clock()` as tabular figures — the caller splits the
 *  sentence around the number rather than baking it into a string, so the figure can be marked up
 *  as a figure. `waiting` is the whole sentence: no number exists, and inventing one is the bug. */
export type PhaseTiming =
  | { kind: "countdown"; before: string; seconds: number; after: string }
  | { kind: "waiting"; text: string };

/** THE SAME TIMING AS ONE PLAIN STRING, for a `title` — which cannot hold markup.
 *
 *  `RoundPhaseNote` splits a countdown around its figure so the number can be marked up AS a number;
 *  a tooltip has no elements to split into. Flattening the three parts here rather than writing a
 *  second, shorter set of words for the compact surfaces is the whole point: one claim, one wording,
 *  one place it changes. */
export function timingText(timing: PhaseTiming): string {
  if (timing.kind === "waiting") return timing.text;
  return `${timing.before} ${clock(timing.seconds)}${timing.after}`;
}

/**
 * WHAT GOES IN A COMPACT CLOCK SLOT — the few characters the top bar, 00-1's hero and the field's own
 * overlay each put where a clock goes.
 *
 * THE STATE THIS TYPE EXISTS FOR. All three of those surfaces rendered `clock(live.elapsedSec)`
 * unconditionally, which is the FIGHT clock — and outside a fight it is zero. So a lobby the keeper
 * is deliberately holding open, at no cost, until a real person arrives printed `0:00` in three
 * places at once. `0:00` on a countdown means the time is up; nothing was up, and a visitor read a
 * broken clock over the healthiest resting state this arena has.
 *
 * A slot that cannot hold a sentence must therefore hold a STATE rather than a zero, and the two are
 * different enough that they must not be the same shape: a figure is formatted through `clock()` and
 * tabular, a word is not, and a caller holding `{ text: "0:00" }` has no way to tell them apart. The
 * whole answer travels alongside as `title`, because the sentence still has to be reachable from a
 * slot too small to print it.
 */
export type ClockSlot =
  /** Seconds to render through `clock()`: a fight that is running, the length one ran, or a deadline
   *  something is genuinely counting down to. */
  | { kind: "clock"; seconds: number; title: string }
  /** No clock is running. `word` IS the state, and it must never be dressed as a figure. */
  | { kind: "state"; word: string; title: string };

/** THE WORD A HELD-OPEN LOBBY PUTS WHERE A CLOCK WOULD BE.
 *
 *  Deliberately the same word as this state's `label`, so the plate on the field, the dock's handle
 *  and the three compact slots all name one state with one word. It reads as a healthy state rather
 *  than as a wait on something unnamed — which `WAITING` does not, and which is the reading `0:00`
 *  already gave a visitor. What it is waiting FOR is in the `title` and in the sentence the hero,
 *  the plate and the dock all print in full. */
const HELD_OPEN_WORD = "OPEN";

/** Every other clockless state. This page's standing rule for a slot with no figure in it — a
 *  no-data cell reads `—`, never `0` (styles/base.css). */
const NO_CLOCK = "—";

export interface RoundPhaseCopy {
  /** Which body a control surface should show: the deploy buttons, the extract button, or neither.
   *  Derived from `entriesOpen()`, never from the phase alone. */
  control: "deploy" | "extract" | "none";
  /** WHAT `control` WOULD HAVE BEEN but for the player's own gate (`data/playGate.ts`) — and `null`
   *  whenever the gate is not what suppressed it.
   *
   *  Two states that both render no buttons are not the same state, and a surface that cannot tell
   *  them apart says the wrong thing in one of them. "You cannot deploy because the round is over"
   *  wants the round's own words and nothing else; "you cannot deploy because you have no wallet"
   *  wants a Connect button. This field is that distinction, and it is the only thing the dock needs
   *  in order to stop nagging a reader about a wallet during a settled round they could not have
   *  entered anyway. */
  blocked: "deploy" | "extract" | null;
  /** Two or three words for the `.u` label. Changes rarely enough to be announced politely. */
  label: string;
  /** (1) What is true now. */
  now: string;
  /** (2) What the player can do — or plainly that there is nothing. */
  action: string;
  /** (3) When it changes. */
  timing: PhaseTiming;
  /** (3) AGAIN, AT THE SIZE A FIXED BAR HAS — see `ClockSlot`. The same decision as `timing`, never a
   *  parallel one, so a slot reading `OPEN` and a sentence reading "closes in 0:12" cannot both be on
   *  screen at once. NOT taken over by the player's gate, for the same reason `timing` is not: a
   *  countdown is a countdown whether or not a wallet is connected. */
  clockSlot: ClockSlot;
}

export interface RoundPhaseInput {
  live: LiveRound | null;
  /** Epoch ms, ticked once a second by the caller. */
  nowMs: number;
  /** No program: nothing on the page can reach the chain, which outranks every phase. */
  programError: boolean;
  /** The first round fetch is still in flight. */
  loading: boolean;
  /** WHAT THE KEEPER SAYS ABOUT TIME, this instant — `ui/keeperCadence.ts`, which is the only module
   *  that reads the keeper's status file and the only one that may.
   *
   *  IT IS AN INPUT RATHER THAN A LOOKUP so this stays a pure function of the round and the clock.
   *  Every case in it has already been decided by `keeperCountdown()` in `data/keeperStatus.ts` — the
   *  seconds are computed, floored and ceiled there, and every moment where no honest number exists
   *  has already collapsed to `keeper-silent`. Nothing below re-derives any of that; the branches
   *  here choose SENTENCES, never numbers.
   *
   *  The one thing this module must get right on its own is the difference between `keeper-silent`
   *  and `no-keeper`, because it decides whether the chain's `lobby_closes_at` may be shown. See
   *  `lobbyTiming` below. */
  cadence: Cadence;
  /** WHY THIS PLAYER CANNOT ACT, or null when they can — `data/playGate.ts`'s single verdict.
   *
   *  Optional, and absent means "not gated". Every existing caller and every existing test predates
   *  it and describes a round rather than a player, which is exactly the shape this field is not
   *  allowed to disturb. */
  gate?: PlayBlock | null;
  /** A TRANSACTION THIS PLAYER STARTED IS STILL IN THE AIR (`actions.entering || extracting`).
   *
   *  Optional and absent means "nothing in flight", so no existing caller or test is disturbed. It
   *  exists for one narrow case — see `roundPhaseCopy`'s note on why a gate must not evict a control
   *  mid-send. */
  inFlight?: boolean;
}

/** THE ONE SENTENCE THAT MUST NEVER BE FAKED, factored out because Settled, Abandoned and "no round"
 *  all end in it: a round is over, and the way back in is a lobby that may or may not be scheduled.
 *
 *  ONE WAITING SENTENCE FOR ALL FOUR SILENT CASES, deliberately. Whether the keeper is absent, down,
 *  stalled, or simply between commitments, the two facts a PLAYER needs are identical and both are
 *  true in every one of them: there is no timer, and getting in costs them nothing but showing up
 *  when it opens. Which of the four it is, is an operator's question, and this page has no operator
 *  surface to answer it on — splitting the sentence would put four readings in front of a player who
 *  can act on none of them. */
function nextLobbyTiming(cadence: Cadence): PhaseTiming {
  if (cadence.kind === "next-lobby") {
    return { kind: "countdown", before: "Next lobby in", seconds: cadence.seconds, after: "." };
  }
  return {
    kind: "waiting",
    text: "No timer for the next one — it opens when we start it.",
  };
}

/** WHEN AN OPEN LOBBY STOPS TAKING DEPOSITS — and the one place on this page where reaching for the
 *  chain's own deadline is sometimes right and sometimes a lie, which is why it is a function.
 *
 *  A lobby carries two deadlines that mean different things. `round.lobby_closes_at` is the BACKSTOP
 *  the program enforces so a round always reaches a terminal state; the keeper's `entriesCloseAt` is
 *  the SCHEDULE it actually intends to keep. Under the hold-open policy those are an hour apart, and
 *  they are apart in the direction that reads as "nothing is happening here".
 *
 *  So the keeper outranks the chain whenever a keeper is there at all — including, and especially,
 *  when it is there and SILENT. A keeper that has gone stale mid-hold leaves a lobby whose published
 *  deadline is fifty-nine minutes of backstop; counting that down would be technically true (the
 *  chain really would accept a deposit for fifty-nine minutes) and completely useless, which is the
 *  precise failure this whole mechanism was built to delete. `no-keeper` is the only case that falls
 *  through to the chain, and there it is the honest answer: nobody is holding anything open, so the
 *  backstop IS the schedule. That is the pre-keeper page, the `?fixture=1` page, and an operator's
 *  hand-opened round.
 *
 *  THE ONE CASE THIS GETS WRONG, STATED RATHER THAN HIDDEN. A keeper running a schema this build
 *  cannot parse reaches here as `no-keeper` and not as `keeper-silent`, because `useKeeperStatus`
 *  deliberately collapses a version skew, a 404 and a dead network into one value — and it is right
 *  to: telling them apart is only useful if the page acts differently, and for the next-lobby
 *  sentence it must not. The cost is that a skewed keeper mid-hold gets the chain's backstop counted
 *  down here for as long as the skew lasts, which the schema note in `data/keeperStatus.ts` bounds at
 *  one deploy (writer and reader ship together). The alternative is refusing to count `lobby_closes_at`
 *  anywhere, which would permanently delete a correct and useful countdown from the fixture page and
 *  from every hand-opened round in order to cover a window measured in minutes. Detecting a backstop
 *  by its LENGTH instead would mean inventing a threshold in the browser — the exact move
 *  `staleAfterSeconds` is published to avoid, and a worse lie than the one it would prevent. */
function lobbyTiming(cadence: Cadence, live: LiveRound, nowMs: number): PhaseTiming {
  if (cadence.kind === "entries-close") {
    return { kind: "countdown", before: "Closes in", seconds: cadence.seconds, after: "." };
  }
  if (cadence.kind !== "no-keeper") {
    // Silent, or describing a round this page has already moved past — either way the keeper is the
    // authority here and it is not naming a time. Says so, rather than borrowing the backstop.
    return {
      kind: "waiting",
      text: "No close time we can show — it can close any moment.",
    };
  }
  const secondsLeft = entrySecondsLeft(live, nowMs);
  // Null is a real state, not a missing read: a round opened by a program revision without
  // `lobby_closes_at` has no deadline to show (see `LiveRound.lobbyClosesAtMs`). Saying so is the
  // honest fallback; a countdown invented from a client-side constant would be the one thing worse
  // than none.
  if (secondsLeft === null) {
    return { kind: "waiting", text: "No close time set — it can close any moment." };
  }
  return { kind: "countdown", before: "Closes in", seconds: secondsLeft, after: "." };
}

/** THE ROUND'S OWN STATE, with no opinion about who is reading it. `roundPhaseCopy` below layers the
 *  player's gate on top; keeping the two apart is what lets the gate COMPOSE with the phase — it
 *  keeps the countdown a blocked player still wants to see — instead of replacing it. */
function phaseCopy(input: RoundPhaseInput): Omit<RoundPhaseCopy, "blocked" | "clockSlot"> {
  const { live, nowMs, programError, loading, cadence } = input;

  // A dead program is not a phase, but it is the reason nothing can be pressed — and it outranks
  // the phase, because with no program there is no `enter()` and no `extract()` either.
  if (programError) {
    return {
      control: "none",
      label: "Offline",
      now: "We can't reach the game right now.",
      action: "Nothing works until it's back.",
      timing: { kind: "waiting", text: "Try reloading in a moment." },
    };
  }

  if (live === null) {
    if (loading) {
      return {
        control: "none",
        label: "Loading",
        now: "Getting the round.",
        action: "One moment.",
        timing: { kind: "waiting", text: "The buttons appear as soon as it loads." },
      };
    }
    return {
      control: "none",
      label: "No round",
      now: "No round is open.",
      action: "Nothing to join yet.",
      timing: nextLobbyTiming(cadence),
    };
  }

  const no = live.roundNo.toString();
  // Whether the reader has a fighter in this round. Several states below say something different to
  // a player who is in it than to one who is not, and "am I in this?" is the first question any of
  // them has to answer.
  const entered = live.fighters.some((f) => f.isYou);

  switch (live.phase) {
    case "Lobby": {
      if (entriesOpen(live, nowMs)) {
        // THE ROOM IS NOT EMPTY AND NOTHING IS WRONG — the state that used to have no words at all,
        // and the one most likely to be read as broken if it borrowed any. The keeper has fielded the
        // house so nobody arrives to an empty arena, and it will keep this lobby open at no cost
        // until a real person turns up; there is no clock running, because it is not waiting on one.
        //
        // A COUNTDOWN HERE WOULD BE THE WORST AVAILABLE ANSWER in both directions: `lobby_closes_at`
        // reads "closes in 59:47", which says nothing is happening, and a timer parked at 0:00 says
        // something is stuck. So the words carry it — what is true (house only), what to do (deploy,
        // and it is YOU that starts it), and when it changes (the moment a real player joins). The
        // player is not waiting on this state; they are the thing it is waiting for.
        //
        // THE TIMING CLAUSE HAS TO SURVIVE ON ITS OWN, which is why it names the trigger rather than
        // just reporting the absence of a clock. Every surface that shows an OPEN lobby renders
        // `detail="timing"` — the deploy buttons are the answer to "what can I do", so repeating it
        // in a paragraph above them is a wall (see `RoundPhaseNote.tsx`). `now` and `action` are
        // still the honest values for this state and still drive `control`, but the sentence a
        // player actually reads here is this one, alone, directly above a live Deploy button.
        if (cadence.kind === "waiting-for-players") {
          return {
            control: "deploy",
            label: "Open",
            now: `Round ${no} is open, with only house fighters in it so far.`,
            action: "Pick a side and deploy — the first real player starts the clock.",
            timing: {
              kind: "waiting",
              text: "Nothing is counting down — the clock starts when a real player joins.",
            },
          };
        }
        return {
          control: "deploy",
          label: "Open",
          now: `Round ${no} is open.`,
          action: "Pick a side and deploy.",
          timing: lobbyTiming(cadence, live, nowMs),
        };
      }
      // THE WINDOW THE OLD COPY HAD NO WORDS FOR. `enter` is refused from `lobby_closes_at`, but the
      // phase only leaves Lobby when an operator's `close_lobby_and_draw` lands — a separate
      // transaction, sent at a human's pace. Between the two, this round says "Lobby" and refuses
      // every deposit sent to it.
      return {
        control: "none",
        // WHAT THIS STATE USED TO SAY, and why it was useless: "Round 38 stopped taking deposits.
        // Too late to join this one, a deposit now gets rejected. The fight starts once we draw the
        // seed." Three sentences, one fact, and none of the three things a player actually wants to
        // know — am I in this one, when does it start, and when can I play if I'm not.
        //
        // The answer to the first was sitting right here in `live.fighters` the whole time.
        label: "Fight starting",
        now: entered
          ? `You are in round ${no}. It is closed now and about to fight.`
          : `Round ${no} is closed and about to fight.`,
        action: entered
          ? "Nothing to do, just watch. Your extract button appears the moment it starts."
          : "You are not in this one. The next lobby is the way in.",
        timing: {
          kind: "waiting",
          // No number exists here and inventing one would be the lie this file refuses everywhere
          // else: the seed is drawn by a separate transaction, so "seconds" is a description of how
          // it behaves and not a clock. Saying that plainly still beats the old text, which implied
          // a wait of unknown length and unknown cause.
          text: "It begins the moment the seed is drawn, usually a few seconds.",
        },
      };
    }

    case "Drawing":
      return {
        control: "none",
        label: "Starting",
        now: `Round ${no} is picking its random seed.`,
        action: "Nothing to do.",
        timing: {
          kind: "waiting",
          // There is genuinely no deadline on a draw. Saying "usually seconds" is a description of
          // the oracle's behaviour, not a promise dressed as a clock.
          text: "The fight starts as soon as it lands, usually seconds.",
        },
      };

    case "Fight": {
      return {
        control: "extract",
        label: "Fighting",
        now: `Round ${no} is fighting.`,
        action: entered
          ? "Extract to bank what is left and get out."
          : "You are not in this one.",
        timing: live.resolvable
          ? {
              kind: "waiting",
              // `resolvable` is the flag, not a number, precisely because the deadline an extract is
              // racing is not a fixed countdown: it is whenever someone sends the transaction.
              text: "It can end any second now.",
            }
          : {
              kind: "countdown",
              before: "Ends in",
              seconds: Math.max(0, Math.ceil(FIGHT_TIMEOUT_SECONDS - live.elapsedSec)),
              after: " — or sooner if a side is wiped out.",
            },
      };
    }

    case "Settled":
      return {
        control: "none",
        label: "Round over",
        now: `Round ${no} is done.`,
        action: "Nothing to deposit into. Replay and check it in 00-7.",
        timing: nextLobbyTiming(cadence),
      };

    case "Abandoned":
      return {
        control: "none",
        label: "Round expired",
        // `abandon_round` ends a lobby that reached its deadline holding fewer than two fighters.
        // There is no winner, no seed and no fight in one — so it must not read as settled.
        now: `Round ${no} expired — fewer than two players joined.`,
        action: "No fight to watch.",
        timing: nextLobbyTiming(cadence),
      };
  }
}

/**
 * THE ROUND'S STATE AT THE SIZE OF A FIXED BAR — see `ClockSlot` for the failure that put it here.
 *
 * IT IS DERIVED FROM `phaseCopy`'S OWN OUTPUT, NOT ALONGSIDE IT. Every honesty rule about which
 * deadline may be counted has already been decided once — by `keeperCountdown`, then `lobbyTiming`,
 * then the branch above — and re-deriving any of it here is how a slot ends up counting down the
 * hour-away backstop that the sentence six inches away is refusing to count. So the Lobby case reads
 * `state.timing` and does not look at `lobbyClosesAtMs` at all: if the sentence has a number, the
 * slot shows that number; if the sentence has none, the slot must not invent one.
 *
 * THE FIGHT IS THE ONE CASE THAT IS NOT `timing`, and deliberately. The fight clock counts UP — it is
 * what the step gauge beside it in all three surfaces is measured against, and what `elapsedSec`
 * means — while `timing` there counts the bell DOWN. Two different facts; the slot keeps the one it
 * has always shown, and the bell stays in the sentence and in 00-1's own `Bell in` tile.
 *
 * THE BACKSTOP IS STILL NEVER SURFACED, in any branch. `Round.lobby_closes_at` under the hold-open
 * policy is an hour out and the only thing that happens at it is the keeper abandoning the round; a
 * slot reading `59:47`, or "closes within the hour", would be the same lie `keeperCountdown`'s
 * ordering was written to delete, arriving through a surface too small to qualify it.
 */
function clockSlotFor(
  input: RoundPhaseInput,
  state: Omit<RoundPhaseCopy, "blocked" | "clockSlot">,
): ClockSlot {
  const { live, nowMs, cadence } = input;
  // The whole answer, for a slot with room for a word. Built from the clauses the phase note already
  // renders rather than from a second, shorter set of words — a compact surface that paraphrases is a
  // compact surface that drifts, and this one is the surface a visitor reads first.
  // `lead` replaces `now` for the two branches whose figure is not what `now` describes — see Fight
  // below, where "Round 23 is fighting" is already the word printed beside the slot and what a reader
  // hovering actually wants to know is what the number IS.
  const said = (lead?: string) => `${lead ?? state.now} ${timingText(state.timing)}`;
  const noClock = (): ClockSlot => ({ kind: "state", word: NO_CLOCK, title: said() });

  // Offline, loading, no round: `state.now` already says which, and none of the three has a clock.
  if (live === null || input.programError) return noClock();

  switch (live.phase) {
    case "Lobby": {
      // `entriesOpen()` and never the phase, exactly as the sentence above is written — the window
      // between `lobby_closes_at` and the operator's draw still says "Lobby" and has no clock in it.
      if (!entriesOpen(live, nowMs)) return noClock();
      // THE STATE THIS WHOLE TYPE EXISTS FOR. Nothing is counting down because nothing is waiting on a
      // clock, so the slot says what IS true instead of what the fight clock happens to read.
      if (cadence.kind === "waiting-for-players") {
        return { kind: "state", word: HELD_OPEN_WORD, title: said() };
      }
      // A real deadline, from whichever authority `lobbyTiming` decided was the honest one.
      if (state.timing.kind === "countdown") {
        return { kind: "clock", seconds: state.timing.seconds, title: said() };
      }
      return noClock();
    }

    case "Drawing":
      return noClock();

    case "Fight":
      return {
        kind: "clock",
        seconds: live.elapsedSec,
        title: said("How long this fight has been running."),
      };

    case "Settled":
      return {
        kind: "clock",
        seconds: live.elapsedSec,
        title: said("How long the fight ran before it settled."),
      };

    case "Abandoned":
      // No fight ever started here, so `elapsedSec` is 0 and printing it would say the fight ran for
      // no time rather than that there was never one. That distinction is the entire content of this
      // phase.
      return noClock();
  }
}

/** WHERE THE WAY OUT OF A BLOCK IS, in one clause.
 *
 *  `PlayBlock.detail` is two to four sentences — right for a panel with a button in it, far too much
 *  for the single line this note gets. `short` says what is true; this says where to go, and the two
 *  together are the whole answer at the size the note has to fit in.
 *
 *  It names SURFACES, not sentences: the words about what to do belong to `playGate.ts` and are
 *  rendered in full by `ConnectPanel`. This only has to get a reader to the panel. The bottom bar's
 *  Connect button is named because it is on screen on all five screens and never scrolls away, so it
 *  is the one pointer that is true wherever this note is being read. */
function gateRoute(gate: PlayBlock): string {
  switch (gate.cta?.kind) {
    case "connect":
      return " Use Connect wallet in the bar at the bottom of the page.";
    case "install":
      return " Install Phantom, then reload this page.";
    case "faucet":
      return " Devnet SOL is free at faucet.solana.com.";
    case "retry":
      return " Reload the page.";
    default:
      // `no-program` and `connecting` both end on their own, and `short` has already said so. A
      // manufactured instruction here would be an action where there genuinely is none.
      return "";
  }
}

/** The `.u` label for a gated state: the dock's head, its collapsed handle, and the word a screen
 *  reader hears announced. One or two words, because the handle is a corner and `.dock-handle` sets
 *  10px tracked uppercase on a single line — `cta.label` is button copy ("Get devnet SOL", "Reload
 *  the page") and overflows it. Same meaning, handle-sized. */
function gateLabel(gate: PlayBlock): string | null {
  switch (gate.cta?.kind) {
    case "connect":
      return "Connect";
    case "install":
      return "Install";
    case "faucet":
      return "Needs SOL";
    case "retry":
      return "Reload";
    default:
      return null;
  }
}

/**
 * THE ROUND'S STATE, AS IT APPLIES TO THE PERSON READING IT.
 *
 * The gate outranks the phase for the CONTROL — a button the reader cannot use must not be offered,
 * which is SPEC.md's rule — but it deliberately does NOT outrank the phase for the WORDS. A lobby
 * closing in fourteen seconds is closing in fourteen seconds whether or not a wallet is connected,
 * and replacing that with "no wallet is connected" would delete the one fact that tells a reader
 * whether it is worth connecting right now. So `now` and `timing` survive intact and only `action` —
 * the clause that answers "what can you do" — is taken over, because that answer really has changed.
 *
 * IT ONLY SPEAKS WHEN IT IS THE THING IN THE WAY. If the round is offering nothing anyway (Settled,
 * Drawing, a closed lobby), the round's own words are already the complete answer and the gate says
 * nothing at all — a settled round that nags a reader about a wallet they did not need is noise, and
 * `blocked` stays null so no surface mistakes it for a funnel.
 */
export function roundPhaseCopy(input: RoundPhaseInput): RoundPhaseCopy {
  const state = phaseCopy(input);
  // LAYERED ON ONCE, HERE, AND NEVER TOUCHED BY THE GATE BELOW — the same treatment `timing` gets and
  // for the same reason. What the round's clock is doing is a fact about the round; a reader with no
  // wallet is still owed it, and is in fact the reader most likely to be deciding off it.
  const base = { ...state, clockSlot: clockSlotFor(input, state) };
  const gate = input.gate ?? null;

  // Nothing in the way, or nothing being offered to get in the way of.
  if (gate === null || base.control === "none") return { ...base, blocked: null };

  // A GATE MUST NOT EVICT A CONTROL WHILE THAT CONTROL'S OWN TRANSACTION IS STILL SUBMITTING.
  //
  // The gate can turn non-null mid-send — Phantom disconnects, or the balance poll lands at zero
  // after the fee was spent — and swapping `control` to "none" at that moment unmounts the deploy
  // or extract body, taking its "Sending…" line with it and replacing it with a connect funnel.
  // Nothing is corrupted (`useActions` keeps its own `entering`/`extracting`, and `requireReady`
  // re-checks the gate at click time so a button and its transaction can never disagree), but the
  // reader loses every trace that their transaction exists, at the one moment they are watching for
  // it. The controls inside are already disabled by `entering`/`extracting`, so keeping the body is
  // not an offer to press anything — it is the receipt staying on screen until the send resolves.
  if (input.inFlight === true) return { ...base, blocked: null };

  return {
    ...base,
    control: "none",
    blocked: base.control,
    // The label is the dock's head and its collapsed handle — one word standing in for the move on
    // offer. With the move withdrawn, it names what would restore it instead of the move itself,
    // which is what stops a handle reading "Deploy" over a panel that cannot deploy. A block with no
    // control to offer (`no-program`, `connecting`) keeps the round's own label: both end on their
    // own and neither is something to press.
    label: gateLabel(gate) ?? base.label,
    action: `${asSentence(gate.short)}${gateRoute(gate)}`,
  };
}
