// `.sc-wrap` — the box a long table scrolls inside — with a keyboard able to reach it.
//
// WHY THIS FILE EXISTS AT ALL. A browser scrolls an overflow box with the arrow keys, Page Up/Down
// and Home/End only when focus is INSIDE that box: those keys act on the nearest scrollport of the
// focused element and on nothing else. The rows of these tables are `role="row"` divs and not one of
// them is focusable, so on the leaderboard the nearest scrollport of every stop a keyboard could
// reach was the PAGE. Measured on the all-time board at 1440x900 before this existed: focus the
// tabpanel that WRAPS the box, press ArrowDown and then PageDown — the box's `scrollTop` stayed at 0
// and the window scrolled 165px instead, while the board's last row sat 1016px below the bottom edge
// of a box that would not move. Every row past the fold was on the page and unreachable without a
// pointer. That is WCAG 2.1.1 Keyboard, level A, and it is a defect, not a preference.
//
// SO THE BOX ITSELF BECOMES THE TAB STOP. With focus on it the same keys act on it, and that is the
// entire fix. It is deliberately NOT left to the browser: Chrome 151 does ship keyboard-focusable
// scrollers, and it does pick up some of these — measured, it focuses the hall-of-fame box on its
// own but NOT the all-time box, because that one contains the sortable column headers and the
// feature skips scrollers that already contain something focusable. So the browser's version of this
// is present in one engine, absent in Safari, inconsistent between two tabs of one widget, and,
// landing on a bare div, announces nothing when it gets there. An explicit named stop is the same
// behaviour everywhere and says what it is.
//
// `role="group"`, NOT `role="region"`. A region is a LANDMARK: it joins the list a screen-reader user
// jumps between, alongside the page's banner, nav and main. These boxes are not destinations — they
// are the inside of a section the reader is already in, named after a heading two lines above them,
// and on the leaderboard there would be one per tab. Five landmarks a screen is how a landmark list
// stops being worth opening. `group` gives the stop a name and a boundary without claiming to be a
// place.
//
// IT LIVES IN ITS OWN FILE because both `LeaderboardView` and `HistoryView` scroll tables this way
// and the alternative was the same ResizeObserver twice. It is not in `ui/primitives.tsx`: `.sc-wrap`
// is defined in `views/screens.css` and means nothing outside these screens, and the vocabulary file
// says in its own header that anything specific to one screen stays with that screen.

import { useEffect, useState, type ReactNode } from "react";

/** Whether `el` currently holds more than it can show — i.e. whether the arrow keys would do
 *  anything at all if it were focused.
 *
 *  WHY THIS IS MEASURED RATHER THAN ASSUMED. `max-height: min(62vh, 640px)` is a cap these tables
 *  reach sometimes and not others, and the answer moves with the data, the viewport and the
 *  breakpoint. Measured against the fixture at 1440x900, where the cap resolves to 558px: the round
 *  board is 284px tall at 8 fighters and 543px at the program's maximum of 16, so it never scrolls at
 *  that height; the all-time board's content is 1646px against that same 558 and always does — except
 *  at `?fighters=2`, where it is 350px and does not. At 390px NOTHING scrolls: `screens.css` releases
 *  the cap, and the leaderboards' `overflow` with it, so the page becomes the scrollport. An
 *  unconditional `tabIndex` would therefore be four dead stops on a phone and one on every desktop
 *  round board — a stop that announces a box and then answers no key is worse than no stop, because
 *  the reader has to work out which of the two kinds they have landed on.
 *
 *  IT WATCHES THE BOX AND THE TABLE IN IT, and between the two there is nothing left to miss:
 *    · the BOX, because a window resize changes its width and, through the `62vh` term, its cap —
 *      the one kind of change that happens with no React render behind it at all;
 *    · the TABLE, because rows arriving is the other kind, and it is the case the box alone would
 *      get wrong. A board pinned at its cap does not change size when a row is added to it: the box
 *      stays 558px, the content goes from 558 to 612, and the answer flips from no to yes with
 *      nothing about the box itself having moved.
 *  Re-measuring after every render would cover the second case too, and was the first thing tried
 *  here — but it means a layout read on every tick of a live board, to catch a change the browser is
 *  already willing to tell us about for free. A resize observer coalesces before paint and fires only
 *  when a box has genuinely changed size, which is exactly the question being asked.
 *
 *  THE CONTRACT THAT MAKES THAT SAFE: a `ScrollBox` holds one table for its lifetime. All four call
 *  sites are literally that, and a board with no rows returns an `Empty` INSTEAD of a box rather than
 *  emptying one, so React never swaps the child out underneath the observer. If that ever stops being
 *  true, this is the line that needs to know. */
function useCanScroll(el: HTMLElement | null): boolean {
  const [canScroll, setCanScroll] = useState(false);

  useEffect(() => {
    if (el === null) return;
    const measure = () => {
      setCanScroll(overflows(el));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const content of Array.from(el.children)) ro.observe(content);
    return () => {
      ro.disconnect();
    };
  }, [el]);

  return canScroll;
}

/** The 1px slack is for the rounding in `scrollHeight`/`clientHeight`, not for taste: a box that
 *  overflows by a single pixel hides nothing worth a tab stop. */
function overflows(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight > 1;
}

/** A scrolling box around one table.
 *
 *  `label` names the box for the reader who lands on it, and it is the SECTION HEADING the box sits
 *  under — passed in from the one place that owns that string rather than typed again here, so the
 *  two can never drift. It names where you are ("All-time"); the table inside keeps its own, more
 *  specific name for what it is ("All-time standings"), which is what a reader hears on the separate
 *  act of navigating into it. */
export function ScrollBox({ label, children }: { label: string; children: ReactNode }) {
  // `useState` rather than `useRef` for the node: the effects above have to re-run when the element
  // arrives, and a ref's mutation is invisible to React. React 18 has no ref cleanup callback, so
  // this is the honest way to say "when this element changes, re-measure it".
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const canScroll = useCanScroll(box);

  return (
    <div
      ref={setBox}
      className="sc-wrap"
      // All three or none. A `group` with no way in is a boundary announced for nothing, and a stop
      // with no role is a stop with no name — `aria-label` is not exposed on a generic div.
      tabIndex={canScroll ? 0 : undefined}
      role={canScroll ? "group" : undefined}
      aria-label={canScroll ? label : undefined}
    >
      {children}
    </div>
  );
}
