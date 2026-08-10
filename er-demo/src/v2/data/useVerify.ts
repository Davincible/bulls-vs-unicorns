// Re-derive the settled round in this tab and diff it against what the chain settled to — the whole
// "provably fair" claim, executed rather than asserted. All the real work lives in
// `src/ui/verifyRound.ts` (shared with the original app, read-only here); this hook only decides WHEN
// it runs and holds the result.
//
// It is only meaningful once Settled: `verifyRound()` replays exactly `round.tickCount` steps, which
// is 0 until `resolve()` writes it. Running it earlier would compare a zero-step replay against a
// half-fought round and report a mismatch that means nothing — so this refuses, out loud, instead.
//
// WHY THE DEFERRED CALL. `verifyRound` is synchronous and does up to `finalCursor(fighterCount)`
// sha256 rounds — 17,280 at the 48-fighter ceiling, up from 4,000 at the old flat cap — long enough
// to drop frames. Flipping `running` and yielding to the browser
// before starting means the button can actually render its pending state, instead of the page
// freezing with the button still looking idle.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RoundState } from "../../chain/useRound.ts";
import { verifyRound, type VerifyResult } from "../../ui/verifyRound.ts";
import type { ArenaContextValue, ToastKind } from "./types.ts";

export function useVerify(
  round: RoundState | null,
  push: (text: string, kind?: ToastKind) => void,
): ArenaContextValue["verify"] {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [running, setRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // A result belongs to the round it was computed from. When the page moves to a different round the
  // old verdict is not merely stale, it is about something else entirely.
  const roundNo = round?.roundNo ?? null;
  const shownForRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (shownForRef.current !== roundNo) {
      shownForRef.current = roundNo;
      setResult(null);
    }
  }, [roundNo]);

  const run = useCallback(() => {
    if (!round) {
      push("nothing to verify — no round is loaded", "error");
      return;
    }
    if (round.phaseName !== "Settled") {
      push(`verification needs a settled round — this one is still ${round.phaseName}`, "error");
      return;
    }
    setRunning(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      try {
        setResult(verifyRound(round));
      } catch (e) {
        push(`verification failed to run: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        setRunning(false);
      }
    }, 0);
  }, [round, push]);

  return { result, run, running };
}
