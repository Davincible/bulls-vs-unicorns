// HOW FAR THE FIGHT HAS GOT, and whether anyone may end it — the derived numbers every other surface
// in v2 hangs off (the clock, the canvas playhead, the urgency behind `EXTRACT`).
//
// TWO PROPERTIES OF THE PROGRAM SHAPE EVERYTHING BELOW, and neither is obvious from the outside:
//
//   1. THE RATE IS PER FIGHTER. `steps_per_second(n) = n * STEPS_PER_FIGHTER_PER_SECOND` (= n × 2),
//      because a fight's length in steps grows ~n^1.5 and no flat rate paces both a 2-fighter duel
//      and a 16-fighter brawl (lib.rs carries the measured table). A 9-fighter round runs at 18
//      steps/s; a 2-fighter one at 4. Any client that assumes a fixed rate draws a different fight
//      from the one being settled.
//   2. THERE IS NO MINIMUM FIGHT LENGTH. `resolve()` refuses until the fight is genuinely over — one
//      side with nobody standing — or the bell rings at `FIGHT_TIMEOUT_SECONDS`. That, not a fixed
//      countdown, is the deadline an extract is racing, which is why `resolvable` is a flag.
//
// Both constants come through `contract.ts`, which re-exports `chain/constants.ts` — the one
// maintained mirror of lib.rs.

import { FIGHT_TIMEOUT_SECONDS, MAX_STEPS, stepsPerSecond, type PhaseName, type Side } from "../contract.ts";
import type { SignerMode } from "./flags.ts";

/** Just enough of a fighter to know whether their side still has anyone in the ring. */
export interface PaceFighter {
  side: Side;
  dead: boolean;
}

export interface FightPaceInput {
  phase: PhaseName;
  /** Epoch ms of `Round.fight_started_at`, or null before the seed lands. */
  fightStartedAtMs: number | null;
  fighters: PaceFighter[];
  /** The chain's own settled cursor — the only truth about a Settled round's length. */
  tickCount: bigint;
  nowMs: number;
}

export interface FightPace {
  elapsedSec: number;
  stepsNow: number;
  resolvable: boolean;
}

/** lib.rs's `fight_is_over`: one side has nobody standing. Extraction counts as leaving the ring
 *  (`extract()` sets `dead = 1`), which is deliberate on-chain — pull the last opponent out and
 *  there is genuinely nothing left to play. */
export function fightIsOver(fighters: PaceFighter[]): boolean {
  let a = 0;
  let b = 0;
  for (const f of fighters) {
    if (f.dead) continue;
    if (f.side === 0) a += 1;
    else b += 1;
  }
  return a === 0 || b === 0;
}

/** `resolve()`'s own guards, restated client-side so the UI can say "this can be settled now" without
 *  sending a transaction to find out: Fight phase, at least two fighters, and either the fight is
 *  over or the bell has rung. */
function isResolvable(input: FightPaceInput, elapsedSec: number): boolean {
  if (input.phase !== "Fight") return false;
  if (input.fighters.length < 2) return false;   // lib.rs: `require!(n >= 2, NotEnoughFighters)`
  return fightIsOver(input.fighters) || elapsedSec >= FIGHT_TIMEOUT_SECONDS;
}

export interface DriveFightInput {
  /** True when the page is showing the fixture — there is no chain round to advance. */
  fallback: boolean;
  sessionActive: boolean;
  /** The signer's SOL, or null while the first balance poll is still out. */
  solBalance: number | null;
  /** WHO WOULD PAY FOR THE TICKS. See the wallet-mode clause in `shouldDriveFight`. */
  mode: SignerMode;
}

