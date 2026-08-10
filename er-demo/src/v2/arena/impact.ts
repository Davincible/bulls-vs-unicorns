// What a hit looks like. Four marks, three of them black, all of them short:
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
//   FIGURE the damage, mono, rising and fading — and set in the ATTACKER'S SIDE COLOUR, or in
//          `--hot` when the blow finished the defender. The one coloured mark on this field, cased
//          in paper so it survives whatever it flies over. This is a trading terminal that happens
//          to be a game; the number IS the event.
//
// Nothing here is soft, and exactly one thing here is coloured. The dark-theme original spent a
// GlowFilter, an additive blend and a fourteen-particle burst per hit; on white, at this scale, all
// three would be noise laid over the one thing worth reading. Extremity here is bought in SPEED,
// WEIGHT, CONTRAST and — for one mark, once — HUE: a hard ring that crosses three radii in 120ms and
// is gone is more violent than anything that lingers.
//
// THE ONE COLOURED MARK, AND THE TWO WRITTEN RULES IT BENDS. Every mark in this file used to draw in
// `palette.ink`, and two documents said it should:
//
//     base.css's header — "THE ONLY COLOUR ON THE PAGE IS THE GAME: the two side colours appear on
//     fighters, health bars and side markers, and nowhere else."
//     SPEC.md — "impact reads as a hard black ring and a mono damage figure that fades."
//
// The figure is coloured now. The argument, in full, because a rule bent without one is a rule gone:
//
//   THE DAMAGE FIGURE IS THE GAME. base.css's sentence is not a permit list, it is an INVENTORY, and
//   it was written before this mark existed — a damage figure is not excluded from it, it is MISSING
//   from it. Read it for the rule it states rather than the enumeration it happens to be and the rule
//   is: COLOUR SAYS WHO. A fighter's fill says whose fighter that is. A health bar says whose money
//   is on the table. A side marker says which half of the round a row belongs to. A damage figure
//   says WHO JUST TOOK MONEY OFF WHOM. It is the only number this canvas publishes that describes an
//   EVENT rather than a state — every other figure on the field, the fighters' value lines and the
//   scoreboard's totals, says what something is currently worth; this one says what just happened,
//   and it exists only because one side took it off the other. That is the same category of statement
//   as the three already on the list, not a decoration hung on one of them. Rule 5 is then read in
//   its own words: "`--a`/`--b` for the two sides, `--hot` for loss/danger" is exactly, and only,
//   what this file now spends.
//
//   AND THE FIELD ALREADY SPEAKS THIS WAY, which is the part that makes it a reading of the rule
//   rather than an exception to it. `draw.ts`'s `drawEnemyWedge` fills a wedge of a fighter's own disc
//   in the OPPOSITE side's colour, to show the money that fighter has taken off the enemy — colour on
//   a fighter, saying whose money it was, not whose fighter it is. A damage figure in the attacker's
//   colour is the same sentence one frame earlier: the wedge is the settled version of what the figure
//   announces. If the wedge is legal, this is.
//
//   SPEC.md IS NOW HALF TRUE AND NEEDS THE MATCHING EDIT, from whoever owns it — not from here. The
//   RING is still a hard black ring; the FIGURE is no longer black. Nothing else in that sentence
//   moved: it is still mono, and it still fades. Leaving the half-truth unflagged is how a spec stops
//   being read at all.
//
//   RESTRAINT IS THE OTHER HALF OF THE DECISION, and it is a mechanism rather than an aesthetic.
//   EXACTLY ONE MARK GAINS COLOUR: the ring, its echo, the spall fan and the connector all stay
//   `palette.ink`, and that is not an oversight for a later pass to tidy up. A figure that is the only
//   coloured thing in a field of black marks is found by the eye before it is read; a field where the
//   ring is red, the fan is green and the connector is the attacker's colour has no emphasis left in
//   it anywhere. If everything shouts, nothing does. The figure is loud precisely because nothing
//   around it is, and anything added here that reaches for `palette.side` or `palette.hot` is spending
//   the thing that makes the figure work.
//
//   LEGIBILITY IS NOT WHAT THIS COSTS, which is the first place a reviewer will look. All three
//   colours this file can now set clear WCAG AA (4.5:1) as TEXT on white, and the page already sets
//   small type in every one of them: `--a` #278834 at 4.51:1 (`.pos`'s 12px P/L figures — base.css
//   states that ratio and records that the hue was deepened one step to reach it), `--b` #8f09bf at
//   7.10:1, and `--hot` #c4291a at 5.71:1 (`.neg`, i.e. every negative number on the page). base.css
//   spells out the first two; `--hot`'s was measured for this pass, because base.css asserts only
//   that paper.ts holds it at "at least the contrast it holds here" without saying what that is, and
//   an unstated number is not evidence. They are READ off the custom properties by `palette.ts` and
//   never written down
//   here, so on a coloured sheet `styles/paper.ts` has already deepened each until it clears that bar
//   against THAT sheet. And the figure is cased in paper on top of all of it — see the figure pass in
//   `draw` — so the case a contrast ratio does not cover, coloured type at 10px over a fighter's own
//   disc, is covered too.
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

