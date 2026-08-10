// The plain `requestAnimationFrame` loop — NOT inside React's render cycle, per REACT.md's own
// advice (cited in the plan doc) and per how the rest of this render/ layer is built: React mounts
// this once (see PixiCanvas.tsx) and hands it a ref to read the latest props from every frame,
// rather than the loop itself being React state or re-created on every prop change.
//
// Per-frame order: advance the shadow-fight replay to wherever the wall-clock playhead now is,
// firing impactFx for every `HitEvent` newly crossed -> recompute retarget() targets from the
// (possibly just-advanced) cursor -> `Matter.Engine.update()` -> `steer()` bodies toward their
// targets -> sync every Pixi sprite's position/hp bar from its Matter body + shadow state -> advance
// any in-flight impactFx animations.
import Matter from "matter-js";
import { finalCursor, stepsPerSecond } from "../chain/constants.ts";
import { spawnFighterBodies, type ArenaScene } from "./arena/ArenaScene.ts";
import { computeTargets, steer } from "./arena/retarget.ts";
import { buildShadowFighters, advanceShadow } from "./shadowFight.ts";
import { updateFighterSprite, type FighterSprite } from "./fighterSprite.ts";
import type { ImpactFxController } from "./arena/impactFx.ts";
import type { ERFighter } from "../sim/erSim.ts";
import type { PixiCanvasProps } from "./types.ts";

// THE PACING CONSTANTS NOW LIVE IN chain/constants.ts, and this module imports them.
//
// They used to be local copies here (`STEPS_PER_SECOND = 175`, `MAX_STEPS = 7_000`) with a comment
// saying they'd been verified against the deployed program. By the time the fight became genuinely
// stepped on-chain, BOTH were stale — the program had moved to `MAX_STEPS = 4_000` in an earlier
// session and to a per-fighter rate in this one — so the canvas was playing the fight at 44x the
// chain's pace and would have kept running 3,000 steps past where the chain stops. A second copy of a
// chain fact is a second thing to forget to update; there is now one copy, in the layer that owns
// talking to the chain, and this module re-exports it so App.tsx's import is unchanged.
//
// `MAX_STEPS` ITSELF LATER SPLIT IN TWO (the 16 -> 48 fighter cap): a flat cursor ceiling stopped
// being able to describe every lineup, so the program replaced it with `finalCursor(fighterCount)` —
// the per-lineup cursor ceiling — and `MAX_STEPS_PER_CALL`, a compute bound on a single transaction
// that this module has no reason to know about (round.ts's `tick` is the one caller that sizes a
// transaction; this loop only ever asks "how far can THIS fight's playhead go"). This module now
// re-exports `finalCursor` where it used to re-export `MAX_STEPS`.
//
// `playheadStep` computes the SAME quantity as the program's `canonical_cursor()` — the cursor real
// elapsed time says the fight has reached — but at sub-second float precision. It converges to the
// exact on-chain integer at every whole-second mark, which is the only place the chain itself ever
// moves; the fractional part between marks exists purely to make the animation smooth, not to change
// which `HitEvent`s have happened at any second boundary.
export { finalCursor } from "../chain/constants.ts";

/** The fixed step handed to `Matter.Engine.update()` every frame — REACT.md §8's performance budget
 *  verbatim: "Physics substeps: 60Hz fixed step is enough."
 *
 *  This replaced a real-elapsed delta capped at 50ms. That cap existed to stop a backgrounded-tab
 *  stall from handing Matter one enormous step (bodies visibly jumping or tunnelling through walls
 *  on return) — a fixed step is immune to that by construction, and it also silences the
 *  `Matter.Engine.update: delta argument is recommended to be less than or equal to 16.667 ms`
 *  warning the capped version printed to the console on every load, which is the one console message
 *  this demo was still emitting. Matter's own guidance is a constant delta; the reason a variable
 *  one buys nothing here is that this physics is cosmetic (ArenaScene.ts's header) — it decides
 *  nothing about the fight, so "the drift is a few percent slow after a stall" has no consequence
 *  worth the instability of a variable step. */
const PHYSICS_STEP_MS = 1000 / 60;

/** Pure — split out from the loop so the wall-clock-to-step math is unit-testable without a DOM, a
 *  Matter world, or pixi.js. Returns a float; callers compare it against integer `HitEvent.step`
 *  values with `<=`.
 *
 *  `fighterCount` is the third argument because the on-chain rate is per fighter, not flat — a fight's
 *  length in steps grows roughly as n^1.5, so no single rate paces both a duel and a sixteen-fighter
 *  brawl (the measurements are in `STEPS_PER_FIGHTER_PER_SECOND`'s doc comment in lib.rs). It costs no
 *  new prop: the loop reads it from `props.fighters.length`, which is already the array the
 *  `HitEvent` indices are relative to. */
export function playheadStep(fightStartedAtMs: number | null, nowMs: number, fighterCount: number): number {
  if (fightStartedAtMs === null) return 0;
  const elapsedSeconds = Math.max(0, (nowMs - fightStartedAtMs) / 1000);
  return Math.min(elapsedSeconds * stepsPerSecond(fighterCount), finalCursor(fighterCount));
}

