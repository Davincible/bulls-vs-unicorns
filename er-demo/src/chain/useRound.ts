// React hook: polls a single Round account and exposes it as a plain object. Anchor camel-cases the
// raw (snake_case) IDL at `new Program(...)` time — confirmed at runtime this session by constructing
// a throwaway Program against public/idl/bulls_arena.json and inspecting `program.idl.types`, not
// assumed from the canary's comments: `round_no` -> `roundNo`, `fight_started_at` -> `fightStartedAt`,
// `fighter_count` -> `fighterCount`, `tick_count` -> `tickCount`. `Fighter`'s own fields (`wallet`,
// `side`, `dead`, `stake`, `hp`, `banked`) were already camelCase-shaped in the Rust source, so they're
// unchanged either way.

import { useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { PHASE_NAME } from "./constants.ts";
import type { BullsArenaProgram, RawRoundAccount } from "./program.ts";

export interface FighterState {
  wallet: PublicKey;
  side: number;
  dead: boolean;
  stake: bigint;
  hp: bigint;
  banked: bigint;
}

export interface RoundState {
  arena: PublicKey;
  roundNo: bigint;
  phase: number;
  phaseName: (typeof PHASE_NAME)[number];
  winner: number;
  fighterCount: number;
  tickCount: bigint;
  pot: bigint;
  seedCommit: number[];
  seed: number[];
  fightStartedAt: bigint;
  fighters: FighterState[];
}

function toPlainRound(raw: RawRoundAccount): RoundState {
  return {
    arena: raw.arena,
    roundNo: BigInt(raw.roundNo.toString()),
    phase: raw.phase,
    phaseName: PHASE_NAME[raw.phase] ?? "Lobby",
    winner: raw.winner,
    fighterCount: raw.fighterCount,
    tickCount: BigInt(raw.tickCount.toString()),
    pot: BigInt(raw.pot.toString()),
    seedCommit: raw.seedCommit,
    seed: raw.seed,
    fightStartedAt: BigInt(raw.fightStartedAt.toString()),
    fighters: raw.fighters.slice(0, raw.fighterCount).map((f) => ({
      wallet: f.wallet,
      side: f.side,
      dead: f.dead !== 0,
      stake: BigInt(f.stake.toString()),
      hp: BigInt(f.hp.toString()),
      banked: BigInt(f.banked.toString()),
    })),
  };
}

export interface UseRoundResult {
  round: RoundState | null;
  error: Error | null;
  /** True only for the very first fetch — later polls update `round`/`error` in place so the UI
   *  doesn't flash a loading state every 1-2s. */
  loading: boolean;
}

/** Polls `program.account.round.fetch(roundPda)` on an interval and returns the latest state as a
 *  plain object. `program`/`roundPda` are nullable so a component can mount before a round exists
 *  (before the admin has run `open_round`) — polling simply doesn't start until both are present. */
export function useRound(
  program: BullsArenaProgram | null,
  roundPda: PublicKey | null,
  intervalMs = 1500,
): UseRoundResult {
  const [round, setRound] = useState<RoundState | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  // Guards against a slow fetch from a PREVIOUS `roundPda`/`program` landing after a newer one has
  // already started polling — without this, switching rounds mid-flight could briefly show stale
  // data for the wrong round.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!program || !roundPda) {
      setRound(null);
      setError(null);
      setLoading(true);
      return;
    }

    const thisRequestId = ++requestIdRef.current;
    let cancelled = false;
    setLoading(true);

    const poll = async () => {
      try {
        const raw = await program.account.round.fetch(roundPda);
        if (cancelled || requestIdRef.current !== thisRequestId) return;
        setRound(toPlainRound(raw));
        setError(null);
      } catch (e) {
        if (cancelled || requestIdRef.current !== thisRequestId) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled && requestIdRef.current === thisRequestId) setLoading(false);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // `program`/`roundPda` are the only inputs that should restart polling; `intervalMs` changing at
    // runtime is not a supported use case (it's a tuning constant, not reactive UI state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, roundPda]);

  return { round, error, loading };
}
