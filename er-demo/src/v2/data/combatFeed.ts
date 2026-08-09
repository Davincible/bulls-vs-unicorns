// THE FIGHT'S RECENT PAST, cut out of the precomputed hit stream once per tick.
//
// ONE SOURCE. `hitEvents` is the same stream the canvas replays and the verifier diffs against the
// chain — computed once when the seed reveals, never re-derived. This resolves a WINDOW of it against
// the current roster and hands back `contract.ts`'s `CombatEvent`, which is the shape the log and the
// toast rail were both written against. Nothing here decides who hit whom; `sim/erSim.ts` did that,
// on chain the program does, and a second opinion about it is the one thing this module must not be.
//
// IT MUST NOT SCAN THE STREAM, and that is the whole design constraint. The fight runs at
// `stepsPerSecond(n) = n * 2` and the readouts re-render four times a second, so anything O(events)
// here would walk up to `MAX_STEPS` entries four times a second for as long as a fight lasts. The
// stream is ordered by step and never reordered, so finding the cursor is a binary search and the
// window is a slice: O(log n) and a bounded allocation, whatever the fight is doing.
//
// The other half of the cheapness is the caller's: the stream itself is memoised on primitive keys
// (`useLiveRound.ts`'s seed hex and entries key) precisely so a 1.5s poll returning a fresh
// `RoundState` cannot re-run the fight. This module inherits that — it is handed the memoised array
// and never asks for it to be rebuilt.

import type { HitEvent } from "../../sim/hitEvents.ts";
// `MAX_FIGHTERS` from the sim rather than `chain/constants.ts`, which does not carry it: `erSim.ts`
// is the maintained mirror of the Rust's own cap and the parity tests fail if it drifts.
import { MAX_FIGHTERS } from "../../sim/erSim.ts";
import { stepsPerSecond } from "../../chain/constants.ts";
import type { CombatEvent, CombatFeed, FighterView } from "../contract.ts";

/** HOW MANY EXCHANGES THE WINDOW HOLDS, and the number is arithmetic rather than taste.
 *
 *  The window has to be big enough that a consumer which only looks once per throttle interval still
 *  sees everything it was owed. The fastest this program can produce exchanges is a full lobby:
 *  `stepsPerSecond(MAX_FIGHTERS)` = 32 a second, one per step. Four seconds of that is 128, which
 *  covers the toast rail's coalescing window (3s, `ui/combatFeed.ts`) with a second to spare for a
 *  dropped frame or a tab that was briefly backgrounded. A two-fighter duel runs at 4 a second, so
 *  the same window there is half a minute of fight.
 *
 *  It is deliberately larger than any log would render. A log shows the last handful and slices; the
 *  cost of the surplus is a bounded array of small objects rebuilt on a tick that already rebuilds
 *  the entire roster, and the cost of being too small is a hit that happened and was never said. */
export const COMBAT_WINDOW = stepsPerSecond(MAX_FIGHTERS) * 4;

/** Index of the first event AFTER `cursor` — i.e. the exclusive end of the window, and the count of
 *  events that have happened. Binary search over a list this module never reorders; see the header
 *  for why a walk is not acceptable here. */
function endOfWindow(hits: readonly HitEvent[], cursor: bigint): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].step <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface CombatFeedParams {
  /** The whole precomputed fight, ascending by step. Empty outside Fight/Settled. */
  hitEvents: readonly HitEvent[];
  /** The current roster, indexed exactly as the stream names its parties — `FighterView.id` is
   *  positional against this same array, and `liveRound.ts` keeps it that way. */
  fighters: readonly FighterView[];
  /** The replay playhead: `LiveRound.stepsNow`, which is the program's own `canonical_cursor()`. An
   *  event enters the feed at the instant the canvas draws it and the chain would agree it happened
   *  — not when a poll happens to notice. */
  stepsNow: number;
  /** Test seam. Defaults to `COMBAT_WINDOW`; nothing in the app passes it. */
  limit?: number;
}

/**
 * Cut the window and resolve it.
 *
 * A HIT WHOSE FIGHTERS CANNOT BE RESOLVED IS DROPPED, SILENTLY AND ON PURPOSE. `attackerId` indexes
 * the array the stream was computed against, and `FighterView.id` is documented to match — but the
 * two arrive from different reads, and there is a window on every entry to a fight where a poll has
 * landed a roster the stream has not been recomputed against yet. A resolver that threw there would
 * take the page down over a log line; one that invented a name would put a fighter who is not in the
 * round in front of a reader. Dropping is the only option that is merely incomplete.
 */
export function combatFeed({ hitEvents, fighters, stepsNow, limit }: CombatFeedParams): CombatFeed {
  const size = limit ?? COMBAT_WINDOW;
  // Floored and clamped: `stepsNow` is derived from a wall clock and a rate, so it is a real number,
  // and the stream's steps are integers. Comparing 12.4 against 12 the wrong way round would show an
  // exchange a fifth of a second before the canvas draws it.
  const at = Math.max(0, Math.floor(stepsNow));
  const end = endOfWindow(hitEvents, BigInt(at));
  const start = Math.max(0, end - size);

  const recent: CombatEvent[] = [];
  const mine: CombatEvent[] = [];
  for (let i = start; i < end; i++) {
    const hit = hitEvents[i];
    const attacker = fighters[hit.attackerId];
    const defender = fighters[hit.defenderId];
    if (attacker === undefined || defender === undefined) continue;
    const event: CombatEvent = {
      step: Number(hit.step),
      attacker,
      defender,
      amount: hit.amount,
      // Either party. A raid you landed and a raid you took are both news to you, and they are
      // different sentences — which is the consumer's problem, not this one's.
      mine: attacker.isYou || defender.isYou,
    };
    recent.push(event);
    if (event.mine) mine.push(event);
  }

  return { recent, mine, at };
}

/** The empty feed, for the moments there is no fight to report: a lobby, a round being drawn, or a
 *  settled round whose seed this page never saw. A shared constant rather than a fresh object per
 *  call, so a consumer memoising on `combat` is not re-run once a second by a round that is not
 *  fighting. */
export const NO_COMBAT: CombatFeed = { recent: [], mine: [], at: 0 };
