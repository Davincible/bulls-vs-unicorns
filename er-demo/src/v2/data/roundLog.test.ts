// The round log is where every leaderboard number comes from, so these tests are mostly about the
// three ways an aggregation like this quietly lies: counting zeroed on-chain array slots as players,
// reading `winner` on a round that hasn't settled, and letting a loss into a wins ticker.

import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { RawFighter, RawRoundAccount } from "../../chain/program.ts";
import { Phase } from "../../chain/constants.ts";
import type { RoundSummary, Side } from "../contract.ts";
import {
  deriveBigWins,
  deriveHall,
  deriveSideRecord,
  deriveStandings,
  summarizeRoundAccount,
} from "./roundLog.ts";

const ARENA = Keypair.generate().publicKey;
const ALICE = Keypair.generate().publicKey;
const BOB = Keypair.generate().publicKey;

function fighter(wallet: PublicKey, side: Side, stake: number, hp: number, banked: number): RawFighter {
  return {
    wallet,
    side,
    dead: hp === 0 ? 1 : 0,
    stake: new BN(stake),
    hp: new BN(hp),
    banked: new BN(banked),
  };
}

/** An empty on-chain slot — `Round.fighters` is a fixed-size array and the tail is all zeroes. */
const EMPTY_SLOT: RawFighter = fighter(PublicKey.default, 0, 0, 0, 0);

function rawRound(over: Partial<RawRoundAccount> = {}): RawRoundAccount {
  return {
    arena: ARENA,
    roundNo: new BN(3),
    phase: Phase.Settled,
    winner: 1,
    bump: 254,
    fighterCount: 2,
    tickCount: new BN(320),
    pot: new BN(300),
    // The extract penalty, added to the program after this fixture was written: `pot` is now
    // `sum(hp + banked) + penaltiesCollected`, so a round's books only balance with this in them.
    penaltiesCollected: new BN(0),
    seedCommit: Array.from({ length: 32 }, () => 1),
    seed: Array.from({ length: 32 }, () => 2),
    // The lobby deadline, added to the program after this fixture was written. A summary derives
    // nothing from it — the log is about what a round DID — but the account carries it now.
    lobbyOpenedAt: new BN(1_699_999_940),
    lobbyClosesAt: new BN(1_700_000_000),
    fightStartedAt: new BN(1_700_000_000),
    fighters: [
      fighter(ALICE, 0, 100, 0, 40),      // lost 60 of a 100 stake
      fighter(BOB, 1, 200, 150, 110),     // ended up 60 ahead
      EMPTY_SLOT,
      EMPTY_SLOT,
    ],
    ...over,
  };
}

