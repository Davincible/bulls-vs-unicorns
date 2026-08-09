// THE ROUND LOG and everything derived from it — the leaderboards, the wins ticker, the hall.
//
// One rule shapes this whole file (UI-SPEC.md): a standing is derived from the LOG OF ROUNDS, never
// from live balances. A wallet's balance today says nothing about how it got there — it survived,
// which is the definition of survivorship bias — whereas every round account records what each
// fighter put in and what they ended with, losses included. So the aggregation below reads
// `RoundSummary[]` and nothing else, and the same functions run over the fixture's rounds as over
// devnet's, which is what makes the fixture a real rehearsal of the page rather than a drawing of it.
//
// Pure and React-free on purpose: `roundLog.test.ts` exercises it directly, and `useHistory.ts` only
// has to worry about fetching.

import { PHASE_NAME } from "../../chain/constants.ts";
import type { RawRoundAccount } from "../../chain/program.ts";
import {
  nameFor,
  shortKey,
  type BigWin,
  type RoundPlayer,
  type RoundSummary,
  type Side,
  type SideRecord,
  type StandingsRow,
} from "../contract.ts";

/** `Fighter.side` is a `u8` on chain and typed `number` by `chain/useRound.ts`; the program only ever
 *  writes 0 or 1 (`require!(side == 0 || side == 1)`), so this is a narrowing, not a guess. */
export function toSide(side: number): Side {
  return side === 1 ? 1 : 0;
}

/** One round account, straight off the wire, flattened into the shape History/Leaderboard/ticker all
 *  read.
 *
 *  Takes the RAW (Anchor-decoded, BN-carrying) account rather than `chain/useRound.ts`'s `RoundState`
 *  deliberately: `RoundState` is the LIVE round's shape and its converter (`toPlainRound`) is private
 *  to that hook. Going through it here would mean either duplicating that converter or widening a
 *  file this layer only imports from — and the log needs strictly less than it produces (no seed, no
 *  fight clock), so it decodes once, straight to the summary.
 *
 *  `final = hp + banked` is the number that decides everything: what the fighter is worth at the
 *  moment the round is read, whether that value is still in the ring (hp) or already banked by a raid
 *  or an extract. `stake` is already net of the arena fee — the chain stored it that way at `enter()`
 *  — so `pnl` is like-for-like and never double-counts the fee.
 *
 *  THE EXTRACT PENALTY NEEDS NO CORRECTION TO ANY PER-PLAYER FIGURE, and it is worth saying why
 *  rather than leaving the next reader to re-derive it. `extract()` splits what leaves the ring
 *  BEFORE anything reaches the bank (`f.banked += kept`), so `hp + banked` is already net of the
 *  house's cut: every `final`, every `pnl`, and every standing aggregated out of them is correct as
 *  written, and adding the penalty back anywhere would credit a player with money that left the
 *  round. What the penalty DOES break is the round-level identity `sum(final) === pot`, which is
 *  why `penaltiesCollected` is carried through — see `RoundSummary`'s own comment. */
export function summarizeRoundAccount(raw: RawRoundAccount, youPubkey: string): RoundSummary {
  const phase = PHASE_NAME[raw.phase] ?? "Lobby";
  // `fighters` is a fixed-size on-chain array; only the first `fighter_count` entries are real, the
  // rest are zeroed slots that would otherwise show up as a crowd of all-zero players.
  const players: RoundPlayer[] = raw.fighters.slice(0, raw.fighterCount).map((f) => {
    const wallet = f.wallet.toBase58();
    const stake = BigInt(f.stake.toString());
    const final = BigInt(f.hp.toString()) + BigInt(f.banked.toString());
    return {
      wallet,
      short: shortKey(wallet),
      name: nameFor(wallet),
      side: toSide(f.side),
      stake,
      final,
      pnl: final - stake,
      dead: f.dead !== 0,
      isYou: wallet === youPubkey,
    };
  });

  return {
    roundNo: BigInt(raw.roundNo.toString()),
    phase,
    // `Round.winner` is a u8 that is simply 0 until `resolve()` writes it, so reading it before the
    // round settles would report "side 0 won" for every lobby on the page.
    winner: phase === "Settled" ? toSide(raw.winner) : null,
    pot: BigInt(raw.pot.toString()),
    fighterCount: raw.fighterCount,
    tickCount: BigInt(raw.tickCount.toString()),
    penaltiesCollected: BigInt(raw.penaltiesCollected.toString()),
    players,
  };
}

