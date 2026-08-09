// Proves verifyRound.ts's three-way verdict (verified / extraction-likely / mismatch) against real
// ground truth, not invented numbers:
//   - the "verified" case reuses the exact checked-in parity fixture from sim/hitEvents.test.ts
//     (seed 0..32, 4 fighters, 50 steps, no extraction) — the same fixture
//     `programs/bulls-arena/gen-parity-fixture.mjs` generated and the Rust program's own
//     `parity_tests::run_fight_matches_the_typescript_mirror_exactly` checks against.
//   - the "extraction-likely" case reuses the REAL numbers read off devnet round #8
//     (EBsoVPkgHshqsh3vUFX33WMXUafNZKVRVcMwXipG1bkD) via a throwaway fetch against
//     `chain/program.ts#createProgram` — player A (side 0) extracted immediately after Fight phase
//     began, before any hit landed; player B (side 1) was never touched. Recorded here as a literal
//     fixture so this test doesn't depend on live devnet or burn SOL to run.
//   - the "mismatch" cases are synthetic on purpose — there is no way to observe an actual bug in
//     real on-chain data (if there were, it'd be a production incident, not a fixture) — so these
//     construct the two distinct ways a divergence can fail to be extraction-explained: broken value
//     conservation, and a divergence with no fighter carrying the extraction fingerprint at all.
import { describe, expect, test } from "vitest";
import type { PublicKey } from "@solana/web3.js";
import type { RoundState, FighterState } from "../chain/useRound.ts";
import { verifyRound } from "./verifyRound.ts";

function pubkey(base58: string): PublicKey {
  return { toBase58: () => base58 } as PublicKey;
}

function mockRound(fighters: FighterState[], overrides: Partial<RoundState> = {}): RoundState {
  return {
    arena: pubkey("arena"),
    roundNo: 1n,
    phase: 3,
    phaseName: "Settled",
    winner: 0,
    fighterCount: fighters.length,
    tickCount: 50n,
    pot: fighters.reduce((n, f) => n + f.stake, 0n),
    penaltiesCollected: 0n,
    // Both default to the pre-fee state, which is a real state and not merely a convenient one: a
    // round read from a program revision older than this build decodes both as absent, and
    // `chain/program.ts#bnOr0` turns that into exactly these values.
    feesCollected: 0n,
    houseSwept: false,
    seedCommit: [],
    seed: Array.from({ length: 32 }, (_, i) => i),
    // The lobby deadline. Verification never reads it — a settled round is checked against its seed
    // and its fighters — but `RoundState` carries it, so the fixture has to be a whole round.
    lobbyOpenedAt: 1_700_000_000n,
    lobbyClosesAt: 1_700_000_060n,
    fightStartedAt: 0n,
    fighters,
    ...overrides,
  };
}

describe("verifyRound — verified", () => {
  test("an exact replay of the checked-in parity fixture reports 'verified'", () => {
    // From sim/hitEvents.test.ts's EXPECTED_FIGHTERS / EXPECTED_WINNER, 50 steps, no extraction.
    const fighters: FighterState[] = [
      { wallet: pubkey("w1"), side: 0, dead: false, stake: 100_000n, hp: 15_158n, banked: 84_062n },
      { wallet: pubkey("w2"), side: 0, dead: false, stake: 250_000n, hp: 201_600n, banked: 116_021n },
      { wallet: pubkey("w3"), side: 1, dead: false, stake: 180_000n, hp: 26_975n, banked: 48_467n },
      { wallet: pubkey("w4"), side: 1, dead: false, stake: 90_000n, hp: 42_942n, banked: 84_775n },
    ];
    const result = verifyRound(mockRound(fighters, { winner: 0, tickCount: 50n }));

    expect(result.verdict).toBe("verified");
    expect(result.winnerMatches).toBe(true);
    expect(result.conservationHoldsOnChain).toBe(true);
    expect(result.fighters.every((f) => f.matches)).toBe(true);
    expect(result.fighters.every((f) => !f.extractionSignature)).toBe(true);
  });
});

