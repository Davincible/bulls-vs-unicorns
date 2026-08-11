// THE COMPOSITION ROOT of v2's data layer. ONE export, `ArenaProvider`, and nothing in this file
// computes anything — every hook it calls lives beside it in `data/`, which is what keeps this
// readable as a wiring diagram instead of a six-hundred-line hook.
//
// `useArena()` is next door in `data/useArena.ts`, and the reason it is not here is written up in
// that file: a module that exports anything other than components cannot be hot-refreshed, and this
// one sits at the root of the whole page's import graph. Keep this file components-only.
//
// THREE PROVIDERS, PICKED ONCE. `?fixture=1` renders a provider that never constructs a program,
// never opens a session, and never touches the network — so the page is fully reviewable with no
// wallet, no round and no connectivity. Everything else renders a chain provider, which ALSO holds
// the fixture and falls through to it when devnet genuinely has nothing to show (no round ever
// opened, the IDL unreachable, the RPC down). Which one is in play is on the context as `source`, and
// the reason is in `status.programError`/`status.roundError`, so no panel has to guess and no reader
// can be misled.
//
// THE TWO CHAIN PROVIDERS DIFFER BY ONE OBJECT AND NOTHING ELSE. `WalletChainProvider` acquires an
// identity from the visitor's Phantom; `BurnerChainProvider` builds one from the keypair this
// browser keeps in localStorage. Both hand a `ChainIdentity` (see `identity.ts`) to the same
// `ChainArena`, which owns every piece of wiring below it. Forking that wiring instead would mean
// two copies of the round poll, the history, the session manager and the ticker — and one of them
// would be updated alone.
//
// WHY THE BURNER IS A SEPARATE PROVIDER RATHER THAN A BRANCH INSIDE ONE. `useSigner()` does not just
// read a keypair, it MINTS AND PERSISTS one. Calling it unconditionally would write a secret key
// into the localStorage of every stranger who ever opens the public URL — which is the precise
// behaviour this change exists to remove. It must not run on the wallet path at all, and the only
// way to guarantee that in React is for the hook to live in a component the wallet path never
// mounts.
//
// Each choice is made from a module-level flag, not from state: the providers call different hooks,
// so a flag that could flip mid-session would change a component's hook list. They are deep-links.
// Changing one is a reload.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PROGRAM_ID } from "../../chain/constants.ts";
import { useFightTicker } from "../../chain/useFightTicker.ts";
import {
  useAppSessionManager,
  type ActiveSession,
  type SessionManager,
} from "../../chain/session/useSessionKeyManager.ts";
import { toAnchorWallet, useSigner } from "../../chain/useSigner.ts";
import { feeRate, nameFor, shortKey, type FeeRate, type Side } from "../contract.ts";
import { simBankrollUsd } from "./autoDeploy.ts";
import { unattendedSigning, type UnattendedSigning } from "./autoPolicy.ts";
import { signingPlan, type SessionSigning, type SessionWork } from "./autoSession.ts";
import { classifyWalletError } from "./walletFault.ts";
import { useAutoDeploy } from "./useAutoDeploy.ts";
import { FIXTURE_FORCED, SIGNER_MODE, type SignerMode } from "./flags.ts";
import { shouldDriveFight } from "./fightPace.ts";
import { burnerIdentity, newTickerPlaceholder, walletIdentity, type ChainIdentity } from "./identity.ts";
import { playBlock, type PlayBlock } from "./playGate.ts";
import { NO_COMBAT, combatFeed } from "./combatFeed.ts";
import { withLinks } from "./linkFighters.ts";
import { LinksContext, useLinkFeed } from "./useLinks.ts";
import { MOCK_FEE_BPS } from "./mockData.ts";
import { useTreasury } from "./useTreasury.ts";
import { forgetSession, noteSessionStarted, readSessionStartedAt, sessionLife } from "./sessionExpiry.ts";
import {
  deriveBigWins,
  deriveHall,
  deriveLogCoverage,
  deriveSideRecord,
  deriveStandings,
} from "./roundLog.ts";
import { useActions } from "./useActions.ts";
import { useChain } from "./useChain.ts";
import { useFixtureArena } from "./useFixtureArena.ts";
import { useHistory } from "./useHistory.ts";
import { useLiveRound } from "./useLiveRound.ts";
import { usePhantom } from "./usePhantom.ts";
import { useShell, type Shell } from "./useShell.ts";
import { useVerify } from "./useVerify.ts";
import { useWallet } from "./useWallet.ts";
import { ArenaContext } from "./useArena.ts";
import type { ArenaContextValue } from "./types.ts";

export function ArenaProvider({ children }: { children: ReactNode }) {
  if (FIXTURE_FORCED) return <FixtureArenaProvider>{children}</FixtureArenaProvider>;
  return SIGNER_MODE === "burner"
    ? <BurnerChainProvider>{children}</BurnerChainProvider>
    : <WalletChainProvider>{children}</WalletChainProvider>;
}

// ---------------------------------------------------------------------------------------------
// Fixture only — `?fixture=1`
// ---------------------------------------------------------------------------------------------

