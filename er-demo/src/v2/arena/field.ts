// The field: one circle per fighter, its radius a pure function of the value still in its ring, and
// a few hundred flops per frame of drift / seek / bounce to move them around.
//
// WHY NOT matter-js (it is already a dependency, and render/arena/ArenaScene.ts uses it):
//
//   1. A Matter body's collider radius is fixed at construction. Ours is not — it tracks hp, which
//      changes on every hit, which is the entire point of the visual (`Matter.Body.scale` exists,
//      but then "how big is this fighter" lives in two places that have to be kept in agreement
//      every frame, and the drawn circle and the thing that collides can drift apart. In a design
//      whose one job is to make relative wealth readable at a glance, that is not a detail.)
//   2. Matter buys rigid-body dynamics — rotation, restitution, compound shapes, constraints, a
//      broadphase built for hundreds of bodies. At the program's cap of 16 circles the broadphase
//      is 120 pair checks, and the other features are all things this design actively does not want.
//   3. The gameplay feel being preserved is `web/index.html`'s, and that is positional separation
//      plus an impulse exchange along the contact normal — thirty lines, reproduced below. Running
//      it through a physics engine would be a re-implementation of the reference, not a use of it.
//
// The physics is COSMETIC and always was: `run_fight()` picks its pairs by hash, so nothing here
// decides anything. It exists to make the hit stream legible.

import type { Side, FighterView } from "../contract.ts";

export interface ArenaBody {
  readonly id: number;
  /** Identity across a rebuild — `id` is a position in the on-chain array, the wallet is the player. */
  readonly wallet: string;
  readonly side: Side;
  readonly name: string;
  readonly isYou: boolean;
  /** Starting hp, i.e. net-of-fee stake — fixed for the life of the round. */
  readonly stake: bigint;

  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The drawn radius AND the collider. One number, so they cannot disagree. */
  r: number;
  /** The radius this fighter entered at. Drawn as a hairline ghost ring, so a mauled fighter reads
   *  as diminished — a small disc inside the outline of the size it used to be — rather than just
   *  as a small disc. */
  r0: number;

  /** Radius of the AT-RISK portion (`hp`) inside the disc, or 0 when it wouldn't read. Everything
   *  outside it is banked and safe — the tension `extract()` exists to resolve, drawn. */
  rRisk: number;

  // Mirrored from the replay's shadow state each frame; the painter reads them from here so it
  // never needs to know that a shadow-fight exists.
  hp: bigint;
  banked: bigint;
  /** `hp + banked` — what the fighter is worth, and what its size means. */
  worth: bigint;
  dead: boolean;
}

export interface ArenaField {
  w: number;
  h: number;
  /** Everything sized in px scales by this, so the field looks the same shape at any parent size
   *  instead of turning into a sparse scatter of dots on a large screen. */
  unit: number;
  /** The stake a `baseRadius` circle represents — see `computeRefStake`. */
  refStake: bigint;
  bodies: ArenaBody[];
  /** How far apart fighters try to stay, in px — see `computeSpacing`. */
  spacing: number;
  /** Radius of a fighter holding exactly `refStake` — see `BASE_RADIUS_SHARE`. */
  baseRadius: number;
  /** `bodies` indexed by `FighterView.id`. Steering resolves a target id every frame for every
   *  fighter; a linear scan would make that O(n²) for no reason, and the ids are dense array
   *  indices by contract anyway. Sparse only if a caller ever violates that contract. */
  byId: (ArenaBody | undefined)[];
}

/** Radius of a fighter holding exactly `refStake`, as a share of `sqrt(area / fighters)` — the side
 *  of the square each fighter would get if the field were divided evenly between them.
 *
 *  A FIXED base radius was the first attempt and it does not survive contact with the real range of
 *  inputs: the program's cap is sixteen fighters and its floor is two, so a constant size means
 *  sixteen circles cover eight times the ink two do. Screenshotted at both ends — a full table in a
 *  narrow panel was a solid mass of overlapping discs and unreadable stacked labels, while a duel in
 *  a wide one was two dots adrift in white. Tying it to the room each fighter actually has makes a
 *  duel large and a brawl compact, at every panel size, with no special cases. */
