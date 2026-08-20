// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// The two-mint layer for G12 (ADR-001-two-mints.md): mints, the frozen price, the credit and claim
// conversions, and the per-slot conservation check. The FIGHT itself is not here — it is the same
// `runFight` in `fight-variant.ts` that every other study in this directory calls, driven by a new
// optional `cfg.vector` knob. That is deliberate and it is the whole methodology:
//
//   THERE IS NO SECOND SIMULATOR. `tests/compute.rs`'s `bench_fight` is this repository's own
//   cautionary tale about a hand-copied fight loop drifting away from the real one, and a study
//   that answers "is the vector fight fair" by measuring a fresh transcription of it would be
//   answering a question about the transcription. `parity.ts` still asserts BASELINE is
//   byte-identical to `engine/src/er-sim.ts`, at both fee rates, WITH the vector knob compiled in
//   and unset — so the same loop that is pinned to the chain is the loop measured below.

import { createHash } from "node:crypto";
import {
  BPS, FEE_BPS, PRICE_SCALE, UNITS_PER_USD, BASELINE, MAX_TOKENS,
  creditUnits, claimTokens, claimOf, makeFighter, makeVFighter, vsum, stepBudget,
} from "./fight-variant.ts";
import type { Fighter, FightConfig, VectorSpec, VectorBasis, TakeOrder } from "./fight-variant.ts";
import { makeLobby, finish, usd, BANDS } from "./lobby.ts";
import type { Lobby, Entry } from "./lobby.ts";

// ------------------------------------------------------------------------------------------------
// The arena ADR-001 actually describes: two mints, one per side.
// ------------------------------------------------------------------------------------------------

export const MINTS = 2;
export const MINT_NAMES = ["ANSEM", "UWU"] as const;

/** A fighter's own mint slot IS their side, because ADR-001 says Bulls stake ANSEM and Unicorns
 *  stake UWU. It is a property of the arena's configuration, not a choice the player makes at
 *  entry — which is itself a fairness-relevant fact and is why part 4 asks what a player who could
 *  choose would do. */
export const slotOfSide = (side: 0 | 1): number => side;

/** Dollars per whole token, from ARCHITECTURE-N-TEAM.md §3.1's own worked example ("100 raw ANSEM
 *  ($17) against 100 raw UWU ($3.30)"). The 5.15x ratio is the point — a price that mattered. */
export const USD_PER_TOKEN = [0.17, 0.033] as const;
export const TOKEN_DECIMALS = 6;

/** `price[i]` in units (USD micro-units) per token BASE unit, fixed point at PRICE_SCALE. */
export function priceVector(usdPerToken: readonly number[] = USD_PER_TOKEN): bigint[] {
  const p: bigint[] = [];
  for (const u of usdPerToken) {
    // micro-USD per base unit = usdPerToken / 10^decimals * 10^6, then scaled.
    p.push(BigInt(Math.round(u * 1e6 / 10 ** TOKEN_DECIMALS * Number(PRICE_SCALE))));
  }
  while (p.length < MAX_TOKENS) p.push(1n);
  return p;
}

export const TRUE_PRICE = priceVector();

/** The frozen price with mint `slot` mis-stated by `epsBps` basis points. `epsBps > 0` means the
 *  price authority published that token as MORE valuable than it is. */
export function skewedPrice(epsBps: number, slot: number): bigint[] {
  const p = [...TRUE_PRICE];
  p[slot] = (p[slot] * BigInt(10_000 + epsBps)) / 10_000n;
  return p;
}

// ------------------------------------------------------------------------------------------------
// The candidates. Every one is a `FightConfig` — the SHIPPED BASELINE plus a `vector` knob — so
// none of them can differ from the deployed fight anywhere except in the basis and the take order.
// ------------------------------------------------------------------------------------------------

export function candidate(
  basis: VectorBasis, take: TakeOrder,
  opts: { economy?: "extraction" | "mayhem"; price?: bigint[] } = {},
): FightConfig {
  return {
    ...BASELINE,
    vector: { mints: MINTS, basis, take, economy: opts.economy ?? "extraction", price: opts.price },
  };
}

/** The scalar control: the fight exactly as it ships today, no vector at all. */
export const C0_SCALAR: FightConfig = BASELINE;

