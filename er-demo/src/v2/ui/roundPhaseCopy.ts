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
  entriesOpen,
  entrySecondsLeft,
  type LiveRound,
} from "../contract.ts";

/** When the state changes, in the only two honest shapes there are.
 *
 *  `countdown` renders its seconds through `clock()` as tabular figures — the caller splits the
 *  sentence around the number rather than baking it into a string, so the figure can be marked up
 *  as a figure. `waiting` is the whole sentence: no number exists, and inventing one is the bug. */
export type PhaseTiming =
  | { kind: "countdown"; before: string; seconds: number; after: string }
  | { kind: "waiting"; text: string };

export interface RoundPhaseCopy {
  /** Which body a control surface should show: the deploy buttons, the extract button, or neither.
   *  Derived from `entriesOpen()`, never from the phase alone. */
  control: "deploy" | "extract" | "none";
  /** Two or three words for the `.u` label. Changes rarely enough to be announced politely. */
  label: string;
  /** (1) What is true now. */
  now: string;
  /** (2) What the player can do — or plainly that there is nothing. */
  action: string;
  /** (3) When it changes. */
  timing: PhaseTiming;
}

export interface RoundPhaseInput {
  live: LiveRound | null;
  /** Epoch ms, ticked once a second by the caller. */
  nowMs: number;
  /** No program: nothing on the page can reach the chain, which outranks every phase. */
  programError: boolean;
  /** The first round fetch is still in flight. */
  loading: boolean;
  /** WHEN THE NEXT LOBBY OPENS, in epoch ms — or null, which is what it is today and the reason
   *  this is an input at all.
   *
   *  Rounds are opened by a person running `scripts/`; there is no keeper, no schedule on chain, and
   *  therefore no instant to count down to. The Settled state below renders the honest waiting
   *  sentence while this is null and a real countdown the moment it is a number, so the cadence
   *  drops in without a rewrite of the copy or of either surface. See `useRoundPhase()` in
   *  `RoundPhaseNote.tsx` for the one line that will feed it. */
  nextLobbyOpensAtMs: number | null;
}

/** THE ONE SENTENCE THAT MUST NEVER BE FAKED, factored out because Settled and Abandoned both end
 *  in it: a round is over, and the way back in is a lobby nobody has scheduled. */
function nextLobbyTiming(nextLobbyOpensAtMs: number | null, nowMs: number): PhaseTiming {
  if (nextLobbyOpensAtMs === null) {
    return {
      kind: "waiting",
      text: "No timer for the next one — it opens when we start it.",
    };
  }
  return {
    kind: "countdown",
    before: "Next lobby in",
    seconds: Math.max(0, Math.ceil((nextLobbyOpensAtMs - nowMs) / 1000)),
    after: ".",
  };
}

export function roundPhaseCopy(input: RoundPhaseInput): RoundPhaseCopy {
  const { live, nowMs, programError, loading, nextLobbyOpensAtMs } = input;

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
      timing: nextLobbyTiming(nextLobbyOpensAtMs, nowMs),
    };
  }

  const no = live.roundNo.toString();

  switch (live.phase) {
    case "Lobby": {
      if (entriesOpen(live, nowMs)) {
        const secondsLeft = entrySecondsLeft(live, nowMs);
        return {
          control: "deploy",
          label: "Open",
          now: `Round ${no} is open.`,
          action: "Pick a side and deploy.",
          timing:
            // Null is a real state, not a missing read: a round opened by a program revision without
            // `lobby_closes_at` has no deadline to show (see `LiveRound.lobbyClosesAtMs`). Saying so
            // is the honest fallback; a countdown invented from a client-side constant would be the
            // one thing worse than none.
            secondsLeft === null
              ? {
                  kind: "waiting",
                  text: "No close time set — it can close any moment.",
                }
              : {
                  kind: "countdown",
                  before: "Closes in",
                  seconds: secondsLeft,
                  after: ".",
                },
        };
      }
      // THE WINDOW THE OLD COPY HAD NO WORDS FOR. `enter` is refused from `lobby_closes_at`, but the
      // phase only leaves Lobby when an operator's `close_lobby_and_draw` lands — a separate
      // transaction, sent at a human's pace. Between the two, this round says "Lobby" and refuses
      // every deposit sent to it.
      return {
        control: "none",
        label: "Closed",
        now: `Round ${no} stopped taking deposits.`,
        action: "Too late to join this one — a deposit now gets rejected.",
        timing: {
          kind: "waiting",
          text: "The fight starts once we draw the seed.",
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
      const youAreIn = live.fighters.some((f) => f.isYou);
      return {
        control: "extract",
        label: "Fighting",
        now: `Round ${no} is fighting.`,
        action: youAreIn
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
        timing: nextLobbyTiming(nextLobbyOpensAtMs, nowMs),
      };

    case "Abandoned":
      return {
        control: "none",
        label: "Round expired",
        // `abandon_round` ends a lobby that reached its deadline holding fewer than two fighters.
        // There is no winner, no seed and no fight in one — so it must not read as settled.
        now: `Round ${no} expired — fewer than two players joined.`,
        action: "No fight to watch.",
        timing: nextLobbyTiming(nextLobbyOpensAtMs, nowMs),
      };
  }
}
