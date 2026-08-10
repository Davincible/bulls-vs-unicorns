// THE FIVE THINGS THE HOUSE MUST NEVER DO, checked against EVERY lobby shape a forty-eight-seat round
// can hold rather than against the handful anybody thought to write down.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `houseBank.test.ts`. That file is a set of examples, and
// examples are how a policy gets argued: "1 real player, 9 house fighters" is a sentence somebody has
// to re-endorse. This file is the opposite discipline — no judgement calls, no numbers to re-endorse,
// five properties that must hold at every input and that nobody should ever want to change. It earns
// its place because it FOUND something: the per-side shortfall bug documented in
// `plannedHouseEntries` had survived review and the whole example suite, because it only appears when
// the house is at its target AND badly distributed, which is two conditions nobody thinks to combine.
// It then found two more — a treasury-rule regression and a seat-reservation breach — in the fix for
// the first, within a minute of each. Sweeping is cheaper than being clever.
//
// 71,490 shapes across both stages (up from 5,826 at the old sixteen-seat cap — the seat count enters
// the shape count roughly quadratically via the (r0, r1) sweep, so the 3x seat increase is a ~12x
// shape increase) — still comfortably sub-second. The real fighters are raw 32-byte pubkeys rather
// than generated keypairs: a real player is defined as "a wallet the bank does not hold", nothing here
// signs anything, and Ed25519 keygen is the only thing that would make this slow enough to skip.

import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

import type { RawFighter, RawRoundAccount } from "../../src/chain/program.ts";
import {
  HOUSE_FILL_LEAD_SECONDS, HOUSE_WALLET_COUNT, MIN_FIGHTERS_TO_FIGHT, REAL_SEATS_RESERVED,
} from "./config.ts";
import { houseBankFrom, plannedHouseEntries, type HouseBank } from "./houseBank.ts";

const SEATS = 48;
const CLOSES_AT = 1_800_000_000;
/** The two moments the planner behaves differently at: before the fill lead, and inside it. */
const STAGES = {
  seed: CLOSES_AT - HOUSE_FILL_LEAD_SECONDS - 20,
  fill: CLOSES_AT - HOUSE_FILL_LEAD_SECONDS,
} as const;

const bank: HouseBank = houseBankFrom(Array.from({ length: HOUSE_WALLET_COUNT }, () => Keypair.generate()));

let stranger = 0;
/** A wallet the bank does not hold, which is the entire definition of a real player here. Cheap on
 *  purpose — see the file header. */
function realWallet(): PublicKey {
  const bytes = new Uint8Array(32);
  const n = ++stranger;
  bytes[0] = n & 0xff;
  bytes[1] = (n >> 8) & 0xff;
  bytes[31] = 7; // keeps it clear of the all-zero PublicKey.default the padding uses
  return new PublicKey(bytes);
}

function fighter(wallet: PublicKey, side: 0 | 1): RawFighter {
  return { wallet, side, dead: 0, stake: new BN(1), hp: new BN(1), banked: new BN(0) };
}

function roundWith(fighters: RawFighter[]): RawRoundAccount {
  const padded = [...fighters];
  while (padded.length < SEATS) padded.push(fighter(PublicKey.default, 0));
  return {
    lobbyClosesAt: new BN(CLOSES_AT), fighterCount: fighters.length, fighters: padded,
  } as unknown as RawRoundAccount;
}

interface Shape {
  stage: keyof typeof STAGES;
  /** Real fighters per side. */
  r0: number; r1: number;
  /** House fighters ALREADY standing, per side — including arrangements this keeper would not itself
   *  produce, because a restart, a partial send or a round seeded under another configuration can. */
  h0: number; h1: number;
}

/** Every lobby a forty-eight-seat round can hold, at both stages. The house-side loops stop at 5 because
 *  the shapes past that are dominated by the ones below them and the sweep is meant to stay fast
 *  enough that nobody is tempted to skip it. */
function everyShape(): Shape[] {
  const shapes: Shape[] = [];
  for (const stage of ["seed", "fill"] as const) {
    for (let r0 = 0; r0 <= SEATS; r0++) {
      for (let r1 = 0; r0 + r1 <= SEATS; r1++) {
        for (let h0 = 0; h0 <= 5; h0++) {
          for (let h1 = 0; h1 <= 5; h1++) {
            if (h0 + h1 > HOUSE_WALLET_COUNT) continue;
            if (r0 + r1 + h0 + h1 > SEATS) continue;
            shapes.push({ stage, r0, r1, h0, h1 });
          }
        }
      }
    }
  }
  return shapes;
}

interface Outcome {
  label: string;
  realTotal: number;
  houseBefore: number;
  /** How many `enter` calls the planner asked for. */
  planned: number;
  houseAfter: number;
  side0After: number;
  side1After: number;
  freeSeatsAfter: number;
  /** Did the plan reach for a wallet already holding a fighter in this round? */
  reusedAWallet: boolean;
  /** Did the plan name the same wallet twice? */
  duplicatedAWallet: boolean;
}

