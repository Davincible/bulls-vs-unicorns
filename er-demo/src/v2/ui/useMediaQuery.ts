// A MEDIA QUERY AS A BOOLEAN — and the name of the one query this page actually asks.
//
// This exists because the same ten lines had been written three times, under three names, by three
// pieces of work that landed within an hour of each other: `useMatches` in `StakeDock.tsx` (which
// width the deploy dock renders at), `useMediaQuery` in `useFocusTrap.ts` (whether the rail is
// full-bleed and therefore has to trap the keyboard), and the bare string `"(max-width: 900px)"`
// declared separately in `SideRail.tsx` and `StakeDock.tsx`. Each was individually defensible; the
// set was not. A hook duplicated three ways is a hook that will eventually behave three ways, and a
// breakpoint written as a literal in two components is a breakpoint that will eventually be two
// breakpoints.
//
// THE BREAKPOINT IS ONE FACT ABOUT THE PAGE, so it gets a name. Below `NARROW` the layout stops being
// a wide page with things at its edges and becomes a single column with a fixed bar on the floor:
// `styles/base.css` collapses `.two` and `.kvs`, `ui/shell.css` takes the rail to `100vw`, grows the
// bottom chrome for the thumb and turns the dock into a bottom sheet. Anything in JS that needs to
// know which of those two pages it is on asks this, so that the day the number moves it moves
// everywhere at once. It is deliberately a JS mirror of a CSS value — CSS custom properties cannot be
// used inside a media query, so there is no way to have only one copy; there is only the choice
// between one mirror and several.
//
// WHY A HOOK AND NOT A ONE-OFF `window.innerWidth` READ: the state has to survive a rotation and a
// desktop window drag, and `matchMedia` is the only source that fires on the same boundary the
// stylesheet uses. Reading `innerWidth` invites answering "is this narrow?" one pixel differently
// from the CSS, which is the class of bug where a panel is styled as a sheet and behaves as a corner.

import { useEffect, useState } from "react";

/** The page's single layout break. Mirrors the `@media (max-width: 900px)` blocks in `base.css`,
 *  `shell.css`, `screens.css` and `ArenaView.css`; those and this must move together. */
export const NARROW = "(max-width: 900px)";

/** True while `query` matches, re-read whenever it changes.
 *
 *  Seeded synchronously in the `useState` initialiser rather than in the effect, because callers use
 *  the first value to decide what to RENDER, not merely how to style it — `StakeDock` picks its
 *  open/collapsed starting state from it, and a hook that returned `false` on the first paint would
 *  flash a 320px panel across a phone before an effect corrected it. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    // The viewport can change between the initial read above and this effect running — a rotation
    // during hydration is the usual way — so re-read once before subscribing.
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);

  return matches;
}
