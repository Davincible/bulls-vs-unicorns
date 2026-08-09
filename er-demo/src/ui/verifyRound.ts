// The actual re-verification logic behind VerifyPanel.tsx, kept separate from the component so it's
// a plain function: testable without React, and reusable from a throwaway Node/Bun script against
// real devnet data (see the Phase 5 verification notes for exactly that).
//
// WHAT THIS PROVES, AND WHAT IT CANNOT. `sim/erSim.ts#tick()` is a pure function of (seed, entries,
// steps) — nothing else. Given the chain's own revealed `seed` and `tickCount` (the real `steps`
// value `resolve()` used, per lib.rs's `r.tick_count = steps as u64`) and the entries a round started
// with, replaying it here MUST reproduce the exact same numbers the chain settled to — UNLESS a
// fighter called `extract()` mid-fight. `extract()` is a human, real-time decision; the chain records
// its EFFECT (a fighter ending dead/hp=0 with their hp banked) but not WHEN it happened, so a replay
// that only knows the final seed/entries/steps cannot reconstruct that timing and will diverge from
// the point of extraction onward — not just for the extracted fighter, but for everyone downstream,
// because `tick()` skips any pair involving a dead fighter, which changes which OTHER pairs the same
// hash-selected steps land on for the remainder of the fight.
//
// So a raw "does every number match" check is the wrong tool: an honest extraction and a real bug
// both produce a divergence. Reporting both as the same flat "MISMATCH" is worse than reporting
// nothing — AGENTS.md's own fairness section (search "MISMATCH", "two links") makes exactly this
// point about the mainnet product's verifier: a false mismatch reads as an accusation of cheating.
// This module distinguishes three outcomes instead of two:
//
//   verified          — exact replay, no divergence. Strongest claim this panel can make.
//   extraction-likely — diverges, but in a way `extract()` explains: on-chain value is still fully
//                        conserved ONCE THE HOUSE'S TAKE IS COUNTED (see the note below), AND at least
//                        one fighter's on-chain state (dead, hp=0) doesn't match what the replay
//                        (which has no idea extraction ever happened) computed for them — exactly
//                        the fingerprint `extract()` leaves and `tick()`-only death does not
//                        reliably distinguish from, which is the honest limit of what's checkable
//                        from final state alone.
//   mismatch          — diverges in a way extraction cannot explain: the on-chain fighters themselves
//                        don't conserve value (see below), or the round's own `pot` field disagrees
//                        with the stakes it is supposed to be the sum of (see below), or the numbers
//                        disagree with no fighter carrying the extraction fingerprint at all (wrong
//                        seed, wrong entries, wrong step count, or a genuine algorithm bug).
//
// THE CONSERVATION CHECK HAS A THIRD TERM, and getting this wrong would have been worse than leaving
// the module alone. `extract()` charges a decaying penalty that goes to the house
// (lib.rs `EXTRACT_PENALTY_START_BPS`), so value genuinely LEAVES the round: `sum(hp + banked)` is
// strictly less than the pot on any round where somebody extracted. Checked the old way, every such
// round would fail conservation, and failing conservation is precisely what disqualifies the honest
// "extraction-likely" verdict — so the panel would have reported a flat MISMATCH on exactly the
// rounds this whole three-way distinction was built to protect. The chain records what left, in
// `Round.penalties_collected`, so the identity stays exact and stays checkable.
//
// AND A FOURTH, which is where the house's OTHER take is named. `Round.fees_collected` is the arena's
// entry fee, charged on every `enter` and — until the revision that added the field — recorded
// nowhere at all. The three quantities this module now reports:
//
//     playersHold   = sum(hp + banked)                       still owed to fighters
//     houseTook     = penaltiesCollected + feesCollected     the house's take from this round
//     grossDeposits = pot + feesCollected                    what players were actually charged
//
//     playersHold + houseTook === grossDeposits
//
// SAY PLAINLY WHAT THAT IS. Algebraically it is the old identity with `feesCollected` added to BOTH
// sides — the fee was taken at the door and never entered the ring, so it cancels. It is therefore
// NOT a stronger check, and it cannot be: a verifier that dropped the term from both sides would
// pass and fail on exactly the same rounds this one does. Two things it does buy, neither of them a
// stronger check and both worth the term:
//
//   * `pot` stops being mistakable for what players paid. `pot` is the sum of NET stakes. A panel
//     that puts it on screen labelled "staked" is understating every entry by the fee.
//   * `houseTook` becomes a named quantity that every verifier computes the same way, instead of a
//     subtraction each one performs differently — or, as was the case here and in three of the four
//     devnet scripts, performs as `penaltiesCollected` alone and misses half the answer.
//
// WHAT ACTUALLY PINS THE FEE IS NOT THIS IDENTITY, and pretending otherwise would be the more
// dangerous kind of check — one that looks like evidence and is not. Because the fee cancels, a
// round whose `feesCollected` is flatly wrong still satisfies the identity above, and
// `verifyRound.test.ts` asserts that limit out loud so nobody later mistakes a passing panel for a
// verified fee. The fee is pinned instead at the point of collection: lib.rs's `Entered` event
// publishes the gross and the fee per entry, and its `the_fee_is_recorded_rather_than_discarded`
// test asserts `credit_entry` against a known gross. Neither is reachable from a settled round
// account, which is all this module is given.
//
// The falsifiable half of the identity is the pair underneath it, and the first of these is the one
// the verdict turns on:
//
//     playersHold + penaltiesCollected === pot    the ring conserves against the NET pot
//     pot + feesCollected === grossDeposits       the gross is the pot plus the fee (definitional)
//
// A round with no extractions and no fee has both terms at zero and this reduces to the original
// check, which is why the oldest fixtures in verifyRound.test.ts still read the same.
//
// AND ONE MORE FACT, THE ONLY ONE HERE CHECKED AGAINST ITSELF. Every quantity above is read off the
// round account once and taken at its word — there is nothing else on the account to weigh it
// against. `pot` is the exception: the account stores it TWICE, once as `Round.pot` and once,
// implicitly, as the sum of the per-fighter `stake` fields. Two independent recordings of one
// quantity can be compared, and until now this module summed the stakes and never once looked at
// `Round.pot` — declining a check that costs nothing and can actually come out false.
//
//     potRecordedOnChain === potOnChain           the account agrees with itself about the pot
//
// IT GATES THE VERDICT, in the same guard as conservation, because it fails for the same kind of
// reason conservation does: a human pressing Extract cannot produce it. lib.rs writes `pot` in
// exactly one place — `credit_entry`, which adds the same `net` to `r.pot` and to that fighter's
// `stake` in adjacent statements, on a first entry and on a top-up alike — and `open_round` zeroes
// `pot` and `fighter_count` together, so an empty round satisfies it too. Nothing else in the
// program touches either field: `extract` moves value between `hp`, `banked` and
// `penalties_collected`; `advance_fight`/`resolve` move `hp` and `banked`; `set_fee_bps` changes
// what future entries are charged, which reaches `pot` and `stake` only back through
// `credit_entry`, still by the same `net`. So there is no legitimate path — top-up, mid-lobby
// re-price, abandonment, sweep — on which these two diverge, and a round where they do is not a
// round any extraction story explains. Letting such a round be labelled "extraction-likely" would
// be laundering an internally contradictory account through the one verdict this panel offers as
// an innocent explanation.
//
// IT DOES NOT DISQUALIFY `verified`, and that asymmetry is a decision, not an oversight. `verified`
// is a claim about the REPLAY — that re-running the algorithm reproduced the chain's numbers
// exactly — and the replay is driven by the `stake` fields, never by `pot`. An exact replay is
// exactly as true on a round whose `pot` field is wrong, so demoting it to "mismatch" would print
// prose saying the on-chain state "disagrees with an independent replay" directly above a table in
// which every row agrees: a false accusation of precisely the kind the top of this comment exists
// to prevent. `conservationHoldsOnChain` is scoped the same way for the same reason. What the flag
// gets instead is unconditional reporting — VerifyPanel.tsx states the cross-check on every round,
// passing or failing — so a disagreement is never hidden behind a passing verdict. It is simply not
// called a replay failure, because it is not one.

