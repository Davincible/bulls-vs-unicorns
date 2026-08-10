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
import { createImpactController, hitForce, hitToll, type ShakeOffset } from "./impact.ts";
import { createChromeMap } from "./chrome.ts";
import { createInkMap } from "./ink.ts";
import { drawBodies, drawEmpty, drawLattice, drawReadout } from "./draw.ts";
import { drawScoreboard } from "./scoreboard.ts";
import { primeFaces } from "./faces.ts";
import {
  bodyAt,
  createField,
  flinch,
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

/** A new fight, or a changed cast: rebuild the field and start the replay over. Answers
 *  `fightStartedAtMs` too, because the same cast in a new fight is still a new fight. Deliberately
 *  IGNORES hp/banked/dead — those change on every poll, and reinitialising on them would rebuild the
 *  world several times a second.
 *
 *  IT COMPARES RATHER THAN BUILDING A KEY, and that is the whole point of the shape. This used to be
 *  `fighters.map(f => \`${f.id}:${f.wallet}:${f.stake}\`).join(",")` — one intermediate array and
 *  seventeen short-lived strings, allocated on EVERY FRAME for the life of the page, to detect a
 *  transition that happens about four times a round. Sixty times a second at the program's cap of
 *  sixteen fighters, that is a thousand allocations a second; the same file keeps a single
 *  `ShakeOffset` for the loop's entire life rather than pay sixty a second to carry two numbers, and
 *  these two positions cannot both be right.
 *
 *  So it reads the bodies the field already holds and exits on the first difference. Nothing is
 *  allocated, the common case (no change) is a length check plus ≤16 comparisons of two numbers and
 *  a string reference, and the strings being compared are the same interned wallet values arriving
 *  from the poll — so the comparison is a pointer test in the overwhelming majority of frames. */
function lineupChanged(
  field: ArenaField | null,
  startedAtMs: number | null,
  props: ArenaCanvasProps,
): boolean {
  if (!field) return true;
  if (startedAtMs !== props.fightStartedAtMs) return true;
  const bodies = field.bodies;
  if (bodies.length !== props.fighters.length) return true;
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const f = props.fighters[i];
    if (b.id !== f.id || b.stake !== f.stake || b.wallet !== f.wallet) return true;
  }
  return false;
}

/** The five values that identify an event stream by its CONTENT, not by array identity.
 *
 *  Array identity is the obvious choice and it is wrong here: a data layer that rebuilds
 *  `hitEvents` on each poll (the fixture provider literally does — `phase === "Lobby" ? [] : …`
 *  allocates a fresh array every render) would trip a full replay reset several times a second, and
 *  a reset drops the impact FX in flight. Length plus the first and last event pins the stream
 *  tightly enough: an `extract()` recompute changes the tail, which changes this, which is exactly
 *  when a reset IS wanted.
 *
 *  Held as scalars rather than composed into a key string, for `lineupChanged`'s reason: this runs on
 *  every frame forever and a template literal here is one more throwaway string a frame. */
interface StreamMark {
  length: number;
  firstStep: bigint;
  firstAmount: bigint;
  lastStep: bigint;
  lastAmount: bigint;
}

/** True when `events` is not the stream `mark` describes; updates `mark` in place when it is not.
 *
 *  The same five values the key string carried, compared rather than concatenated — the step AND the
 *  amount at each end, because a recompute can leave a step where it was and change only what
 *  happens at it. `-1n` for an empty stream is a value no real event can hold, so "empty" is a state
 *  rather than a special case. */
