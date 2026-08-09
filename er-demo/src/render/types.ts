// Shared types for the render/ layer — Phase 4 of snug-floating-mitten.md.
//
// Deliberately NOT importing React or pixi.js/matter-js types here: this file is the vocabulary
// every render/ module (gameLoop, retarget, impactFx, PixiCanvas) shares, so it stays as plain and
// dependency-light as sim/ itself. It DOES import sim/'s own types (HitEvent) — that's the intended
// coupling ("your event source"), not a boundary violation; the violation would be sim/ importing
// anything from here.

import type { HitEvent } from "../sim/hitEvents.ts";

/** One fighter as the render layer needs to know it — a deliberately narrower shape than either
 *  `chain/useRound.ts`'s `FighterState` (on-chain, PublicKey-typed, includes live hp/banked/dead)
 *  or `sim/erSim.ts`'s `ERFighter`.
 *
 *  WHY hp/banked AREN'T HERE: this render layer treats the precomputed `hitEvents` sequence, played
 *  back against wall-clock time, as the single source of truth for what's visually happening —
 *  exactly mirroring how `resolve()` derives its step count from elapsed real time rather than from
 *  a live per-tick feed (see gameLoop.ts's header comment). Accepting a separately-polled hp/banked
 *  here would create a second, potentially-disagreeing source of truth for the same fact. `stake` is
 *  the one number needed to seed that replay: `erSim.ts`'s `enter()` and `hitEvents.ts`'s
 *  `buildRoundFromEntries()` both set a fighter's starting hp equal to its net-of-fee stake, so
 *  `RenderFighter.stake` IS the starting hp — see shadowFight.ts.
 *
 *  `id` MUST equal this fighter's index in the array `hitEvents`' `attackerId`/`defenderId` were
 *  computed against (i.e. the same order as `round.fighters`/`entries` passed to
 *  `buildRoundFromEntries`). Nothing here re-derives that ordering — it's the caller's job to supply
 *  it correctly, same as `hitEvents.ts` itself requires. */
export interface RenderFighter {
  id: number;
  wallet: string;
  side: 0 | 1;
  stake: bigint;
  /** Known-dead as of the last on-chain checkpoint, independent of what `hitEvents` alone can show.
   *  The one case the precomputed event stream can't reflect is `extract()` (Phase 5): it moves a
   *  fighter out of the ring without producing a `HitEvent` (see hitEvents.ts's own comment on why).
   *  Passing the live `dead` flag here lets `retarget()`/`steer()` stop targeting an extracted
   *  fighter immediately, rather than waiting on a caller to also hand back a freshly-recomputed
   *  `hitEvents` array. Defaults to false — a fighter that's merely destined to die later in the
   *  precomputed sequence is NOT "dead" yet; the replay in shadowFight.ts derives that live. */
  dead?: boolean;
}

/** The top-level prop contract for `PixiCanvas` (and therefore for whatever wires it into the real
 *  app once Phase 3's store lands — see PixiCanvas.tsx's header comment for the full integration
 *  note). Every field is plain data; nothing here depends on zustand or on `useRound`'s hook shape,
 *  so this component has no dependency on a store existing to be exercised standalone (see
 *  render/harness/ for exactly that). */
export interface PixiCanvasProps {
  fighters: RenderFighter[];
  /** The full precomputed hit sequence for the CURRENT fight, ordered by `step`, from
   *  `runFullFight()`/`computeHitEvents()`. Phase 4's scope assumes this is the whole sequence for
   *  one uninterrupted fight (see gameLoop.ts's reinit note) — mid-fight extraction recompute is
   *  Phase 5's job, not this component's. */
  hitEvents: HitEvent[];
  /** `RoundState.fightStartedAt` (on-chain unix seconds) converted to a JS epoch ms timestamp by the
   *  caller, or `null` before the Fight phase has started (Lobby/Drawing) — the canvas renders
   *  fighters at rest, un-steered, with nothing played back, until this is non-null. */
  fightStartedAtMs: number | null;
  /** `RoundState.phaseName` — read-only context for what the canvas draws (e.g. whether to show the
   *  "waiting for the fight to start" state at all); the canvas does not gate on this to decide
   *  whether to advance the playhead (`fightStartedAtMs` alone does that). */
  phase: string;
  width?: number;
  height?: number;
}

export const DEFAULT_ARENA_WIDTH = 960;
export const DEFAULT_ARENA_HEIGHT = 540;
