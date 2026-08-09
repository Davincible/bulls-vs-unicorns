# Bubble Auto-Battler — Technical Spec

**Stack:** PixiJS · Matter.js · pixi-filters · gooey-react / metaballs-js · tsParticles
**Style:** colorful, punchy, arcade
**Target:** weekend build, extensible into a full auto-battler later

---

## 1. Architecture overview

Two decoupled layers, synced by one game loop:

```
┌─────────────────────────────────────────────┐
│                 React shell                  │
│  (menus, HP bars, battle log, draft screen)  │
│                                               │
│   ┌───────────────────────────────────────┐ │
│   │         PixiJS <Stage> canvas          │ │
│   │  ┌─────────────┐  ┌─────────────────┐  │ │
│   │  │ Matter.js    │→│ Pixi Sprites /   │  │ │
│   │  │ physics world│  │ Graphics (bubbles│  │ │
│   │  └─────────────┘  └─────────────────┘  │ │
│   │      ↑ positions each tick              │ │
│   │  filters: Glow / AdvancedBloom          │ │
│   │  overlay: gooey SVG merge layer          │ │
│   │  overlay: tsParticles pop bursts         │ │
│   └───────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Key principle: **Matter.js owns physics truth, Pixi only renders it.** Never let Pixi mutate positions directly — always read from Matter bodies each frame. This keeps collisions, merging, and knockback consistent regardless of frame rate.

---

## 2. Dependencies

```bash
npm install pixi.js @pixi/react matter-js pixi-filters \
  @tsparticles/react @tsparticles/slim gooey-react
```

| Package                                    | Version target            | Role                                                 |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------- |
| `pixi.js`                                  | ^8.x                      | WebGL renderer                                       |
| `@pixi/react`                              | ^7.x (Pixi v8 compatible) | Declarative JSX wrapper around Pixi                  |
| `matter-js`                                | ^0.20.x                   | 2D physics: bodies, collisions, restitution          |
| `pixi-filters`                             | ^6.x                      | `GlowFilter`, `AdvancedBloomFilter`, `OutlineFilter` |
| `gooey-react`                              | ^1.x                      | SVG metaball merge effect (cheap, CPU-light)         |
| `@tsparticles/react` + `@tsparticles/slim` | ^3.x                      | Pop-burst particles on bubble death/collision        |

Optional swap: if `gooey-react`'s SVG filter approach looks too soft or has Safari issues, drop in **metaballs-js** (WebGL shader-based) instead — same visual goal, GPU-rendered, scales better past ~30 bubbles.

---

## 3. Project structure

```
src/
  game/
    engine/
      PhysicsWorld.ts       # Matter.js engine + world setup
      GameLoop.ts           # requestAnimationFrame tick, syncs physics → render state
      collisions.ts         # Matter collision event handlers (damage, merge triggers)
    entities/
      Bubble.ts             # data model: id, stats, Matter body ref
      BubbleFactory.ts       # spawns a Bubble (body + visual + stats) from a unit definition
    render/
      BubbleSprite.tsx       # Pixi Graphics/Sprite for one bubble, reads position from body
      GlowLayer.tsx          # applies pixi-filters to the bubble container
      GooeyOverlay.tsx        # SVG gooey-react layer positioned over the canvas
      PopBurst.tsx            # tsParticles instance triggered on bubble pop
    state/
      battleStore.ts          # zustand/jotai store: bubble stats, HP, battle phase
  ui/
    HPBar.tsx
    BattleHUD.tsx
  App.tsx
```

---

## 4. Physics layer (Matter.js)

### 4.1 World setup

```ts
// engine/PhysicsWorld.ts
import Matter from "matter-js";

export const engine = Matter.Engine.create({
  gravity: { x: 0, y: 0 }, // top-down arena, no gravity
});

export const world = engine.world;

