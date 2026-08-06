// Round orchestrator with commit-reveal fairness.
// Lifecycle: LOBBY (deposits open, seed committed) → BATTLE (deposits locked, seed revealed,
// simulate) → SETTLE (post net deltas on-chain, credit off-chain ledger) → repeat.
import { randomBytes } from "crypto";
import { simulateRound, seedHash } from "./game.ts";
import type { Entry, RoundConfig, RoundResult, Mode } from "./game.ts";

export type Phase = "lobby" | "battle" | "settle";

export interface RoundState {
  round: number; mode: Mode; phase: Phase;
  seedHashPublished: string;      // published at lobby start; seed hidden until reveal
  seed?: string;                  // revealed after battle
  entries: Entry[];
  result?: RoundResult;
  multiplier: number;
  openedAt: number; closesAt: number;
  battleMs?: number;              // actual battle length (may be < BATTLE_MS if a side is wiped)
}

const LOBBY_MS = Number(process.env.LOBBY_MS || 8_000);   // deploy window between rounds (shorter = less dead air)
const BATTLE_MS = 60_000;

export function newRoundConfig(mode: Mode, multiplier: number): RoundConfig {
  // tickMs is the physics timestep now — collisions decide hits, so it must be fine-grained
  return { mode, multiplier, base: 0.085, hitCapFrac: 0.25, battleMs: BATTLE_MS, tickMs: 50, dust: 1.2 };
}

// A per-mode round runner. `onSettle` receives the net per-player wallet balances to (a) update
// the Postgres ledger and (b) batch into an on-chain `settle_round` posting.
export class RoundRunner {
  state: RoundState;
  mode: Mode;
  private onSettle: (r: RoundResult, s: RoundState) => Promise<void>;
  private seed = "";
  constructor(mode: Mode, onSettle: (r: RoundResult, s: RoundState) => Promise<void>) {
    this.mode = mode; this.onSettle = onSettle;
    this.state = this.freshLobby(1);
  }

  private rollMultiplier(): number {
    const u = Math.random(); return u < 0.7 ? 1 : u < 0.85 ? 2 : u < 0.93 ? 4 : u < 0.97 ? 6 : u < 0.99 ? 8 : 10;
  }

  private freshLobby(round: number): RoundState {
    this.seed = randomBytes(32).toString("hex");   // committed now, revealed after battle
    const mult = this.rollMultiplier();
    const now = Date.now();
    return {
      round, mode: this.mode, phase: "lobby", seedHashPublished: seedHash(this.seed),
      entries: [], multiplier: mult, openedAt: now, closesAt: now + LOBBY_MS,
    };
  }

  /** Player enters the round during lobby with a stake already reserved from their ledger balance. */
  enter(playerId: string, side: "bull" | "uwu", stake: number): boolean {
    if (this.state.phase !== "lobby") return false;
    // one fighter per side per player — topping up adds to your existing fighter rather than
    // spawning a second one. stake is the NET (fee already taken on deposit/reserve)
    const existing = this.state.entries.find(e => e.id === playerId && e.side === side);
    if (existing) { existing.stake += stake; return true; }
    this.state.entries.push({ id: playerId, side, stake });
    return true;
  }

  /** Called by the engine tick loop; advances the phase machine and returns true when a round settled. */
  async tick(now = Date.now()): Promise<boolean> {
    const s = this.state;
    if (s.phase === "lobby" && now >= s.closesAt) {
      s.phase = "battle";
      s.seed = this.seed;                                   // REVEAL
      const cfg = newRoundConfig(s.mode, s.multiplier);
      s.result = simulateRound(this.seed, s.entries, cfg);
      // the fight can be decided long before the clock runs out (a side gets wiped) — end it then,
      // plus a short tail so the last hits and the win banner land on screen
      s.battleMs = Math.min(BATTLE_MS, (s.result.endTick + 2) * cfg.tickMs + 900);   // tail: let the last hits + banner land
      s.closesAt = now + s.battleMs;
      return false;
    }
    if (s.phase === "battle" && now >= s.closesAt) {
      s.phase = "settle";
      if (s.result) await this.onSettle(s.result, s);       // ledger + on-chain batched settlement
      this.state = this.freshLobby(s.round + 1);
      return true;
    }
    return false;
  }
}