describe("verifyRound — extraction-likely", () => {
  test("real devnet round #8 (player A extracted immediately) reports 'extraction-likely', not a false mismatch", () => {
    // Literal values read from EBsoVPkgHshqsh3vUFX33WMXUafNZKVRVcMwXipG1bkD via
    // program.account.round.fetch() this session — see the module header for provenance.
    const fighters: FighterState[] = [
      {
        wallet: pubkey("9duJN2PuHUBrS5cnsUqfcTE749Ec8sLc1LPT67SFASPi"),
        side: 0, dead: true, stake: 998_000n, hp: 0n, banked: 998_000n,
      },
      {
        wallet: pubkey("DsajoTfWPrLqKQLigdfjHAAvrKP3ugWcdxhuwHUg5GAk"),
        side: 1, dead: false, stake: 748_500n, hp: 748_500n, banked: 0n,
      },
    ];
    const seedHex = "38a5fb603a9eb735567d64543f7fa2288b96a147efef11c33e378bd1e5a2188c";
    const seed = Array.from(Buffer.from(seedHex, "hex"));
    const result = verifyRound(mockRound(fighters, { winner: 0, tickCount: 1400n, seed, pot: 1_746_500n }));

    expect(result.verdict).toBe("extraction-likely");
    // Conservation holds on the real on-chain numbers — extraction moved value, it didn't lose any.
    expect(result.conservationHoldsOnChain).toBe(true);
    expect(result.totalValueOnChain).toBe(1_746_500n);
    // The extracted fighter (dead, hp=0, banked = their full stake, landed zero real hits) carries
    // the direct fingerprint; the untouched opponent does not need to on its own.
    expect(result.fighters[0].extractionSignature).toBe(true);
    expect(result.fighters[0].onChain).toEqual({ hp: 0n, banked: 998_000n, dead: true });
    // The pure replay (which doesn't know extraction happened) disagrees with the chain on who won —
    // a real, honest divergence, and exactly the case a flat "MISMATCH" label would misrepresent.
    expect(result.winnerMatches).toBe(false);
  });

  test("a round where the house took an extract penalty still conserves, and is not a false mismatch", () => {
    // THE REGRESSION THIS FILE EXISTS TO CATCH FROM NOW ON. `extract()` charges a decaying penalty
    // that leaves the round (lib.rs `EXTRACT_PENALTY_START_BPS`), so `sum(hp + banked)` is strictly
    // BELOW the pot here. Under the old two-term check that read as broken conservation, which
    // disqualifies the honest "extraction-likely" verdict and reports a flat MISMATCH — an
    // accusation of cheating, on a round where the chain did exactly what it says it does.
    //
    // Same shape as devnet round #8 above, re-priced: a fighter with 998,000 in the ring extracting
    // at cursor 0 of a two-fighter round pays 20% (horizon 71 steps, so the rate is at its start
    // value), banking 798,400 and leaving 199,600 with the house.
    const fighters: FighterState[] = [
      { wallet: pubkey("early"), side: 0, dead: true, stake: 998_000n, hp: 0n, banked: 798_400n },
      { wallet: pubkey("stayed"), side: 1, dead: false, stake: 748_500n, hp: 748_500n, banked: 0n },
    ];
    const result = verifyRound(mockRound(fighters, {
      winner: 0, tickCount: 1400n, pot: 1_746_500n, penaltiesCollected: 199_600n,
    }));

    expect(result.penaltiesCollectedOnChain).toBe(199_600n);
    expect(result.totalValueOnChain).toBe(1_546_900n);
    expect(result.totalValueOnChain).toBeLessThan(result.potOnChain);
    expect(result.conservationHoldsOnChain).toBe(true);
    expect(result.verdict).toBe("extraction-likely");
  });

  test("a penalty larger than the value actually missing is still a real mismatch", () => {
    // The third term must not become a licence to explain away any shortfall: it is checked as an
    // exact identity, so a `penaltiesCollected` that doesn't account for the gap fails, in either
    // direction. Same fighters as above, with the house claiming 1 lamport more than it took.
    //
    // WITH A NON-ZERO FEE IN PLAY, deliberately. The fee sits on BOTH sides of the identity and
    // cancels, so this same off-by-one must still be caught with a fee present — and it would NOT be
    // if the identity were ever implemented with the fee added to one side only. That is not a
    // theoretical slip: `houseTook` and `grossDeposits` are two separate expressions and a term
    // dropped from either reads as a plausible line of code.
    const fighters: FighterState[] = [
      { wallet: pubkey("early"), side: 0, dead: true, stake: 998_000n, hp: 0n, banked: 798_400n },
      { wallet: pubkey("stayed"), side: 1, dead: false, stake: 748_500n, hp: 748_500n, banked: 0n },
    ];
    const result = verifyRound(mockRound(fighters, {
      winner: 0, tickCount: 1400n, pot: 1_746_500n, penaltiesCollected: 199_601n, feesCollected: 3_500n,
    }));

    expect(result.conservationHoldsOnChain).toBe(false);
    expect(result.verdict).toBe("mismatch");
  });
});

