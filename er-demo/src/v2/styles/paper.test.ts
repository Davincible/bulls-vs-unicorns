// The sheet, and the two promises it makes.
//
// The first is a REGRESSION GUARD, and it is the reason this file exists: theming the page was an
// experiment run on a finished design, and anybody who opens the arena without choosing a colour must
// get exactly the page that shipped. `white` is not "close to base.css" — it is base.css, and this
// asserts that against the literal hexes in the stylesheet. If someone retunes a grey there and does
// not retune it here, that is precisely the moment to be stopped and asked which one is the truth.
//
// The second is the CONTRAST CONTRACT: `--a` and `--b` say which side a fighter is on, so no sheet is
// allowed to give either less separation than the white page gave it, and no sheet is allowed to put
// body text under AA. Those are properties of the derivation and are checked across every theme at
// every strength rather than at the handful of settings anyone looked at.
//
// What is NOT tested here is the DOM: `applyPaper`, the store and the URL are a dozen lines of
// `setProperty` and `URLSearchParams` around this maths, and a jsdom harness for them would test the
// harness. The maths is where a wrong number hides.

import { describe, expect, it } from "vitest";
import { PAPER_THEMES, contrastRatio, resolvePaper } from "./paper.ts";

/** Copied by hand from base.css's `:root`, on purpose — the point is to notice when the two diverge,
 *  which importing the stylesheet would defeat. */
const BASE_CSS = {
  "--paper": "#ffffff",
  "--paper-2": "#ffffff",
  "--ink": "#0b0b0b",
  "--on-ink": "#ffffff",
  "--wash": "#f6f6f6",
  "--grid": "#f0f0f0",
  "--rule": "#e4e4e4",
  "--ghost": "#e2e2e2",
  "--mark": "#d8d8d8",
  "--rule-2": "#cccccc",
  "--ink-2": "#4d4d4d",
  "--ink-3": "#8a8a8a",
  "--ink-4": "#b5b5b5",
  "--a": "#2b8c39",
  "--b": "#8f09bf",
  "--hot": "#c4291a",
};

const TINTS = [0, 5, 25, 50, 60, 70, 80, 95, 100];
/** base.css's own bar for body text, restated here so the tests do not import a private constant. */
const AA = 4.5;

describe("the white sheet is base.css", () => {
  it("reproduces every token byte for byte", () => {
    expect(resolvePaper({ theme: "white", tint: 70 }).vars).toEqual(BASE_CSS);
  });

  it("does not depend on the strength, because white has no strength", () => {
    for (const tint of TINTS) {
      expect(resolvePaper({ theme: "white", tint }).vars).toEqual(BASE_CSS);
    }
  });

  it("writes the SAME set of properties as every coloured sheet, so returning to white clears them all", () => {
    // `applyPaper` returns to white by REMOVING the properties it owns, and it learns which those are
    // from `resolvePaper`'s own output. That is only sound while the resolver emits one fixed key set:
    // a token emitted for coloured sheets only would never be in the list, would never be removed, and
    // would strand one surface on the old colour. `--paper-2` did exactly that once — the panels stayed
    // bright after switching back to white — which is what this guards.
    const keys = (choice: Parameters<typeof resolvePaper>[0]) => Object.keys(resolvePaper(choice).vars).sort();
    const white = keys({ theme: "white", tint: 70 });
    for (const theme of PAPER_THEMES) {
      for (const tint of TINTS) expect(keys({ theme: theme.id, tint })).toEqual(white);
    }
  });

  it("is what an unknown theme name falls back to — a hand-edited URL must not reach the mixer", () => {
    // `PaperThemeId` is a union, so this can only happen from outside TypeScript: a `?theme=` param, or
    // a stale localStorage value. Both are strings a person can type.
    const bogus = resolvePaper({ theme: "chartreuse" as never, tint: 70 });
    expect(bogus.vars).toEqual(BASE_CSS);
  });
});