export interface GameLoopHandles {
  scene: ArenaScene;
  getSprite(fighterId: number): FighterSprite | undefined;
  fx: ImpactFxController;
}

interface FightRun {
  signature: string;
  shadow: ERFighter[];
  cursor: number;
}

/** Identifies "the current fight" for reinit purposes — a new signature means the shadow-fight
 *  replay, Matter bodies, and any in-flight FX all need to reset from scratch (a new round started,
 *  or the fighter lineup itself changed, which only happens between rounds). Scope note: Phase 4
 *  treats `hitEvents` as the whole precomputed sequence for one uninterrupted fight (see
 *  types.ts's `PixiCanvasProps.hitEvents` doc) — mid-fight recompute after an `extract()` (Phase 5)
 *  is intentionally NOT a reinit trigger here, since `RenderFighter.dead` already lets `steer()`
 *  react to an extraction immediately without needing a full reset (see retarget.ts). */
function fightSignature(props: PixiCanvasProps): string {
  const fighterKey = props.fighters.map((f) => `${f.id}:${f.wallet}:${f.stake}`).join(",");
  return `${props.fightStartedAtMs ?? "pending"}|${fighterKey}`;
}

export interface GameLoop {
  start(): void;
  stop(): void;
}

/** `propsRef` is a plain mutable object (`{ current: PixiCanvasProps }`) that PixiCanvas.tsx keeps
 *  up to date via a `useEffect` on every render — the loop reads `propsRef.current` fresh each
 *  frame rather than closing over a snapshot, so prop updates (new poll results, a phase change)
 *  take effect on the very next frame without restarting the loop or re-subscribing anything. */
export function createGameLoop(handles: GameLoopHandles, propsRef: { current: PixiCanvasProps }): GameLoop {
  let rafHandle = 0;
  let run: FightRun | null = null;

  /** Copies every live Matter body's position onto its matching sprite and redraws its hp bar —
   *  shared by the normal per-frame sync (below) and by `ensureRun`'s initial spawn (immediately
   *  after creating fresh bodies), so a `HitEvent` scheduled for step 0 of a brand-new fight — fired
   *  from the very same frame that spawns those bodies, before the frame's OWN sync step would
   *  otherwise run — still finds sprites already positioned at their real (if freshly-randomized)
   *  spawn point rather than at a Container's default (0, 0). Caught by direct browser verification
   *  (a step-0 event's flash rendering at the arena's top-left corner instead of on a fighter), not
   *  by reading the code — worth the extra function, not worth leaving in. */
  function syncSprites(run: FightRun): void {
    for (let id = 0; id < run.shadow.length; id++) {
      const body = handles.scene.bodies[id];
      const sprite = handles.getSprite(id);
      if (!body || !sprite) continue;
      sprite.root.position.set(body.position.x, body.position.y);
      const fighter = run.shadow[id];
      updateFighterSprite(sprite, fighter.hp, fighter.stake, fighter.dead === 1);
    }
  }

  function ensureRun(props: PixiCanvasProps): FightRun {
    const signature = fightSignature(props);
    if (run && run.signature === signature) return run;

    spawnFighterBodies(handles.scene, props.fighters);
    handles.fx.clear();
    run = { signature, shadow: buildShadowFighters(props.fighters), cursor: 0 };
    syncSprites(run);
    return run;
  }

  function frame(nowMs: number): void {
    const props = propsRef.current;
    const current = ensureRun(props);

    // `nowMs` (the rAF callback's own timestamp) is relative to `performance.timeOrigin` — i.e. the
    // page's navigation start — NOT a Unix epoch value. `fightStartedAtMs` (see types.ts) IS a Unix
    // epoch ms value (`Number(round.fightStartedAt) * 1000`). Comparing them directly would silently
    // produce a permanently-negative (clamped to 0) playhead — caught by an actual browser run
    // during this phase's verification, not by reading the code, which is exactly why that
    // verification step exists. `performance.timeOrigin + nowMs` converts the rAF timestamp back to
    // the same epoch-ms basis `fightStartedAtMs` is already in.
    const nowEpochMs = performance.timeOrigin + nowMs;
    const step = playheadStep(props.fightStartedAtMs, nowEpochMs, props.fighters.length);
    let cursor = current.cursor;
    while (cursor < props.hitEvents.length && Number(props.hitEvents[cursor].step) <= step) {
      advanceShadow(current.shadow, props.hitEvents, cursor, cursor + 1);
      handles.fx.fire(props.hitEvents[cursor]);
      cursor++;
    }
    current.cursor = cursor;

    const targets = computeTargets(current.shadow.length, props.hitEvents, cursor);
    Matter.Engine.update(handles.scene.engine, PHYSICS_STEP_MS);
    steer(handles.scene, current.shadow, targets, nowMs);
    syncSprites(current);

    handles.fx.update(nowMs);
    rafHandle = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (rafHandle) return; // already running — start() is idempotent
      rafHandle = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    },
  };
}