// THE HOUSE'S BOOKS — both sources of the take, on one round, against arithmetic a reader can check.
//
// The fixture is the devnet round #8 lineup at its real gross prices. Those two net stakes are what a
// 20 bps arena produces from 1,000,000 and 750,000: 1_000_000 - 2_000 = 998_000 and
// 750_000 - 1_500 = 748_500. So `feesCollected` is 3_500 as a matter of the published rate, and
// `grossDeposits` comes back as 1_750_000 — the two gross entries, added up, arrived at from the
// opposite direction. That is the point of carrying the fee: the pot alone (1_746_500) is not what
// anybody paid, and no amount of staring at it reveals the 3,500 that went to the house at the door.
describe("verifyRound — the house's take", () => {
  const fighters: FighterState[] = [
    { wallet: pubkey("early"), side: 0, dead: true, stake: 998_000n, hp: 0n, banked: 798_400n },
    { wallet: pubkey("stayed"), side: 1, dead: false, stake: 748_500n, hp: 748_500n, banked: 0n },
  ];
  const overrides = { winner: 0 as const, tickCount: 1400n, pot: 1_746_500n };

  test("a round with both a fee and a penalty reports the full identity, and it balances", () => {
    const result = verifyRound(mockRound(fighters, {
      ...overrides, penaltiesCollected: 199_600n, feesCollected: 3_500n,
    }));

    expect(result.potOnChain).toBe(1_746_500n);          // net — what is being fought over
    expect(result.grossDepositsOnChain).toBe(1_750_000n); // gross — 1,000,000 + 750,000, as charged
    expect(result.feesCollectedOnChain).toBe(3_500n);
    expect(result.penaltiesCollectedOnChain).toBe(199_600n);
    expect(result.houseTookOnChain).toBe(203_100n);       // both sources, which neither alone is

    // playersHold + houseTook === grossDeposits, spelled out rather than asserted via the flag, so a
    // reader can see the three numbers meet.
    expect(result.totalValueOnChain + result.houseTookOnChain).toBe(result.grossDepositsOnChain);
    expect(result.conservationHoldsOnChain).toBe(true);
    expect(result.verdict).toBe("extraction-likely");
  });

  // A ROUND FROM THE PROGRAM THAT IS ACTUALLY DEPLOYED, which is the case this panel spends most of
  // its life in and the one a new term is most likely to break.
  //
  // The served IDL is a contract with the DEPLOYED program, and that program's `Round` has no
  // `fees_collected` at all — Anchor hands back `undefined`, `chain/program.ts#bnOr0` turns it into
  // `0n`, and the identity must degenerate cleanly to the two-term check today's rounds satisfy.
  // A verifier that needed a fee to balance would paint "BROKEN" across every live round on the page
  // — a panel whose entire job is looking trustworthy, accusing the chain of losing money because a
  // field had not shipped yet. That is the failure this test exists to make impossible.
  test("a round from a deployment with no fee field at all still verifies, with no false alarm", () => {
    const noFeeYet = verifyRound(mockRound(fighters, {
      ...overrides, penaltiesCollected: 199_600n, feesCollected: 0n,
    }));

    expect(noFeeYet.feesCollectedOnChain).toBe(0n);
    expect(noFeeYet.grossDepositsOnChain).toBe(noFeeYet.potOnChain);   // no fee, so gross IS the pot
    expect(noFeeYet.houseTookOnChain).toBe(noFeeYet.penaltiesCollectedOnChain);
    expect(noFeeYet.conservationHoldsOnChain).toBe(true);
    expect(noFeeYet.verdict).toBe("extraction-likely");   // never "mismatch"
  });

  test("a WRONG feesCollected still satisfies the identity — the limit, asserted so nobody mistakes it", () => {
    // This is a characterisation test of something the verifier CANNOT do, and it earns its place by
    // being the only thing standing between a future reader and the wrong conclusion.
    //
    // The fee cancels. It is added to `houseTook` and to `grossDeposits` alike, because it never
    // entered the ring — it was taken at the door, and `pot` was already net of it. So a round
    // claiming a fee ten times the truth balances exactly as well as an honest one, and the panel
    // will say "holds". That is not a bug in the check; it is the arithmetic, and lib.rs's
    // `Round.fees_collected` doc comment says the same thing about the same identity.
    //
    // WHERE THE FEE IS ACTUALLY PINNED, since it is not here: at the point of collection. lib.rs's
    // `Entered` event publishes the gross and the fee for each entry, and
    // `the_fee_is_recorded_rather_than_discarded` asserts `credit_entry` against a known gross stake.
    // Neither is reachable from a settled round account, which is all this module is ever given.
    //
    // If someone later makes this test fail by finding a genuine round-level check on the fee, that
    // is a good day — delete the test and keep the check. What must not happen is the check being
    // BELIEVED to exist because the panel reports a fee beside a green "holds".
    const honest = verifyRound(mockRound(fighters, {
      ...overrides, penaltiesCollected: 199_600n, feesCollected: 3_500n,
    }));
    const nonsense = verifyRound(mockRound(fighters, {
      ...overrides, penaltiesCollected: 199_600n, feesCollected: 35_000n,
    }));

    expect(honest.conservationHoldsOnChain).toBe(true);
    expect(nonsense.conservationHoldsOnChain).toBe(true);
    expect(nonsense.verdict).toBe(honest.verdict);
    // The two rounds differ in exactly the two derived figures, and in nothing that is checked.
    expect(nonsense.houseTookOnChain).toBe(234_600n);
    expect(nonsense.grossDepositsOnChain).toBe(1_781_500n);
  });
});

