// What a hit looks like. Four marks, all black, all short:
//
//   RING   a hard expanding circle at the point of impact. No glow, no bloom, no fill — an impact
//          reads as a shockwave leaving the thing it happened to, and a filled flash would simply
//          cover the fighter you are trying to watch (`render/arena/impactFx.ts` learned that one in
//          a browser: several overlapping discs turned that corner of the arena into a solid blob
//          with the fight invisible underneath).
//   SPALL  a short fan of hairline dashes thrown off the contact point, away from the attacker. The
//          one mark here that is not a circle, and the only thing on the field that says a hit had a
//          DIRECTION as well as a target. Heavy blows only — see FAN_FORCE.
//   LINE   a black segment between attacker and defender — the only thing on the field that says who
//          took the money. Drawn edge to edge, not centre to centre, so it never strikes through
//          either circle, and it RETRACTS into the defender over its life so the force reads as
//          arriving rather than as a wire that appeared.
//   FIGURE the damage in mono black, rising and fading. This is a trading terminal that happens to
//          be a game; the number IS the event.
//
// Nothing here is coloured and nothing here is soft. The dark-theme original spent a GlowFilter, an
// additive blend and a fourteen-particle burst per hit; on white, at this scale, all three would be
// noise laid over the one thing worth reading. Extremity here is bought in SPEED, WEIGHT and
// CONTRAST — a hard ring that crosses three radii in 120ms and is gone is more violent than
// anything that lingers.
//
// TWO SIGNALS, AND EVERY MARK HERE IS SIZED OFF ONE OF THEM. Until this pass every hit drew the
// identical ring, the identical line and the identical figure, and the chain hands us two
// independent measures of how big a blow was, both of which were being thrown away:
//
//   FORCE  the ROLL. `advance_fight` computes `dmg = min(hp_a, hp_d) * roll / 100` with
//          `roll ∈ [4, 27]`, so every blow already carries a near-7x spread in how hard it was
//          swung, and it is recoverable exactly (see `hitForce`). Measured over the nine-fighter
//          fixture: p50 = 7% of the ring, p90 = 23%, and that spread holds for the WHOLE fight
//          because it is a property of the dice and not of the state. So force is what keeps the
//          late fight alive: the blows still differ from each other when nothing else does.
//   TOLL   what the blow actually COST — the share of the defender's worth that moved. This one
//          collapses as the fight goes on, and dramatically: 50% of all the size movement in a
//          94-second fixture fight is over by t=3s and 90% of it by t=19s. So toll is what makes
//          the opening a barrage and the tail a mopping-up, which is what the fight honestly is.
//
// Force drives the marks' REACH and SHARPNESS, toll their SIZE and PERSISTENCE. A hit that is swung
// hard but takes nothing is a fast wide thin ring with a spall fan and no number worth reading; a
// hit that empties a fighter is a slow heavy ring and a large figure. Both are true readings, and
// the pair of them is the entire dynamic range this file previously spent on one constant.
//
// PACING. The chain advances `stepsPerSecond(n) = n * 2` steps a second and roughly half of those
// produce a real exchange, so hits land at very nearly `n` per second: ~2/s in a duel, ~16/s at the
// program's cap of sixteen. That is slow enough that every hit can have its full mark, and the caps
// below are sized so nothing throttles in normal play — only a pathological burst trims anything.
//
// The caps still exist, and they are not decoration: they are the backstop that keeps a dense
// stretch from putting fifteen overlapping numbers on one defender, which conveys less than five do.
// Each mark's minimum spacing is DERIVED from its LONGEST possible life (duration / cap) rather than
// tuned separately, so the two can never drift apart, and the derivation stays conservative now that
// a mark's life is a function of the hit rather than a constant.
//
// …AND THE THROTTLE YIELDS TO A BIG HIT. A cap that drops marks in arrival order will eventually
// drop the one blow of the round that mattered because two nothing-hits happened to land in front of
// it, which is the throttle destroying exactly the signal it was added to protect. Anything past
// `URGENT_FORCE` (or, for the figures, `URGENT_TOLL`) is admitted regardless. That cannot flood:
// `roll` is uniform on [4, 27], so URGENT_FORCE = 0.8 is the top fifth of blows, i.e. ~3/s at the
// program's cap of sixteen fighters.
//
// Dropping a mark affects NOTHING but the flourish: replay.ts advances fight state for every event
// independently of this module. Hp, deaths and the settled outcome are untouched.

import { usd, usdCompact } from "../contract.ts";
import type { InkMap } from "./ink.ts";
import { monoFont, monoWidth, type ArenaPalette } from "./palette.ts";

const TAU = Math.PI * 2;

/** `advance_fight`'s `let roll = (h[8] as u64) % 24 + 4;` — the inclusive range of the damage roll,
 *  restated here because it is what `hitForce` normalises against. If the program's roll range ever
 *  moves, this is the one number on the canvas that has to move with it, and the failure mode is
 *  silent: every hit would simply read as maximum force. */