import type { RoundState } from "../chain/useRound.ts";
import { settle, type ERFighter } from "../sim/erSim.ts";
import { runFullFight, type HitEventEntry } from "../sim/hitEvents.ts";

export interface FighterComparison {
  wallet: string;
  side: 0 | 1;
  onChain: { hp: bigint; banked: bigint; dead: boolean };
  recomputed: { hp: bigint; banked: bigint; dead: boolean };
  /** Every field above agrees, exactly. */
  matches: boolean;
  /** This fighter's on-chain state (dead, hp=0, some banked amount) doesn't match the pure replay
   *  AND is the shape only `extract()` or a natural `tick()` kill can produce — the direct signature
   *  a mid-fight extraction leaves behind. Never true when `matches` is true. */
  extractionSignature: boolean;
}

export type VerifyVerdict = "verified" | "extraction-likely" | "mismatch";

export interface VerifyResult {
  verdict: VerifyVerdict;
  steps: number;
  seedHex: string;
  winnerOnChain: 0 | 1;
  winnerRecomputed: 0 | 1;
  winnerMatches: boolean;
  fighters: FighterComparison[];
  /** The NET pot — `sum(f.stake)`, which is what the fighters were credited with, the fee already
   *  taken. Summed from the fighter array rather than read from `round.pot` so it is derived from the
   *  same rows every other number here is derived from — and that choice is now free of consequence
   *  rather than merely defensible, because `potMatchesStakesOnChain` below compares the two, so on
   *  any round this module reports as anything other than a mismatch they are the same number. */
  potOnChain: bigint;
  /** `Round.pot`: the round account's OWN record of the same quantity, kept by the program as a
   *  running total rather than recomputed from the fighters. Reported beside `potOnChain` so a panel
   *  can show that the account was cross-examined, not just read. */
  potRecordedOnChain: bigint;
  /** `potRecordedOnChain === potOnChain` — the account's two independent recordings of the pot agree.
   *
   *  The one check here whose both operands are on-chain facts about the same quantity, which is why
   *  it can be false at all. Not breakable by a human pressing Extract: `pot` and `stake` are written
   *  only by lib.rs's `credit_entry`, by the same amount, in adjacent statements. It therefore gates
   *  the verdict exactly as `conservationHoldsOnChain` does — and, exactly as with that flag, only
   *  the `extraction-likely` branch. The module header argues both halves of that. */
  potMatchesStakesOnChain: boolean;
  /** sum(on-chain hp + banked) across fighters — what the TABLE still holds. On a round where
   *  somebody extracted this is legitimately LESS than `potOnChain`, by exactly
   *  `penaltiesCollectedOnChain`. */
  totalValueOnChain: bigint;
  /** `Round.penalties_collected`: what the house took in extract penalties. Zero on a round nobody
   *  extracted from. Exposed so a panel can show the difference rather than leaving a viewer to
   *  wonder why the two numbers above disagree. */
  penaltiesCollectedOnChain: bigint;
  /** `Round.fees_collected`: the entry fee this round charged, over every entry and top-up. Zero on
   *  a round read from a program revision that predates the field — which is the true value there,
   *  since that revision recorded no fee anywhere (see `bnOr0` in chain/program.ts).
   *
   *  Reported, but NOT checkable from this account: it cancels out of the identity below. See the
   *  module header for where it is actually pinned. */
  feesCollectedOnChain: bigint;
  /** `penaltiesCollectedOnChain + feesCollectedOnChain` — the whole of the house's take from this
   *  round, in one number, so no caller has to remember there are two sources. */
  houseTookOnChain: bigint;
  /** `potOnChain + feesCollectedOnChain` — what players were actually charged to be here, as opposed
   *  to what is being fought over. This is the number a panel should show beside the word "staked". */
  grossDepositsOnChain: bigint;
  /** `totalValueOnChain + houseTookOnChain === grossDepositsOnChain`.
   *
   *  Exact, and not something a human pressing Extract can break. Identical in force to the old
   *  `totalValue + penalties === pot` — the fee sits on both sides and cancels — so this flag still
   *  falsifies exactly one thing: that the ring conserves against the net pot. The module header
   *  spells out why the fee is carried anyway and what does pin it. */
  conservationHoldsOnChain: boolean;
}