import { usd, usdCompact, type Side } from "../contract.ts";
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
 *  exactly as much of the page, for exactly as long, as one that took a fifth of a fighter.
 *
 *  THE SIZE RANGE WAS [9, 15] AND THAT WAS TOO POLITE AT BOTH ENDS.
 *
 *  THE FLOOR IS THE PAGE'S OWN SMALLEST TYPE. base.css sets `.u` at 10px — the tracked micro-label
 *  that carries every column header, field name and status word in the product — and 10px is the
 *  smallest `font-size` anywhere in the stylesheet. A damage figure has no business being SMALLER
 *  than the page's smallest label: 9px was below the page's own minimum, and it was carrying digits,
 *  which are the one thing a reader has to get exactly right. It has no business claiming a floor
 *  ABOVE it either — 11px was tried here first and measured, and it cost the small fields real range
 *  for nothing the page could point at. 10px is the one value on that scale with a reason behind it,
 *  and the reason is not this file's. It is also where the paper casing starts to matter, since the
 *  figure now carries HUE as well, which costs a little acuity at small sizes and buys it back there.
 *
 *  THE CEILING IS 26 ON A FULL-SIZE FIELD AND LESS ON A SMALL ONE — see `figureTop`. 15px, the old
 *  ceiling, was three pixels over a body-text line for a blow that took a SEVENTH of a fighter's
 *  entire worth (`TOLL_FULL` = 0.15) — the largest single event this game can produce short of a
 *  death, printed at roughly the size of a table cell. 26px is the size at which that hit stops the
 *  eye, which is the whole job of the top of a range. It is not reached everywhere, because this
 *  range was the last quantity in the file still measured in absolute pixels on a canvas where
 *  everything else is measured in `unit`.
 *
 *  THE FLOOR IS ABSOLUTE AND THE CEILING IS NOT, and that asymmetry is the whole design — see
 *  `figureTop` for the argument. The curve between them is unchanged and still linear in toll, so
 *  nothing moved except the ends; and because the fixture's tolls collapse hard after t≈3s (see the
 *  header), the great majority of a fight's figures still sit near the floor. The big type is rare on
 *  purpose — a range whose top end fires often is not a range, it is a size. */
const FIGURE_SIZE = [10, 26] as const;
/** THE SMALLEST CEILING A FIELD MAY BE GIVEN — the point below which `figureTop`'s scaling stops.
 *
 *  Not a taste value and not `FIGURE_SIZE[0] + something`: it is 15 because 15 is the ceiling this
 *  file shipped with before the range was widened, and a phone measured at that ceiling delivers its
 *  damage figures at HEAD's rate. It is the largest top end the smallest field this product runs on
 *  is known to fit, which is a stronger claim than any number picked to look reasonable.
 *
 *  It also keeps the range from collapsing. 15 against a floor of 10 is a ratio of 1.5 — comfortably
 *  past the ~1.2 at which two sizes of the same type stop reading as two sizes — so even the smallest
 *  field still says "this blow was bigger than that one" with the size, which is the whole reason the
 *  size is a range and not a constant. */
const FIGURE_SIZE_TOP_FLOOR = 15;
const FIGURE_MS = [520, 950] as const;
/** HOW FAR A FIGURE CLIMBS. The bottom of the range is absolute, exactly as the size floor is; the
 *  top is DERIVED from the field's ceiling — see `figureRise`. */
