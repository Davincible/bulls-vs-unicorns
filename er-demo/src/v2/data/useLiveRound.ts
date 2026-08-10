// The live round: poll it, tick a local clock against it, and precompute the whole fight once.
//
// TWO MEMOISATION RULES, both load-bearing, both learned the hard way in `src/App.tsx`:
//
//   1. `hitEvents` memoises on PRIMITIVE KEYS derived from the round (the seed hex and an entries
//      key), never on the polled `round` object. `useRound()` hands back a brand-new `RoundState`
//      every ~1.5s poll even when nothing changed, so memoising on it would re-run the entire
//      `finalCursor(fighterCount)`-step fight — sha256 per step — every poll tick, forever.
//   2. The 250ms clock only runs during Fight. Outside it, nothing about `LiveRound` moves between
//      polls, so a timer would be four re-renders a second of identical output.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { BullsArenaProgram } from "../../chain/program.ts";
import { useRound, type RoundState } from "../../chain/useRound.ts";
import { runFullFight, type HitEvent } from "../../sim/hitEvents.ts";
import { finalCursor, type LiveRound } from "../contract.ts";
import { isSeedRevealed, toHex, toHitEventEntries, toLiveRound } from "./liveRound.ts";

/** Fast enough that the fight clock never visibly stutters, slow enough that a sixteen-fighter roster
 *  re-renders at a quarter the rate of a display refresh. The canvas animates off `requestAnimationFrame`
 *  and `fightStartedAtMs`, not off this — this is for the readouts. */
const CLOCK_MS = 250;

export interface LiveRoundResult {
  /** The raw chain state, for the two consumers that genuinely need it: `verifyRound()` and the
   *  extract-eligibility check, both of which are written against `RoundState`. */
  round: RoundState | null;
  live: LiveRound | null;
  hitEvents: HitEvent[];
  error: string | null;
  /** First fetch only — later polls update in place so the page doesn't flash. */
  loading: boolean;
}

export function useLiveRound(
  program: BullsArenaProgram | null,
  roundPda: PublicKey | null,
  youPubkey: string,
): LiveRoundResult {
  const { round, error, loading } = useRound(program, roundPda);

  const inFight = round?.phaseName === "Fight";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!inFight) return;
    // Set once immediately: entering Fight must not wait a whole tick for the clock to leave 0:00.
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(id);
  }, [inFight]);

  // See rule 1 above. These two strings change only when the seed actually reveals (Drawing -> Fight)
  // or when the entry list itself changes shape (never, once the lobby has closed) — and never when
  // only the live per-tick fields (hp/banked/dead) move underneath them.
  const seedHex = round && isSeedRevealed(round.seed) ? toHex(round.seed) : null;
  const entriesKey = round
    ? round.fighters.map((f) => `${f.wallet.toBase58()}:${f.side}:${f.stake}`).join(",")
    : "";

  // A ref, not a dep: the closure needs the fighters and the seed bytes, but reading them through a
  // ref is what lets the memo key stay primitive without lying to the linter about what it uses.
  const roundRef = useRef<RoundState | null>(round);
  roundRef.current = round;

  const hitEvents = useMemo<HitEvent[]>(() => {
    const r = roundRef.current;
    if (!seedHex || !r) return [];
    // Runs to `finalCursor(fighterCount)` unconditionally rather than to `tickCount` (only meaningful
    // once Settled, long after the canvas needs to start animating). `finalCursor` is
    // `canonical_cursor()`'s own on-chain saturation point for THIS lineup, so the stream can never
    // run out from under a live fight — and never overshoots it either, now that the ceiling scales
    // with the roster instead of being one flat number for every lineup.
    return runFullFight(Buffer.from(r.seed), toHitEventEntries(r.fighters), finalCursor(r.fighters.length))
      .events;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedHex, entriesKey]);

  const live = useMemo<LiveRound | null>(
    () => (round ? toLiveRound(round, youPubkey, nowMs) : null),
    [round, youPubkey, nowMs],
  );

  return {
    round,
    live,
    hitEvents,
    error: error === null ? null : error.message,
    loading,
  };
}
