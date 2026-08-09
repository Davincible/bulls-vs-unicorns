// The ONE React component that imports pixi.js — everything it does to the `Application`/sprites
// happens imperatively in refs/effects, never through JSX describing Pixi objects (no `@pixi/react`;
// see the plan doc's package notes on why: a real `react@>=19` vs `react@^18.2.0` peer conflict with
// `gum-react-sdk`, verified directly, not assumed). The `requestAnimationFrame` loop itself lives in
// gameLoop.ts, outside React's render cycle entirely, per REACT.md's own advice.
//
// PROP CONTRACT for whoever wires this into the real app (Phase 3's store/App.tsx are being built
// concurrently this session — see types.ts for the full field-by-field contract on `PixiCanvasProps`):
//   - `fighters`: build with `render/adapt.ts`'s `fromFighterStates(round.fighters)` for live data, or
//     `fromERFighters(...)` for a sim-only fixture. Order MUST match the on-chain fighter array order
//     (same order `hitEvents` was computed against) — `id` is a positional index, not a lookup key.
//   - `hitEvents`: the full precomputed sequence from `sim/hitEvents.ts`'s `computeHitEvents()` /
//     `runFullFight()`, run once client-side as soon as `phase === "Fight"` and `round.seed` is
//     non-null (per the plan doc's chain<->render wiring section).
//   - `fightStartedAtMs`: `Number(round.fightStartedAt) * 1000`, or `null` before the Fight phase.
//   - `phase`: `round.phaseName`, read-only context (not used to gate playhead advancement).
// This component has NO dependency on zustand/a store — it's plain props in, canvas out. (It was
// exercised standalone against a fixture in `render/harness/` during Phase 4's own build, before
// App.tsx wired it into the real app; that temporary harness was deleted in the integration pass.)
import { useEffect, useMemo, useRef, useState } from "react";
import { Application, Container } from "pixi.js";
import { Particles, ParticlesProvider, type ParticlesPluginRegistrar } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";
import type { Container as ParticlesContainer, ISourceOptions } from "@tsparticles/engine";
import { createArenaScene, destroyArenaScene, type ArenaScene } from "./arena/ArenaScene.ts";
import { createArenaBackdrop } from "./arena/backdrop.ts";
import {
  createImpactFxController,
  MAX_ALIVE_PARTICLES,
  PARTICLE_BURST_LIFETIME_MS,
  type ImpactFxController,
} from "./arena/impactFx.ts";
import { createFighterSprite, type FighterSprite } from "./fighterSprite.ts";
import { createGameLoop, type GameLoop } from "./gameLoop.ts";
import { DEFAULT_ARENA_HEIGHT, DEFAULT_ARENA_WIDTH, type PixiCanvasProps } from "./types.ts";

const BACKGROUND_COLOR = 0x0b0d12;

/** Particles stay dormant (no auto-emitted particles, `number.value: 0`) until impactFx.ts pushes a
 *  burst via `container.particles.push(...)` — this IS the "pooled" part the plan doc calls for: one
 *  persistent particle system reused for every hit, never recreated per event.
 *
 *  `limit.value` is the backstop, not the budget: impactFx.ts throttles bursts to at most
 *  MAX_CONCURRENT_BURSTS alive (REACT.md §8), and this limit is simply that same ceiling expressed in
 *  particles, so tsParticles never becomes the thing quietly absorbing an over-budget spawn rate. It
 *  was previously set to 240 — ~17 concurrent bursts, well past §8's "max 5 alive" guidance — which
 *  meant the real cap on a 175-events-per-second fight was this number and nothing else. Both the
 *  count and the lifetime are imported rather than restated so the throttle's arithmetic
 *  (lifetime / cap = spacing) stays true to what the particles actually do. */
