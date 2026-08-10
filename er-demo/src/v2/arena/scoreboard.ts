// THE SCORE, AS THE FLOOR OF THE ARENA.
//
// The central fact of this game is two sides fighting over one pot, and until now that fact lived
// entirely off the field: in the strength bar above the frame, in the two KVs in 00-1, in the roster
// tables below. The field itself — the thing anyone actually watches — said who was winning only by
// implication, as the relative area of a dozen drifting circles. This draws the answer underneath
// them, at the size of the field, as a piece of the game rather than as a readout beside it.
//
// TWO SCORES, AND THEY ARE NOT THE SAME FACT. Getting these confused is the one way this feature
// makes the page worse rather than better, so they are separated on every axis available:
//
//                          THIS ROUND                 <- band 1: what is happening NOW
//              ANSEM                    UWU              two columns, side colours
//            $172.98                  $235.02            the loudest mark on the field
//              42%                      58%              centred on the playable middle
//
//
//                   ROUNDS WON · 12 SETTLED           <- band 2: what has happened BEFORE,
//                        7 — 5                           and, under it, WHERE THIS ROUND IS IN TIME
//                         1:23
//
//   Band 1 is `hp + banked` per side, live off `field.bodies`, moving on every hit. Band 2 is a count
//   of finished rounds and does not move until one settles. Each carries its own centred caption in
//   neutral ink; the money band is two big columns, the record is one small line; the money band is
//   ~2.4x the type size of the record. Nothing about them invites being read as one quantity.
//
//   THE CLOCK IS THE THIRD ROW OF BAND 2, and it arrived last — by direction ("I want it in the
//   background not in the foreground... below the rounds and the settled number, relatively centred
//   at the top"). It used to be an 88px DOM element in the frame's top-left corner; see ArenaView.css
//   for what happened to that one and why there is now exactly one clock inside this frame.
//
//   IT IS IN BAND 2 AND NOT IN BAND 1, WHICH IS THE OPPOSITE OF WHAT THE FACT SUGGESTS — the clock is
//   about THIS round and band 1 is the "this round" band. It sits here for two reasons that both
//   outrank the taxonomy. Composition: band 1 is nailed to the playable middle, which is precisely
//   where `field.ts`'s `recentre()` parks the crowd, and a four-glyph mark in the middle of the field
//   is one disc away from reading `:23` instead of `1:23`. And reading order: the top strip already
//   says which contest this is and how it has gone, and "how far into this round we are" completes
//   that sentence before the eye drops to the money. The two bands stay separated on every axis they
//   were separated on before — different sizes, different inks, a caption's worth of air between them.
//
//   IT IS NEUTRAL INK, and that is the same rule as the captions: base.css reserves colour for the
//   two sides, and a clock belongs to neither. It is also the ONLY mark in this file that is neither
//   a side's figure nor a label about one, which is the second reason it is set in `--ink` rather
//   than in `--ink-3` — being the darkest thing here at a middling size is what makes it read as its
//   own mark and not as a caption that grew.
//
//   BAND 2 IS A HEADER, AND NOT THE ROW DIRECTLY ABOVE. It sits at the TOP of the field (Max's
//   direction) because that is the order the board reads in: who is ahead between these two
//   communities, and then what is on the table this round. The standings are the frame; the round is
//   the thing inside it.
//
//   What it is NOT is the next row up. Stacking it against the live band was the first attempt at the
//   equivalent placement below and a nine-fighter melee threw it out: `field.ts`'s `recentre()` keeps
//   the crowd on the playable middle by design, so everything within about a figure-height of the
//   centre spends the fight behind discs — the caption came out as `RO▮▮▮▮▮ · 16` with three fighters
//   parked on it. So it is anchored near the EDGE, where disc density falls off, and clamped so it can
//   never print through the live band. The live band's own position is untouched by band 2 existing.
//
// WHY THE RECORD IS NOT LABELLED "ALL TIME". `useHistory` fetches the newest round accounts still on
// chain — a walk back from `round_counter` that stops on a short run of rounds whose rent has been
// reclaimed, capped at `MAX_ROUNDS` — and tolerates a failed read, so the log behind band 2 is a
// WINDOW, and since `close_round_account` a window close to `MIN_RETAINED_ROUNDS` rather than a
// distant cap. `SideRecord` therefore carries the coverage it was counted over and the caption states
// it — `ROUNDS WON · 12 SETTLED` is true whatever the window did, where "all time" would be a quiet
// lie of exactly the kind the rest of this page refuses to tell.
//
//   IT IS A WATERMARK, AND MUST STAY ONE. It is painted after the paper and (in survey) after the
//     lattice, and BEFORE a single fighter — so nothing here can ever obscure the fight. The alphas
//     below are the whole discipline of this file: a scoreboard that competed with the discs would
//     have destroyed the one reading the field exists for, which is who is still in this and how big
//     they are. Every value was pushed up until it started to compete, then taken back down.
//   …AND A WATERMARK GETS CROSSED BY DISCS, NOT BY WORDS. Being walked over by a fighter is the fight
//     happening in front of its scoreboard and is the point of drawing it here at all. Being walked
//     over by a fighter's NAME is two strings in the same pixels and neither survives it: screenshot
//     of a real 9-fighter frame, `ROUNDS WON · 16 SETTLED` reduced to `NDS WON · 16 SETTLED` with a
//     label through the rest of it. So every row this file draws claims its box in `ink.ts` and the
//     labels and damage figures route around them. That is also why the geometry below moved out to
//     the margins — see COLUMN_OFFSET and RECORD_TOP_SHARE: text that is going to be avoided should
//     stand where the fight isn't, or the avoiding costs more than it buys.
//   A ROW THAT CAN BE SWALLOWED WHOLE IS A ROW THAT CAN LIE. The rule that fell out of the crowded
//     frames, and the one to apply to any row added here: a mark NARROWER than the widest disc this
//     field can draw can be covered completely by one fighter, and a partly-covered number is not a
//     damaged reading, it is a different number. `49%` came out as `9%`. Every row here is now either
//     wider than a disc (the figures, both captions, the share line — see SHARE_SEPARATOR) or is
//     something whose loss is merely cosmetic (the side names, which are the same colour as the
//     figure under them and are said again in the roster).
//   BAND 1 IS LIVE. Its totals come from `field.bodies`, which the loop has already synced to the
//     replay shadow for THIS frame — so the counter moves on every hit, in step with the disc that
//     shrank. Reading the same sums off the poll would tick once every couple of seconds, in jumps,
//     out of time with the field, and the liveness is the entire point of putting it here.
//   EACH BAND SAYS WHO IS AHEAD FIRST. The leading side is drawn heavier — more alpha, and in band 1
//     more weight. They are scoreboards; the first thing read off one should be the standing. The two
//     leaders are computed separately, because being ahead this round and being ahead over the log are
//     genuinely different claims and a side can hold one without the other.
//
// WORTH, NOT hp — `hp + banked`, summed per side, which is `contract.ts`'s `sideTotals` and the same
// quantity `field.ts`'s `radiusFor` sizes a fighter on and the same quantity the winner is decided
// on. A counter that disagreed with the circles above it about who is winning would make both
// useless; there is one definition and all three call it.
//
// Flat vector, per base.css: mono type, side colours, `globalAlpha`. No gradient, no shadow, no blend
// mode. (`draw.ts`'s enemy wedge already takes the same `globalAlpha` exemption, for the same reason:
// a tint of a colour is not a new colour.)

