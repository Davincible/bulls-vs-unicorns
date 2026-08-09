// The painter. Everything here is flat vector on white — a filled circle, a hairline, a mono label —
// with ONE photographic element: the fighters' faces. No gradient, no shadow, no radius, no blend
// mode, per base.css's header, which is the law. (The artwork is the same exemption `TokenIcon.tsx`
// takes on the DOM side, for the same reason, and it is the only one.)
//
// The whole visual argument, in one place:
//
//   SIZE IS VALUE.  A fighter's area is proportional to what it still has in the ring, so the field
//     answers "who is winning" before you have read a single number — exactly what the original
//     game's drifting circles did. A hairline GHOST RING marks the size it entered at, so a mauled
//     fighter is a small disc sitting inside the outline of what it used to be. Diminished, not
//     merely small. A fighter that is winning simply bursts out past its own ghost.
//   A FIGHTER IS ITS COIN.  The disc is filled with the token's own logo, circle-clipped, inside a
//     rim in the side colour — `web/index.html`'s central visual move, and the reason its field was
//     legible instantly to someone who had never seen it. Two memecoin communities are fighting;
//     they should be visible as themselves and not as two abstract colours with a key. Every face
//     resolves through `faces.ts`'s `faceFor()`, which also carries the honest note about avatars.
//   IT EATS THE ENEMY.  A wedge of the OTHER side's colour, sized to the enemy's share of everything
//     a fighter has ever held — what they brought, plus what they took off the other side. The
//     original's help text was "watch a circle change colour as it eats the enemy", and it is still
//     the fastest read on the field. Half a disc means they have taken as much as they staked. See
//     `drawEnemyWedge`, which is also where the reference formula gets corrected for this program.
//   OUT IS OUT.  Dead or extracted: face desaturated and faded almost to nothing, a grey outline, a
//     greyed label, the word OUT in front of its money. No side colour anywhere on it — colour on
//     this field means "in play". There is no ambiguity about who is still fighting.
//   YOU ARE FINDABLE.  A black ring and four crosshair ticks, and your name in bold. Sixteen circles
//     is a crowd; you should never have to hunt.
//   LABELS ARE INK.  Names and figures are black on white, always. Colour on this page means "which
//     side", and a coloured label would be colour meaning something else.
//
// Draw order matters and is deliberate: lattice, ghosts, discs, markers, labels, then (from the
// loop) impact FX, then the hover readout on top of everything. Labels above discs so a fighter
// drifting across another's name never eats it; the readout above FX so a shockwave never obscures
// the thing you are pointing at.

import { SIDE_TOKEN, usd } from "../contract.ts";
import { faceFor } from "./faces.ts";
import { LABEL_SPACE, type ArenaBody, type ArenaField } from "./field.ts";
import type { InkMap } from "./ink.ts";
import { monoFont, monoWidth, type ArenaPalette } from "./palette.ts";

const TAU = Math.PI * 2;
const NAME_SIZE = 9.5;
const VALUE_SIZE = 9;

/** Below this radius the coin's artwork is mud — a 192px logo squeezed into a dozen device pixels is
 *  a smear that reads as dirt on the paper, while a flat disc in the side colour still says exactly
 *  which side it is. So the smallest fighters keep the flat fill, and the rim carries the identity
 *  either way. */
const FACE_MIN_RADIUS = 6.5;
/** The side-colour rim, as a share of the radius, floored and capped. FLOORED because a photographic
 *  disc has to survive at 8px, where a proportional rim would be a third of a pixel and side
 *  membership would rest entirely on a picture too small to see. CAPPED because past ~4px it stops
 *  reading as a rim and starts eating the face.
 *
 *  Widened from 0.17/[1.75, 3.25] after looking at a real late fight: a fighter deep into the enemy's
 *  colour has nothing but this rim left saying which side it belongs to, and at the first weight the
 *  rim lost that argument against a disc two-thirds full of the other colour. */
const RIM_SHARE = 0.2;
const RIM_RANGE = [2, 4] as const;
/** How strongly a corpse's face is drawn. Enough to say who it was, faint enough that a live fighter
 *  never has to compete with one for attention. */