export const C1_SLOT_MIN = candidate("slot-min", "stolen-first");
export const C2_TOKEN_MIN = candidate("token-min", "stolen-first", { price: TRUE_PRICE });
export const C3_PROPORTIONAL = candidate("value-min", "proportional");
export const C4_GREEDY = candidate("value-min", "stolen-first");
export const C5_OWN_FIRST = candidate("value-min", "own-first");

export const CANDIDATES: { id: string; name: string; cfg: FightConfig }[] = [
  { id: "C1", name: "slot-min, independent per slot   ", cfg: C1_SLOT_MIN },
  { id: "C2", name: "token-min, raw amounts, unpriced ", cfg: C2_TOKEN_MIN },
  { id: "C3", name: "value-min + proportional split   ", cfg: C3_PROPORTIONAL },
  { id: "C4", name: "value-min + stolen-first (3.4b)  ", cfg: C4_GREEDY },
  { id: "C5", name: "value-min + own-first            ", cfg: C5_OWN_FIRST },
];

// ------------------------------------------------------------------------------------------------
// Lineups. TWO constructors on purpose, because they answer two different questions and conflating
// them would let the conversion's rounding contaminate the fight's fairness measurement.
// ------------------------------------------------------------------------------------------------

/** UNITS-EXACT. The fighter is credited exactly the net units the single-mint arena would have
 *  credited, and those units are placed in the fighter's own slot. No price is applied, so no
 *  rounding enters, so any difference from the scalar fight is the BASIS and nothing else.
 *
 *  This is the constructor every fight-property test uses. */
export function vFightersOf(l: Lobby, mints = MINTS): { fighters: Fighter[]; fees: bigint } {
  const fighters: Fighter[] = [];
  let fees = 0n;
  for (const e of l.entries) {
    const { f, fee } = makeFighter(e.wallet, e.side, e.grossUnits);
    const slot = slotOfSide(e.side);
    f.ring = new Array(mints).fill(0n); f.ring[slot] = f.hp;
    f.vbank = new Array(mints).fill(0n);
    f.slot = slot;
    fighters.push(f); fees += fee;
  }
  return { fighters, fees };
}

/** THE FULL ROUND TRIP: USD -> token base units at the TRUE price -> value units at the FROZEN
 *  price. Both floor divisions are live, and the frozen price may be wrong. This is the
 *  constructor the price-sensitivity and dust measurements use, and only those. */
export function vFightersFromTokens(
  l: Lobby, frozen: bigint[], truePrice = TRUE_PRICE, mints = MINTS,
): { fighters: Fighter[]; deposits: { wallet: string; slot: number; tokens: bigint; usdTrue: number }[]; feeTokens: bigint[] } {
  const fighters: Fighter[] = [];
  const deposits: { wallet: string; slot: number; tokens: bigint; usdTrue: number }[] = [];
  const feeTokens = new Array(mints).fill(0n);
  for (const e of l.entries) {
    const slot = slotOfSide(e.side);
    // What the player actually sends: the USD they meant to stake, bought at the REAL price.
    const tokens = (e.grossUnits * PRICE_SCALE) / truePrice[slot];
    const { f, feeTokens: ft } = makeVFighter(e.wallet, e.side, tokens, slot, frozen, mints);
    fighters.push(f);
    feeTokens[slot] += ft;
    deposits.push({ wallet: e.wallet, slot, tokens, usdTrue: tokensToUsd(tokens, slot, truePrice) });
  }
  return { fighters, deposits, feeTokens };
}

/** Token base units valued at a price vector, in dollars. Analysis only — floats never touch the
 *  path from a hash to a damage number. */
export const tokensToUsd = (tokens: bigint, slot: number, price: bigint[]): number =>
  Number(tokens) * Number(price[slot]) / Number(PRICE_SCALE) / Number(UNITS_PER_USD);

export const unitsToUsd = (u: bigint): number => Number(u) / Number(UNITS_PER_USD);

// ------------------------------------------------------------------------------------------------
// Conservation. The bar is `ARCHITECTURE-N-TEAM.md` §3.2's per-slot identity, not the scalar one:
//
//     sum_fighters ( ring[i] + banked[i] ) + penalties[i]  ==  pot[i]      for every slot i
//
// A scalar total that balances while a slot does not is precisely the failure the vector exists to
// prevent — the vault holding surplus UWU and owing ANSEM it does not have.
// ------------------------------------------------------------------------------------------------

export interface Residual { perSlot: bigint[]; scalar: bigint; partition: bigint }

/** Max absolute residual, in micro-units, over the three identities that can independently break:
 *  per-slot conservation, scalar conservation, and the partition invariant `sum(ring) === hp`. */