import { SIDE_TOKEN, clock, usdCompact, type SideRecord } from "../contract.ts";
import { NO_CLOCK, type ClockSlot } from "../ui/roundPhaseCopy.ts";
import { drawTracked } from "./draw.ts";
import { LABEL_SPACE } from "./field.ts";
import type { InkMap } from "./ink.ts";
import { MONO_ADVANCE, monoFont, monoWidth, type ArenaPalette } from "./palette.ts";

/** Where each side's column sits, as a distance from the centre in field widths, and how much of the
 *  width one side's figure may fill. The two are a PAIR, and the gutter between the columns is what
 *  they leave: each block owns `[½ − offset − slot/2, ½ − offset + slot/2]` and its mirror, so at
 *  0.29 / 0.34 that is [0.04, 0.38] and [0.62, 0.96], with 0.24 of the field between them.
 *
 *  The first pass was 0.23 / 0.42, and a screenshot of the lobby killed it: two seven-character
 *  figures at that weight left ninety pixels between them across a 1,392px field, and at that ratio
 *  the eye reads `$207.00 $201.00` as one continuous band of numerals spanning the whole arena rather
 *  than as two facts about two sides. A scoreboard has to separate before it can be read.
 *
 *  WIDENED AGAIN, from 0.25, and this time the reason is the fight rather than the reading. Two late
 *  fixture frames at 1440x950 put the entire nine-fighter crowd inside the middle two fifths of the
 *  field — `recentre` parks the centroid on the middle by design, so the far left and far right are
 *  the emptiest paper on the page at any moment of any round. Pushing the two loudest marks out into
 *  that space costs the composition nothing (they are ground; they were never meant to be read
 *  against the frame) and it buys the fight a clear centre gutter to happen in, which is exactly what
 *  a scoreboard is supposed to leave.
 *
 *  Derived from the field rather than fixed because the frame runs from a ~1,390px panel on a desktop
 *  to a ~400px one on a phone, and a constant is either a whisper or an overflow at one of those. */
const COLUMN_OFFSET = 0.29;
/** …and the slot THINS AS THE FIELD FILLS. At the program's floor of two fighters the arena is mostly
 *  paper and the score is most of what there is to look at; at its cap of sixteen the field is the
 *  story and a headline behind it is one more thing in the way. Interpolated rather than switched, so
 *  a lobby filling up one entry at a time does not step. Ends chosen against the fixture: 0.34 is the
 *  weight the block was tuned at, 0.24 is where sixteen discs stop having to fight it. */
const SLOT_SHARE = [0.34, 0.24] as const;
const CROWD_RANGE = [2, 16] as const;
/** Below the floor this has stopped being a background and become a caption, and above the ceiling a
 *  four-figure pot on a large screen would be a headline the fighters are standing on rather than
 *  something they sit above. Both ends are reachable: 16:9 in a 1,680px page, and 4:3 in a phone's
 *  gutter. */
const FIGURE_RANGE = [18, 130] as const;
/** How much of the PLAYABLE height the live band — caption, names, figures, shares and the gaps
 *  between them — may occupy.
 *
 *  A cap on the FIGURE alone was the first version and it is the wrong control: every row here is a
 *  fraction of the figure, so adding or removing a row silently changes the block's height for the
 *  same nominal size, and a wide-but-short frame (a 16:9 canvas in a squat panel) would have run it
 *  off both ends of its own field. Sizing the stack and then shrinking to fit means a row can come or
 *  go without anyone having to re-derive this number. */