describe("summarizeRoundAccount", () => {
  it("reads only the first fighter_count entries, not the zeroed tail", () => {
    const summary = summarizeRoundAccount(rawRound(), ALICE.toBase58());
    expect(summary.players).toHaveLength(2);
    expect(summary.players.map((p) => p.wallet)).toEqual([ALICE.toBase58(), BOB.toBase58()]);
  });

  it("scores a player on hp + banked against the stake the chain stored", () => {
    const [alice, bob] = summarizeRoundAccount(rawRound(), ALICE.toBase58()).players;
    expect(alice.final).toBe(40n);
    expect(alice.pnl).toBe(-60n);
    expect(alice.dead).toBe(true);
    expect(bob.final).toBe(260n);
    expect(bob.pnl).toBe(60n);
  });

  it("marks your own fighter and nobody else's", () => {
    const players = summarizeRoundAccount(rawRound(), BOB.toBase58()).players;
    expect(players.map((p) => p.isYou)).toEqual([false, true]);
  });

  // THE ROUND'S BOOKS AFTER AN EXTRACTION. `extract()` sends a decaying slice of what leaves the
  // ring to the house, so a settled round genuinely holds less than its pot and the old identity
  // `sum(final) === pot` is false — the shortfall is exactly `penaltiesCollected`. A summary that
  // dropped the field would leave every downstream panel unable to explain the gap.
  it("carries what the house took, so a round with an extraction in it still balances", () => {
    // Alice extracted her whole 100 stake at the opening 20%: 80 reached her bank, 20 left the
    // round. Bob never moved. 80 + 200 + 20 = the 300 pot.
    const extracted = rawRound({
      penaltiesCollected: new BN(20),
      fighters: [
        fighter(ALICE, 0, 100, 0, 80),
        fighter(BOB, 1, 200, 200, 0),
        EMPTY_SLOT,
        EMPTY_SLOT,
      ],
    });
    const summary = summarizeRoundAccount(extracted, ALICE.toBase58());
    const held = summary.players.reduce((sum, p) => sum + p.final, 0n);

    expect(summary.penaltiesCollected).toBe(20n);
    expect(held).toBe(280n);
    expect(held + summary.penaltiesCollected).toBe(summary.pot);
    // And the penalty is NOT double-counted against the player who paid it: it never reached her
    // bank, so her P/L already has it in, and re-subtracting it anywhere would show a 40 loss on a
    // fighter who is down 20.
    expect(summary.players[0].pnl).toBe(-20n);
  });

  it("refuses to name a winner before the round settles", () => {
    // `winner` is a u8 that is simply 0 until `resolve()` writes it — read early, every open lobby on
    // the page would claim side 0 had won.
    const lobby = summarizeRoundAccount(rawRound({ phase: Phase.Lobby, winner: 0 }), "");
    expect(lobby.phase).toBe("Lobby");
    expect(lobby.winner).toBeNull();
    expect(summarizeRoundAccount(rawRound(), "").winner).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

function summary(roundNo: number, winner: Side | null, players: [string, Side, number, number][]): RoundSummary {
  return {
    roundNo: BigInt(roundNo),
    phase: winner === null ? "Fight" : "Settled",
    winner,
    pot: players.reduce((sum, [, , stake]) => sum + BigInt(stake), 0n),
    fighterCount: players.length,
    tickCount: 100n,
    // Nobody extracted in these hand-built rounds, so the house took nothing. The aggregations
    // under test never read this field — that is the point of `summarizeRoundAccount`'s note: the
    // penalty is already out of every `final`, so a standing derived from finals is correct with or
    // without it, and the test below proves that rather than assuming it.
    penaltiesCollected: 0n,
    players: players.map(([wallet, side, stake, final]) => ({
      wallet,
      short: wallet,
      name: wallet,
      side,
      stake: BigInt(stake),
      final: BigInt(final),
      pnl: BigInt(final - stake),
      dead: final === 0,
      isYou: false,
    })),
  };
}

const LOG: RoundSummary[] = [
  summary(2, 0, [["alice", 0, 100, 260], ["bob", 1, 100, 0]]),
  summary(1, 1, [["alice", 0, 100, 30], ["bob", 1, 100, 170]]),
];

describe("deriveStandings", () => {
  it("aggregates every round a wallet played, losses included", () => {
    const [first, second] = deriveStandings(LOG);
    expect(first.wallet).toBe("alice");
    expect(first.rounds).toBe(2);
    expect(first.wins).toBe(1);
    expect(first.staked).toBe(200n);
    expect(first.returned).toBe(290n);
    expect(first.pnl).toBe(90n);
    expect(first.best).toBe(160n);
    expect(first.roi).toBeCloseTo(1.45, 12);
    // Sorted by P/L, so the loser is second rather than absent.
    expect(second.wallet).toBe("bob");
    expect(second.pnl).toBe(-30n);
  });

  it("leaves roi null rather than dividing by a zero stake", () => {
    const rows = deriveStandings([summary(1, 0, [["ghost", 0, 0, 0]])]);
    expect(rows[0].roi).toBeNull();
  });
});

describe("deriveBigWins", () => {
  it("carries profits only — it is a WINS ticker", () => {
    const wins = deriveBigWins(LOG);
    expect(wins.every((w) => w.amount > 0n)).toBe(true);
    expect(wins).toHaveLength(2);
  });

  it("is newest round first", () => {
    expect(deriveBigWins(LOG).map((w) => w.roundNo)).toEqual([2n, 1n]);
  });
});

describe("deriveHall", () => {
  it("ranks single-round performances, best first", () => {
    expect(deriveHall(LOG).map((p) => p.pnl)).toEqual([160n, 70n]);
  });
});

describe("deriveSideRecord", () => {
  it("counts rounds won per side", () => {
    expect(deriveSideRecord(LOG)).toEqual({ wins: [1, 1], settled: 2 });
  });

  it("ignores rounds that have not settled — an unfinished round has no winner to count", () => {
    // `summary(_, null, …)` builds a round still in Fight. Counting it would credit side 0 with a
    // win for every lobby on the page, which is the same trap `summarizeRoundAccount` guards.
    const withOpenRound = [...LOG, summary(3, null, [["alice", 0, 100, 100], ["bob", 1, 100, 100]])];
    expect(deriveSideRecord(withOpenRound)).toEqual({ wins: [1, 1], settled: 2 });
  });

  it("reports a genuine 0-0 over an empty log rather than nothing at all", () => {
    // Before the first round settles this is real data, and the scoreboard renders it as such. The
    // "we don't know yet" case is a null record, and that is the provider's call, not this one's.
    expect(deriveSideRecord([])).toEqual({ wins: [0, 0], settled: 0 });
  });

  it("states a coverage that matches what it actually counted", () => {
    const record = deriveSideRecord(LOG);
    expect(record.wins[0] + record.wins[1]).toBe(record.settled);
  });
});
