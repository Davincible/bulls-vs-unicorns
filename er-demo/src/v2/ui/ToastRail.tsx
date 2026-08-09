// The toast stack. Bottom-left, above the bottom chrome, column-reverse so the newest is nearest
// the eye — the same placement the original used.
//
// TWO SOURCES, ONE COLUMN, AND THE SEPARATION IS STRUCTURAL RATHER THAN COSMETIC.
//
//   `toasts.items`   what YOU did — a deploy landed, an extract landed, a transaction was refused.
//                    Receipts. `data/useToasts.ts` caps them at five and keeps each for six seconds.
//   `voice.lines`    what the FIGHT is doing to you — see `useCombatVoice.ts`. Throttled, coalesced,
//                    capped at three, and five seconds each.
//
// They are separate lists on purpose. A fight produces exchanges faster than any stack can hold, and
// if the commentary shared `useToasts`'s five slots a busy round would push a failed transaction off
// the screen before anybody read it. Separate lists make that impossible rather than unlikely: the
// receipts have five slots that the fight cannot reach.
//
// THE RECEIPTS SIT AT THE CORNER AND THE COMMENTARY STACKS ABOVE THEM. `.toasts` is
// `flex-direction: column-reverse` anchored at the bottom, so the first child is the bottom-most —
// the fixed point nearest the eye. The churning content must never be the thing that moves the
// stable content, so the receipts go first.
//
// WHAT A SCREEN READER HEARS IS NOT THIS LIST. `aria-live="polite"` QUEUES, so twenty commentary
// lines a minute would put a reader minutes behind the fight and bury the announcement they
// actually need. The commentary lines are therefore `aria-hidden` — visible, never announced — and
// the reader gets `voice.announcement` instead: a position summary on a ten-second cadence plus the
// moments (your fighter is out; the round is decided) verbatim. That region is separate from this
// one so a receipt and the fight can never interrupt each other.

import { createPortal } from "react-dom";
import { useArena } from "../data/useArena.ts";
import { useShell } from "./shell.ts";
import { useCombatVoice } from "./useCombatVoice.ts";
import { useFullscreenTarget } from "./useFullscreenTarget.ts";

const KIND_CLASS: Record<string, string> = {
  error: " toast--err",
  a: " toast--a",
  b: " toast--b",
  info: "",
};

export function ToastRail() {
  const { toasts } = useArena();
  const { commentary } = useShell();
  const voice = useCombatVoice(commentary);
  // A fullscreen field paints nothing outside its own subtree, and a fight that stops talking to you
  // the moment you make it bigger is the wrong trade — see `useFullscreenTarget.ts`.
  const fullscreen = useFullscreenTarget();

  const rail = (
    <>
      <div className="toasts" aria-live="polite" aria-label="Notifications">
        {toasts.items.map((t) => (
          <div key={t.id} className={`toast${KIND_CLASS[t.kind] ?? ""}`}>
            {t.text}
          </div>
        ))}
        {voice.lines.map((l) => (
          <div key={`v${l.id}`} className={`toast${KIND_CLASS[l.kind] ?? ""}`} aria-hidden="true">
            {l.text}
          </div>
        ))}
      </div>

      {/* THE FIGHT'S OWN CHANNEL. Read aloud, never drawn — the screen already has the field, the
          position HUD on it and the commentary above. Polite, because nothing in it is urgent enough
          to cut a reader off mid-sentence: a fighter dying has already happened and the round has
          already been decided by the time either is said. */}
      <p className="sr" role="status">
        {voice.announcement}
      </p>
    </>
  );

  return fullscreen === null ? rail : createPortal(rail, fullscreen);
}
