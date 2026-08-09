// KEEPER POLICY: how many house fighters to field, which sides they take, and what they stake.
//
// PURE FUNCTIONS ONLY — no chain, no I/O, no wall clock, no `Math.random()`. Everything in this file
// is a judgement call about what the arena looks like to somebody reading it, and a judgement call
// you cannot run on its own is one nobody will ever argue with. `houseSizing.test.ts` walks the
// entire policy in milliseconds, which leaves the keeper itself with nothing to decide: it asks
// these three functions and sends the transactions they describe.
//
// THE FACT THAT REFRAMES THE WHOLE PROBLEM: `enter` RECORDS A STAKE. IT NEVER MOVES LAMPORTS.
//
// This program custodies nothing at all — see the file header of `programs/bulls-arena/src/lib.rs`
// ("It does NOT move balances or custody"), and `abandon_round`'s "NOTHING IS REFUNDED, BECAUSE
// NOTHING WAS TAKEN". A stake is a number written into a `Fighter` row. So the SIZE of a house stake
// costs the treasury exactly nothing, and cannot: the only real spend is transaction fees and account
// rent, and both are per FIGHTER, not per dollar.
//
// That deletes the question everyone expects this file to be answering. There is no bankroll to risk,
// no exposure to hedge, no ruin to avoid — "what can the house afford to lose" has no meaning here.
// What remains is the only thing these numbers can honestly be optimising: the shape of the market on
// screen. How many fighters make a lobby look like an arena rather than a duel. Whether both sides
// are covered so there is a fight at all. Whether the stakes on the roster read like players or like
// N copies of one bot. Every constant below is argued on those terms, and none of them should be
// argued on any other.
//
// (The day balances move on-chain, the paragraph above stops being true and every rule under it needs
// re-arguing from the top. It is written this plainly so that day is impossible to miss.)

import { usdToUnits } from "../../src/v2/contract.ts";

export interface SideCounts {
  side0: number;
  side1: number;
}

/** THE MINIMUM THAT MAKES A FIGHT POSSIBLE AT ALL, and the one part of this policy that is not
 *  throttleable. `close_lobby_and_draw` refuses a lobby holding fewer than two fighters
 *  (`enough_to_fight`), and a lobby that reaches its deadline under-subscribed has exactly one
 *  instruction left that will succeed on it: `abandon_round`. So this is not a comfort figure — it
 *  is the difference between a round and no round, and everything else here may be tuned to zero
 *  while this may not. */
export const HOUSE_FLOOR = 2;

/** WHAT THE HOUSE FIELDS INTO A LOBBY THAT IS BEING HELD OPEN FOR REAL PLAYERS — one fighter, and
 *  the number is chosen for what it makes IMPOSSIBLE rather than for how it looks.
 *
 *  THE MIRROR IMAGE OF `HOUSE_FLOOR`, ARGUED FROM THE SAME CHAIN RULE. Two is the count at which a
 *  round becomes capable of fighting (`enough_to_fight`). One is therefore the largest count at which
 *  it is INCAPABLE of it — and while the keeper is holding a lobby open waiting for a person, being
 *  incapable of fighting is precisely the property wanted:
 *
 *    * `close_lobby_and_draw` is refused, for everyone. Not "the keeper declines to call it" — the
 *      program rejects it, so a permissionless caller racing the deadline cannot run a
 *      house-versus-house round either. The operator's requirement stops being a policy and becomes
 *      an invariant, which is a much stronger thing to be able to promise.
 *    * `abandon_round` is AVAILABLE at the deadline, because `lobby_is_dead` is exactly "past the
 *      deadline and not `enough_to_fight`". A held-open lobby that nobody joined therefore ends
 *      cleanly and the keeper opens another. At `HOUSE_TARGET` it could not be abandoned at all, and
 *      the round would either fight itself or sit in `Lobby` forever with its rent stranded.
 *
 *  AND THE ROOM IS STILL NOT EMPTY, which is the requirement pulling the other way. There is a
 *  fighter and a live pot on screen. The rest of the house arrives the moment a real player enters —
 *  the room populates AROUND them, which reads better than a static crowd that was already there.
 *
 *  Zero would satisfy the chain rules just as well and is rejected on the product: an empty room is
 *  the thing the house exists to prevent, and a visitor who arrives to nothing does not wait to find
 *  out that the arena is alive. */
