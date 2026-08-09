// Flash + GlowFilter + pooled tsParticles burst + damage-number floater — fired once per `HitEvent`,
// exactly when gameLoop.ts's playhead reaches that event's scheduled step (never before, never
// speculatively). This is the payoff of the whole retarget() architecture: the fighters were already
// steering toward each other in anticipation, so the FX lands on a pair that's visually together.
import { Container as PixiContainer, Graphics, Text } from "pixi.js";
import { GlowFilter } from "pixi-filters";
import type { Container as ParticlesContainer } from "@tsparticles/engine";
import type { HitEvent } from "../../sim/hitEvents.ts";
import type { FighterSprite } from "../fighterSprite.ts";

const FLASH_DURATION_MS = 220;
const GLOW_DURATION_MS = 260;
const FLOATER_DURATION_MS = 850;
const FLOATER_RISE_PX = 42;
/** Capped, not "one particle per lamport of damage" — see the plan doc's Phase 7 performance budget
 *  note (glow quality low, capped concurrent particle bursts). A fixed count per hit is the "pooled"
 *  part: the tsParticles `Container` itself is created once (PixiCanvas.tsx) and reused for every
 *  burst via `particles.push()`, never torn down and recreated per hit. */
const PARTICLE_BURST_COUNT = 14;

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
  /** Called once, the instant gameLoop.ts's playhead crosses `event`'s scheduled step. */
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

  function spawnFlash(x: number, y: number, nowMs: number): void {
    const graphic = new Graphics().circle(0, 0, 26).fill({ color: 0xffffff, alpha: 0.9 });
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
    const filter = new GlowFilter({ distance: 14, outerStrength: 3, color: 0xffffff, quality: 0.2 });
    sprite.avatar.filters = [filter];
    glows.push({ sprite, filter, expiresAtMs: nowMs + GLOW_DURATION_MS });
  }

  function spawnFloater(x: number, y: number, amount: bigint, nowMs: number): void {
    const text = new Text({
      text: `-${formatAmount(amount)}`,
      style: { fontFamily: "monospace", fontSize: 13, fontWeight: "bold", fill: 0xffcc33 },
    });
    text.anchor.set(0.5, 1);
    text.position.set(x, y);
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

      const particles = deps.getParticlesContainer();
      particles?.particles.push(PARTICLE_BURST_COUNT, { x, y }, particleBurstOverrides());
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
        f.graphic.alpha = 1 - t;
        f.graphic.scale.set(1 + t * 0.6);
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
