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
  lost: number; retired: boolean;   // retired = hit its loss cap and walked away with the rest
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
// below this size ratio vs your attacker, the per-hit cap no longer protects you
export const FINISH_RATIO = 0.08;   // and only late in the round (see below)
// Bounded exposure: a fighter can lose at most this share of its OWN deposited stake in a round,
// then it retires keeping the rest. This is the core fairness rule - your downside is set by your
// stake, not by how many enemies happen to be swinging at you. Upside stays uncapped (it is
// funded by other fighters' losses), so big wins are still possible.
export const MAX_LOSS = 0.5;
// Gains are bounded too, but far looser (a 3x round is still on the table). Without any ceiling
// a small fighter compounds uncapped while risking the same 50%, so % returns favoured minnows.
export const MAX_GAIN = 2.0;

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
const aliveF = (f: Fighter, dust: number) => !f.dead && !f.retired && ring(f) > dust;
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
      lost: 0, retired: false,
      x: 0, y: 0, vx: rand(-1, 1), vy: rand(-1, 1), r: 12,
    };
    // bulls start left, unicorns right
    f.x = e.side === "bull" ? rand(30, ARENA.w * 0.34) : rand(ARENA.w * 0.66, ARENA.w - 30);
    f.y = rand(40, ARENA.h - 40);
    f.r = radiusFor(f);
    return f;
  });
  const steps = Math.floor(cfg.battleMs / cfg.tickMs);
  // NOTE: a damage handicap for the lighter side was tried here and reverted - at a 1.4x cap it
  // swung Normal from favourite +8%/underdog -11% to underdog +64%/favourite -49% and also broke
  // Extraction, which was already neutral. Side balance should be handled in the lobby instead.
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
  // A clash is resolved ATOMICALLY. Both blows are planned against a snapshot taken before
  // either lands, then applied. Resolving them in sequence let the first fighter's stolen coins
  // sit in its ring before the counter-blow was measured, which in Normal mode handed whoever
  // deployed first a compounding edge (they won ~100% of rounds).
  const planHit = (def: Fighter, snap: { bull: number; uwu: number }, dmg: number) => {
    const takeEnemy = (def.side === "bull" ? snap.uwu : snap.bull) > 0.05;   // stolen coins are lost first
    const tk: Side = takeEnemy ? (def.side === "bull" ? "uwu" : "bull") : def.side;
    return { tk, amt: Math.min(dmg, tk === "bull" ? snap.bull : snap.uwu) };
  };
  const applyHit = (atk: Fighter, def: Fighter, hit: { tk: Side; amt: number }) => {
    const budget = Math.max(0, def.deposited * MAX_LOSS - def.lost);          // downside cap
    const room = Math.max(0, atk.deposited * MAX_GAIN - atk.raided);           // upside cap
    const amt = Math.min(hit.amt, hit.tk === "bull" ? def.bull : def.uwu, budget, room);
    if (amt <= 0.01) { if (budget <= 0.01) def.retired = true; if (room <= 0.01) atk.retired = true; return; }
    if (hit.tk === "bull") def.bull -= amt; else def.uwu -= amt;
    if (cfg.mode === "extraction") { if (hit.tk === "bull") atk.sBull += amt; else atk.sUwu += amt; }
    else { if (hit.tk === "bull") atk.bull += amt; else atk.uwu += amt; }
    atk.raided += amt; atk.dmgDealt += amt; def.dmgTaken += amt; def.lost += amt;
    if (def.lost >= def.deposited * MAX_LOSS - 0.01) def.retired = true;   // walks away with the rest
    if (amt > atk.bestHit) atk.bestHit = amt;
    const h: HitLog = { t: s.t, atk: atk.id, def: def.id, amt, tk: hit.tk };
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
    // Both sides of a clash risk the same amount: the cap is a share of the SMALLER position.
    // Capping by the defender's own size let a minnow risk pennies while raiding a whale for
    // real money - tiny stakes returned ~+290% ROI against the whale's -26%.
    // Below FINISH_RATIO the cap lifts so hopeless stragglers actually die.
    const small = Math.min(ring(a), ring(b));
    // The finisher only switches on in the back half of the round. Applying it from the start
    // meant a small stake was deleted on contact, which made small play a trap (-58% ROI).
    const lateGame = s.t > s.steps * 0.5;
    const capFor = (def: Fighter, atk: Fighter) =>
      (lateGame && ring(def) < ring(atk) * FINISH_RATIO) ? ring(def) : small * cfg.hitCapFrac;
    const dAB = Math.min(gm * roll(), capFor(b, a));
    const dBA = Math.min(gm * roll(), capFor(a, b));
    const snapA = { bull: a.bull, uwu: a.uwu }, snapB = { bull: b.bull, uwu: b.uwu };
    const hitOnB = planHit(b, snapB, dAB), hitOnA = planHit(a, snapA, dBA);
    applyHit(a, b, hitOnB); applyHit(b, a, hitOnA);
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
