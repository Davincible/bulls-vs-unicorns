// EVERY ROUND ACCOUNT THAT EXISTS, read once and re-read on demand — the log the leaderboards, the
// wins ticker and the history screen are all derived from.
//
// HOW IT READS THEM, AND WHY NOT `program.account.round.all()`. `all()` is a `getProgramAccounts`
// scan: it only ever sees the BASE layer, so a round currently delegated to an Ephemeral Rollup comes
// back frozen at the state it had when it was delegated — a live fight would appear as an untouched
// lobby. Round PDAs are deterministic (`["round", arena, u64le(n)]`), the arena tells us exactly how
// many exist (`round_counter`), and fetching each one BY ADDRESS goes through the Magic Router, which
// routes per account and therefore returns the ER's view for the delegated ones. That is the same
// read path `useRound()` already proves works, just applied to the whole log.
//
// Bounded by construction rather than by hope: the walk back from `round_counter` stops on a short
// run of reclaimed accounts and is capped at `MAX_ROUNDS` regardless — so a long-lived arena costs a
// bounded number of round-trips and the rows a reader actually looks at arrive in the first batch.
// WHICH ROUNDS GET READ AND WHERE THE WALK STOPS IS NOT DECIDED HERE: `historyScan.ts` owns every
// one of those rules and is tested directly, because this file is a hook and nothing in this project
// can test a hook. What is left below is the fetching and the setState.
//
// NOT POLLED. The log only grows when a round is opened, so this fetches on mount, again when the
// arena's `round_counter` moves, and whenever `refresh()` is called. Re-reading N accounts every
// couple of seconds to watch one number change on the newest of them would be pure waste — the live
// round has its own poll for exactly that.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { BullsArenaProgram } from "../../chain/program.ts";
import { roundPdaForRoundNo } from "../../chain/round.ts";
import type { RoundSummary } from "../contract.ts";
import { scanRoundLog } from "./historyScan.ts";
import { summarizeRoundAccount } from "./roundLog.ts";

export interface HistoryResult {
  rounds: RoundSummary[];
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/** One round, or null if that PDA holds nothing — a round number that was never opened, or one whose
 *  rent `close_round_account` has since reclaimed, is a perfectly valid address with an empty account
 *  at it. Deliberately does NOT catch: `scanRoundLog` has to be able to tell an absence from a failed
 *  read, and it can only do that if the failure reaches it. */
async function fetchSummary(
  program: BullsArenaProgram,
  roundNo: bigint,
  arena: PublicKey,
  youPubkey: string,
): Promise<RoundSummary | null> {
  const raw = await program.account.round.fetchNullable(roundPdaForRoundNo(roundNo, arena));
  return raw ? summarizeRoundAccount(raw, youPubkey) : null;
}

export function useHistory(
  program: BullsArenaProgram | null,
  arena: PublicKey,
  roundCounter: bigint | null,
  youPubkey: string,
): HistoryResult {
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Same guard as chain/useRound.ts: a slow batch from a previous request must never overwrite the
  // results of a newer one.
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!program || roundCounter === null) return;
    if (roundCounter === 0n) {
      // The arena is readable and has never opened a round. Not an error, and not "still loading" —
      // an empty log is the honest answer.
      setRounds([]);
      setError(null);
      setLoading(false);
      return;
    }

    const thisRequestId = ++requestIdRef.current;
    let cancelled = false;
    const stale = () => cancelled || requestIdRef.current !== thisRequestId;

    const run = async () => {
      setLoading(true);
      const { summaries, succeeded, firstError } = await scanRoundLog({
        newest: roundCounter,
        read: (n) => fetchSummary(program, n, arena, youPubkey),
        cancelled: stale,
      });

      if (stale()) return;
      setRounds(summaries);
      // A partial failure is not worth a banner — some rounds arrived and the page is usable. Only a
      // total failure (every read threw) is reported, because that means the log on screen is empty
      // for a reason the reader can't otherwise see.
      setError(succeeded === 0 ? firstError : null);
      setLoading(false);
    };

    void run();
    return () => { cancelled = true; };
  }, [program, arena, roundCounter, youPubkey, nonce]);

  return { rounds, loading, error, refresh };
}
