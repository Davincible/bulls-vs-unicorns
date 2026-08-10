// THE FIGHT IS A REPLAY, NOT A SIMULATION.
//
// The outcome was decided the moment the VRF seed was revealed: `run_fight()` picks attacker and
// defender by `hash(seed, step) % n`, with no positions and no collisions. `sim/hitEvents.ts` has
// already turned that into an ordered `HitEvent[]`. This module's only job is to advance a playhead
// through that array at exactly the rate the chain derives its own step count at, and to keep a
// local copy of hp/banked/dead in step with it.
//
// Ported from `render/shadowFight.ts` + `render/gameLoop.ts`'s `playheadStep`, with the same
// reasoning and two deliberate differences:
//
//   1. The pace comes from `v2/contract.ts` (which re-exports `chain/constants.ts`, the maintained
//      mirror of lib.rs), not from gameLoop.ts, whose constants are stale twice over. THE RATE IS
//      PER FIGHTER — `stepsPerSecond(n) = n * 2` — because a fight's length in steps grows ~n^1.5,
//      so no flat rate paces both a two-fighter duel and a sixteen-fighter brawl. A canvas running
//      on a flat 175/s would play a sixteen-fighter fight roughly five times faster than the chain
//      settles it, and finish a duel in under a second.
//   2. `resetReplay` exists at all. gameLoop.ts only ever advances a cursor forward through one
//      immutable array; v2 has to survive the array being REPLACED mid-fight (an `extract()` forces
//      the data layer to recompute the stream from the extraction point on). A cursor into the old
//      array means nothing in the new one, so the only correct move is to re-derive the whole
//      replay from step 0 — which is cheap, because it is a pure fold over at most
//      `finalCursor(fighterCount)` events: 720 for a duel, 17,280 at the 48-fighter ceiling.
//
// Nothing here is a second opinion about fight state: `applyHitEvent` is `sim/hitEvents.ts`'s own,
// the same function `hitEvents.test.ts` already proves reaches identical numbers to `tick()`'s
// internal mutation. Two implementations of "what does one hit do" is how the DUST-floor bug got in.

import { applyHitEvent, type HitEvent } from "../../sim/hitEvents.ts";
import type { ERFighter } from "../../sim/erSim.ts";
import { finalCursor, stepsPerSecond, type FighterView } from "../contract.ts";

export interface ReplayState {
  /** Indexed by `FighterView.id`, which is the same index `HitEvent.attackerId`/`defenderId` use. */
  shadow: ERFighter[];
  /** How many events of the current stream have been applied. */
  cursor: number;
}

/** Where the playhead is, as a float step count — this canvas's sub-second twin of the program's own
 *  `canonical_cursor()`. Returns a float on purpose: it converges to the chain's integer
 *  `min(floor(elapsed), FIGHT_TIMEOUT_SECONDS) * stepsPerSecond(n)` at every whole-second boundary,
 *  which is the only place the chain itself ever moves, and the fractional part in between exists
 *  purely to make the animation smooth. It never changes which events have "happened" at a second
 *  mark. Clamped here to `finalCursor(n)` — the same bell, expressed as the per-lineup step ceiling
 *  this function's return type actually wants.
 *
 *  `fighterCount` is the WHOLE lineup, dead included — `canonical_cursor()` takes
 *  `round.fighters.len()`, and a fight that sped up as players were knocked out would drift away
 *  from the settlement it is supposed to be a picture of.
 *
 *  `nowEpochMs` must be on the SAME clock as `fightStartedAtMs`, i.e. `Date.now()`'s epoch. A rAF
 *  timestamp is relative to `performance.timeOrigin`; handing one in directly yields a permanently
 *  negative (clamped-to-0) playhead and a fight that never starts. gameLoop.ts learned that in a
 *  browser rather than by reading the code, which is why it is spelled out here too. */
export function playheadStep(
  fightStartedAtMs: number | null,
  fighterCount: number,
  nowEpochMs: number,
): number {
  if (fightStartedAtMs === null) return 0;
  const elapsedSeconds = Math.max(0, (nowEpochMs - fightStartedAtMs) / 1000);
  return Math.min(elapsedSeconds * stepsPerSecond(fighterCount), finalCursor(fighterCount));
}

/** The instant the lobby closed: everyone at full hp (= net-of-fee stake), nothing banked, nobody
 *  dead — INCLUDING anyone the props currently report as dead.
 *
 *  That last part is not an oversight. A recomputed stream still contains the pre-extraction events
 *  in which an extracted fighter was attacker or defender; seeding them at hp 0 would drive their
 *  hp negative as those events replay. Their exit is applied afterwards, once, by
 *  `applyExtractions()` — which is also chronologically honest, since extraction happens at the
 *  playhead, not before the fight. */