export function residualOf(fighters: Fighter[], potPerSlot: bigint[], mints = MINTS): Residual {
  const held = new Array(mints).fill(0n);
  let partition = 0n;
  for (const f of fighters) {
    for (let i = 0; i < mints; i++) held[i] += f.ring![i] + f.vbank![i];
    const dr = vsum(f.ring!) - f.hp, db = vsum(f.vbank!) - f.banked;
    const e = (dr < 0n ? -dr : dr) + (db < 0n ? -db : db);
    if (e > partition) partition = e;
  }
  const perSlot: bigint[] = [];
  let scalarHeld = 0n, scalarPot = 0n;
  for (let i = 0; i < mints; i++) {
    perSlot.push(held[i] - potPerSlot[i]);
    scalarHeld += held[i]; scalarPot += potPerSlot[i];
  }
  return { perSlot, scalar: scalarHeld - scalarPot, partition };
}

export const maxAbs = (r: Residual): bigint => {
  let m = r.partition;
  const a = (x: bigint) => (x < 0n ? -x : x);
  for (const x of r.perSlot) if (a(x) > m) m = a(x);
  if (a(r.scalar) > m) m = a(r.scalar);
  return m;
};

export function potPerSlotOf(fighters: Fighter[], mints = MINTS): bigint[] {
  const p = new Array(mints).fill(0n);
  for (const f of fighters) for (let i = 0; i < mints; i++) p[i] += f.ring![i] + f.vbank![i];
  return p;
}

// ------------------------------------------------------------------------------------------------
// Settlement in the only denomination a player can spend.
// ------------------------------------------------------------------------------------------------

/** What a fighter walks away with, per mint, in token base units — and what that is worth at the
 *  TRUE price, which is the number that decides whether they were treated fairly. */
export function settleTokens(f: Fighter, frozen: bigint[], truePrice = TRUE_PRICE): { perMint: bigint[]; usdTrue: number } {
  const perMint = claimOf(f, frozen);
  let usdTrue = 0;
  for (let i = 0; i < perMint.length; i++) usdTrue += tokensToUsd(perMint[i], i, truePrice);
  return { perMint, usdTrue };
}

/** The claim residue: units credited that no player can withdraw, because `units / price` floors.
 *  Bounded by one base unit per occupied slot per fighter, and it accrues to the ESCROW — i.e. to
 *  the house — which is the opposite direction to §11.1's single-mint rounding. */
export function claimDust(fighters: Fighter[], frozen: bigint[], mints = MINTS): bigint[] {
  // RETURNED SCALED BY PRICE_SCALE, and that is not a detail — it is the fix for a wrong first
  // answer. This started as `units - creditUnits(claimTokens(units, p), p)`, which re-floors the
  // tokens back into units and so charges the player a SECOND rounding that the real money path
  // never performs: a claimant receives tokens and keeps them, they are not re-credited. That
  // phantom floor inflated the measured dust 6.6x, to 1.08e-5 $/round against a true bound of
  // 1.6e-6, and it read as the vector being dustier than it is. The exact residue is
  // `units - tokens * p / SCALE` with no floor on the second term, so it is computed in scaled
  // integers and divided once, at the end, in the analysis.
  const dust = new Array(mints).fill(0n);
  for (const f of fighters) {
    for (let i = 0; i < mints; i++) {
      const units = f.ring![i] + f.vbank![i];
      if (units === 0n) continue;
      dust[i] += units * PRICE_SCALE - claimTokens(units, frozen[i]) * frozen[i];
    }
  }
  return dust;
}

/** `claimDust`'s scaled residue, in whole micro-units, for reporting. */
export const dustToUnits = (scaled: bigint): number => Number(scaled) / Number(PRICE_SCALE);

// ------------------------------------------------------------------------------------------------
// Reporting. Same register as HOUSE-EDGE-STUDY.md: point estimate, bootstrap SE over ROUNDS.
// ------------------------------------------------------------------------------------------------

export { makeLobby, finish, usd, BANDS, stepBudget, FEE_BPS, BPS, PRICE_SCALE, UNITS_PER_USD };
export type { Lobby, Entry, Fighter, FightConfig, VectorSpec };

export const fmtPct = (x: number, d = 4) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
export const fmtU = (u: bigint) => `${u} µu`;

export function hr(title: string) {
  console.log(`\n${"=".repeat(96)}\n${title}\n${"=".repeat(96)}`);
}