/**
 * EVERY CONFIRMED DEPOSIT, FANNED OUT TO EVERYONE WHO NEEDS TO KNOW — and there are now two: the
 * simulated ledger books the stake and the fee, and the repeat rule learns which side to follow.
 *
 * The indirection through a ref is not decoration. `useActions` needs this callback in order to be
 * built, and the repeat rule needs `actions.enterUnattended` in order to be built, so one of the two
 * has to be wired after the fact. A ref written on render is the cheapest honest way to close that
 * loop; the alternative is a context between two hooks that sit four lines apart.
 *
 * THE FEE GOES THROUGH A REF FOR A SECOND, DIFFERENT REASON. It is read at CONFIRMATION time rather
 * than captured when this callback was built, which is both the more accurate rate (the door charged
 * whatever the arena said when the transaction landed, and the newest poll is the closest thing to
 * that) and the one that does not rebuild `onEntered` — and with it every callback in `useActions`
 * that depends on it — each time the arena poll returns a changed `fee_bps`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * TWO CALLBACKS, NOT ONE, AND THE SECOND ONE IS A MONEY BUG THAT WAS SHIPPED.
 *
 * `ChainArena` holds the fixture as a FALLBACK — devnet has no round open, so invented data is on
 * screen — and it wired that fixture's Deploy button to this same `onEntered`. Nothing about that
 * press is real: no transaction, no signature, no stake, by the fixture's own contract. But
 * `noteDeployRef` points at the CHAIN-pointed repeat rule, so a press on invented data was setting
 * `state.side` on the rule that spends real money. That satisfies the `no-side` hold, whose whole
 * documented meaning is "waiting for your first deploy" — and because there is no live round while
 * the fallback is up, arming also records `floorRound: null`, which is the rule's other protection
 * ("never spend money on the round already in front of you") correctly not applying because there is
 * no such round. Put together: the keeper opens round 42, and a REAL deposit goes into a lobby the
 * player never saw, on a side chosen by a press that was explicitly not a deploy.
 *
 * So the two are separated at the source. `onEntered` is a deposit into the world the rule is
 * watching: it books the ledger AND configures the rule. `bookSimOnly` is a deposit into a world
 * that is invented: it books the ledger and configures nothing. The line between them is not
 * "fixture or chain" — under `?fixture=1` the rule IS pointed at the fixture and takes the full
 * fan-out, which is what makes that mode a place to watch the rule work. The line is whether the
 * deposit and the rule describe the same rounds.
 *
 * The simulated ledger takes both, and that is deliberate rather than an inconsistency: it is
 * invented money by construction and carries the `SIM` marker everywhere it is shown, so invented
 * events may move it. A real deposit may not be configured by one.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * AND A DEPLOY IS NEVER BOOKED AT A RATE NOBODY WAS CHARGED. `recordDeploy` prices the house's take
 * off the `FeeRate` it is handed and reads only `bps`, never `known` — so while the arena account is
 * unreadable, `feeRate(null)` hands it the build-time fallback and the simulated treasury and
 * `referralEarned` accrue at a rate that was never charged, persisted to localStorage, permanently,
 * with nothing marking it. That is the same defect as the production fee incident recorded on
 * `FEE_BPS` (the rate was moved 20 → 100 on devnet while the site was serving), one layer down, and
 * `recordDeploy`'s own doc comment names it as the thing that function exists to close.
 *
 * The honest options are to book at an invented rate, to book nothing at all, or to WAIT for the
 * rate — and only the last of the three loses nothing. The deposit happened and the arena has a
 * rate; this page has simply not read it yet, and the poll that failed will run again in a second.
 * So an unpriced deploy is held and booked the moment a rate lands. If none ever does, it is never
 * booked, which is a missing row in play money rather than a fabricated house take that outlives the
 * page — the smaller of the two lies, and the one that cannot mislead anybody reading the referrals
 * screen a week later.
 */
function useOnEntered(
  recordDeploy: (side: Side, stakeUnits: bigint, arenaFee: FeeRate) => void,
  fee: FeeRate,
) {
  const noteDeployRef = useRef<((side: Side, roundNo: bigint | null) => void) | null>(null);
  const feeRef = useRef(fee);
  feeRef.current = fee;
  /** Confirmed deploys the arena's rate was unreadable for. Bounded by how long a poll stays broken;
   *  in the ordinary life of the page it is empty, and a deploy is booked in the same tick. */
  const unpricedRef = useRef<{ side: Side; stakeUnits: bigint }[]>([]);

  const bookSimOnly = useCallback(
    (side: Side, stakeUnits: bigint) => {
      const arenaFee = feeRef.current;
      if (!arenaFee.known) {
        unpricedRef.current.push({ side, stakeUnits });
        return;
      }
      recordDeploy(side, stakeUnits, arenaFee);
    },
    [recordDeploy],
  );

  // A RATE ARRIVED. `fee` changes identity only when `fee_bps` does (see the memo that builds it), so
  // this runs on the poll that answers rather than on every render, and it is a no-op on every page
  // that never had an unpriced deploy — which is all of them but the broken one.
  useEffect(() => {
    if (!fee.known || unpricedRef.current.length === 0) return;
    const waiting = unpricedRef.current;
    unpricedRef.current = [];
    // The rate that has just been read, not the one in force when the transaction landed — which is
    // the closest thing to it that exists, and the same approximation `feeRef` already makes for
    // every ordinary deploy.
    for (const d of waiting) recordDeploy(d.side, d.stakeUnits, fee);
  }, [fee, recordDeploy]);

  // THE ROUND TRAVELS WITH THE DEPOSIT, all the way from `useActions`' `targetRoundNoRef` — captured
  // at send time — to the repeat rule's books. Nothing on this path derives it, because every place
  // it could be derived from (`live.roundNo`, the round on screen) is the round the poll last read
  // rather than the round the transaction was written to, and the two differ for up to a poll every
  // time a new round opens. The simulated ledger does not want it: `recordDeploy` books a side and a
  // stake against a wallet, not against a round.
  const onEntered = useCallback(
    (side: Side, stakeUnits: bigint, roundNo: bigint | null) => {
      bookSimOnly(side, stakeUnits);
      noteDeployRef.current?.(side, roundNo);
    },
    [bookSimOnly],
  );
  return { onEntered, bookSimOnly, noteDeployRef };
}

