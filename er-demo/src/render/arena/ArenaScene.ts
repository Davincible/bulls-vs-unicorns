// Matter.js world setup — COSMETIC physics only. Bounds, one circular body per fighter. This module
// never decides who hits whom (see retarget.ts and this project's plan doc, "Why hash-paired
// retarget, not physics-decided hits" — the on-chain fight has no positions or collisions at all,
// `hash(seed, step) % n` picks attacker/defender). All this module produces is a believable place
// for fighters to glide and bounce while the real sequence, computed elsewhere, plays out on top of
// it.

import Matter from "matter-js";

export const FIGHTER_RADIUS = 22;
const WALL_THICKNESS = 60;
// No gravity/friction pull toward a rest state — fighters should read as actively moving/searching,
// not settling into a pile. `frictionAir` (set per-body below) is what keeps velocities from running
// away, not gravity.
const GRAVITY = { x: 0, y: 0 };

export interface ArenaScene {
  engine: Matter.Engine;
  world: Matter.World;
  /** Indexed by fighter id — `bodies[i]` is fighter `i`'s body, or `undefined` if `spawnFighterBodies`
   *  hasn't run for that id (e.g. a round with fewer fighters than a previous one reused this scene). */
  bodies: (Matter.Body | undefined)[];
  width: number;
  height: number;
}

export function createArenaScene(width: number, height: number): ArenaScene {
  const engine = Matter.Engine.create({ gravity: GRAVITY });
  const walls = [
    // top, bottom, left, right — centered just outside the visible canvas so their edge, not their
    // center, is what fighters actually bounce off.
    Matter.Bodies.rectangle(width / 2, -WALL_THICKNESS / 2, width + WALL_THICKNESS * 2, WALL_THICKNESS, { isStatic: true }),
    Matter.Bodies.rectangle(width / 2, height + WALL_THICKNESS / 2, width + WALL_THICKNESS * 2, WALL_THICKNESS, { isStatic: true }),
    Matter.Bodies.rectangle(-WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, height + WALL_THICKNESS * 2, { isStatic: true }),
    Matter.Bodies.rectangle(width + WALL_THICKNESS / 2, height / 2, WALL_THICKNESS, height + WALL_THICKNESS * 2, { isStatic: true }),
  ];
  for (const wall of walls) {
    wall.restitution = 0.85;
    wall.friction = 0;
  }
  Matter.World.add(engine.world, walls);
  return { engine, world: engine.world, bodies: [], width, height };
}

/** (Re)populates `scene.bodies`, one per fighter, replacing whatever was there before — the reset
 *  path gameLoop.ts takes whenever a new fight starts (see its header comment on the reinit signal).
 *  Side 0 spawns in the upper band, side 1 in the lower band, purely so two teams read as visually
 *  distinct at rest before any steering kicks in — the on-chain fight has no notion of "bands", this
 *  is presentation only. */
export function spawnFighterBodies(scene: ArenaScene, fighters: { id: number; side: 0 | 1 }[]): void {
  const existing = scene.bodies.filter((b): b is Matter.Body => b !== undefined);
  if (existing.length) Matter.World.remove(scene.world, existing);

  const bodies: (Matter.Body | undefined)[] = [];
  for (const f of fighters) {
    const laneY = f.side === 0 ? scene.height * 0.3 : scene.height * 0.7;
    const x = Matter.Common.random(scene.width * 0.18, scene.width * 0.82);
    const y = laneY + Matter.Common.random(-scene.height * 0.08, scene.height * 0.08);
    const body = Matter.Bodies.circle(x, y, FIGHTER_RADIUS, {
      restitution: 0.7,
      friction: 0,
      frictionAir: 0.08,
      label: `fighter-${f.id}`,
    });
    bodies[f.id] = body;
  }
  Matter.World.add(scene.world, bodies.filter((b): b is Matter.Body => b !== undefined));
  scene.bodies = bodies;
}

export function destroyArenaScene(scene: ArenaScene): void {
  Matter.World.clear(scene.world, false);
  Matter.Engine.clear(scene.engine);
  scene.bodies = [];
}
