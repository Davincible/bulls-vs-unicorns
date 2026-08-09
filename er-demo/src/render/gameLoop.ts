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
import { spawnFighterBodies, type ArenaScene } from "./arena/ArenaScene.ts";
import { computeTargets, steer } from "./arena/retarget.ts";
import { buildShadowFighters, advanceShadow } from "./shadowFight.ts";
import { updateFighterSprite, type FighterSprite } from "./fighterSprite.ts";
import type { ImpactFxController } from "./arena/impactFx.ts";
import type { ERFighter } from "../sim/erSim.ts";
import type { PixiCanvasProps } from "./types.ts";

// Mirrored from `programs/bulls-arena/src/lib.rs`:
//   pub const STEPS_PER_SECOND: u64 = 175;
//   pub const MAX_STEPS: u64 = 7_000;
// (verified directly against the deployed program's source this session, not invented — see this
// task's own instructions on why a silently-different number here would be a real bug, not a detail).
// `resolve()` derives its on-chain step count as `min(elapsed_seconds * STEPS_PER_SECOND, MAX_STEPS)`
// where `elapsed_seconds` is truncated to a whole integer (both `now` and `fight_started_at` are unix
// timestamps in seconds). `playheadStep` below computes the SAME quantity from wall-clock time at
// sub-second float precision — it converges to the exact on-chain integer at every whole-second mark,
// the fractional part in between exists purely to make the client-side animation smooth, not to
// change which `HitEvent`s have "happened" at any second boundary.
//
// Kept local to render/ rather than chain/constants.ts on purpose: Phase 3 owns that file
// concurrently this session (see this task's own brief), and these two constants are read ONLY by
// this module. An integration pass may reasonably hoist them into chain/constants.ts later, since
// they're genuinely chain-level facts, not render-specific tuning — nothing here depends on them
// staying local.
export const STEPS_PER_SECOND = 175;
export const MAX_STEPS = 7_000;

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
 *  values with `<=`. */
export function playheadStep(fightStartedAtMs: number | null, nowMs: number): number {
  if (fightStartedAtMs === null) return 0;
  const elapsedSeconds = Math.max(0, (nowMs - fightStartedAtMs) / 1000);
  return Math.min(elapsedSeconds * STEPS_PER_SECOND, MAX_STEPS);
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
    const step = playheadStep(props.fightStartedAtMs, nowEpochMs);
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
