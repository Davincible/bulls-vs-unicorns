// THE PAPER KNOB — the programmatic half of base.css.
//
// base.css's first token is `--paper`, and its header comment is the design's law: hairlines and
// whitespace, no fills, colour reserved for the two sides. This module owns the one question that law
// left open — WHAT COLOUR IS THE SHEET — and, because everything faint on the page is defined
// relative to the sheet, it owns every consequence of the answer too.
//
// WHY IT EXISTS. Max wanted to see the page on a colour instead of on white, and to hand a friend a
// link that opens in the same colour. The obvious build is nine palettes. That is nine places to get a
// hairline wrong and nine things to re-tune when the ink changes, so this takes ONE input — a hue, and
// how much of it — and derives the rest. Nothing here is a taste judgement about a particular colour;
// it is a ladder, applied to whichever colour is chosen.
//
// WHY THE MIXING HAPPENS IN JS AND NOT IN `color-mix()`. The canvas. `arena/palette.ts` resolves these
// tokens with `getComputedStyle().getPropertyValue()` and hands the strings straight to a 2D context.
// An UNREGISTERED custom property computes to its own token stream, so a `--rule` written as
// `color-mix(in srgb, var(--paper) 89%, var(--ink))` would reach the canvas verbatim, `var()` and all
// — and a 2D context rejects a colour it cannot parse SILENTLY, by keeping the previous one. The fix
// would be `@property { syntax: "<color>" }` on eight tokens, which is a second mechanism to know
// about and a Chrome-version cliff, for something this file does in a dozen lines. Resolved hex on
// `:root` is what every consumer — CSS, canvas, and the eyedropper in devtools — already understands.

import { useSyncExternalStore } from "react";

// =================================================================================================
// COLOUR MATHS
// =================================================================================================

type Rgb = readonly [number, number, number];

const WHITE = "#ffffff";
/** base.css's `--ink`. Restated (not read back off the document) because every derivation below has to
 *  work before a stylesheet exists — at boot, and in the unit test. */
const INK = "#0b0b0b";

