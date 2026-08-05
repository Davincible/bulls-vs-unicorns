// Deterministic, seed-driven battle simulation — the provably-fair core.
//
// This runs the REAL physics (movement, collisions) on a fixed timestep, so a hit happens
// because two fighters actually collided — exactly like the original prototype — while staying
// perfectly reproducible: given the revealed seed, anyone recomputes the identical fight.
// The browser runs a byte-identical port of this file, so the arena you watch IS the
// authoritative simulation rather than an animation layered over a precomputed result.
import { createHash } from "crypto";

export type Side = "bull" | "uwu";
export type Mode = "normal" | "extraction";

export interface Entry { id: string; side: Side; stake: number; } // stake already net of the 0.2% fee
export interface Fighter {
  id: string; side: Side;
  bull: number; uwu: number;        // in-ring holdings (what's at risk)
  sBull: number; sUwu: number;      // extraction: banked out of the ring
  deposited: number; raided: number; dmgDealt: number; dmgTaken: number; bestHit: number; dead: boolean;
  x: number; y: number; vx: number; vy: number; r: number;
}
export interface RoundConfig {
  mode: Mode; multiplier: number; base: number; hitCapFrac: number;
  battleMs: number; tickMs: number; dust: number;
}
export interface HitLog { t: number; atk: string; def: string; amt: number; tk: Side; }
export interface RoundResult {
  seedHash: string;
  fighters: Fighter[];
  winner: Side;
  hits: HitLog[];
  settlement: Record<string, { bull: number; uwu: number }>;
  endTick: number;
}

// virtual arena — fixed so the sim is identical everywhere; the client scales it to its canvas
export const ARENA = { w: 900, h: 560 };
export const COMBAT = { speed: 112, accel: 250, hitCd: 430 };

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
function rngFromSeed(seed: string) { const s = xmur3(seed); return sfc32(s(), s(), s(), s()); }

export function seedHash(seed: string): string { return createHash("sha256").update(seed).digest("hex"); }

export const ring = (f: Fighter) => f.bull + f.uwu;
const aliveF = (f: Fighter, dust: number) => !f.dead && ring(f) > dust;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const radiusFor = (f: Fighter) => clamp(7 + 1.7 * Math.sqrt(ring(f)), 7, 26);

export interface SimState {
  rnd: () => number; F: Fighter[]; byId: Map<string, Fighter>;
  hits: HitLog[]; t: number; steps: number; cfg: RoundConfig;
  pairCd: Map<string, number>; endTick: number; done: boolean;
}

export function createSim(seed: string, entries: Entry[], cfg: RoundConfig): SimState {
  const rnd = rngFromSeed(seed);
  const rand = (a: number, b: number) => a + rnd() * (b - a);
  const F: Fighter[] = entries.map(e => {
    const f: Fighter = {
      id: e.id, side: e.side,
      bull: e.side === "bull" ? e.stake : 0, uwu: e.side === "uwu" ? e.stake : 0,
      sBull: 0, sUwu: 0, deposited: e.stake, raided: 0, dmgDealt: 0, dmgTaken: 0, bestHit: 0, dead: false,
      x: 0, y: 0, vx: rand(-1, 1), vy: rand(-1, 1), r: 12,
    };
    // bulls start left, unicorns right
    f.x = e.side === "bull" ? rand(30, ARENA.w * 0.34) : rand(ARENA.w * 0.66, ARENA.w - 30);
    f.y = rand(40, ARENA.h - 40);
    f.r = radiusFor(f);
    return f;
  });
  const steps = Math.floor(cfg.battleMs / cfg.tickMs);
  return { rnd, F, byId: new Map(F.map(f => [f.id, f])), hits: [], t: 0, steps, cfg, pairCd: new Map(), endTick: steps, done: false };
}