const ROLL_MIN = 4;
const ROLL_MAX = 27;

/** What share of a defender's WORTH a hit has to take to count as a full-toll blow.
 *
 *  Measured on the nine-fighter fixture rather than guessed. The opening exchanges take 10-23% of
 *  the defender's worth apiece; by t=15s a hit takes ~1%; past t=30s it is hundredths of a percent.
 *  15% puts the whole of the opening barrage at or near the top of the scale and everything after
 *  t=20s near the bottom, which is the shape of the fight. */
const TOLL_FULL = 0.15;

// --- the ring ------------------------------------------------------------------------------------
/** Lifetime, by TOLL. Both ends came down hard from a flat 250ms. 250ms of ring at ~n hits a second
 *  means the field is never not covered in expanding circles, which is wallpaper rather than an
 *  event; and a shockwave that is legible for a quarter of a second has stopped being a shock. 110ms
 *  is roughly seven frames — long enough to be seen leaving, short enough that the paper is empty
 *  again before the next blow, which is what makes the next blow land. */
const RING_MS = [110, 260] as const;
/** How far it travels, in multiples of the defender's own radius, by FORCE. It was a flat 2.35 and
 *  every hit therefore drew the same circle whatever the chain rolled. */
const RING_REACH = [1.6, 3.6] as const;
/** …AND THE TRAVEL IS CAPPED IN PIXELS, because a multiple of the radius is the wrong unit once the
 *  radii span 4px to 115px. Checked in a browser at the new size curve: a $124 fighter on a desktop
 *  panel is an 83px disc, and 3.6 of that is a 300px black circle — a quarter of the arena, centred
 *  on nothing in particular, reading as a diagram someone left on the paper rather than as that
 *  fighter being hit. A small fighter still gets the whole multiple (its 4px disc needs it); a large
 *  one gets a shockwave that hugs its own rim, which is also what a shockwave off a heavy object
 *  looks like. Scaled by the field's `unit` so it is the same fraction of the arena at any size. */
const RING_MAX_TRAVEL = 52;
/** Stroke weight at birth, by FORCE. Thinning as it expands (see `draw`) lets several concentric
 *  shockwaves stack without turning into a black disc. */
const RING_WIDTH = [1, 2.8] as const;
/** A SECOND ring behind the first, on heavy blows only: two concussions 45ms apart read as one
 *  violent event where one ring reads as one hit. Shorter and shallower than the lead ring so it is
 *  unmistakably its echo rather than a second, unexplained hit. */
const ECHO_FORCE = 0.55;
const ECHO_DELAY_MS = 45;
const ECHO_REACH_SHARE = 0.62;

// --- the spall fan -------------------------------------------------------------------------------
/** Heavy blows only. At every hit this is confetti; at the top ~55% of the roll range it is the
 *  mark that separates a real exchange from a tap, and on the fixture it fires through the opening
 *  barrage and then only occasionally — which is the arc the fight actually has. */
const FAN_FORCE = 0.42;
const FAN_ARMS = 5;
/** Total angular width of the cone, centred on the attacker→defender normal. A cone rather than a
 *  full circle because it is spall, not an explosion: it says which way the blow came from, which is
 *  a second, wordless statement of the same fact the connector line makes. */
const FAN_SPREAD = 1.5;
const FAN_MS = 150;
const FAN_REACH = [1.4, 2.4] as const;
/** Same pixel cap as the ring, for the same reason and at a shorter throw: spall thrown 200px clear
 *  of a big disc stops being debris off that fighter and becomes five unexplained tick marks. */
const FAN_MAX_TRAVEL = 34;
/** Length of one dash, as a share of the defender's radius. Shrinks to nothing over the fan's life,
 *  so the marks read as fragments thrown clear rather than as rays drawn outward. */
const FAN_DASH = 0.3;

// --- the connector -------------------------------------------------------------------------------
const LINE_MS = [90, 200] as const;
const LINE_WIDTH = [1, 2.4] as const;
/** How much of the connector's length has been eaten by the time it dies. Not 1: a line that
 *  retracts the whole way vanishes into the defender's rim and the last frames of it are nothing at
 *  all, where stopping short leaves a short hard stub at the moment of maximum fade. */
const LINE_RETRACT = 0.92;

// --- the figure ----------------------------------------------------------------------------------
/** Type size and lifetime, by TOLL. A flat 10.5px/900ms gave a hit that moved a hundredth of a cent
 *  exactly as much of the page, for exactly as long, as one that took a fifth of a fighter. */
const FIGURE_SIZE = [9, 15] as const;
const FIGURE_MS = [520, 950] as const;
const FIGURE_RISE = [22, 40] as const;
/** Past this the figure is set in the page's 600 weight — the same weight `draw.ts` reserves for
 *  YOUR name, and for the same reason: it is the thing on the frame you must not miss. */
const FIGURE_BOLD_TOLL = 0.5;
/** Cap height of this string as a share of its size. Every damage figure is `−`, `$`, digits and a
 *  `.` — no descenders and no lowercase — so its ink is its caps, and a box measured in em would
 *  reserve a third more height than the glyphs ever occupy and push labels around for nothing. */
