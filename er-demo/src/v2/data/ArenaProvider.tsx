// THE COMPOSITION ROOT of v2's data layer. Two exports, `ArenaProvider` and `useArena()`, and
// nothing in this file computes anything — every hook it calls lives beside it in `data/`, which is
// what keeps this readable as a wiring diagram instead of a six-hundred-line hook.
//
// TWO PROVIDERS, PICKED ONCE. `?fixture=1` renders a provider that never constructs a program, never
// opens a session, and never touches the network — so the page is fully reviewable with no wallet, no
// round and no connectivity. Everything else renders the chain provider, which ALSO holds the fixture
// and falls through to it when devnet genuinely has nothing to show (no round ever opened, the IDL
// unreachable, the RPC down). Which one is in play is on the context as `source`, and the reason is
// in `status.programError`/`status.roundError`, so no panel has to guess and no reader can be misled.
//
// The choice is made from a module-level flag, not from state: the two providers call different
// hooks, so a flag that could flip mid-session would change a component's hook list. It is a
// deep-link. Changing it is a reload.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PROGRAM_ID } from "../../chain/constants.ts";
import { useFightTicker } from "../../chain/useFightTicker.ts";
import { useAppSessionManager } from "../../chain/session/useSessionKeyManager.ts";
import { toAnchorWallet, useSigner } from "../../chain/useSigner.ts";
import { nameFor, shortKey, type Side } from "../contract.ts";
import { simBankrollUsd } from "./autoDeploy.ts";
import { useAutoDeploy } from "./useAutoDeploy.ts";
import { FIXTURE_FORCED } from "./flags.ts";
import { shouldDriveFight } from "./fightPace.ts";
import { deriveBigWins, deriveHall, deriveSideRecord, deriveStandings } from "./roundLog.ts";
import { useActions } from "./useActions.ts";
import { useChain } from "./useChain.ts";
import { useFixtureArena } from "./useFixtureArena.ts";
import { useHistory } from "./useHistory.ts";
import { useLiveRound } from "./useLiveRound.ts";
import { useShell, type Shell } from "./useShell.ts";
import { useVerify } from "./useVerify.ts";
import { useWallet } from "./useWallet.ts";
import type { ArenaContextValue } from "./types.ts";

const ArenaContext = createContext<ArenaContextValue | null>(null);

export function ArenaProvider({ children }: { children: ReactNode }) {
  return FIXTURE_FORCED
    ? <FixtureArenaProvider>{children}</FixtureArenaProvider>
    : <ChainArenaProvider>{children}</ChainArenaProvider>;
}