function FixtureArenaProvider({ children }: { children: ReactNode }) {
  const shell = useShell();
  // KNOWN, AND INVENTED, AND BOTH ARE TRUE. There is no arena account to be waiting on here, so
  // `known: false` would describe a read that is never going to happen; the fixture's rate is simply
  // present, exactly as its treasury and its round are. `MOCK_FEE_BPS` says why it is 20.
  const fee = useMemo(() => feeRate(MOCK_FEE_BPS), []);
  const { onEntered, noteDeployRef } = useOnEntered(shell.simLedger.recordDeploy, fee);
  // THE FIXTURE'S DEPLOY BUTTON KNOWS NOTHING ABOUT ROUNDS, so this supplies the one it is standing
  // in. On the chain path the round comes off `useActions`' send-time capture; here there is no send,
  // no PDA and no poll to lag behind it — the invented round on screen IS the round a press enters,
  // which is what makes `?fixture=1` a place the rule's own bookkeeping can be watched working. The
  // ref is written on render for the reason `noteDeployRef` beside it is: the fixture needs this
  // callback in order to be built, so the round it reports can only be wired after the fact.
  const fixtureRoundRef = useRef<bigint | null>(null);
  const recordDeploy = useCallback(
    (side: Side, stakeUnits: bigint) => onEntered(side, stakeUnits, fixtureRoundRef.current),
    [onEntered],
  );
  const fixture = useFixtureArena({
    active: true,
    push: shell.toasts.push,
    recordDeploy,
  });
  fixtureRoundRef.current = fixture.live?.roundNo ?? null;
  const session = useFixtureSession();

  // Armed and evaluated on the fixture path too. Nothing is sent to any chain, but the rule's state
  // machine is the same one — which is exactly what makes `?fixture=1` a place to watch it work.
  //
  // THE FULL FAN-OUT IS CORRECT HERE, and it is the one place it is: the rule and the Deploy button
  // are pointed at the same invented round, so a press on it genuinely is "the deposit this rule
  // should follow". See `useOnEntered` for the fallback path, where they are pointed at different
  // worlds and were wired together anyway.
  const autoDeploy = useAutoDeploy({
    live: fixture.live,
    // The fixture reads and writes the same invented round, so the two can never disagree.
    targetRoundNo: fixture.live?.roundNo ?? null,
    entering: fixture.actions.entering,
    // THE FIXTURE'S OWN `enter`, WHICH IS THE UNATTENDED SENDER HERE BY BEING INCAPABLE OF ANYTHING
    // ELSE: it takes a side and a stake, it pushes a toast and moves local state, and there is no
    // wallet, no session and no chain anywhere behind it. Nothing it does can raise a dialog, which
    // is the property `enterUnattended` exists to guarantee on the real path.
    enterUnattended: fixture.actions.enter,
    simWalletUsd: simBankrollUsd(shell.simLedger.ledger.balances),
    // Routed through the same function the chain path uses rather than hand-written as "silent", so
    // the fixture exercises the real branch: `signingPlan` answers `{wallet, fixture}` here, and
    // `unattendedSigning` is what decides that signing nothing costs no approval.
    signing: unattendedSigning(session.plan),
    sessionEpoch: session.epoch,
    // There is no chain session, so there is no clock to turn into a number of rounds. The runway
    // says so in words rather than quoting a session length nothing here is running under.
    sessionMinutesLeft: null,
    fee,
    roundLog: fixture.history.rounds,
    youPubkey: fixture.you.pubkey,
    push: shell.toasts.push,
  });
  noteDeployRef.current = autoDeploy.noteDeploy;

  // X IDENTITIES ON THE FIXTURE — this is the path design review actually runs (`?fixture=1`), so
  // `?links=mock` has to work here or the mock has nowhere to be looked at. `mockLinks.ts` assigns
  // its cast to whatever wallets are on screen, which is exactly what the fixture supplies.
  //
  // `?links=off` — the default — makes all of this a no-op.
  //
  // Same priority order as the chain path: the round on screen, then you, then the leaderboard's
  // rows — `rosterCast` dedupes and caps in the order given. Standings are included so 01-2 and 01-3
  // can carry faces at all; without them those boards aggregate over the round LOG and their wallets
  // are mostly not in the round on screen.
  //
  // ON THIS PATH THE ORDER DECIDES MORE THAN THE CAP. `?links=mock` casts six invented identities
  // over this list in the order it is given (`mockLinks.ts#assignMockIdentities`), so putting the
  // round first is what puts faces on the arena — the screen the flag exists to make reviewable.
  // Fifty-two wallets reach the cast and nine of them are fighting; a list composed the other way
  // round would spend the cast on leaderboard rows and leave the canvas exactly as it looks with the
  // feature switched off. The leaderboard's own faces are the remainder, and under this fixture that
  // is one row: with six identities, priority order genuinely costs the boards that sit behind it.
  const fixtureLinkWallets = useMemo(
    () => [
      ...(fixture.live === null ? [] : fixture.live.fighters.map((f) => f.wallet)),
      fixture.you.pubkey,
      ...fixture.standings.map((r) => r.wallet),
    ],
    [fixture.live, fixture.you.pubkey, fixture.standings],
  );
  const fixtureLinks = useLinkFeed(fixtureLinkWallets, fixture.you.pubkey);
  const fixtureLive = useMemo(() => withLinks(fixture.live, fixtureLinks.map), [fixture.live, fixtureLinks.map]);

  const value: ArenaContextValue = {
    source: "fixture",
    ...fixture,
    // AFTER the spread: `fixture.live` is the unstamped round, and this is the one with any linked
    // fighter's avatar path on it. Same substitution the chain provider makes, for the same reason.
    live: fixtureLive,
    fee,
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
    // NOTHING IS BLOCKED IN FIXTURE MODE, because nothing is real: the fixture's `enter`/`extract`
    // are local state changes that always succeed. A gate here would be a warning about a wallet
    // that has no bearing on anything on screen. `?fixture=1` was asked for, and its banner says so.
    gate: null,
    ...shellValue(shell, fixture.you.pubkey),
  };

  return (
    <ArenaContext.Provider value={value}>
      <LinksContext.Provider value={fixtureLinks}>{children}</LinksContext.Provider>
    </ArenaContext.Provider>
  );
}

/** A local toggle. There is no wallet to authorize a session key against in fixture mode, and a
 *  session that silently did nothing would be worse than one that plainly says it's a stand-in. */
function useFixtureSession(): ArenaContextValue["session"] {
  const [active, setActive] = useState(false);
  // THE SAME COUNTER, AND IT IS NOT DECORATION EVEN HERE. The repeat rule's lapsed-session latch
  // clears when this advances, and the fixture is where that machinery gets exercised without a
  // wallet: pressing Start is the fixture's whole notion of "a session was successfully opened", so
  // it is what bumps it. Nothing on this path can ever refuse a transaction, so the latch is never
  // set — but a counter that stood still here would be a stand-in that quietly stopped standing in.
  const [epoch, setEpoch] = useState(0);
  return useMemo(
    () => ({
      active,
      epoch,
      busy: false,
      work: null,
      error: null,
      auto: true,
      // NOTHING ON THIS PATH IS SIGNED AT ALL — the fixture's `enter`/`extract` are local state
      // changes. Routed through `signingPlan` rather than hand-written so the fixture branch is the
      // same branch the tests hold: without it the deploy panel would quote a 0.02 SOL cost, and a
      // first approval that is never coming, over invented data.
      plan: signingPlan({
        fixture: true,
        mode: SIGNER_MODE,
        auto: true,
        sessionActive: active,
        gate: null,
        solBalance: null,
      }),
      start: async () => {
        setActive(true);
        setEpoch((n) => n + 1);
      },
      end: async () => setActive(false),
      // No chain session exists, so there is no expiry to count down and nothing to infer one from.
      // `{ known: false }` is the truthful answer and renders as "expiry unknown" rather than as a
      // fabricated hour on a session that is a boolean.
      life: { known: false } as const,
    }),
    [active, epoch],
  );
}

// ---------------------------------------------------------------------------------------------
// The two identities — everything below them is shared
// ---------------------------------------------------------------------------------------------

/**
 * `?signer=burner` — the local keypair, and the only path that existed before this change.
 *
 * `useSigner()` MINTS AND PERSISTS a keypair, so it is confined to this component: see the header's
 * note on why that cannot be a branch inside a single provider. Behaviour on this path is unchanged
 * — the same keypair signs, pays and ticks as before.
 */
function BurnerChainProvider({ children }: { children: ReactNode }) {
  const { keypair, wallet } = useSigner();
  const identity = useMemo(() => burnerIdentity(keypair, wallet), [keypair, wallet]);
  return <ChainArena identity={identity}>{children}</ChainArena>;
}

/** The default, and what a stranger on the public URL gets: their own Phantom, or an honest account
 *  of why there isn't one yet. */
