// N-team deterministic battle sim — powers 3-WAY and FFA arenas.
// Same provable-fairness contract as game.ts (seeded RNG, physics collisions decide hits,
// value conservation incl. refunds), generalized from two hardcoded sides to N teams:
//   3-WAY: teams = ["ansem","uwu","sol"], matched to the SMALLEST team total (min rule -
//   median was tried first and skewed the WIN badge mid 54%/light 5%; min measures 33/35/33)
//   FFA:   every fighter is its own team, no matching (nothing to favour), biggest bag wins
//   LAUNCH GATE: FFA ships EXTRACTION-ONLY. Measured: FFA+Mayhem grinds small stakes to
//   about -40% ROI (death forfeits the ring; small fighters die more; survivors compound).
//   A pairwise matched cap was tried and did not move it - parked pending a real redesign.
import { createHash } from "crypto";

export interface EntryN { id: string; team: number; stake: number; }   // stake net of fee, USD units
export interface FighterN {
  id: string; team: number;
  own: number;            // in-ring value of your own token
  stolen: number[];       // in-ring value raided from each team (index = team)
  banked: number;         // extraction: value banked out of the ring
  unmatched: number;      // matched-book refund, paid at settlement
  deposited: number; raided: number; dmgDealt: number; dmgTaken: number; bestHit: number; dead: boolean;
  x: number; y: number; vx: number; vy: number; r: number;
}
export interface CfgN {
  mode: "normal" | "extraction"; teams: number;      // teams=0 → FFA (each fighter solo)
  multiplier: number; base: number; hitCapFrac: number;
  battleMs: number; tickMs: number; matchRule: "median" | "min" | "none";
}
export interface HitN { t: number; atk: string; def: string; amt: number; }
export interface ResultN {
  seedHash: string; fighters: FighterN[]; winnerTeam: number; winnerId: string;
  hits: HitN[]; settlement: Record<string, number>;   // USD units back per entry id
  teamTotals: number[]; endTick: number;
}

export const ARENA_N = { w: 900, h: 560 };
const COMBAT = { speed: 112, accel: 300, hitCd: 380, knock: 46 };
const FINISH_RATIO = 0.08, SMALL_EDGE = 1.03, SIZE_WEIGHT = 0.9, DUST_FRAC = 0.03;

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
const rngFromSeed = (seed: string) => { const s = xmur3(seed); return sfc32(s(), s(), s(), s()); };
export const seedHashN = (seed: string) => createHash("sha256").update(seed).digest("hex");

const ring = (f: FighterN) => f.own + f.stolen.reduce((a, b) => a + b, 0);
const dustFor = (f: FighterN) => Math.max(0.005, f.deposited * DUST_FRAC);
const aliveF = (f: FighterN) => !f.dead && ring(f) > dustFor(f);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const radiusFor = (f: FighterN) => clamp(13 + 1.9 * Math.sqrt(ring(f)), 13, 30);