export function useArena(): ArenaContextValue {
  const ctx = useContext(ArenaContext);
  if (!ctx) throw new Error("useArena() must be called inside <ArenaProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Fixture only — `?fixture=1`
// ---------------------------------------------------------------------------------------------

/**
 * EVERY CONFIRMED DEPOSIT, FANNED OUT TO EVERYONE WHO NEEDS TO KNOW — and there are now two: the
 * simulated ledger books the stake and the fee, and the repeat rule learns which side to follow.
 *
 * The indirection through a ref is not decoration. `useActions` needs this callback in order to be
 * built, and the repeat rule needs `actions.enter` in order to be built, so one of the two has to be
 * wired after the fact. A ref written on render is the cheapest honest way to close that loop; the
 * alternative is a context between two hooks that sit four lines apart.
 */
function useOnEntered(recordDeploy: (side: Side, stakeUnits: bigint) => void) {
  const noteDeployRef = useRef<((side: Side) => void) | null>(null);
  const onEntered = useCallback(
    (side: Side, stakeUnits: bigint) => {
      recordDeploy(side, stakeUnits);
      noteDeployRef.current?.(side);
    },
    [recordDeploy],
  );
  return { onEntered, noteDeployRef };
}

function FixtureArenaProvider({ children }: { children: ReactNode }) {
  const shell = useShell();
  const { onEntered, noteDeployRef } = useOnEntered(shell.simLedger.recordDeploy);
  const fixture = useFixtureArena({
    active: true,
    push: shell.toasts.push,
    recordDeploy: onEntered,
  });
  const session = useFixtureSession();

  // Armed and evaluated on the fixture path too. Nothing is sent to any chain, but the rule's state
  // machine is the same one — which is exactly what makes `?fixture=1` a place to watch it work.
  const autoDeploy = useAutoDeploy({
    live: fixture.live,
    // The fixture reads and writes the same invented round, so the two can never disagree.
    targetRoundNo: fixture.live?.roundNo ?? null,
    entering: fixture.actions.entering,
    enter: fixture.actions.enter,
    simWalletUsd: simBankrollUsd(shell.simLedger.ledger.balances),
    push: shell.toasts.push,
  });
  noteDeployRef.current = autoDeploy.noteDeploy;

  const value: ArenaContextValue = {
    source: "fixture",
    ...fixture,
    autoDeploy,
    status: {
      // Nothing failed — the fixture was ASKED for. Reporting a program error here would send the
      // page looking for a chain problem that doesn't exist.
      programReady: true,
      programError: null,
      roundError: null,
      loading: false,
      roundNo: fixture.live?.roundNo ?? null,
    },
    session,
    ...shellValue(shell, fixture.you.pubkey),
  };

  return <ArenaContext.Provider value={value}>{children}</ArenaContext.Provider>;
}

/** A local toggle. There is no wallet to authorize a session key against in fixture mode, and a
 *  session that silently did nothing would be worse than one that plainly says it's a stand-in. */
function useFixtureSession(): ArenaContextValue["session"] {
  const [active, setActive] = useState(false);
  return useMemo(
    () => ({
      active,
      busy: false,
      error: null,
      start: async () => setActive(true),
      end: async () => setActive(false),
    }),
    [active],
  );
}

// ---------------------------------------------------------------------------------------------
// Chain, with the fixture as the fallback
// ---------------------------------------------------------------------------------------------

function ChainArenaProvider({ children }: { children: ReactNode }) {
  const shell = useShell();
  const { keypair, wallet } = useSigner();
  const youPubkey = keypair.publicKey.toBase58();

  const chain = useChain(wallet, true);
  const { round, live, hitEvents, error: roundError, loading } = useLiveRound(
    chain.program,
    chain.roundPda,
    youPubkey,
  );
  const history = useHistory(chain.program, chain.arena, chain.roundCounter, youPubkey);

  // Session Keys. `baseConnection`, not the router: `create_session`/`revoke_session` call the
  // `gpl_session` program directly and it is never ER-delegated (see useSessionKeyManager.ts).
  const anchorWallet = useMemo(() => toAnchorWallet(wallet), [wallet]);
  const sessionManager = useAppSessionManager(anchorWallet, chain.baseConnection, "devnet", PROGRAM_ID);

  const { onEntered, noteDeployRef } = useOnEntered(shell.simLedger.recordDeploy);
  const actions = useActions({
    program: chain.program,
    router: chain.router,
    keypair,
    arena: chain.arena,
    roundPda: chain.roundPda,
    live,
    session: sessionManager.active,
    onEntered,
  });

  const walletValue = useWallet(keypair, chain.baseConnection, shell.toasts.push);
  const verify = useVerify(round, shell.toasts.push);

  // WHY THIS SHAPE. The fallback triggers only when the chain has failed to produce a round AND has
  // told us why — never merely because the first poll hasn't landed yet (that is `loading`, and
  // flipping to the fixture for a second on every page load would be a flicker that teaches readers
  // to distrust what they see). Once a round HAS been read, the page stays on it: a later poll
  // failure leaves the last-known round on screen with `roundError` set, which is more useful than
  // replacing a real round with a fictional one over one dropped request.
  const noRoundEverOpened = chain.roundCounter === 0n;
  const chainUnusable =
    chain.programError !== null || chain.arenaError !== null || roundError !== null || noRoundEverOpened;
  const fallback = live === null && chainUnusable;

  // DRIVE THE LIVE FIGHT. Without this the round account's `hp`/`banked`/`dead` never move until the
  // round settles — see `shouldDriveFight`'s own doc comment for why, and for what the gate below is
  // protecting against. It is a LIVENESS HELPER, not a dependency: `tick` is permissionless and
  // outcome-neutral, and `resolve` catches up on its own if every tab closes.
  const ticker = useFightTicker({
    program: chain.program,
    router: chain.router,
    roundPda: chain.roundPda,
    round,
    keypair,
    session: sessionManager.active,
    enabled: shouldDriveFight({
      fallback,
      sessionActive: sessionManager.active !== null,
      solBalance: walletValue.solBalance,
    }),
  });

  const fixture = useFixtureArena({
    active: fallback,
    push: shell.toasts.push,
    recordDeploy: onEntered,
  });

  // POINTED AT THE CHAIN, ALWAYS — including while the fixture is on screen as the fallback. The
  // repeat rule is an instruction to spend real money on real rounds, so with no real round to read
  // it holds on `no-round` and says so, rather than quietly "depositing" into an invented one and
  // teaching a player it is working. `chain.roundNo` is the round the write path would target;
  // handing the rule BOTH that and the round being read is what lets it refuse to act in the window
  // where a newly opened round has been discovered but not yet fetched.
  const autoDeploy = useAutoDeploy({
    live,
    targetRoundNo: chain.roundNo,
    entering: actions.entering,
    enter: actions.enter,
    simWalletUsd: simBankrollUsd(shell.simLedger.ledger.balances),
    push: shell.toasts.push,
  });
  noteDeployRef.current = autoDeploy.noteDeploy;

  const standings = useMemo(() => deriveStandings(history.rounds), [history.rounds]);
  const bigWins = useMemo(() => deriveBigWins(history.rounds), [history.rounds]);
  const hall = useMemo(() => deriveHall(history.rounds), [history.rounds]);
  // NULL MEANS "NOT KNOWN YET", and it is a different thing from an honest nil-all. The log arrives in
  // batches after mount, so between the first paint and the first batch `deriveSideRecord([])` is a
  // perfectly well-formed 0–0 about a log nobody has read — and anything rendering it would flash a
  // false scoreline on every load before snapping to the real one. Once ANY round has landed, or the
  // fetch is done, the count is real and is shown, nil-all included.
  const sideRecord = useMemo(
    () => (history.loading && history.rounds.length === 0 ? null : deriveSideRecord(history.rounds)),
    [history.loading, history.rounds],
  );

  const you = useMemo(
    () => ({ pubkey: youPubkey, short: shortKey(youPubkey), name: nameFor(youPubkey) }),
    [youPubkey],
  );

  const session: ArenaContextValue["session"] = {
    active: sessionManager.active !== null,
    busy: sessionManager.isLoading,
    error: sessionManager.error,
    start: sessionManager.createSession,
    end: sessionManager.revokeSession,
  };

  const status: ArenaContextValue["status"] = {
    programReady: chain.program !== null,
    programError: chain.programError,
    // The arena account is what tells us WHICH round exists; failing to read it is a round-level
    // failure, not a fatal program one, so it is reported here rather than as the page-killing
    // banner. `no round has been opened yet` is not an error at all — it is the honest state of an
    // arena between demos, and saying so beats an empty page with nothing to read.
    roundError: roundError ?? chain.arenaError ?? (noRoundEverOpened ? "no round has been opened on this arena yet" : null),
    loading: loading && !fallback,
    roundNo: live?.roundNo ?? chain.roundNo,
  };

  const value: ArenaContextValue = fallback
    ? {
        source: "fixture",
        ...fixture,
        // The real reason the fixture is on screen, kept intact — this is the difference between
        // "the demo data" and "the demo data, because devnet has no round open".
        status: { ...status, loading: false, roundNo: fixture.live?.roundNo ?? null },
        autoDeploy,
        session,
        ...shellValue(shell, fixture.you.pubkey),
      }
    : {
        source: "chain",
        you,
        status,
        live,
        hitEvents,
        history,
        standings,
        bigWins,
        hall,
        sideRecord,
        actions,
        autoDeploy,
        session,
        wallet: walletValue,
        verify,
        // Normalised to a string at this boundary, like every other error on the context — a view
        // should never have to decide how to render an `Error` object (this codebase has already
        // white-screened once on exactly that, see useSessionKeyManager.ts's `normalizeGumError`).
        ticker: {
          ticksSent: ticker.ticksSent,
          stepsAdvanced: ticker.stepsAdvanced,
          lastSignature: ticker.lastSignature,
          error: ticker.error === null ? null : ticker.error.message,
        },
        ...shellValue(shell, youPubkey),
      };

  return <ArenaContext.Provider value={value}>{children}</ArenaContext.Provider>;
}

// ---------------------------------------------------------------------------------------------

/** The shell fields, identical in both providers — spread rather than restated so they cannot drift.
 *  `pubkey` is whichever identity the page is actually presenting, since it is what the referral link
 *  is minted from. */
function shellValue(shell: Shell, pubkey: string) {
  return {
    sim: { ledger: shell.simLedger.ledger, actions: shell.simLedger.actions, refLink: shell.refLink(pubkey) },
    toasts: shell.toasts,
    mode: shell.mode,
    setMode: shell.setMode,
    arenaId: shell.arenaId,
    setArenaId: shell.setArenaId,
    board: shell.board,
    setBoard: shell.setBoard,
  };
}
