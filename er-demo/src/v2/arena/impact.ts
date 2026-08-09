// What a hit looks like. Three marks, all black, all short:
//
//   RING   a hard expanding circle at the point of impact, 250ms. No glow, no bloom, no fill — an
//          impact reads as a shockwave leaving the thing it happened to, and a filled flash would
//          simply cover the fighter you are trying to watch (`render/arena/impactFx.ts` learned that
//          one in a browser: several overlapping discs turned that corner of the arena into a solid
//          blob with the fight invisible underneath).
//   LINE   a 1px black segment between attacker and defender, 160ms — the only thing on the field
//          that says who took the money. Drawn edge to edge, not centre to centre, so it never
//          strikes through either circle.
//   FIGURE the damage in mono black, rising and fading. This is a trading terminal that happens to
//          be a game; the number IS the event.
//
// Nothing here is coloured and nothing here is soft. The dark-theme original spent a GlowFilter, an
// additive blend and a fourteen-particle burst per hit; on white, at this scale, all three would be
// noise laid over the one thing worth reading.
//
// PACING. The chain advances `stepsPerSecond(n) = n * 2` steps a second and roughly half of those
// produce a real exchange, so hits land at very nearly `n` per second: ~2/s in a duel, ~16/s at the
// program's cap of sixteen. That is slow enough that every hit can have its full mark, and the caps
// below are sized so nothing throttles in normal play — a full table's 16 hits/second sits just
// inside the 12.5/second the damage figures allow, and only a pathological burst trims anything.
//
// The caps still exist, and they are not decoration: they are the backstop that keeps a dense
// stretch from putting fifteen overlapping numbers on one defender, which conveys less than five do.
// Each mark's minimum spacing is DERIVED from its cap (duration / cap) rather than tuned separately,
// so the two can never drift apart.
//
// (These were first tuned against a flat 175 steps/second — the pre-stepped-fight constant that
// `render/gameLoop.ts` still carries. At that rate the throttles were doing violent work; at the
// real rate they are a guard rail. The numbers moved, the derivation didn't.)
//
// Dropping a mark affects NOTHING but the flourish: replay.ts advances fight state for every event
// independently of this module. Hp, deaths and the settled outcome are untouched.

import { usd } from "../contract.ts";
import type { InkMap } from "./ink.ts";
import { monoFont, monoWidth, type ArenaPalette } from "./palette.ts";

const RING_MS = 250;
const LINE_MS = 200;
/** Long enough to read a figure at the new pace, short enough that a full table's worth never
 *  becomes a wall of digits. */
const FIGURE_MS = 900;

const MAX_RINGS = 8;
const MAX_LINES = 6;
const MAX_FIGURES = 11;

const RING_MIN_GAP_MS = RING_MS / MAX_RINGS;
const LINE_MIN_GAP_MS = LINE_MS / MAX_LINES;
const FIGURE_MIN_GAP_MS = FIGURE_MS / MAX_FIGURES;

const FIGURE_RISE_PX = 34;
const FIGURE_SIZE = 10.5;
/** Cap height of this string as a share of its size. Every damage figure is `−`, `$`, digits and a
 *  `.` — no descenders and no lowercase — so its ink is its caps, and a box measured in em would
 *  reserve a third more height than the glyphs ever occupy and push labels around for nothing. */
const FIGURE_CAP = FIGURE_SIZE * 0.75;
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
 *  Two shelves and no more. A third would stand 130px over a fighter's head, and a damage figure that
 *  far from the disc it belongs to has stopped saying whose damage it is. */
const FIGURE_SHELF_PX = FIGURE_RISE_PX + FIGURE_CAP + 4;
const FIGURE_SHELVES = 2;

interface Ring {
  x: number;
  y: number;
  r0: number;
  bornMs: number;
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  bornMs: number;
}

interface Figure {
  x: number;
  y: number;
  /** Half the drawn width, kept so the per-frame occlusion test costs no arithmetic. */
  halfW: number;
  text: string;
  bornMs: number;
}