const LIVE_HEIGHT_SHARE = 0.46;
/** Where the record band's TOP sits, as a share of the playable height.
 *
 *  IT IS A HEADER NOW, NOT A FOOTER — moved above the live band on Max's direction. The standings
 *  between the two communities are the frame you read the current round inside: who is ahead overall
 *  first, then what is on the table right now. Read top to bottom that is the sentence the board
 *  should say, and the previous order said it backwards.
 *
 *  The reason it was a footer still stands and is now the constraint rather than the answer:
 *  `field.ts`'s `recentre()` parks the crowd on the playable middle, so the protection this line has
 *  is DISTANCE FROM THE CENTRE, and it needs as much of it at the top as it had at the bottom. Hence
 *  a share that mirrors the old 0.85 about the middle rather than a token inset — the record is two
 *  glyphs and a dash, and one disc parked on it turns `8 — 8` into `8 — `, which is not a degraded
 *  scoreboard but a wrong one.
 *
 *  One asymmetry to know about: the crowd currently drifts ABOVE centre (measured ~106px high on a
 *  9-fighter frame), so until `field.ts`'s spread/centring is fixed the top strip is the more
 *  contested of the two. The clamp below keeps this band off the live one regardless. */
const RECORD_TOP_SHARE = 0.05;
/** How far the record band walks per probe when it has to get out from under the shell's HUD — see
 *  the walk in `drawScoreboard`. Small enough that the band settles just clear of the chrome rather
 *  than a whole caption below it, large enough that the whole walk is a couple of dozen rectangle
 *  tests on the one frame size that ever needs it. */
const RECORD_YIELD_STEP = 3;

/** Every other size is a fraction of the figure, so the block keeps its proportions at any field size
 *  instead of having four independent clamps that cross over somewhere in the middle of the range.
 *  The ceilings stop a desktop-sized figure from turning its own label into a footnote; the floors are
 *  `.u`'s own 10px, below which the page's micro-label type stops being legible at all. */
const CAPTION_SHARE = 0.13;
const CAPTION_RANGE = [9.5, 18] as const;
const NAME_SHARE = 0.2;
const NAME_RANGE = [10, 30] as const;
const SHARE_SHARE = 0.3;
const SHARE_RANGE = [10, 38] as const;
/** The record numerals. Deliberately well under half the figure: band 2 has to be legible as a score
 *  and unmistakably the quieter of the two. */
const RECORD_SHARE = 0.42;
const RECORD_RANGE = [14, 54] as const;
/** THE CLOCK, WHICH IS THE LOUDEST THING IN BAND 2 AND STILL WELL UNDER BAND 1.
 *
 *  Ordered on purpose: caption < record < clock < money figure. The record is history and is quiet by
 *  design; the clock is the one figure a person watching a fight actually wants off this frame ("how
 *  much of this is left"), so within the top group it leads. It stays at ~0.62 of the money figure
 *  because the money IS the game — a clock that outgrew the pot would make the field a stopwatch with
 *  a fight behind it.
 *
 *  THE FLOOR IS 20 AND NOT `.u`'s 10. Every other row here degrades to a micro-label on a phone
 *  because a micro-label is still what it is; a clock that shrank to caption size would be the exact
 *  complaint that moved it out of the corner in the first place ("very hidden"). 20px is the smallest
 *  this reads as a figure across a 360px field. The 78 ceiling is a shade under the 88 the DOM
 *  element it replaces was clamped to — background ink can be a little smaller than foreground type
 *  and still be the bigger reading, and 78 is where it stops crowding `ROUNDS WON · 12 SETTLED`
 *  directly above it on a 1,680px page. */
const CLOCK_SHARE = 0.62;
const CLOCK_RANGE = [20, 78] as const;
/** The air between the record numerals and the clock, as a share of the record's own size. Deliberately
 *  larger than the 0.85-caption gap inside the record: `7 — 5` over `1:23` with a caption's gap
 *  between them reads as a two-line block, and the one reading this band must not produce is a clock
 *  mistaken for part of a score. Size, ink and air all say the same thing three times. */
const CLOCK_GAP_SHARE = 0.8;
/** `.u`'s 0.14em, which is what makes the page's micro-label type look like itself. */
const TRACKING = 0.14;
/** Cap height of uppercase and digits, as a share of the font size — this type sets no descenders in
 *  any string it draws (`$`, digits, `%`, uppercase names), so the visible height of every row is its
 *  caps. Used for the vertical rhythm; a rhythm measured in em would leave a third of every gap as
 *  invisible line box and read as if the rows had drifted apart. */
const CAP_H = 0.72;