const FIGURE_CAP_SHARE = 0.75;

/** HOW MANY OF EACH MARK MAY BE ALIVE AT ONCE — and these are now ENFORCED as lengths rather than
 *  merely used to derive the spacings below.
 *
 *  They used to be enforced only in the sense that a mark's life divided by its minimum spacing came
 *  out at the cap. That is a rate argument, and it holds exactly as long as marks arrive at a rate:
 *  a catch-up burst hands the controller a hundred events on ONE timestamp, every spacing test
 *  compares against a gap of zero milliseconds, and the caps are simply not present in the code.
 *  `advanceReplay` now suppresses those bursts at the source, which is the right fix and the reason
 *  this is a backstop rather than the answer — but a documented invariant that is only true because
 *  of an argument made in another file is one refactor away from being false, and the cost of making
 *  it structural is one comparison per mark. */
const MAX_RINGS = 14;
const MAX_FANS = 5;
const MAX_LINES = 8;
const MAX_FIGURES = 14;

/** Drops the OLDEST mark when a list is at its cap, so a new one always gets on the field. Index 0
 *  is the oldest: marks are only ever appended, and the one exception — an echo ring, pushed with a
 *  `bornMs` in the future — is pushed immediately after its own lead ring, so it is never the
 *  element being evicted in preference to something younger. */
function push<T>(list: T[], mark: T, cap: number): void {
  if (list.length >= cap) list.splice(0, list.length - cap + 1);
  list.push(mark);
}

/** Removes everything expired, in place, preserving order and allocating nothing. `splice` in a loop
 *  is the obvious form and it returns a discarded single-element array per removal; a compacting
 *  write index does the same job in one pass. */
function cull<T extends { bornMs: number; ms: number }>(list: T[], nowMs: number): void {
  let write = 0;
  for (let i = 0; i < list.length; i++) {
    if (nowMs - list[i].bornMs < list[i].ms) list[write++] = list[i];
  }
  list.length = write;
}

// Derived from each mark's LONGEST possible life, so a cap and its spacing can never drift apart.
const RING_MIN_GAP_MS = RING_MS[1] / MAX_RINGS;
const FAN_MIN_GAP_MS = FAN_MS / MAX_FANS;
const LINE_MIN_GAP_MS = LINE_MS[1] / MAX_LINES;
const FIGURE_MIN_GAP_MS = FIGURE_MS[1] / MAX_FIGURES;

/** The blows a throttle may not drop — see this file's header. */
const URGENT_FORCE = 0.8;
const URGENT_TOLL = 0.5;

/** Consecutive hits land on the same defender at the same point and outlive each other; without a
 *  fan-out they render as one illegible smear of digits. A ROTATING offset rather than a random one,
 *  because random jitter allows two in a row to coincide, which is the case that matters.
 *
 *  It is now also the CANDIDATE LIST for the placement search below, walked from the rotating index —
 *  so the rotation still separates consecutive hits on one defender when everything is free, and the
 *  same list doubles as the set of places a blocked figure is allowed to try instead. */
const FIGURE_FAN_PX = [0, -26, 26, -13, 13];
/** …and a second SHELF above the first, tried only when the whole fan on the near one is taken. Two
 *  attackers working the same defender at the chain's pace produce three or four live figures around
 *  one small circle, and five horizontal slots is not enough for them: the rotation alone put
 *  `−$0.069` and `−$0.038` on top of each other on a real fixture frame, which is not two readings, it
 *  is neither. One shelf's height clears the whole of another figure's climb, so a number on the far
 *  shelf can never rise into one on the near shelf.
 *
 *  Measured against the LARGEST figure this file can now set, not against the one being placed: the
 *  shelves have to clear each other for every pairing of sizes, and a shelf sized for a 9px figure
 *  would let a 15px one rise straight into the row above it.
 *
 *  Two shelves and no more. A third would stand 130px over a fighter's head, and a damage figure that
 *  far from the disc it belongs to has stopped saying whose damage it is. */
const FIGURE_SHELF_PX = FIGURE_RISE[1] + FIGURE_SIZE[1] * FIGURE_CAP_SHARE + 4;
const FIGURE_SHELVES = 2;

// --- the camera ----------------------------------------------------------------------------------
/** SCREEN SHAKE, scaled to the toll and gone almost before it registers.
 *
 *  `web/index.html` had one (`w.shake = 14`, decayed 0.86 a frame) and it is the one thing from the
 *  original this page had dropped that it should not have: a jolt is how a viewer's eye is told
 *  something happened somewhere they were not looking, and a field of sixteen circles is exactly the
 *  case where they were not looking. It is a THIRD of the original's amplitude because that one was
 *  tuned for a dark canvas full of particles and this is a technical drawing on paper — 3.6px is a
 *  flinch, 14 would be a page fault.
 *
 *  Decays at 15/s, i.e. half gone in 46ms, so it is a hit rather than a wobble; and it is floored to
 *  zero rather than allowed to trail, because a permanent sub-pixel tremor is a blurry page.
 *
 *  Never sampled under `prefers-reduced-motion` — the loop does not call `shake()` at all there. */
