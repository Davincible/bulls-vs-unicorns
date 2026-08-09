// THE SHELL'S OWN TEXT, ON THIS CANVAS.
//
// ink.ts's premise is that everything putting words on the field asks the map first. Three canvas
// painters do. A fourth writer does not, and cannot: the shell's HUD overlays (`.ovl` in
// ArenaView.css) are DOM, positioned over the frame's corners, and in the `blank` board style — the
// DEFAULT board style — they are stripped to bare transparent text sitting directly on the paper
// (`.frame--blank .ovl { background: transparent; border-color: transparent; }`).
//
// Screenshotted at 390x844 with sixteen fighters: `FIGHT 0:20 640/4,000` printed straight through
// `ROUNDS WON · 16 SETTLED`. That is exactly the failure ink.ts was written to eliminate, arriving
// from the one direction it could not see — and it is a phone-only failure because the record
// caption is ~160px of a ~360px field there, so it reaches into the top-left corner that a 1,390px
// desktop field leaves it a clear 350px away from.
//
// The canvas cannot make the DOM ask. So it asks the DOM: once a frame it reads the overlays' boxes
// and claims them into the map on their behalf, FIRST — before the watermark, which is the only
// canvas text that could otherwise claim a corner. From there the existing priority order does the
// rest with no further changes: the record band steps clear of them, the labels route around them,
// and a damage figure refuses to be born under one.
//
// MEASURED, NOT DECLARED, and this is the part worth defending. A constant here would have to
// encode the overlays' padding, their border, how many lines each of them is currently rendering,
// the 700px breakpoint that moves one of them from the top corner to the bottom, and the width of
// strings that change while you watch (`0:20` → `10:20`, `640/4,000` → `4,000/4,000`, a position
// HUD that becomes `You are not in this round`). Every one of those lives in ArenaView.tsx or
// ArenaView.css and every one of them would drift. field.ts's LABEL_SPACE is the cautionary tale
// already in this directory: one hardcoded number for "the shell chrome's own height", wrong by
// enough that a fighter's value line ended up under the bottom nav.
//
// WHAT IT DOES NOT CLAIM. The centred `.result` plate (settled/lobby) is opaque in BOTH board
// styles, so canvas text under it is hidden rather than garbled, and claiming its ~40% of a phone
// field would evict most of the labels on a frame where nothing is wrong. Occlusion is not the
// failure this module exists for; overprinting is.
//
// AND WHAT IT CANNOT FIX: discs still drift under these boxes, and in `blank` a coin's face behind
// `You · ANSEM` is unreadable HUD text. That is a paper-casing problem on the shell's side of the
// frame, not something the canvas can solve without either evicting the fight from a tenth of a
// phone field or painting a filled panel, which base.css forbids.

import type { InkMap } from "./ink.ts";

/** The shell's overlay boxes over this frame. `.ovl` is ArenaView.css's own class; if the canvas is
 *  mounted anywhere that does not use that markup, there is simply no chrome and nothing is
 *  claimed — the arena degrades to what it did before this file existed. */
const FRAME_SELECTOR = ".frame";
const OVERLAY_CLASS = "ovl";

export interface ChromeMap {
  /** Read the overlays where they are RIGHT NOW and claim them. Called once per paint, before any
   *  canvas painter claims anything. */
  claim(ink: InkMap): void;
}

export function createChromeMap(canvas: HTMLCanvasElement): ChromeMap {
  const frame = canvas.closest(FRAME_SELECTOR);
  // A LIVE HTMLCollection, taken once. Overlays mount and unmount with the phase and with whether
  // you are in the round, and one of them is `display: none` below 700px — a live collection tracks
  // all of that for free and allocates nothing per frame, which a `querySelectorAll` re-run sixty
  // times a second would not.
  const overlays = frame?.getElementsByClassName(OVERLAY_CLASS) ?? null;

  return {
    claim(ink) {
      if (!overlays || overlays.length === 0) return;
      // One rect per overlay plus one for the canvas, at the top of the paint. Layout is still clean
      // from the browser's own last pass, so none of these force one: the only DOM the loop touches
      // is `canvas.style.cursor` and the aria-label, and neither `cursor` nor `aria-label` is a
      // property layout depends on. A reflow here would be a real cost — it is worth checking that
      // it stays true if anything in this loop ever starts writing geometry.
      const base = canvas.getBoundingClientRect();
      if (base.width <= 0) return;
      for (let i = 0; i < overlays.length; i++) {
        const box = overlays[i].getBoundingClientRect();
        // `display: none` at this breakpoint, or a node React has already detached: both measure
        // 0x0, and a zero box claimed at the origin would reserve the top-left corner of the field
        // for nothing.
        if (box.width <= 0 || box.height <= 0) continue;
        // Both rects are CSS pixels and the painter draws in CSS pixels (arenaLoop owns the DPR
        // transform), so this is a translation and nothing more. The overlays sit at `-1px` against
        // the frame's border, so the boxes reach a pixel outside the field on two sides; the ink map
        // is rectangle arithmetic with no bounds of its own and does not care.
        ink.claim(
          box.left - base.left,
          box.top - base.top,
          box.right - base.left,
          box.bottom - base.top,
        );
      }
    },
  };
}