/** ALPHA. Tuned by eye against the fixture at both extremes — a lobby in a wide desktop panel (where
 *  the figure is near its ceiling and any extra weight reads as a headline) and sixteen fighters in a
 *  narrow one (where discs cover most of the numerals and too little alpha leaves nothing legible
 *  between them).
 *
 *  ALPHA RISES AS SIZE FALLS, all the way down the stack, and that is not an inconsistency: what the
 *  eye integrates is area times alpha, so holding one number across a 130px figure and a 10px caption
 *  would make the figure a slab and the caption invisible. The FIGURES are the faintest thing here
 *  precisely because they are the largest mark on the field by a wide margin — a shade of the side
 *  colour a little stronger than the `--rule` hairlines elsewhere on the page and considerably weaker
 *  than a fighter's rim. At 0.2 the green started reading as a filled panel behind the fight, which is
 *  exactly the thing base.css forbids.
 *
 *  THE LEAD/TRAIL GAP IS SMALL, and was narrowed from 0.16/0.11 after looking at both sides in front.
 *  Three signals already say who is ahead — this alpha, the figure's 600 weight, and the percentage —
 *  and `--b` (#8f09bf) is still a darker colour than `--a` (#278834), so it carries more apparent
 *  weight at identical alpha. Stack a wide alpha gap on top of that and UWU-in-front looks like a rout
 *  while the same lead for ANSEM barely registers. The ranking should come from the numbers, not from
 *  which hue happens to be winning.
 *
 *  THE GAP IS NARROWER THAN WHEN THESE WERE TUNED. `--a` was deepened from the sampled #2b8c39 so that
 *  `.pos` and the split bar's labels clear AA as text, which moved the two sides from 1.66:1 apart on
 *  white to 1.57:1. The imbalance these alphas correct for is therefore slightly smaller than it was —
 *  the direction is unchanged and 0.15/0.11 still looks right on the fixture, so nothing is retuned
 *  here on arithmetic alone. Recorded because the next person to look at both sides in front should
 *  know the ground moved under this paragraph.
 *
 *  The captions are neutral ink, not a side colour: they are labels, and base.css reserves colour for
 *  the two sides. Same rule as `draw.ts`'s "LABELS ARE INK". */
const FIGURE_ALPHA = [0.15, 0.11] as const;
const NAME_ALPHA = [0.42, 0.3] as const;
const SHARE_ALPHA = [0.34, 0.26] as const;
const RECORD_ALPHA = [0.3, 0.24] as const;
const CAPTION_ALPHA = 0.5;
/** THE CLOCK'S, AND THE ONLY ALPHA IN THIS FILE THAT IS A RANGE RATHER THAN A NUMBER.
 *
 *  It is the strongest value here and it has to be: it is neutral `--ink` rather than a side colour,
 *  it carries no second signal (no weight change, no leader, no percentage beside it), and it is the
 *  row a person is most likely to be trying to read at a glance from across a room.
 *
 *  AT THE CEILING, 0.30 of `--ink` (#0b0b0b) on `--paper` composites to #b6b6b6 — which is `--ink-4`
 *  (#b5b5b5) to within a value, the tone this page already sets a dead fighter's `OUT` in, i.e. a
 *  weight the design has accepted as legible-but-quiet ink rather than as a mark. 2.03:1 against
 *  `--paper`, deliberately below AA and the right side of the line for background: the same figure is
 *  on screen twice at full contrast in DOM (the top bar's telemetry, 00-1's hero clock) with a third
 *  copy in the accessibility tree beside this canvas. Past ~0.4 at that size it stops being ground
 *  and starts competing with the discs, which is what every alpha in this file was tuned against.
 *
 *  AT THE FLOOR IT RISES TO 0.46, and this is the file's own rule rather than an exception to it:
 *  "what the eye integrates is area times alpha", which is why the captions here already carry more
 *  alpha than the figures they sit under. Every other row keeps ONE value because every other row is
 *  a fixed fraction of the money figure and therefore shrinks in proportion with it. The clock does
 *  not — `CLOCK_RANGE`'s floor binds on a phone, where it is 20px against a ~28px money figure — so
 *  the proportional argument stops holding at exactly the width where the field is most crowded.
 *  Screenshotted at 390x844 with 44 fighters: a 20px clock at 0.30 is a grey smear among 44 labels;
 *  at 0.46 (#8f8f8f, 3.23:1) it is the figure it is supposed to be, and it is still lighter than any
 *  fighter's label beside it — `--ink-3` (#767676) is 4.54:1, so the loudest this row ever gets is
 *  still a third of a stop under the quietest LABEL on the field. Interpolated on the clock's own
 *  size, so there is no step anywhere. */
const CLOCK_ALPHA = [0.46, 0.3] as const;

/** The clock's ink weight at this size — see CLOCK_ALPHA. Linear between the ends of CLOCK_RANGE,
 *  and clamped, so a size outside the range (there is none today) cannot invert the relation. */
function clockAlpha(size: number): number {
  const t = clamp((size - CLOCK_RANGE[0]) / (CLOCK_RANGE[1] - CLOCK_RANGE[0]), 0, 1);
  return CLOCK_ALPHA[0] + (CLOCK_ALPHA[1] - CLOCK_ALPHA[0]) * t;
}
/** The punctuation between the two figures on a split line — quieter than either of them, because it
 *  is punctuation and not a third number. A dash for the record and a middot for the share, so the
 *  two centred lines in this block are never mistaken for each other at a glance; the middot is the
 *  separator the rest of this page already uses (`OUT · $69.12`, `ROUNDS WON · 16 SETTLED`).
 *
 *  THE SHARE'S THREE SPACES EITHER SIDE ARE STRUCTURAL, not air. The widest disc this field can draw
 *  is `2 · MAX_SCALE · baseRadius`, which on a 1,390px desktop panel is ~200px at the two-fighter
 *  floor and ~125px at the sixteen-fighter cap; the share line has to be wider than that, or one
 *  fighter can stand on the whole of it. `49%   ·   51%` at the sizes below measures 185-265px over
 *  the same range, and the padded separator is most of that margin — narrowing it is not a
 *  typographic preference, it is putting the `9%` back.
 *
 *  Note what this does and does not buy: no SINGLE disc can cover the line. Two of them still can,
 *  and on a 400px phone canvas carrying nine fighters they occasionally do. That is the same bargain
 *  every row here makes with the fight in front of it, and it is a partial occlusion rather than a
 *  false number, which was the whole point. */