const BASE_RADIUS_SHARE = 0.115;
const BASE_RADIUS_RANGE = [11, 48] as const;
/** Clamps on `sqrt(hp / refStake)`. Without the floor a nearly-dead fighter becomes a subpixel dot
 *  with a label floating over nothing; without the ceiling one runaway winner eats the field. Both
 *  bounds are wide enough that the interesting range — roughly a tenth of the band to four times it
 *  — is rendered honestly, and only the extremes are compressed. */
const MIN_SCALE = 0.32;
const MAX_SCALE = 2.1;

// Motion, all in px/s (or px/s²) per `unit`.
const SEEK_ACCEL = 190;
const MAX_SPEED = 135;
/** Inside this radius of the standoff point, cap the speed hard: the pair should visibly MEET and
 *  linger around the moment their event fires, not overshoot and orbit. */
const APPROACH_RADIUS = 110;
const APPROACH_SPEED = 42;
/** A fighter steers to a point BESIDE its target, not to its centre.
 *
 *  Steering at the centre makes every fighter try to occupy the same coordinate as its opponent, and
 *  with a dozen of them and hash-picked pairs the whole table collapses into one vibrating knot in
 *  the middle of the field — verified in a browser, and the reason two thirds of the arena was empty
 *  while every label overlapped. Aiming just outside contact instead lets pairs actually pair off:
 *  they close, sit alongside each other for the duration of the duel, and the field stays spread.
 *  The angle drifts slowly and is offset per id by the golden angle, so a duel rotates rather than
 *  freezing into a diagram, and two attackers on the same defender approach from different sides. */
const STANDOFF_GAP = 22;
const STANDOFF_DRIFT = 0.35;
/** Idle drift while a fighter has no event in the lookahead window. */
const WANDER_SPEED = 30;
/** Lobby/Drawing. Deliberately almost still: an empty pre-fight arena should read as composed and
 *  waiting, not as a screensaver. */
const CALM_SPEED = 8;
/** How fast velocity converges on the idle target. A fighter leaving combat eases out of it. */
const WANDER_LERP = 2.6;
/** Settled, and dead bodies at any time: exponential decay to a standstill. */
const REST_DECAY = 3.2;
const WALL_RESTITUTION = 0.9;
/** Extra push applied along the contact normal when two live circles touch, so a crowd keeps
 *  breathing instead of packing into a solid mass. `web/index.html`'s `COMBAT.knock`, and it has to
 *  be a real fraction of `MAX_SPEED` to do anything against a seek force pulling twelve fighters at
 *  the same point — at a tenth of it the field simply fused into one knot. */
const CONTACT_KNOCK = 75;
/** The kick a LANDED HIT gives the pair, on top of the contact knock. Fired from the event stream,
 *  not from the collision, so a hit visibly throws two fighters apart — the clearest possible
 *  reading of "that just happened", and at the chain's pace of ~n hits a second it lands often
 *  enough to keep a melee from settling into a static huddle. Applied only while the pair is
 *  genuinely touching, so it is a recoil and not a permanent outward wind. */
const HIT_RECOIL = 130;
/** PERSONAL SPACE. Every fighter is attracted to some other fighter and nothing pushes the field
 *  apart at range, so a table converges on one tight knot in the middle and leaves two thirds of the
 *  arena white — verified in a browser at three different points of a fight before this existed.
 *
 *  A soft outward accel between any two fighters closer than this multiple of their combined radii,
 *  falling off linearly to nothing at the edge of it, spreads duels across the field without ever
 *  preventing one: the pair actually fighting each other is exempt, so they still meet and touch. */
