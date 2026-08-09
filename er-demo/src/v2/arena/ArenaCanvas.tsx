// The arena. A plain 2D canvas on white paper — the one colourful element on the page.
//
// WHY 2D AND NOT PIXI (which this repo already depends on, and `render/PixiCanvas.tsx` already
// uses): the visual language here is flat vector on white — filled circles, hairlines, mono labels.
// There is no texture, no blend mode, no filter and no particle system in the design, so WebGL is
// buying a shader pipeline, a texture atlas and an async `Application.init()` to draw sixteen
// `arc()` calls. The existing pixi path is also a dark-theme dead end for this page: its colours,
// its GlowFilter and its additive flashes all assume ink-on-black. Reusing its ARCHITECTURE (the
// out-of-React loop, the shadow-fight replay, retarget steering) is worth everything; reusing its
// renderer would mean fighting it on every draw call.
//
// This component is deliberately thin. It owns exactly four things — the element, its size, the
// pointer, and the loop's lifetime — and hands everything else to the modules beside it:
//
//   field.ts      circles, radii, drift/seek/bounce
//   replay.ts     the playhead and the shadow copy of hp/banked/dead
//   targeting.ts  who is moving toward whom
//   impact.ts     what a hit looks like
//   draw.ts       every mark that reaches the canvas
//   arenaLoop.ts  the rAF loop that sequences all of the above
//
// STATE NEVER CROSSES INTO REACT. `props` are mirrored into a mutable box that the loop reads each
// frame; not one `setState` fires per frame, and re-rendering this component never restarts the
// loop or reallocates the world.

import { useEffect, useRef } from "react";
import { subscribePaper } from "../styles/paper.ts";
import { createArenaLoop, type ArenaLoop } from "./arenaLoop.ts";
import type { ArenaCanvasProps, PointerState } from "./types.ts";
import "./ArenaCanvas.css";

export type { ArenaCanvasProps } from "./types.ts";

export function ArenaCanvas(props: ArenaCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loopRef = useRef<ArenaLoop | null>(null);

  // The "latest props" box. Written during render rather than in an effect so the very first frame
  // after a prop change already sees the new value — an effect would leave the loop one frame
  // behind, which for `fightStartedAtMs` flipping to non-null is one frame of a fight that has
  // started but isn't playing. Writing a ref during render is safe precisely because nothing
  // reads it during render: React never re-renders on it, and the loop is not part of the tree.
  const propsRef = useRef<ArenaCanvasProps>(props);
  propsRef.current = props;

  const pointerRef = useRef<PointerState>({ x: 0, y: 0, inside: false });
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    // Read live rather than once: someone toggling "reduce motion" in system settings mid-session
    // should see the field settle on the next frame, not on the next reload.
    const motionQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reducedMotionRef.current = motionQuery?.matches ?? false;
    const onMotionChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
    };
    motionQuery?.addEventListener("change", onMotionChange);

    const loop = createArenaLoop({
      canvas,
      props: propsRef,
      pointer: pointerRef,
      reducedMotion: reducedMotionRef,
    });
    loopRef.current = loop;

    // Observing the PARENT, not the canvas: the canvas is sized from the observation, so observing
    // it would be a feedback loop — resize the element, the observer fires, resize it again.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) loop.resize(box.width, box.height);
    });
    observer.observe(parent);

    // The third thing outside React that the field has to follow, alongside the parent's size and the
    // motion preference: the colour of the sheet. `styles/paper.ts` writes the tokens onto `:root`
    // and then calls back, and the loop re-reads them off this element's computed style — so the
    // field retints on the next frame without the component re-rendering, the world being rebuilt, or
    // a fight in progress losing its playhead. Subscribed rather than remounted on a `key` for exactly
    // that last reason: a remount would restart the fight to change a colour.
    const unsubscribePaper = subscribePaper(() => loop.retint());

    const initial = parent.getBoundingClientRect();
    loop.resize(initial.width, initial.height);
    loop.start();

    return () => {
      observer.disconnect();
      unsubscribePaper();
      motionQuery?.removeEventListener("change", onMotionChange);
      loop.stop();
      loopRef.current = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="arena-canvas"
      // The canvas is one opaque object to assistive tech, and a field of circles is not something
      // a screen reader should be asked to navigate. It carries a summary label that the loop keeps
      // current (fighters in play, per-side totals); the accessible path to the SAME data, per
      // fighter and keyboard-operable, is the shell's roster tables — which is where a reader should
      // be sent, rather than being handed sixteen focusable canvas hotspots that duplicate them.
      role="img"
      aria-label="Arena field"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        pointerRef.current.x = e.clientX - rect.left;
        pointerRef.current.y = e.clientY - rect.top;
        pointerRef.current.inside = true;
      }}
      onPointerLeave={() => {
        pointerRef.current.inside = false;
      }}
      onPointerDown={(e) => {
        // Selection on pointer-down, and only when a fighter is actually under it: clicking bare
        // field is not a request to deselect (`onSelect` takes an id, and inventing a "deselect"
        // channel the contract doesn't have would be this component deciding the shell's policy).
        const rect = e.currentTarget.getBoundingClientRect();
        const id = loopRef.current?.pick(e.clientX - rect.left, e.clientY - rect.top);
        if (id !== null && id !== undefined) props.onSelect?.(id);
      }}
    />
  );
}
