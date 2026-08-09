// The requestAnimationFrame loop — deliberately OUTSIDE React.
//
// React mounts this once and hands it a plain mutable box (`{ current: ArenaCanvasProps }`) that it
// keeps up to date on every render. The loop reads `props.current` fresh each frame rather than
// closing over a snapshot, so a new poll result or a phase change takes effect on the very next
// frame without restarting the loop, re-subscribing anything, or re-creating a single closure.
// `render/gameLoop.ts` is built the same way and its header says why; the short version is that a
// canvas repainting 60 times a second must never be a function of React's render cycle, and
// `setState` per frame is the one way to guarantee it is.
//
// Per-frame order, and every step of it matters:
//
//   1. rebuild the field if the LINEUP changed (someone deployed; a new round)
//   2. re-derive the replay if the EVENT STREAM changed (an extract() forced a recompute)
//   3. advance the playhead to wall-clock, firing impact FX for each newly-crossed hit
//   4. overlay extractions — the one thing the event stream cannot express
//   5. pull hp/banked/dead onto the bodies; radii follow
//   6. pick targets from the events just ahead of the playhead, then move, collide, bounce
//   7. paint
//
// Steps 3-5 are the fight. Step 6 is decoration and knows it: `run_fight()` picks its pairs by
// `hash(seed, step) % n`, so nothing about a position, a collision or a frame rate can change a
// single number on this page.

import { SIDE_TOKEN, counted, sideTotals, usd } from "../contract.ts";
import { createImpactController } from "./impact.ts";
import { createChromeMap } from "./chrome.ts";
import { createInkMap } from "./ink.ts";
import { drawBodies, drawEmpty, drawLattice, drawReadout } from "./draw.ts";
import { drawScoreboard } from "./scoreboard.ts";
import { primeFaces } from "./faces.ts";
import {
  bodyAt,
  createField,
  motionModeFor,
  recoil,
  resizeField,
  stepField,
  syncBodies,
  type ArenaField,
} from "./field.ts";
import { readPalette, type ArenaPalette } from "./palette.ts";
import { advanceReplay, createReplay, applyExtractions, playheadStep, resetReplay, type ReplayState } from "./replay.ts";
import { createTargetTracker } from "./targeting.ts";
import type { ArenaCanvasProps, PointerState } from "./types.ts";

/** Retina without paying for a 3x buffer on phones that report it — `web/index.html`'s own cap, and
 *  the point past which nobody can tell. */
const MAX_DPR = 2;
/** The canvas is one opaque blob to assistive tech, so it carries a summary label. Rebuilt at most
 *  this often: it is a description, not a live region, and recomputing it 60x/second to set an
 *  identical string is pure waste. */
const LABEL_INTERVAL_MS = 1000;

export interface ArenaLoop {
  start(): void;
  stop(): void;
  /** CSS pixels; the loop owns the backing-store size and the DPR transform. */
  resize(cssWidth: number, cssHeight: number): void;
  /** Which fighter is at this point, for the click handler. `null` for empty field. */
  pick(x: number, y: number): number | null;
  /** Re-read base.css's tokens off the canvas's computed style.
   *
   *  The palette is resolved at mount and at `start()` and then held, because for the page's whole
   *  life it never changed — a `getComputedStyle` per frame is a forced style recalculation sixty
   *  times a second to fetch ten strings that are always the same. `styles/paper.ts` made the sheet a
   *  variable, so there is now exactly one moment when it does change, and this is the hook for it.
   *  Deliberately a push from the thing that changed the tokens rather than the loop watching for it:
   *  the caller knows precisely when, and the loop should not be paying to find out. */
  retint(): void;
}

export interface ArenaLoopDeps {
  canvas: HTMLCanvasElement;
  props: { current: ArenaCanvasProps };
  pointer: { current: PointerState };
  /** `prefers-reduced-motion`, live — read every frame so a mid-session change takes effect at once. */
  reducedMotion: { current: boolean };
}

/** A new fight, or a changed cast: rebuild the field and start the replay over. Includes
 *  `fightStartedAtMs` because the same cast in a new fight is still a new fight. Deliberately
 *  EXCLUDES hp/banked/dead — those change on every poll, and reinitialising on them would rebuild
 *  the world several times a second. */
function lineupSignature(props: ArenaCanvasProps): string {
  const cast = props.fighters.map((f) => `${f.id}:${f.wallet}:${f.stake}`).join(",");
  return `${props.fightStartedAtMs ?? "pending"}|${cast}`;
}

/** Identifies the event stream by its CONTENT, not by array identity.
 *
 *  Array identity is the obvious choice and it is wrong here: a data layer that rebuilds
 *  `hitEvents` on each poll (the fixture provider literally does — `phase === "Lobby" ? [] : …`
 *  allocates a fresh array every render) would trip a full replay reset several times a second, and
 *  a reset drops the impact FX in flight. Length plus the first and last event pins the stream
 *  tightly enough: an `extract()` recompute changes the tail, which changes this, which is exactly
 *  when a reset IS wanted. */
