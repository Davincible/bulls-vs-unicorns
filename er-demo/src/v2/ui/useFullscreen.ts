// FULLSCREEN, FOR ONE ELEMENT.
//
// `UI-SPEC.md` Part 3's first requirement is "game canvas is the hero, as large as the viewport
// allows". The layout delivers that inside the page; this is what cashes it — the frame goes to the
// whole screen and the canvas follows for free, because `arena/ArenaCanvas.tsx` sizes itself from a
// `ResizeObserver` on its parent rather than from a React render.
//
// THE STATE IS THE DOCUMENT'S, NOT OURS. `document.fullscreenElement` is the only truth: a reader
// can leave fullscreen with Escape, with F11, by switching tabs on some platforms, or because
// another element took it. A boolean this hook set on click would be wrong within seconds and would
// leave a button reading "Exit fullscreen" over a page that is not in it. So nothing is stored on
// the way in; `fullscreenchange` is the single writer.
//
// THE STANDARD API ONLY, DELIBERATELY. Every engine that ships `Element.requestFullscreen` also
// ships `document.fullscreenEnabled`, so the capability check and the call agree by construction and
// there is no prefixed path to keep in step. Where it is genuinely absent — iOS Safari has never
// supported element fullscreen — `supported` is false and the caller renders no control at all,
// which is this page's standing rule about buttons that cannot work (see the in-page airdrop's note
// in `SideRail.tsx`).

import { useCallback, useEffect, useState, type RefObject } from "react";

export interface FullscreenHandle {
  /** Whether this browser can put an element fullscreen at all. False renders no control. */
  supported: boolean;
  /** Whether `ref`'s element is the fullscreen element right now. */
  active: boolean;
  /** Why the last request or exit was refused, in the browser's own words, or null. Kept until the
   *  next attempt: a refusal that vanished on the next render would leave a button that plainly did
   *  nothing and said nothing about it. */
  error: string | null;
  toggle(): void;
}

/** A DOMException's `message` is usually empty for this API — engines signal the refusal by `name`
 *  ("TypeError" for a disallowed request, "NotAllowedError" inside a restricted frame) — so the name
 *  is the fallback rather than a generic string of our own. */
function reason(e: unknown): string {
  if (e instanceof DOMException) return e.message !== "" ? e.message : e.name;
  if (e instanceof Error && e.message !== "") return e.message;
  return "the browser refused";
}

export function useFullscreen(ref: RefObject<HTMLElement | null>): FullscreenHandle {
  // `document.fullscreenEnabled` is false inside an iframe without `allow="fullscreen"`, which is a
  // real deployment of this page and not a hypothetical.
  const [supported] = useState(() => typeof document !== "undefined" && document.fullscreenEnabled);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    const sync = () => setActive(ref.current !== null && document.fullscreenElement === ref.current);
    // Read once on mount as well as on change: this component can be mounted while the element is
    // already fullscreen (a screen switch and back does exactly that).
    sync();
    document.addEventListener("fullscreenchange", sync);
    // Fires when the request is refused ASYNCHRONOUSLY, which the promise rejection does not always
    // cover — the two paths report different failures and both have to be caught or the control
    // appears to do nothing.
    const onError = () => {
      setError("the browser refused fullscreen for this element");
      sync();
    };
    document.addEventListener("fullscreenerror", onError);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("fullscreenerror", onError);
    };
  }, [ref, supported]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!supported || el === null) return;
    setError(null);
    // EXIT IS ON THE DOCUMENT, ENTER IS ON THE ELEMENT, and the branch is on which element is
    // currently fullscreen rather than on our own `active` — if something else has the screen,
    // asking the document to exit is the wrong move and asking for it again is the right one.
    const request =
      document.fullscreenElement === el ? document.exitFullscreen() : el.requestFullscreen();
    request.catch((e: unknown) => setError(reason(e)));
  }, [ref, supported]);

  return { supported, active, error, toggle };
}