const PERSONAL_SPACE = 2.4;
/** …and it has to be able to WIN against the seek, or the crowd's size is set by the pursuit graph
 *  instead of by the field. It was 150 against a `SEEK_ACCEL` of 190, and EVERY fighter is seeking
 *  somebody: hash-picked pairs put two or three attackers on one defender most of the time, and a
 *  hub like that contracts harder than a linear falloff can hold open. Two late fixture frames, nine
 *  fighters, 1440x950: the entire field of play was a 570x410 knot in one and a 430x555 column in the
 *  other, inside a 1,390x781 canvas — under a fifth of the paper, both outer thirds white, which is
 *  the "bunched into the upper middle" the redesign was called in for. */
const SPREAD_ACCEL = 250;
/** …but a multiple of the RADII alone only spaces fighters relative to each other, which leaves a
 *  dozen well-spaced circles occupying one corner of a wide arena and the other two thirds blank —
 *  the second thing the screenshots showed, after the knot itself.
 *
 *  So personal space is also floored at a share of the ROOM AVAILABLE: `sqrt(area / fighters)` is the
 *  side of the square each fighter would get if the field were divided evenly between them.
 *
 *  RAISED FROM 0.55, which was the arithmetic error underneath the whole complaint. That quantity is
 *  the side of the cell each fighter owns, so centres one WHOLE cell apart is what tiles the field;
 *  0.55 of it aims the crowd at 30% of the area it was given and then the seek eats into even that.
 *  A hexagonal packing at spacing `s` covers `n·s²·√3/2`, so 0.85 targets about 63% of the field —
 *  a crowd that reaches into all four corners while keeping a margin, at 9 fighters and at 16 alike.
 *
 *  CAPPED against the short side, because the share alone diverges as the field empties: two fighters
 *  in a desktop panel work out to 700-odd px of personal space, which is not a duel with room around
 *  it, it is one fighter per wall with the whole arena between them and nothing in it. The cap binds
 *  only below about six fighters, which is exactly the range where "fill the field" stops being the
 *  thing a viewer wants. */
const SPACING_SHARE = 0.85;
const SPACING_MAX_SHARE = 0.42;
/** …and personal space still only says how far apart fighters stand, not WHERE they stand. Because
 *  every fighter is seeking another one, the crowd behaves like a body with its own centre of mass,
 *  and that centre wanders — it drifts into whichever corner the last few duels happened in and
 *  parks there, leaving a third of the arena blank while the fight plays out off to one side.
 *
 *  This nudges the CENTROID toward the middle of the field, applying the identical acceleration to
 *  every fighter. A uniform translation changes nothing about the crowd's internal structure: it
 *  doesn't compress the melee, doesn't override a duel, doesn't make anyone converge — it just keeps
 *  the composition framed. Capped so it is always a drift, never a current. */
const RECENTRE_GAIN = 0.5;
const RECENTRE_MAX_ACCEL = 60;
const MAX_DT = 1 / 30;

export type MotionMode = "calm" | "active" | "rest";

/** What a `phase` means to the field. Settled deliberately brings everything to a halt: the fight is
 *  over, the numbers are final, and a field that keeps milling about says otherwise. */