// THE ACCOUNT CROSS-EXAMINED AGAINST ITSELF. `Round.pot` and the per-fighter `stake` fields are two
// independent recordings of one quantity — lib.rs's `credit_entry` adds the same `net` to both, in
// adjacent statements, and nothing else in the program writes either — so they must agree, and this
// is the only check on this panel whose two operands are both on-chain facts. Every other fixture in
// this file carries a `pot` that already agrees (mockRound defaults to the sum), which is why the
// three below have to set it wrong on purpose to say anything.
describe("verifyRound — the recorded pot against the stakes it is the sum of", () => {
  // The parity fixture, again: 100_000 + 250_000 + 180_000 + 90_000 = 620_000.
  const cleanFighters: FighterState[] = [
    { wallet: pubkey("w1"), side: 0, dead: false, stake: 100_000n, hp: 15_158n, banked: 84_062n },
    { wallet: pubkey("w2"), side: 0, dead: false, stake: 250_000n, hp: 201_600n, banked: 116_021n },
    { wallet: pubkey("w3"), side: 1, dead: false, stake: 180_000n, hp: 26_975n, banked: 48_467n },
    { wallet: pubkey("w4"), side: 1, dead: false, stake: 90_000n, hp: 42_942n, banked: 84_775n },
  ];

  test("a round whose recorded pot equals its summed stakes reports the two agreeing", () => {
    const result = verifyRound(mockRound(cleanFighters, { winner: 0, tickCount: 50n, pot: 620_000n }));

    expect(result.potRecordedOnChain).toBe(620_000n);
    expect(result.potOnChain).toBe(620_000n);
    expect(result.potMatchesStakesOnChain).toBe(true);
    expect(result.verdict).toBe("verified");
  });

  // WHAT THE NEW CHECK IS FOR, and the pairing is the whole test: the two rounds differ in one
  // lamport of `Round.pot` and in nothing else. The first is the real devnet #8 extraction, which
  // this file already proves comes back "extraction-likely". The second is the same round with a pot
  // that contradicts its own stakes — and it must not be laundered through the innocent verdict,
  // because extraction moves value between `hp`, `banked` and `penalties_collected` and cannot write
  // `pot` or a `stake` at all.
  test("a recorded pot that contradicts the stakes disqualifies 'extraction-likely'", () => {
    const extracted: FighterState[] = [
      { wallet: pubkey("early"), side: 0, dead: true, stake: 998_000n, hp: 0n, banked: 998_000n },
      { wallet: pubkey("stayed"), side: 1, dead: false, stake: 748_500n, hp: 748_500n, banked: 0n },
    ];
    const seed = Array.from(
      Buffer.from("38a5fb603a9eb735567d64543f7fa2288b96a147efef11c33e378bd1e5a2188c", "hex"),
    );
    const base = { winner: 0 as const, tickCount: 1400n, seed };

    const honest = verifyRound(mockRound(extracted, { ...base, pot: 1_746_500n }));
    const contradictory = verifyRound(mockRound(extracted, { ...base, pot: 1_746_501n }));

    expect(honest.potMatchesStakesOnChain).toBe(true);
    expect(honest.verdict).toBe("extraction-likely");

    expect(contradictory.potMatchesStakesOnChain).toBe(false);
    expect(contradictory.verdict).toBe("mismatch");
    // The new flag is the SOLE cause. Conservation still holds and a fighter still carries the
    // extraction fingerprint, so under the previous guard this round would have come back
    // "extraction-likely" — an account that disagrees with itself, reported as an honest early exit.
    expect(contradictory.conservationHoldsOnChain).toBe(true);
    expect(contradictory.fighters.some((f) => f.extractionSignature)).toBe(true);
  });

  // THE ASYMMETRY, PINNED, because it is a decision and not an oversight and the next reader will
  // reasonably wonder. `verified` is a claim about the REPLAY, and the replay is driven by the
  // `stake` fields — `Round.pot` is never an input to it. An exact replay is exactly as exact on a
  // round whose `pot` field is wrong, and demoting it to "mismatch" would print prose about
  // disagreeing with an independent replay above a table in which every row agrees. The flag is
  // reported instead, and VerifyPanel.tsx shows it on every round, so nothing is hidden.
  test("an exact replay stays 'verified' when only the recorded pot is wrong, and still reports it", () => {
    const result = verifyRound(mockRound(cleanFighters, { winner: 0, tickCount: 50n, pot: 620_001n }));

    expect(result.potMatchesStakesOnChain).toBe(false);
    expect(result.potRecordedOnChain).toBe(620_001n);
    expect(result.verdict).toBe("verified");
    expect(result.fighters.every((f) => f.matches)).toBe(true);
  });
});

