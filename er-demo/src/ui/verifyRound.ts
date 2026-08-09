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
//   mismatch          — diverges in a way extraction cannot explain: either the on-chain fighters
//                        themselves don't conserve value (see below), or the numbers disagree with no
//                        fighter carrying the extraction fingerprint at all (wrong seed, wrong
//                        entries, wrong step count, or a genuine algorithm bug).
//
// THE CONSERVATION CHECK HAS A THIRD TERM NOW, and getting this wrong would have been worse than
// leaving the module alone. `extract()` charges a decaying penalty that goes to the house
// (lib.rs `EXTRACT_PENALTY_START_BPS`), so value genuinely LEAVES the round: `sum(hp + banked)` is
// strictly less than the pot on any round where somebody extracted. Checked the old way, every such
// round would fail conservation, and failing conservation is precisely what disqualifies the honest
// "extraction-likely" verdict — so the panel would have reported a flat MISMATCH on exactly the
// rounds this whole three-way distinction was built to protect. The chain records what left, in
// `Round.penalties_collected`, so the identity stays exact and stays checkable:
//
//     sum(hp + banked) + penaltiesCollected == pot
//
// A round with no extractions has `penaltiesCollected == 0` and this reduces to the old check, which
// is why the pre-penalty fixtures in verifyRound.test.ts still read the same.

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
  potOnChain: bigint;
  /** sum(on-chain hp + banked) across fighters — what the TABLE still holds. On a round where
   *  somebody extracted this is legitimately LESS than `potOnChain`, by exactly
   *  `penaltiesCollectedOnChain`. */
  totalValueOnChain: bigint;
  /** `Round.penalties_collected`: what the house took in extract penalties. Zero on a round nobody
   *  extracted from. Exposed so a panel can show the difference rather than leaving a viewer to
   *  wonder why the two numbers above disagree. */
  penaltiesCollectedOnChain: bigint;
  /** `totalValueOnChain + penaltiesCollectedOnChain === potOnChain`. Still exact, still not something
   *  a human pressing Extract can break — see the module header. */
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
  const totalValueOnChain = round.fighters.reduce((sum, f) => sum + f.hp + f.banked, 0n);
  const penaltiesCollectedOnChain = round.penaltiesCollected;
  const conservationHoldsOnChain = totalValueOnChain + penaltiesCollectedOnChain === potOnChain;

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
  } else if (conservationHoldsOnChain && anyExtractionSignature) {
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
    totalValueOnChain,
    penaltiesCollectedOnChain,
    conservationHoldsOnChain,
  };
}
