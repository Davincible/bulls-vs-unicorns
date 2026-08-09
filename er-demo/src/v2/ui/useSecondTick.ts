// A ONE-HERTZ CLOCK, for the handful of places that show a countdown.
//
// A deadline is a time, not a phase, and nothing else on this page re-renders on time alone: `live`
// only changes when a poll lands or, during Fight, on the provider's 250ms clock — neither of which
// runs down a lobby. Without a tick of its own a countdown would sit frozen at whatever second the
// last poll happened to arrive on.
//
// ONE SECOND, NOT A FRAME. The figures are read at second resolution (`clock()`), so a
// `requestAnimationFrame` loop would re-render the world sixty times a second to change a string
// once. Same pattern and the same reasoning as `data/useAutoDeploy.ts`'s evaluation clock.
//
// `active` gates the interval so a settled round with nothing counting down costs nothing. The
// initial value is a real `Date.now()`, so the first paint is already correct and switching `active`
// on cannot flash a stale second.

import { useEffect, useState } from "react";

export function useSecondTick(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}
