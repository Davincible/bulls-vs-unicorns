// Shockwave ring + GlowFilter + pooled tsParticles burst + damage-number floater — fired once per
// `HitEvent`, exactly when gameLoop.ts's playhead reaches that event's scheduled step (never before,
// never speculatively). This is the payoff of the whole retarget() architecture: the fighters were
// already steering toward each other in anticipation, so the FX lands on a pair that's visually
// together.
//
// Each of those four pieces is independently rate-limited so a dense flurry of hits stays inside
// REACT.md §8's performance budget AND stays legible — see the PERFORMANCE BUDGET block below,
// which is where the real reasoning lives.
import { Container as PixiContainer, Graphics, Text } from "pixi.js";
import { GlowFilter } from "pixi-filters";
import type { Container as ParticlesContainer } from "@tsparticles/engine";
import type { HitEvent } from "../../sim/hitEvents.ts";
import type { FighterSprite } from "../fighterSprite.ts";
import { FIGHTER_RADIUS } from "./ArenaScene.ts";

/** The one colour every part of an impact shares — ring, glow, floater, and particles. Impacts
 *  landing in three different colours read as three unrelated effects going off at once, which is
 *  what a dense flurry looked like before this. */
const IMPACT_COLOR = 0xffcc33;

const FLASH_DURATION_MS = 220;
const GLOW_DURATION_MS = 260;
const FLOATER_DURATION_MS = 850;
const FLOATER_RISE_PX = 42;
/** Horizontal offsets cycled through so consecutive damage numbers on the same defender don't stack
 *  on top of each other — see `spawnFloater`. */
const FLOATER_FAN_OUT_PX = [0, -30, 30, -15, 15];
/** Capped, not "one particle per lamport of damage" — see the plan doc's Phase 7 performance budget
 *  note (glow quality low, capped concurrent particle bursts). A fixed count per hit is the "pooled"
 *  part: the tsParticles `Container` itself is created once (PixiCanvas.tsx) and reused for every
 *  burst via `particles.push()`, never torn down and recreated per hit. */
const PARTICLE_BURST_COUNT = 14;
/** How long one pushed particle lives. PixiCanvas.tsx feeds this straight into the tsParticles
 *  options (`life.duration`) so the burst throttle below and the particles' actual lifetime can't
 *  drift apart — the throttle's whole correctness argument is "duration / cap = spacing". */
export const PARTICLE_BURST_LIFETIME_MS = 600;

// ---------------------------------------------------------------------------------------------
// PERFORMANCE BUDGET (Phase 7). REACT.md §8: "Particle bursts — cap concurrent burst instances
// (e.g. max 5 alive at once); queue overflow pops."
//
// Why this is load-bearing rather than a precaution: the fight plays back at `STEPS_PER_SECOND =
// 175` (gameLoop.ts, mirrored from the on-chain constant), and in a two-fighter round EVERY step
// produces a valid cross-side exchange — `tick()` only skips same-side/self/dead pairs, and with one
// fighter per side there are none. So `fire()` is called up to 175x per second, i.e. ~3x per frame
// at 60fps. Uncapped that meant ~105 concurrent particle bursts (~1,470 particles, held back only by
// tsParticles' own `limit`), ~148 concurrent `Text` floaters at 175 texture allocations/second, and
// ~38 concurrent additive `Graphics` flashes. That is far outside the budget above, and it is also
// simply unreadable — 148 overlapping damage numbers convey less than 8 do.
//
// The caps are expressed as "at most N alive at once", and the minimum spacing between spawns is
// DERIVED from that (duration / cap) rather than tuned independently, so the two can't disagree.
// Below the cap — a 16-fighter round, where most steps are skipped as same-side or dead — nothing
// throttles and every hit still gets its full FX.
//
// WHAT DROPPING AN FX DOES NOT AFFECT: gameLoop.ts advances the shadow-fight state for every event
// via `advanceShadow()`, independently of this controller. Hp bars, deaths, and the settled outcome
// are unchanged by any of this — only how many of a dense flurry's hits get a visible flourish.
const MAX_CONCURRENT_FLASHES = 6;
const MAX_CONCURRENT_FLOATERS = 8;
const MAX_CONCURRENT_GLOWS = 6;
const MAX_CONCURRENT_BURSTS = 5;

const FLASH_MIN_INTERVAL_MS = FLASH_DURATION_MS / MAX_CONCURRENT_FLASHES;
const FLOATER_MIN_INTERVAL_MS = FLOATER_DURATION_MS / MAX_CONCURRENT_FLOATERS;
const BURST_MIN_INTERVAL_MS = PARTICLE_BURST_LIFETIME_MS / MAX_CONCURRENT_BURSTS;

