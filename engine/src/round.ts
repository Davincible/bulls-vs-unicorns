// Round orchestrator with commit-reveal fairness.
// Lifecycle: LOBBY (deposits open, seed committed) → BATTLE (deposits locked, seed revealed,
// simulate) → SETTLE (post net deltas on-chain, credit off-chain ledger) → repeat.
import { randomBytes } from "crypto";
import { simulateRound, seedHash } from "./game.ts";
import { createHash } from "node:crypto";

/** seed = sha256(secret || canonical(entries)). Canonical so a verifier reproduces it byte-for-byte:
 *  sorted by id, fixed field order, stake to a fixed precision — otherwise map iteration order or a
 *  float's tail decides whether verification passes, which is the same as it not verifying. */
export function deriveSeed(secret: string, entries: Array<{ id: string; side: string; stake: number }>): string {
  const canon = [...entries]
    .map(e => `${e.id}|${e.side}|${Number(e.stake).toFixed(8)}`)
    .sort()
    .join(";");
  return createHash("sha256").update(secret + "|" + canon).digest("hex");
}
import type { Entry, RoundConfig, RoundResult, Mode } from "./game.ts";

export type Phase = "lobby" | "battle" | "settle";

export interface RoundState {
  round: number; mode: Mode; phase: Phase;
  seedHashPublished: string;      // published at lobby start; seed hidden until reveal
  seed?: string;                  // derived at lobby close, revealed with the result
  secretRevealed?: string;        // the committed secret, published so the derivation can be checked
  entries: Entry[];
  result?: RoundResult;
  multiplier: number;
  openedAt: number; closesAt: number;
  battleMs?: number;              // actual battle length (may be < BATTLE_MS if a side is wiped)
}

const LOBBY_MS = Number(process.env.LOBBY_MS || 9_000);   // deploy window between rounds (shorter = less dead air)
const BATTLE_MS = Number(process.env.BATTLE_MS || 40_000);

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
  private secret = "";   // committed at lobby open; the seed is derived from it at lobby close
  private seed = "";     // only exists once entries are locked
  constructor(mode: Mode, onSettle: (r: RoundResult, s: RoundState) => Promise<void>, startRound = 1) {
    this.mode = mode; this.onSettle = onSettle;
    // Resume the round number across restarts. It used to start at 1 on every boot, so a
    // redeploy silently reset the match history and every "previous rounds" list with it.
    this.state = this.freshLobby(startRound);
  }

  private rollMultiplier(): number {
    const u = Math.random(); return u < 0.7 ? 1 : u < 0.85 ? 2 : u < 0.93 ? 4 : u < 0.97 ? 6 : u < 0.99 ? 8 : 10;
  }

  private freshLobby(round: number): RoundState {
    // COMMIT-REVEAL, AND WHY THE SEED IS NOT SIMPLY DRAWN HERE.
    //
    // The obvious design draws the round's randomness when the lobby opens. Players never see it —
    // only the hash is published — so it looks sound. It is not: the ENGINE then knows the outcome
    // while entries are still open. Nothing in the code acts on that, but "provably fair" cannot
    // rest on the operator choosing not to use knowledge it holds. The test is whether anyone,
    // including us, CAN know the result while anyone can still act on it.
    //
    // So the secret is committed here and the seed is DERIVED at lobby close from that secret plus
    // the final entry list. Until entries lock, the seed does not exist for anybody; the moment it
    // does exist, nobody can enter, deploy or withdraw from the round any more.
    //
    // Verification is unchanged in shape and strictly stronger: we publish sha256(secret) before
    // deploys open, then publish the secret and the entries afterwards. Anyone can check that
    // sha256(secret) matches what was committed and that seed == sha256(secret || entries).
    this.secret = randomBytes(32).toString("hex");
    const mult = this.rollMultiplier();
    const now = Date.now();
    return {
      round, mode: this.mode, phase: "lobby", seedHashPublished: seedHash(this.secret),
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
      // DERIVE NOW, not at lobby open. Entries are locked on the line above, so from this instant
      // the round is decidable — and from this instant nobody can act on it either.
      this.seed = deriveSeed(this.secret, s.entries);
      s.secretRevealed = this.secret;                       // so anyone can recompute the derivation
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