const SHAKE_HIT_PX = 3.6;
const SHAKE_DEATH_PX = 6.5;
const SHAKE_DECAY = 15;
const SHAKE_FLOOR = 0.15;

// --- death ---------------------------------------------------------------------------------------
/** A FIGHTER GOING OUT IS THE LOUDEST THING THAT HAPPENS IN THIS GAME, and it used to happen in
 *  silence — the disc simply became a grey outline between one frame and the next.
 *
 *  Measured on the nine-fighter fixture: six fighters go out, at t=33s, 57s, 64s, 73s, 83s and 94s.
 *  Every one of them lands in the stretch where the discs have stopped moving (90% of all size
 *  movement is done by t=19s), so for three quarters of a fight the deaths are the ONLY events left
 *  and they were the only events not being drawn. Everything below is the hit vocabulary at its
 *  ceiling and past it: further, harder, longer, all round rather than in a cone. */
const DEATH_RING_MS = 300;
const DEATH_ECHO_MS = 240;
const DEATH_REACH = 3.9;
const DEATH_ECHO_REACH = 2.4;
const DEATH_RING_WIDTH = 2.6;
const DEATH_ARMS = 9;
const DEATH_FAN_MS = 260;
const DEATH_FAN_REACH = 2.7;

/** A LIVE POSITION ON THE FIELD, held by a mark and re-read on every frame it is drawn.
 *
 *  Rings and spall are anchored to the fighter rather than snapshotted at the point of impact, and
 *  that is a deliberate departure from physics. A shockwave really does stay where it happened — but
 *  the motion in this arena is now fast enough that a defender covers 50-odd pixels inside a ring's
 *  260ms life, and a hard black circle sitting in clear paper next to the fighter it belongs to does
 *  not read as "that fighter was hit", it reads as a second thing having happened somewhere else.
 *  Screenshotted at the new speeds before this was anchored: two concentric rings floating a disc's
 *  width to the left of ONYX_39, attached to nothing.
 *
 *  The caller passes the `ArenaBody` itself, which survives every frame the field is not rebuilt —
 *  and the one thing that rebuilds it, a lineup change, calls `clear()` in the same breath. */
export interface ImpactAnchor {
  readonly x: number;
  readonly y: number;
}

interface Ring {
  at: ImpactAnchor;
  r0: number;
  bornMs: number;
  ms: number;
  /** Absolute outer radius at full expansion, resolved at birth — see RING_MAX_TRAVEL. */
  outer: number;
  width: number;
}

interface Fan {
  at: ImpactAnchor;
  r0: number;
  outer: number;
  /** Centre of the cone, radians. */
  angle: number;
  /** Total angular width. Arms are laid evenly across it. */
  spread: number;
  arms: number;
  bornMs: number;
  ms: number;
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  bornMs: number;
  ms: number;
  width: number;
}

interface Figure {
  x: number;
  y: number;
  /** Half the drawn width, kept so the per-frame occlusion test costs no arithmetic. */
  halfW: number;
  text: string;
  bornMs: number;
  ms: number;
  size: number;
  cap: number;
  rise: number;
  /** The full CSS font shorthand, resolved ONCE at birth. Size and weight are both fixed for a
   *  figure's whole life, and `draw` runs sixty times a second over up to fourteen of them — building
   *  the string per figure per frame is ~840 throwaway strings a second to hand the canvas a value
   *  that never changes. draw.ts makes the same point about the label passes and restructures around
   *  it; this is the cheaper version of the same fix. */
  font: string;
}

/** Where the camera is this frame, in CSS px. One of these exists per loop and is written in place —
 *  see `shake`. */
export interface ShakeOffset {
  x: number;
  y: number;
}