/** The burst cap restated in particles, for tsParticles' own `particles.number.limit` backstop —
 *  see PixiCanvas.tsx's `PARTICLE_OPTIONS`. Derived here rather than there so there is exactly one
 *  place where "how many particles may be alive at once" is decided. */
export const MAX_ALIVE_PARTICLES = MAX_CONCURRENT_BURSTS * PARTICLE_BURST_COUNT;

interface ActiveFlash {
  graphic: Graphics;
  startedAtMs: number;
}

interface ActiveFloater {
  text: Text;
  startedAtMs: number;
  startY: number;
}

interface ActiveGlow {
  sprite: FighterSprite;
  filter: GlowFilter;
  expiresAtMs: number;
}

export interface ImpactFxDeps {
  /** Layer added above fighter sprites in the stage — flashes and floaters live here. */
  fxLayer: PixiContainer;
  getSprite(fighterId: number): FighterSprite | undefined;
  /** `null` until `@tsparticles/react`'s `particlesLoaded` callback has fired (async engine init) —
   *  every call site tolerates this: a hit landing before particles finish loading just skips the
   *  particle burst, nothing else. */
  getParticlesContainer(): ParticlesContainer | null;
}

export interface ImpactFxController {
  /** Called once, the instant gameLoop.ts's playhead crosses `event`'s scheduled step. Always
   *  called for every event; how much of the impact is actually drawn depends on how many of the
   *  same kind are already on screen (see the PERFORMANCE BUDGET block above). */
  fire(event: HitEvent): void;
  /** Called every frame to advance/cull active flashes, glows, and floaters. Takes `nowMs` rather
   *  than a delta so cleanup is exact regardless of frame timing jitter. */
  update(nowMs: number): void;
  /** Removes every active FX object from the stage and clears internal state — used on unmount and
   *  on a fight reinit (see gameLoop.ts) so stale FX from a previous round can't linger. */
  clear(): void;
}