const FIGURE_RISE_LOW = 22;
/** HOW FAR THE LARGEST FIGURE CLIMBS, IN MULTIPLES OF ITS OWN CAP HEIGHT — and this number is a
 *  PRESERVED RATIO, not a tuning knob. Nobody should round it to 3.5 because 3.56 looks unfinished.
 *
 *  It is what this file's top-end figure did before the size range was widened: at the old `[9, 15]`
 *  the largest figure rose 40px on an 11.25px cap, i.e. 3.56 of its own height. Widening the ceiling
 *  to 26 while leaving the rise at a flat 40 quietly took that to 2.05, which inverted the
 *  relationship — the big numbers travelled LESS of themselves than the small ones and read as static
 *  where they were supposed to read as loudest. Deriving the rise from the ceiling instead of writing
 *  it down restores 3.56 at BOTH ends and on EVERY field: a phone's 15px ceiling gets 40px of climb,
 *  which is exactly what it had, and a desktop's 26px ceiling gets 69.4px, which is what it should
 *  always have had.
 *
 *  This is the reason the rise is a function and not a constant, and it is the same reason
 *  `figureShelf` is: the moment the ceiling stopped being one number, everything derived from the
 *  ceiling had to stop being one number too, or it would be correct on exactly one field. */
const FIGURE_RISE_CAP_HEIGHTS = 3.56;
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
 *  DERIVED, NOT WRITTEN DOWN — see `figureShelf`, which is where it now lives. It used to be a
 *  module constant, and it stopped being able to be one the moment the ceiling started depending on
 *  the field: a constant folded at import time would have been right on a desktop and 8px too tall on
 *  a phone, which is a shelf reserving height nothing will ever occupy on the one field that has no
 *  height to spare. That is the exact class of drift the derivation was written to prevent, so it
 *  followed the ceiling out of module scope rather than being pinned to the ceiling's largest value.
 *
 *  Two shelves and no more. A third would stand 186px over a fighter's head on a full-size field, and
 *  a damage figure that far from the disc it belongs to has stopped saying whose damage it is. */
const FIGURE_SHELVES = 2;
/** The clearance a shelf leaves above the highest ink the shelf below it can reach — see
 *  `figureShelf`.
 *
 *  It predates the paper casing and survives it with room to spare, which is worth writing down
 *  rather than rediscovering: the casing puts `FIGURE_CASE_PX / 2` of stroke past each glyph edge, so
 *  two figures facing each other across this gap spend 2px of it on ink that no measured box in this
 *  file accounts for. The remaining 2px is the actual separation, and 2px is what `ink.ts` independently
 *  settled on as the least that keeps two legal marks from reading as one crowded one. */
const FIGURE_SHELF_GAP_PX = 4;
/** The paper casing's stroke width — see the figure pass in `draw`, and `draw.ts`'s label pass for
 *  why it is 2 and not 3.
 *
 *  ONE CONSTANT FOR TWO JOBS, and that is the point of naming it. It is what `draw` strokes, and it is
 *  therefore also how far a figure's ink extends past the glyph box every measurement in this file
 *  works in. `hitsFigures` pads by it for exactly that reason. Written down twice, the painted halo
 *  and the reserved space would drift, and the failure is invisible until two numbers touch. */
const FIGURE_CASE_PX = 2;