export interface ImpactController {
  /** Called the instant the playhead crosses an event — never speculatively, never twice. */
  fire(input: {
    nowMs: number;
    amount: bigint;
    attacker: { x: number; y: number; r: number } | undefined;
    defender: { x: number; y: number; r: number } | undefined;
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
  /** Culls anything expired. Takes an absolute clock rather than a delta so cleanup is exact under
   *  frame jitter. */
  update(nowMs: number): void;
  draw(ctx: CanvasRenderingContext2D, palette: ArenaPalette, nowMs: number, ink: InkMap): void;
  /** A different fight starts now — drop everything in flight, including the throttle clocks, so the
   *  new fight's first hit is never suppressed because of when the last one's last hit happened. */
  clear(): void;
  /** True while anything is on screen. */
  readonly busy: boolean;
}

/** `usd()` rounds to 2dp below $1,000, which collapses every small raid to "$0.00" — the exact bug
 *  `web/index.html` called out and fixed with a third decimal. Raids here are a percentage of
 *  remaining hp, so late-fight hits are genuinely tiny: at UNITS_PER_USD = 1e6 a hit can be a single
 *  unit, i.e. $0.000001. Three decimals below a dollar, and an explicit "less than" below a tenth of
 *  a cent — because "$0.000" is the same lie one digit later. */
export function damageLabel(amount: bigint): string | null {
  if (amount <= 0n) return null;
  if (amount < 1_000n) return "−<$0.001";
  return `−${usd(amount, amount < 1_000_000n ? 3 : 2)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The box a figure will have swept by the time it expires: it is drawn on an alphabetic baseline at
 *  `y` and rises `FIGURE_RISE_PX` over its life, so its ink occupies everything from one cap height
 *  above the top of that climb down to the baseline it started on.
 *
 *  The SWEPT box rather than the box it has right now, because a figure is placed once and then
 *  animates: testing only the birth position would put a number in clear paper that walks into a name
 *  three hundred milliseconds later, which is the collision this whole pass exists to prevent. */
function sweptTop(y: number): number {
  return y - FIGURE_RISE_PX - FIGURE_CAP;
}

/** Does this box overlap a figure already in flight? Figures are not in the ink map — they must never
 *  displace a label — so they check each other directly. */
function hitsFigures(figures: Figure[], x0: number, y0: number, x1: number, y1: number): boolean {
  for (const f of figures) {
    if (x0 < f.x + f.halfW && x1 > f.x - f.halfW && y0 < f.y && y1 > sweptTop(f.y)) return true;
  }
  return false;
}

export function createImpactController(): ImpactController {
  const rings: Ring[] = [];
  const lines: Line[] = [];
  const figures: Figure[] = [];

  let lastRingMs = -Infinity;
  let lastLineMs = -Infinity;
  let lastFigureMs = -Infinity;
  let fanIndex = 0;

  return {
    get busy() {
      return rings.length + lines.length + figures.length > 0;
    },

    fire({ nowMs, amount, attacker, defender, maxLineDist, fieldW, ink }) {
      // An out-of-range id from a caller-supplied stream: skip the flourish, don't throw. The hit
      // itself has already been applied by replay.ts either way.
      if (!defender) return;

      if (nowMs - lastRingMs >= RING_MIN_GAP_MS) {
        lastRingMs = nowMs;
        rings.push({ x: defender.x, y: defender.y, r0: defender.r, bornMs: nowMs });
      }

      if (attacker && attacker !== defender && nowMs - lastLineMs >= LINE_MIN_GAP_MS) {
        const dx = defender.x - attacker.x;
        const dy = defender.y - attacker.y;
        const dist = Math.hypot(dx, dy);
        // Only when the pair is apart but not absurdly so. Too close and the line is a stray black
        // smudge between two overlapping circles; too far and it is a streak across the whole field.
        if (dist > attacker.r + defender.r && dist <= maxLineDist) {
          lastLineMs = nowMs;
          const nx = dx / dist;
          const ny = dy / dist;
          lines.push({
            x1: attacker.x + nx * attacker.r,
            y1: attacker.y + ny * attacker.r,
            x2: defender.x - nx * defender.r,
            y2: defender.y - ny * defender.r,
            bornMs: nowMs,
          });
        }
      }

      const text = damageLabel(amount);
      if (text && nowMs - lastFigureMs >= FIGURE_MIN_GAP_MS) {
        // WHERE THE NUMBER GOES, and it is the same slot search the labels run — see ink.ts. The
        // figure wants the slot just over the defender's head; it walks the fan from the rotating
        // index, then the shelf above it, and takes the first candidate whose WHOLE FLIGHT is clear
        // of both the field's text and the figures already in the air. If all ten are taken it is
        // DROPPED — a hit that draws no number is a much smaller loss than a number nobody can read,
        // and the ring and the connector still say the hit happened.
        const halfW = monoWidth(text.length, FIGURE_SIZE) / 2;
        const head = defender.y - defender.r - 6;
        const start = fanIndex++;
        let x = 0;
        let y = 0;
        let placed = false;
        for (let shelf = 0; shelf < FIGURE_SHELVES && !placed; shelf++) {
          const baseY = head - shelf * FIGURE_SHELF_PX;
          const top = sweptTop(baseY);
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
          figures.push({ x, y, halfW, text, bornMs: nowMs });
        }
      }
    },

    update(nowMs) {
      for (let i = rings.length - 1; i >= 0; i--) if (nowMs - rings[i].bornMs >= RING_MS) rings.splice(i, 1);
      for (let i = lines.length - 1; i >= 0; i--) if (nowMs - lines[i].bornMs >= LINE_MS) lines.splice(i, 1);
      for (let i = figures.length - 1; i >= 0; i--) if (nowMs - figures[i].bornMs >= FIGURE_MS) figures.splice(i, 1);
    },

    draw(ctx, palette, nowMs, ink) {
      ctx.save();
      ctx.strokeStyle = palette.ink;
      ctx.lineCap = "butt";

      for (const l of lines) {
        const t = (nowMs - l.bornMs) / LINE_MS;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1);
        ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
      }

      for (const r of rings) {
        const t = (nowMs - r.bornMs) / RING_MS;
        ctx.globalAlpha = 1 - t;
        // Starts just inside the fighter's own outline and expands past it, so the ring appears to
        // come OFF the impact rather than to have always been drawn around the circle. Thinning as
        // it goes lets several concentric shockwaves stack without turning into a black disc.
        ctx.lineWidth = 1.6 - t * 0.9;
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r0 * (0.85 + t * 1.5), 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = palette.ink;
      ctx.font = monoFont(FIGURE_SIZE);
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (const f of figures) {
        const t = (nowMs - f.bornMs) / FIGURE_MS;
        const baseY = f.y - t * FIGURE_RISE_PX;
        // THE LAST WORD ON "never over a label". `fire` cleared this figure's whole flight path
        // against the text that was on the field at the moment it was born — but labels are attached
        // to fighters, and a fighter can walk one into a number that was placed in clear paper.
        // Checked again here, per frame, against where the text actually is.
        //
        // Suppressed rather than nudged. A figure that moved to dodge would be a number sliding
        // sideways across the field for reasons nothing on screen explains; a figure that stops being
        // drawn for the tail of its life is a number that was read and has gone, which is what a
        // damage floater looks like anyway.
        if (ink.hits(f.x - f.halfW, baseY - FIGURE_CAP, f.x + f.halfW, baseY)) continue;
        // Hold full opacity for the first third, then fade: a number that starts disappearing the
        // instant it appears is a number nobody reads.
        ctx.globalAlpha = t < 0.34 ? 1 : 1 - (t - 0.34) / 0.66;
        ctx.fillText(f.text, f.x, baseY);
      }

      ctx.restore();
    },

    clear() {
      rings.length = 0;
      lines.length = 0;
      figures.length = 0;
      lastRingMs = -Infinity;
      lastLineMs = -Infinity;
      lastFigureMs = -Infinity;
      fanIndex = 0;
    },
  };
}
