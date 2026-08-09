// The steer-toward-next-real-event pattern this project's plan doc calls `retarget()` — see
// snug-floating-mitten.md's "Why hash-paired retarget, not physics-decided hits". Two halves:
//
//  - `computeTargets` is pure (no Matter, no DOM) — given where the playhead currently is in the
//    ordered `hitEvents` array, decide who each fighter should be moving toward. Kept pure and
//    exported separately so its assignment logic is unit-testable without a Matter world.
//  - `steer` is the Matter-touching half: reads those targets and each fighter's live (possibly
//    dead) state, sets body velocities accordingly, one call per animation frame.
import Matter from "matter-js";
import type { ERFighter } from "../../sim/erSim.ts";
import type { HitEvent } from "../../sim/hitEvents.ts";
import type { ArenaScene } from "./ArenaScene.ts";

/** How many upcoming events to look ahead when assigning targets. >1 so a fighter whose very next
 *  event is still a few steps off already starts drifting toward its opponent, rather than snapping
 *  to a new target only once the event immediately in front of the playhead names it — a lookahead
 *  of 1 reads as fighters "teleporting" toward each other right as they collide, not converging. */
export const DEFAULT_LOOKAHEAD = 4;

const MAX_SPEED = 3.4;
const WANDER_SPEED = 0.55;
/** Once a pair is this close (px), stop accelerating at full speed — lets them visibly meet and
 *  linger near each other around the moment their event fires, instead of overshooting and
 *  orbiting. */
const APPROACH_EASE_RADIUS = 130;

/** For each fighter id in `[0, fighterCount)`, the id of the fighter it should currently be steering
 *  toward, or `null` if nothing in the lookahead window involves them (they wander instead). When a
 *  fighter appears in more than one event within the window, the NEARER event wins — iterating the
 *  window back-to-front means later (closer to cursor) assignments overwrite earlier ones. */
export function computeTargets(
  fighterCount: number,
  events: HitEvent[],
  cursor: number,
  lookahead: number = DEFAULT_LOOKAHEAD,
): (number | null)[] {
  const targets: (number | null)[] = new Array(fighterCount).fill(null);
  const end = Math.min(events.length, cursor + lookahead);
  for (let i = end - 1; i >= cursor; i--) {
    const e = events[i];
    if (e.attackerId >= 0 && e.attackerId < fighterCount) targets[e.attackerId] = e.defenderId;
    if (e.defenderId >= 0 && e.defenderId < fighterCount) targets[e.defenderId] = e.attackerId;
  }
  return targets;
}

/** Sets every live fighter body's velocity for this frame: toward its target if it has a live one,
 *  otherwise a slow per-fighter idle drift (a phase-shifted sinusoid, not random noise — smooth and
 *  reproducible frame to frame, and spreads idle fighters apart via the golden angle so they don't
 *  all drift in lockstep). Dead fighters are zeroed out and left where they are; nothing here removes
 *  their body — PixiCanvas.tsx fades their sprite instead, matching them staying visible-but-out per
 *  the on-chain `dead` flag rather than disappearing.
 *
 *  Does NOT call `Matter.Engine.update` — that stays in gameLoop.ts, which owns per-frame ordering
 *  (per the plan doc's own listing of gameLoop.ts's responsibilities). */
export function steer(scene: ArenaScene, shadow: ERFighter[], targets: (number | null)[], nowMs: number): void {
  for (let id = 0; id < scene.bodies.length; id++) {
    const body = scene.bodies[id];
    const fighter = shadow[id];
    if (!body) continue;
    if (!fighter || fighter.dead === 1) {
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      continue;
    }

    const targetId = targets[id];
    const targetFighter = targetId !== null ? shadow[targetId] : null;
    const targetBody = targetId !== null ? scene.bodies[targetId] : undefined;

    if (targetId !== null && targetFighter && targetFighter.dead !== 1 && targetBody) {
      const dx = targetBody.position.x - body.position.x;
      const dy = targetBody.position.y - body.position.y;
      const dist = Math.hypot(dx, dy) || 1;
      const ease = Math.min(1, dist / APPROACH_EASE_RADIUS);
      const speed = MAX_SPEED * (0.3 + 0.7 * ease);
      Matter.Body.setVelocity(body, { x: (dx / dist) * speed, y: (dy / dist) * speed });
    } else {
      // Golden angle per id spreads idle fighters' phases apart so they don't drift in unison.
      const phase = id * 2.399963;
      const t = nowMs / 1000;
      Matter.Body.setVelocity(body, {
        x: Math.cos(t * 0.6 + phase) * WANDER_SPEED,
        y: Math.sin(t * 0.5 + phase) * WANDER_SPEED,
      });
    }
  }
}
