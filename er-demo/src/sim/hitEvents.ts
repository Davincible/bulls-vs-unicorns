// Turns the deterministic on-chain fight into an ORDERED sequence of real hit events, for the
// render layer to play back and for VerifyPanel.tsx to diff against the chain's settled state.
//
// Why this is a thin wrapper and not its own simulation: `run_fight()` (mirrored in erSim.ts) picks
// attacker/defender by hash(seed, step) % n — no positions, no collisions. The render layer still
// needs a real sequence of "who hit whom, for how much, in what order" to steer sprites and time
// impact FX. That sequence is not a separate thing to compute — it IS what erSim.ts's `tick()`
// already decides internally, one step at a time. This module never re-derives attacker/defender
// selection or the damage roll; it only asks `tick()` to report what it already computed, via the
// `onHit` callback added there for exactly this purpose.
import { newRound, tick, type ERFighter, type ERRound, type HitEvent } from "./erSim";

export type { HitEvent } from "./erSim";

/** A fighter's on-chain entry, as read from a delegated Round account after entries have closed.
 *  `stake` here is intentionally net-of-fee — it is `round.fighters[i].stake` as the chain already
 *  computed it, not the raw lamports a player sent. Fee math belongs to `enter()`, which already
 *  ran once, on-chain, before this module ever sees the entries. */
export interface HitEventEntry {
  wallet: string;
  side: 0 | 1;
  stake: bigint;
}

/** Builds the round exactly as it existed the instant the lobby closed: every fighter at full hp,
 *  nothing banked, nobody dead. Skips `enter()` on purpose — see `HitEventEntry` above. */
export function buildRoundFromEntries(seed: Buffer, entries: HitEventEntry[]): ERRound {
  const round = newRound(seed);
  for (const e of entries) {
    round.fighters.push({ wallet: e.wallet, side: e.side, dead: 0, stake: e.stake, hp: e.stake, banked: 0n });
    round.pot += e.stake;
  }
  return round;
}

/** Runs `steps` more ticks against `round` and returns the ordered hit events that produced —
 *  mutates `round` in place, same as `tick()` itself.
 *
 *  This composes with `extract()` for free: call this for the first N steps, `extract()` a fighter
 *  out of `round.fighters`, then call this again for the rest. The second call's events already
 *  exclude the extracted fighter as either attacker or defender, because `tick()`'s own
 *  `dead === 1` check (unchanged, still reading live fighter state) skips them — nothing here needs
 *  to know extraction happened. */
export function computeHitEvents(round: ERRound, steps: number): HitEvent[] {
  const events: HitEvent[] = [];
  tick(round, steps, event => events.push(event));
  return events;
}

/** Convenience for the common case: seed + entries + a step count, no mid-fight interaction. Runs
 *  the whole fight in one call and returns both the final round state and the full event list —
 *  what `VerifyPanel.tsx` needs for a one-shot re-verification against the chain's settled state. */
export function runFullFight(seed: Buffer, entries: HitEventEntry[], steps: number): { round: ERRound; events: HitEvent[] } {
  const round = buildRoundFromEntries(seed, entries);
  const events = computeHitEvents(round, steps);
  return { round, events };
}

/** Applies one hit event to `fighters` in place — the inverse of what `tick()` did internally to
 *  produce it. Exists so a consumer can reconstruct fight state purely from the event list: that's
 *  what the render layer will do when it scrubs a playhead through the sequence (Phase 4), and it's
 *  what the parity tests do here, independently of the `tick()`-mutated round, to prove the event
 *  stream alone carries the whole outcome rather than being a lossy summary of it.
 *
 *  Damage in an emitted event is always <= the defender's hp at the moment it was produced —
 *  `tick()` computes it that way (see the DUST-floor comment in erSim.ts) — so plain subtraction is
 *  safe here; no need for the saturating helper `tick()` uses internally for the same reason. */
export function applyHitEvent(fighters: ERFighter[], event: HitEvent): void {
  const attacker = fighters[event.attackerId];
  const defender = fighters[event.defenderId];
  defender.hp -= event.amount;
  attacker.banked += event.amount;
  if (defender.hp === 0n) defender.dead = 1;
}