export function motionModeFor(phase: string, fightStartedAtMs: number | null): MotionMode {
  if (phase === "Settled") return "rest";
  if (fightStartedAtMs === null) return "calm";
  return "active";
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function unitFor(w: number, h: number): number {
  return clamp(Math.min(w, h) / 560, 0.55, 2.4);
}

/** The side of the square each fighter would get if the field were divided evenly between them —
 *  the one quantity both the base radius and the spacing floor are derived from, so "how big" and
 *  "how far apart" can never disagree about how crowded the arena is. */
function roomPerFighter(w: number, h: number, count: number): number {
  return Math.sqrt((w * h) / Math.max(1, count));
}

function computeSpacing(w: number, h: number, count: number): number {
  if (count <= 1) return 0;
  return Math.min(roomPerFighter(w, h, count) * SPACING_SHARE, Math.min(w, h) * SPACING_MAX_SHARE);
}

function computeBaseRadius(w: number, h: number, count: number): number {
  return clamp(roomPerFighter(w, h, count) * BASE_RADIUS_SHARE, BASE_RADIUS_RANGE[0], BASE_RADIUS_RANGE[1]);
}

/** The MEDIAN stake, not the mean and not the max.
 *
 *  This number sets what "normal size" means on the field, so it decides whether the picture is
 *  readable. The max makes every non-whale a dot the moment one player deploys the $100 cap against
 *  a table of $5 entries; the mean is dragged by that same whale most of the way there. The median
 *  is the one that answers "bigger or smaller than the rest of this table?", which is the question
 *  a player is actually asking. */
function computeRefStake(fighters: FighterView[]): bigint {
  if (fighters.length === 0) return 1n;
  const sorted = fighters.map((f) => f.stake).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted[sorted.length >> 1];
  return mid > 0n ? mid : 1n;
}

/** SIZE IS **WORTH** — `hp + banked` — NOT `hp`.
 *
 *  This is the single most important line in the file, and it took a browser to find. In this
 *  program a raid does not compound in the ring the way `web/index.html`'s did: `applyHitEvent`
 *  moves the amount from the defender's `hp` straight into the attacker's `banked`, and nothing ever
 *  puts value back into `hp`. So `hp` is monotonically decreasing FOR EVERYONE, and a canvas that
 *  sizes on it shows a fight in which all sixteen fighters shrink toward nothing and the eventual
 *  winner is the smallest dot on the field. Screenshotted at step 3,572: four survivors holding the
 *  entire pot, drawn as specks inside enormous ghost rings.
 *
 *  `worth()` is what `contract.ts` itself calls "a fighter's total worth right now, which is what
 *  the winner is decided on", and it is the quantity that behaves the way the original game's
 *  circles did: raid the other side and you grow, get raided and you shrink.
 *
 *  `sqrt` so AREA is proportional to value — the encoding the eye actually integrates. Radius-
 *  proportional would exaggerate a 4x lead into a 16x blot. */
export function radiusFor(value: bigint, refStake: bigint, baseRadius: number): number {
  if (value <= 0n) return baseRadius * MIN_SCALE;
  const scale = clamp(Math.sqrt(Number(value) / Number(refStake)), MIN_SCALE, MAX_SCALE);
  return baseRadius * scale;
}

/** A stable pseudo-random in [0,1) from a string. Deterministic on purpose: the spawn layout must
 *  survive React StrictMode's double mount, a remount, and a hot reload without the whole field
 *  visibly reshuffling. Same wallet, same corner of the arena, every time. */
function hash01(text: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Side 0 takes the left third, side 1 the right — so before a single hit lands the two camps are
 *  already legible as camps. Presentation only; the program has no notion of a position. */
function spawn(body: ArenaBody, wallet: string, w: number, h: number): void {
  const rx = hash01(wallet, 0x9e37);
  const ry = hash01(wallet, 0x85eb);
  body.x = body.side === 0 ? w * (0.07 + rx * 0.31) : w * (0.62 + rx * 0.31);
  body.y = h * (0.1 + ry * 0.8);
  body.vx = 0;
  body.vy = 0;
}

/** `prev` carries positions and velocities across a lineup change, matched by wallet.
 *
 *  Without it, every entry that lands during a lobby would rebuild the field and snap every fighter
 *  already on it back to its spawn point — the arena visibly twitching each time somebody else
 *  deploys. `web/index.html` hit the same thing and fixed it the same way ("MERGE by id: keep
 *  existing circles where they drift, no teleporting on every join"). */
export function createField(
  fighters: FighterView[],
  w: number,
  h: number,
  prev?: ArenaField | null,
): ArenaField {
  const unit = unitFor(w, h);
  const baseRadius = computeBaseRadius(w, h, fighters.length);
  const refStake = computeRefStake(fighters);
  const carried = new Map<string, ArenaBody>();
  if (prev) for (const b of prev.bodies) carried.set(b.wallet, b);

  const bodies = fighters.map((f) => {
    const body: ArenaBody = {
      id: f.id,
      wallet: f.wallet,
      side: f.side,
      name: f.name,
      isYou: f.isYou,
      stake: f.stake,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: radiusFor(f.hp + f.banked, refStake, baseRadius),
      r0: radiusFor(f.stake, refStake, baseRadius),
      rRisk: 0,
      hp: f.hp,
      banked: f.banked,
      worth: f.hp + f.banked,
      dead: f.dead,
    };
    const before = carried.get(f.wallet);
    if (before) {
      body.x = before.x;
      body.y = before.y;
      body.vx = before.vx;
      body.vy = before.vy;
    } else {
      spawn(body, f.wallet, w, h);
    }
    return body;
  });
  const byId: (ArenaBody | undefined)[] = [];
  for (const b of bodies) byId[b.id] = b;

  const field: ArenaField = {
    w,
    h,
    unit,
    refStake,
    spacing: computeSpacing(w, h, bodies.length),
    baseRadius,
    bodies,
    byId,
  };
  // Deterministic spawn means deterministic overlaps. Settle them before the first paint so a lobby
  // never opens with two fighters fused together — 16 passes of the same solver the loop uses.
  for (let i = 0; i < 16; i++) separate(field);
  clampToWalls(field);
  return field;
}

/** Resize keeps the fight running: positions move proportionally and radii re-derive at the new
 *  scale. Respawning on every ResizeObserver callback would scatter the field every time a sidebar
 *  animated open. */
export function resizeField(field: ArenaField, w: number, h: number): void {
  const sx = field.w > 0 ? w / field.w : 1;
  const sy = field.h > 0 ? h / field.h : 1;
  field.w = w;
  field.h = h;
  field.unit = unitFor(w, h);
  field.spacing = computeSpacing(w, h, field.bodies.length);
  field.baseRadius = computeBaseRadius(w, h, field.bodies.length);
  for (const b of field.bodies) {
    b.x *= sx;
    b.y *= sy;
    sizeBody(field, b);
    b.r0 = radiusFor(b.stake, field.refStake, field.baseRadius);
  }
  clampToWalls(field);
}

/** Fraction of the disc that must be at risk (and not at risk) before the inner boundary is worth
 *  drawing. Outside this band it is either a dot in the middle or a hairline sitting on the edge —
 *  in both cases a mark that says nothing, on a design that has no room for those. */
const RISK_BAND = [0.06, 0.94] as const;

function sizeBody(field: ArenaField, b: ArenaBody): void {
  b.r = radiusFor(b.worth, field.refStake, field.baseRadius);
  const frac = b.worth > 0n ? Number(b.hp) / Number(b.worth) : 0;
  b.rRisk = !b.dead && frac > RISK_BAND[0] && frac < RISK_BAND[1] ? b.r * Math.sqrt(frac) : 0;
}

/** Pulls the replay's current hp/banked/dead onto the bodies and re-derives radii from them. The one
 *  place fight state enters the field — everything downstream (steering, collision, painting) reads
 *  it from the body. */
export function syncBodies(
  field: ArenaField,
  shadow: { hp: bigint; banked: bigint; dead: number }[],
): void {
  for (const b of field.bodies) {
    const s: { hp: bigint; banked: bigint; dead: number } | undefined = shadow[b.id];
    if (!s) continue;
    b.hp = s.hp;
    b.banked = s.banked;
    b.worth = s.hp + s.banked;
    b.dead = s.dead === 1;
    // Dead fighters keep sizing on `worth` like everyone else, drawn hollow. A player wiped out to
    // nothing leaves a small empty ring; a player who EXTRACTED a fortune leaves a large one. Both
    // are out of play, and the difference between them is the whole story of the round.
    sizeBody(field, b);
  }
}

/** One frame of motion. `targets[id]` is who to steer toward (see targeting.ts); `nowMs` drives the
 *  idle sinusoid. Never called under `prefers-reduced-motion` — positions simply stay where
 *  `createField` put them. */
export function stepField(
  field: ArenaField,
  targets: (number | null)[],
  mode: MotionMode,
  dtMs: number,
  nowMs: number,
): void {
  // Clamped rather than raw: a backgrounded tab hands back one enormous delta, and integrating it
  // would teleport every fighter through a wall. The physics decides nothing, so losing a little
  // wall-clock accuracy after a stall costs nothing at all.
  const dt = clamp(dtMs / 1000, 0, MAX_DT);
  if (dt <= 0) return;
  const u = field.unit;
  const t = nowMs / 1000;

  // Not in `rest`: Settled means the field comes to a standstill, and either of these would be a
  // slow permanent creep that the decay never quite wins against.
  if (mode !== "rest") {
    spread(field, targets, dt);
    recentre(field, dt);
  }

  for (const b of field.bodies) {
    if (b.dead || mode === "rest") {
      const decay = Math.exp(-REST_DECAY * dt);
      b.vx *= decay;
      b.vy *= decay;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      continue;
    }

    const targetId = mode === "active" ? (targets[b.id] ?? null) : null;
    const target = targetId !== null ? field.byId[targetId] : undefined;

    if (target && !target.dead) {
      const angle = b.id * 2.399963 + t * STANDOFF_DRIFT;
      const standoff = b.r + target.r + STANDOFF_GAP * u;
      const dx = target.x + Math.cos(angle) * standoff - b.x;
      const dy = target.y + Math.sin(angle) * standoff - b.y;
      const dist = Math.hypot(dx, dy) || 1;
      b.vx += (dx / dist) * SEEK_ACCEL * u * dt;
      b.vy += (dy / dist) * SEEK_ACCEL * u * dt;
      // Ease off as they close, so the pair meets and stays together across the moment the hit lands
      // rather than sailing past each other at full tilt.
      const cap = (dist < APPROACH_RADIUS * u ? APPROACH_SPEED : MAX_SPEED) * u;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > cap) {
        b.vx *= cap / speed;
        b.vy *= cap / speed;
      }
    } else {
      // A phase-shifted sinusoid rather than random noise: smooth frame to frame, reproducible, and
      // spread apart by the golden angle so idle fighters don't all drift in lockstep. Lerped into
      // rather than assigned, so leaving combat is a glide, not a snap.
      const speed = (mode === "calm" ? CALM_SPEED : WANDER_SPEED) * u;
      const phase = b.id * 2.399963;
      const wx = Math.cos(t * 0.6 + phase) * speed;
      const wy = Math.sin(t * 0.5 + phase) * speed;
      const k = 1 - Math.exp(-WANDER_LERP * dt);
      b.vx += (wx - b.vx) * k;
      b.vy += (wy - b.vy) * k;
    }

    b.x += b.vx * dt;
    b.y += b.vy * dt;
  }

  separate(field);
  clampToWalls(field);
}

/** PERSONAL SPACE, applied as an acceleration before integration.
 *
 *  Every fighter is pulled toward some other fighter and, without this, nothing pushes the field
 *  apart at any range — so a table converges on one tight knot in the middle and leaves two thirds of
 *  the arena blank. That is not a hypothetical: it is what three screenshots at three different
 *  points of a fight all showed, with a dozen labels stacked on top of each other in the same 400px.
 *
 *  A soft outward accel between any two LIVE fighters closer than `PERSONAL_SPACE` times their
 *  combined radii, falling off linearly to nothing at the edge of that range. Two exemptions keep it
 *  from fighting the thing it exists to serve:
 *
 *    - the pair currently targeting each other is exempt in BOTH directions, so a duel still closes,
 *      touches, and lands its hit;
 *    - the dead are exempt entirely — they are markers, and a corpse should neither shove nor be
 *      shoved (`separate()` lays them out among themselves and no further).
 *
 *  Linear falloff rather than inverse-square on purpose: an inverse law is unbounded as distance
 *  goes to zero and turns a momentary overlap into a launch. This is a nudge with a hard edge, which
 *  is all a crowd of at most sixteen circles needs. */
function spread(field: ArenaField, targets: (number | null)[], dt: number): void {
  const bodies = field.bodies;
  const accel = SPREAD_ACCEL * field.unit * dt;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.dead) continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b.dead) continue;
      if (targets[a.id] === b.id || targets[b.id] === a.id) continue;

      const range = Math.max((a.r + b.r) * PERSONAL_SPACE, field.spacing);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= range || dist <= 0) continue;

      // 1 at contact, 0 at the edge of personal space.
      const push = (accel * (range - dist)) / range;
      const nx = dx / dist;
      const ny = dy / dist;
      a.vx -= nx * push;
      a.vy -= ny * push;
      b.vx += nx * push;
      b.vy += ny * push;
    }
  }
}