function streamChanged(events: { step: bigint; amount: bigint }[], mark: StreamMark): boolean {
  const n = events.length;
  const firstStep = n > 0 ? events[0].step : -1n;
  const firstAmount = n > 0 ? events[0].amount : -1n;
  const lastStep = n > 0 ? events[n - 1].step : -1n;
  const lastAmount = n > 0 ? events[n - 1].amount : -1n;
  if (
    mark.length === n &&
    mark.firstStep === firstStep &&
    mark.firstAmount === firstAmount &&
    mark.lastStep === lastStep &&
    mark.lastAmount === lastAmount
  ) {
    return false;
  }
  mark.length = n;
  mark.firstStep = firstStep;
  mark.firstAmount = firstAmount;
  mark.lastStep = lastStep;
  mark.lastAmount = lastAmount;
  return true;
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
  /** What `fightStartedAtMs` was when the world was last built — half of `lineupChanged`'s test, and
   *  held here rather than derived because the field itself has no notion of a clock. */
  let lineupStartedAtMs: number | null = null;
  /** The stream the replay is currently derived from — see `streamChanged`. `length: -1` cannot match
   *  any real stream, so the first frame always resets, which is what a fresh mount wants. */
  const streamMark: StreamMark = { length: -1, firstStep: -1n, firstAmount: -1n, lastStep: -1n, lastAmount: -1n };

  let cssWidth = 0;
  let cssHeight = 0;
  let rafHandle = 0;
  let lastFrameMs = 0;
  let hoverId: number | null = null;
  let cursorStyle = "";
  let labelAtMs = 0;
  let labelText = "";
  /** Where the camera sits this frame. One object for the life of the loop, written in place by
   *  `impact.shake` — a `{x, y}` returned per frame would be sixty allocations a second to carry two
   *  numbers that are zero on almost all of them. */
  const shake: ShakeOffset = { x: 0, y: 0 };

  function ensureWorld(
    p: ArenaCanvasProps,
    playhead: number,
  ): { field: ArenaField; replay: ReplayState; fresh: boolean } {
    let fresh = false;
    if (!replay || lineupChanged(field, lineupStartedAtMs, p)) {
      field = createField(p.fighters, cssWidth, cssHeight, field);
      replay = createReplay(p.fighters);
      lineupStartedAtMs = p.fightStartedAtMs;
      streamMark.length = -1;
      fresh = true;
      // A new cast means any shockwave still expanding belongs to a fight that no longer exists.
      impact.clear();
    }

    if (streamChanged(p.hitEvents, streamMark)) {
      fresh = true;
      // SILENT. These hits already happened — a mount into a fight in progress, or a stream
      // recomputed around an extraction. Firing them would dump the whole fight onto the field in
      // one frame. In-flight FX is left alone on purpose: the events up to the playhead are by
      // construction the same ones, so this is a continuation, not a restart.
      resetReplay(replay, p.fighters, p.hitEvents, playhead);
    }

    // `fresh` says the shadow state on this frame did not get here by anybody being hit — it was
    // re-derived wholesale. Deaths found on such a frame are HISTORY, not news, and announcing them
    // would detonate every corpse in a fight already in progress on the first frame a viewer sees.
    return { field, replay, fresh };
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
    // HOW FAR THROUGH THE FIGHT WE ARE, on the chain's own axis — see field.ts's `FERVOUR_GAIN`, the
    // one thing `web/index.html` had that made a round build rather than idle at one temperature.
    //
    // Its ramp was `roundT / BATTLE_MS`, a share of the round's own length. The exact analogue here is
    // the playhead's share of the LAST EVENT'S STEP, because that is where THIS fight stops — not
    // where the program's cap would. Dividing by `MAX_STEPS` instead would be wrong by however short
    // the fight is, which at the low end is nearly all of it: `stepsPerSecond(2)` is 4, so a duel that
    // settles by step 300 would live its entire life inside the first 8% of the ramp and never once
    // leave a walk. An empty or not-yet-started stream is 0, which is exactly the opening pace.
    const lastStep = p.hitEvents.length > 0 ? Number(p.hitEvents[p.hitEvents.length - 1].step) : 0;
    const fervour = lastStep > 0 ? Math.min(1, playhead / lastStep) : 0;
    const { field: f, replay: r, fresh } = ensureWorld(p, playhead);

    const still = reducedMotion.current;
    // A connector longer than this is a streak across the whole field, not a statement about who
    // hit whom — the pairs are hash-picked, so plenty of them are simply nowhere near each other and
    // no amount of steering will fix that. Above the cap the ring and the figure still fire; only
    // the line is dropped.
    const maxLineDist = Math.hypot(cssWidth, cssHeight) * 0.22;
    advanceReplay(r, p.hitEvents, playhead, (event, announce) => {
      // reduced motion: the hit still lands, it just doesn't announce itself. `announce` is the same
      // refusal for a different reason — this event is one of a catch-up backlog after a stall, and
      // is history rather than news. See `advanceReplay`. Everything skipped here is FLOURISH: the
      // shadow has already been advanced by the time this runs.
      if (still || !announce) return;
      // HOW BIG WAS THIS BLOW — both answers, both off the chain's own numbers, both read BEFORE
      // anything is drawn with them. See impact.ts's `hitForce` / `hitToll` for what each one means
      // and why one is not enough.
      //
      // The shadow has already had this event applied to it (`advanceReplay` applies, then calls
      // back), so the defender's pre-hit ring and worth are recovered by adding the amount back. The
      // attacker's ring is untouched by its own blow and reads straight off.
      const shadowA = r.shadow[event.attackerId];
      const shadowD = r.shadow[event.defenderId];
      // `+ event.amount` in BOTH, and it is easy to write only the first: `applyHitEvent` moved the
      // amount out of the defender's `hp` and into the ATTACKER's `banked`, so the defender's own
      // banked is untouched and its pre-hit worth is `hp + banked + amount`. Taking the post-hit
      // worth instead would overstate every toll by exactly the toll — a blow that took a fifth of a
      // fighter would report a quarter.
      const force = shadowA && shadowD ? hitForce(event.amount, shadowA.hp, shadowD.hp + event.amount) : 0.5;
      const toll = shadowD ? hitToll(event.amount, shadowD.hp + shadowD.banked + event.amount) : 0.5;
      recoil(f, event.attackerId, event.defenderId, force);
      flinch(f, event.attackerId, event.defenderId, force);
      impact.fire({
        nowMs: rafMs,
        amount: event.amount,
        force,
        toll,
        // DID THIS BLOW FINISH THEM. Read off the shadow `advanceReplay` has already advanced, so it
        // is the settled fact rather than a guess from the size of the number — a fighter on their
        // last dust goes out to a tiny amount, and the biggest hit in the round often kills nobody.
        // impact.ts sets the figure in `--hot` for it; nothing else in the canvas is that colour.
        kill: shadowD !== undefined && shadowD.hp === 0n,
        // The BODIES, not snapshots of them — rings and spall hold these and follow the fighter.
        // See impact.ts's `ImpactAnchor`.
        attacker: f.byId[event.attackerId],
        defender: f.byId[event.defenderId],
        unit: f.unit,
        maxLineDist,
        fieldW: cssWidth,
        // The PREVIOUS frame's text — this runs several steps before the paint that fills the map
        // for this one. `impact.draw` re-checks against the current map every frame, so the staleness
        // costs nothing except an occasional figure that could have been placed and wasn't.
        ink,
      });
    });
    applyExtractions(r, p.fighters);
    // `snap` under reduced motion: the radius spring is integrated by `stepField`, which is not
    // called there, so the drawn radius has to be put on its target directly or it would freeze at
    // whatever it held when the preference was turned on.
    const died = syncBodies(f, r.shadow, rafMs, still, !still && !fresh);
    // A fighter leaving is the loudest event in the game and it is not in the hit stream: a wipeout
    // arrives as a side effect of a blow and an EXTRACTION arrives with no event at all. Both are
    // caught here, once, off the transition `syncBodies` just stamped.
    //
    // AN INVARIANT THE DATA LAYER CURRENTLY HOLDS UP, WRITTEN DOWN BECAUSE IT IS LOAD-BEARING AND
    // INVISIBLE FROM HERE. `!fresh` suppresses deaths on any frame the replay was re-derived, on the
    // grounds that such deaths are history rather than news. An extraction is the one death that
    // arrives with no event behind it, so if the data layer ever starts RECOMPUTING `hitEvents` at
    // the extraction point — which `streamChanged`, `resetReplay` and `applyExtractions` are all
    // written to accommodate, and which their comments anticipate — the recompute would land on the
    // same frame the fighter goes out, `fresh` would be true, and every extraction's mark would be
    // silently dropped. Today `useLiveRound` memoises the stream on `(seed, entries)` and an
    // extraction changes neither, so extractions land on ordinary frames and are announced. Anyone
    // making the stream recompute mid-fight has to split this flag: "the replay was re-derived" and
    // "this particular death is not news" stop being the same statement at that point.
    if (died) {
      for (const b of f.bodies) {
        if (b.deadAtMs === rafMs) impact.die({ nowMs: rafMs, at: b, r: b.r, unit: f.unit });
      }
    }

    if (!still) {
      const dtMs = lastFrameMs === 0 ? 16.7 : rafMs - lastFrameMs;
      const targets = tracker.assign(
        f.bodies.length,
        p.hitEvents,
        r.cursor,
        playhead,
        rafMs,
        (id) => f.byId[id]?.dead ?? true,
      );
      stepField(
        f,
        targets,
        tracker.leadMs,
        motionModeFor(p.phase, p.fightStartedAtMs),
        dtMs,
        rafMs,
        fervour,
      );
      impact.shake(rafMs, f.unit, shake);
    } else {
      shake.x = 0;
      shake.y = 0;
    }
    // OUTSIDE the reduced-motion branch, unlike everything else here. Turning the preference ON
    // mid-fight leaves whatever was in flight sitting in the mark arrays for the rest of the round —
    // never drawn, so nothing is wrong on screen, but a set of lists that are documented as holding
    // only live marks and do not. Culling is four compacting passes over a couple of dozen entries
    // and it is correct in both modes, which is a better trade than a state nobody can see.
    impact.update(rafMs);
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

    // THE PAPER IS PAINTED BEFORE THE CAMERA MOVES, and everything else after it. A shake that
    // included the ground would drag a 4px band of nothing in behind the field's edge; painting the
    // sheet in canvas space and jolting only what stands on it is the difference between the arena
    // being struck and the page being dragged.
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = palette.paper;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    ctx.save();
    if (shake.x !== 0 || shake.y !== 0) ctx.translate(shake.x, shake.y);

    // The lattice is the ONLY thing the board style changes on the canvas; the frame and the overlays
    // are the parent's half of the same word (see `BoardStyle` in contract.ts).
    //
    // INSIDE the shake, and that is the point of having one at all: the survey grid is the page's
    // fixed frame of reference, so it is the mark that makes the jolt legible AS a jolt rather than
    // as the fighters twitching. `drawLattice` covers a step of margin past every edge, so shifting
    // it never exposes a bare strip.
    if (p.board === "survey") drawLattice(ctx, cssWidth, cssHeight, palette);

    // A new frame of text. Reset here, AFTER `impact.fire` has read last frame's map and before the
    // first thing that claims into it — and the first thing that claims into it is the shell's own
    // HUD, which is drawn over this canvas by the DOM and is therefore the one piece of text on the
    // frame that nothing here is free to move. See chrome.ts.
    //
    // The shake is handed to `claim` because the HUD is the one writer that does NOT move with it:
    // it is DOM sitting over the canvas, so its box has to be expressed in the shaken coordinates
    // everything on this canvas is about to be drawn in, or a label would route around where the HUD
    // used to be by up to the shake's amplitude.
    ink.reset();
    chrome.claim(ink, shake.x, shake.y);

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
      drawBodies(ctx, f, palette, { hoverId, selectedId: p.selectedId ?? null }, ink, rafMs);
      if (!still) impact.draw(ctx, palette, rafMs, ink);
    }
    ctx.restore();

    // OUTSIDE THE SHAKE. The readout is a panel you are pointing at, and a panel that jitters under
    // the cursor is a panel you cannot read — the one thing on this canvas that is a UI element
    // rather than a piece of the arena. Drawn after the restore for that reason and for one more:
    // it must sit above the impact FX, which is where it has always been.
    if (hovered) drawReadout(ctx, hovered, pointer.current.x, pointer.current.y, cssWidth, cssHeight, palette);

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