export function createImpactFxController(deps: ImpactFxDeps): ImpactFxController {
  const flashes: ActiveFlash[] = [];
  const floaters: ActiveFloater[] = [];
  const glows: ActiveGlow[] = [];

  // Last spawn time per FX kind, for the derived-spacing throttle described above. `-Infinity` so
  // the very first hit of a fight is never throttled.
  let lastFlashMs = -Infinity;
  let lastFloaterMs = -Infinity;
  let lastBurstMs = -Infinity;
  let floaterFanIndex = 0;

  // One GlowFilter per sprite, created on that sprite's first glow and reused for every later one.
  // Filters are relatively expensive objects (a shader program's uniform group each); a fighter is
  // hit repeatedly across a fight and its glow expires every GLOW_DURATION_MS, so allocating a fresh
  // one per glow meant tens of throwaway filters per second. A WeakMap rather than a field on
  // `FighterSprite` because sprites are rebuilt whenever the lineup changes (PixiCanvas.tsx) while
  // this controller outlives them — the entries go away with the sprites, with nothing to clean up.
  const glowFilters = new WeakMap<FighterSprite, GlowFilter>();

  function glowFilterFor(sprite: FighterSprite): GlowFilter {
    let filter = glowFilters.get(sprite);
    if (!filter) {
      // `quality: 0.2` — the low end of REACT.md §8's 0.2–0.4 band, chosen deliberately: with
      // MAX_CONCURRENT_GLOWS filtered objects on screen at once this is the setting that guidance
      // exists to protect, and at this radius the difference is not visible.
      filter = new GlowFilter({ distance: 12, outerStrength: 2.2, color: IMPACT_COLOR, quality: 0.2 });
      glowFilters.set(sprite, filter);
    }
    return filter;
  }

  function spawnFlash(x: number, y: number, nowMs: number): void {
    if (nowMs - lastFlashMs < FLASH_MIN_INTERVAL_MS) return;
    lastFlashMs = nowMs;
    // An expanding RING, not a filled disc. The disc this replaced was a 26px-radius white circle at
    // alpha 0.9 in additive blend, drawn on top of a 22px-radius fighter — one of them already
    // covered the fighter completely, and several overlapping (they all land on the same defender,
    // at the same place) turned that corner of the arena into a solid white blob with the fight
    // invisible underneath it. Caught in a real browser at full event density, not by reading it.
    // A ring reads as an impact, leaves the thing it happened to visible, and stacks as concentric
    // shockwaves rather than as accumulating opacity.
    const graphic = new Graphics()
      .circle(0, 0, FIGHTER_RADIUS)
      .stroke({ width: 3, color: IMPACT_COLOR, alpha: 0.9 });
    graphic.position.set(x, y);
    graphic.blendMode = "add";
    deps.fxLayer.addChild(graphic);
    flashes.push({ graphic, startedAtMs: nowMs });
  }

  function spawnGlow(sprite: FighterSprite, nowMs: number): void {
    // A defender already mid-glow from a hit within the last GLOW_DURATION_MS just gets its expiry
    // pushed out — no reason to stack two GlowFilter instances on the same sprite.
    const existing = glows.find((g) => g.sprite === sprite);
    if (existing) {
      existing.expiresAtMs = nowMs + GLOW_DURATION_MS;
      return;
    }
    // Deduplication above already bounds this by the fighter count (MAX_FIGHTERS = 16 on-chain), but
    // 16 simultaneously filtered objects is exactly the case REACT.md §8 warns about — and a glow on
    // everyone at once stops meaning "these two are trading blows right now". Capped, not throttled:
    // which sprites are glowing is the signal, so holding a slot until it expires is the point.
    if (glows.length >= MAX_CONCURRENT_GLOWS) return;
    const filter = glowFilterFor(sprite);
    sprite.avatar.filters = [filter];
    glows.push({ sprite, filter, expiresAtMs: nowMs + GLOW_DURATION_MS });
  }

  function spawnFloater(x: number, y: number, amount: bigint, nowMs: number): void {
    if (nowMs - lastFloaterMs < FLOATER_MIN_INTERVAL_MS) return;
    lastFloaterMs = nowMs;
    const text = new Text({
      text: `-${formatAmount(amount)}`,
      style: { fontFamily: "monospace", fontSize: 13, fontWeight: "bold", fill: IMPACT_COLOR },
    });
    text.anchor.set(0.5, 1);
    // Consecutive floaters land on the same defender, at the same point, and live long enough to
    // overlap — without a fan-out they render as one illegible smear of digits. A rotating offset
    // rather than a random one so two in a row can never coincide, which random jitter allows.
    text.position.set(x + FLOATER_FAN_OUT_PX[floaterFanIndex++ % FLOATER_FAN_OUT_PX.length], y);
    deps.fxLayer.addChild(text);
    floaters.push({ text, startedAtMs: nowMs, startY: y });
  }

  return {
    fire(event) {
      const nowMs = performance.now();
      const defender = deps.getSprite(event.defenderId);
      if (!defender) return; // out-of-range id from a caller-supplied hitEvents array — skip, don't throw
      const { x, y } = defender.root.position;

      spawnFlash(x, y, nowMs);
      spawnGlow(defender, nowMs);
      spawnFloater(x, y, event.amount, nowMs);

      if (nowMs - lastBurstMs >= BURST_MIN_INTERVAL_MS) {
        const particles = deps.getParticlesContainer();
        if (particles) {
          lastBurstMs = nowMs;
          particles.particles.push(PARTICLE_BURST_COUNT, { x, y }, particleBurstOverrides());
        }
      }
    },

    update(nowMs) {
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        const t = (nowMs - f.startedAtMs) / FLASH_DURATION_MS;
        if (t >= 1) {
          f.graphic.destroy();
          flashes.splice(i, 1);
          continue;
        }
        // Starts just inside the fighter's own outline and expands past it — the ring appears to
        // come off the impact rather than to have always been drawn around the sprite.
        f.graphic.alpha = 1 - t;
        f.graphic.scale.set(0.8 + t * 1.1);
      }

      for (let i = floaters.length - 1; i >= 0; i--) {
        const fl = floaters[i];
        const t = (nowMs - fl.startedAtMs) / FLOATER_DURATION_MS;
        if (t >= 1) {
          fl.text.destroy();
          floaters.splice(i, 1);
          continue;
        }
        fl.text.position.y = fl.startY - t * FLOATER_RISE_PX;
        fl.text.alpha = 1 - t;
      }

      for (let i = glows.length - 1; i >= 0; i--) {
        const g = glows[i];
        if (nowMs >= g.expiresAtMs) {
          g.sprite.avatar.filters = [];
          glows.splice(i, 1);
        }
      }
    },

    clear() {
      for (const f of flashes) f.graphic.destroy();
      for (const fl of floaters) fl.text.destroy();
      for (const g of glows) g.sprite.avatar.filters = [];
      flashes.length = 0;
      floaters.length = 0;
      glows.length = 0;
      // Reset the throttle clocks with the rest of the state: `clear()` means "a different fight
      // starts now" (gameLoop.ts's reinit path), and that fight's very first hit should never be
      // suppressed because of when the previous one's last hit happened.
      lastFlashMs = -Infinity;
      lastFloaterMs = -Infinity;
      lastBurstMs = -Infinity;
    },
  };
}

/** u64 lamport-scale amounts read better compacted for a floater than a raw digit string — this is
 *  purely a display choice made here, not a source-of-truth format (VerifyPanel/RoundPanel show raw
 *  values, correctly, for exactness). */
function formatAmount(amount: bigint): string {
  const n = Number(amount);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function particleBurstOverrides() {
  return {
    move: { speed: { min: 3, max: 8 } },
  };
}