function parseHex(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(c: Rgb): string {
  let out = "#";
  for (const v of c) {
    out += Math.round(Math.min(255, Math.max(0, v)))
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

/** A straight sRGB interpolation, NOT a perceptual one, and that is the whole reason it is here: Max
 *  arrived at "60% to 80%" by putting the colour over white at that opacity in a design tool, and an
 *  opacity composite over white IS a straight sRGB mix. Mixing in OKLab would give a smoother ramp and
 *  a colour he has never seen — the slider would stop being the control he described. */
function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

function toLinear(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function fromLinear(l: number): number {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return s * 255;
}

/** WCAG relative luminance. */
function luminance(c: Rgb): number {
  return 0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);
}

/** WCAG contrast ratio, 1..21. Exported because the switcher PRINTS these — a theme that eats a side
 *  colour is broken rather than merely ugly, and the only way to know is to measure. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a));
  const lb = luminance(parseHex(b));
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

/** Scale a colour's LIGHT without touching its colour. Multiplying linear RGB by one factor multiplies
 *  luminance by exactly that factor and leaves chromaticity — hue and saturation ratio — untouched, so
 *  ANSEM's green comes out of this a deeper ANSEM green rather than a different colour. */
function scaleLuminance(c: Rgb, k: number): Rgb {
  return [fromLinear(toLinear(c[0]) * k), fromLinear(toLinear(c[1]) * k), fromLinear(toLinear(c[2]) * k)];
}

/** How far a base.css grey sits along the white-to-ink line. Both endpoints are neutral on the page
 *  that shipped, so one channel answers it and the other two agree. */
function amountFromWhite(hex: string): number {
  const v = parseHex(hex)[1];
  return (255 - v) / (255 - parseHex(INK)[1]);
}

/** The same distance measured from the other end, for the ink ramp. */
function amountFromInk(hex: string): number {
  const v = parseHex(hex)[1];
  return (v - parseHex(INK)[1]) / (255 - parseHex(INK)[1]);
}

// =================================================================================================
// THE LADDER
// =================================================================================================

// EVERY NEAR-WHITE VALUE ON THE PAGE IS DEFINED BY ITS DISTANCE FROM PAPER, and each distance here is
// recovered from the hex base.css already had rather than invented. Two things follow, and both are
// the point:
//
//   1. `white` reproduces base.css byte for byte, because the numbers came from base.css.
//   2. Every other sheet gets the SAME ladder. A #e4e4e4 rule on a lime page is not a faint rule, it
//      is a grey smear — a neutral laid over a saturated field reads as dirt. Mixed the same distance
//      from a lime paper toward ink, it is the same hairline it always was, in the page's own colour.
//
// THE HAIRLINES, faintest first, written as the hex each one has on a white page:
const LADDER = {
  "--wash": "#f6f6f6", //   the row-hover fill and the bar's trough
  "--grid": "#f0f0f0", //   NEW — the arena's survey lattice (was hardcoded in arena/palette.ts)
  "--rule": "#e4e4e4", //   the hairline between rows
  "--ghost": "#e2e2e2", //  NEW — the arena's origin rings
  "--mark": "#d8d8d8", //   NEW — registration crosses, on the field AND on the hero
  "--rule-2": "#cccccc", // the heavier divider, and the scrollbar thumb
} as const;

// THE INK RAMP, mixed the other way — from ink toward paper. These are today pure neutrals, which is
// right on a neutral sheet and wrong on every other one: a #767676 column header on a cyan page is the
// single element that visibly does not belong to it. Derived, a label is ink diluted BY THE PAPER IT
// SITS ON, which is what a printed page does anyway.
//
// THE RAMP IS TWO RUNGS OF TEXT AND ONE OF STATE, and `hold` below treats all three the same way for a
// reason worth knowing: each one's floor is whatever it measured on white, so the ramp cannot be made
// worse by a sheet, only differently coloured. `--ink-3` carries 4.54:1 and every quiet word on the
// page; `--ink-4` carries 2.05:1 and, since the contrast pass, no words at all — it is the disabled
// state and nothing else (base.css says which). Moving a word onto `--ink-4` here would be a WCAG 1.4.3
// failure on every sheet at once, which is exactly the leverage this file has and why it is stated.
const INK_RAMP = {
  "--ink-2": "#4d4d4d", // `.lede`, the explanatory sentence a section is allowed
  "--ink-3": "#767676", // `.u` and every other quiet word: `.idx`, `.none`, dead rows, the `sim` fill
  "--ink-4": "#b5b5b5", // disabled control text, and `.mk--dead`. No readable text lives here.
} as const;

/** THE RAISED SHEET — `--paper-2`: THE PAGE WITH LESS COLOUR IN IT.
 *
 *  base.css forbids shadows, gradients and translucent fills, which leaves a floating panel exactly
 *  one way to say it is floating: VALUE. On white there was nothing to say it with, so every overlay,
 *  dock, rail and toast simply sat at `--paper` and let its 1px ink border do the whole job — which
 *  works on white and stops working the moment the sheet has a colour, because then a panel at
 *  `--paper` is not "the same neutral", it is visibly the same COLOUR as the page and reads as a hole
 *  cut in it rather than a card over it.
 *
 *  Stated as a share of the strength rather than as "one step lighter", which is the same thing on a
 *  tinted sheet and the WRONG thing on a shaded one. A `light` theme's page is the hue laid over ink;
 *  taking colour out of it moves toward ink, so its panels come out DEEPER than the page while a
 *  `dark` theme's come out paler. Both are the page turned down, both read as a distinct plane, and —
 *  the part that matters — both move AWAY from the type rather than toward it, so a panel is never
 *  harder to read than the page it sits on. Lifting toward white regardless would have cost a deep
 *  magenta most of its depth just to keep a rule that only ever described light sheets.
 *
 *  A no-op on white by construction: white at any strength is still white. */
const LIFT = 0.32;

/** A sheet with NO COLOUR LEFT TO GIVE UP has to find its plane the other way. `Black` is the case:
 *  stepping away from white type means going darker than `#0b0b0b`, and there is nothing there. So the
 *  panel goes toward the type instead — the dark-mode convention, and the only plane available. Small,
 *  because a step toward the type costs contrast and 32% of the way to white would be a mid grey.
 *
 *  Deliberately NOT applied to the white sheet, which is degenerate in exactly the same way and must
 *  stay that way: a flat white page with hairline-bordered panels is the design that shipped, and this
 *  whole feature is not allowed to touch it. */
const LIFT_FLAT = 0.08;

/** A panel steps AWAY from the type — see the note in `resolvePaper` — falling back to `LIFT_FLAT`
 *  when the sheet is already at that end and the step would round to nothing. */
function panelFor(paperRgb: Rgb, paper: string, inkHex: string, onInkHex: string, lightType: boolean): string {
  const away = toHex(mix(paperRgb, parseHex(onInkHex), LIFT));
  if (away !== paper || !lightType) return away;
  return toHex(mix(paperRgb, parseHex(inkHex), LIFT_FLAT));
}

/** Every sheet has to keep body text at AA. It is the one number nothing here is allowed to trade. */
const AA = 4.5;

/** HOW MUCH OF ITSELF A SIDE COLOUR MAY SPEND to stay visible on a sheet, as a share of the distance
 *  to the ink's end.
 *
 *  Without it, `maxStrength` would push a sheet right up to the point where its own TYPE is at exactly
 *  4.5:1 — and leave nothing at all for `--a` and `--b`, which have their own floors to meet against
 *  the same sheet. On a deep magenta that plays out as both side colours being bleached to very nearly
 *  white: they meet their numbers and stop being green and violet, which is the failure the numbers
 *  existed to prevent. Below about 0.65 of the way to white, `#8f09bf` is still recognisably UWU's
 *  violet; past it, it is a pale lilac and then it is nothing.
 *
 *  So the strength cap answers a harder question than "can you read the type": can you read the type
 *  AND can both coins still be told apart. It costs the magenta family some depth at full strength and
 *  buys back the only colour the design has. */
const IDENTITY_BUDGET = 0.65;

/** How much of a hue the sheet can take before its own type stops clearing AA — the slider's 100%.
 *
 *  THE SLIDER MEANS "AS MUCH OF THIS COLOUR AS THIS PAGE CAN CARRY", not "this fraction of a hex", and
 *  those are the same thing for six of the nine. Laid over white and read with near-black type, every
 *  green, blue and yellow here is still comfortably legible at full strength, so their cap is 1 and
 *  the slider is the plain opacity Max described.
 *
 *  It is the magenta family that needs it. Laid over INK and read with near-white type they get darker
 *  as the slider goes UP, until near the top the hue reasserts itself — pure `#ff0078` is a light
 *  colour again, and white type on it is 3.8:1. Without a cap the pinks would get better and then
 *  quietly get worse, which is the one thing a control must never do. With it, 100 is the deepest
 *  legible version of that hue and the slider is monotone: more colour, all the way up.
 *
 *  Bisected because contrast against the sheet falls monotonically as the hue is added — in BOTH
 *  directions, since adding hue always moves the sheet away from its own ink. */
function maxStrength(hue: string, baseHex: string, inkHex: string): number {
  const base = parseHex(baseHex);
  const hueRgb = parseHex(hue);
  const reserved = Object.entries(RESERVED).map(([, c]) => ({
    hex: c,
    floor: Math.min(contrastRatio(c, WHITE), CONTRAST_CAP),
  }));
  const readable = (m: number) => {
    const sheet = toHex(mix(base, hueRgb, m));
    if (contrastRatio(sheet, inkHex) < AA) return false;
    // …and the game's colours have to survive it, spending no more than the budget getting there. The
    // end they are spent toward is the sheet's, not the type's — same reason as in `resolvePaper`.
    const toward = parseHex(contrastRatio(WHITE, sheet) > contrastRatio(INK, sheet) ? WHITE : INK);
    return reserved.every(
      (r) => contrastRatio(toHex(mix(parseHex(r.hex), toward, IDENTITY_BUDGET)), sheet) >= r.floor,
    );
  };
  // A theme whose ground and ink disagree cannot reach AA at ANY strength (see `PaperThemeDef.ink`).
  // Bisecting would walk it down to a blank sheet chasing a number it can never hit, which is the one
  // outcome nobody asked for — so the cap does not apply and the switcher's readout carries the truth.
  if (!readable(0)) return 1;
  if (readable(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (readable(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// THE RESERVED COLOURS. `--a`, `--b` and `--hot` are not decoration — they say which side a fighter is
// on and whether a number is a loss — so a sheet that swallows one has broken the page rather than
// merely dulled it. `--accent` is absent on purpose: base.css confines it to the black chrome bars,
// which stay black whatever colour the sheet is, so it never meets `--paper`.
//
// BOTH SIDES ARE THE COINS' HUES ONE STEP DOWN, and neither step was a taste judgement: `--a` and
// `--b` are set as TEXT (`.pos`'s P/L figures, `.split-a`/`.split-b`'s white labels), so each was
// deepened until it cleared AA against white — 4.51:1 and 7.10:1. That has a consequence this module
// then has to live with: the two are 1.57:1 apart on white rather than the 1.66:1 they were, because
// only the green moved. See `PaperReport.sides`.
const RESERVED = { "--a": "#278834", "--b": "#8f09bf", "--hot": "#c4291a" } as const;

/** THE FLOOR IS THE WHITE PAGE: no token may give less separation from the sheet than it gave on
 *  white. Every one of these values was chosen against white, so white is the standard they were
 *  judged by — which also makes `white` a no-op by construction rather than by special case, and makes
 *  each target a property of the colour instead of a number somebody picked.
 *
 *  CAPPED AT AA's 4.5:1, because some of them started with far more than they need. `--b` holds 7.1:1
 *  on white; insisting on 7.1:1 against a magenta sheet drives it to near-black, trading away the very
 *  identity the contrast existed to protect. `--ink-2` holds 8.2:1, and holding that would collapse it
 *  onto `--ink` and flatten the ramp into one weight. Past AA, more separation buys nothing and costs
 *  the hue.
 *
 *  APPLIED TO TEXT, NOT TO HAIRLINES. `LADDER` gets no floor: a hairline's whole job is to be nearly
 *  invisible, and clamping it would thicken the page's rules on exactly the sheets already carrying
 *  the most colour. */
const CONTRAST_CAP = 4.5;

/** Push `colour` away from the sheet until it holds `target`, and not one step further.
 *
 *  ALWAYS TOWARD THE INK'S END. On a light sheet the ink is near-black and everything that has to be
 *  seen against the page gets darker; on a dark sheet the ink is near-white and the same things have
 *  to get LIGHTER, because below the sheet there is only black and it runs out fast. One direction
 *  flag, both cases, and it is never a judgement — it is which side of the sheet the type is on.
 *
 *  The two directions are different operations for the same reason: hue has to survive both.
 *    DOWN scales linear RGB, which multiplies luminance by exactly that factor and leaves chromaticity
 *      untouched — a deeper ANSEM green, not another colour.
 *    UP cannot scale, because a channel already at 255 (every one of these hues has one) would clip
 *      and take the hue with it. Mixing toward white raises luminance along a straight line to white,
 *      which holds the hue angle and spends saturation instead. A pale green, still that green. */
function separate(colour: string, paperL: number, target: number, up: boolean): string {
  const rgb = parseHex(colour);
  const l = luminance(rgb);
  const have = up ? (l + 0.05) / (paperL + 0.05) : (paperL + 0.05) / (l + 0.05);
  if (have >= target) return colour;

  const holds = (hex: string) => {
    const got = luminance(parseHex(hex));
    return (up ? (got + 0.05) / (paperL + 0.05) : (paperL + 0.05) / (got + 0.05)) >= target;
  };

  if (up) {
    // Bisection on the mix toward white, which is monotone in luminance. Twelve steps resolves a 1/255
    // channel several times over, and the answer is checked on the EMITTED hex rather than on the ideal
    // — three integer channels are what ships, and rounding them can land a hair short of the target.
    if (!holds(WHITE)) return WHITE; // the sheet is so light that even white cannot separate from it
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (holds(toHex(mix(rgb, parseHex(WHITE), mid)))) hi = mid;
      else lo = mid;
    }
    return toHex(mix(rgb, parseHex(WHITE), hi));
  }

  const wanted = (paperL + 0.05) / target - 0.05;
  if (wanted <= 0) return INK; // even black misses: the sheet is too dark to carry this colour at all
  // The closed form solves for a LUMINANCE; what ships is three integer channels, and rounding to them
  // can land a hair light of the answer — 4.25 where 4.27 was asked for. Invisible, and still a broken
  // promise, so the emitted hex is measured and walked down if it is short. One step is enough in
  // every case here; the loop is a bound, not an algorithm.
  let k = wanted / l;
  for (let i = 0; i < 8; i++) {
    const hex = toHex(scaleLuminance(rgb, k));
    if (holds(hex)) return hex;
    k *= 0.99;
  }
  return INK;
}

/** `separate`, with the target read off the white page. `onWhite` is the base.css value that sets the
 *  floor; `candidate` is what this sheet derived (the same colour again, for `RESERVED`). */
function hold(onWhite: string, candidate: string, paperL: number, up: boolean): string {
  // THE CAP IS A PROPERTY OF THE DIRECTION, not of the colour. Going DOWN there is a hard floor a
  // little under the sheet — black — and range runs out fast, so chasing `--b`'s native 7.1:1 on a
  // light sheet drives it to near-black and throws away the hue the contrast existed to protect.
  // Going UP there is room: on a dark sheet `--b` reaches 7.1:1 as a mid lilac with its hue intact,
  // and asking for the full native figure there is what keeps `--a` and `--b` apart at the spacing
  // they have on white — 1.57:1 — instead of collapsing both onto one lightness at 4.5.
  const native = contrastRatio(onWhite, WHITE);
  return separate(candidate, paperL, up ? native : Math.min(native, CONTRAST_CAP), up);
}

// =================================================================================================
// THE THEMES
// =================================================================================================

export type PaperThemeId =
  | "white"
  | "lime"
  | "mint"
  | "cyan"
  | "sky"
  | "sun"
  | "magenta"
  | "pink"
  | "rose"
  | "plum"
  | "berry"
  | "wine"
  | "black";

export interface PaperThemeDef {
  id: PaperThemeId;
  /** Printed on the swatch. Short enough for a 10px tracked mono label in a 420px rail. */
  name: string;
  /** The colour at full strength. `white` is not a special case — it is this list's identity element,
   *  and mixing white into white at any strength is still white. */
  hue: string;
  /** WHAT THE STRENGTH LAYS THE HUE OVER. `white` gives a tint — the sheet gets paler as the slider
   *  comes down, and Max's "60-80% opacity" is exactly this. `ink` gives a shade: the same hue over
   *  near-black, so the slider runs from black up to the deepest legible version of the colour. */
  ground: "white" | "ink";
  /** WHICH WAY THE TYPE RUNS. `dark` is the page as designed; `light` inverts the ink, and with it the
   *  ink ramp, `--on-ink`, and the direction the hairline ladder is mixed. The chrome is the one thing
   *  it does NOT touch: `--chrome`/`--on-chrome` are fixed black-and-white, because the two bars are
   *  the instrument frame around the sheet rather than part of it.
   *
   *  TWO AXES AND NOT ONE, because Max asked for both of the combinations they make on the magenta
   *  family. Ground and ink agreeing is what keeps a sheet legible — `white`+`dark` is the shipped
   *  page, `ink`+`light` is Plum/Berry/Wine. Disagreeing is a deliberate choice with a known price:
   *  hot pink over WHITE is a light colour (luminance 0.29 at 70%), so white type on it tops out
   *  around 2.7:1 and there is no strength at which it reaches AA. Magenta, Pink and Rose are that
   *  combination, asked for by name and shipped with the switcher's readout saying so in red rather
   *  than quietly corrected into something nobody asked for. */
  ink: "dark" | "light";
}

/** WHITE FIRST, and it is the default. This is an experiment run on a finished page, not a redesign:
 *  anybody who opens the arena without choosing anything must get exactly the page that shipped.
 *
 *  The other eight are Max's, verbatim, in his order — grouped so the list reads as two families
 *  (the bright greens and blues he can push hard, then the magentas and pinks he cannot). */
export const PAPER_THEMES: readonly PaperThemeDef[] = [
  // The shipped page, and the five of Max's hues that are light enough to carry near-black type.
  { id: "white", name: "White", hue: WHITE, ground: "white", ink: "dark" },
  { id: "lime", name: "Lime", hue: "#afff00", ground: "white", ink: "dark" },
  { id: "mint", name: "Mint", hue: "#27ff5d", ground: "white", ink: "dark" },
  { id: "cyan", name: "Cyan", hue: "#00f3ff", ground: "white", ink: "dark" },
  { id: "sky", name: "Sky", hue: "#00cfff", ground: "white", ink: "dark" },
  { id: "sun", name: "Sun", hue: "#fff127", ground: "white", ink: "dark" },

  // Max's magenta family exactly as he wrote them — laid over white, so they stay HOT — with the white
  // type he asked for. Knowingly under AA; see `PaperThemeDef.ink`.
  { id: "magenta", name: "Magenta", hue: "#ff00fb", ground: "white", ink: "light" },
  { id: "pink", name: "Pink", hue: "#ff00a7", ground: "white", ink: "light" },
  { id: "rose", name: "Rose", hue: "#ff0078", ground: "white", ink: "light" },

  // The same three hues over ink instead. Named for what they became rather than as variants of the
  // three above, because at strength they are their own colours: #870585, #900560, #950548.
  { id: "plum", name: "Plum", hue: "#ff00fb", ground: "ink", ink: "light" },
  { id: "berry", name: "Berry", hue: "#ff00a7", ground: "ink", ink: "light" },
  { id: "wine", name: "Wine", hue: "#ff0078", ground: "ink", ink: "light" },

  // The other end of the list from `white`, and its exact mirror: a sheet with no hue in it at all.
  // The strength does nothing here for the same reason it does nothing on white — there is no colour
  // to be a percentage of — and the whole page is derived from the two ends it already has.
  { id: "black", name: "Black", hue: INK, ground: "ink", ink: "light" },
];

export interface PaperChoice {
  theme: PaperThemeId;
  /** Percent of the hue laid over white — Max's "opacity". 0 is white whatever the hue. */
  tint: number;
}

/** 70 is the middle of the 60-80 Max landed on by eye. */
export const PAPER_DEFAULT: PaperChoice = { theme: "white", tint: 70 };

/** Coarse enough that a URL stays readable and two people dragging to "about 70" land on the same
 *  sheet; fine enough that the difference between steps is visible. */
export const TINT_STEP = 5;

function themeById(id: PaperThemeId): PaperThemeDef {
  return PAPER_THEMES.find((t) => t.id === id) ?? PAPER_THEMES[0];
}

function clampTint(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

// =================================================================================================
// RESOLVING
// =================================================================================================

export interface PaperReport {
  /** Body text on the sheet, in the ink the page actually uses. AA wants 4.5:1. */
  ink: number;
  /** The SAME measurement for the other polarity — what the type would score if this sheet flipped.
   *
   *  Kept on screen because it is the number that says whether a theme's `ink` choice is the right one,
   *  and because it is the one that explains why a `light` theme is grounded on ink rather than white:
   *  hot pink laid over WHITE is a light colour (luminance 0.29 at 70%), and white type on it tops out
   *  at 3.1:1 — so a light-ink theme laid over white would print 3.1 here and lose to its own
   *  alternative. Grounded on ink instead, the same hue at the same strength gives white type 5.8:1.
   *  If this number ever beats `ink`, the theme's `ink` word is set the wrong way round. */
  inkIfFlipped: number;
  /** Which way the type runs on this sheet — `PaperThemeDef.ink`, echoed so the switcher can say it. */
  polarity: "dark" | "light";
  /** `.u`, the 10px tracked micro-labels. Held by `hold` at white's own 4.54:1, or at `CONTRAST_CAP`'s
   *  4.5 where the sheet is darkened rather than lightened — either way, at AA for text under 18px.
   *
   *  IT USED TO SAY 3.45:1 HERE, and the floor did its job perfectly: it carried `--ink-3`'s white-page
   *  failure faithfully onto all thirteen sheets. The mechanism was never wrong, the value it was
   *  anchored to was. Worth remembering when reading the rest of this file — "no worse than white" is
   *  only a guarantee while white is right. */
  label: number;
  a: number;
  b: number;
  hot: number;
  /** `--paper-2`, echoed. The colour itself rather than a ratio or a percentage: a contrast ratio is
   *  the wrong instrument (lifting a saturated yellow moves almost no luminance — blue is 7% of it —
   *  while being obviously paler to look at, and the ratio would print 1.01 for a change nobody could
   *  miss), and a percentage stopped being true once the panel started stepping away from the TYPE
   *  rather than away from the colour. Two hexes side by side is the thing being judged anyway. */
  panel: string;
  /** `--a` against `--b`. THE NUMBER THAT DECIDES WHETHER A SHEET IS USABLE, and the one the other
   *  five miss: `hold` can push both side colours off the paper and still leave them stacked on top of
   *  each other, at which point the page has two dark marks whose only difference is a hue nobody can
   *  judge at 7px. White gives 1.57:1 — it gave 1.66 until `--a` was deepened to clear AA as text, and
   *  the two sides moved 0.09 closer as the price of that. Anything near 1.0 means they have merged. */
  sides: number;
}

export interface ResolvedPaper {
  paper: string;
  /** Every custom property this module owns, ready for `setProperty`. */
  vars: Readonly<Record<string, string>>;
  /** Measured against the resolved sheet, not asserted. */
  report: PaperReport;
}

export function resolvePaper(choice: PaperChoice): ResolvedPaper {
  const def = themeById(choice.theme);
  const tint = clampTint(choice.tint);

  const lightType = def.ink === "light";
  const inkHex = lightType ? WHITE : INK;
  const onInkHex = lightType ? INK : WHITE;
  const inkRgb = parseHex(inkHex);

  const baseHex = def.ground === "ink" ? INK : WHITE;
  // The slider is a share of what this hue can carry, not of the raw hex — see `maxStrength`.
  const strength = (tint / 100) * maxStrength(def.hue, baseHex, inkHex);
  const paperRgb = mix(parseHex(baseHex), parseHex(def.hue), strength);
  const paper = toHex(paperRgb);
  // Measured on the ROUNDED sheet, not on the unrounded mix. Three integer channels are what ships and
  // what every consumer reads back; deriving the floors from a luminance a fraction off the real one
  // left `--b` landing at 4.4885 against a 4.5 floor — invisible, and still a promise this module made.
  const paperL = luminance(parseHex(paper));

  // A PANEL STEPS AWAY FROM THE TYPE. That is the one statement of the rule that is true on all three
  // kinds of sheet: on white it is a step toward white (a no-op there, which is what keeps the default
  // page flat), on a deep sheet it is a step toward ink, and on a hot sheet carrying white type it is
  // also a step toward ink — which is the case that stops "one step lighter" from being the rule, and
  // the case where a lighter panel would have taken white type from 2.7:1 to worse.
  const vars: Record<string, string> = {
    "--paper": paper,
    "--paper-2": panelFor(paperRgb, paper, inkHex, onInkHex, lightType),
    "--ink": inkHex,
    "--on-ink": onInkHex,
  };

  // Hairlines: pure derivation, no floor. Toward the ink, so they darken on a light sheet and lighten
  // on a dark one — which is the same hairline either way, seen from the other side.
  for (const [name, onWhite] of Object.entries(LADDER)) {
    vars[name] = toHex(mix(paperRgb, inkRgb, amountFromWhite(onWhite)));
  }
  // Text: derive, then hold the floor. These are dilutions OF THE INK, so they are pushed the way the
  // ink lies — a light-type page's labels get lighter, not darker.
  for (const [name, onWhite] of Object.entries(INK_RAMP)) {
    vars[name] = hold(onWhite, toHex(mix(inkRgb, paperRgb, amountFromInk(onWhite))), paperL, lightType);
  }
  // The reserved colours are the exception, and they take their direction FROM THE SHEET rather than
  // from the type: a fighter's disc is a shape on the paper, not a word in the ink, and what it needs
  // is whichever side of the sheet has room left. On a hot pink page carrying white type that is
  // DOWN — the fighters stay a deep green and a deep violet while the words above them are white,
  // which is the right answer for both and would be impossible if one flag drove both.
  const roomAbove = contrastRatio(WHITE, paper) > contrastRatio(INK, paper);
  for (const [name, onWhite] of Object.entries(RESERVED)) {
    vars[name] = hold(onWhite, onWhite, paperL, roomAbove);
  }

  return {
    paper,
    vars,
    report: {
      ink: contrastRatio(inkHex, paper),
      inkIfFlipped: contrastRatio(onInkHex, paper),
      polarity: def.ink,
      label: contrastRatio(vars["--ink-3"], paper),
      a: contrastRatio(vars["--a"], paper),
      b: contrastRatio(vars["--b"], paper),
      hot: contrastRatio(vars["--hot"], paper),
      panel: vars["--paper-2"],
      sides: contrastRatio(vars["--a"], vars["--b"]),
    },
  };
}

/** Every property `applyPaper` can write, so switching back to white can take them all away again —
 *  ASKED OF THE RESOLVER rather than restated beside it.
 *
 *  It was restated once, and that is exactly how `--paper-2` shipped broken: the token was added to
 *  `resolvePaper` and not to the hand-kept list, so returning to white removed all twelve of the
 *  others and left the panels sitting on the previous sheet's colour. Two lists that have to be kept
 *  in step are one list plus a bug waiting for whoever adds the next token. There is one list now, and
 *  it is the resolver's own output. */
const OWNED = Object.keys(resolvePaper(PAPER_DEFAULT).vars);

/** Writes the sheet onto `:root`.
 *
 *  WHITE REMOVES RATHER THAN SETS. `resolvePaper({theme:"white"})` does reproduce base.css exactly —
 *  the ladder was recovered from those very hexes — but "the default page is untouched" should be true
 *  by inspection and not by trusting six round-trips through a luminance curve. With nothing set,
 *  base.css is simply in force. */
export function applyPaper(choice: PaperChoice): void {
  const root = document.documentElement;
  if (choice.theme === "white") {
    for (const name of OWNED) root.style.removeProperty(name);
    return;
  }
  const { vars } = resolvePaper(choice);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

// =================================================================================================
// WHERE THE CHOICE COMES FROM
// =================================================================================================

/** Dotted and versioned, matching `useShell.ts`'s `BOARD_KEY` and for the same reason: the set of
 *  legal theme names is expected to change while people are playing with it, and a value stored under
 *  an older vocabulary must be ignored rather than half-read. Bump the suffix, never migrate. */
const PAPER_KEY = "v2.paper.1";
const PARAM_THEME = "theme";
const PARAM_TINT = "tint";

function isThemeId(s: string | null): s is PaperThemeId {
  return s !== null && PAPER_THEMES.some((t) => t.id === s);
}

/** THE URL WINS OVER STORAGE, always. The point of the link is that the person who opens it sees what
 *  the person who sent it saw; a stored preference quietly overriding it would make the link a lie. */
function readChoice(): PaperChoice {
  let stored: PaperChoice = PAPER_DEFAULT;
  try {
    const raw = localStorage.getItem(PAPER_KEY);
    if (raw !== null) {
      // Validated field by field, never cast: this is a string a user can edit, and `{"theme":"lime"}`
      // with a missing tint must degrade to the default rather than reach the mixer as `NaN`.
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const t = (parsed as { theme?: unknown }).theme;
        const n = (parsed as { tint?: unknown }).tint;
        stored = {
          theme: typeof t === "string" && isThemeId(t) ? t : PAPER_DEFAULT.theme,
          tint: typeof n === "number" && Number.isFinite(n) ? clampTint(n) : PAPER_DEFAULT.tint,
        };
      }
    }
  } catch {
    // Storage disabled, or a half-written value. Merely TOUCHING localStorage throws in some engines
    // (private mode, sandboxed frame) — the default is a fine answer and a white-screen is not.
  }

  try {
    const q = new URLSearchParams(window.location.search);
    const t = q.get(PARAM_THEME);
    if (!isThemeId(t)) return stored;
    const n = Number(q.get(PARAM_TINT));
    return { theme: t, tint: Number.isFinite(n) && q.get(PARAM_TINT) !== null ? clampTint(n) : PAPER_DEFAULT.tint };
  } catch {
    return stored;
  }
}

/** Written from the setter, never from an effect on the value — `useShell.ts` makes the same choice for
 *  `board` and the reasoning transfers exactly: an effect would also fire on mount, which would record
 *  a preference for anybody who merely OPENED a themed link, and then moving the default later would
 *  leave every past visitor pinned to the old one. Only a press is a choice. */
function saveChoice(choice: PaperChoice): void {
  try {
    if (choice.theme === "white") localStorage.removeItem(PAPER_KEY);
    else localStorage.setItem(PAPER_KEY, JSON.stringify(choice));
  } catch {
    // Quota, or storage off. The switcher still works for this session; only the memory of it is lost.
  }
}

/** The address bar IS the share button. Every change rewrites it in place, so "send me what you're
 *  looking at" is a copy of the URL and never a set of instructions.
 *
 *  `replaceState`, not `pushState`: dragging a slider must not bury the page under forty history
 *  entries. Other params are preserved — `?fixture=1` is how this page is reviewed between rounds and
 *  a theme must not silently drop it. */
function writeUrl(choice: PaperChoice): void {
  try {
    const url = new URL(window.location.href);
    if (choice.theme === "white") {
      url.searchParams.delete(PARAM_THEME);
      url.searchParams.delete(PARAM_TINT);
    } else {
      url.searchParams.set(PARAM_THEME, choice.theme);
      url.searchParams.set(PARAM_TINT, String(choice.tint));
    }
    window.history.replaceState(null, "", url);
  } catch {
    // A sandboxed frame can refuse replaceState. The theme still applies; only the link is lost.
  }
}

/** The shareable link for a choice, as text — what the switcher's Copy button puts on the clipboard.
 *  Built from the same writer as the address bar so the two can never disagree. */
export function paperLink(choice: PaperChoice): string {
  const url = new URL(window.location.href);
  if (choice.theme === "white") {
    url.searchParams.delete(PARAM_THEME);
    url.searchParams.delete(PARAM_TINT);
  } else {
    url.searchParams.set(PARAM_THEME, choice.theme);
    url.searchParams.set(PARAM_TINT, String(choice.tint));
  }
  return url.toString();
}

// =================================================================================================
// THE STORE
// =================================================================================================
//
// A module-level store rather than a React context, for two reasons that both point the same way. The
// sheet must be on the document BEFORE React renders — a shared link that flashes white for 300ms and
// then turns lime has failed at the one job it has — so the value has to exist outside the tree. And
// the canvas is not in the tree either: `arena/arenaLoop.ts` runs outside React by design and needs a
// plain callback when the tokens change, not a re-render it would ignore.
//
// `useSyncExternalStore` then makes any number of React readers correct by construction, which a bare
// `useState` in the switcher would not: a second consumer would keep its own copy and the two would
// drift the moment either one set a value.

let current: PaperChoice = PAPER_DEFAULT;
const listeners = new Set<() => void>();

/** Call once, from the entry point, before `createRoot().render()`. */
export function bootPaper(): void {
  current = readChoice();
  applyPaper(current);
}

export function getPaper(): PaperChoice {
  return current;
}

export function subscribePaper(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Applies, persists, rewrites the link, then notifies — in that order. The DOM has to be updated
 *  before the listeners run because one of them (`ArenaCanvas`) responds by re-reading the tokens off
 *  the computed style, and would otherwise read the sheet it is replacing. */
export function setPaper(next: PaperChoice): void {
  current = { theme: next.theme, tint: clampTint(next.tint) };
  applyPaper(current);
  saveChoice(current);
  writeUrl(current);
  for (const fn of listeners) fn();
}

export function usePaper(): PaperChoice {
  return useSyncExternalStore(subscribePaper, getPaper, getPaper);
}