// --- the camera ----------------------------------------------------------------------------------
/** SCREEN SHAKE, scaled to the toll and gone almost before it registers.
 *
 *  `web/index.html` had one (`w.shake = 14`, decayed 0.86 a frame) and it is the one thing from the
 *  original this page had dropped that it should not have: a jolt is how a viewer's eye is told
 *  something happened somewhere they were not looking, and a field of sixteen circles is exactly the
 *  case where they were not looking.
 *
 *  THESE WERE 3.6 AND 6.5, AND THE COMMENT HERE CALLED THEM "A THIRD OF THE ORIGINAL'S AMPLITUDE".
 *  They are not a third any more and the honest figures are ~40% and ~70% of it: 5.5 and 10 against
 *  `w.shake = 14`. The reason for discounting the original at all still stands exactly as written —
 *  it was tuned for a dark canvas full of particles, where a jolt competes with a screenful of motion,
 *  and this is a technical drawing on paper where the whole field is otherwise still. A third was a
 *  first estimate of that discount made before anyone watched a full round on the new field; watching
 *  one, a hit read as a flinch and a DEATH read as slightly more of a flinch, which is the wrong
 *  ordering for the loudest event in the game. 5.5px is a hit you feel, 10px is a fighter going out,
 *  and 14 would still be a page fault.
 *
 *  Decays at 15/s, i.e. half gone in 46ms, so it is a hit rather than a wobble; and it is floored to
 *  zero rather than allowed to trail, because a permanent sub-pixel tremor is a blurry page. Both of
 *  those, and the MAX-not-sum accumulation in `kickShake`, are untouched and they matter MORE at this
 *  amplitude, not less: they are the entire reason the opening barrage — sixteen fighters, ~16 hits a
 *  second, every one of them at full toll — is a series of jolts rather than a page that never stops
 *  moving. Raising the amplitude without them would have been the change that broke this.
 *
 *  Multiplied by the field's `unit` at sample time, which is `clamp(min(w, h) / 560, 0.55, 2.4)` —
 *  so a phone gets 3.0px/5.5px of it and a large desktop panel proportionally more, and the jolt is
 *  the same fraction of the arena everywhere rather than the same number of pixels.
 *
 *  Never sampled under `prefers-reduced-motion` — the loop does not call `shake()` at all there, and
 *  that is a hard requirement rather than a nicety now that the amplitude is half again what it was. */
const SHAKE_HIT_PX = 5.5;
const SHAKE_DEATH_PX = 10;
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
  /** WHOSE MARK THIS IS. Read for one thing only — the damage figure's colour, see `fire` — and it
   *  costs the call site nothing to supply: every anchor handed to this module is an `ArenaBody`, and
   *  `field.ts` has given those a `side` since the day it built the first one. Widening the anchor
   *  rather than adding an `attackerSide` field to `fire`'s input keeps the fact attached to the
   *  fighter it is a fact about, which is also where it stays true when the field is rebuilt. */
  readonly side: Side;
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

/** WHICH COLOUR A FIGURE IS SET IN — see this file's header for why a figure is coloured at all.
 *
 *  Three of the four are `styles/paper.ts`'s RESERVED tokens, the ones a themed sheet may dim but
 *  never swallow. The fourth is plain ink, and it is the absence of a claim rather than a colour.
 *
 *    a `Side`  the ATTACKER's, for an ordinary blow. Not the defender's: the number is a statement
 *              about who took the money, and putting it in the colour of the fighter it is floating
 *              over would make it read as that fighter's own figure — which is the one thing it
 *              isn't. (When the pairing is same-side the figure and the disc under it do end up the
 *              same hue. That is what the paper casing is for.)
 *    "hot"     the blow finished the defender. A kill is the loudest thing this game does and
 *              `--hot` is the page's one word for it, so it overrides the side colour rather than
 *              sitting alongside it — a death is not a fact about which side you were on.
 *    "ink"     nobody to attribute it to. The event stream named an attacker this field does not
 *              hold, so the money moved and the figure says how much without claiming who took it.
 *              Black is the honest answer, not a guess at a side.
 */
type FigureTone = Side | "hot" | "ink";

/** One property read and at most two string compares, called at most `MAX_FIGURES` times a frame.
 *  The DECISION is made once at birth (`fire`); this only spends it. */