/** True for a fighter whose on-chain state is exactly what `extract()` (or a natural `tick()` kill)
 *  leaves behind: out of the fight, nothing left in play. Both mechanisms produce this same shape —
 *  final state alone can't tell them apart, which is the honest limit this module works within. */
function isOutOfPlay(f: { hp: bigint; dead: boolean }): boolean {
  return f.dead && f.hp === 0n;
}

/** Re-derives a round's outcome independently from its own revealed on-chain seed, entries, and step
 *  count, and diffs the result against what the chain actually settled to. Pure — no network, no
 *  React — so it can run identically inside the panel and inside a standalone verification script. */
export function verifyRound(round: RoundState): VerifyResult {
  const seed = Buffer.from(round.seed);
  const entries: HitEventEntry[] = round.fighters.map((f) => ({
    wallet: f.wallet.toBase58(),
    side: f.side as 0 | 1,
    stake: f.stake,
  }));
  const steps = Number(round.tickCount);

  const { round: recomputed } = runFullFight(seed, entries, steps);
  const winnerRecomputed = settle(recomputed); // runFullFight stops after tick()s; settle() is ours to call.

  const potOnChain = round.fighters.reduce((sum, f) => sum + f.stake, 0n);
  const potRecordedOnChain = round.pot;
  const potMatchesStakesOnChain = potRecordedOnChain === potOnChain;
  const totalValueOnChain = round.fighters.reduce((sum, f) => sum + f.hp + f.banked, 0n);
  const penaltiesCollectedOnChain = round.penaltiesCollected;
  const feesCollectedOnChain = round.feesCollected;
  const houseTookOnChain = penaltiesCollectedOnChain + feesCollectedOnChain;
  const grossDepositsOnChain = potOnChain + feesCollectedOnChain;
  const conservationHoldsOnChain = totalValueOnChain + houseTookOnChain === grossDepositsOnChain;

  const recomputedByKey = new Map<string, ERFighter>(
    recomputed.fighters.map((f) => [`${f.wallet}:${f.side}`, f]),
  );

  const fighters: FighterComparison[] = round.fighters.map((f) => {
    const r = recomputedByKey.get(`${f.wallet.toBase58()}:${f.side}`);
    const recomputedState = { hp: r?.hp ?? 0n, banked: r?.banked ?? 0n, dead: r?.dead === 1 };
    const onChainState = { hp: f.hp, banked: f.banked, dead: f.dead };
    const matches =
      onChainState.hp === recomputedState.hp &&
      onChainState.banked === recomputedState.banked &&
      onChainState.dead === recomputedState.dead;
    return {
      wallet: f.wallet.toBase58(),
      side: f.side as 0 | 1,
      onChain: onChainState,
      recomputed: recomputedState,
      matches,
      extractionSignature: !matches && isOutOfPlay(onChainState),
    };
  });

  const winnerOnChain: 0 | 1 = round.winner === 1 ? 1 : 0;
  const winnerMatches = winnerOnChain === winnerRecomputed;
  const allFightersMatch = fighters.every((f) => f.matches);
  // At least one fighter's divergence is the specific shape extraction leaves. Once that's true, the
  // OTHER fighters are allowed to diverge too without their own extraction signature — a single
  // extraction reshapes every subsequent pairing for the whole rest of the fight (see module header)
  // — so ripple-only divergence on other fighters doesn't need its own separate signature to count.
  const anyExtractionSignature = fighters.some((f) => f.extractionSignature);

  let verdict: VerifyVerdict;
  if (winnerMatches && allFightersMatch) {
    verdict = "verified";
  } else if (conservationHoldsOnChain && potMatchesStakesOnChain && anyExtractionSignature) {
    // `potMatchesStakesOnChain` sits beside conservation rather than in its own branch because it
    // disqualifies the extraction story for the same reason: extraction moves value between `hp`,
    // `banked` and `penalties_collected` and never writes `pot` or any `stake`, so an account that
    // disagrees with itself about its own pot is not something a player's mid-fight decision can
    // have caused. It is deliberately absent from the `verified` branch above — see the module
    // header for why an exact replay stays exact regardless of what `Round.pot` says.
    verdict = "extraction-likely";
  } else {
    verdict = "mismatch";
  }

  return {
    verdict,
    steps,
    seedHex: seed.toString("hex"),
    winnerOnChain,
    winnerRecomputed,
    winnerMatches,
    fighters,
    potOnChain,
    potRecordedOnChain,
    potMatchesStakesOnChain,
    totalValueOnChain,
    penaltiesCollectedOnChain,
    feesCollectedOnChain,
    houseTookOnChain,
    grossDepositsOnChain,
    conservationHoldsOnChain,
  };
}
