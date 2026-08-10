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
import { bnOr0, type BullsArenaProgram, type RawRoundAccount } from "./program.ts";

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
  /** What the house has taken out of this round in extract penalties, cumulative. Needed by anything
   *  checking conservation — `sum(hp + banked) + penaltiesCollected === pot` — and by any UI that
   *  wants to show what leaving early has cost the table so far. */
  penaltiesCollected: bigint;
  /** The other half of the house's take: the arena's entry fee, cumulative over every `enter`,
   *  top-ups included.
   *
   *  IT CHANGES WHAT `pot` MEANS TO A READER, which is the reason to carry it up here rather than
   *  leave it on the raw account. `pot` is the sum of NET stakes — the fee was taken at the door and
   *  never entered the ring — so `pot` is what is being fought over, and `pot + feesCollected` is
   *  what players actually paid. Anything that puts a pot on screen next to the word "staked" wants
   *  the second number. See `Round.fees_collected` in lib.rs. */
  feesCollected: bigint;
  /** Whether `sweep_house_take` has already booked this round's take onto the arena's `Treasury`. */
  houseSwept: boolean;
  seedCommit: number[];
  seed: number[];
  /** When the lobby opened and when it stops taking entries, in on-chain unix seconds.
   *
   *  THIS IS WHAT A LOBBY COUNTDOWN MUST BE DRAWN FROM. Both ends are enforced by the program —
   *  `enter` refuses at or after `lobbyClosesAt`, `close_lobby_and_draw` refuses before it — so the
   *  number on screen is the rule the chain is applying, not a client-side guess at when an operator
   *  intends to close. `lobbyOpenedAt` is the other end a progress bar needs: remaining time comes
   *  from the deadline, but the fraction elapsed needs the duration, and inventing that duration from
   *  a client constant is the exact thing this field exists to stop.
   *
   *  ZERO MEANS THIS ROUND HAS NO DEADLINE, and that is a state to survive rather than an error. The
   *  lobby fields arrived in a later revision of the program than the one that may be deployed; a
   *  round opened by an earlier `open_round` carries no deadline at all and takes deposits for the
   *  whole of its `Lobby` phase. Callers must read these through `data/liveRound.ts`, which turns a
   *  zero into an explicit null rather than a timestamp in 1970. */
  lobbyOpenedAt: bigint;
  lobbyClosesAt: bigint;
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
    // `bnOr0`, not `raw.x.toString()`, for every field below: decoded against a program revision
    // that predates them they are simply absent, and dereferencing them there would throw inside a
    // poll — turning "the chain is one deploy behind this build" into "the page cannot read any
    // round at all". `penaltiesCollected` was written the bare way and had the bug latent the whole
    // time; it is not hypothetical which revisions this app gets pointed at, so it is fixed here
    // rather than left for the deploy that would have found it.
    penaltiesCollected: bnOr0(raw.penaltiesCollected),
    feesCollected: bnOr0(raw.feesCollected),
    // Same "absent means the revision has no sweep" reasoning as above, plus the boundary conversion
    // this field alone needs: the wire value is a `u8` (bytemuck can't make `bool` Pod — see
    // `RawRoundAccount.houseSwept`'s own doc comment in program.ts), so `raw.houseSwept` is a NUMBER
    // here, not a boolean, and `?? false` on a number would type-error rather than silently misbehave.
    // `!== 0` is the same normalization `f.dead !== 0` already does below for exactly the same reason —
    // this is the one place a raw wire count becomes an app-level boolean; nothing past this function
    // should ever see the byte again.
    houseSwept: (raw.houseSwept ?? 0) !== 0,
    seedCommit: raw.seedCommit,
    seed: raw.seed,
    lobbyOpenedAt: bnOr0(raw.lobbyOpenedAt),
    lobbyClosesAt: bnOr0(raw.lobbyClosesAt),
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