export function simulateN(seed: string, entries: EntryN[], cfg: CfgN): ResultN {
  const rnd = rngFromSeed(seed);
  const rand = (a: number, b: number) => a + rnd() * (b - a);
  const roll = () => { const u = rnd(); return u < 0.88 ? rand(0.2, 1.5) : u < 0.97 ? rand(1.5, 4) : rand(4, 13); };
  const ffa = cfg.teams === 0;
  const teamOf = (e: EntryN, i: number) => (ffa ? i : e.team);           // FFA: fighter index = team
  const nTeams = ffa ? entries.length : cfg.teams;

  // ---- matched book across N teams ----
  const totals = Array(nTeams).fill(0);
  entries.forEach((e, i) => { totals[teamOf(e, i)] += e.stake; });
  let capPer = Infinity;
  if (!ffa && cfg.matchRule !== "none" && nTeams >= 2) {
    const sorted = totals.slice().sort((a, b) => a - b);
    capPer = cfg.matchRule === "min" ? sorted[0]
           : sorted[Math.floor((sorted.length - 1) / 2)];                 // MEDIAN (3-way: middle value)
    if (capPer <= 0) capPer = sorted.find(v => v > 0) ?? 0;               // degenerate lobbies
  }
  const frac = (team: number) => (totals[team] > 0 ? Math.min(1, capPer / totals[team]) : 1);

  const F: FighterN[] = entries.map((e, i) => {
    const team = teamOf(e, i);
    const inPlay = e.stake * frac(team);
    const f: FighterN = {
      id: e.id, team, own: inPlay, stolen: Array(nTeams).fill(0), banked: 0,
      unmatched: e.stake - inPlay, deposited: e.stake, raided: 0, dmgDealt: 0, dmgTaken: 0, bestHit: 0, dead: false,
      x: 0, y: 0, vx: rand(-1, 1), vy: rand(-1, 1), r: 12,
    };
    // spawn: teams get arc sectors around the arena, FFA scatters
    const ang = ffa ? rand(0, Math.PI * 2) : (team / nTeams) * Math.PI * 2 + rand(-0.5, 0.5);
    const cx = ARENA_N.w / 2, cy = ARENA_N.h / 2, rr = ffa ? rand(60, 240) : rand(150, 250);
    f.x = clamp(cx + Math.cos(ang) * rr, 20, ARENA_N.w - 20);
    f.y = clamp(cy + Math.sin(ang) * rr * (ARENA_N.h / ARENA_N.w), 20, ARENA_N.h - 20);
    f.r = radiusFor(f);
    return f;
  });
  const hits: HitN[] = [];
  const steps = Math.floor(cfg.battleMs / cfg.tickMs);
  let endTick = steps;
  const pairCd = new Map<string, number>();

  for (let t = 0; t < steps; t++) {
    const A = F.filter(aliveF);
    const teamsAlive = new Set(A.map(f => f.team));
    if (teamsAlive.size < 2) { endTick = t; break; }
    const dt = cfg.tickMs / 1000, nowMs = t * cfg.tickMs, ramp = 1 + 1.6 * (t / steps);

    for (const p of A) {
      p.r += (radiusFor(p) - p.r) * 0.15;
      let tgt: FighterN | null = null, td = 1e18;
      const rp = Math.max(0.01, ring(p));
      for (const q of A) {
        if (q.team === p.team) continue;
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
        const rq = Math.max(0.01, ring(q));
        const ratio = Math.min(rp > rq ? rp / rq : rq / rp, 8);
        const score = d * (1 + SIZE_WEIGHT * (ratio - 1));
        if (score < td) { td = score; tgt = q; }
      }
      if (tgt) { const ax = tgt.x - p.x, ay = tgt.y - p.y, al = Math.hypot(ax, ay) || 1;
        p.vx += (ax / al) * COMBAT.accel * ramp * dt; p.vy += (ay / al) * COMBAT.accel * ramp * dt; }
      p.vx += rand(-8, 8) * dt; p.vy += rand(-8, 8) * dt;
      const sp = Math.hypot(p.vx, p.vy) || 0.001, mx = COMBAT.speed * ramp * 1.4;
      if (sp > mx) { p.vx *= mx / sp; p.vy *= mx / sp; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < p.r) { p.x = p.r; p.vx = Math.abs(p.vx); }
      if (p.x > ARENA_N.w - p.r) { p.x = ARENA_N.w - p.r; p.vx = -Math.abs(p.vx); }
      if (p.y < p.r) { p.y = p.r; p.vy = Math.abs(p.vy); }
      if (p.y > ARENA_N.h - p.r) { p.y = ARENA_N.h - p.r; p.vy = -Math.abs(p.vy); }
    }

    // atomic clash resolution against pre-clash snapshots (order-bias proof, same as game.ts)
    const takeFrom = (def: FighterN, want: number) => {
      // stolen coins are lost first (largest stolen pot first, deterministic), then your own
      const plan: Array<[number | "own", number]> = [];
      let left = want;
      const order = def.stolen.map((v, i) => [i, v] as [number, number]).filter(([, v]) => v > 0.001)
        .sort((a, b) => b[1] - a[1]);
      for (const [i, v] of order) { if (left <= 0) break; const take = Math.min(v, left); plan.push([i, take]); left -= take; }
      if (left > 0) { const take = Math.min(def.own, left); if (take > 0) plan.push(["own", take]); }
      return plan;
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
      // recoil so a pair cannot weld together during the hit cooldown (see game.ts)
      a.vx -= nx * COMBAT.knock; a.vy -= ny * COMBAT.knock;
      b.vx += nx * COMBAT.knock; b.vy += ny * COMBAT.knock;
      if (a.team === b.team) continue;
      const key = a.id < b.id ? a.id + "|" + b.id : b.id + "|" + a.id;
      if (nowMs - (pairCd.get(key) ?? -1e9) < COMBAT.hitCd / ramp) continue;
      pairCd.set(key, nowMs);
      const base = cfg.base * Math.min(cfg.multiplier, 4) * (0.7 + 0.3 * ramp);
      const gm = Math.sqrt(ring(a) * ring(b)) * base;
      const small = Math.min(ring(a), ring(b));
      const lateGame = t > steps * 0.5;
      const capF = (def: FighterN, atk: FighterN) =>
        (lateGame && ring(def) < ring(atk) * FINISH_RATIO) ? ring(def) : small * cfg.hitCapFrac;
      const eA = ring(a) < ring(b) ? SMALL_EDGE : 1, eB = ring(b) < ring(a) ? SMALL_EDGE : 1;
      const dAB = Math.min(gm * roll() * eA, capF(b, a));
      const dBA = Math.min(gm * roll() * eB, capF(a, b));
      const planB = takeFrom(b, dAB), planA = takeFrom(a, dBA);   // plans on pre-clash state
      const apply = (atk: FighterN, def: FighterN, plan: Array<[number | "own", number]>) => {
        let got = 0;
        for (const [src, amt] of plan) {
          const avail = src === "own" ? def.own : def.stolen[src as number];
          const take = Math.min(amt, avail);
          if (take <= 0.005) continue;
          if (src === "own") def.own -= take; else def.stolen[src as number] -= take;
          const asTeam = src === "own" ? def.team : (src as number);
          if (cfg.mode === "extraction") atk.banked += take;
          else if (asTeam === atk.team) atk.own += take; else atk.stolen[asTeam] += take;
          got += take;
        }
        if (got <= 0.005) return 0;
        atk.raided += got; atk.dmgDealt += got; def.dmgTaken += got;
        if (got > atk.bestHit) atk.bestHit = got;
        hits.push({ t, atk: atk.id, def: def.id, amt: got });
        return got;
      };
      apply(a, b, planB); apply(b, a, planA);
      if (ring(a) <= dustFor(a)) a.dead = true;
      if (ring(b) <= dustFor(b)) b.dead = true;
    }
  }

  const teamTotals = Array(nTeams).fill(0);
  for (const f of F) teamTotals[f.team] += ring(f) + f.banked;
  let winnerTeam = 0;
  teamTotals.forEach((v, i) => { if (v > teamTotals[winnerTeam]) winnerTeam = i; });
  let winnerId = ""; let bestBag = -1;
  for (const f of F) { const bag = ring(f) + f.banked + f.unmatched; if (bag > bestBag) { bestBag = bag; winnerId = f.id; } }
  const settlement: Record<string, number> = {};
  for (const f of F) settlement[f.id] = ring(f) + f.banked + f.unmatched;
  return { seedHash: seedHashN(seed), fighters: F, winnerTeam, winnerId, hits, settlement, teamTotals, endTick };
}