function streamSignature(events: { step: bigint; amount: bigint }[]): string {
  if (events.length === 0) return "0";
  const first = events[0];
  const last = events[events.length - 1];
  return `${events.length}|${first.step}:${first.amount}|${last.step}:${last.amount}`;
}

export function createArenaLoop(deps: ArenaLoopDeps): ArenaLoop {
  const { canvas, props, pointer, reducedMotion } = deps;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("v2/arena: 2D context unavailable");

  let palette: ArenaPalette = readPalette(canvas);
  // Start the fighters' artwork decoding now rather than on the first frame that has a body to draw
  // it on: the wait then happens in an empty lobby, where nothing pops, instead of under the first
  // player to deploy. Same-origin assets out of `public/`; see faces.ts.
  primeFaces();
  const impact = createImpactController();
  const tracker = createTargetTracker();
  // One map of where the frame's text is, shared by the four things that put text on the field —
  // see ink.ts. Owned here because it is a property of the FRAME rather than of any one painter, and
  // because the order it is filled in is the priority order between them. The fourth is the shell's
  // own HUD, which is DOM and cannot ask for itself; `chrome` measures it and claims on its behalf.
  const ink = createInkMap();
  const chrome = createChromeMap(canvas);

  let field: ArenaField | null = null;
  let replay: ReplayState | null = null;
  let lineupKey = "";
  let streamKey = "";

  let cssWidth = 0;
  let cssHeight = 0;
  let rafHandle = 0;
  let lastFrameMs = 0;
  let hoverId: number | null = null;
  let cursorStyle = "";
  let labelAtMs = 0;
  let labelText = "";

  function ensureWorld(p: ArenaCanvasProps, playhead: number): { field: ArenaField; replay: ReplayState } {
    const nextLineup = lineupSignature(p);
    if (!field || !replay || nextLineup !== lineupKey) {
      field = createField(p.fighters, cssWidth, cssHeight, field);
      replay = createReplay(p.fighters);
      lineupKey = nextLineup;
      streamKey = "";
      // A new cast means any shockwave still expanding belongs to a fight that no longer exists.
      impact.clear();
    }

    const nextStream = streamSignature(p.hitEvents);
    if (nextStream !== streamKey) {
      streamKey = nextStream;
      // SILENT. These hits already happened — a mount into a fight in progress, or a stream
      // recomputed around an extraction. Firing them would dump the whole fight onto the field in
      // one frame. In-flight FX is left alone on purpose: the events up to the playhead are by
      // construction the same ones, so this is a continuation, not a restart.
      resetReplay(replay, p.fighters, p.hitEvents, playhead);
    }

    return { field, replay };
  }

  /** `totals` is the frame's own per-side worth, computed once by `frame()` and handed to both
   *  consumers — this label and the background scoreboard. It used to be summed here, in a loop that
   *  ran at most once a second; the scoreboard needs the same two numbers on every frame, and two
   *  sums of the same bodies is the shortest possible route to a counter that disagrees with the
   *  label describing it. */
  function updateLabel(
    p: ArenaCanvasProps,
    f: ArenaField,
    totals: readonly [bigint, bigint],
    nowMs: number,
  ): void {
    if (nowMs - labelAtMs < LABEL_INTERVAL_MS) return;
    labelAtMs = nowMs;
    let alive = 0;
    for (const body of f.bodies) if (!body.dead) alive++;
    const next =
      f.bodies.length === 0
        ? `Arena field, ${p.phase}. No fighters.`
        : `Arena field, ${p.phase}. ${alive} of ${counted(f.bodies.length, "fighter")} in play. ` +
          `${SIDE_TOKEN[0].name} ${usd(totals[0])}, ${SIDE_TOKEN[1].name} ${usd(totals[1])}.`;
    if (next === labelText) return;
    labelText = next;
    canvas.setAttribute("aria-label", next);
  }

  function frame(rafMs: number): void {
    rafHandle = requestAnimationFrame(frame);
    const p = props.current;
    if (cssWidth <= 0 || cssHeight <= 0) return;

    // `rafMs` is relative to `performance.timeOrigin` — the page's navigation start — while
    // `fightStartedAtMs` is a Unix epoch value. Comparing them directly yields a permanently
    // negative (clamped-to-0) playhead and a fight that never starts. gameLoop.ts found that in a
    // browser, not by reading the code; the conversion is cheap and the bug is silent.
    const nowEpochMs = performance.timeOrigin + rafMs;
    const playhead = playheadStep(p.fightStartedAtMs, p.fighters.length, nowEpochMs);
    const { field: f, replay: r } = ensureWorld(p, playhead);

    const still = reducedMotion.current;
    // A connector longer than this is a streak across the whole field, not a statement about who
    // hit whom — the pairs are hash-picked, so plenty of them are simply nowhere near each other and
    // no amount of steering will fix that. Above the cap the ring and the figure still fire; only
    // the line is dropped.
    const maxLineDist = Math.hypot(cssWidth, cssHeight) * 0.22;
    advanceReplay(r, p.hitEvents, playhead, (event) => {
      if (still) return; // reduced motion: the hit still lands, it just doesn't announce itself
      recoil(f, event.attackerId, event.defenderId);
      impact.fire({
        nowMs: rafMs,
        amount: event.amount,
        attacker: f.byId[event.attackerId],
        defender: f.byId[event.defenderId],
        maxLineDist,
        fieldW: cssWidth,
        // The PREVIOUS frame's text — this runs several steps before the paint that fills the map
        // for this one. `impact.draw` re-checks against the current map every frame, so the staleness
        // costs nothing except an occasional figure that could have been placed and wasn't.
        ink,
      });
    });
    applyExtractions(r, p.fighters);
    syncBodies(f, r.shadow);

    if (!still) {
      const dtMs = lastFrameMs === 0 ? 16.7 : rafMs - lastFrameMs;
      const targets = tracker.assign(
        f.bodies.length,
        p.hitEvents,
        r.cursor,
        rafMs,
        (id) => f.byId[id]?.dead ?? true,
      );
      stepField(f, targets, motionModeFor(p.phase, p.fightStartedAtMs), dtMs, rafMs);
      impact.update(rafMs);
    }
    lastFrameMs = rafMs;

    const hovered = pointer.current.inside ? bodyAt(f, pointer.current.x, pointer.current.y) : null;
    hoverId = hovered ? hovered.id : null;
    // Touch the DOM only on a change: assigning `style.cursor` every frame is a style invalidation
    // 60 times a second for a string that is almost always the same one.
    const nextCursor = hovered ? "pointer" : "crosshair";
    if (nextCursor !== cursorStyle) {
      cursorStyle = nextCursor;
      canvas.style.cursor = nextCursor;
    }

    // ONE read of the per-side worth per frame, off the bodies the replay was just synced onto — so
    // the scoreboard behind the fight and the label describing it are the same two numbers, taken at
    // the same instant, from the same place the discs are sized from (`contract.ts`'s `sideTotals`,
    // which is also what the strength bar above the frame uses).
    const totals = sideTotals(f.bodies);

    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = palette.paper;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    // The lattice is the ONLY thing the board style changes on the canvas; the frame and the overlays
    // are the parent's half of the same word (see `BoardStyle` in contract.ts).
    if (p.board === "survey") drawLattice(ctx, cssWidth, cssHeight, palette);

    // A new frame of text. Reset here, AFTER `impact.fire` has read last frame's map and before the
    // first thing that claims into it — and the first thing that claims into it is the shell's own
    // HUD, which is drawn over this canvas by the DOM and is therefore the one piece of text on the
    // frame that nothing here is free to move. See chrome.ts.
    ink.reset();
    chrome.claim(ink);

    if (f.bodies.length === 0) {
      drawEmpty(ctx, cssWidth, cssHeight, palette, p.phase);
    } else {
      // After the paper and the lattice, before a single fighter: the score is the floor of the
      // arena, and the fighters stand on it. Drawn in BOTH board styles — it is not decoration that
      // the minimal board strips, it is the game.
      //
      // It also claims its rows in `ink` first, because it is the only text here that cannot move:
      // labels are placed relative to a fighter and can take the next band down, figures can take
      // another fan offset or be dropped, and the watermark is nailed to the frame's geometry.
      drawScoreboard(ctx, cssWidth, cssHeight, palette, ink, {
        totals,
        record: p.sideRecord,
        crowd: f.bodies.length,
      });
      drawBodies(ctx, f, palette, { hoverId, selectedId: p.selectedId ?? null }, ink);
      if (!still) impact.draw(ctx, palette, rafMs, ink);
      if (hovered) drawReadout(ctx, hovered, pointer.current.x, pointer.current.y, cssWidth, cssHeight, palette);
    }

    updateLabel(p, f, totals, rafMs);
  }

  return {
    start() {
      if (rafHandle) return; // idempotent — StrictMode mounts effects twice
      palette = readPalette(canvas);
      lastFrameMs = 0;
      rafHandle = requestAnimationFrame(frame);
    },

    stop() {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    },

    resize(w, h) {
      if (w <= 0 || h <= 0) return;
      const dpr = Math.min(globalThis.devicePixelRatio || 1, MAX_DPR);
      cssWidth = w;
      cssHeight = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      // One transform, set once per resize: everything downstream draws in CSS pixels and never has
      // to know the device ratio exists.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (field) resizeField(field, w, h);
    },

    pick(x, y) {
      if (!field) return null;
      const body = bodyAt(field, x, y);
      return body ? body.id : null;
    },

    retint() {
      palette = readPalette(canvas);
    },
  };
}
