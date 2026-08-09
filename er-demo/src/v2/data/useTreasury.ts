// THE ARENA'S HOUSE BOOKS, off the chain — the `Treasury` PDA, read rather than modelled.
//
// `treasuryPda()` and `program.account.treasury.fetchNullable()` have both existed since program v6
// and neither was called from anywhere in the app, while the Dashboard rendered a `sim` treasury out
// of localStorage in the tile beside them. That is the exact tile `UI-SPEC.md` Part 1 ordered fixed:
// "should read the treasury ACCOUNT, not the counter."
//
// HOW OFTEN, AND WHY NOT WITH THE ROUND. The treasury moves on exactly one instruction —
// `sweep_house_take`, which books a finished round's fee and penalty totals onto the arena — and a
// round can only be swept after it has settled, closed and undelegated. So it changes at most once
// per round, minutes apart, and putting it on the round's 1.5s poll would be a fetch every 1.5
// seconds for a number that moves every few minutes. Instead it is read on two triggers that between
// them cover every way it can change:
//
//   · WHEN `round_counter` MOVES. A new round opening is the page's own signal that the previous one
//     has finished, which is the only moment a sweep becomes possible. The arena counter is already
//     polled by `useChain` every 5s, so this costs nothing to watch and lands the new figure within
//     one arena poll of the sweep it describes.
//   · A SLOW BACKSTOP. The trigger above misses one real case: an operator sweeping a backlog of old
//     rounds without opening a new one. That is rare and not urgent, so it is covered by a minute
//     interval rather than by a faster poll that would be idle the other 99% of the time.
//
// NULL IS TWO FACTS AND THEY MUST NOT BE SPLIT INTO THREE. `null` means "not read yet, or never
// initialised", because `init_treasury` is a separate admin call from `init_arena` and an arena can
// legitimately run without one. Both render `—`. What null must NEVER mean is "holds nothing": a
// treasury that has been swept and is genuinely at zero is a real, different fact, and it renders a
// zero. See `TreasuryState` in contract.ts.

import { useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import { bnOr0, type BullsArenaProgram } from "../../chain/program.ts";
import { treasuryPda } from "../../chain/round.ts";
import type { TreasuryState } from "../contract.ts";

/** The backstop interval — see the header for what it is catching that `roundCounter` does not. */
const POLL_MS = 60_000;

/**
 * @param roundCounter the arena's own counter, from `useChain`. Not read for its value: it is the
 *        edge that says a round has finished and may now have been swept.
 */
export function useTreasury(
  program: BullsArenaProgram | null,
  arena: PublicKey,
  roundCounter: bigint | null,
): TreasuryState | null {
  const [treasury, setTreasury] = useState<TreasuryState | null>(null);
  // Same guard as every other read in this layer: a slow response from a previous effect must never
  // overwrite the result of a newer one.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!program) return;
    const thisRequestId = ++requestIdRef.current;
    let cancelled = false;
    const stale = () => cancelled || requestIdRef.current !== thisRequestId;
    const pda = treasuryPda(arena);

    const read = async () => {
      try {
        const raw = await program.account.treasury.fetchNullable(pda);
        if (stale()) return;
        // `fetchNullable`, and the null branch is a real state rather than a failure: the treasury
        // has never been initialised. It collapses into the same `null` as "not read yet", which is
        // deliberate — a page that told a reader "this arena has no treasury account" would be
        // reporting an operator's to-do list as a fact about the house's take.
        if (raw === null) {
          setTreasury(null);
          return;
        }
        // Through `bnOr0`, like every other decoded u64 in this layer: the served IDL is a contract
        // with the DEPLOYED program and can lag the one this build was written against, in which
        // case a field it has never heard of decodes as `undefined`. Zero is the true value on a
        // program revision that never accrued it — see `bnOr0` in chain/program.ts.
        setTreasury({
          feesAccrued: bnOr0(raw.feesAccrued),
          penaltiesAccrued: bnOr0(raw.penaltiesAccrued),
          roundsSwept: bnOr0(raw.roundsSwept),
        });
      } catch {
        // A FAILED READ LEAVES THE LAST GOOD FIGURE ON SCREEN, and does not report itself. Both
        // halves are deliberate. Blanking a tile that has been reading fine, because one request out
        // of sixty timed out, would be strictly less true than leaving the last known figure there —
        // the treasury does not move between sweeps, so the stale value is almost certainly still
        // the current one. And a banner for it would be noise: nothing on this page depends on the
        // treasury, so a reader can do nothing with the news, while `status.roundError` already says
        // when the chain is genuinely unreachable.
      }
    };

    void read();
    const id = setInterval(() => void read(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [program, arena, roundCounter]);

  return treasury;
}