// Arena walls (invisible static bodies) keep bubbles inside the battle circle/rect
export function createArenaBounds(width: number, height: number) {
  const thickness = 50;
  const walls = [
    Matter.Bodies.rectangle(width / 2, -thickness / 2, width, thickness, {
      isStatic: true,
    }),
    Matter.Bodies.rectangle(
      width / 2,
      height + thickness / 2,
      width,
      thickness,
      { isStatic: true },
    ),
    Matter.Bodies.rectangle(-thickness / 2, height / 2, thickness, height, {
      isStatic: true,
    }),
    Matter.Bodies.rectangle(
      width + thickness / 2,
      height / 2,
      thickness,
      height,
      { isStatic: true },
    ),
  ];
  Matter.World.add(world, walls);
}
```

### 4.2 Bubble bodies

```ts
// entities/BubbleFactory.ts
Matter.Bodies.circle(x, y, radius, {
  restitution: 0.9, // bounciness — tune per "arcade" feel, 0.85–0.95 range
  friction: 0.001, // near-frictionless, bubbles glide
  frictionAir: 0.002, // slight drag so they settle, not perpetual bounce
  density: 0.001,
  label: `bubble:${unitId}`, // used in collision matching
});
```

Give each faction/team a `collisionFilter.group` so same-team bubbles can optionally pass through each other (negative group = never collide) while enemy bubbles always collide — useful for auto-battler pathing so allies don't clump-jam.

### 4.3 Combat via collisions

```ts
// engine/collisions.ts
Matter.Events.on(engine, "collisionStart", (event) => {
  for (const { bodyA, bodyB } of event.pairs) {
    const a = getBubbleFromBody(bodyA);
    const b = getBubbleFromBody(bodyB);
    if (!a || !b || a.team === b.team) continue;

    applyDamage(a, b.attack);
    applyDamage(b, a.attack);
    triggerHitEffect(bodyA.position); // → drives glow flash + small particle puff
  }
});
```

Keep damage/stat resolution in the state store (`battleStore.ts`), not in the physics callback itself — the callback should only _dispatch_ events. This keeps physics and game rules decoupled, which matters once you add abilities, status effects, or crits.

---

## 5. Render layer (PixiJS)

### 5.1 Canvas setup with @pixi/react

```tsx
// App.tsx
import { Application, extend } from "@pixi/react";
import { Container, Graphics } from "pixi.js";

extend({ Container, Graphics });

<Application width={960} height={640} backgroundAlpha={0}>
  <BubbleLayer />
</Application>;
```

### 5.2 Bubble visual — layered for "character"

Each bubble is not a single sprite but a small stack, bottom to top:

1. **Base circle** (`Graphics`, radial gradient fill via a generated texture — flat Pixi fills look dull, always fake a gradient)
2. **Rim highlight** — thin arc, lighter tint, offset toward top-left (fake light source)
3. **Specular dot** — small white circle, ~15% opacity, gives the "wet glass" look
4. **Team-color glow** — driven by `GlowFilter`

```ts
// render/GlowLayer.tsx
import { GlowFilter } from "pixi-filters";

const glow = new GlowFilter({
  distance: 15,
  outerStrength: 2,
  innerStrength: 0.5,
  color: teamColor,
  quality: 0.3, // keep low — this is the single biggest perf cost with many bubbles
});
bubbleContainer.filters = [glow];
```

Apply `AdvancedBloomFilter` once, globally, on the whole battle container rather than per-bubble — far cheaper, and gives a nicer unified "arcade glow" look across the scene.

### 5.3 Sync loop

```ts
// engine/GameLoop.ts
function tick() {
  Matter.Engine.update(engine, 1000 / 60);

  for (const bubble of bubbles) {
    bubble.sprite.x = bubble.body.position.x;
    bubble.sprite.y = bubble.body.position.y;
    bubble.sprite.rotation = bubble.body.angle;
  }

  requestAnimationFrame(tick);
}
```

Run this outside React's render cycle (a plain `requestAnimationFrame` loop, not `useEffect` re-renders per frame) — mutate Pixi display objects imperatively for position updates, and only touch React state for things that actually need re-renders (HP numbers, death, phase changes).

---

## 6. The "merging" effect (gooey-react)

This is what turns "circles bouncing" into "bubbles" — the visual pull-and-release when two bubbles get close.

```tsx
// render/GooeyOverlay.tsx
import { Goo } from "gooey-react";

<Goo intensity={8}>
  <svg
    width={960}
    height={640}
    style={{ position: "absolute", pointerEvents: "none" }}
  >
    {bubbles.map((b) => (
      <circle key={b.id} cx={b.x} cy={b.y} r={b.radius} fill={b.teamColor} />
    ))}
  </svg>
