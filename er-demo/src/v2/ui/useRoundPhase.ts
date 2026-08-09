// THE ROUND'S STATE IN WORDS, LIVE — the hook half of `RoundPhaseNote.tsx`.
//
// It is the only place that wires the pure copy (`roundPhaseCopy.ts`) to the two things it cannot be
// pure about: the clock a countdown needs, and where the "next lobby opens at" instant comes from.
//
// Separate from the component because a surface can want the DECISION without the markup — the dock
// picks which body to render off `control`, and that decision (`entriesOpen()`, never a phase check)
// has to be the same one the words are written against or the panel says "entries closed" over a
// live Deploy button.

import { useArena } from "../data/useArena.ts";
import { roundPhaseCopy, type RoundPhaseCopy } from "./roundPhaseCopy.ts";
import { useSecondTick } from "./useSecondTick.ts";

/** Safe to call from more than one component: each gets its own second-resolution clock, and they
 *  agree because both are reading `Date.now()`. */
export function useRoundPhase(): RoundPhaseCopy {
  const { live, status } = useArena();

  /** WHERE THE CADENCE WILL COME FROM, and why it is null today.
   *
   *  A round is opened by a person running the operator script. Nothing schedules the next one:
   *  there is no keeper process, and the arena account carries no "next round opens at" field — so
   *  there is no instant to count down to, and manufacturing one would be a timer to an event with
   *  no cause. That is the same class of lie as an unbacked money figure, which this page refuses
   *  everywhere else, so the Settled state says plainly that there is no schedule instead.
   *
   *  THE KEEPER BEING BUILT ALONGSIDE THIS IS WHAT FEEDS IT, and the field already has a name:
   *  `data/keeperStatus.ts`'s `KeeperStatus.nextLobbyOpensAt` — unix SECONDS, non-null only while
   *  the keeper is holding between rounds and the next open time is genuinely known. Once that
   *  module is wired into the provider, this line becomes one expression:
   *
   *      const { status: keeper } = useArena();   // or whatever the provider exposes it as
   *      const nextLobbyOpensAtMs =
   *        keeper !== null && !isKeeperStale(keeper, nowSec) && keeper.nextLobbyOpensAt !== null
   *          ? keeper.nextLobbyOpensAt * 1000
   *          : null;
   *
   *  Both guards are load-bearing and neither is this module's to relax: a STALE keeper's next-open
   *  time is a promise from a process that has stopped, which is the same lie in a different costume,
   *  and the field is already null wherever there is no honest answer.
   *
   *  Everything downstream handles both worlds today: `roundPhaseCopy`'s Settled and Abandoned
   *  branches render a countdown when it is a number and the honest waiting sentence when it is not,
   *  the tick below turns itself on for it, and both are covered by `roundPhaseCopy.test.ts`. No copy
   *  and no markup moves. */
  const nextLobbyOpensAtMs: number | null = null;

  // Tick only while something is genuinely counting down: the lobby deadline, the bell, or a
  // published next-lobby instant. A settled round with no cadence is static text and costs nothing.
  const phase = live?.phase ?? null;
  const ticking = phase === "Lobby" || phase === "Fight" || nextLobbyOpensAtMs !== null;
  const nowMs = useSecondTick(ticking);

  return roundPhaseCopy({
    live,
    nowMs,
    programError: status.programError !== null,
    loading: status.loading,
    nextLobbyOpensAtMs,
  });
}
