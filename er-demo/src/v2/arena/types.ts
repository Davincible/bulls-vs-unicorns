// The canvas layer's own vocabulary. `ArenaCanvasProps` lives here rather than in ArenaCanvas.tsx
// so the rAF loop (arenaLoop.ts) can name the shape it reads every frame without importing the
// React component that owns it — the loop is deliberately React-free (see arenaLoop.ts's header),
// and a module cycle between "the component" and "the loop the component starts" is the kind of
// thing that works until the day a bundler decides it doesn't. ArenaCanvas.tsx re-exports this
// type, so SPEC.md's canvas contract (`import { ArenaCanvas, type ArenaCanvasProps }`) still reads
// exactly as written.

import type { HitEvent } from "../../sim/hitEvents.ts";
import type { BoardStyle, FighterView, PhaseName, SideRecord } from "../contract.ts";
import type { ClockSlot } from "../ui/roundPhaseCopy.ts";

export interface ArenaCanvasProps {
  /** `id` MUST be the index the `hitEvents` stream's `attackerId`/`defenderId` were computed
   *  against — the canvas indexes into these positionally, same requirement `sim/hitEvents.ts`
   *  itself imposes on its caller. */
  fighters: FighterView[];
  /** The full precomputed hit stream for the CURRENT fight, ordered by `step`. Replaced wholesale
   *  (new array identity) when an `extract()` forces a recompute — the loop watches for exactly
   *  that and re-derives its replay from scratch rather than trusting a cursor into the old array.
   *  `[]` outside Fight/Settled. */
  hitEvents: HitEvent[];
  /** Epoch ms, or `null` before the fight starts. The playhead — and therefore every hit — is a
   *  pure function of this and wall-clock time; nothing here simulates. */
  fightStartedAtMs: number | null;
  phase: PhaseName;
  /** How the board is drawn. The canvas's whole share of it is the lattice: `"blank"` skips it, and
   *  nothing else on the field changes. The frame and the overlays are the parent's half of the same
   *  word — see `BoardStyle` in contract.ts. Required, not optional with a default: a canvas that
   *  quietly drew a grid the page around it had just taken the border off would be the two halves
   *  disagreeing, which is precisely what one shared type is here to prevent. */
  board: BoardStyle;
  /** The two sides' head-to-head record, for the background scoreboard's second, quieter band. It is
   *  passed IN rather than derived here: it comes off the round log, the canvas has no access to that
   *  and should not grow one, and a per-frame draw call is the last place a fold over N round accounts
   *  belongs. `null` is "not known yet" and draws nothing — see `SideRecord` and `ArenaContextValue`. */
  sideRecord: SideRecord | null;
  /** THE ROUND'S CLOCK, AS A DECISION RATHER THAN AS A NUMBER — for the third row of the background
   *  scoreboard (`scoreboard.ts`'s band 2).
   *
   *  IT IS THE DECISION AND NOT `elapsedSec`, and that is the whole reason this prop has this type.
   *  Three surfaces once rendered `clock(live.elapsedSec)` directly and printed `0:00` over a lobby
   *  the keeper was deliberately holding open — see `ClockSlot` in `ui/roundPhaseCopy.ts` and
   *  `e2e/clock.e2e.ts`. The field is now a fourth surface showing that figure, so it asks the same
   *  pure function the other three ask, through the same union, and the canvas's only freedom is how
   *  to SET what it is handed. A `number` here would have re-opened the defect on the one surface
   *  where it is drawn largest.
   *
   *  WHY `arena/` REACHES INTO `ui/` FOR IT, which nothing else in this directory does. The union is
   *  a fact about the ROUND, not about React — `roundPhaseCopy.ts` is a pure, tested module with no
   *  component in it, and nothing it imports imports anything here, so there is no cycle to create.
   *  The alternative was for `ArenaView` to unpack the slot and hand the canvas a pre-rendered
   *  string, which is one more place formatting the same union and exactly the shape of the original
   *  bug. If this ever needs to stop being a `ui/` import, the move is to lift `ClockSlot` into
   *  `contract.ts` beside `clock()`, not to re-derive it. */
  clockSlot: ClockSlot;
  onSelect?(fighterId: number): void;
  /** Drawn with a persistent black ring. */
  selectedId?: number | null;
}

/** Where the pointer is, in CSS px relative to the canvas's top-left — the same space the field's
 *  own coordinates live in, so hit-testing is a plain distance check with no transform. */
export interface PointerState {
  x: number;
  y: number;
  inside: boolean;
}