const RECORD_SEPARATOR = "  —  ";
const SHARE_SEPARATOR = "   ·   ";
const SEPARATOR_ALPHA = 0.26;

const LIVE_CAPTION = "THIS ROUND";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Which side is ahead, or `null` on a dead heat — nobody is ahead, and picking one to embolden would
 *  be inventing a standing. Both columns then draw at the trailing weight, which reads as the level
 *  thing it is. */
function leaderOf(a: number | bigint, b: number | bigint): 0 | 1 | null {
  return a > b ? 0 : b > a ? 1 : null;
}

/** The record's caption, which is also its honesty: it states the coverage it was counted over rather
 *  than claiming a lifetime it cannot back. Nil-all before the first round settles is real data and
 *  says so in words, because `ROUNDS WON · 0 SETTLED` above a `0 — 0` reads like a broken readout. */
function recordCaption(settled: number): string {
  if (settled === 0) return "ROUNDS WON · NONE SETTLED YET";
  return `ROUNDS WON · ${settled} SETTLED`;
}

/** What the clock row actually puts on the paper, or `null` for "draw nothing at all". The only
 *  decision this file makes about the clock; everything about WHICH fact belongs in the slot, and
 *  whether any deadline may be counted at all, was decided by `ui/roundPhaseCopy.ts` before it got
 *  here (see `ArenaCanvasProps.clockSlot`).
 *
 *  THREE CASES, AND THE THIRD IS THE ONE THIS FUNCTION EXISTS FOR:
 *
 *    a figure   `clock()`, untracked, tabular — set exactly like the money figures two bands down,
 *               because it is the same kind of mark: a number to be read off the field.
 *    a word     `OPEN`, the state a held-open lobby is genuinely in — and TRACKED, which is the whole
 *               difference. `RoundClockSlot`'s rule is that a state must never be dressed as a
 *               figure, since `0:00` was misread precisely because it wore a figure's clothes. On a
 *               canvas there is no `.num` class to stay out of, so the distinction has to be drawn:
 *               `.u`'s 0.14em tracking is how this page sets a WORD, and at this size a tracked
 *               `O P E N` cannot be mistaken for a reading of anything.
 *    nothing    `NO_CLOCK`. A fixed slot must print `—`, because a blank cell reads as broken; a
 *               watermark has no cell, so the honest rendering of "no clock is running" is no clock.
 *               A metre-wide em dash over the fight would be an assertion, and the thing it would
 *               assert is nothing. See the note on `NO_CLOCK` in `ui/roundPhaseCopy.ts`.
 *
 *  Any FUTURE state word — a paused arena, an intermission — falls through to the word case and is
 *  drawn, which is the right default: a state this page thought worth naming is worth showing. */
function clockMark(slot: ClockSlot, size: number): { text: string; tracking: number } | null {
  if (slot.kind === "clock") return { text: clock(slot.seconds), tracking: 0 };
  if (slot.word === NO_CLOCK) return null;
  return { text: slot.word, tracking: size * TRACKING };
}

/** ONE CENTRED LINE IN THREE PIECES, so each side keeps its own colour. `49%  ·  51%` and `8 — 8` are
 *  the same construction, so they are laid out by the same code: two independent versions of "measure
 *  three strings and centre them" drift, and a pixel of drift either side of a separator is a visible
 *  limp in a line whose whole job is to look balanced.
 *
 *  MEASURED rather than counted (`monoWidth`), because these pieces have to ABUT exactly. A couple of
 *  percent of error is invisible under a whole label and it is a limp around a dash.
 *
 *  Returns the line's total width, which is what the caller claims in the ink map.
 *
 *  The caller sets the font; `textAlign` is put back the way it was found. */
function drawSplitLine(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  parts: readonly [string, string, string],
  fills: readonly [string, string, string],
  alphas: readonly [number, number, number],
): number {
  const widths = [
    ctx.measureText(parts[0]).width,
    ctx.measureText(parts[1]).width,
    ctx.measureText(parts[2]).width,
  ];
  const total = widths[0] + widths[1] + widths[2];
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  let x = cx - total / 2;
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = fills[i];
    ctx.globalAlpha = alphas[i];
    ctx.fillText(parts[i], x, y);
    x += widths[i];
  }
  ctx.textAlign = prevAlign;
  return total;
}

/** How much of its half of the field one figure may fill, at this many fighters — see SLOT_SHARE. */
function slotShare(crowd: number): number {
  const t = clamp((crowd - CROWD_RANGE[0]) / (CROWD_RANGE[1] - CROWD_RANGE[0]), 0, 1);
  return SLOT_SHARE[0] + (SLOT_SHARE[1] - SLOT_SHARE[0]) * t;
}

/** What the scoreboard needs to know about the frame. `totals` is `contract.ts`'s
 *  `sideTotals(field.bodies)` — computed once per frame by the loop and shared with the aria-label,
 *  rather than summed twice. `record` is the head-to-head folded out of the round log; `null` means
 *  the log has not been read yet and the footer is simply not drawn. `crowd` is how many fighters are
 *  on the field, which is the only thing here that is about the FIGHT rather than about the score:
 *  see SLOT_SHARE for why the block gets out of a full table's way. */
export interface ScoreboardInput {
  totals: readonly [bigint, bigint];
  record: SideRecord | null;
  crowd: number;
  /** WHERE THIS ROUND IS IN TIME, already decided — `ui/roundPhaseCopy.ts`'s `ClockSlot`, passed
   *  through `ArenaCanvasProps` untouched. Not `elapsedSec`, and the reason is written out on the
   *  prop. */
  clock: ClockSlot;
}