/** Keeps the melee framed — see RECENTRE_GAIN. Reads the live fighters' centroid and drifts the
 *  whole crowd toward the middle of the field, using the vertical middle of the PLAYABLE area (the
 *  label strip at the bottom is not part of it, and centring on the raw height would sit the fight
 *  permanently a dozen pixels low). The dead are excluded from both the measurement and the nudge:
 *  they are markers of where something happened, and sliding them around afterwards would quietly
 *  falsify that. */
function recentre(field: ArenaField, dt: number): void {
  let sumX = 0;
  let sumY = 0;
  let live = 0;
  for (const b of field.bodies) {
    if (b.dead) continue;
    sumX += b.x;
    sumY += b.y;
    live++;
  }
  if (live === 0) return;

  const cap = RECENTRE_MAX_ACCEL * field.unit;
  const ax = clamp((field.w / 2 - sumX / live) * RECENTRE_GAIN, -cap, cap) * dt;
  const ay = clamp(((field.h - LABEL_SPACE) / 2 - sumY / live) * RECENTRE_GAIN, -cap, cap) * dt;
  for (const b of field.bodies) {
    if (b.dead) continue;
    b.vx += ax;
    b.vy += ay;
  }
}

/** The kick a hit gives its pair. A no-op unless they are actually in contact — a raid between two
 *  fighters at opposite ends of the arena (the hash pairs them, not their positions) has no contact
 *  to recoil from, and inventing one would fling fighters around for reasons nothing on screen
 *  explains. Called once per crossed `HitEvent`, from the loop. */