const SPENT_ALPHA = 0.3;
/** The enemy wedge, over artwork. Well under `web/index.html`'s 0.55: that value was tuned against a
 *  flat radial-gradient disc with nothing in it worth preserving, and at the same strength over a
 *  photograph the wedge simply repaints the fighter — which would throw away the coin identity that
 *  is the whole point of putting the artwork there. At this weight it is unmistakably a TINT laid
 *  over a face rather than a second disc: you can see how far the enemy has got into it, and you can
 *  still see whose face it is. Checked at both extremes of the fixture. */
const WEDGE_ALPHA = 0.34;
/** Below this share the wedge is a sliver a couple of degrees wide, which is not a reading — it is a
 *  speck of the wrong colour on the edge of a disc. `web/index.html`'s threshold, kept. */
const WEDGE_MIN_FRAC = 0.03;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
/** Gap from a fighter's edge to the top of its name. Clears the widest marker drawn around a
 *  circle (the `isYou` crosshair, which reaches r + 9.5). */
const LABEL_GAP = 14;

/** Hover and selection rings sit outside everything else a body draws. `isYou` already owns the
 *  r+3.5 to r+9.5 band, so its ring goes further out rather than fighting the crosshair. */
function markerRadius(b: ArenaBody): number {
  return b.r + (b.isYou ? 13 : 6.5);
}

/** The survey lattice — the page's technical-instrument language, carried onto the field so the
 *  canvas reads as an instrument panel rather than as a hole cut in the paper. Two weights: a very
 *  faint grid, and registration crosses on every third intersection that give the eye something to
 *  measure motion against. It is the only thing on the field that isn't a fighter or a hit.
 *
 *  Anchored to the CENTRE, not the top-left, so the pattern stays symmetric as the parent resizes
 *  instead of appearing to slide out of one corner. */
