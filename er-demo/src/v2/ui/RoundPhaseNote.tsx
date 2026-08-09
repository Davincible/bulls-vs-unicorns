// THE PHASE SENTENCE, RENDERED — the one component both the dock and the deploy section show, so
// the words in the bottom-right corner and the words four screens up can never disagree again.
//
// The copy is `roundPhaseCopy.ts` (pure, tested); the clock and the cadence input are
// `useRoundPhase.ts`. This file is markup and nothing else.
//
// TWO DENSITIES, ONE SOURCE. `detail="full"` prints all three clauses — what is true, what you can
// do, when it changes — and is what a state with NO pressable control gets. That state is exactly
// where a player is left asking "what now?", and it is the state this whole module was written for.
// `detail="timing"` prints the label and the deadline only, and is what a state WITH controls gets:
// the deploy buttons are the answer to "what can I do", and repeating it in a paragraph above them
// is a wall, not an answer. Two renderings of one object, never two texts.

import { clock } from "../contract.ts";
import type { PhaseTiming } from "./roundPhaseCopy.ts";
import { useRoundPhase } from "./useRoundPhase.ts";

/** The countdown is a figure, so it is marked up as one (`.num`, tabular). `role="timer"` carries an
 *  implicit `aria-live="off"`: a number that changes every second must never be announced every
 *  second — a screen reader reading "one minute twelve, one minute eleven…" over a running fight is
 *  worse than silence. The label is the part that gets announced, because it changes once per phase
 *  and is the fact worth interrupting for. */
function Timing({ timing }: { timing: PhaseTiming }) {
  if (timing.kind === "waiting") return <>{timing.text}</>;
  return (
    <>
      {timing.before}{" "}
      <span className="num u--ink" role="timer">
        {clock(timing.seconds)}
      </span>
      {timing.after}
    </>
  );
}

export interface RoundPhaseNoteProps {
  detail?: "full" | "timing";
  /** Drop the label when the surface already shows it as its own heading — the dock puts it in the
   *  panel head, and "CLOSED / Closed" twice in two lines reads as a rendering bug. */
  showLabel?: boolean;
  /** Whether THIS instance's label is a live region.
   *
   *  ONE PHASE, ONE ANNOUNCEMENT. This component is on screen twice at once — section 00-3 on the
   *  Arena screen and the deploy dock — and two polite live regions holding the same word means every
   *  phase change is read out twice, which reads as a stutter rather than as emphasis. The dock keeps
   *  it, because the dock is the instance that is present on all five screens: a reader on the
   *  Leaderboard when the lobby closes still hears it. The Arena's copy is the same sentence in the
   *  reader's own reading order a moment later, so it is silent.
   *
   *  Default `true`, so a new surface announces unless it has thought about it — an announcement that
   *  is missing is invisible, an announcement that doubles is at least audible. */
  announce?: boolean;
}

export function RoundPhaseNote({
  detail = "full",
  showLabel = true,
  announce = true,
}: RoundPhaseNoteProps) {
  const copy = useRoundPhase();
  return (
    <div className={`phase-note${detail === "timing" ? " phase-note--tight" : ""}`}>
      {showLabel ? (
        <span className="u u--ink phase-note-l" aria-live={announce ? "polite" : undefined}>
          {copy.label}
        </span>
      ) : null}
      <p className="lede phase-note-b">
        {detail === "full" ? `${copy.now} ${copy.action} ` : null}
        <Timing timing={copy.timing} />
      </p>
    </div>
  );
}
