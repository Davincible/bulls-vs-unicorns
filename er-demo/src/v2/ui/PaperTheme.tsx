// The paper switcher — a DEV control, not a player setting.
//
// It exists because the question "what colour should this page be" is not one anybody answers from a
// hex list; it is answered by looking at a running fight on nine different sheets and then asking
// other people. So this is built for that loop and no other: every swatch previews the real sheet at
// the strength currently set, the change is live (the canvas retints on the next frame — see
// ArenaCanvas.tsx), and every change rewrites the address bar, so "look at this" is a copied URL.
//
// WHY IT LIVES IN THE WALLET RAIL. It has to be reachable and it must not become furniture. The rail
// is two clicks from anywhere, closed by default, and already the home for the things that are about
// this browser rather than about the game — the burner key, the session, the simulated ledger. A
// segmented control beside the board-style toggle would have put a colour picker in the middle of the
// arena screen, permanently, for the sake of a week's experiment.
//
// The measurements are printed rather than assumed. `--a` and `--b` say which side a fighter is on;
// a sheet that swallows one has broken the page rather than merely dulled it, and the only way to
// know which sheets do that is to read the numbers while looking at the field.

import { useMemo } from "react";
import { useArena } from "../data/useArena.ts";
import {
  PAPER_DEFAULT,
  PAPER_THEMES,
  TINT_STEP,
  paperLink,
  resolvePaper,
  setPaper,
  usePaper,
} from "../styles/paper.ts";
import "./PaperTheme.css";

/** The bar each printed ratio is judged against, and where the bar comes from.
 *
 *  `ink` is body text, so it is AA's 4.5:1. `label` is `.u`, 10px tracked mono metadata: it sits at
 *  3.45:1 on the white page that shipped, which is under AA and always was, so the honest bar for it
 *  is "no worse than white" rather than a standard the design never met. `a`/`b` are held at their
 *  own white-page contrast by paper.ts and should never trip.
 *
 *  `sides` is the one that earns its place: it is `--a` against `--b`, and it is the only number here
 *  that paper.ts does not control. Holding both side colours off the SHEET can still leave them
 *  stacked on each other, and then the two sides differ by hue alone — which is a coin toss at the
 *  7px a side marker actually gets. White gives 1.66. Below 1.2 the lightness cue is gone.
 *
 *  The panel strength beside the tint is the other half of the sheet: a floating overlay, dock, rail
 *  or toast is the same hue with less ink in it, and on a coloured page that difference is the only
 *  thing saying a panel is on top of the field rather than cut out of it. */
const BARS = { ink: 4.5, label: 3.4, a: 4.2, b: 4.2, sides: 1.2 } as const;

function Ratio({ name, value, bar }: { name: string; value: number; bar: number }) {
  return (
    <span>
      <span className="u">{name}</span>
      <span className={`num${value < bar ? " pap-bad" : ""}`}>{value.toFixed(2)}</span>
    </span>
  );
}

export function PaperTheme() {
  const { toasts } = useArena();
  const choice = usePaper();

  // Every swatch previews at the CURRENT strength, so dragging the slider moves all nine together and
  // the grid stays a fair comparison rather than nine colours at nine different settings.
  const swatches = useMemo(
    () => PAPER_THEMES.map((t) => ({ ...t, paper: resolvePaper({ theme: t.id, tint: choice.tint }).paper })),
    [choice.tint],
  );
  const active = useMemo(() => resolvePaper(choice), [choice]);
  const activeName = PAPER_THEMES.find((t) => t.id === choice.theme)?.name ?? "White";

  const copy = () => {
    navigator.clipboard?.writeText(paperLink(choice)).then(
      () => toasts.push(`Link copied — opens on ${activeName.toLowerCase()} at ${choice.tint}%`),
      () => toasts.push("Clipboard refused the copy", "error"),
    );
  };

  return (
    <div className="blk">
      <div className="blk-h">
        <span className="u u--ink">Paper</span>
        <span className="u u--faint push">dev</span>
      </div>

      <div className="pap-grid" role="group" aria-label="Page colour">
        {swatches.map((t) => (
          <button
            key={t.id}
            type="button"
            className="pap-sw"
            style={{ background: t.paper }}
            aria-pressed={choice.theme === t.id}
            onClick={() => setPaper({ theme: t.id, tint: choice.tint })}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="pap-cap">
        <span className="u u--ink">{activeName}</span>
        {/* Said in words, because it is the one property of a theme that is a decision rather than a
            consequence — and on a `light` sheet it is also why the strength reads as depth rather than
            as pastel (see `PaperThemeDef.ink`). */}
        <span className="u">{active.report.polarity === "light" ? "light type" : "dark type"}</span>
        <span className="u">
          {choice.theme === "white" ? "no tint" : `${choice.tint}%`}
        </span>
        <span className="idx push">
          {active.paper} / {active.report.panel}
        </span>
      </div>

      <div className="pap-tint">
        <label className="u" htmlFor="pap-tint">
          Tint
        </label>
        <input
          id="pap-tint"
          type="range"
          min={0}
          max={100}
          step={TINT_STEP}
          value={choice.tint}
          // Kept live on the white sheet too: the nine swatches above are previewing at this strength,
          // so it is still the control that decides what you are choosing between.
          onChange={(e) => setPaper({ theme: choice.theme, tint: Number(e.target.value) })}
        />
        <span className="num">{choice.tint}%</span>
      </div>

      <div className="pap-num">
        <Ratio name="Ink" value={active.report.ink} bar={BARS.ink} />
        <Ratio name="Label" value={active.report.label} bar={BARS.label} />
        <Ratio name="A" value={active.report.a} bar={BARS.a} />
        <Ratio name="B" value={active.report.b} bar={BARS.b} />
        <Ratio name="A/B" value={active.report.sides} bar={BARS.sides} />
      </div>

      {/* Not reachable with the nine themes at any strength, and on screen rather than in a comment
          because the moment it IS reached somebody has pushed a sheet past what its own type can carry.
          Two different failures, said differently: the type has dropped under AA, or the theme's `ink`
          word is set the wrong way round and the OTHER polarity would read better. */}
      {active.report.ink < BARS.ink ? (
        <p className="lede" style={{ marginTop: 10, fontSize: 12, color: "var(--hot)" }}>
          Type on this sheet is {active.report.ink.toFixed(2)}:1, under AA&apos;s 4.5.{" "}
          {active.report.inkIfFlipped > active.report.ink
            ? // The hot magenta family. Saying "pull the strength down" here would be a lie: this hue
              // over white is a light colour at every strength, so the number never reaches AA. The
              // two things that DO fix it are the two things worth naming.
              `The other ink would read ${active.report.inkIfFlipped.toFixed(2)}:1, and no strength fixes it — this hue over white stays light. Plum, Berry and Wine are these same three hues over ink, and carry light type at 12:1.`
            : "Pull the strength down."}
        </p>
      ) : null}

      <div className="line line--wrap" style={{ marginTop: 14, gap: 8 }}>
        <button type="button" className="btn btn--sm" onClick={copy}>
          Copy link
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={choice.theme === PAPER_DEFAULT.theme && choice.tint === PAPER_DEFAULT.tint}
          onClick={() => setPaper(PAPER_DEFAULT)}
        >
          Back to white
        </button>
      </div>

      <p className="lede" style={{ marginTop: 12, fontSize: 12 }}>
        One hue and one strength; every rule, label and mark on the page — and on the field — is
        derived from them. The link carries the choice, so a page sent to someone else opens on the
        same sheet. Nothing here is stored on chain or shared with anyone you don&apos;t send it to.
      </p>
    </div>
  );
}