export function drawLattice(ctx: CanvasRenderingContext2D, w: number, h: number, palette: ArenaPalette): void {
  const step = Math.max(56, Math.min(110, Math.round(Math.min(w, h) / 7)));
  const cx = w / 2;
  const cy = h / 2;
  const iMin = -Math.ceil(cx / step);
  const iMax = Math.ceil(cx / step);
  const jMin = -Math.ceil(cy / step);
  const jMax = Math.ceil(cy / step);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.grid;
  ctx.beginPath();
  for (let i = iMin; i <= iMax; i++) {
    // +0.5 puts a 1px stroke on the pixel rather than across two of them at half intensity — the
    // difference between a hairline and a smudge, and at this lightness a smudge is invisible.
    const x = Math.round(cx + i * step) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let j = jMin; j <= jMax; j++) {
    const y = Math.round(cy + j * step) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  const arm = 3.5;
  ctx.strokeStyle = palette.tick;
  ctx.beginPath();
  for (let i = iMin; i <= iMax; i++) {
    if (i % 3 !== 0) continue;
    for (let j = jMin; j <= jMax; j++) {
      if (j % 3 !== 0) continue;
      const x = Math.round(cx + i * step) + 0.5;
      const y = Math.round(cy + j * step) + 0.5;
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
    }
  }
  ctx.stroke();
  ctx.restore();
}

export interface BodyMarks {
  hoverId: number | null;
  selectedId: number | null;
}

/** `ink` arrives with the scoreboard watermark already claimed (arenaLoop paints it first) and leaves
 *  with every resolved label claimed too — which is what the damage figures then avoid. See ink.ts
 *  for why the three of them share one map. */
export function drawBodies(
  ctx: CanvasRenderingContext2D,
  field: ArenaField,
  palette: ArenaPalette,
  marks: BodyMarks,
  ink: InkMap,
): void {
  const bodies = field.bodies;

  // --- ghost rings: the size each fighter entered at ------------------------------------------
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.ghost;
  ctx.beginPath();
  for (const b of bodies) {
    // Only when it would actually be visible outside the disc. A ghost inside a growing winner's
    // fill is covered anyway; drawing it costs a path segment and says nothing.
    if (b.dead || b.r0 <= b.r + 1.5) continue;
    ctx.moveTo(b.x + b.r0, b.y);
    ctx.arc(b.x, b.y, b.r0, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();

  // --- the fighters themselves ------------------------------------------------------------------
  // Per body: face, then wedge, then rim. In that order, because each one has to sit on top of the
  // last — the wedge is a statement ABOUT the coin it covers, and the rim is what stops a photograph
  // from bleeding into white paper.
  for (const b of bodies) {
    drawFace(ctx, b, palette);
    if (!b.dead) {
      drawEnemyWedge(ctx, b, palette);
      drawRim(ctx, b, palette);
    } else {
      // Hollow, grey, 1px, unchanged: a marker rather than a player. Still sized by what they were
      // worth when they left, so an extraction and a wipeout do not look alike — and the greyed face
      // inside it says WHICH coin went out without spending any colour to do it.
      ctx.lineWidth = 1;
      ctx.strokeStyle = palette.ink4;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.stroke();
    }
  }

  // --- the at-risk boundary ----------------------------------------------------------------------
  // A paper-coloured hairline inside the disc at the radius of `hp` alone. Everything between it and
  // the edge is banked and safe; everything inside it is still in the ring and can still be taken.
  // That gap IS the question `extract()` asks, and it is the one thing about this program's
  // mechanics that the outline of a circle cannot say on its own. Suppressed near either extreme
  // (field.ts's RISK_BAND), so it appears only while it means something.
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.paper;
  ctx.beginPath();
  for (const b of bodies) {
    if (b.rRisk <= 0) continue;
    ctx.moveTo(b.x + b.rRisk, b.y);
    ctx.arc(b.x, b.y, b.rRisk, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();

  // --- you ---------------------------------------------------------------------------------------
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.ink;
  ctx.beginPath();
  for (const b of bodies) {
    if (!b.isYou) continue;
    const ring = b.r + 3.5;
    ctx.moveTo(b.x + ring, b.y);
    ctx.arc(b.x, b.y, ring, 0, Math.PI * 2);
    // Four ticks at the compass points: a reticle, not a highlight. Reads as an instrument locking
    // on rather than as a decoration applied to a favourite.
    const t0 = b.r + 5.5;
    const t1 = b.r + 9.5;
    ctx.moveTo(b.x - t1, b.y);
    ctx.lineTo(b.x - t0, b.y);
    ctx.moveTo(b.x + t0, b.y);
    ctx.lineTo(b.x + t1, b.y);
    ctx.moveTo(b.x, b.y - t1);
    ctx.lineTo(b.x, b.y - t0);
    ctx.moveTo(b.x, b.y + t0);
    ctx.lineTo(b.x, b.y + t1);
  }
  ctx.stroke();
  ctx.restore();

  // --- hover / selection -------------------------------------------------------------------------
  // Selection is ink and permanent; hover is a lighter grey and follows the pointer. Both are the
  // same shape, so a hovered selection doesn't produce two competing rings — ink simply wins.
  ctx.save();
  ctx.lineWidth = 1;
  for (const b of bodies) {
    const selected = marks.selectedId === b.id;
    const hovered = marks.hoverId === b.id;
    if (!selected && !hovered) continue;
    ctx.strokeStyle = selected ? palette.ink : palette.ink3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, markerRadius(b), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // --- labels ------------------------------------------------------------------------------------
  // Two passes, one font each. Canvas re-parses the font shorthand on every assignment, and
  // alternating name/value per fighter means 32 re-parses a frame instead of 2.
  //
  // Every label is CASED: stroked in paper before it is filled in ink (see `casedText`). At the
  // program's cap of sixteen fighters a melee puts several names in the same few hundred pixels, and
  // uncased they overprint each other and the discs behind them into something genuinely unreadable
  // — screenshotted at 16. A halo is what a map does with a place name over a contour line, it costs
  // one extra stroke per label, and it is invisible anywhere the field isn't crowded.
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.strokeStyle = palette.paper;
  // 2, not 3. At 3 the halo stops reading as a casing and starts reading as a white chip drawn
  // behind the text — a filled label, which is precisely the thing base.css forbids. 2 separates the
  // glyphs from whatever is under them and disappears.
  ctx.lineWidth = 2;

  const slots = layoutLabels(bodies, field, ink);

  ctx.font = monoFont(NAME_SIZE);
  for (const b of bodies) {
    if (b.isYou) continue;
    const top = slots.get(b.id);
    if (top === undefined) continue;
    ctx.fillStyle = b.dead ? palette.ink4 : palette.ink;
    casedText(ctx, b.name, labelX(b.x, b.name.length, NAME_SIZE, field.w), top);
  }
  ctx.font = monoFont(NAME_SIZE, 600);
  for (const b of bodies) {
    if (!b.isYou) continue;
    const top = slots.get(b.id);
    if (top === undefined) continue;
    ctx.fillStyle = b.dead ? palette.ink4 : palette.ink;
    casedText(ctx, b.name, labelX(b.x, b.name.length, NAME_SIZE, field.w), top);
  }

  ctx.font = monoFont(VALUE_SIZE);
  for (const b of bodies) {
    // WORTH, not `hp` — the same quantity the circle's size means (field.ts's `radiusFor`). A label
    // that disagreed with the shape it sits under would make both of them useless.
    //
    // The dead keep their figure, with the status in front of it. Dropping the number for a bare
    // "OUT" was the first attempt and it threw away real information: a fighter whose hp reached
    // zero still HOLDS everything it raided, that value still counts toward its side's total (see
    // `contract.ts`'s `sideTotals`), and an extracted player's whole point is the figure they left
    // with. "OUT" alone made a $48 corpse and a $0 one look identical.
    const top = slots.get(b.id);
    if (top === undefined) continue;
    const text = b.dead ? `OUT · ${usd(b.worth)}` : usd(b.worth);
    ctx.fillStyle = b.dead ? palette.ink4 : palette.ink2;
    casedText(ctx, text, labelX(b.x, text.length, VALUE_SIZE, field.w), top + NAME_SIZE + 3);
  }
  ctx.restore();
}

/** The coin's own logo, circle-clipped into the disc — `web/index.html`'s
 *  `save → arc → clip → drawImage → restore`, which is the whole trick and needs no more than that.
 *
 *  THE ART GOES ON, OR THE FLAT FILL DOES — never both, and never neither. The original carried a
 *  scar here worth not reinheriting: its fallback `else` had drifted onto the wrong `if`, so a solid
 *  circle was painted straight over the logo that had just been drawn and the art looked broken for
 *  weeks while working perfectly. One branch, one fill, no second opinion.
 *
 *  `drawImage` into the disc's square bounding box, so a square logo lands exactly inscribed and the
 *  clip only ever trims the corners. */
function drawFace(ctx: CanvasRenderingContext2D, b: ArenaBody, palette: ArenaPalette): void {
  const face = b.r >= FACE_MIN_RADIUS ? faceFor(b) : null;

  if (!face) {
    // No artwork yet (decoding, failed, disabled, or a token with none in the repo), or a disc too
    // small to carry it. The dead stay hollow, as they always were; the living get the flat disc
    // this field drew before there were faces. Nothing flickers: this is a complete rendering, not
    // a placeholder — a fighter that never loads its face is simply a fighter drawn in its colour.
    if (b.dead) return;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fillStyle = palette.side[b.side];
    ctx.fill();
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(b.x, b.y, b.r, 0, TAU);
  ctx.clip();
  // Desaturated AND faded for the out-of-play: either alone leaves a corpse competing with the
  // living for the eye, and a full-strength logo on a dead fighter is the one thing that could make
  // "who is still in this" ambiguous, which is the field's most important single reading.
  if (b.dead) ctx.globalAlpha = SPENT_ALPHA;
  ctx.drawImage(b.dead ? face.spent : face.art, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  ctx.restore();
}

/** THE WEDGE — "watch a circle change colour as it eats the enemy", which is how the original game
 *  explained itself in one line and is still the fastest read on this field. A pie slice from twelve
 *  o'clock, clockwise, in the OTHER side's colour, sized by how much of the other side this fighter
 *  has eaten.
 *
 *  WHY `banked` IS THE LOOT, and where that stops being true. `lib.rs`'s `Fighter` says it in the
 *  struct — `banked: u64, // value raided from the other side` — and `advance_fight` is the only
 *  thing that feeds it during a fight: `fighters[d].hp -= dmg; fighters[a].banked += dmg`. Everyone
 *  opens at `hp = stake, banked = 0` (`enter`, and `replay.ts`'s `buildShadow` mirrors it), nothing
 *  ever moves value back into `hp`, and banked money cannot be raided.
 *
 *  ONE exception, and it is why this is drawn for LIVE FIGHTERS ONLY: `extract()` also adds to
 *  `banked` — `f.banked += kept`, where `kept` is whatever was left in the ring less the house's
 *  penalty — and that money is the player's OWN, not the enemy's. A fighter who extracts early
 *  therefore ends with a large `banked` they never raided from anyone. But `extract()` sets `dead`
 *  in the same instruction (and `replay.ts`'s `applyExtractions` does both together), so by the time
 *  any of that value is in `banked` the fighter is out of play and is being drawn as OUT. There is
 *  no state in which a wedge is drawn over a `banked` that isn't loot.
 *
 *  THE DENOMINATOR IS `stake`, NOT `hp`. The original's ratio was
 *  `enFrac = enemy / (own + enemy)` — the enemy's share of everything the fighter is holding — and
 *  it worked there because `own` was a fighter's own coin, which started at their full entry and
 *  only ever fell by being raided. The obvious port, `banked / (hp + banked)`, substitutes the wrong
 *  thing for `own` and inverts the whole reading: in THIS program `hp` also falls when you are hit
 *  (`advance_fight` subtracts the damage from it and never adds anything back), so being beaten up
 *  RAISES the ratio and paints you more of the enemy's colour FOR LOSING. Screenshotted mid-fixture
 *  at 0.7 on a player who was down $14 on the round, and converging on 1.0 late for very nearly
 *  everybody, winner and victim alike — the entire field flipping to the wrong colour at once and
 *  distinguishing nobody. (At that point it is also a second drawing of the at-risk hairline below,
 *  which already encodes the same `hp : banked` split as area, and does it better.)
 *
 *  `banked / (stake + banked)` is the SAME ratio with `own` read as what the fighter BROUGHT, which
 *  is the quantity in this program that behaves the way the original's own-coin did: fixed at entry,
 *  never inflated by luck. The enemy's share of everything this fighter has ever held. It starts at
 *  zero, moves only when they take something, and is monotone in loot and in nothing else.
 *
 *  It also never reaches a full turn, which is a property and not an accident: half a disc is a
 *  fighter who has taken as much as they staked, four-fifths is 4x that, and the remaining sector
 *  always shows the coin's own face. A wedge that could close would repaint the artwork entirely at
 *  exactly the moment the fight gets interesting, and the artwork is the point.
 *
 *  This is field.ts's `radiusFor` lesson again, in a second place: a formula ported verbatim from
 *  the reference does not survive contact with this program's arithmetic. What ports is the MEANING.
 *
 *  Drawn at the full radius and then overstruck by the rim, so the loot is bounded by the fighter's
 *  own side colour instead of bleeding to the paper's edge. */
function drawEnemyWedge(ctx: CanvasRenderingContext2D, b: ArenaBody, palette: ArenaPalette): void {
  if (b.banked <= 0n) return;
  const frac = Number(b.banked) / Number(b.stake + b.banked);
  if (frac < WEDGE_MIN_FRAC) return;

  ctx.save();
  ctx.globalAlpha = WEDGE_ALPHA;
  ctx.fillStyle = palette.side[b.side === 0 ? 1 : 0];
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.arc(b.x, b.y, b.r, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The side rim. Two jobs, and it is the reason the artwork can be there at all:
 *
 *    1. A photograph has no edge. A flat disc ends where the colour stops; a logo that is mostly
 *       black on a light ground just fades into white paper and the circle loses its shape. The rim
 *       gives every fighter the same hard boundary the flat discs had.
 *    2. SIDE SURVIVES THE PICTURE. The two logos are easy to tell apart at size and to anyone who
 *       knows them — but at r=8 they are both a dark smudge, and a colour-blind reader gets nothing
 *       from the pairing at any size. Membership has to be carried by something the eye can resolve
 *       at every radius the field produces, in a stroke that is the exact colour the roster table
 *       and the side markers use.
 *
 *  Inset by half its width so the disc's outer edge stays at exactly `r` — the same number the
 *  collider, the hit test, the ghost ring, the reticle and the label offset are all built on. A rim
 *  stroked ON the boundary would make every fighter visually a pixel or two larger than it is. */
function drawRim(ctx: CanvasRenderingContext2D, b: ArenaBody, palette: ArenaPalette): void {
  const width = clamp(b.r * RIM_SHARE, RIM_RANGE[0], RIM_RANGE[1]);
  ctx.lineWidth = width;
  ctx.strokeStyle = palette.side[b.side];
  ctx.beginPath();
  ctx.arc(b.x, b.y, Math.max(b.r - width / 2, 0.5), 0, TAU);
  ctx.stroke();
}

/** Paper casing, then ink. The caller sets the font, the fill and the stroke once for a whole pass;
 *  this is only the two draw calls, in the order that puts the halo underneath. */
/** The height of a name+value label block. */
const LABEL_H = NAME_SIZE + 3 + VALUE_SIZE;
/** How far a label may be pushed from the band it wants before it is dropped instead.
 *
 *  There was no leash in the first version and it did not matter, because the only thing a label had
 *  to dodge was another label and the field was never that crowded. It matters now that the
 *  scoreboard watermark is in the map: a fighter standing on one of the two big figures would walk
 *  its label the whole 80-odd px past it and end up with a name floating in clear paper a disc and a
 *  half below the fighter it names, which on a nine-body field is genuinely ambiguous about whose
 *  name it is. Roughly four label heights: far enough to clear any single row of the watermark or one
 *  other label, short enough that the label is still visibly ATTACHED to its disc. Past that, drop —
 *  the same trade the no-room case has always made. */
const LABEL_REACH = 92;

/** WHERE EACH FIGHTER'S LABEL GOES, so that no label is ever drawn on top of another one, or on top
 *  of the scoreboard watermark underneath them both.
 *
 *  Casing (`casedText`) keeps a label legible over the lattice and over a disc. It does nothing about
 *  the case this solves: two labels in the same place, where the second simply cases over the first
 *  and both become unreadable. Screenshotted on a real 9-fighter frame — a dead fighter's
 *  `OUT · $69.12` printed across two live names, three strings inside one 40px band.
 *
 *  The rule is a slot search, not a physics: each label wants the band directly under its disc, and
 *  takes the first free one stepping DOWN from there, then UP above the disc if the field's bottom is
 *  reached. A label that can find no free band within `LABEL_REACH` is dropped rather than stacked or
 *  orphaned — one missing figure is a smaller lie than two overprinted ones, and the fighter is still
 *  identifiable by its disc, its face and its rim.
 *
 *  WHAT IT IS DODGING is whatever `ink.ts`'s map already holds, which by the time this runs is the
 *  scoreboard watermark, plus every label already placed on this pass. The watermark is in there
 *  because its captions and its record numerals are set at very nearly a label's own size: a disc
 *  crossing them is the fight happening in front of its scoreboard, but a 9.5px name crossing a 15px
 *  caption is two strings in one place and neither of them survives it (`ROUNDS WON · 16 SETTLED`,
 *  screenshotted with a name through it).
 *
 *  ORDER DECIDES WHO WINS A CONTESTED SLOT, and it is deliberate rather than array order: you first
 *  (you must always be able to find yourself), then the living, then the largest — and `id` last as
 *  the tiebreak, because it is stable for the life of the round. That stability is the point: the
 *  same fighter resolves to the same slot on every frame, so labels never flicker between two
 *  positions as bodies drift past each other, which reads worse than an overlap. */
function layoutLabels(bodies: ArenaBody[], field: ArenaField, ink: InkMap): Map<number, number> {
  const order = [...bodies].sort((p, q) => {
    if (p.isYou !== q.isYou) return p.isYou ? -1 : 1;
    if (p.dead !== q.dead) return p.dead ? 1 : -1;
    if (p.r !== q.r) return q.r - p.r;
    return p.id - q.id;
  });

  const out = new Map<number, number>();
  const STEP = 4;

  for (const b of order) {
    // The band is as wide as the WIDER of the two lines, since they share a centre.
    const chars = Math.max(b.name.length, (b.dead ? 12 : 0) + 7);
    const half = monoWidth(chars, NAME_SIZE) / 2;
    // The SAME clamp the painter applies (`labelX`). Reserving `b.x ± half` while drawing at the
    // clamped centre means a fighter pinned to a wall claims one rectangle and fills another, and the
    // fighters pinned to a wall are exactly the ones with a neighbour close enough to care.
    const cx = clamp(b.x, half + 2, field.w - half - 2);
    const x0 = cx - half;
    const x1 = cx + half;

    let top: number | null = null;
    const below = b.y + b.r + LABEL_GAP;
    // `field.h - LABEL_SPACE` and not `field.h`: the bottom strip is a margin the field does not draw
    // into, and the shell's fixed bottom nav is sitting on it. See field.ts's LABEL_SPACE.
    const floor = field.h - LABEL_SPACE;
    for (let y = below; y <= below + LABEL_REACH && y + LABEL_H <= floor; y += STEP) {
      if (!ink.hits(x0, y, x1, y + LABEL_H)) { top = y; break; }
    }
    if (top === null) {
      // Nothing below — try above the disc, walking up from just over its rim.
      const above = b.y - b.r - LABEL_GAP - LABEL_H;
      for (let y = above; y >= above - LABEL_REACH && y >= 0; y -= STEP) {
        if (!ink.hits(x0, y, x1, y + LABEL_H)) { top = y; break; }
      }
    }
    if (top === null) continue;   // genuinely no room — drop it rather than stack it
    ink.claim(x0, top, x1, top + LABEL_H);
    out.set(b.id, top);
  }
  return out;
}

function casedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Keeps a centred label inside the field. A fighter pinned against the left or right wall has its
 *  name running out through the parent's frame otherwise — the vertical case is handled up front by
 *  `field.ts`'s LABEL_SPACE, but a name is wider than a circle and no wall inset can fix that
 *  without wasting half the field.
 *
 *  Width is estimated from the character count rather than measured — see `MONO_ADVANCE`. */
function labelX(x: number, chars: number, size: number, fieldW: number): number {
  const half = monoWidth(chars, size) / 2;
  return clamp(x, half + 2, fieldW - half - 2);
}

/** An empty field is a real state, not a failure: the lobby opens with nobody in it. One line of the
 *  page's own micro-label type, centred, says so — a blank white rectangle inside a hairline frame
 *  reads as something that failed to load. */
export function drawEmpty(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  palette: ArenaPalette,
  phase: string,
): void {
  ctx.save();
  ctx.fillStyle = palette.ink4;
  ctx.font = monoFont(10);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = phase === "Lobby" || phase === "Drawing" ? "AWAITING ENTRIES" : "NO FIGHTERS";
  // Tracked out to match `.u`'s 0.14em, which canvas has no letter-spacing property for on older
  // engines — drawn glyph by glyph so it matches the rest of the page's micro-labels exactly.
  drawTracked(ctx, text, w / 2, h / 2, 1.4);
  ctx.restore();
}

/** Canvas 2D's `letterSpacing` is recent and unevenly supported; the page's micro-label type is
 *  defined by its tracking, so it gets drawn a glyph at a time rather than approximated. Only used
 *  for the handful of tracked labels on the field, never for figures.
 *
 *  Exported for `scoreboard.ts`, which sets the two side names in the same type at a larger size —
 *  the alternative was a second implementation of `.u`'s tracking, and two of those drift. Uses
 *  whatever font, fill, alpha and baseline the caller has set; it centres on `cx` regardless of the
 *  incoming `textAlign`, and puts that back before it returns. */
export function drawTracked(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, extra: number): void {
  const widths: number[] = [];
  let total = 0;
  for (const ch of text) {
    const wch = ctx.measureText(ch).width;
    widths.push(wch);
    total += wch + extra;
  }
  total -= extra;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  let x = cx - total / 2;
  let i = 0;
  for (const ch of text) {
    ctx.fillText(ch, x, y);
    x += widths[i++] + extra;
  }
  ctx.textAlign = prevAlign;
}

const READOUT_PAD = 7;
const READOUT_ROW = 13;
const READOUT_GAP = 16;

/** The hover readout: name, which side, ring value, banked. A hairline box with a white fill —
 *  the same construction as a `.toast`, drawn in the canvas so it is DPR-correct and can never lag a
 *  frame behind the circle it belongs to.
 *
 *  Drawn last, above the impact FX, and flipped away from the edges so it is never clipped by the
 *  parent's frame. */
export function drawReadout(
  ctx: CanvasRenderingContext2D,
  b: ArenaBody,
  pointerX: number,
  pointerY: number,
  w: number,
  h: number,
  palette: ArenaPalette,
): void {
  // WORTH first because it is what the circle's size says; RING and BANKED break it into the part
  // still exposed and the part already safe — the split the disc only hints at with its at-risk
  // hairline, and the exact numbers a player weighing an `extract()` is after.
  const rows: [string, string][] = [
    ["SIDE", SIDE_TOKEN[b.side].name],
    ["WORTH", usd(b.worth)],
    ["RING", b.dead ? "—" : usd(b.hp)],
    ["BANKED", usd(b.banked)],
  ];
  const title = b.dead ? `${b.name}  OUT` : b.name;

  ctx.save();
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  ctx.font = monoFont(NAME_SIZE, b.isYou ? 600 : 400);
  let width = ctx.measureText(title).width;
  ctx.font = monoFont(VALUE_SIZE);
  for (const [label, value] of rows) {
    width = Math.max(width, ctx.measureText(label).width + READOUT_GAP + ctx.measureText(value).width);
  }
  const boxW = width + READOUT_PAD * 2;
  const boxH = READOUT_PAD * 2 + READOUT_ROW + rows.length * READOUT_ROW;

  let x = pointerX + 14;
  let y = pointerY + 14;
  if (x + boxW > w - 2) x = pointerX - 14 - boxW;
  if (y + boxH > h - 2) y = pointerY - 14 - boxH;
  x = Math.max(2, Math.round(x)) + 0.5;
  y = Math.max(2, Math.round(y)) + 0.5;

  ctx.fillStyle = palette.paper;
  ctx.fillRect(x, y, boxW, boxH);
  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.ink;
  ctx.strokeRect(x, y, boxW, boxH);

  ctx.fillStyle = b.dead ? palette.ink4 : palette.ink;
  ctx.font = monoFont(NAME_SIZE, b.isYou ? 600 : 400);
  ctx.fillText(title, x + READOUT_PAD, y + READOUT_PAD);

  ctx.font = monoFont(VALUE_SIZE);
  let rowY = y + READOUT_PAD + READOUT_ROW + 1;
  for (const [label, value] of rows) {
    ctx.fillStyle = palette.ink3;
    ctx.fillText(label, x + READOUT_PAD, rowY);
    ctx.fillStyle = palette.ink;
    ctx.textAlign = "right";
    ctx.fillText(value, x + boxW - READOUT_PAD, rowY);
    ctx.textAlign = "left";
    rowY += READOUT_ROW;
  }
  ctx.restore();
}
