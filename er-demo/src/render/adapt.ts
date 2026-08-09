// Adapters from the two real fighter shapes this app produces (`chain/useRound.ts`'s `FighterState`,
// the live on-chain poll; `sim/erSim.ts`'s `ERFighter`, the verification-harness/test fixture shape)
// into this layer's own `RenderFighter` — see types.ts for why `RenderFighter` deliberately drops
// hp/banked. Kept separate from types.ts so that file can stay free of any import from chain/ or
// sim/erSim.ts beyond the one HitEvent type it already needs.

import type { FighterState } from "../chain/useRound.ts";
import type { ERFighter } from "../sim/erSim.ts";
import type { RenderFighter } from "./types.ts";

/** `id` is the array index — callers must pass fighters in the same order the on-chain `Round`
 *  account (and therefore `hitEvents`) uses, i.e. `round.fighters.map(fromFighterState)`, not a
 *  reordered/filtered copy. */
export function fromFighterState(fighter: FighterState, id: number): RenderFighter {
  return {
    id,
    wallet: fighter.wallet.toBase58(),
    side: fighter.side === 1 ? 1 : 0,
    stake: fighter.stake,
    dead: fighter.dead,
  };
}

export function fromFighterStates(fighters: FighterState[]): RenderFighter[] {
  return fighters.map(fromFighterState);
}

/** Same ordering requirement as `fromFighterState` — `id` must match the index `hitEvents` was
 *  computed against (i.e. the position in the `entries`/`fighters` array passed to
 *  `buildRoundFromEntries`). */
export function fromERFighter(fighter: ERFighter, id: number): RenderFighter {
  return {
    id,
    wallet: fighter.wallet,
    side: fighter.side,
    stake: fighter.stake,
    dead: fighter.dead === 1,
  };
}

export function fromERFighters(fighters: ERFighter[]): RenderFighter[] {
  return fighters.map(fromERFighter);
}