</Goo>;
```

Practical notes:

- This SVG layer sits **on top of** the Pixi canvas as a separate absolutely-positioned overlay, not inside Pixi itself — `gooey-react` is a DOM/SVG filter technique, it doesn't render inside WebGL.
- Keep this layer's circle count low-fidelity (flat team color, no gradient) — it's a _silhouette_ effect underneath the real detailed Pixi bubbles, not the final visual. Render actual bubble detail (highlights, glow) in Pixi on top; use gooey purely for the merge silhouette bleeding through at the edges.
- `intensity` controls how far apart bubbles start blending — tune against your actual bubble radius and typical spacing in a real battle, not in isolation.
- If profiling shows this SVG filter chugging on Safari or on >25 simultaneous bubbles, swap to **metaballs-js**, which does the same job on the GPU via a canvas/WebGL shader instead of SVG `feGaussianBlur` + `feColorMatrix`.

---

## 7. Pop / death effects (tsParticles)

```tsx
// render/PopBurst.tsx
import { useEffect } from "react";
import Particles, { initParticlesEngine } from "@tsparticles/react";
import { loadSlim } from "@tsparticles/slim";

useEffect(() => {
  initParticlesEngine(async (engine) => {
    await loadSlim(engine);
  });
}, []);

// Trigger a one-shot burst at (x, y) when a bubble is destroyed
<Particles
  id={`pop-${bubbleId}`}
  options={{
    particles: {
      number: { value: 12 },
      color: { value: teamColor },
      shape: { type: "circle" },
      opacity: {
        value: 0.8,
        animation: {
          enable: true,
          speed: 2,
          startValue: "max",
          destroy: "min",
        },
      },
      size: { value: { min: 2, max: 6 } },
      move: {
        enable: true,
        speed: 6,
        decay: 0.1,
        direction: "none",
        outModes: "destroy",
      },
    },
    emitters: {
      position: { x: bubbleX, y: bubbleY },
      rate: { quantity: 12, delay: 0 },
      life: { count: 1 },
    },
  }}
/>;
```

Mount a fresh short-lived `<Particles>` instance per pop rather than one persistent global instance you keep re-triggering — simpler lifecycle, and tsParticles cleans itself up via `life: { count: 1 }`. For high pop-frequency battles, pool a small number of reusable instances instead of mounting/unmounting rapidly, since instance init has overhead.

---

## 8. Performance budget (arcade-style, not photorealistic)

| Concern              | Guidance                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Bubble count         | Comfortable up to ~40–60 on mid-range hardware with this stack                                          |
| `GlowFilter` quality | Keep at 0.2–0.4; higher tanks fps fast with multiple filtered objects                                   |
| Gooey/metaball layer | Biggest single cost — profile first, this is the first thing to downgrade or disable on low-end devices |
| Particle bursts      | Cap concurrent burst instances (e.g. max 5 alive at once); queue overflow pops                          |
| Physics substeps     | 60Hz fixed step is enough; don't increase Matter's iterations unless you see tunneling at high speed    |

Detect low-end devices (or just expose a settings toggle) and drop the gooey overlay + reduce glow quality first — those are the two effects that add the most visual character but also cost the most, so they're your first lever for scaling down gracefully.

---

## 9. Suggested build order (weekend plan)

1. **Day 1 AM** — Matter.js world + plain circle bubbles bouncing in an arena, no Pixi yet (debug render via Matter's own renderer)
2. **Day 1 PM** — Swap in Pixi rendering synced to Matter bodies; add gradient + rim highlight visual
3. **Day 1 evening** — Add `GlowFilter` per team color + global `AdvancedBloomFilter`
4. **Day 2 AM** — Layer in gooey-react merge overlay, tune intensity against real bubble spacing
5. **Day 2 PM** — Wire collision → damage → tsParticles pop burst on death
6. **Day 2 evening** — HP bars, basic HUD, polish pass (screen shake on big hits, tune colors)

---

## 10. Open decisions to make before starting

- **Team differentiation**: color only, or also shape/pattern/size variance per unit type?
- **Arena shape**: rectangle (simplest for Matter walls) vs circular arena (needs a ring of static segment bodies)
- **Merge effect scope**: only same-team bubbles gooey-merge (reinforces "team blob" feel), or all bubbles merge visually regardless of team (more chaotic, more "lava lamp")?
