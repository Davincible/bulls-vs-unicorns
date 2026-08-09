// THE CONNECTOR — the one place the keeper's published status becomes something the phase copy can
// render, and the only place in `ui/` that is allowed to know the keeper exists.
//
// `data/keeperStatus.ts` already owns every honesty rule about that file, and `keeperCountdown()` is
// where they are written down. This module does not re-derive any of them. It does exactly two
// things the pure `keeperCountdown` cannot do by itself:
//
//   1. It folds in `useKeeperStatus()`'s OWN staleness clock (`stale`), which is not redundant with
//      the one inside `keeperCountdown`. See `roundCadence` — the `nowMs` this page has is
//      deliberately frozen whenever nothing is counting down, so a keeper that dies during a settled
//      round would never age past `staleAfterSeconds` if this asked `keeperCountdown` alone.
//
//   2. It separates the two situations `keeperCountdown` deliberately collapses into `none`:
//      "a keeper is publishing here and has nothing honest to say" from "nothing is publishing here
//      at all". Both mean the keeper contributes no number — but they mean OPPOSITE things about the
//      chain's own `lobby_closes_at`, and getting that backwards is how the 59:47 countdown reaches a
//      player. See `Cadence` below, where the distinction is spelled out.
//
// It is pure and takes its clock as an argument, so every case is a unit test rather than a browser
// session (`keeperCadence.test.ts`) — which matters, because most of these cases are ones the keeper
// only produces when something has gone wrong.

import { createContext, useContext } from "react";
import { keeperCountdown } from "../data/keeperStatus.ts";
import type { KeeperStatusResult } from "../data/useKeeperStatus.ts";

/**
 * WHAT THE PAGE MAY SAY ABOUT TIME, this instant.
 *
 * The first three cases are `keeperCountdown`'s own, passed through untouched — the keeper is up,
 * progressing, and has an answer. The last two are both `keeperCountdown`'s `none`, split apart,
 * and the split is the whole reason this type is not just `KeeperCountdown`:
 *
 *   * `keeper-silent` — a keeper IS publishing here, and right now it has no honest number: it has
 *     gone stale, or it is stalled, or the round is mid-draw or mid-fight, or a deadline has already
 *     passed. The page must show NO countdown, and specifically must NOT reach past the keeper for
 *     the chain's `lobby_closes_at` instead. Under the hold-open policy that field is an hour-away
 *     backstop the keeper never intends to reach, and rendering it produces "closes in 59:47" over a
 *     lobby whose real schedule is twenty seconds long — the dead-room reading this whole mechanism
 *     exists to delete.
 *
 *   * `no-keeper` — nothing is publishing here: no status file (a 404 is the NORMAL response where a
 *     keeper has never run, and is not an error), or one this build cannot parse. Nobody is holding
 *     any lobby open, so the chain's own deadline is both the schedule and the backstop, and it is
 *     the honest number to show. This is the pre-keeper page, the `?fixture=1` page, and the page an
 *     operator sees when they open a round by hand — all three of which shipped counting down
 *     `lobby_closes_at` and were right to.
 */
export type Cadence =
  /** Entries stop at a time the keeper has committed to. Seconds, whole, never negative, never 0
   *  while live — ceiled by `keeperCountdown`. */
  | { kind: "entries-close"; seconds: number }
  /** The next lobby opens at a time the keeper has committed to. Same guarantees. */
  | { kind: "next-lobby"; seconds: number }
  /** The lobby is open and waiting for a PERSON, not for a clock. Carries no seconds because none
   *  exists — see `KeeperCountdown` in `data/keeperStatus.ts`. The page has a specific, inviting
   *  sentence for this, and it is not a timer stuck at zero. */
  | { kind: "waiting-for-players" }
  /** A keeper is publishing and has no honest number — see the type doc. */
  | { kind: "keeper-silent" }
  /** No keeper is publishing here at all — see the type doc. */
  | { kind: "no-keeper" };

/**
 * Turn one poll of the keeper's status file into the cadence the copy renders.
 *
 * @param result exactly what `useKeeperStatus()` returns — both halves are load-bearing.
 * @param nowMs epoch MILLISECONDS (the page's clock). The file is in SECONDS, so this is the one
 *        conversion in the chain and it happens here, once, on the way in.
 */
export function roundCadence(result: KeeperStatusResult, nowMs: number): Cadence {
  const { status, stale } = result;

  // No parsed status: a 404 (normal — no keeper has ever run here), a network failure, a body that
  // is not JSON, or a schema this build does not know. `useKeeperStatus` deliberately collapses all
  // of those into one value, and they are one answer here too: nothing is publishing a schedule.
  if (status === null) return { kind: "no-keeper" };

  // THE HOOK'S LIVENESS CLOCK, ASKED SEPARATELY, AND IT IS NOT BELT-AND-BRACES. `keeperCountdown`
  // re-asks `isKeeperStale` against the `nowSec` it is handed — but the clock this page has is
  // `useSecondTick`, which is switched OFF whenever nothing is counting down. On a settled round with
  // no scheduled lobby that clock is frozen at the second the component mounted, so a keeper that
  // dies a minute later would never age past `staleAfterSeconds` by that reckoning. `useKeeperStatus`
  // runs its own once-a-second interval against `Date.now()` precisely so a dying keeper goes stale
  // on screen with no fetch and no page tick involved; this is where that answer is consumed.
  if (stale) return { kind: "keeper-silent" };

  // Everything else is `keeperCountdown`'s to decide, and none of it is re-derived here: stalled
  // (alive but getting nowhere — a separate question from stale, and the keeper answers it itself),
  // no round, a deadline already passed, mid-Drawing, mid-Fight, held open, entries closing, next
  // lobby. Each of its `none`s is a moment where no honest number exists, so each of them lands on
  // `keeper-silent` — a keeper IS here, it just has nothing to say.
  const countdown = keeperCountdown(status, nowMs / 1000);
  return countdown.kind === "none" ? { kind: "keeper-silent" } : countdown;
}

// ---------------------------------------------------------------------------------------------
// One poll, shared
// ---------------------------------------------------------------------------------------------

/** THE STATUS FILE IS FETCHED ONCE FOR THE WHOLE PAGE, and this is why it has to be.
 *
 *  `useRoundPhase()` is called from `RoundPhaseNote` — which is on screen up to five times at once —
 *  and from `StakeDock` and `ArenaView` besides. `useKeeperStatus()` opens an interval and a fetch
 *  loop per call, so calling it there directly would put seven independent two-second polls of the
 *  same file on the wire, seven staleness clocks that can disagree by up to a second, and seven
 *  chances for two surfaces to render different answers to the same question at the same instant.
 *  One provider, one poll, one answer.
 *
 *  The default is the truthful one for a tree with no provider above it: nothing has told us
 *  anything about a keeper, which reads as `no-keeper` and shows no invented countdown. */
export const KeeperStatusContext = createContext<KeeperStatusResult>({ status: null, stale: true });

export function useSharedKeeperStatus(): KeeperStatusResult {
  return useContext(KeeperStatusContext);
}