/**
 * WHETHER THIS TAB SHOULD DRIVE THE LIVE FIGHT (`chain/useFightTicker.ts`).
 *
 * `tick()` is what makes the on-chain `hp` genuinely decay mid-fight: `catch_up()` runs inside `tick`,
 * `extract` and `resolve` and NOWHERE else in the program, so with nobody ticking, every fighter's
 * stored hp sits at their full entry stake until the round settles — the canvas would replay the
 * fight correctly from the seed while every roster and health bar stayed frozen.
 *
 * It is gated on WHO PAYS, because ticks cost transaction fees:
 *   - a session key pays for its own ticks, so the burner's balance is then irrelevant;
 *   - with no session, a burner known to hold 0 SOL cannot sign anything, and letting the ticker
 *     rediscover that every 400ms forever is a failure loop that rate-limits the RPC the round poll
 *     itself depends on;
 *   - `null` (balance not read yet) means GO: the first balance poll can land after the first Fight
 *     poll, and one tick that fails is harmless — the next covers the same backlog.
 *
 * Not gated on phase or on there being a backlog: `useFightTicker` already refuses outside Fight and
 * stays silent when the cursor is current, and duplicating either check here would be a second place
 * for them to be wrong.
 *
 * ------------------------------------------------------------------------------------------------
 * THE WALLET-MODE CLAUSE, which is doing two jobs at once.
 *
 * FIRST, THE OBVIOUS ONE. `useFightTicker` polls every 400ms and sends a transaction whenever the
 * cursor has moved. With a connected Phantom and no session key, EVERY ONE OF THOSE would open an
 * approval popup — roughly two and a half a second, for the length of a fight. That is not a degraded
 * experience, it is an unusable page. So in wallet mode the ticker runs only when a session key is
 * paying and signing, which is exactly the arrangement the session feature exists to create.
 *
 * SECOND, AND LOAD-BEARING: THIS IS WHAT MAKES THE PLACEHOLDER KEYPAIR UNREACHABLE.
 * `chain/useFightTicker.ts` takes a required `keypair: Keypair` and uses it only on the branch where
 * `session` is null — and it may not be edited by this workstream. In wallet mode there is no
 * keypair to give it, so `identity.ts` hands it a freshly generated, never-persisted, never-funded
 * one. This clause is the guarantee that the branch which would touch it cannot execute: wallet mode
 * requires `sessionActive`, and `sessionActive` means the ticker takes the session branch. The tests
 * on this function are that guarantee's proof, and deleting the clause silently arms a signer that
 * holds nothing.
 * ------------------------------------------------------------------------------------------------
 */
export function shouldDriveFight({ fallback, sessionActive, solBalance, mode }: DriveFightInput): boolean {
  if (fallback) return false;
  if (mode === "wallet") return sessionActive;
  if (sessionActive) return true;
  return solBalance !== 0;
}

/**
 * The replay playhead and the fight clock, for any phase.
 *
 * Lobby/Drawing  — nothing has happened; 0/0.
 * Fight          — live-ticking off the wall clock at the chain's own per-fighter rate, capped at
 *                  `MAX_STEPS` exactly as `canonical_cursor()` saturates.
 * Settled        — FROZEN at the chain's recorded `tick_count`, and the clock frozen at the fight
 *                  time that cursor represents. `contract.ts`'s doc comment says `elapsedSec` is 0
 *                  outside Fight; taken literally that renders a finished round's clock as `0:00`
 *                  (a claim about the round that isn't true) and puts the canvas playhead back at
 *                  step 0 (the fight un-fought). Freezing at the settled cursor is the same
 *                  quantity both fields already mean — "where the fight actually got to" — and is
 *                  what every panel showing a settled round wants. Lobby/Drawing are unchanged.
 */
export function fightPace(input: FightPaceInput): FightPace {
  const rate = stepsPerSecond(input.fighters.length);

  if (input.phase === "Settled") {
    const steps = Math.min(Number(input.tickCount), MAX_STEPS);
    return {
      elapsedSec: rate > 0 ? steps / rate : 0,
      stepsNow: steps,
      resolvable: false,   // already settled — there is nothing left to resolve
    };
  }

  if (input.phase !== "Fight" || input.fightStartedAtMs === null) {
    return { elapsedSec: 0, stepsNow: 0, resolvable: false };
  }

  const elapsedSec = Math.max(0, (input.nowMs - input.fightStartedAtMs) / 1000);
  return {
    elapsedSec,
    stepsNow: Math.min(Math.floor(elapsedSec * rate), MAX_STEPS),
    resolvable: isResolvable(input, elapsedSec),
  };
}