function buildShadow(fighters: FighterView[]): ERFighter[] {
  return fighters.map((f) => ({
    wallet: f.wallet,
    side: f.side,
    dead: 0,
    stake: f.stake,
    hp: f.stake,
    banked: 0n,
  }));
}

export function createReplay(fighters: FighterView[]): ReplayState {
  return { shadow: buildShadow(fighters), cursor: 0 };
}

/** Re-derives the whole replay from scratch and parks the cursor at `step` — SILENTLY. No impact FX
 *  is fired for anything crossed here, because nothing was crossed: these hits already happened (a
 *  fresh mount into a fight in progress, or a stream swapped underneath us). Firing them would dump
 *  the entire fight's worth of rings onto the field in one frame. */
export function resetReplay(
  state: ReplayState,
  fighters: FighterView[],
  events: HitEvent[],
  step: number,
): void {
  state.shadow = buildShadow(fighters);
  let cursor = 0;
  while (cursor < events.length && Number(events[cursor].step) <= step) {
    applyHitEvent(state.shadow, events[cursor]);
    cursor++;
  }
  state.cursor = cursor;
}

/** How many of a frame's crossed events may ANNOUNCE themselves — see `advanceReplay`.
 *
 *  At the program's cap of sixteen fighters the chain lands ~16 hits a second against a 60Hz loop,
 *  so a healthy frame crosses about a quarter of an event and even a 200ms hitch crosses three. This
 *  is therefore unreachable in normal play and fires only on a genuine stall. */
const MAX_ANNOUNCED = 3;

/** Advances to `step`, calling `onEvent` for each newly-crossed hit — this is the ONLY path that
 *  fires impact FX. Loops rather than applying one event per frame so a frame that arrives late
 *  (a stall, a backgrounded tab) catches up in a single pass instead of playing the fight back in
 *  slow motion for however long it takes the cursor to walk the backlog.
 *
 *  …AND THAT CATCH-UP IS WHY `onEvent` GETS A SECOND ARGUMENT. Backgrounding the tab stops rAF while
 *  the playhead keeps running on wall clock, so the first frame back crosses the entire backlog — a
 *  minute hidden at sixteen fighters is around a thousand events, every one of them arriving in one
 *  callback with one identical `nowMs`. `resetReplay` already refuses to announce hits that "already
 *  happened"; these are the same hits arriving down the other path, and left unmarked they would
 *  detonate a thousand shockwaves on one frame and stack a thousand impulses into bodies that then
 *  ricochet off the walls for a second. (The per-mark throttles do not save it: they are spacings in
 *  MILLISECONDS, and every event in a burst shares a timestamp.)
 *
 *  So the fight state still advances for every event — hp, deaths and the settled outcome are
 *  untouched, exactly as before — and only the last `MAX_ANNOUNCED` of them are allowed to say so.
 *  The count is resolved BEFORE anything is applied, because the caller needs to know an event is
 *  the tail of a burst at the moment it is handed over, not afterwards. */
export function advanceReplay(
  state: ReplayState,
  events: HitEvent[],
  step: number,
  onEvent: (event: HitEvent, announce: boolean) => void,
): void {
  let end = state.cursor;
  while (end < events.length && Number(events[end].step) <= step) end++;
  const quietUntil = end - MAX_ANNOUNCED;

  while (state.cursor < end) {
    const event = events[state.cursor];
    applyHitEvent(state.shadow, event);
    const announce = state.cursor >= quietUntil;
    state.cursor++;
    onEvent(event, announce);
  }
}

/** Overlays the one thing the event stream cannot express: `extract()`.
 *
 *  Extraction takes a live fighter's ring value out of play without producing a `HitEvent` (see
 *  `sim/hitEvents.ts` on why it doesn't need to). The chain reports it as `dead` on the next poll,
 *  and the canvas has to honour that IMMEDIATELY — an extracted fighter that keeps getting targeted
 *  is the exact failure `render/arena/retarget.ts` documents.
 *
 *  Applied every frame rather than at reset, and monotone (never resurrects), so a poll landing
 *  between two resets still takes effect on the very next frame. Moving `hp` into `banked` mirrors
 *  what `extract()` itself does on-chain, so the hover readout stays arithmetically honest without
 *  needing a second read of chain state that would only lag behind this one anyway. */
export function applyExtractions(state: ReplayState, fighters: FighterView[]): void {
  for (const f of fighters) {
    const s = state.shadow[f.id];
    if (!s || !f.dead || s.dead === 1) continue;
    s.banked += s.hp;
    s.hp = 0n;
    s.dead = 1;
  }
}
