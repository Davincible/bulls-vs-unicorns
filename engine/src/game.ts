// Deterministic, seed-driven battle simulation — the provably-fair core.
// Given the revealed seed + the round's entries, ANYONE recomputes the exact outcome and
// verifies it matches the engine. No hidden state. Economy ported from the tuned prototype.
import { createHash } from "crypto";

export type Side = "bull" | "uwu";
export type Mode = "normal" | "extraction";

export interface Entry { id: string; side: Side; stake: number; } // stake already net of the 0.2% fee
export interface Fighter {
  id: string; side: Side; ownedBull: number; ownedUwu: number; // in-ring holdings
  bankedBull: number; bankedUwu: number;                        // extraction: banked to wallet
  deposited: number; raided: number; dmgDealt: number; dead: boolean;
}
export interface RoundConfig {
  mode: Mode; multiplier: number; base: number; hitCapFrac: number;
  battleMs: number; tickMs: number; dust: number;
}
export interface RoundResult {
  seedHash: string;
  fighters: Fighter[];
  winner: Side;
  hits: HitLog[];                 // full ordered log — replayable
  settlement: Record<string, { bull: number; uwu: number }>; // per-entry final wallet delta
}
export interface HitLog { t: number; atk: string; def: string; amt: number; tk: Side; }

// --- deterministic RNG: xmur3 seed -> sfc32 stream (fast, reproducible across JS engines) ---
function xmur3(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
}
function sfc32(a: number, b: number, c: number, d: number) {
  return () => { a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296; };
}
function rngFromSeed(seed: string) {
  const s = xmur3(seed);
  return sfc32(s(), s(), s(), s());
}

export function seedHash(seed: string): string { return createHash("sha256").update(seed).digest("hex"); }

const ring = (f: Fighter) => f.ownedBull + f.ownedUwu;
const alive = (f: Fighter, dust: number) => !f.dead && ring(f) > dust;

// simulate a full round deterministically from (seed, entries, config)
export function simulateRound(seed: string, entries: Entry[], cfg: RoundConfig): RoundResult {
  const rnd = rngFromSeed(seed);
  const rand = (a: number, b: number) => a + rnd() * (b - a);
  // combat "roll" — fat-tail crits, matching the prototype
  const roll = () => { const u = rnd(); return u < 0.88 ? rand(0.2, 1.5) : u < 0.97 ? rand(1.5, 4) : rand(4, 13); };

  const F: Fighter[] = entries.map(e => ({
    id: e.id, side: e.side, ownedBull: e.side === "bull" ? e.stake : 0, ownedUwu: e.side === "uwu" ? e.stake : 0,
    bankedBull: 0, bankedUwu: 0, deposited: e.stake, raided: 0, dmgDealt: 0, dead: false,
  }));
  const hits: HitLog[] = [];
  const ownKey = (f: Fighter) => (f.side === "bull" ? "ownedBull" : "ownedUwu") as "ownedBull" | "ownedUwu";
  const enemyKey = (f: Fighter) => (f.side === "bull" ? "ownedUwu" : "ownedBull") as "ownedBull" | "ownedUwu";

  const strike = (t: number, atk: Fighter, def: Fighter, dmg: number) => {
    // you lose STOLEN coins first, then your own
    const takeEnemy = def[enemyKey(def)] > 0.05;
    const tkField = takeEnemy ? enemyKey(def) : ownKey(def);
    const tkSide: Side = tkField === "ownedBull" ? "bull" : "uwu";
    dmg = Math.min(dmg, def[tkField]);
    if (dmg <= 0.01) return;
    def[tkField] -= dmg;
    if (cfg.mode === "extraction") { // raids bank out of the ring
      if (tkSide === "bull") atk.bankedBull += dmg; else atk.bankedUwu += dmg;
    } else { atk[tkField] += dmg; }   // normal: compound in-ring
    atk.raided += dmg; atk.dmgDealt += dmg;
    hits.push({ t, atk: atk.id, def: def.id, amt: dmg, tk: tkSide });
  };

  const base = cfg.base * Math.min(cfg.multiplier, 4);
  const steps = Math.floor(cfg.battleMs / cfg.tickMs);
  for (let t = 0; t < steps; t++) {
    const A = F.filter(f => alive(f, cfg.dust));
    const bulls = A.filter(f => f.side === "bull"), unis = A.filter(f => f.side === "uwu");
    if (!bulls.length || !unis.length) break;
    // deterministic pairing this tick: each alive fighter clashes a pseudo-random enemy
    for (const f of A) {
      if (!alive(f, cfg.dust)) continue;
      const foes = f.side === "bull" ? unis : bulls;
      const g = foes[Math.floor(rnd() * foes.length)];
      if (!g || !alive(g, cfg.dust)) continue;
      const ramp = 1 + 1.6 * (t / steps);
      const gm = Math.sqrt(ring(f) * ring(g)) * base * (0.7 + 0.3 * ramp);
      let d = gm * roll(); d = Math.min(d, ring(g) * cfg.hitCapFrac);
      strike(t, f, g, d);
    }
  }
  const bullV = F.filter(f => f.side === "bull").reduce((s, f) => s + ring(f) + f.bankedBull + f.bankedUwu, 0);
  const uwuV = F.filter(f => f.side === "uwu").reduce((s, f) => s + ring(f) + f.bankedBull + f.bankedUwu, 0);
  const winner: Side = bullV >= uwuV ? "bull" : "uwu";

  const settlement: Record<string, { bull: number; uwu: number }> = {};
  for (const f of F) settlement[f.id] = { bull: f.ownedBull + f.bankedBull, uwu: f.ownedUwu + f.bankedUwu };
  return { seedHash: seedHash(seed), fighters: F, winner, hits, settlement };
}

// verify: independently recompute and compare the settlement (what a player/auditor runs)
export function verifyRound(seed: string, entries: Entry[], cfg: RoundConfig, claimed: RoundResult): boolean {
  if (seedHash(seed) !== claimed.seedHash) return false;
  const re = simulateRound(seed, entries, cfg);
  return JSON.stringify(re.settlement) === JSON.stringify(claimed.settlement) && re.winner === claimed.winner;
}