describe("verifyRound — mismatch (not explainable by extraction)", () => {
  test("on-chain value that doesn't conserve is reported as a real mismatch, never as extraction", () => {
    const fighters: FighterState[] = [
      { wallet: pubkey("w1"), side: 0, dead: false, stake: 100_000n, hp: 15_158n, banked: 84_062n },
      { wallet: pubkey("w2"), side: 0, dead: false, stake: 250_000n, hp: 201_600n, banked: 116_021n },
      { wallet: pubkey("w3"), side: 1, dead: false, stake: 180_000n, hp: 26_975n, banked: 48_467n },
      // banked inflated by 999_999 with nothing removed elsewhere — value created from nowhere,
      // which neither tick() nor extract() can ever do.
      { wallet: pubkey("w4"), side: 1, dead: false, stake: 90_000n, hp: 42_942n, banked: 84_775n + 999_999n },
    ];
    const result = verifyRound(mockRound(fighters, { winner: 0, tickCount: 50n }));

    expect(result.verdict).toBe("mismatch");
    expect(result.conservationHoldsOnChain).toBe(false);
  });

  test("a divergence with no fighter carrying the extraction fingerprint is reported as mismatch", () => {
    // Same fixture as the 'verified' test, but claiming a step count the chain never actually ran
    // (wrong tickCount) — every number moves, conservation still holds (nothing here breaks it), but
    // nobody ends up dead/hp=0 in a way that doesn't also match the replay's own ending state, so
    // there's no honest extraction story available: this is what a wrong seed/entries/steps looks
    // like, and it must not be laundered into "probably just an extraction".
    const fighters: FighterState[] = [
      { wallet: pubkey("w1"), side: 0, dead: false, stake: 100_000n, hp: 15_158n, banked: 84_062n },
      { wallet: pubkey("w2"), side: 0, dead: false, stake: 250_000n, hp: 201_600n, banked: 116_021n },
      { wallet: pubkey("w3"), side: 1, dead: false, stake: 180_000n, hp: 26_975n, banked: 48_467n },
      { wallet: pubkey("w4"), side: 1, dead: false, stake: 90_000n, hp: 42_942n, banked: 84_775n },
    ];
    const result = verifyRound(mockRound(fighters, { winner: 0, tickCount: 49n }));

    expect(result.verdict).toBe("mismatch");
    expect(result.conservationHoldsOnChain).toBe(true);
    expect(result.fighters.some((f) => f.extractionSignature)).toBe(false);
  });
});
