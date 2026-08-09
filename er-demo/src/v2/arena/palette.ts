// Canvas 2D cannot read CSS custom properties: every colour the field paints has to reach the
// context as a literal string. The tempting shortcut is to restate base.css's palette here — which
// is also how, six weeks later, the fighters end up one shade off the side markers in the roster
// table next to them because exactly one of the two copies got retuned.
//
// So this resolves the REAL custom properties off the mounted canvas's own computed style, once at
// mount. base.css is the single source of truth; these literals are only the fallback for a context
// where the stylesheet genuinely hasn't applied (a unit test, a first paint before CSS lands).

/** Every colour the arena is allowed to draw in. Nothing outside this object reaches the context. */
export interface ArenaPalette {
  paper: string;
  ink: string;
  /** Secondary ink — the ring-value line under a fighter's name. */
  ink2: string;
  ink3: string;
  /** Dead/extracted: outline, greyed label, `OUT`. */
  ink4: string;
  /** Indexed by `Side` — `--a` / `--b`, the only colour on the page. */
  side: readonly [string, string];
  /** `--grid` — the survey lattice. Deliberately LIGHTER than `--rule`: a rule is a divider drawn a
   *  handful of times per screen, this is a full-field grid, and at --rule's weight a whole page of
   *  it reads as a table someone forgot to fill in rather than as graph paper under the instrument. */
  grid: string;
  /** `--mark` — the registration crosses on every third lattice intersection. Darker than the grid so
   *  they read as marks ON it, not as more of it; the same token `.hero-marks` draws the page's own
   *  survey crosses with, so the field's marks and the page's are literally the same mark.
   *
   *  Named `mark` and not `tick` because base.css's `--tick` is already the 120ms motion duration. */
  mark: string;
  /** `--ghost` — the hairline "origin ring" at a fighter's starting stake, the ghost of the size they
   *  entered at, so a shrunken fighter reads as *diminished* rather than merely small. */
  ghost: string;
}

const FALLBACK: ArenaPalette = {
  paper: "#ffffff",
  ink: "#0b0b0b",
  ink2: "#4d4d4d",
  ink3: "#767676",
  ink4: "#b5b5b5",
  // Kept in step with base.css's `--a`/`--b`, which are the coins' own logo hues one step down — far
  // enough for each to hold AA as text on white, since the same two tokens set `.pos`'s figures and
  // the split bar's labels. See the note in base.css.
  // These literals are only ever used when the stylesheet genuinely hasn't applied.
  side: ["#278834", "#8f09bf"],
  grid: "#f0f0f0",
  mark: "#d8d8d8",
  ghost: "#e2e2e2",
};

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = style.getPropertyValue(name).trim();
  return raw.length > 0 ? raw : fallback;
}

/** Reads base.css's tokens through `el`, so the canvas inherits any theming applied to an ancestor
 *  rather than to `:root` specifically. */
export function readPalette(el: Element): ArenaPalette {
  const style = getComputedStyle(el);
  return {
    paper: readVar(style, "--paper", FALLBACK.paper),
    ink: readVar(style, "--ink", FALLBACK.ink),
    ink2: readVar(style, "--ink-2", FALLBACK.ink2),
    ink3: readVar(style, "--ink-3", FALLBACK.ink3),
    ink4: readVar(style, "--ink-4", FALLBACK.ink4),
    side: [readVar(style, "--a", FALLBACK.side[0]), readVar(style, "--b", FALLBACK.side[1])],
    // These three USED to be literals here, on the argument that three near-white values with one
    // consumer did not earn a place in the global palette. That argument held exactly as long as the
    // page was always white. The sheet is a variable now (`styles/paper.ts`), and a field drawing a
    // white-derived #f0f0f0 lattice across a lime page is not a faint grid — it is a white smear.
    // They are `--grid`/`--mark`/`--ghost` in base.css and read like everything else above.
    grid: readVar(style, "--grid", FALLBACK.grid),
    mark: readVar(style, "--mark", FALLBACK.mark),
    ghost: readVar(style, "--ghost", FALLBACK.ghost),
  };
}

/** The mono stack, matching base.css's `--mono`. Canvas needs a full CSS font shorthand, so the
 *  family list is restated once here and composed with a size/weight at each call site. */
export const MONO = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export function monoFont(px: number, weight: 400 | 600 = 400): string {
  return `${weight} ${px}px ${MONO}`;
}

/** The advance of one glyph in that stack, as a share of the font size — 0.6em for SF Mono / Menlo.
 *
 *  It is mono type: every glyph is the same width, so the width of a string is arithmetic that
 *  `measureText` does not need to be asked for. That matters because the alternative is a layout call
 *  per label per frame, which at the program's cap of sixteen fighters is 32 of them 60 times a
 *  second. Lives here beside the stack it describes, so a change of family can't leave two call sites
 *  measuring against the old one. */
export const MONO_ADVANCE = 0.6;

/** The width of a run of mono glyphs, counted rather than measured — see `MONO_ADVANCE`.
 *
 *  `tracking` is the extra px `drawTracked` puts BETWEEN glyphs, so it is added `chars - 1` times and
 *  not `chars`: the trailing gap is never drawn, and counting it would leave every tracked label's
 *  box a glyph-gap wider than the label itself.
 *
 *  Five call sites now measure the same strings — the label layout, the label's own wall clamp, the
 *  damage figures, the scoreboard's rows and the boxes it claims in `ink.ts` — and any two of them
 *  disagreeing about how wide a string is means the layout reserves one rectangle while the painter
 *  fills a different one, which is a bug that only ever shows up as a near miss on a crowded frame. */
export function monoWidth(chars: number, size: number, tracking = 0): number {
  return chars <= 0 ? 0 : chars * size * MONO_ADVANCE + (chars - 1) * tracking;
}
