// THE ROUND'S CLOCK, AT THE SIZE THREE FIXED SURFACES HAVE FOR IT — the top bar's telemetry, 00-1's
// hero, and the overlay in the corner of the field.
//
// WHY IT IS A COMPONENT AND NOT THREE TERNARIES. All three used to render `clock(live.elapsedSec)`
// directly, which is the FIGHT clock — and outside a fight that is zero. A lobby the keeper is
// deliberately holding open until a real person arrives therefore printed `0:00` in three places at
// once, and `0:00` on a countdown means the time is up. Nothing was up. Three copies of one wrong
// line is also how they were three copies of one right line before that, so the decision moved to
// `roundPhaseCopy.ts` (pure, tested) and the markup moved here.
//
// THE ONLY THING THIS FILE DECIDES is whether the slot's contents are a FIGURE or a WORD, which is a
// rendering question: a figure goes through `clock()`, a word does not, and dressing "OPEN" as a
// tabular numeral would put the state back in the clothes that made `0:00` misread. Everything else —
// which fact belongs in the slot, and which deadline may be counted at all — belongs to `ClockSlot`.
//
// The class is the CALLER'S, because the three slots genuinely differ: 19px mono in the hero, white
// on black in the top bar, small mono on the field. `.num` renders a word perfectly well (the page
// already prints `DRAWING`, `ANYONE MAY` and `—` in `.num` slots), so nothing here needs a second
// class for the state case.

import { clock } from "../contract.ts";
import { useRoundPhase } from "./useRoundPhase.ts";

export interface RoundClockSlotProps {
  /** What the surface would have put on its own clock element. */
  className?: string;
}

export function RoundClockSlot({ className }: RoundClockSlotProps) {
  const { clockSlot } = useRoundPhase();
  return (
    // THE `title` IS NOT DECORATION HERE. A slot this size can hold `OPEN` but not the reason for it,
    // and a state word with no reachable explanation is the same dead end `0:00` was. It carries the
    // round's own two clauses, from the same object the sentence under the Deploy button renders —
    // see `clockSlotFor`. The surfaces with room for the sentence print it in full as well.
    <span className={className} title={clockSlot.title}>
      {clockSlot.kind === "clock" ? clock(clockSlot.seconds) : clockSlot.word}
    </span>
  );
}