function plan({ stage, r0, r1, h0, h1 }: Shape): Outcome {
  const seated = [
    ...Array.from({ length: r0 }, () => fighter(realWallet(), 0 as const)),
    ...Array.from({ length: r1 }, () => fighter(realWallet(), 1 as const)),
    ...bank.active.slice(0, h0).map((w) => fighter(w.keypair.publicKey, 0 as const)),
    ...bank.active.slice(h0, h0 + h1).map((w) => fighter(w.keypair.publicKey, 1 as const)),
  ];
  const round = roundWith(seated);
  const { entries } = plannedHouseEntries(bank, round, 7n, STAGES[stage], { drawAt: CLOSES_AT });

  const already = new Set(seated.map((f) => f.wallet.toBase58()));
  const picked = entries.map((e) => e.wallet.keypair.publicKey.toBase58());
  const added0 = entries.filter((e) => e.side === 0).length;
  const added1 = entries.length - added0;

  return {
    label: `${stage}: ${r0}v${r1} real, ${h0}v${h1} house`,
    realTotal: r0 + r1,
    houseBefore: h0 + h1,
    planned: entries.length,
    houseAfter: h0 + h1 + entries.length,
    side0After: r0 + h0 + added0,
    side1After: r1 + h1 + added1,
    freeSeatsAfter: SEATS - (r0 + r1 + h0 + h1 + entries.length),
    reusedAWallet: picked.some((k) => already.has(k)),
    duplicatedAWallet: new Set(picked).size !== picked.length,
  };
}

const outcomes = everyShape().map(plan);

describe("what the house does to every lobby a round can hold", () => {
  it("sweeps every shape, so a passing run below is a claim about all of them", () => {
    expect(outcomes.length).toBe(71_490);
  });

  it("never asks for a seat the round does not have", () => {
    // `enter` answers `RoundFull` past MAX_FIGHTERS, and a transaction guaranteed to fail is a fee
    // spent to learn nothing. Nothing outranks this bound — not the target, not the cover rule.
    for (const o of outcomes) expect(o.freeSeatsAfter, o.label).toBeGreaterThanOrEqual(0);
  });

  it("never enters a wallet that is already fighting in the round", () => {
    // A wallet on both sides would be one bot funding both ends of a fight with itself. `enter` is
    // keyed on (wallet, side), so the program would allow it.
    for (const o of outcomes) {
      expect(o.reusedAWallet, o.label).toBe(false);
      expect(o.duplicatedAWallet, o.label).toBe(false);
    }
  });

  it("NEVER makes a lobby with no real player in it capable of fighting", () => {
    // THE TREASURY RULE, and the property this whole file is really here to defend. The claim is
    // deliberately about what the planner CAUSES rather than about the state it finds: a lobby that
    // somehow already holds two house fighters and nobody real is unreachable under this policy — a
    // real player cannot un-enter, so `realCount` never falls — but if the planner is ever handed one,
    // it must not make it worse, and above all it must not push a one-fighter room to two.
    for (const o of outcomes) {
      if (o.realTotal > 0) continue;
      expect(o.houseAfter, o.label).toBeLessThanOrEqual(Math.max(MIN_FIGHTERS_TO_FIGHT - 1, o.houseBefore));
    }
  });

  it("leaves every lobby holding a real player drawable, by the time it is drawn", () => {
    // Both sides occupied and at least `enough_to_fight` fighters, or the round reaches its deadline
    // with one instruction left that succeeds on it — `abandon_round` — and the person who turned up
    // and waited gets nothing while the round's ~0.0085 SOL of rent goes with it.
    //
    // ASSERTED AT THE FILL STAGE, WHICH IS THE HONEST PLACE FOR IT. The seed stage deliberately stands
    // down once the round can already fight (`realCount >= MIN_FIGHTERS_TO_FIGHT`), so a lobby can be
    // transiently lopsided early on; the fill stage, twelve seconds before the draw, is what has to
    // have fixed it. That this passes for every shape at `fill` and not at `seed` is the two-stage
    // design working, not a gap.
    for (const o of outcomes) {
      if (!o.label.startsWith("fill") || o.realTotal === 0) continue;
      if (o.freeSeatsAfter === 0 || o.houseAfter >= HOUSE_WALLET_COUNT) continue; // nothing left to fix it with
      expect(o.side0After + o.side1After, o.label).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
      expect(o.side0After, o.label).toBeGreaterThan(0);
      expect(o.side1After, o.label).toBeGreaterThan(0);
    }
  });

  it("keeps seats free for players who have not arrived yet", () => {
    // The house must never be the reason a visitor meets `RoundFull`. The single documented exception
    // is the cover fighter: one bot onto an empty side outranks the reservation, because an
    // unenterable round is bad and an undrawable one is worse. It is recognisable as exactly one entry
    // landing on a side that had nobody on it.
    for (const o of outcomes) {
      const coveringAnEmptySide = o.planned === 1 && (o.side0After === 1 || o.side1After === 1);
      if (coveringAnEmptySide || o.planned === 0) continue;
      if (o.houseAfter <= MIN_FIGHTERS_TO_FIGHT) continue; // the fightability floor also outranks it
      expect(o.freeSeatsAfter, o.label).toBeGreaterThanOrEqual(REAL_SEATS_RESERVED);
    }
  });
});