export const HOLD_OPEN_HOUSE_FIGHTERS = 1;

/** THE LINEUP THE HOUSE FIELDS INTO AN EMPTY ROOM. Two fighters is a duel and reads as a test
 *  transaction; four reads as an arena with something going on in it, which is what a visitor
 *  arriving mid-lobby has to see in the two seconds before they decide whether this is a live game.
 *  It is also cheap enough to run every round forever: four entries of fees and rent, once a
 *  round. */
export const HOUSE_TARGET = 4;

/** HOW MANY HOUSE FIGHTERS EACH REAL ENTRANT DISPLACES. Two rather than one, because the house is
 *  seeding a market it wants to leave, and leaving at the same rate the crowd arrives would mean the
 *  house was still on the roster at four real players. At two, the room is entirely human by the
 *  time two people have turned up — which is the moment they no longer need anybody to fight. */
export const DISPLACEMENT = 2;

/** THE CEILING, and also the number of wallets the keeper banks — the two are the same number on
 *  purpose, since a policy that asked for a seventh fighter would be asking for a wallet that does
 *  not exist. Six is comfortably under the program's own `MAX_FIGHTERS` of 16, leaving ten seats
 *  that only real players can occupy: the house must never be able to fill a lobby. */
export const HOUSE_MAX = 6;

/**
 * HOW MANY HOUSE FIGHTERS THIS LOBBY GETS.
 *
 *     throttled = max(HOUSE_FLOOR - realTotal, HOUSE_TARGET - DISPLACEMENT * realTotal)
 *     cover     = how many sides are currently empty (0, 1 or 2)
 *     count     = clamp(max(throttled, cover), 0, HOUSE_MAX)
 *
 * Read it as three promises, in order of how much they matter:
 *
 *   1. a fight can happen — the first term never lets the lobby fall under `enough_to_fight`;
 *   2. an empty room still looks like an arena — the second term seeds `HOUSE_TARGET` into it;
 *   3. the house leaves the moment real players can fight each other — the second term shrinks by
 *      `DISPLACEMENT` per entrant, so the house withdraws FASTER than the crowd arrives.
 *
 * The ladder that falls out of it, which is the thing to check when arguing with any of the three
 * constants above:
 *
 *     0 real -> 4 house      2 real -> 0 house
 *     1 real -> 2 house      3+     -> 0 house        (all subject to `cover`, below)
 *
 * `COVER` IS THE GENUINE MARKET-MAKER FUNCTION, and it is why the ladder above carries a caveat. A
 * lobby where every fighter picked the same side is not a fight — it is a queue — and no amount of
 * real entrants fixes that by itself, because they are free to all pick Bulls. So the house always
 * takes an empty side, even when fully throttled out by the count rule: three real players stacked
 * on side 0 still get one house fighter, and it stands on side 1. That is the one case where the
 * house adds a fighter to a room that does not need more fighters, and it is the case where the
 * alternative is a round that cannot be drawn.
 */
export function houseFighterCount(real: SideCounts): number {
  const realTotal = real.side0 + real.side1;
  const throttled = Math.max(HOUSE_FLOOR - realTotal, HOUSE_TARGET - DISPLACEMENT * realTotal);
  const cover = (real.side0 === 0 ? 1 : 0) + (real.side1 === 0 ? 1 : 0);
  return Math.max(0, Math.min(HOUSE_MAX, Math.max(throttled, cover)));
}

