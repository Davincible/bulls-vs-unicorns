// Everything round-shaped, served from the fixture: the round itself, the log, the leaderboards, and
// write actions that go nowhere and say so.
//
// Used by BOTH providers — `?fixture=1` renders it exclusively, and the chain provider falls back to
// it when devnet has no round to show. Sharing one implementation is what keeps the fallback from
// being a second, less-maintained fixture that drifts from the first.

import { useCallback, useMemo, useState } from "react";
import { bpsPct, finalCursor, nameFor, shortKey, sideTotals, usd, type Side } from "../contract.ts";
import type { VerifyResult } from "../../ui/verifyRound.ts";
import type { ArenaContextValue, ToastKind } from "./types.ts";
import { combatFeed } from "./combatFeed.ts";
import { extractEligibility } from "./extractTerms.ts";
import { houseDisclosureOf } from "./houseFighters.ts";
import {
  MOCK_HISTORY,
  MOCK_HOUSE_DISCLOSURE,
  MOCK_HOUSE_WALLETS,
  MOCK_SEED,
  MOCK_TREASURY,
  MOCK_YOU,
} from "./mockData.ts";
import {
  deriveBigWins,
  deriveHall,
  deriveLogCoverage,
  deriveSideRecord,
  deriveStandings,
} from "./roundLog.ts";
import { useFixtureRound } from "./useFixtureRound.ts";

/** A plausible fee-paying balance so the wallet strip renders in its normal state rather than its
 *  unfunded one. Fixture, like everything else here. */
const FIXTURE_SOL = 2.418;

export interface FixtureArenaParams {
  /** False while the chain provider holds this in reserve — see `useFixtureRound`. */
  active: boolean;
  push(text: string, kind?: ToastKind): void;
  /** Books the deploy against the simulated ledger. A fixture deploy sends nothing to any chain, but
   *  the ledger it moves is simulated in the real path too — so the dashboard behaves identically,
   *  which is most of why the fixture exists. */
  recordDeploy(side: Side, stakeUnits: bigint): void;
}

/** The slice of `ArenaContextValue` the fixture can supply. Session, sim, toasts, mode and arena
 *  selection are not here: they are either shell state or genuinely real even when the round isn't. */
export type FixtureArena = Pick<
  ArenaContextValue,
  | "you"
  | "live"
  | "hitEvents"
  | "combat"
  | "houseDisclosure"
  | "treasury"
  | "history"
  | "standings"
  | "logCoverage"
  | "bigWins"
  | "hall"
  | "sideRecord"
  | "actions"
  | "wallet"
  | "verify"
>;

