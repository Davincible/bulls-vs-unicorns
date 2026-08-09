// WHERE THE PAGE'S FLOATING FURNITURE HAS TO GO WHEN THE FIELD TAKES THE SCREEN.
//
// A fullscreen element is rendered in the TOP LAYER and nothing outside its subtree is painted at
// all. That is the whole point of the API and it is also a trap: the deploy/extract dock, the right-
// hand rail and the toast rail are siblings of the arena frame, so the first version of the
// fullscreen button silently removed the extract control from a running fight. Measured, not
// reasoned — the button was simply gone at 1440x900 with the field fullscreen, and the only way back
// to it was Escape.
//
// EXTRACTING IS A RACE. It has to land inside a running fight, before anybody settles the round;
// that is the one move a rollup makes possible and a settlement layer does not, and it is the reason
// this page exists. A viewing mode that costs a player a keypress and a re-orientation in the middle
// of that race is not a viewing mode, it is a trap with a nice view. So the furniture follows the
// field: every fixed overlay portals into whatever element currently holds the screen.
//
// `position: fixed` KEEPS WORKING through the move, which is what makes this a portal and not a
// reimplementation. A fixed box resolves against the viewport unless an ancestor is transformed, and
// `.frame` is not — so `.dock`, `.rail` and `.toasts` land on exactly the same pixels they occupied
// before, with no second stylesheet and no fullscreen-only layout to keep in step.

import { useEffect, useState } from "react";

/** The element currently holding the screen, or null when nothing is. Re-read on every
 *  `fullscreenchange`, which is the only truth — a reader can leave with Escape, with F11, or
 *  because another element took the screen, and none of those go through our own button. */
export function useFullscreenTarget(): Element | null {
  const [target, setTarget] = useState<Element | null>(null);

  useEffect(() => {
    const sync = () => setTarget(document.fullscreenElement);
    // Once on mount as well as on change: a component can mount while something is already
    // fullscreen (switching screens and back does exactly that).
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  return target;
}