/**
 * The background counter.
 *
 * CLAIMS EVERY ROW IT DRAWS in `ink`, which the loop then hands to the labels and the damage figures.
 * It goes first because it is the one thing on this field that cannot move out of the way: it is
 * positioned off the frame's own geometry, where a label is positioned off a fighter that is free to
 * drift somewhere else. See ink.ts.
 *
 * DRAWS NOTHING ON AN EMPTY FIELD. The caller already owns that branch (`drawEmpty`'s "AWAITING
 * ENTRIES"), and a `$0.00 — $0.00` scoreboard behind that line would be noise dressed as data.
 */
export function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  palette: ArenaPalette,
  ink: InkMap,
  score: ScoreboardInput,
): void {
  const { totals, record } = score;
  // Compact, and this is the figure with the most to gain from it on the whole page: a side total is
  // the SUM of a side, drawn at `figure` size behind the fight, and it CLAIMS ITS ROW in `ink` — so
  // its width is not just its own problem, it is the size of the hole every fighter label and damage
  // figure has to route around for the rest of the frame. Nineteen characters of watermark across the
  // middle of the field is how a crowded lineup ends up with half its labels dropped.
  const text: [string, string] = [usdCompact(totals[0]), usdCompact(totals[1])];
  const total = totals[0] + totals[1];

  // Centred on the PLAYABLE area, not on `h`: the bottom `LABEL_SPACE` px are reserved for the
  // fighters' two label lines (field.ts), and centring on the raw height would sit the whole block a
  // dozen pixels low against a fight that is itself framed on the playable middle (`recentre`).
  const playable = h - LABEL_SPACE;
  const cy = playable / 2;

  // Side 0 is rounded and side 1 takes the remainder, so the two always sum to exactly 100. Rounding
  // both independently prints `51% / 50%` about half the time it lands on a boundary, and a
  // scoreboard that doesn't add up is a scoreboard nobody trusts about anything else either. Skipped
  // entirely at a zero total: `50% / 50%` about nothing is a claim, and `0% / 0%` is noise.
  let shares: readonly [string, string] | null = null;
  if (total > 0n) {
    const a = Math.round((Number(totals[0]) / Number(total)) * 100);
    shares = [`${a}%`, `${100 - a}%`];
  }

  // ONE size for both sides, taken from the LONGER of the two figures. Sizing each independently
  // would make `$1,240` bigger than `$980` for having more digits — a scoreboard whose type size
  // encoded string length rather than value, which is the one thing it must not do.
  const chars = Math.max(text[0].length, text[1].length);
  let figure = clamp((w * slotShare(score.crowd)) / (chars * MONO_ADVANCE), FIGURE_RANGE[0], FIGURE_RANGE[1]);

  // Two passes: size the figure off the WIDTH, then, if the live band that falls out of it is taller
  // than its share of the playable area, shrink to fit and re-derive. A second pass is enough — the
  // clamps make the band relatively taller only at small figures, which is exactly where height was
  // never the binding constraint.
  const maxHeight = playable * LIVE_HEIGHT_SHARE;
  let capSize = 0;
  let nameSize = 0;
  let shareSize = 0;
  let recordSize = 0;
  let clockSize = 0;
  let liveH = 0;
  for (let pass = 0; pass < 2; pass++) {
    capSize = clamp(figure * CAPTION_SHARE, CAPTION_RANGE[0], CAPTION_RANGE[1]);
    nameSize = clamp(figure * NAME_SHARE, NAME_RANGE[0], NAME_RANGE[1]);
    shareSize = clamp(figure * SHARE_SHARE, SHARE_RANGE[0], SHARE_RANGE[1]);
    recordSize = clamp(figure * RECORD_SHARE, RECORD_RANGE[0], RECORD_RANGE[1]);
    // Derived in the same pass as the rest, so a shrink-to-fit on the live band takes the top group
    // down with it rather than leaving a clock sized for a field this one turned out not to be.
    clockSize = clamp(figure * CLOCK_SHARE, CLOCK_RANGE[0], CLOCK_RANGE[1]);
    liveH =
      capSize * CAP_H +
      capSize * 0.85 + nameSize * CAP_H +
      nameSize * 0.55 + figure * CAP_H +
      (shares ? figure * 0.16 + shareSize * CAP_H : 0);
    if (liveH <= maxHeight) break;
    figure = Math.max(FIGURE_RANGE[0], figure * (maxHeight / liveH));
  }

  // A cursor down a band. Every row is drawn on `textBaseline = "middle"`, so one number per row —
  // its own visible height — positions all of them, and adding or removing a row is a line here and
  // a line in the height above.
  let cursor = 0;
  const rowMiddle = (height: number, gapBefore: number): number => {
    cursor += gapBefore + height / 2;
    const mid = cursor;
    cursor += height / 2;
    return mid;
  };

  // Every row is centred on `cx` and drawn on a middle baseline, so its box is the same three
  // numbers each time. `size * CAP_H` and not `size`: this type sets no descenders anywhere in the
  // block, and reserving the full line box would push labels a third of a row further away than the
  // glyphs it is protecting actually reach.
  const claimRow = (cx: number, yMid: number, width: number, size: number): void => {
    const halfH = (size * CAP_H) / 2;
    ink.claim(cx - width / 2, yMid - halfH, cx + width / 2, yMid + halfH);
  };

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // --- band 1: this round ------------------------------------------------------------------------
  cursor = cy - liveH / 2;
  const yCaption = rowMiddle(capSize * CAP_H, 0);
  const yName = rowMiddle(nameSize * CAP_H, capSize * 0.85);
  const yFigure = rowMiddle(figure * CAP_H, nameSize * 0.55);
  const yShare = shares ? rowMiddle(shareSize * CAP_H, figure * 0.16) : 0;
  // (The live band's BOTTOM was tracked here while the record sat under it. The record is a header
  // now and clamps against `liveTop`, which is arithmetic from `cy`/`liveH` and needs no cursor.)

  ctx.fillStyle = palette.ink3;
  ctx.globalAlpha = CAPTION_ALPHA;
  ctx.font = monoFont(capSize);
  drawTracked(ctx, LIVE_CAPTION, w / 2, yCaption, capSize * TRACKING);
  claimRow(w / 2, yCaption, monoWidth(LIVE_CAPTION.length, capSize, capSize * TRACKING), capSize);

  const liveLead = leaderOf(totals[0], totals[1]);
  for (const side of [0, 1] as const) {
    const cx = w * (side === 0 ? 0.5 - COLUMN_OFFSET : 0.5 + COLUMN_OFFSET);
    const rank = liveLead === side ? 0 : 1;
    const name = SIDE_TOKEN[side].name;
    ctx.fillStyle = palette.side[side];

    ctx.globalAlpha = NAME_ALPHA[rank];
    ctx.font = monoFont(nameSize);
    drawTracked(ctx, name, cx, yName, nameSize * TRACKING);
    claimRow(cx, yName, monoWidth(name.length, nameSize, nameSize * TRACKING), nameSize);

    ctx.globalAlpha = FIGURE_ALPHA[rank];
    ctx.font = monoFont(figure, rank === 0 ? 600 : 400);
    ctx.fillText(text[side], cx, yFigure);
    claimRow(cx, yFigure, monoWidth(text[side].length, figure), figure);
  }

  // THE SPLIT, AS ONE LINE — the one row here whose measurements answer to the FIGHTERS rather than
  // to the composition.
  //
  // It used to be two three-glyph numbers, one under each column, and a screenshot of the fixture
  // lobby killed that: a $100 whale against a $25 median draws a disc 200px across, it parked on the
  // left column, and `49%` became `9%`. That is not a watermark being crossed by the fight — which is
  // this file's whole bargain — it is the scoreboard stating a number that is false. A three-glyph
  // mark is narrower than the widest disc this field can produce, so at that width a total loss is
  // always one fighter away and there is no size that fixes it: only WIDTH survives a circle.
  //
  // So the two shares became one line, deliberately set wider than the widest possible disc (see
  // SHARE_SEPARATOR). A disc can now take a piece of it and never the whole of it, and either half
  // alone still gives the split, because the two are complements and the reader can see they are a
  // pair. It is also the truer statement: a share is a relation between the two sides, not a property
  // of one of them.
  if (shares) {
    ctx.font = monoFont(shareSize);
    const width = drawSplitLine(
      ctx,
      w / 2,
      yShare,
      [shares[0], SHARE_SEPARATOR, shares[1]],
      [palette.side[0], palette.ink3, palette.side[1]],
      [SHARE_ALPHA[liveLead === 0 ? 0 : 1], SEPARATOR_ALPHA, SHARE_ALPHA[liveLead === 1 ? 0 : 1]],
    );
    claimRow(w / 2, yShare, width, shareSize);
  }

  // --- band 2: the head-to-head, and the clock under it ------------------------------------------
  //
  // TWO ROWS THAT COME AND GO INDEPENDENTLY, which is why nothing below assumes either of them. The
  // record is `null` until the round log has been read — a fold over N round accounts that can fail —
  // and the clock is absent in every phase that genuinely has none (`clockMark`). A band that is
  // sized as "the record, plus a clock" would put the clock a caption-and-a-numeral below the top of
  // the field on a page whose history had not loaded, i.e. floating over nothing.
  const caption = record ? recordCaption(record.settled) : null;
  const mark = clockMark(score.clock, clockSize);
  if (caption !== null || mark !== null) {
    // Anchored to the FIELD, not to the band below it — it sits at the top of the board and the live
    // band keeps the middle it earned. Two clamps, in this order of priority:
    //   1. never overlap the live band — pulled UP so its last row ends a caption's height above the
    //      live band's first row, because a header printing through the money figures is the one
    //      failure that would make both unreadable;
    //   2. never leave the field — floored at 0 for a squat panel, which degrades to "high and tight"
    //      rather than to "drawn off the top edge".
    // Both are unreachable at any frame this page actually renders.
    //
    // EVERY TERM IS CONDITIONAL, and the gaps belong to the row BELOW them — so a missing record
    // takes its caption, its numerals AND the air under them out of the total, and the clock becomes
    // the first row of the band rather than the second row of a band with a hole in it.
    const recordH = caption === null ? 0 : capSize * CAP_H + capSize * 0.85 + recordSize * CAP_H;
    const clockH = mark === null ? 0 : (caption === null ? 0 : recordSize * CLOCK_GAP_SHARE) + clockSize * CAP_H;
    const bandH = recordH + clockH;
    const liveTop = cy - liveH / 2;
    const lowest = liveTop - capSize * 1.6 - bandH;
    const highest = Math.min(playable * RECORD_TOP_SHARE, lowest);

    const captionW = caption === null ? 0 : monoWidth(caption.length, capSize, capSize * TRACKING);
    const markW = mark === null ? 0 : monoWidth(mark.text.length, clockSize, mark.tracking);

    // …AND THEN, ONLY FOR THE SHELL'S OWN CHROME, IT MOVES.
    //
    // Everything else in this file is nailed to the frame's geometry and is the thing other painters
    // route around, which is the whole premise of ink.ts's priority order. There is exactly one
    // writer above it, and this is where that shows up: the HUD overlays are DOM, drawn over this
    // canvas by the shell, and in the default board style they are bare transparent text (chrome.ts).
    // They own the frame's top CORNERS — and this band is anchored to the frame's TOP EDGE, so on a
    // narrow field the two are competing for the same paper and the canvas is the one that can yield.
    // Screenshotted at 390x844 with sixteen fighters: `ROUNDS WON · 16 SETTLED` and `FIGHT 0:20
    // 640/4,000` in the same pixels, both illegible.
    //
    // A walk DOWN, one small step at a time, bounded by clamp 1 — a header printing through the money
    // figures is a worse failure than one printing through the HUD, so if the band cannot clear the
    // chrome before it reaches the live band it stays where it was and takes the overlap. On a desktop
    // the caption is 175px in the middle of a 1,390px field and the corners are 350px away, so the
    // first probe passes and this costs one `hits` call.
    //
    // Probed as ONE BOX at the WIDEST row's width for the band's full height. That used to be the
    // caption unconditionally (`ROUNDS WON · 16 SETTLED` against `9 — 7`); with the clock in the band
    // it is a max, because a caption-less band — the round log has not landed yet — would otherwise
    // probe a zero-width column, clear the chrome trivially and draw the clock straight through it.
    cursor = Math.max(0, highest);
    const probeW = Math.max(captionW, markW);
    for (let y = cursor; y <= lowest; y += RECORD_YIELD_STEP) {
      if (!ink.hits(w / 2 - probeW / 2, y, w / 2 + probeW / 2, y + bandH)) {
        cursor = y;
        break;
      }
    }

    if (record !== null && caption !== null) {
      const yRecordCaption = rowMiddle(capSize * CAP_H, 0);
      const yRecord = rowMiddle(recordSize * CAP_H, capSize * 0.85);

      ctx.fillStyle = palette.ink3;
      ctx.globalAlpha = CAPTION_ALPHA;
      ctx.font = monoFont(capSize);
      drawTracked(ctx, caption, w / 2, yRecordCaption, capSize * TRACKING);
      claimRow(w / 2, yRecordCaption, captionW, capSize);

      // The same split line the share row is set on — see `drawSplitLine`. Weight stays at 400 for
      // both numerals: the advance is identical in this mono stack, but the leader cue in this band is
      // alpha alone, so that the heavier type stays a property of the live figure and the two bands
      // cannot be confused.
      const recLead = leaderOf(record.wins[0], record.wins[1]);
      ctx.font = monoFont(recordSize);
      const width = drawSplitLine(
        ctx,
        w / 2,
        yRecord,
        [String(record.wins[0]), RECORD_SEPARATOR, String(record.wins[1])],
        [palette.side[0], palette.ink3, palette.side[1]],
        [RECORD_ALPHA[recLead === 0 ? 0 : 1], SEPARATOR_ALPHA, RECORD_ALPHA[recLead === 1 ? 0 : 1]],
      );
      claimRow(w / 2, yRecord, width, recordSize);
    }

    // THE CLOCK. Centred on the field, under the standings, in neutral ink — the last row of the top
    // group and the loudest of them.
    //
    // IT TAKES THE SAME BARGAIN EVERY ROW HERE TAKES and it is worth being explicit about which one,
    // because this file's own rule is that "a row that can be swallowed whole is a row that can lie":
    // `1:23` is four glyphs, so at 57px on a desktop it is ~137px against a widest-disc of ~125px at
    // this crowd — wider than one fighter, and only just. A disc taking its left half would leave
    // `:23`, which is a false reading and not a damaged one, exactly as `49%` became `9%`.
    //
    // WHAT MAKES THAT ACCEPTABLE HERE AND NOT THERE is that the share line was the only statement of
    // the split on the whole screen, and this figure is the fourth copy of one that is also in the
    // top bar's telemetry, in 00-1's hero directly above this frame, and in the accessibility tree
    // beside this canvas — all three at full contrast, none of them coverable by anything. A
    // watermark clock is a convenience at the size of the field, and the top strip is the emptiest
    // paper on it (`recentre` parks the crowd on the middle), so the case where it is obscured is
    // both rare and harmless. It is NOT padded out to disc width the way `SHARE_SEPARATOR` is: a
    // clock spaced `1 : 2 3` to survive a circle would stop reading as a clock, which trades a rare
    // partial loss for a permanent one.
    if (mark !== null) {
      const yClock = rowMiddle(clockSize * CAP_H, caption === null ? 0 : recordSize * CLOCK_GAP_SHARE);
      ctx.fillStyle = palette.ink;
      ctx.globalAlpha = clockAlpha(clockSize);
      ctx.font = monoFont(clockSize);
      // Tracked only when it is a WORD — see `clockMark`. `drawTracked` at zero extra is the same
      // marks as `fillText`, but going through one path for both would set a figure a glyph at a
      // time for nothing, so the figure takes the plain centred draw the money figures take.
      if (mark.tracking > 0) drawTracked(ctx, mark.text, w / 2, yClock, mark.tracking);
      else ctx.fillText(mark.text, w / 2, yClock);
      claimRow(w / 2, yClock, markW, clockSize);
    }
  }

  ctx.restore();
}