export interface ImpactController {
  /** Called the instant the playhead crosses an event — never speculatively, never twice. */
  fire(input: {
    nowMs: number;
    amount: bigint;
    /** The roll, normalised — `hitForce`. */
    force: number;
    /** The share of the defender's worth that moved, normalised — `hitToll`. */
    toll: number;
    attacker: (ImpactAnchor & { r: number }) | undefined;
    /** Held for the life of every ring and spall fan it produces — see `ImpactAnchor`. */
    defender: (ImpactAnchor & { r: number }) | undefined;
    /** The field's own scale, so a mark is the same fraction of the arena at any panel size. */
    unit: number;
    /** Beyond this the connector is dropped — see the call site. */
    maxLineDist: number;
    /** Field width, so a figure on a fighter pinned to a wall is clamped inside the frame the way a
     *  label is (`draw.ts`'s `labelX`) rather than running off the paper. */
    fieldW: number;
    /** The text already on the field. Note this is the PREVIOUS frame's map: `fire` runs from the
     *  replay's event callback, which is several steps before this frame's layout exists. One frame
     *  of staleness at 60fps is under two device pixels of drift for a fighter at full tilt, and the
     *  alternative — deferring placement to the first paint — would mean deciding where a figure goes
     *  after its throttle has already claimed the slot. */
    ink: InkMap;
  }): void;
  /** A fighter has just left the field — knocked out or extracted. Never throttled: there are at
   *  most `MAX_FIGHTERS` of these in a whole round and each one is the end of somebody's game. */
  die(input: { nowMs: number; at: ImpactAnchor; r: number; unit: number }): void;
  /** Culls anything expired. Takes an absolute clock rather than a delta so cleanup is exact under
   *  frame jitter. */
  update(nowMs: number): void;
  draw(ctx: CanvasRenderingContext2D, palette: ArenaPalette, nowMs: number, ink: InkMap): void;
  /** Where the camera should sit this frame, written into `out` so a frame allocates nothing.
   *  `unit` is the field's own scale, so the jolt is the same fraction of the arena at every size. */
  shake(nowMs: number, unit: number, out: ShakeOffset): void;
  /** A different fight starts now — drop everything in flight, including the throttle clocks, so the
   *  new fight's first hit is never suppressed because of when the last one's last hit happened. */
  clear(): void;
}

/** THE FULL DYNAMIC RANGE OF A RAID, in at most eight characters, with no lie at either end.
 *
 *  Both ends are real and they are eleven orders of magnitude apart. `usd()` rounds to 2dp below
 *  $1,000, which collapses every small raid to "$0.00" — the exact bug `web/index.html` called out
 *  and fixed with a third decimal — because raids are a percentage of remaining hp and late-fight
 *  hits are genuinely tiny: at UNITS_PER_USD = 1e6 a hit can be a single unit, i.e. $0.000001. The
 *  other end is a chain-sized round, where a single raid off a $13T fighter printed in full is
 *  nineteen characters flying across the field.
 *
 *  So: three decimals below a dollar, an explicit "less than" below a tenth of a cent (because
 *  "$0.000" is the same lie one digit later), and `usdCompact` from a dollar up — which keeps cents
 *  to $1,000 and scales after. Width matters here more than anywhere: `fire` clears a figure's whole
 *  flight path against every label on the field using `monoWidth(text.length)`, so a long figure is
 *  a figure that cannot find anywhere to fly and is dropped. */
