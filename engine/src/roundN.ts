// Round orchestrator for N-team arenas (3-WAY, FFA) — same commit-reveal contract as round.ts.
// LOBBY (seed committed) → BATTLE (seed revealed, sim run, clients replay) → SETTLE.
import { randomBytes } from "crypto";
import { simulateN, seedHashN } from "./gameN.ts";
import type { EntryN, CfgN, ResultN } from "./gameN.ts";

export type PhaseN = "lobby" | "battle" | "settle";
export interface StateN {
  round: number; phase: PhaseN;
  seedHashPublished: string; seed?: string;
  entries: EntryN[]; result?: ResultN;
  multiplier: number; openedAt: number; closesAt: number; battleMs?: number;
}

const LOBBY_MS = Number(process.env.LOBBY_MS || 8_000);
const BATTLE_MS = 60_000;

export function cfgN(mode: "normal" | "extraction", teams: number, multiplier: number): CfgN {
  return { mode, teams, multiplier, base: 0.085, hitCapFrac: 0.25,
           battleMs: BATTLE_MS, tickMs: 50, matchRule: teams === 0 ? "none" : "min" };
}

export class RoundRunnerN {
  state: StateN;
  teams: number;                                   // 0 = FFA
  mode: "normal" | "extraction";
  private onSettle: (r: ResultN, s: StateN) => Promise<void>;
  private seed = "";
  constructor(mode: "normal" | "extraction", teams: number, onSettle: (r: ResultN, s: StateN) => Promise<void>) {
    this.mode = mode; this.teams = teams; this.onSettle = onSettle;
    this.state = this.freshLobby(1);
  }
  private rollMultiplier(): number {
    const u = Math.random(); return u < 0.7 ? 1 : u < 0.85 ? 2 : u < 0.93 ? 4 : u < 0.97 ? 6 : u < 0.99 ? 8 : 10;
  }
  private freshLobby(round: number): StateN {
    this.seed = randomBytes(32).toString("hex");
    const now = Date.now();
    return { round, phase: "lobby", seedHashPublished: seedHashN(this.seed), entries: [],
             multiplier: this.rollMultiplier(), openedAt: now, closesAt: now + LOBBY_MS };
  }
  /** team is the slot index (FFA: ignored, each entry is its own team) */
  enter(id: string, team: number, stake: number): boolean {
    if (this.state.phase !== "lobby") return false;
    const existing = this.state.entries.find(e => e.id === id && e.team === team);
    if (existing) { existing.stake += stake; return true; }
    this.state.entries.push({ id, team, stake });
    return true;
  }
  async tick(now = Date.now()): Promise<boolean> {
    const s = this.state;
    if (s.phase === "lobby" && now >= s.closesAt) {
      s.phase = "battle"; s.seed = this.seed;
      const cfg = cfgN(this.mode, this.teams, s.multiplier);
      s.result = simulateN(this.seed, s.entries, cfg);
      s.battleMs = Math.min(BATTLE_MS, (s.result.endTick + 2) * cfg.tickMs + 900);   // tail: let the last hits + banner land
      s.closesAt = now + s.battleMs;
      return false;
    }
    if (s.phase === "battle" && now >= s.closesAt) {
      s.phase = "settle";
      if (s.result) await this.onSettle(s.result, s);
      this.state = this.freshLobby(s.round + 1);
      return true;
    }
    return false;
  }
}