export function useFixtureArena({ active, push, recordDeploy }: FixtureArenaParams): FixtureArena {
  const { live, hitEvents } = useFixtureRound(active);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const you = useMemo(
    () => ({ pubkey: MOCK_YOU, short: shortKey(MOCK_YOU), name: nameFor(MOCK_YOU) }),
    [],
  );

  const standings = useMemo(() => deriveStandings(MOCK_HISTORY), []);
  const bigWins = useMemo(() => deriveBigWins(MOCK_HISTORY), []);
  const hall = useMemo(() => deriveHall(MOCK_HISTORY), []);
  // Never null here: `MOCK_HISTORY` is a module constant, so there is no "we haven't fetched yet"
  // state for the fixture to be honest about — the log is simply present.
  const sideRecord = useMemo(() => deriveSideRecord(MOCK_HISTORY), []);
  // COMPLETE, AND TRUTHFULLY SO. The fixture's log is not a window onto a longer history — those
  // sixteen rounds ARE every round this invented arena ever had — so it is the one place on the page
  // entitled to say "all time", and the coverage says so rather than the screens assuming it.
  const logCoverage = useMemo(() => deriveLogCoverage(MOCK_HISTORY, BigInt(MOCK_HISTORY.length)), []);

  // THE FIXTURE DISCLOSES ITS OWN HOUSE, through the same counter the chain path runs. The marks are
  // already on the lineup (`mockData.ts`); this is the caption's half of the same fact, and it is
  // never null here because the fixture's list is a module constant that is always present. The note
  // it carries opens with the word FIXTURE — see `MOCK_HOUSE_DISCLOSURE`.
  const houseDisclosure = useMemo(
    () =>
      houseDisclosureOf(live.fighters, {
        house: { wallets: MOCK_HOUSE_WALLETS, disclosure: MOCK_HOUSE_DISCLOSURE },
      }),
    [live.fighters],
  );

  const combat = useMemo(
    () => combatFeed({ hitEvents, fighters: live.fighters, stepsNow: live.stepsNow }),
    [hitEvents, live.fighters, live.stepsNow],
  );

  const enter = useCallback(
    async (side: Side, stakeUnits: bigint): Promise<string> => {
      recordDeploy(side, stakeUnits);
      push(`FIXTURE — would deploy ${stakeUnits} units to side ${side}`, side === 0 ? "a" : "b");
      return "fixture-signature";
    },
    [push, recordDeploy],
  );

  // NOT the same function the chain path calls, and it must stay that way: nothing is sent. What it
  // reports is the split the real `extract()` WOULD charge at this cursor — read off the same
  // `extractEligible` below — because a fixture toast that says "would extract $12.40" while the
  // panel beside it says $9.92 lands is a second, quieter version of the lie this session removed.
  const extract = useCallback(async (): Promise<string> => {
    const t = live.extractTerms;
    push(
      t.youKeep === null || t.youForfeit === null
        ? "FIXTURE — would extract"
        : `FIXTURE — would bank ${usd(t.youKeep)}, ${usd(t.youForfeit)} to the house at ${bpsPct(t.penaltyBps)}`,
      "info",
    );
    return "fixture-signature";
  }, [push, live]);

  // The SAME function the chain path calls (`data/extractTerms.ts`), not a restatement of it. This
  // used to be a hand-copied ladder of the same four branches "in the same register" — which is two
  // copies of one rule, and the penalty is exactly the kind of change that would have been made to
  // one of them. `notReady` is omitted: there is no program to still be loading here.
  const extractEligible = extractEligibility(live);

  const runVerify = useCallback(() => {
    if (live.phase !== "Settled") {
      push(`verification needs a settled round — this one is still ${live.phase}`, "error");
      return;
    }
    // NOT a fabricated verdict. In the fixture there is no chain: the "on-chain" rosters ARE the
    // replay of `MOCK_HIT_EVENTS` (see `mockFightersAt`), so comparing them against that same replay
    // is trivially exact and `verified` is the only truthful answer. The real path calls
    // `verifyRound()` (ui/verifyRound.ts) against genuinely independent settled state, which is where
    // the verdict actually costs something to earn — this only exercises the panel's layout.
    const [a, b] = sideTotals(live.fighters);
    const winner: 0 | 1 = a >= b ? 0 : 1;
    setVerifyResult({
      verdict: "verified",
      steps: Math.min(Number(live.tickCount), finalCursor(live.fighters.length)),
      seedHex: MOCK_SEED.toString("hex"),
      winnerOnChain: winner,
      winnerRecomputed: winner,
      winnerMatches: true,
      fighters: live.fighters.map((f) => ({
        wallet: f.wallet,
        side: f.side,
        onChain: { hp: f.hp, banked: f.banked, dead: f.dead },
        recomputed: { hp: f.hp, banked: f.banked, dead: f.dead },
        matches: true,
        extractionSignature: false,
      })),
      potOnChain: live.pot,
      // The account's OTHER recording of the pot, which on a real round is written by a different
      // line of `enter` than the fighters' stakes are. Here it is the same number by construction —
      // the fixture hands `pot` to the roster rather than accumulating it — so the comparison below
      // is `true` for a reason that proves nothing. Said plainly because that is the point: this
      // fixture exercises the PANEL, and `potMatchesStakesOnChain` is one of the two flags that only
      // means something against genuinely independent chain state.
      potRecordedOnChain: live.pot,
      potMatchesStakesOnChain: true,
      totalValueOnChain: a + b,
      // Zero, and truthfully so: the fixture's rosters are a pure replay of `MOCK_HIT_EVENTS`, in
      // which nobody ever calls `extract()`, so no penalty has been charged and the pre-penalty
      // identity `sum(hp + banked) === pot` still closes. Inventing a house take to make the panel
      // look busier would be fabricating the one figure this section exists to let a reader check.
      penaltiesCollectedOnChain: 0n,
      // Likewise zero, and likewise truthfully: the fixture's stakes are handed to the roster
      // directly, so no `enter()` has charged a fee and these stakes are already the gross. That
      // makes `grossDeposits` equal to `pot` and the house's take equal to nothing, which is the
      // honest state of a round nobody paid to be in — not a placeholder waiting to be filled.
      feesCollectedOnChain: 0n,
      houseTookOnChain: 0n,
      grossDepositsOnChain: live.pot,
      conservationHoldsOnChain: true,
    });
  }, [live, push]);

  return {
    you,
    live,
    hitEvents,
    combat,
    houseDisclosure,
    // THE FIXTURE'S TREASURY IS DERIVED FROM ITS OWN LOG, and is zero because every round in that log
    // charged nothing — see `MOCK_TREASURY` for why that is the honest figure rather than `null` and
    // rather than an invented one.
    treasury: MOCK_TREASURY,
    history: { rounds: MOCK_HISTORY, loading: false, error: null, refresh: () => {} },
    standings,
    logCoverage,
    bigWins,
    hall,
    sideRecord,
    actions: { enter, extract, entering: false, extracting: false, extractEligible },
    wallet: {
      pubkey: MOCK_YOU,
      short: shortKey(MOCK_YOU),
      solBalance: FIXTURE_SOL,
      airdrop: async () => push("FIXTURE — would request a devnet airdrop", "info"),
      airdropping: false,
      refresh: () => {},
      // THE FIXTURE IS A COMPLETE FICTION, WALLET INCLUDED. It reports "burner"/"connected" because
      // that is the state in which nothing on the page is gated — there is no wallet to connect and
      // no failure to model, and offering a Connect button that connects nothing would be the one
      // kind of dishonesty this page refuses. `?fixture=1` is announced by its own banner.
      mode: "burner" as const,
      status: "connected" as const,
      fault: null,
      connect: async () => push("FIXTURE — no wallet to connect", "info"),
      disconnect: async () => push("FIXTURE — no wallet to disconnect", "info"),
      // THROWS RATHER THAN FABRICATING A SIGNATURE, and that is the one place the fixture's "report
      // the ungated state" rule above does not apply. Everything else on this object is a number or a
      // no-op that makes the page reviewable; a signature is a CLAIM — the fixture has no key, so any
      // bytes it returned would be a forgery of a proof, and the endpoint that consumed them would
      // rightly reject it somewhere far from here. The fixture is honest about being a fiction; it
      // does not get to be dishonest about cryptography.
      signMessage: async () => {
        push("FIXTURE — there is no wallet here to sign with", "info");
        throw new Error("FIXTURE — there is no wallet here to sign with");
      },
    },
    verify: { result: verifyResult, run: runVerify, running: false },
  };
}