export function damageLabel(amount: bigint): string | null {
  if (amount <= 0n) return null;
  if (amount < 1_000n) return "−<$0.001";
  if (amount < 1_000_000n) return `−${usd(amount, 3)}`;
  // Negated rather than prefixed, so the minus is the same glyph and the same rule as every other
  // signed figure on the page rather than a second hand-written one.
  return usdCompact(-amount);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(range: readonly [number, number], t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}

/** HOW HARD THE CHAIN SWUNG, recovered from the numbers it published.
 *
 *  `advance_fight` is `dmg = min(hp_a, hp_d) * roll / 100`, so the roll is `dmg * 100 / basis` and
 *  the basis is the smaller of the two rings AS THEY WERE BEFORE THE BLOW — which is what the caller
 *  must pass. (`applyHitEvent` has already moved the money by the time the loop's event callback
 *  runs, so the defender's pre-hit ring is `hp + amount`; the attacker's ring is untouched by its own
 *  blow and can be read straight off the shadow.)
 *
 *  Two edge cases, both real and both handled by the clamp rather than by a branch:
 *    - THE DUST FINISH. `if fighters[d].hp <= DUST { dmg = fighters[d].hp }` hands over the whole
 *      remaining ring, so the implied "roll" is 100. That IS a fighter being finished off and full
 *      force is the honest reading of it.
 *    - INTEGER TRUNCATION. The chain divides by 100 in `u64`, so a recovered roll sits a hair under
 *      the real one; at the smallest rings it can land below ROLL_MIN. Floored at zero.
 *
 *  Pure and exported so `impact.test.ts` can pin both ends against the constants in lib.rs. */
export function hitForce(amount: bigint, attackerHp: bigint, defenderHp: bigint): number {
  const basis = attackerHp < defenderHp ? attackerHp : defenderHp;
  if (basis <= 0n) return 1;
  const roll = (Number(amount) * 100) / Number(basis);
  return clamp((roll - ROLL_MIN) / (ROLL_MAX - ROLL_MIN), 0, 1);
}

/** WHAT THE BLOW COST, as a share of what the defender was worth before it — the quantity the disc's
 *  own size is about to move by, and therefore the one that says whether a viewer will SEE this hit
 *  or merely be told about it. `worthBefore` is `hp + banked` at the instant before the exchange. */
export function hitToll(amount: bigint, worthBefore: bigint): number {
  if (worthBefore <= 0n) return 1;
  return clamp(Number(amount) / Number(worthBefore) / TOLL_FULL, 0, 1);
}

/** The box a figure will have swept by the time it expires: it is drawn on an alphabetic baseline at
 *  `y` and rises over its life, so its ink occupies everything from one cap height above the top of
 *  that climb down to the baseline it started on.
 *
 *  The SWEPT box rather than the box it has right now, because a figure is placed once and then
 *  animates: testing only the birth position would put a number in clear paper that walks into a name
 *  three hundred milliseconds later, which is the collision this whole pass exists to prevent. */
function sweptTop(y: number, rise: number, cap: number): number {
  return y - rise - cap;
}

/** Does this box overlap a figure already in flight? Figures are not in the ink map — they must never
 *  displace a label — so they check each other directly. */
function hitsFigures(figures: Figure[], x0: number, y0: number, x1: number, y1: number): boolean {
  for (const f of figures) {
    if (x0 < f.x + f.halfW && x1 > f.x - f.halfW && y0 < f.y && y1 > sweptTop(f.y, f.rise, f.cap)) return true;
  }
  return false;
}

export function createImpactController(): ImpactController {
  const rings: Ring[] = [];
  const fans: Fan[] = [];
  const lines: Line[] = [];
  const figures: Figure[] = [];

  let lastRingMs = -Infinity;
  let lastFanMs = -Infinity;
  let lastLineMs = -Infinity;
  let lastFigureMs = -Infinity;
  let fanIndex = 0;

  // The camera's amplitude and the clock it was last decayed against. Decayed lazily — on every kick
  // and on every sample — so no work happens on a frame with no shake in it and none is needed.
  let shakeAmp = 0;
  let shakeMs = 0;

  function decayShake(nowMs: number): void {
    if (shakeAmp <= 0) {
      shakeMs = nowMs;
      return;
    }
    const dt = Math.max(0, nowMs - shakeMs) / 1000;
    shakeMs = nowMs;
    shakeAmp *= Math.exp(-SHAKE_DECAY * dt);
    if (shakeAmp < SHAKE_FLOOR) shakeAmp = 0;
  }

  function kickShake(nowMs: number, px: number): void {
    decayShake(nowMs);
    // MAX, not sum: two hits in the same frame is a busier fight, not a bigger earthquake, and
    // accumulating would let the opening barrage shake the page off its hinges.
    if (px > shakeAmp) shakeAmp = px;
  }

  /** `reach` is in radii and `unit` caps it in pixels — see RING_MAX_TRAVEL. Resolved once, here, so
   *  neither `update` nor `draw` has to know the rule exists. */
  function pushRing(
    at: ImpactAnchor,
    r0: number,
    bornMs: number,
    ms: number,
    reach: number,
    width: number,
    unit: number,
  ): void {
    push(rings, { at, r0, bornMs, ms, outer: Math.min(r0 * reach, r0 + RING_MAX_TRAVEL * unit), width }, MAX_RINGS);
  }

  return {
    fire({ nowMs, amount, force, toll, attacker, defender, unit, maxLineDist, fieldW, ink }) {
      // An out-of-range id from a caller-supplied stream: skip the flourish, don't throw. The hit
      // itself has already been applied by replay.ts either way.
      if (!defender) return;
      const urgent = force >= URGENT_FORCE;

      if (urgent || nowMs - lastRingMs >= RING_MIN_GAP_MS) {
        lastRingMs = nowMs;
        const reach = lerp(RING_REACH, force);
        const ms = lerp(RING_MS, toll);
        const width = lerp(RING_WIDTH, force);
        pushRing(defender, defender.r, nowMs, ms, reach, width, unit);
        // The echo. Born in the FUTURE and skipped by both `update` and `draw` until its time comes,
        // rather than queued somewhere that would need its own clock.
        if (force >= ECHO_FORCE) {
          pushRing(defender, defender.r, nowMs + ECHO_DELAY_MS, ms * 0.8, reach * ECHO_REACH_SHARE, width * 0.7, unit);
        }
      }

      // Everything below wants the contact normal, and only the spall fan and the connector need the
      // attacker at all. `atk` is null for a self-hit or an id the stream named that this field does
      // not have — both of which leave the ring, the figure and the shake to carry the event alone.
      const atk = attacker && attacker !== defender ? attacker : null;
      let nx = 0;
      let ny = 0;
      let dist = 0;
      if (atk) {
        const dx = defender.x - atk.x;
        const dy = defender.y - atk.y;
        dist = Math.hypot(dx, dy);
        if (dist > 0) {
          nx = dx / dist;
          ny = dy / dist;
        }
      }

      if (force >= FAN_FORCE && dist > 0 && (urgent || nowMs - lastFanMs >= FAN_MIN_GAP_MS)) {
        lastFanMs = nowMs;
        push(fans, {
          at: defender,
          r0: defender.r,
          outer: Math.min(defender.r * lerp(FAN_REACH, force), defender.r + FAN_MAX_TRAVEL * unit),
          angle: Math.atan2(ny, nx),
          spread: FAN_SPREAD,
          arms: FAN_ARMS,
          bornMs: nowMs,
          ms: FAN_MS,
        }, MAX_FANS);
      }

      if (atk && dist > 0 && (urgent || nowMs - lastLineMs >= LINE_MIN_GAP_MS)) {
        // Only when the pair is apart but not absurdly so. Too close and the line is a stray black
        // smudge between two overlapping circles; too far and it is a streak across the whole field.
        if (dist > atk.r + defender.r && dist <= maxLineDist) {
          lastLineMs = nowMs;
          push(lines, {
            x1: atk.x + nx * atk.r,
            y1: atk.y + ny * atk.r,
            x2: defender.x - nx * defender.r,
            y2: defender.y - ny * defender.r,
            bornMs: nowMs,
            ms: lerp(LINE_MS, force),
            width: lerp(LINE_WIDTH, force),
          }, MAX_LINES);
        }
      }

      const text = damageLabel(amount);
      if (text && (toll >= URGENT_TOLL || nowMs - lastFigureMs >= FIGURE_MIN_GAP_MS)) {
        // WHERE THE NUMBER GOES, and it is the same slot search the labels run — see ink.ts. The
        // figure wants the slot just over the defender's head; it walks the fan from the rotating
        // index, then the shelf above it, and takes the first candidate whose WHOLE FLIGHT is clear
        // of both the field's text and the figures already in the air. If all ten are taken it is
        // DROPPED — a hit that draws no number is a much smaller loss than a number nobody can read,
        // and the ring and the connector still say the hit happened.
        const size = lerp(FIGURE_SIZE, toll);
        const cap = size * FIGURE_CAP_SHARE;
        const rise = lerp(FIGURE_RISE, toll);
        const halfW = monoWidth(text.length, size) / 2;
        const head = defender.y - defender.r - 6;
        const start = fanIndex++;
        let x = 0;
        let y = 0;
        let placed = false;
        for (let shelf = 0; shelf < FIGURE_SHELVES && !placed; shelf++) {
          const baseY = head - shelf * FIGURE_SHELF_PX;
          const top = sweptTop(baseY, rise, cap);
          // OFF THE TOP OF THE PAPER is the one obstacle that is not in the ink map and never can
          // be. A figure is placed above its defender and then climbs, so a hit on a fighter near the
          // ceiling — which at sixteen on a phone is most of them, the field is 270px tall — is born
          // half outside the canvas and renders as a row of clipped digit tops. Screenshotted at
          // 390x844: `−$0.244` with its baseline on the frame's edge. The shelf above is further out
          // still, so this is a `break`, not a `continue`.
          if (top < 0) break;
          for (let i = 0; i < FIGURE_FAN_PX.length; i++) {
            const cx = clamp(
              defender.x + FIGURE_FAN_PX[(start + i) % FIGURE_FAN_PX.length],
              halfW + 2,
              fieldW - halfW - 2,
            );
            if (ink.hits(cx - halfW, top, cx + halfW, baseY)) continue;
            if (hitsFigures(figures, cx - halfW, top, cx + halfW, baseY)) continue;
            x = cx;
            y = baseY;
            placed = true;
            break;
          }
        }
        // The throttle clock only moves when a figure is actually born. Stamping it on a dropped one
        // would let a hit that drew nothing suppress the next hit that could have.
        if (placed) {
          lastFigureMs = nowMs;
          push(figures, {
            x,
            y,
            halfW,
            text,
            bornMs: nowMs,
            ms: lerp(FIGURE_MS, toll),
            size,
            cap,
            rise,
            font: monoFont(size, toll >= FIGURE_BOLD_TOLL ? 600 : 400),
          }, MAX_FIGURES);
        }
      }

      if (toll > 0) kickShake(nowMs, SHAKE_HIT_PX * toll);
    },

    die({ nowMs, at, r, unit }) {
      pushRing(at, r, nowMs, DEATH_RING_MS, DEATH_REACH, DEATH_RING_WIDTH, unit);
      pushRing(at, r, nowMs + ECHO_DELAY_MS, DEATH_ECHO_MS, DEATH_ECHO_REACH, DEATH_RING_WIDTH * 0.65, unit);
      push(fans, {
        at,
        r0: r,
        outer: Math.min(r * DEATH_FAN_REACH, r + FAN_MAX_TRAVEL * 1.5 * unit),
        angle: 0,
        // All round, with the last arm one gap short of the first so nine arms are nine marks rather
        // than eight and a double.
        spread: (TAU * (DEATH_ARMS - 1)) / DEATH_ARMS,
        arms: DEATH_ARMS,
        bornMs: nowMs,
        ms: DEATH_FAN_MS,
      }, MAX_FANS);
      kickShake(nowMs, SHAKE_DEATH_PX);
    },

    update(nowMs) {
      cull(rings, nowMs);
      cull(fans, nowMs);
      cull(lines, nowMs);
      cull(figures, nowMs);
    },

    shake(nowMs, unit, out) {
      decayShake(nowMs);
      if (shakeAmp <= 0) {
        out.x = 0;
        out.y = 0;
        return;
      }
      // Fresh noise per frame rather than a sinusoid, which is what a jolt looks like and what
      // `web/index.html` used. A sine at any frequency this short-lived aliases against 60Hz into a
      // slow standing wobble — the one thing this must not read as.
      const amp = shakeAmp * unit;
      out.x = (Math.random() - 0.5) * amp;
      out.y = (Math.random() - 0.5) * amp;
    },

    draw(ctx, palette, nowMs, ink) {
      ctx.save();
      ctx.strokeStyle = palette.ink;
      ctx.lineCap = "butt";

      // Connectors first, under everything: they are the longest mark on the field and the least
      // important of the three, and a shockwave crossing one should read as being in front of it.
      for (const l of lines) {
        const t = (nowMs - l.bornMs) / l.ms;
        if (t < 0) continue;
        // Held at full strength for the first ~40% and then gone, rather than fading from the instant
        // it appears. A mark that starts disappearing immediately never reads as having been struck.
        ctx.globalAlpha = Math.min(1, 2.4 * (1 - t));
        ctx.lineWidth = l.width;
        // The tail eats forward into the defender, so the force reads as travelling and arriving.
        // Squared, so it retracts slowly and then snaps — follow-through, not a wipe.
        const p = t * t * LINE_RETRACT;
        ctx.beginPath();
        ctx.moveTo(l.x1 + (l.x2 - l.x1) * p, l.y1 + (l.y2 - l.y1) * p);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }

      for (const r of rings) {
        const t = (nowMs - r.bornMs) / r.ms;
        if (t < 0) continue; // an echo whose delay has not elapsed
        ctx.globalAlpha = Math.min(1, 2.2 * (1 - t));
        // Thinning as it goes lets several concentric shockwaves stack without turning into a black
        // disc.
        ctx.lineWidth = r.width * (1 - t * 0.62);
        // Starts just inside the fighter's own outline and expands past it, so the ring appears to
        // come OFF the impact rather than to have always been drawn around the circle. `sqrt` rather
        // than linear: a shockwave leaves fast and decelerates, and a ring that expands at a constant
        // rate reads as a circle being animated rather than as something being thrown off.
        ctx.beginPath();
        ctx.arc(r.at.x, r.at.y, r.r0 * 0.85 + (r.outer - r.r0 * 0.85) * Math.sqrt(t), 0, TAU);
        ctx.stroke();
      }

      // SPALL. One path for every arm of every fan on the frame — at the caps above that is at most
      // 5 fans x 5 arms plus a death's 9, i.e. 34 segments in one stroke.
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let anyFan = false;
      for (const f of fans) {
        const t = (nowMs - f.bornMs) / f.ms;
        if (t < 0) continue;
        anyFan = true;
        const inner = f.r0 * 1.05;
        const travel = inner + (f.outer - inner) * Math.sqrt(t);
        const dash = f.r0 * FAN_DASH * (1 - t) + 2;
        for (let k = 0; k < f.arms; k++) {
          const a = f.arms === 1 ? f.angle : f.angle - f.spread / 2 + (f.spread * k) / (f.arms - 1);
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          ctx.moveTo(f.at.x + ca * travel, f.at.y + sa * travel);
          ctx.lineTo(f.at.x + ca * (travel + dash), f.at.y + sa * (travel + dash));
        }
      }
      if (anyFan) {
        // One alpha for every fan on the frame. They live 150ms and at most a handful overlap, so a
        // stroke per fan would buy a more correct fade at five times the draw calls; the oldest fan
        // on a crowded frame is over-drawn by a few percent and nothing else.
        ctx.globalAlpha = 0.85;
        ctx.stroke();
      }

      ctx.fillStyle = palette.ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (const f of figures) {
        const t = (nowMs - f.bornMs) / f.ms;
        if (t < 0) continue;
        const baseY = f.y - t * f.rise;
        // THE LAST WORD ON "never over a label". `fire` cleared this figure's whole flight path
        // against the text that was on the field at the moment it was born — but labels are attached
        // to fighters, and a fighter can walk one into a number that was placed in clear paper.
        // Checked again here, per frame, against where the text actually is.
        //
        // Suppressed rather than nudged. A figure that moved to dodge would be a number sliding
        // sideways across the field for reasons nothing on screen explains; a figure that stops being
        // drawn for the tail of its life is a number that was read and has gone, which is what a
        // damage floater looks like anyway.
        if (ink.hits(f.x - f.halfW, baseY - f.cap, f.x + f.halfW, baseY)) continue;
        // Hold full opacity for the first third, then fade: a number that starts disappearing the
        // instant it appears is a number nobody reads.
        ctx.globalAlpha = t < 0.34 ? 1 : 1 - (t - 0.34) / 0.66;
        ctx.font = f.font;
        ctx.fillText(f.text, f.x, baseY);
      }

      ctx.restore();
    },

    clear() {
      rings.length = 0;
      fans.length = 0;
      lines.length = 0;
      figures.length = 0;
      lastRingMs = -Infinity;
      lastFanMs = -Infinity;
      lastLineMs = -Infinity;
      lastFigureMs = -Infinity;
      fanIndex = 0;
      shakeAmp = 0;
    },
  };
}
