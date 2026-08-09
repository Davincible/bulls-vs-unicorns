// Who is each fighter currently moving toward? A direct port of `render/arena/retarget.ts`'s pure
// half, unchanged in logic and kept pure for the same reason: it is decided entirely by where the
// playhead sits in the ordered event array, so it can be reasoned about (and tested) without a
// canvas, a body, or a clock.
//
// The whole idea, restated because it is the non-obvious part of this design: the on-chain fight has
// no positions and no collisions — `hash(seed, step) % n` picks the pair. So the motion cannot
// decide the hits; it has to ANTICIPATE them. Reading a few events ahead of the playhead and
// steering the named pair together means that when the hit finally lands, it lands on two circles
// that are already touching, and the whole thing reads as cause and effect instead of as two
// unrelated systems running side by side.

import type { HitEvent } from "../../sim/hitEvents.ts";

/** How far ahead to look, in EVENTS — scaled to the table, because the fight's pace is scaled to the
 *  table. The chain advances `stepsPerSecond(n) = n * 2` steps a second and roughly half of those
 *  produce a real exchange (`tick()` skips same-side, self and dead pairs), so hits arrive at very
 *  nearly `n` per second and `2 * n` events is about TWO SECONDS of lead at any lineup size.
 *
 *  `render/arena/retarget.ts`'s flat 4 was tuned against a two-fighter duel; at a full table it is a
 *  quarter-second window that most fighters don't appear in at all, so most of the field would idle
 *  through a brawl. Two seconds is enough that the window reliably names everyone, and the
 *  back-to-front sweep below then hands each fighter its NEAREST upcoming partner. */
export function lookaheadFor(count: number): number {
  return Math.max(8, count * 2);
}

/** How long an assignment is held once made.
 *
 *  Lookahead alone doesn't settle the field, because a fighter is named in roughly 2/n of all
 *  events — so at n hits a second its "nearest upcoming partner" changes about twice a second no
 *  matter how far ahead anyone looks. Re-deciding at that rate is not targeting, it is jitter.
 *
 *  So an assignment is COMMITTED for a beat: pick the partner of the nearest upcoming event, then
 *  hold it long enough to actually cross the field and trade, then pick again. Positions decide
 *  nothing (`hash(seed, step) % n` already picked every pair before the first frame), so holding a
 *  target past the event that suggested it costs no correctness at all and buys the one thing this
 *  canvas is for: a fight that reads as fighters choosing each other.
 *
 *  1.6s at a glide of ~150px/s is ~240px of travel — roughly a fifth of a wide field, which is what
 *  it takes to actually arrive. Tuned at the real chain pace, not the 175/s the first draft assumed. */
const DWELL_MS = 1600;

/** For each id in `[0, count)`: who to steer toward, or `null` to idle. When a fighter appears in
 *  more than one event inside the window the NEARER event wins — iterating back-to-front means the
 *  assignments closest to the cursor are written last. */
export function computeTargets(
  count: number,
  events: HitEvent[],
  cursor: number,
  lookahead: number = lookaheadFor(count),
): (number | null)[] {
  const targets: (number | null)[] = new Array<number | null>(count).fill(null);
  const end = Math.min(events.length, cursor + lookahead);
  for (let i = end - 1; i >= cursor; i--) {
    const e = events[i];
    if (e.attackerId >= 0 && e.attackerId < count) targets[e.attackerId] = e.defenderId;
    if (e.defenderId >= 0 && e.defenderId < count) targets[e.defenderId] = e.attackerId;
  }
  return targets;
}

export interface TargetTracker {
  /** The committed assignment for each id this frame. `isDead` breaks a commitment early — an
   *  extracted fighter must stop being chased the instant the chain says it left, which is the case
   *  `render/arena/retarget.ts` documents. */
  assign(
    count: number,
    events: HitEvent[],
    cursor: number,
    nowMs: number,
    isDead: (id: number) => boolean,
  ): (number | null)[];
}

export function createTargetTracker(): TargetTracker {
  let held: (number | null)[] = [];
  let until: number[] = [];

  return {
    assign(count, events, cursor, nowMs, isDead) {
      if (held.length !== count) {
        held = new Array<number | null>(count).fill(null);
        until = new Array<number>(count).fill(0);
      }
      const proposed = computeTargets(count, events, cursor);
      for (let id = 0; id < count; id++) {
        const current = held[id];
        const expired =
          current === null || nowMs >= until[id] || current >= count || isDead(current) || isDead(id);
        if (!expired) continue;
        held[id] = proposed[id];
        // Stagger the renewals by id so a table of sixteen doesn't re-target in unison, which reads
        // as a shoal turning rather than as individual fights.
        until[id] = nowMs + DWELL_MS + ((id * 137) % 500);
      }
      return held;
    },
  };
}