describe("no sheet loses a side colour", () => {
  const white = resolvePaper({ theme: "white", tint: 0 });

  for (const theme of PAPER_THEMES) {
    for (const tint of TINTS) {
      const r = resolvePaper({ theme: theme.id, tint });

      it(`${theme.id} @ ${tint}%: --a and --b keep their white-page contrast (capped at AA)`, () => {
        // The floor is min(what it had on white, 4.5). Above AA the extra separation was never needed
        // and buying it would cost the hue — see CONTRAST_CAP in paper.ts.
        expect(r.report.a).toBeGreaterThanOrEqual(Math.min(white.report.a, 4.5) - 0.01);
        expect(r.report.b).toBeGreaterThanOrEqual(Math.min(white.report.b, 4.5) - 0.01);
        expect(r.report.hot).toBeGreaterThanOrEqual(Math.min(white.report.hot, 4.5) - 0.01);
      });

      it(`${theme.id} @ ${tint}%: labels are no worse than the white page's`, () => {
        // Body text is asserted below, where the ground/ink pairing decides whether AA is reachable.
        if ((theme.ground === "white") === (theme.ink === "dark")) {
          expect(r.report.label).toBeGreaterThanOrEqual(white.report.label - 0.05);
        }
      });

      it(`${theme.id} @ ${tint}%: ground and ink agreeing is exactly what decides legibility`, () => {
        // The two axes are independent, and this is the whole consequence of that. Agreeing, a sheet
        // clears AA and its own ink is the better of the two. Disagreeing — Max's hot magenta family,
        // asked for by name — it cannot reach AA at any strength, and the page says so in red rather
        // than quietly correcting itself into a colour nobody chose. Both halves are asserted so that
        // neither can change by accident: a new theme that disagrees will fail here until it is meant.
        const agree = (theme.ground === "white") === (theme.ink === "dark");
        if (agree) {
          expect(r.report.ink).toBeGreaterThanOrEqual(AA);
          expect(r.report.ink).toBeGreaterThanOrEqual(r.report.inkIfFlipped);
        } else {
          expect(r.report.ink).toBeLessThan(AA);
        }
      });

      it(`${theme.id} @ ${tint}%: every sheet but white gives a floating panel its own plane`, () => {
        // The `blank` board draws no frame around the field at all, so on any sheet with a colour in it
        // this step is the ONLY thing separating the extract dock and the corner overlays from the
        // arena behind them. WHITE IS THE EXCEPTION AND STAYS ONE: a flat white page with
        // hairline-bordered panels is the design that shipped, and this feature does not touch it.
        // "Is the white page" — which `white` is at every strength, and which every white-ground
        // dark-type theme also is at strength zero. All of them must stay flat.
        const isTheWhitePage = r.paper === "#ffffff" && theme.ink === "dark";
        if (isTheWhitePage) expect(r.report.panel).toBe(r.vars["--paper"]);
        else expect(r.report.panel).not.toBe(r.vars["--paper"]);
      });

      it(`${theme.id} @ ${tint}%: a panel is never harder to read than the page it sits on`, () => {
        // The panel steps away from the type wherever there is room, and toward it only on a sheet with
        // no colour left to give up (`Black`) — where the step is small and the type has 19:1 to spend.
        // Either way the words on a panel have to survive it, which is the only reason the rule exists
        // in this shape rather than as a flat "one step lighter".
        const onPanel = contrastRatio(r.report.panel, r.vars["--ink"]);
        const onPage = contrastRatio(r.vars["--paper"], r.vars["--ink"]);
        if (onPage >= AA) expect(onPanel).toBeGreaterThanOrEqual(AA);
        else expect(onPanel).toBeGreaterThanOrEqual(onPage - 0.001);
      });

      it(`${theme.id} @ ${tint}%: the side colours keep their own hue, only their light is spent`, () => {
        // Darkening is a scale of LINEAR rgb, which is chromaticity-preserving — so ANSEM's green is
        // still ANSEM's green on every sheet, at whatever lightness the sheet forced. Checked as the
        // ratio between channels, which is what "same colour, less light" means.
        for (const [token, original] of [
          ["--a", "#2b8c39"],
          ["--b", "#8f09bf"],
        ] as const) {
          const got = r.vars[token];
          if (got === original) continue; // untouched on the light sheets
          const hueOf = (hex: string) => {
            const [red, green, blue] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            if (max === min) return -1;
            const d = max - min;
            const h =
              max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4;
            return h * 60;
          };
          // A degree of slack: the round trip through the transfer curve lands on integer channels.
          expect(Math.abs(hueOf(got) - hueOf(original))).toBeLessThan(4);
        }
      });
    }
  }
});

describe("the readout the switcher prints", () => {
  it("measures `sides` between the two side colours and not against the paper", () => {
    const r = resolvePaper({ theme: "rose", tint: 80 });
    expect(r.report.sides).toBeCloseTo(contrastRatio(r.vars["--a"], r.vars["--b"]), 6);
  });

  it("shows the dark sheets collapsing the two sides onto one lightness — the thing to look for", () => {
    // Not an assertion about taste: on a sheet dark enough that BOTH side colours have to be pushed to
    // the same 4.5:1 floor, they end up at the same lightness and the only difference left between
    // side 0 and side 1 is hue. White separates them 1.66:1. This is why the number is on screen.
    expect(resolvePaper({ theme: "white", tint: 0 }).report.sides).toBeGreaterThan(1.6);
    expect(resolvePaper({ theme: "lime", tint: 70 }).report.sides).toBeGreaterThan(1.35);
    expect(resolvePaper({ theme: "rose", tint: 70 }).report.sides).toBeLessThan(1.1);
  });
});