export function recoil(field: ArenaField, attackerId: number, defenderId: number): void {
  const a = field.byId[attackerId];
  const d = field.byId[defenderId];
  if (!a || !d || a === d || a.dead || d.dead) return;
  const dx = d.x - a.x;
  const dy = d.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 0 || dist > a.r + d.r + 6 * field.unit) return;
  const k = (HIT_RECOIL * field.unit) / dist;
  a.vx -= dx * k * 0.5;
  a.vy -= dy * k * 0.5;
  d.vx += dx * k;
  d.vy += dy * k;
}

/** Positional separation plus an impulse exchange along the contact normal — `web/index.html`'s
 *  collision response, which is the feel being preserved. O(n²) over at most 16 bodies: 120 pair
 *  checks, cheaper than the branch that would avoid them.
 *
 *  A live fighter passes straight THROUGH a dead one: the dead are hollow outlines, out of play, and
 *  shoving the living around from beyond the grave would be a physical claim the game does not make.
 *  Two dead fighters, though, still push each other apart — they die where they were fighting, which
 *  is to say on top of each other, and a pile of concentric grey rings with three greyed labels
 *  stacked underneath is unreadable. Positional only, no impulse: they are markers being laid out,
 *  not bodies colliding. */
function separate(field: ArenaField): void {
  const bodies = field.bodies;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (a.dead !== b.dead) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const min = a.r + b.r;
      if (dist >= min || dist <= 0) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = (min - dist) / 2;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      if (a.dead) continue; // (and therefore b.dead — see the pairing guard above)

      const va = a.vx * nx + a.vy * ny;
      const vb = b.vx * nx + b.vy * ny;
      const diff = vb - va;
      const knock = CONTACT_KNOCK * field.unit;
      a.vx += nx * diff - nx * knock;
      a.vy += ny * diff - ny * knock;
      b.vx -= nx * diff - nx * knock;
      b.vy -= ny * diff - ny * knock;
    }
  }
}

