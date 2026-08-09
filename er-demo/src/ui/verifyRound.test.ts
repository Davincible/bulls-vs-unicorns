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
    seedCommit: [],
    seed: Array.from({ length: 32 }, (_, i) => i),
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
    const fighters: FighterState[] = [
      { wallet: pubkey("early"), side: 0, dead: true, stake: 998_000n, hp: 0n, banked: 798_400n },
      { wallet: pubkey("stayed"), side: 1, dead: false, stake: 748_500n, hp: 748_500n, banked: 0n },
    ];
    const result = verifyRound(mockRound(fighters, {
      winner: 0, tickCount: 1400n, pot: 1_746_500n, penaltiesCollected: 199_601n,
    }));

    expect(result.conservationHoldsOnChain).toBe(false);
    expect(result.verdict).toBe("mismatch");
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