function WalletChainProvider({ children }: { children: ReactNode }) {
  const phantom = usePhantom();
  // One per page, in memory, holding nothing — `identity.ts`'s landmine 1 explains what it is for
  // and `fightPace.test.ts` proves it can never sign.
  const tickerKeypair = useMemo(() => newTickerPlaceholder(), []);

  const identity = useMemo(
    () =>
      walletIdentity({
        wallet: phantom.wallet,
        status: phantom.status,
        fault: phantom.fault,
        tickerKeypair,
        connect: phantom.connect,
        disconnect: phantom.disconnect,
      }),
    [phantom.wallet, phantom.status, phantom.fault, phantom.connect, phantom.disconnect, tickerKeypair],
  );

  return (
    <ChainArena
      identity={identity}
      providerPresent={phantom.providerPresent}
      connectStalled={phantom.connectStalled}
    >
      {children}
    </ChainArena>
  );
}

// ---------------------------------------------------------------------------------------------
// Chain, with the fixture as the fallback
// ---------------------------------------------------------------------------------------------

function ChainArena({
  identity,
  providerPresent = false,
  connectStalled = false,
  children,
}: {
  identity: ChainIdentity;
  /** Wallet mode only: a Phantom-shaped provider is in the page even if the adapter has not said so.
   *  Splits "install Phantom" from "Phantom is here but silent" — see `walletConnection.ts`. */
  providerPresent?: boolean;
  /** Wallet mode only: the connect handshake has gone unanswered past `CONNECT_PATIENCE_MS`, so the
   *  page stops claiming the player is being asked — see `connectPatience.ts`. */
  connectStalled?: boolean;
  children: ReactNode;
}) {
  const shell = useShell();
  const { tickerKeypair: keypair, anchorWallet: wallet } = identity;
  // `""` WHEN NOBODY IS CONNECTED, and that is the right value rather than a sentinel: every
  // consumer uses it for equality against a fighter's wallet, and no wallet is ever the empty
  // string — so "nobody is you" falls out of the comparison with no consumer knowing this state
  // exists. See `ArenaContextValue.you`.
  const youPubkey = identity.player?.toBase58() ?? "";

  const chain = useChain(wallet, true);
  const { round, live: liveRaw, hitEvents, error: roundError, loading } = useLiveRound(
    chain.program,
    chain.roundPda,
    youPubkey,
  );
  const history = useHistory(chain.program, chain.arena, chain.roundCounter, youPubkey);

  // WHAT THE DOOR CHARGES, off the arena account rather than off a constant this build was compiled
  // with. It rides the arena poll that was already fetching `round_counter` (see `useChain.ts`), so
  // this costs no request; `known` is false only until that first read lands, or if it failed.
  const fee = useMemo(() => feeRate(chain.feeBps), [chain.feeBps]);

  // X IDENTITIES — fetched here rather than from a provider mounted below, and the reason is a cycle.
  // The feed needs the round's roster to ask about, and the canvas needs the answer stamped back onto
  // the fighters it draws; a child provider could do the first but could never feed the second back
  // up. So it lives at the top of the data layer, where both halves are in hand.
  //
  // OFF UNLESS ASKED FOR. `data/linkSource.ts` defaults to `off`, in which case this never fetches
  // and `withLinks` finds an empty map and hands back the very same object it was given — so the memo
  // graph below is untouched and every player renders exactly as they did before this existed.
  // Hoisted above the link feed — it depends only on `history.rounds`, which is already in hand, and
  // the feed has to know which wallets the LEADERBOARD will render. Without it those rows can never
  // carry a face: standings are aggregated over the round LOG, so their wallets are mostly not in the
  // round currently on screen.
  const standings = useMemo(() => deriveStandings(history.rounds), [history.rounds]);

  // WHO WE ASK ABOUT, IN PRIORITY ORDER — `rosterCast` dedupes and caps this list IN THE ORDER GIVEN,
  // so the order here is the policy. The round on screen first (those faces are the point of the
  // feature), then the connected player (their own wallet panel shows their identity whether or not
  // they have entered), then the leaderboard's rows. Under `?links=mock` the same order also decides
  // which wallets the fixture's identities land on; on the `api` path the server answers about all of
  // them and the order only decides who survives the cap.
  //
  // The cap is `MAX_WALLETS_PER_QUERY`, so at a full 48-fighter round only the top handful of
  // standings rows fit. That is the honest trade for a single query; a second request per view is the
  // right answer once a screen other than the arena is the common destination, and is a follow-up
  // rather than something to guess at now.
  const linkWallets = useMemo(() => {
    const inRound = liveRaw === null ? [] : liveRaw.fighters.map((f) => f.wallet);
    const you = youPubkey === "" ? [] : [youPubkey];
    return [...inRound, ...you, ...standings.map((r) => r.wallet)];
  }, [liveRaw, youPubkey, standings]);
  const links = useLinkFeed(linkWallets, youPubkey === "" ? null : youPubkey);
  // Substituted for `live` from here down, so nothing below can accidentally read the unstamped
  // rosters: `markLinkedFighters` returns the very same array when nothing changed — the
  // overwhelmingly common case, since most players never link — so nothing below re-renders for a
  // poll that found nothing.
  const live = useMemo(() => withLinks(liveRaw, links.map), [liveRaw, links.map]);

  // THE FIGHT, IN EVENTS. Cut from the same memoised stream the canvas replays, at the same cursor —
  // see `combatFeed.ts` for why this cannot be a scan and how it stays cheap at `stepsPerSecond(16)`.
  const combat = useMemo(
    () =>
      live === null ? NO_COMBAT : combatFeed({ hitEvents, fighters: live.fighters, stepsNow: live.stepsNow }),
    [hitEvents, live],
  );

  // THE HOUSE'S OWN BOOKS. Read off the `Treasury` PDA on its own slow schedule and NOT on the round
  // poll — it moves once per sweep, which is once per round at most. See `useTreasury.ts`.
  const treasury = useTreasury(chain.program, chain.arena, chain.roundCounter);

  // Session Keys. `baseConnection`, not the router: `create_session`/`revoke_session` call the
  // `gpl_session` program directly and it is never ER-delegated (see useSessionKeyManager.ts).
  const anchorWallet = useMemo(() => toAnchorWallet(wallet), [wallet]);
  const sessionManager = useAppSessionManager(anchorWallet, chain.baseConnection, "devnet", PROGRAM_ID);

  // BEFORE `useActions`, because the write path is gated on the balance this reads. The ordering is
  // load-bearing rather than stylistic: `gate` needs `solBalance`, and `useActions` needs `gate`.
  const walletValue = useWallet(identity, chain.baseConnection, shell.toasts.push);

  // THE ONE VERDICT. Every disabled control on the page renders this, and so does the write path
  // itself — which is what stops a button and its transaction disagreeing about whether an action
  // was available. See `playGate.ts`.
  const gate = useMemo(
    () =>
      playBlock({
        mode: identity.mode,
        programReady: chain.program !== null,
        walletStatus: identity.status,
        providerPresent,
        connectStalled,
        fault: identity.fault,
        solBalance: walletValue.solBalance,
        pubkey: youPubkey,
      }),
    [identity.mode, identity.status, identity.fault, chain.program, providerPresent, connectStalled, walletValue.solBalance, youPubkey],
  );

  const sessionCtl = useSessionController({
    manager: sessionManager,
    mode: identity.mode,
    walletPubkey: youPubkey,
    gate,
    solBalance: walletValue.solBalance,
    push: shell.toasts.push,
  });

  // COULD THE NEXT DEPOSIT BE SIGNED WITH NOBODY IN THE ROOM — and if not, why. It is asked once,
  // here, off the same `SigningPlan` the write path acts on, so the rule's status line and the
  // transaction can never disagree about what signing this move would cost. `autoPolicy.ts` sorts
  // every plan into "silent" and "costs an approval" and is total over the type, so a new plan shape
  // fails the build here rather than defaulting to silent and shipping a dialog nobody can answer.
  //
  // THE GATE IS ASKED FIRST, AND IT HAS TO BE ASKED HERE. `signingPlan` consults `gate` fourth, below
  // a live session and below burner mode, which is right for its own question — "how would this be
  // signed" — and wrong for this one. With a session live and the gate blocking (a wallet whose
  // devnet SOL ran out mid-run is the realistic case, since `playGate` blocks on the WALLET's balance
  // while the session key pays its own fees), the plan answers `{kind:"session"}`, this answers
  // "silent", the rule fires, and `requireReady` throws the gate's own copy back at it — one failed
  // attempt and one red toast per round, forever, for a condition that is a HOLD with a sentence
  // already on screen. Nothing may be sent unattended when nothing may be sent at all, and
  // `no-signer`'s wording ("the wallet panel says what is missing") is exactly the account owed.
  const unattended = useMemo<UnattendedSigning>(
    () => (gate !== null ? { kind: "blocked", reason: "no-signer" } : unattendedSigning(sessionCtl.plan)),
    [gate, sessionCtl.plan],
  );

  const { onEntered, bookSimOnly, noteDeployRef } = useOnEntered(shell.simLedger.recordDeploy, fee);
  const actions = useActions({
    program: chain.program,
    router: chain.router,
    player: identity.player,
    fallbackSigner: identity.txSigner,
    arena: chain.arena,
    roundPda: chain.roundPda,
    live,
    // The round `roundPda` was derived from, so a confirmed deposit is booked against the round it
    // was written to rather than the round the poll happens to have read by the time it lands.
    targetRoundNo: chain.roundNo,
    plan: sessionCtl.plan,
    signing: sessionCtl.signing,
    blocked: gate,
    onEntered,
    push: shell.toasts.push,
  });

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
  // ────────────────────────────────────────────────────────────────────────────────────────────
  // THE INVARIANT THAT KEEPS THE WALLET-MODE PLACEHOLDER KEY UNREACHABLE LIVES HERE, at this call
  // site, and nowhere else — so it is written here rather than only in `identity.ts`/`fightPace.ts`,
  // neither of which is where the mistake would be made.
  //
  // `session` and `sessionActive` MUST STAY DERIVED FROM THE SAME EXPRESSION in the same render.
  // `useFightTicker` writes `{keypair, session, enabled}` into a ref as ONE object literal and its
  // pump snapshots that ref once, with no `await` between the snapshot and the signer branch. So the
  // guarantee is exactly: `enabled === true` ⇒ `session !== null` ⇒ the session signs. Both fields
  // below read `sessionManager.active`, which is what makes that implication hold.
  //
  // Feed `enabled` from a different source than `session` — a debounced copy, a separate piece of
  // state, a `sessionActive` boolean cached anywhere — and the placeholder keypair becomes reachable
  // in wallet mode: a key holding nothing, signing ticks that can never land. `fightPace.test.ts`
  // proves `shouldDriveFight`'s half; only this line can prove the other half.
  // ────────────────────────────────────────────────────────────────────────────────────────────
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
      // In wallet mode this is what keeps `keypair` above — a placeholder that holds nothing —
      // out of the ticker's signing branch. See `identity.ts`'s landmine 1.
      mode: identity.mode,
    }),
  });

  const fixture = useFixtureArena({
    active: fallback,
    push: shell.toasts.push,
    // BOOKS THE PLAY MONEY AND CONFIGURES NOTHING. The repeat rule below is pointed at the chain, and
    // a press on the invented round on screen is not a deposit it may learn a side from — see
    // `useOnEntered` for the whole of that argument and for what it cost when the two were one
    // callback.
    recordDeploy: bookSimOnly,
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
    // NOT `actions.enter`, AND THE DIFFERENCE IS THE FEATURE. `enter` recovers from a lapsed session
    // by replacing it — revoke-then-create, two Phantom approvals — which is the right answer for
    // somebody who just pressed a button and the wrong one for a timer. This sender cannot open a
    // session, renew one, or fall back to the wallet, and cannot extract. See `useActions.ts` and
    // `autoPolicy.ts`.
    enterUnattended: actions.enterUnattended,
    simWalletUsd: simBankrollUsd(shell.simLedger.ledger.balances),
    signing: unattended,
    sessionEpoch: sessionCtl.session.epoch,
    // THE ADVISORY COUNTDOWN, AND IT REACHES ONLY THE COPY. `sessionExpiry.ts` is emphatic that the
    // inference must never gate an action, and it does not: the runway uses it to name which bound
    // runs out first, and `{ known: false }` — a session restored from a previous visit, which is a
    // common state and not an edge one — simply takes it out of the comparison.
    sessionMinutesLeft: sessionCtl.session.life.known ? sessionCtl.session.life.minutesLeft : null,
    fee,
    roundLog: history.rounds,
    youPubkey,
    push: shell.toasts.push,
  });
  noteDeployRef.current = autoDeploy.noteDeploy;

  // WHAT THAT AGGREGATE ACTUALLY COVERS. `roundCounter` is the denominator — the arena's own count of
  // every round it ever opened — and holding the log against it is the only way a screen can know
  // whether "all time" is a claim it can back. Null until the arena has been read once, which
  // `deriveLogCoverage` resolves to `complete: false` rather than to a guess.
  const logCoverage = useMemo(
    () => deriveLogCoverage(history.rounds, chain.roundCounter),
    [history.rounds, chain.roundCounter],
  );
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

  // NOBODY IS "YOU" UNTIL SOMEBODY CONNECTS. `nameFor("")` is deliberately not called: it is a pure
  // hash and would happily mint a stable pseudonym for the empty string, printing an invented
  // fighter name beside a Connect button.
  const you = useMemo(
    () =>
      youPubkey === ""
        ? { pubkey: "", short: "—", name: "—" }
        : { pubkey: youPubkey, short: shortKey(youPubkey), name: nameFor(youPubkey) },
    [youPubkey],
  );

  const session = sessionCtl.session;

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
        // THE WALLET AND THE GATE STAY REAL, even while the round on screen is invented — and this
        // is the one place the fixture is deliberately NOT allowed to be total.
        //
        // The fallback's most common cause is "no round is open right now", which is exactly the
        // moment a visitor should be connecting a wallet in readiness for the next one. Handing them
        // the fixture's mock wallet there would delete the entire connect funnel during the gaps
        // between rounds, and would show a "connected" mock account to somebody whose real Phantom
        // is not connected at all. Round data is fiction here; whether this browser can sign is not.
        wallet: walletValue,
        gate,
        // AND SO DOES THE TREASURY, for the same reason and a different one. Same reason: it stays
        // real because it CAN be. Different one: it is ARENA state, not round state, and the fallback
        // is about there being no ROUND — the most common cause of it, by some distance, is "no round
        // has been opened yet", where the arena and its books read perfectly well. Handing over the
        // fixture's derived zeros there would replace a readable figure with an invented one, in the
        // single tile `UI-SPEC.md` ordered fixed because it was showing a modelled number beside a
        // real one. When the chain genuinely cannot be read this is null, which renders `—`.
        treasury,
        // AND THE FEE, ON EXACTLY THE TREASURY'S ARGUMENT — it is arena state, the fallback is about
        // there being no ROUND, and in the fallback's commonest cause ("no round has been opened
        // yet") the arena account reads perfectly well. A visitor waiting out the gap between rounds
        // is entitled to the rate the next one will charge them, not the fixture's invented 20. When
        // the arena genuinely cannot be read, `known` is false and the surfaces say so.
        fee,
        ...shellValue(shell, fixture.you.pubkey),
      }
    : {
        source: "chain",
        you,
        status,
        live,
        hitEvents,
        combat,
        treasury,
        fee,
        history,
        standings,
        logCoverage,
        bigWins,
        hall,
        sideRecord,
        actions,
        autoDeploy,
        session,
        wallet: walletValue,
        gate,
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

  return (
    <ArenaContext.Provider value={value}>
      {/* The verified identities, for the DOM surfaces that render a handle. The CANVAS does not read
          this — it gets one validated path per fighter on `FighterView.avatarSrc` above, because
          `SPEC.md` says the arena never touches data. */}
      <LinksContext.Provider value={links}>{children}</LinksContext.Provider>
    </ArenaContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// The session controller
// ---------------------------------------------------------------------------------------------

/**
 * HOW LONG TO WAIT FOR THE MANAGER'S STATE TO CATCH UP WITH A CALL WE JUST MADE — and why any wait
 * is needed at all, which is the one genuinely awkward thing in this file.
 *
 * `createSession` resolves `void`. gum's own hook DOES return the new session object, but the app's
 * wrapper (`chain/session/useSessionKeyManager.ts`, which this workstream may not edit) discards it
 * — so the only evidence a session now exists is that the hook's state has changed, and state
 * changes reach this component on a LATER RENDER. React 18 batches updates made inside a promise,
 * so the continuation after `await createSession()` runs BEFORE the re-render it caused.
 *
 * A player pressing Deploy is therefore in the one situation React has no synchronous answer for:
 * the session exists, and this render does not know it yet. So the write path waits for the render,
 * and exits the moment the answer is in either direction — a session appeared, or gum's error
 * channel filled (`withLoading` clears it at the start of every call, so a non-null error after one
 * belongs to that call).
 *
 * BOUNDED TWO WAYS, because the two failure modes pull in opposite directions. A fixed number of
 * polls, so that giving up early is impossible — reporting "no session arrived" when one had would
 * throw away 0.02 SOL and open a second popup, much the worst outcome here. And a wall-clock
 * ceiling, because a HIDDEN tab has its timers throttled to roughly one a second, which is exactly
 * the state a tab is in while its owner is reading a wallet dialog: forty polls would then be forty
 * seconds of dead buttons rather than one. Neither bound is expected to be reached; a commit
 * normally lands within a frame or two.
 */
const SESSION_SETTLE_POLLS = 40;
const SESSION_SETTLE_STEP_MS = 25;
const SESSION_SETTLE_CEILING_MS = 15_000;

export interface SessionControllerParams {
  manager: SessionManager;
  mode: SignerMode;
  /** `""` when nobody is connected. Only used to notice that a DIFFERENT wallet is now in play. */
  walletPubkey: string;
  gate: PlayBlock | null;
  solBalance: number | null;
  push: (text: string, kind?: "info" | "error") => void;
}

/**
 * THE SESSION, MADE INVISIBLE — everything between `useAppSessionManager`'s four exports and a page
 * where a player approves one thing per session rather than one thing per move.
 *
 * It owns three jobs the rest of the file should not have to think about:
 *
 *   OPENING. The first deploy or extract opens a session and then signs with it, in one press
 *   (`autoSession.ts`'s `runSigned` sequences it; `useActions` calls it). Nothing asks first.
 *
 *   RENEWING. gum REUSES ITS SESSION KEYPAIR — `createSession` only generates one when
 *   `keypairRef.current` is empty (read from the compiled hook; it ships no source, see
 *   `useSessionKeyManager.ts`'s header). The session token PDA is derived from that keypair, so a
 *   second `createSession` targets an account that already exists. PROVED, not assumed:
 *   `scripts/verify-session-renewal.mjs` runs it against the deployed program on devnet and the
 *   second attempt fails with `custom program error: 0x0` — Anchor's `init` on a live account —
 *   while a revoke-then-create with the same signer succeeds. An IDL cannot answer this (`init` and
 *   `init_if_needed` look identical in one), and everything the page tells a player about renewal
 *   rests on the answer. So `renew` revokes first, and the copy says two approvals rather than one.
 *   The revoke is not wasted: it closes the old token and sweeps the session key's unspent SOL back
 *   to the wallet.
 *
 *   STOPPING, AND STAYING STOPPED. `auto` is the player's own instruction, and `signingPlan` refuses
 *   to use a session while it is false — even one that is still live, because a revoke can fail and
 *   a Stop button that quietly kept using the key would be a lie.
 */
function useSessionController(params: SessionControllerParams): {
  session: ArenaContextValue["session"];
  plan: ReturnType<typeof signingPlan>;
  signing: SessionSigning<ActiveSession>;
} {
  const { manager, mode, walletPubkey, gate, solBalance, push } = params;
  const { active, error, isLoading } = manager;

  // MIRRORS, WRITTEN ON EVERY RENDER, and there are two different reasons for the two kinds.
  //
  // THE STATE (`active`, `error`) is mirrored because the async callbacks below run BETWEEN renders
  // and must never act on the session this render happened to close over — the value they read is
  // the one that decides whether a transaction opens a wallet popup. Same device as `useOnEntered`'s
  // `feeRef`.
  //
  // THE CALLBACKS (`createSession`, `revokeSession`) are mirrored because they are NOT STABLE and
  // destructuring them does not make them so — which is what the comment that used to sit here
  // claimed. `useAppSessionManager` memoises both, but lists gum's hook return in their dependency
  // arrays, and gum builds that as a fresh object literal on every render. So both identities change
  // every render, and depending on them would rebuild every callback in this hook, the `signing`
  // object, and `useActions`' `enter`/`extract` — on a component that re-renders every 250ms during
  // a fight. Nothing breaks today only because `useAutoDeploy` reads `enter` off a ref rather than an
  // effect dependency; the first effect keyed on `actions.enter` would get a 250ms loop.
  const activeRef = useRef(active);
  activeRef.current = active;
  const errorRef = useRef(error);
  errorRef.current = error;
  const createSessionRef = useRef(manager.createSession);
  createSessionRef.current = manager.createSession;
  const revokeSessionRef = useRef(manager.revokeSession);
  revokeSessionRef.current = manager.revokeSession;

  /** Wait until the manager's state satisfies `done`, or give up. See `SESSION_SETTLE_POLLS`. */
  const settled = useCallback(
    async (done: (s: ActiveSession | null) => boolean): Promise<ActiveSession | null> => {
      const ceiling = Date.now() + SESSION_SETTLE_CEILING_MS;
      for (let poll = 0; poll < SESSION_SETTLE_POLLS; poll += 1) {
        if (done(activeRef.current)) return activeRef.current;
        if (Date.now() > ceiling) break;
        await new Promise((resolve) => setTimeout(resolve, SESSION_SETTLE_STEP_MS));
      }
      return activeRef.current;
    },
    [],
  );

  /** THE PLAYER'S OWN INSTRUCTION, and the only thing that turns this off. In memory only: a reload
   *  is a fresh visit, not a standing preference, and a page that remembered one Stop forever would
   *  quietly sentence that browser to a popup per move for good. */
  const [auto, setAuto] = useState(true);
  // READ FROM THE MIDDLE OF AN ACTION, not from a render — see `signing.renew`. A press can span
  // several seconds of chain confirmation, and Stop can land inside that window.
  const autoRef = useRef(auto);
  autoRef.current = auto;
  // A DIFFERENT WALLET INHERITS NOTHING. "I do not want sessions" was said by whoever was connected
  // at the time; carrying it across to the next account would apply one person's decision to
  // somebody else's key.
  useEffect(() => {
    setAuto(true);
  }, [walletPubkey]);

  /**
   * Revoke whatever is live and drop its clock. Shared by the player's Stop and by a renewal, so the
   * stored start time can never outlive the session it described.
   *
   * `true` when there is no live session left — which is NOT the same as "the call returned". gum's
   * `revokeSession` swallows its own failures and resolves anyway, so the only evidence the token
   * closed is the manager reporting no session, and that arrives on a later render like everything
   * else here. The clock is forgotten only on that evidence: forgetting it after a revoke that in
   * fact failed would leave the session running with no record of when it started, and the next
   * visit would confidently restart its hour from zero.
   */
  const revokeLive = useCallback(async (): Promise<boolean> => {
    const token = activeRef.current?.sessionTokenPda.toBase58() ?? null;
    if (token === null) return true;
    await revokeSessionRef.current();
    if ((await settled((s) => s === null)) !== null) return false;
    forgetSession(token);
    return true;
  }, [settled]);

  /**
   * WHAT THE SESSION MACHINERY IS DOING — tracked here because the manager's `isLoading` cannot
   * answer it, in two different directions, and both of them cost a player something.
   *
   * TOO HIGH: gum wraps `signTransaction` in the SAME `withLoading` helper as `createSession`, so
   * `busy` is equally true while an ordinary session-signed deploy is being signed — a hundred times
   * an hour, silently. A dock reading "approve the play session in Phantom" off that would say it
   * during every move that needed no approval at all.
   *
   * TOO LOW, WHICH IS THE DANGEROUS ONE: `revokeSession` calls `sendTransaction` to sweep the
   * session key's balance back to the wallet, and `sendTransaction` is wrapped in `withLoading` too
   * — so its `finally` clears `isLoading` while the revoke around it is still running. Any control
   * disabled on `busy` therefore RE-ENABLES in the middle of a renewal, and a second press there
   * sends a second `revoke_session` for a token already being revoked: a wallet dialog nobody could
   * possibly explain. This flag stays set across the whole of both calls.
   */
  const [work, setWork] = useState<SessionWork>(null);

  /**
   * ONE `create_session` AT A TIME, and this is not defensive decoration.
   *
   * gum reuses its session keypair (see this hook's header), so two overlapping opens would build
   * two transactions against the SAME token PDA: the first initialises it, the second fails on an
   * account that already exists — after the wallet has already been asked to approve a second
   * 0.02 SOL transfer. The buttons are disabled through a press, so this is a backstop rather than
   * a routine path; it is the kind of backstop worth having when the failure mode spends money.
   */
  const openInFlight = useRef<Promise<ActiveSession> | null>(null);

  /**
   * HOW MANY SESSIONS THIS TAB HAS SUCCESSFULLY OPENED — the identity the repeat rule's lapsed-
   * session latch is keyed on. `ArenaContextValue.session.epoch` carries the full argument for why
   * it is a count rather than the session token PDA (gum reuses the session signer keypair across a
   * renewal, so the PDA is stable across one and a latch keyed on it would never clear); what
   * belongs here is where it moves.
   *
   * IT IS BUMPED IN EXACTLY ONE PLACE, and that place covers all three entry points because every
   * path to a NEW session runs through this function: `openSession` wraps it, `renewSession` revokes
   * and then calls `openSession`, and the rail's Start does one or the other. Bumping at the call
   * sites instead would be three chances to miss one, and a missed bump is a rule that stays dead
   * with a working session key in its hand.
   *
   * ON SUCCESS ONLY. `createSession` resolves whether or not it worked — gum swallows its own
   * failures — so this sits after the evidence that a session actually exists, not after the call.
   *
   * AND IT DOES NOT CHECK THAT THE SESSION IS A DIFFERENT ONE, which looks like an omission and is
   * the opposite. The obvious guard — bump only if the token address changed — would suppress the
   * bump on a RENEWAL, because gum reuses the session signer and therefore renews to the identical
   * PDA. That is the same fact that rules the PDA out as the latch's key, and it rules it out here
   * for the same reason. The residual cost of bumping once too often is one refused transaction that
   * re-latches immediately; the cost of bumping once too seldom is a rule that stays dead holding a
   * working session key, so the direction to err in is not in doubt.
   */
  const [sessionEpoch, setSessionEpoch] = useState(0);

  /** One `create_session`, start to finish: the wallet approval, the wait for the manager to catch
   *  up, and an honest throw when nothing arrived. Wrapped by `openSession`, never called directly. */
  const createFresh = useCallback(async (): Promise<ActiveSession> => {
    setWork((w) => w ?? "opening");
    try {
      await createSessionRef.current();
      // EITHER ANSWER ENDS THE WAIT. Polling for the session alone would spend the whole window on
      // every cancelled approval — a second of dead buttons after the player has already dismissed
      // the dialog and is waiting to be told what happened.
      const opened = await settled((s) => s !== null || errorRef.current !== null);
      if (opened !== null) {
        setSessionEpoch((n) => n + 1);
        return opened;
      }
      // gum SWALLOWS ITS OWN FAILURES: `createSession` catches everything, calls `setError` and
      // resolves anyway (read from the compiled hook). So "no session arrived" is the only signal
      // there is that anything went wrong, and the reason — a cancelled popup, an unfunded wallet —
      // is over in the error channel. Thrown from here so the ONE decision about what a failure
      // means stays in `autoSession.ts` rather than being made twice.
      throw new Error(
        errorRef.current ??
          "the play session could not be opened, and neither the wallet nor the session SDK said why",
      );
    } finally {
      setWork(null);
    }
  }, [settled]);

  const openSession = useCallback(async (): Promise<ActiveSession> => {
    const running = openInFlight.current;
    if (running !== null) return await running;
    const attempt = createFresh();
    openInFlight.current = attempt;
    try {
      return await attempt;
    } finally {
      openInFlight.current = null;
    }
  }, [createFresh]);

  const renewSession = useCallback(async (): Promise<ActiveSession | null> => {
    setWork("renewing");
    try {
      // A session still standing here is a revoke that failed — and going on to open one would
      // collide with the token it did not close. Better to report the chain's original refusal than
      // to add a doomed approval dialog to it.
      if (!(await revokeLive())) return null;
      return await openSession();
    } catch (e) {
      // A renewal is a recovery, not a request: whatever went wrong, the caller's own error is the
      // one worth showing (`autoSession.ts`'s `runSigned` re-throws the chain's refusal), and a
      // second red toast about the recovery would bury it.
      //
      // LOGGED, THOUGH, because this catch is otherwise the end of the evidence. From the outside
      // every failure here looks identical — "extract keeps failing with session-expired" — and
      // whether the revoke was cancelled, the create was rejected, the balance pre-flight refused or
      // the wait timed out is the whole of the diagnosis. gum logs its own two; this covers ours.
      console.error("[session] renewal failed", e);
      return null;
    } finally {
      setWork(null);
    }
  }, [revokeLive, openSession]);

  /** The rail's Start: make sure a FRESH session exists, whatever is there now, and re-arm `auto`.
   *
   *  It renews rather than opens when one is already live — pressing Start with a stale session in
   *  hand used to be a silent no-op-then-failure for the keypair-reuse reason in this hook's header,
   *  which is exactly the state a player would be in when they went looking for the button. */
  const startSession = useCallback(async () => {
    setAuto(true);
    // Written straight through for the same reason `endSession` writes the other direction: this ref
    // is read from the middle of an action, and an explicit Start must be visible to a refusal that
    // lands before the next render.
    autoRef.current = true;
    if (activeRef.current !== null) {
      const renewed = await renewSession();
      if (renewed === null) {
        throw new Error(errorRef.current ?? "the play session could not be replaced");
      }
      return;
    }
    await openSession();
  }, [renewSession, openSession]);

  /** The rail's Stop. `auto` goes down FIRST, so the instruction is recorded even if the on-chain
   *  revoke fails — `signingPlan` will not touch a session the player has stopped. */
  const endSession = useCallback(async () => {
    setAuto(false);
    // Written straight through as well as through state: `signing.renew` reads this ref, and a
    // refusal arriving from a move already in flight must see the Stop that just happened rather
    // than the value from the render before it.
    autoRef.current = false;
    setWork("stopping");
    try {
      await revokeLive();
    } finally {
      setWork(null);
    }
  }, [revokeLive]);

  // THE BOOLEAN, NOT THE SESSION OBJECT, in the dependency list — and it is worth a line. gum builds
  // a fresh `signTransaction` closure on every render, so `manager.active` changes identity every
  // render even when the same session has been live for forty minutes. Depending on it would rebuild
  // this plan, and with it every callback in `useActions` that reads it, on every single render.
  const sessionActive = active !== null;
  const plan = useMemo(
    () => signingPlan({ fixture: false, mode, auto, sessionActive, gate, solBalance }),
    [mode, auto, sessionActive, gate, solBalance],
  );

  const signing = useMemo<SessionSigning<ActiveSession>>(
    () => ({
      current: () => activeRef.current,
      open: openSession,
      // THE STOP INSTRUCTION IS RE-READ HERE, and that is not belt and braces. `runSigned` takes the
      // PLAN from the render it was built in, but a press spans seconds of chain confirmation — long
      // enough for a player watching nothing happen to open the rail and press Stop. Without this
      // check the refusal that arrives a moment later would revoke, spend 0.02 SOL and raise a wallet
      // dialog on behalf of somebody who had just said no. The rail's own Start goes through
      // `startSession`, not this wrapper, so an explicit renewal is unaffected.
      renew: async () => (autoRef.current ? await renewSession() : null),
      classify: (e) => classifyWalletError(e).code,
      // SAID ONCE, AND NOT AS A FAILURE. The move itself is fine — it is about to be signed by the
      // wallet — so this is not an error, it is the page accounting for the popup that is about to
      // appear when the player had been told there would not be one. `info`, not `error`, for
      // exactly that reason.
      onFallback: (e) =>
        push(`No play session this time, so this move needs one wallet approval — ${classifyWalletError(e).detail}`, "info"),
    }),
    [openSession, renewSession, push],
  );

  // HOW LONG THE SESSION HAS LEFT — recorded when one appears, read back by its token address.
  // Advisory only; `sessionExpiry.ts` sets out why, and why the authoritative path is the reactive
  // renewal in `autoSession.ts`.
  const sessionToken = active?.sessionTokenPda.toBase58() ?? null;

  // A token appearing is how a successful `createSession` announces itself: gum resolves the address
  // only once the session genuinely exists, so recording here books the start time against a real
  // session rather than against an attempt. Idempotent — `noteSessionStarted` writes the same key,
  // and re-recording would move the clock, so it only writes when nothing is stored.
  //
  // AN EFFECT, NOT A MEMO, and the distinction is not pedantry: this writes to `localStorage`, and a
  // memo body must be pure. React is free to discard a render and recompute — under StrictMode it
  // deliberately does — and a persisted record written from a render that was then thrown away is a
  // clock started by a session that, from the component's point of view, never happened. It is
  // idempotent enough to have been harmless today; it is the kind of harmless that stops being
  // harmless when someone later makes the write unconditional.
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (sessionToken === null) {
      setSessionStartedAt(null);
      return;
    }
    const existing = readSessionStartedAt(sessionToken);
    if (existing !== null) {
      setSessionStartedAt(existing);
      return;
    }
    const now = Date.now();
    noteSessionStarted(sessionToken, now);
    setSessionStartedAt(now);
  }, [sessionToken]);

  return {
    session: {
      active: sessionActive,
      epoch: sessionEpoch,
      busy: isLoading,
      work,
      error,
      auto,
      plan,
      start: startSession,
      end: endSession,
      life: sessionLife(sessionStartedAt, Date.now()),
    },
    plan,
    signing,
  };
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
