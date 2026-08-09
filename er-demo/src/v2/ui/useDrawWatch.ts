// HOW LONG THE DRAW HAS BEEN TAKING — the one dead end on this screen the chain gives no field for.
//
// `Phase::Drawing` has NO ON-CHAIN EXIT. `close_lobby_and_draw` moves a round into it and only the
// VRF callback moves it out; `abandon_round` accepts `Lobby` and nothing else. So a callback that
// never lands leaves the round wedged there permanently, and every surface on this page renders a
// spinner-shaped sentence at it — "the fight starts as soon as it lands, usually seconds" — for as
// long as anybody keeps the tab open. That sentence is true for the first few seconds and a lie for
// the rest of the hour.
//
// THE MEASUREMENT IS THIS BROWSER'S, AND IT SAYS SO. There is no `drawingStartedAt` on the round
// account, and there is no honest way to derive one: `fightStartedAtMs` is null until Fight and
// `elapsedSec` is 0 throughout. What this page CAN state without inventing anything is how long IT
// has been watching — which is a weaker claim than "the draw has been stuck for N", is never wrong,
// and is enough to tell a reader that waiting further is not the plan. A visitor arriving late sees
// a smaller number than one who was here at the start, and the copy is written so that is fine.

import { useEffect, useRef } from "react";
import { FIGHT_TIMEOUT_SECONDS } from "../contract.ts";
import { useSecondTick } from "./useSecondTick.ts";

/** HOW LONG A DRAW MAY RUN BEFORE THE PAGE STOPS CALLING IT NORMAL, in seconds.
 *
 *  Half the fight bell (`FIGHT_TIMEOUT_SECONDS`), which makes it a proportion of the program's own
 *  clock rather than a number somebody liked. The reasoning: a VRF callback lands in seconds when it
 *  lands at all, and by the time a draw has taken longer than half a whole fight there is no reading
 *  of "usually seconds" left to defend. Deliberately far above any plausible slow callback, so
 *  crossing it is information and not a false alarm. */
export const DRAW_STALL_SECONDS = FIGHT_TIMEOUT_SECONDS / 2;

export interface DrawWatch {
  /** Seconds THIS TAB has had the round on screen in `Drawing`. Never a claim about the chain. */
  watchedSec: number;
  /** Past `DRAW_STALL_SECONDS`. The surfaces stop saying "usually seconds" from here. */
  stalled: boolean;
}

/**
 * @param drawing whether the round on screen is in `Phase::Drawing` right now.
 * @param roundNo the round being watched — a new round restarts the count, and a round moving out
 *   of Drawing and back (which cannot happen on chain, but can on a reconnect that re-reads a stale
 *   account) restarts it too, because the clock belongs to a round-in-a-phase and not to a phase.
 */
export function useDrawWatch(drawing: boolean, roundNo: bigint | null): DrawWatch | null {
  // The instant this tab first saw THIS round drawing. A ref rather than state: writing it would
  // re-render, and the second-tick below is already the render that matters.
  const startedRef = useRef<{ round: bigint | null; atMs: number } | null>(null);
  const nowMs = useSecondTick(drawing);

  useEffect(() => {
    if (!drawing) {
      startedRef.current = null;
      return;
    }
    if (startedRef.current?.round !== roundNo) {
      startedRef.current = { round: roundNo, atMs: Date.now() };
    }
  }, [drawing, roundNo]);

  if (!drawing) return null;
  // The first render after the phase flips runs BEFORE the effect above, so there is no start mark
  // yet. Zero is the honest answer for that one frame, not a reason to render nothing.
  const started = startedRef.current?.round === roundNo ? startedRef.current.atMs : nowMs;
  const watchedSec = Math.max(0, Math.floor((nowMs - started) / 1000));
  return { watchedSec, stalled: watchedSec >= DRAW_STALL_SECONDS };
}