/** Descending bigint compare, written out because `Array.sort`'s comparator wants a `number` and
 *  `Number(a - b)` on two u64-sized values is a precision bug waiting for a big enough pot. */
function descending(a: bigint, b: bigint): number {
  return b > a ? 1 : b < a ? -1 : 0;
}

export function deriveStandings(rounds: RoundSummary[]): StandingsRow[] {
  const by = new Map<string, StandingsRow>();
  for (const round of rounds) {
    for (const p of round.players) {
      const row = by.get(p.wallet) ?? {
        wallet: p.wallet,
        short: p.short,
        name: p.name,
        rounds: 0,
        wins: 0,
        staked: 0n,
        returned: 0n,
        pnl: 0n,
        roi: null,
        best: 0n,
      };
      row.rounds += 1;
      if (round.winner === p.side) row.wins += 1;
      row.staked += p.stake;
      row.returned += p.final;
      row.pnl += p.pnl;
      if (p.pnl > row.best) row.best = p.pnl;
      by.set(p.wallet, row);
    }
  }
  const rows = [...by.values()];
  for (const row of rows) row.roi = row.staked > 0n ? Number(row.returned) / Number(row.staked) : null;
  rows.sort((x, y) => descending(x.pnl, y.pnl));
  return rows;
}

/** THE TWO SIDES' RECORD AGAINST EACH OTHER — see `SideRecord`.
 *
 *  `winner` is the only honest input. It is written by `resolve()` and `summarizeRoundAccount` sets it
 *  to `null` for anything that hasn't settled, so an open lobby and a fight in progress contribute
 *  nothing — the same guard that stops the standings from reporting "side 0 won" for every round on
 *  the page. Nothing here reads `pot` or a fighter: who took the round is a property of the round.
 *
 *  A pot-value tally was considered alongside the count and left out. It is a second, differently
 *  scaled answer to the same question, it needs its own row and its own money formatting wherever it
 *  is shown, and on a field whose one job is to stay readable behind sixteen moving circles the count
 *  is the headline and the second row is what would have made the pair unreadable. */
export function deriveSideRecord(rounds: RoundSummary[]): SideRecord {
  const record: SideRecord = { wins: [0, 0], settled: 0 };
  for (const round of rounds) {
    if (round.phase !== "Settled") continue;
    record.settled += 1;
    if (round.winner !== null) record.wins[round.winner] += 1;
  }
  return record;
}

export function deriveBigWins(rounds: RoundSummary[]): BigWin[] {
  const wins: BigWin[] = [];
  for (const round of rounds) {
    for (const p of round.players) {
      if (p.pnl <= 0n) continue;   // it is a WINS ticker — never push a loss into it
      wins.push({ roundNo: round.roundNo, wallet: p.wallet, name: p.name, side: p.side, amount: p.pnl });
    }
  }
  return wins.sort((a, b) => descending(a.roundNo, b.roundNo));
}

/** Best single-round performances all time. Capped because it feeds a scrolling table, not an
 *  export — nobody reads past forty rows, and the cap keeps the render cheap as the log grows. */
const HALL_SIZE = 40;

export function deriveHall(rounds: RoundSummary[]): RoundPlayer[] {
  return rounds
    .flatMap((r) => r.players)
    .filter((p) => p.pnl > 0n)
    .sort((a, b) => descending(a.pnl, b.pnl))
    .slice(0, HALL_SIZE);
}