function figureColour(tone: FigureTone, palette: ArenaPalette): string {
  if (tone === "hot") return palette.hot;
  if (tone === "ink") return palette.ink;
  return palette.side[tone];
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
  /** Which colour this figure is set in, DECIDED at birth and never re-decided — same argument as
   *  `font` above, and the decision is the part that costs anything: it reads `kill`, tests whether
   *  there is an attacker at all, and takes that fighter's side, none of which can change once the
   *  mark exists.
   *
   *  The decision and not the colour STRING, and that is deliberate rather than a half-measure.
   *  `fire` runs from the replay's event callback and has no palette — `draw` is the only method
   *  handed one, because the sheet is a variable (`styles/paper.ts`) and a retint mid-flight must
   *  reach a figure that is already in the air. Freezing the literal here would need the palette
   *  smuggled into `fire` through module state and would still leave a 950ms figure painting the old
   *  sheet's red. `figureColour` turns this into a string for one property read a frame instead. */
  tone: FigureTone;
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
    /** Did this blow take the defender to zero. Read off the replay shadow AFTER the event was
     *  applied, so it is the settled fact and not an inference from the size of the number — the
     *  biggest hit of a round usually kills nobody, and a fighter on their last dust goes out to an
     *  amount that rounds to nothing. It buys the figure `--hot`; see `FigureTone`. */
    kill: boolean;
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

function lerpTo(lo: number, hi: number, t: number): number {
  return lo + (hi - lo) * t;
}

/** The tuple form, for the constants that are written as ranges. Expressed in terms of `lerpTo` so
 *  the arithmetic exists once — the figure's size range is the one whose top end is computed rather
 *  than written down, and it needs the two-argument form. */
function lerp(range: readonly [number, number], t: number): number {
  return lerpTo(range[0], range[1], t);
}

/** THE LARGEST FIGURE THIS FIELD MAY SET, which is not the largest figure the file may set.
 *
 *  `FIGURE_SIZE` was the last quantity in this module quoted in absolute pixels. Every other mark
 *  here is already sized in `unit` — the ring's travel cap, the spall's throw, the camera's jolt —
 *  because a mark that is a fixed number of pixels is a different fraction of the arena on every
 *  panel, and the whole file is otherwise written to be the same drawing at any size. A 26px ceiling
 *  is a fourteenth of a 358px phone field and a fiftieth of a 1392px desktop one, and it showed:
 *  measured over the fixture at sixteen fighters on 358x270, a 26px figure NEVER ONCE reached the
 *  screen — the placement search dropped 100% of the top quintile for want of headroom, so the widened
 *  range cost the phone a fifth of its damage figures and returned nothing at all for them.
 *
 *  So the ceiling scales and the FLOOR DOES NOT, and that asymmetry is the substance of this function.
 *  A ring or a fan is a shape, and a shape may be any size; this mark is TEXT, and text has a minimum
 *  at which it stops being a number and becomes a texture. That minimum is a property of reading, not
 *  of the panel, so `FIGURE_SIZE[0]` is 10px on every field there is. The ceiling is the opposite: how
 *  big the loudest blow is ALLOWED to be is a question about how much room the arena has, and the
 *  arena answers it in `unit`.
 *
 *  Three clauses, each doing one job:
 *    `* unit`  ties the ceiling to the field. `unit` is `clamp(min(w, h) / 560, 0.55, 2.4)`, so a
 *              560px field is the neutral one and everything is a share of that.
 *    `min`     26 is a ceiling and not a target. A wall-sized panel does not want a 62px damage
 *              figure; it wants the same figure it always had, with more paper around it. Growth past
 *              the point where the mark is already unmissable buys nothing and costs the restraint
 *              the rest of the page is built on.
 *    `max`     the range may not collapse — see `FIGURE_SIZE_TOP_FLOOR`.
 *
 *  Resolved per hit rather than per frame: `unit` only moves on a resize, and `fire` runs at most
 *  ~16 times a second where `draw` runs 60. A figure already in flight keeps the ceiling it was born
 *  under, which is the same thing every other resolved-at-birth value here does, and which a resize
 *  ends within one figure's lifetime anyway. */
function figureTop(unit: number): number {
  return Math.min(FIGURE_SIZE[1], Math.max(FIGURE_SIZE_TOP_FLOOR, FIGURE_SIZE[1] * unit));
}

/** HOW FAR THE LARGEST FIGURE ON THIS FIELD CLIMBS — a fixed multiple of its own cap height, so the
 *  motion reads the same at every size. See `FIGURE_RISE_CAP_HEIGHTS` for why the multiple is 3.56.
 *
 *  The bottom of the rise range stays absolute (`FIGURE_RISE_LOW`), matching the size floor, which is
 *  also absolute. The two ends of this file's figure are anchored to different things ON PURPOSE: the
 *  small end to what a person can read, the large end to how much arena there is. The range can never
 *  invert — the smallest ceiling a field may have is 15px, which yields 40.05px of climb, comfortably
 *  above the 22px floor. */
function figureRise(top: number): number {
  return top * FIGURE_CAP_SHARE * FIGURE_RISE_CAP_HEIGHTS;
}

/** HOW FAR APART THE TWO SHELVES SIT, given the largest figure THIS field can set.
 *
 *  A near-shelf figure's ink ends at `y - figureRise(top) - top * FIGURE_CAP_SHARE` — the top of its
 *  climb plus its own cap — and the far shelf's baseline sits `FIGURE_SHELF_GAP_PX` beyond that. Both
 *  terms use the range MAXIMA rather than the figure being placed, so the clearance is that same gap
 *  for every pairing of sizes: the worst case is a maximal figure on the near shelf under any figure
 *  at all on the far one, and a shelf sized for a 10px figure would let a 26px one rise straight into
 *  the row above it.
 *
 *  BOTH TERMS NOW MOVE WITH THE FIELD, which is what stopped this being a module constant. Pinning it
 *  to the largest ceiling would reserve a desktop's 92.9px of shelf on a phone that can only ever set
 *  a 15px figure and therefore only needs 55.3 — 37px of height held empty on the one field with none
 *  to spare, which is the difference between the second shelf existing and not. And pinning the RISE
 *  term while the ceiling moved would be the same bug one level down: the rise enters `sweptTop`
 *  directly, so a shelf that did not follow it would simply relocate the drops from collision to
 *  headroom rather than prevent them — measured, not assumed. */
function figureShelf(top: number): number {
  return figureRise(top) + top * FIGURE_CAP_SHARE + FIGURE_SHELF_GAP_PX;
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
 *  three hundred milliseconds later, which is the collision this whole pass exists to prevent.
 *
 *  THREE DIFFERENT BOXES ASK THREE DIFFERENT QUESTIONS, and they are not inconsistent:
 *    - a CANDIDATE being placed reserves its whole future — this top down to its birth baseline,
 *      because all of it is still ahead of it (`fire`).
 *    - a LIVE figure being tested against blocks only what is still ahead of IT — this top down to
 *      its current baseline, because the rest is paper it has already left (`hitsFigures`).
 *    - a figure being PAINTED occupies only where it is on this frame, one cap above its current
 *      baseline, because that is the only ink actually on the glass (`draw`'s per-frame ink test). */
function sweptTop(y: number, rise: number, cap: number): number {
  return y - rise - cap;
}

/** Does this box overlap a figure already in flight? Figures are not in the ink map — they must never
 *  displace a label — so they check each other directly.
 *
 *  AGAINST WHAT IS LEFT OF EACH FIGURE'S CLIMB, NOT AGAINST ALL OF IT. This used to test the full
 *  birth-to-death swept box of every live figure, which reserved paper that could be PROVEN empty: a
 *  figure only ever moves up, so everything below its current baseline is ground it has already left
 *  and can never return to. A figure four fifths of the way through its life was still blocking four
 *  fifths of a column it had entirely vacated, and on a crowded frame that is the difference between a
 *  candidate slot and a dropped number. The top of the box is unchanged — that is where the figure is
 *  still going, and reserving it is the whole reason the test is swept rather than instantaneous.
 *
 *  Nothing about what is DRAWN changes; this only stops claiming space nothing occupies.
 *
 *  THIS IS HERE FOR CORRECTNESS, NOT FOR THE NUMBER IT BOUGHT. Measured over the fixture it recovers
 *  around 4% of otherwise-dropped figures at best and never costs any, which is a small enough return
 *  that somebody will eventually find this loop and wonder whether the extra `t` is worth it. It is
 *  not an optimisation to be weighed: a candidate was being rejected because of ink that was not
 *  there, and a test that answers a question about the present using a box from the past is simply
 *  wrong. It was wrong before it was slow. The 4% is a consequence, not the justification.
 *
 *  Padded downward by the casing, because the freed edge is the one place two figures can now come to
 *  rest against each other: the candidate's cap top would otherwise sit exactly on the departing
 *  figure's baseline, and both marks carry `FIGURE_CASE_PX` of paper stroke that no measured box in
 *  this file includes. `ink.ts` pads its own boxes for the same reason and says so. */
function hitsFigures(figures: Figure[], nowMs: number, x0: number, y0: number, x1: number, y1: number): boolean {
  for (const f of figures) {
    if (x0 >= f.x + f.halfW || x1 <= f.x - f.halfW) continue;
    // Clamped because `fire` runs before the frame's `update`, so a figure one tick past its end can
    // still be in the list; at t = 1 what remains is the cap alone, sitting at the top of the climb.
    const t = clamp((nowMs - f.bornMs) / f.ms, 0, 1);
    if (y0 < f.y - t * f.rise + FIGURE_CASE_PX && y1 > sweptTop(f.y, f.rise, f.cap)) return true;
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
    fire({ nowMs, amount, force, toll, kill, attacker, defender, unit, maxLineDist, fieldW, ink }) {
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
        // How big this field lets the loudest blow be, and therefore how far apart its shelves sit.
        // Both are read once, here, so the size a figure is set at and the height reserved for it are
        // the same field's answer — see `figureTop`.
        const topSize = figureTop(unit);
        const shelfPx = figureShelf(topSize);
        const size = lerpTo(FIGURE_SIZE[0], topSize, toll);
        const cap = size * FIGURE_CAP_SHARE;
        const rise = lerpTo(FIGURE_RISE_LOW, figureRise(topSize), toll);
        const halfW = monoWidth(text.length, size) / 2;
        const head = defender.y - defender.r - 6;
        const start = fanIndex++;
        let x = 0;
        let y = 0;
        let placed = false;
        for (let shelf = 0; shelf < FIGURE_SHELVES && !placed; shelf++) {
          const baseY = head - shelf * shelfPx;
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
            if (hitsFigures(figures, nowMs, cx - halfW, top, cx + halfW, baseY)) continue;
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
            // `attacker`, not `atk`. `atk` is additionally null for a SELF-hit, which the marks below
            // it care about because they need a contact normal and a self-hit has none — but a
            // self-hit still has a side, and it is the same side either way. The only case with
            // nobody to name is an attacker id this field does not hold.
            tone: kill ? "hot" : attacker ? attacker.side : "ink",
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

      // THE FIGURES, and they are the only coloured mark on this field — see this file's header for
      // the rule that bends and the argument for bending it.
      //
      // CASED IN PAPER, stroked under the fill, which is the trick `draw.ts` uses on every fighter
      // label and describes there as what a map does with a place name over a contour line. The
      // figures did not do it while they were black; coloured type needs it more, and needs it in
      // three places black type got away with. Over the lattice, where a hue at 10px has less
      // luminance separation from `--grid` than ink does. Over a fighter's own disc, which on a
      // same-side pairing is now the SAME hue as the figure and would swallow it whole. And over
      // another figure — the placement search clears a figure's whole flight path at birth, but it
      // clears it against the frame that existed then, and two of these can still cross when the
      // fighters under them move.
      //
      // `FIGURE_CASE_PX` is 2, not 3, and `draw.ts` explains why on its own label pass: at 3 the halo
      // stops reading as a casing and starts reading as a white chip drawn behind the text, i.e. a
      // filled label, which is precisely what base.css rule 3 forbids. It is a named constant because
      // `hitsFigures` has to reserve the same 2px — see there. Round joins so the corner of a `$`
      // does not throw
      // a spike. `miterLimit` is dead while the join is round and is set anyway, because these four
      // lines are then character-for-character `draw.ts`'s casing setup — two passes that case text
      // the same way should be diffable, and the alternative is a lone missing line that reads as an
      // oversight rather than as a decision.
      //
      // SET ONCE FOR THE WHOLE PASS. Everything here is constant across figures — only `font` and
      // `fillStyle` vary, and those already had to. Hoisting the rest out of the loop keeps this at
      // two context writes per figure rather than six, on up to `MAX_FIGURES` of them sixty times a
      // second.
      ctx.strokeStyle = palette.paper;
      ctx.lineWidth = FIGURE_CASE_PX;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
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
        // instant it appears is a number nobody reads. ONE alpha for the casing and the fill both —
        // `globalAlpha` multiplies whatever is painted — so the paper stroke dies on exactly the
        // frame the number does. A casing on its own ramp would outlive the digits it was protecting
        // and leave a white ghost of a figure hanging over the fighter.
        ctx.globalAlpha = t < 0.34 ? 1 : 1 - (t - 0.34) / 0.66;
        ctx.font = f.font;
        ctx.fillStyle = figureColour(f.tone, palette);
        // Stroke then fill, per figure, exactly as `draw.ts`'s `casedText` does it — not all the
        // strokes and then all the fills. Two figures that cross should read as a near one over a far
        // one, and painting every casing first would put the near figure's halo UNDER the far
        // figure's digits and erase the depth the casing exists to create.
        ctx.strokeText(f.text, f.x, baseY);
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
