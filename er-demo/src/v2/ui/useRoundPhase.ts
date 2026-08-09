// THE ROUND'S STATE IN WORDS, LIVE — the hook half of `RoundPhaseNote.tsx`.
//
// It is the only place that wires the pure copy (`roundPhaseCopy.ts`) to the two things it cannot be
// pure about: the clock a countdown needs, and the keeper's published cadence.
//
// Separate from the component because a surface can want the DECISION without the markup — the dock
// picks which body to render off `control`, and that decision (`entriesOpen()`, never a phase check)
// has to be the same one the words are written against or the panel says "entries closed" over a
// live Deploy button.

import { useArena } from "../data/useArena.ts";
import { roundCadence, useSharedKeeperStatus } from "./keeperCadence.ts";
import { roundPhaseCopy, type RoundPhaseCopy } from "./roundPhaseCopy.ts";
import { useSecondTick } from "./useSecondTick.ts";

/** Safe to call from more than one component: each gets its own second-resolution clock, they agree
 *  because both are reading `Date.now()`, and they share ONE poll of the keeper's status file
 *  (`KeeperStatusProvider`) rather than opening one apiece. */
export function useRoundPhase(): RoundPhaseCopy {
  const { live, status } = useArena();
  const keeper = useSharedKeeperStatus();

  /** THE CONNECTOR, in the one place it does not need a clock — deciding whether to run one.
   *
   *  A published `nextLobbyOpensAt` from a keeper that is up is the only thing that makes a SETTLED
   *  round count down; every other countdown on this page belongs to a phase that ticks anyway. It is
   *  read straight off the status here rather than out of `roundCadence` below because that would be
   *  circular: the cadence needs `nowMs`, and `nowMs` is what this decides.
   *
   *  Both guards are load-bearing and neither is this file's to relax. A STALE keeper's next-open
   *  time is a promise from a process that has stopped, and the field is already null wherever the
   *  keeper has no honest answer. This deliberately does NOT try to be the whole rule — a stalled
   *  keeper, a passed deadline and a mid-fight round all still reach `roundCadence`, which asks
   *  `keeperCountdown` and gets every one of them right. The cost of this line being generous is one
   *  interval that changes no visible number; the cost of `roundCadence` being generous would be a
   *  wrong number on screen, which is why the honesty rule lives there and not here. */
  const scheduledLobby =
    keeper.status !== null && !keeper.stale && keeper.status.nextLobbyOpensAt !== null;

  // Tick only while something is genuinely counting down: the lobby deadline, the bell, or a
  // published next-lobby instant. A settled round with no cadence is static text and costs nothing.
  const phase = live?.phase ?? null;
  const ticking = phase === "Lobby" || phase === "Fight" || scheduledLobby;
  const nowMs = useSecondTick(ticking);

  return roundPhaseCopy({
    live,
    nowMs,
    programError: status.programError !== null,
    loading: status.loading,
    cadence: roundCadence(keeper, nowMs),
  });
}
