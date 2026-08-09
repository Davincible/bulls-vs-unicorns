// The render layer's own "replay" of the fight — an `ERFighter[]` seeded from each `RenderFighter`'s
// `stake` (see types.ts on why that IS the starting hp) and advanced by applying `hitEvents` up to
// wherever the wall-clock playhead currently is.
//
// This deliberately reuses `sim/hitEvents.ts`'s own `applyHitEvent` rather than re-deriving hp/banked
// bookkeeping here — the exact same reasoning `erSim.ts`'s `tick()` gives for taking an `onHit`
// callback instead of being duplicated: two copies of "how does one hit change fighter state" is how
// the DUST-floor bug happened in the first place. `hitEvents.test.ts` already proves
// `applyHitEvent`'s replay reaches the identical fixture numbers `tick()`'s own mutation does — this
// module leans on that proof rather than re-establishing it.
import { applyHitEvent, type HitEvent } from "../sim/hitEvents.ts";
import type { ERFighter } from "../sim/erSim.ts";
import type { RenderFighter } from "./types.ts";

/** Builds the "instant the lobby closed" state for every fighter: full hp (= net-of-fee stake),
 *  nothing banked, dead only if the caller already knows it (see `RenderFighter.dead`'s own
 *  comment — this seeds the extraction case, `tick()`'s own hit selection re-derives everything
 *  else). Array order/index is preserved — callers rely on `shadow[id]` matching `RenderFighter.id`
 *  and `HitEvent.attackerId`/`defenderId`. */
export function buildShadowFighters(fighters: RenderFighter[]): ERFighter[] {
  return fighters.map((f) => ({
    wallet: f.wallet,
    side: f.side,
    dead: f.dead ? 1 : 0,
    stake: f.stake,
    hp: f.dead ? 0n : f.stake,
    banked: 0n,
  }));
}

/** Applies `events[fromCursor..toCursor)` to `shadow` in place — the incremental step gameLoop.ts
 *  takes each frame as the playhead crosses newly-due events. `fromCursor`/`toCursor` rather than a
 *  single "apply the next event" call so a frame that's behind (e.g. after a dropped/slow frame) can
 *  catch up in one pass without the caller looping itself. */
export function advanceShadow(shadow: ERFighter[], events: HitEvent[], fromCursor: number, toCursor: number): void {
  for (let i = fromCursor; i < toCursor; i++) applyHitEvent(shadow, events[i]);
}