/**
 * WHICH SIDE EACH HOUSE FIGHTER STANDS ON — greedily, onto whichever side is currently smaller,
 * counting the ones this call has already placed.
 *
 * Greedy-onto-the-smaller-side is not a heuristic here, it is the guarantee: because each assignment
 * updates the counts the next one reads, `count >= cover` is sufficient for both sides to end up
 * non-empty. Ties break toward side 0, which only decides which side an even split starts on and
 * matters solely so the allocation is reproducible.
 *
 * It reads the REAL counts, not just the house's own, because the house is balancing the lobby it is
 * joining rather than balancing itself.
 */
export function allocateHouseSides(count: number, real: SideCounts): (0 | 1)[] {
  const filled: [number, number] = [real.side0, real.side1];
  const sides: (0 | 1)[] = [];
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    const side: 0 | 1 = filled[1] < filled[0] ? 1 : 0;
    filled[side]++;
    sides.push(side);
  }
  return sides;
}

/** The band house stakes are drawn from, in dollars. Floor is the smallest preset a real player is
 *  offered; ceiling is the middle of the preset ladder rather than its top. See `houseStake`. */
export const HOUSE_STAKE_MIN_USD = 5;
export const HOUSE_STAKE_MAX_USD = 50;

/**
 * WHAT A HOUSE FIGHTER STAKES, in the program's opaque u64 units.
 *
 * THE BAND. Real players are offered `STAKE_PRESETS` — $5, $20, $50, $100 — so house stakes are drawn
 * from inside that same range, and the roster reads as a market rather than as N identical bots
 * sitting at one round number. Both edges are load-bearing: a house fighter below $5 would be
 * dwarfed by every real entrant at the smallest preset available to them, and one at $100 would dwarf
 * that entrant instead. Neither is a good look for a market maker. The ceiling stops at $50 rather
 * than $100 because the house is seeding liquidity, not providing it — at the top preset the house's
 * fighters would be the pot, and a player's own stake would be a rounding error next to the bots'.
 *
 * Sizing is free (see this file's header: nothing is custodied, so no stake risks anything), which is
 * exactly why the band is argued on how the roster READS and on nothing else.
 *
 * DETERMINISTIC, NOT `Math.random()`. A round's house lineup is reproducible from the round number
 * alone, forever, by anybody with this file. That is what makes an odd-looking round debuggable after
 * the fact: "round 214's bots staked 5/47/12/33" is a claim that can be re-derived and checked
 * months later, against a round whose accounts have long since been closed. With a random source it
 * would be unrecoverable the moment the process exited, and every question about a strange-looking
 * pot would end in a shrug.
 *
 * Whole dollars, so the roster reads cleanly — nobody staking $37.4192 looks like a person.
 */
export function houseStake(roundNo: number, walletIndex: number): bigint {
  // 46 buckets taken modulo a 32-bit hash carries the usual modulo bias; it is around one part in a
  // hundred million and it decides how often a bot picks $5 over $6. Rejection sampling here would
  // be ceremony.
  const span = HOUSE_STAKE_MAX_USD - HOUSE_STAKE_MIN_USD + 1;
  const usd = HOUSE_STAKE_MIN_USD + (mix(roundNo, walletIndex) % span);
  // The peg (`UNITS_PER_USD`) is not restated here — it lives in `contract.ts` and every path that
  // turns dollars into units goes through this one function, house and player alike.
  return usdToUnits(usd);
}

/** A 32-bit integer hash of the two inputs — the `lowbias32` finalizer applied to each half and
 *  combined with the golden-ratio constant, which is the standard cheap way to keep `(1, 0)` and
 *  `(0, 1)` from colliding and to keep consecutive round numbers from producing consecutive stakes.
 *
 *  It is a hash, not a PRNG: no state, no seeding, no sequence. Cryptographic strength is beside the
 *  point — nothing is being protected here, the outputs are published in the same breath as the
 *  wallets that post them, and the only property required is that the result looks unpatterned to a
 *  reader and is identical on every machine that computes it. */
function mix(roundNo: number, walletIndex: number): number {
  const combined = (avalanche(roundNo) ^ (avalanche(walletIndex) + 0x9e3779b9)) >>> 0;
  return avalanche(combined);
}

function avalanche(value: number): number {
  let h = Math.trunc(value) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}