/** THE BOTTOM MARGIN. Nothing the field owns is drawn into it: no disc (see `clampToWalls`), no label
 *  (see draw.ts's `layoutLabels`), no watermark row (see scoreboard.ts's `playable`).
 *
 *  It began as the space kept clear below every fighter for its two label lines — without it the
 *  bottom row printed names and figures straight through the parent's frame, caught in the first
 *  screenshot with the last fighter's ring value simply not there. That reading of it did not survive
 *  the crowd actually reaching the bottom of the arena: at 26 the strip was NARROWER than the label
 *  it was reserved for (draw.ts's LABEL_GAP + LABEL_H is ~36), so a fighter near the floor put its
 *  value line into the last few pixels of the canvas — where the shell's fixed bottom nav is sitting.
 *  Screenshotted on the crowded frame: `INDIGO_82 / $42.7…` with the figure cut in half by the nav's
 *  black bar.
 *
 *  So the strip is now a MARGIN and the label rule is the one that changed: a fighter low enough that
 *  its label will not fit above the margin takes the band over its own head instead, which
 *  `layoutLabels` was already doing for the fighters pinned to the very floor. 30 is the shell chrome's
 *  own height, which is what is actually sitting over the canvas here. */
export const LABEL_SPACE = 30;

function clampToWalls(field: ArenaField): void {
  const floor = field.h - LABEL_SPACE;
  for (const b of field.bodies) {
    // A fighter wider than the field would oscillate forever between two impossible clamps; pin it
    // to the centre of that axis instead. Only reachable at absurd aspect ratios, but "only
    // reachable" is not "unreachable".
    if (b.r * 2 >= field.w) {
      b.x = field.w / 2;
      b.vx = 0;
    } else if (b.x < b.r) {
      b.x = b.r;
      b.vx = Math.abs(b.vx) * WALL_RESTITUTION;
    } else if (b.x > field.w - b.r) {
      b.x = field.w - b.r;
      b.vx = -Math.abs(b.vx) * WALL_RESTITUTION;
    }

    if (b.r * 2 >= floor) {
      b.y = floor / 2;
      b.vy = 0;
    } else if (b.y < b.r) {
      b.y = b.r;
      b.vy = Math.abs(b.vy) * WALL_RESTITUTION;
    } else if (b.y > floor - b.r) {
      b.y = floor - b.r;
      b.vy = -Math.abs(b.vy) * WALL_RESTITUTION;
    }
  }
}

/** Nearest body whose disc contains the point, with a few px of slop so a small fighter is still
 *  clickable. Dead fighters stay hittable — being able to inspect who went out, and with what, is
 *  the whole reason they remain on the field. */
export function bodyAt(field: ArenaField, x: number, y: number): ArenaBody | null {
  let best: ArenaBody | null = null;
  let bestDist = Infinity;
  for (const b of field.bodies) {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d <= b.r + 4 && d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}