/** Advance exactly one tick. Returns the hits produced by collisions during it. */
export function stepSim(s: SimState): HitLog[] {
  const { cfg, rnd } = s;
  const rand = (a: number, b: number) => a + rnd() * (b - a);
  const roll = () => { const u = rnd(); return u < 0.88 ? rand(0.2, 1.5) : u < 0.97 ? rand(1.5, 4) : rand(4, 13); };
  const out: HitLog[] = [];
  if (s.done) return out;

  const A = s.F.filter(f => aliveF(f, cfg.dust));
  const bulls = A.filter(f => f.side === "bull"), unis = A.filter(f => f.side === "uwu");
  if (!bulls.length || !unis.length) { s.endTick = s.t; s.done = true; return out; }
  if (s.t >= s.steps) { s.endTick = s.steps; s.done = true; return out; }

  const dt = cfg.tickMs / 1000;
  const nowMs = s.t * cfg.tickMs;
  const ramp = 1 + 1.6 * (s.t / s.steps);

  // --- movement: seek the nearest enemy, with a little jitter ---
  for (const p of A) {
    p.r += (radiusFor(p) - p.r) * 0.15;
    let tgt: Fighter | null = null, td = 1e18;
    for (const q of A) {
      if (q.side === p.side) continue;
      const dx = q.x - p.x, dy = q.y - p.y, d = dx * dx + dy * dy;
      if (d < td) { td = d; tgt = q; }
    }
    if (tgt) {
      const ax = tgt.x - p.x, ay = tgt.y - p.y, al = Math.hypot(ax, ay) || 1;
      p.vx += (ax / al) * COMBAT.accel * ramp * dt;
      p.vy += (ay / al) * COMBAT.accel * ramp * dt;
    }
    p.vx += rand(-8, 8) * dt; p.vy += rand(-8, 8) * dt;
    const sp = Math.hypot(p.vx, p.vy) || 0.001, mx = COMBAT.speed * ramp * 1.4;
    if (sp > mx) { p.vx *= mx / sp; p.vy *= mx / sp; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx); }
    if (p.x > ARENA.w - p.r) { p.x = ARENA.w - p.r; p.vx = -Math.abs(p.vx); }
    if (p.y < p.r) { p.y = p.r; p.vy = Math.abs(p.vy); }
    if (p.y > ARENA.h - p.r) { p.y = ARENA.h - p.r; p.vy = -Math.abs(p.vy); }
  }

  // --- collisions: separate, exchange momentum, and fight if they're on opposite sides ---
  const strike = (atk: Fighter, def: Fighter, dmg: number) => {
    const takeEnemy = (def.side === "bull" ? def.uwu : def.bull) > 0.05;   // stolen coins are lost first
    const tk: Side = takeEnemy ? (def.side === "bull" ? "uwu" : "bull") : def.side;
    const amt = Math.min(dmg, tk === "bull" ? def.bull : def.uwu);
    if (amt <= 0.01) return;
    if (tk === "bull") def.bull -= amt; else def.uwu -= amt;
    if (cfg.mode === "extraction") { if (tk === "bull") atk.sBull += amt; else atk.sUwu += amt; }
    else { if (tk === "bull") atk.bull += amt; else atk.uwu += amt; }
    atk.raided += amt; atk.dmgDealt += amt; def.dmgTaken += amt;
    if (amt > atk.bestHit) atk.bestHit = amt;
    const h: HitLog = { t: s.t, atk: atk.id, def: def.id, amt, tk };
    s.hits.push(h); out.push(h);
  };

  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    const a = A[i], b = A[j];
    if (a.dead || b.dead) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), m = a.r + b.r;
    if (d >= m || d <= 0) continue;
    const nx = dx / d, ny = dy / d, ov = (m - d) / 2;
    a.x -= nx * ov; a.y -= ny * ov; b.x += nx * ov; b.y += ny * ov;
    const va = a.vx * nx + a.vy * ny, vb = b.vx * nx + b.vy * ny, diff = vb - va;
    a.vx += nx * diff; a.vy += ny * diff; b.vx -= nx * diff; b.vy -= ny * diff;
    if (a.side === b.side) continue;

    const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;   // per-pair hit cooldown
    if (nowMs - (s.pairCd.get(key) ?? -1e9) < COMBAT.hitCd / ramp) continue;
    s.pairCd.set(key, nowMs);
    const base = cfg.base * Math.min(cfg.multiplier, 4) * (0.7 + 0.3 * ramp);
    const gm = Math.sqrt(ring(a) * ring(b)) * base;
    const dAB = Math.min(gm * roll(), ring(b) * cfg.hitCapFrac);
    const dBA = Math.min(gm * roll(), ring(a) * cfg.hitCapFrac);
    strike(a, b, dAB); strike(b, a, dBA);
    if (ring(a) <= cfg.dust) a.dead = true;
    if (ring(b) <= cfg.dust) b.dead = true;
  }

  s.t++;
  if (s.t >= s.steps) { s.endTick = s.steps; s.done = true; }
  return out;
}

export function finishSim(s: SimState): RoundResult {
  const F = s.F;
  const bullV = F.filter(f => f.side === "bull").reduce((a, f) => a + ring(f) + f.sBull + f.sUwu, 0);
  const uwuV = F.filter(f => f.side === "uwu").reduce((a, f) => a + ring(f) + f.sBull + f.sUwu, 0);
  const settlement: Record<string, { bull: number; uwu: number }> = {};
  for (const f of F) settlement[f.id] = { bull: f.bull + f.sBull, uwu: f.uwu + f.sUwu };
  return { seedHash: "", fighters: F, winner: bullV >= uwuV ? "bull" : "uwu", hits: s.hits, settlement, endTick: s.endTick };
}

/** Run a whole round to completion (engine + auditors). */
export function simulateRound(seed: string, entries: Entry[], cfg: RoundConfig): RoundResult {
  const s = createSim(seed, entries, cfg);
  while (!s.done) stepSim(s);
  const r = finishSim(s);
  r.seedHash = seedHash(seed);
  return r;
}

// verify: independently recompute and compare the settlement (what a player/auditor runs)
export function verifyRound(seed: string, entries: Entry[], cfg: RoundConfig, claimed: RoundResult): boolean {
  if (seedHash(seed) !== claimed.seedHash) return false;
  const re = simulateRound(seed, entries, cfg);
  return JSON.stringify(re.settlement) === JSON.stringify(claimed.settlement) && re.winner === claimed.winner;
}