const PARTICLE_OPTIONS: ISourceOptions = {
  fullScreen: { enable: false },
  detectRetina: true,
  fpsLimit: 60,
  particles: {
    number: { value: 0, limit: { value: MAX_ALIVE_PARTICLES } },
    color: { value: ["#ffcc33", "#ff6b3d", "#ffffff"] },
    shape: { type: "circle" },
    opacity: {
      value: { min: 0, max: 1 },
      animation: { enable: true, speed: 3, startValue: "max", destroy: "min" },
    },
    size: { value: { min: 1, max: 3 } },
    life: { duration: { value: PARTICLE_BURST_LIFETIME_MS / 1000, sync: false }, count: 1 },
    move: {
      enable: true,
      speed: { min: 3, max: 8 },
      direction: "none",
      random: true,
      straight: false,
      outModes: { default: "destroy" },
    },
  },
};

const initParticlesEngine: ParticlesPluginRegistrar = async (engine) => {
  await loadSlim(engine);
};

export function PixiCanvas(props: PixiCanvasProps) {
  const width = props.width ?? DEFAULT_ARENA_WIDTH;
  const height = props.height ?? DEFAULT_ARENA_HEIGHT;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<ArenaScene | null>(null);
  const fxControllerRef = useRef<ImpactFxController | null>(null);
  const gameLoopRef = useRef<GameLoop | null>(null);
  const spritesRef = useRef<Map<number, FighterSprite>>(new Map());
  const particlesContainerRef = useRef<ParticlesContainer | null>(null);

  // The loop's "latest props" box — see gameLoop.ts's `createGameLoop` doc for why a ref, not a
  // dependency array: props (a new poll result, a phase flip) should take effect on the very next
  // animation frame without tearing down and restarting the rAF loop.
  const propsRef = useRef<PixiCanvasProps>(props);
  propsRef.current = props;

  const [appReady, setAppReady] = useState(false);

  // Mount effect: create the Application, arena scene, FX layer, and game loop exactly once. Runs
  // only when width/height change (a fixed desktop canvas per the plan's 80/20 cuts — this isn't
  // expected to fire after first mount in practice).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const app = new Application();
    // Captured once at effect-setup time, not re-read as `spritesRef.current` inside cleanup: the
    // ref's underlying Map instance never changes for the life of this component (only its
    // contents do), so this is equivalent to reading it fresh — just without tripping the
    // exhaustive-deps rule meant to catch refs that DO get reassigned out from under a cleanup.
    const sprites = spritesRef.current;

    void app
      .init({
        width,
        height,
        backgroundColor: BACKGROUND_COLOR,
        antialias: true,
        resolution: typeof window === "undefined" ? 1 : (window.devicePixelRatio || 1),
        autoDensity: true,
      })
      .then(() => {
        // A fast unmount (React 18 StrictMode double-invoke in dev, or a real route change) can land
        // here after cleanup already ran — bail rather than attaching a canvas nobody will remove.
        if (cancelled) {
          app.destroy(true, true);
          return;
        }

        host.appendChild(app.canvas);
        appRef.current = app;

        const scene = createArenaScene(width, height);
        sceneRef.current = scene;

        // Added first so it sits under everything — a static, never-updated floor (see
        // arena/backdrop.ts). `app.destroy(true, true)` in this effect's cleanup takes it down with
        // the rest of the stage, so it needs no ref or teardown of its own.
        const backdrop = createArenaBackdrop(width, height);
        const fightersLayer = new Container();
        fightersLayer.label = "fighters";
        const fxLayer = new Container();
        fxLayer.label = "fx";
        app.stage.addChild(backdrop, fightersLayer, fxLayer);

        // Build the initial sprites HERE, synchronously, rather than waiting for the separate
        // lineup effect below (keyed on `appReady`/`lineupKey`) to do it on its own next run. Found
        // by direct browser verification, not by inspection: `loop.start()` used to run before that
        // effect had ever fired, which opens a real window — however many ms until React flushes and
        // runs effects — during which the rAF loop is already ticking (and may already be due to
        // fire impactFx for the fight's very first HitEvent) while `spritesRef` is still empty.
        // `impactFx.ts`'s defensive `if (!defender) return` means that's "only" a silently dropped
        // flash/floater for whichever early hit lands in the gap, never a state-correctness bug
        // (HP/banked bookkeeping in gameLoop.ts's `advanceShadow` call isn't gated on sprites
        // existing) — but a dropped hit's FX is still a real, avoidable bug for a demo whose whole
        // point is visibly syncing FX to real events. The lineup effect still runs after this (once
        // `appReady` flips below) and will harmlessly rebuild these same sprites if `fighters` hasn't
        // changed in the meantime — a redundant destroy+recreate of a handful of Graphics objects,
        // not worth special-casing away.
        for (const fighter of propsRef.current.fighters) {
          const sprite = createFighterSprite(fighter.id, fighter.side, fighter.wallet);
          spritesRef.current.set(fighter.id, sprite);
          fightersLayer.addChild(sprite.root);
        }

        const fx = createImpactFxController({
          fxLayer,
          getSprite: (id) => spritesRef.current.get(id),
          getParticlesContainer: () => particlesContainerRef.current,
        });
        fxControllerRef.current = fx;

        const loop = createGameLoop(
          {
            scene,
            getSprite: (id) => spritesRef.current.get(id),
            fx,
          },
          propsRef,
        );
        gameLoopRef.current = loop;
        loop.start();

        // The lineup effect below (keyed on `appReady`/`lineupKey`) is what keeps sprites in sync
        // with LATER fighter-list changes — flip `appReady` so it's able to run at all.
        setAppReady(true);
      });

    return () => {
      cancelled = true;
      gameLoopRef.current?.stop();
      gameLoopRef.current = null;
      fxControllerRef.current?.clear();
      fxControllerRef.current = null;
      for (const sprite of sprites.values()) sprite.root.destroy({ children: true });
      sprites.clear();
      if (sceneRef.current) {
        destroyArenaScene(sceneRef.current);
        sceneRef.current = null;
      }
      if (appRef.current) {
        appRef.current.destroy(true, true);
        appRef.current = null;
      }
      setAppReady(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
  }, [width, height]);

  // Fighter lineup key: id+wallet+side is what determines WHICH sprites exist and how they're drawn
  // (stake/dead/hp are per-frame concerns, handled by gameLoop.ts's own sync step, not sprite
  // creation) — deliberately narrower than gameLoop.ts's `fightSignature` (which also tracks stake,
  // since that determines the shadow-fight replay's starting hp). Two different concerns, two
  // different keys.
  const lineupKey = useMemo(
    () => props.fighters.map((f) => `${f.id}:${f.wallet}:${f.side}`).join(","),
    [props.fighters],
  );

  useEffect(() => {
    const app = appRef.current;
    if (!appReady || !app) return;
    const fightersLayer = app.stage.getChildByLabel("fighters");
    if (!fightersLayer) return;

    for (const sprite of spritesRef.current.values()) sprite.root.destroy({ children: true });
    spritesRef.current.clear();

    for (const fighter of props.fighters) {
      const sprite = createFighterSprite(fighter.id, fighter.side, fighter.wallet);
      spritesRef.current.set(fighter.id, sprite);
      fightersLayer.addChild(sprite.root);
    }

    // Matter body (re)spawning is NOT done here on purpose — `gameLoop.ts`'s own `fightSignature`
    // check (fired from inside the rAF loop, at most one frame later) already owns that lifecycle
    // correctly: it removes the previous bodies from the Matter world before adding new ones.
    // Clearing `scene.bodies` from this effect too would race it — `spawnFighterBodies` would find
    // nothing to remove and leak the old bodies into the world as invisible, still-colliding ghosts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appReady, lineupKey]);

  const handleParticlesLoaded = (container?: ParticlesContainer) => {
    particlesContainerRef.current = container ?? null;
  };

  return (
    <div style={{ position: "relative", width, height }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} aria-label="arena-canvas" />
      <ParticlesProvider init={initParticlesEngine}>
        <Particles
          id="er-demo-impact-particles"
          options={PARTICLE_OPTIONS}
          particlesLoaded={handleParticlesLoaded}
          style={{ position: "absolute", inset: "0", pointerEvents: "none" }}
        />
      </ParticlesProvider>
    </div>
  );
}
