// The single object every v2 view reads from. Split out of `ArenaProvider.tsx` so the views can
// import the TYPE without importing the provider's implementation (and everything it pulls in:
// anchor, web3.js, the session SDK) — and so the real provider and the mock one are provably the
// same shape.

import type { HitEvent } from "../../sim/hitEvents.ts";
import type { VerifyResult } from "../../ui/verifyRound.ts";
import type { AutoDeployHandle } from "./autoDeploy.ts";
import type { SessionWork, SigningPlan } from "./autoSession.ts";
import type { SignerMode } from "./flags.ts";
import type { PlayBlock } from "./playGate.ts";
import type { SessionLife } from "./sessionExpiry.ts";
import type { WalletStatus } from "./walletConnection.ts";
import type { WalletFault } from "./walletFault.ts";
import type {
  ArenaMeta,
  BigWin,
  BoardStyle,
  CombatFeed,
  ExtractEligibility,
  FeeRate,
  HouseDisclosure,
  LiveRound,
  LogCoverage,
  Mode,
  RoundPlayer,
  RoundSummary,
  Side,
  SideRecord,
  SimLedger,
  SimLedgerActions,
  StandingsRow,
  TreasuryState,
} from "../contract.ts";

export type ToastKind = "info" | "error" | "a" | "b";

export interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

/** Where everything below came from.
 *
 *  `"chain"` — a real round account on devnet, polled live.
 *  `"fixture"` — `mockData.ts`, because `?fixture=1` was passed OR the chain could not be read (no
 *  round open, IDL unreachable, RPC down). The page stays alive either way; what it must never do is
 *  let a reader mistake one for the other, so every surface showing round data checks this and says
 *  so. `status.programError`/`status.roundError` carry the reason when the fallback wasn't asked for.
 */
export type DataSource = "chain" | "fixture";

export interface ArenaContextValue {
  source: DataSource;

  /** THE LOCAL PLAYER. When nobody is connected, `pubkey` is `""` and the other two are `"—"`.
   *
   *  The empty string is the correct value rather than a sentinel hack: every consumer uses it for
   *  equality against a fighter's wallet (`f.wallet === you.pubkey`), and no wallet is ever `""` —
   *  so "nobody is you" falls out of the comparison for free, with no consumer needing to know that
   *  a disconnected state exists. `name` is deliberately NOT `nameFor("")`, which would invent a
   *  stable pseudonym for nobody and print it beside a Connect button. */
  you: { pubkey: string; short: string; name: string };

  status: {
    programReady: boolean;
    /** Fatal: no program means no round, no deploy, no extract. Show it as a persistent banner. */
    programError: string | null;
    roundError: string | null;
    /** True only for the very first round fetch — later polls update in place. */
    loading: boolean;
    roundNo: bigint | null;
  };

  live: LiveRound | null;
  /** The full precomputed hit stream for the current fight; empty outside Fight/Settled.
   *
   *  RAW, AND ALMOST NOTHING SHOULD WANT IT. It is the canvas's input — indices, bigint steps, no
   *  fighters attached — and it runs to `finalCursor(fighterCount)` regardless of where the playhead
   *  is. A surface
   *  that wants to NARRATE the fight wants `combat` below, which is this stream cut at the cursor and
   *  resolved to fighters, done once instead of once per consumer. */
  hitEvents: HitEvent[];

  /** THE FIGHT, IN EVENTS — the recent tail of `hitEvents`, resolved against the current roster. See
   *  `CombatFeed` for the shape, the ordering guarantee and how a consumer dedupes against `at`. */
  combat: CombatFeed;

  /** WHO IN THE ROUND ON SCREEN IS THE HOUSE'S, counted from the same pass that set each
   *  `FighterView.house`. Both counts are null when nothing is publishing a disclosure list, which is
   *  a different fact from "none of them are" — see `HouseDisclosure`. */
  houseDisclosure: HouseDisclosure;

  /** THE ARENA'S HOUSE BOOKS, off the `Treasury` PDA. Null means not read yet OR never initialised
   *  (`init_treasury` is a separate admin call) — never "holds nothing", which is a real state that
   *  renders as a zero. See `TreasuryState`, and `houseTook()` for the same figure per round. */
  treasury: TreasuryState | null;

  /** WHAT ENTRY COSTS, off `Arena.fee_bps` — the rate the program will actually charge, not a
   *  constant this build was compiled with.
   *
   *  Arena state, like `treasury` beside it, and it stays REAL on the fixture FALLBACK for the same
   *  reason: the fallback is about there being no ROUND, and the account that carries the rate
   *  usually reads perfectly well in that state. Only a forced `?fixture=1` gets an invented one.
   *
   *  `known` is false until the first arena read lands. Never render `bps` as a bare figure while it
   *  is — `views/feeCopy.ts` holds the wording, and the reason. */
  fee: FeeRate;

  history: {
    /** Newest first. Every round account that exists, not just settled ones. */
    rounds: RoundSummary[];
    loading: boolean;
    error: string | null;
    refresh(): void;
  };
  /** From the round log only — never from live balances. Best P/L first.
   *
   *  NOT "ALL-TIME" UNLESS `logCoverage.complete` SAYS SO. The log is the newest N rounds, and this
   *  aggregate inherits that window whole — see `logCoverage` directly below. */
  standings: StandingsRow[];
  /** HOW MUCH OF THE ARENA'S HISTORY `standings`, `hall`, `bigWins` and `sideRecord` were actually
   *  computed over — see `LogCoverage`. It exists so those four can stop claiming a window is all
   *  time, which `SideRecord` has refused to do since it was written and nothing else has. */
  logCoverage: LogCoverage;
  /** Profit only. It is a WINS ticker. */
  bigWins: BigWin[];
  /** Best single-round performances, all time. */
  hall: RoundPlayer[];
  /** THE TWO SIDES' HEAD-TO-HEAD RECORD over `history.rounds` — see `SideRecord`, which carries its
   *  own coverage because that log is a newest-N window and must never be labelled "all time".
   *
   *  `null` means NOT KNOWN YET (the first fetch is in flight and nothing has arrived), which is not
   *  the same fact as a nil-all and must not render as one. An empty-but-loaded log is a real 0–0. */
  sideRecord: SideRecord | null;

  actions: {
    enter(side: Side, stakeUnits: bigint): Promise<string>;
    extract(): Promise<string>;
    entering: boolean;
    extracting: boolean;
    /** Legality AND price — see `ExtractEligibility`. It carries `keep`/`forfeit` because the
     *  house's cut is charged at the instant the transaction lands, so "can you" and "for how much"
     *  are answered by the same read of the same cursor. */
    extractEligible: ExtractEligibility;
  };

  /** REPEAT EVERY ROUND — the standing instruction to deposit into each new round without being
   *  asked. It is on the context, not inside the Deploy panel, because it is a rule about spending
   *  money and must keep running while someone is reading the Leaderboard; see `useAutoDeploy.ts`.
   *  The panel in 00-3 renders this and calls `arm`/`disarm`; it decides nothing itself. */
  autoDeploy: AutoDeployHandle;

  /** THE SESSION KEY — which is not a feature of this page so much as the way it signs.
   *
   *  A session is opened by the FIRST deploy or extract and signs everything until it runs out, so
   *  the ordinary player never touches any of this: they approve one Phantom dialog, once, and the
   *  rest of the session is silent. `autoSession.ts` holds the whole decision and the words for it.
   *
   *  NOTHING HERE SAYS HOW LONG THAT IS, deliberately. The length is a chosen constant in
   *  `chain/session/useSessionKeyManager.ts` that this layer neither owns nor can read back
   *  (`sessionExpiry.ts` is the single mirror of it and explains why), and it is moving. Every
   *  sentence on this context is phrased to survive the move — "until it runs out", never "for the
   *  hour" — because copy stating a duration is copy nobody re-reads on the day it changes. */
  session: {
    active: boolean;
    /**
     * HOW MANY SESSIONS THIS TAB HAS SUCCESSFULLY OPENED. Starts at 0, meaning none ever; bumped by
     * `openSession` and `renewSession`, on SUCCESS ONLY. Monotonic, in memory, per tab.
     *
     * IT EXISTS BECAUSE THE OBVIOUS IDENTITY DOES NOT WORK, and that is worth writing down where
     * somebody will find it before proposing the obvious one again. A lapsed session has to be
     * latched — `autoDeploy.ts`'s `deadSessionEpoch` — so that an unattended rule pays for one
     * refused transaction per lapse rather than one per round, and a latch needs something to key
     * on. The session token PDA is the natural key: it is derived from the program, the session
     * signer and the authority, and `sessionExpiry.ts` keys its own records on exactly that.
     *
     * It cannot be used here. gum REUSES THE SAME SESSION SIGNER KEYPAIR ACROSS A RENEWAL — that is
     * precisely why renewal has to be revoke-then-create, and `scripts/verify-session-renewal.mjs`
     * exists to prove it against the deployed program (its line 78 says so outright: a second
     * `create_session` on the same signer fails because the token account still exists). A reused
     * signer means an IDENTICAL PDA before and after a renewal, so a latch keyed on it would never
     * see the world change: auto-deploy would go quiet at its first lapse and stay quiet for the
     * rest of the tab's life, which is the exact opposite of the self-clearing property the whole
     * design rests on.
     *
     * So the identity is an app-owned count that depends on no gum internals at all. It answers one
     * question — "is the session that was refused still the session we have?" — and it answers it
     * without needing to know anything about the session itself.
     */
    epoch: number;
    /** The session SDK is doing something. Deliberately NOT a "we are opening a session" signal:
     *  gum flips the same flag while signing an ordinary session-signed transaction, which is a
     *  hundred times an hour and needs no approval at all. See `opening`. */
    busy: boolean;
    /** WHAT THE SESSION MACHINERY IS DOING — the only state in which the player is being asked to
     *  approve anything, and the one a control says "approve it in Phantom" off.
     *
     *  `busy` cannot stand in for it in either direction: it is true during every silent
     *  session-signed move, and it drops momentarily to FALSE in the middle of a revoke (gum nests
     *  one loading wrapper inside another), which would re-enable controls mid-renewal. */
    work: SessionWork;
    error: string | null;
    /** False once the player has pressed Stop — this page will not open one by itself again until
     *  they press Start. Held in memory only: a reload is a fresh visit, not a standing preference. */
    auto: boolean;
    /** HOW THE NEXT DEPLOY OR EXTRACT WILL BE SIGNED, and the source of every sentence any surface
     *  says about signing. See `autoSession.ts`'s `sessionNote`/`sessionStatus`. */
    plan: SigningPlan;
    /** Make sure a fresh session exists — opening one, or replacing the one that is there. Re-arms
     *  `auto`. The rail's Start button; nothing in the ordinary flow needs it. */
    start(): Promise<void>;
    /** Revoke it and STAY stopped: every move after this asks the wallet to approve it, until the
     *  player presses Start again. */
    end(): Promise<void>;
    /** HOW LONG IT HAS LEFT — INFERRED, AND ADVISORY ONLY.
     *
     *  Nothing can read a session's real expiry back (see `sessionExpiry.ts`): gum carries no
     *  timestamp and the length is a private const in `chain/session/useSessionKeyManager.ts`. This is
     *  counted forward from when THIS browser started the session, so `{ known: false }` is a real
     *  and common answer — a session restored from a previous visit has no local record.
     *
     *  NEVER GATE AN ACTION ON IT. If this says lapsed and the chain disagrees, the chain is right.
     *  The authoritative handling is reactive: a refused transaction classifies as `session-expired`
     *  and says to start a new one. */
    life: SessionLife;
  };

  wallet: {
    /** The connected account, or `""` when nobody is connected — see `you.pubkey`'s note on why the
     *  empty string is the correct answer rather than a sentinel. */
    pubkey: string;
    /** `"—"` when nobody is connected: this is rendered in the fixed top chrome, where a blank reads
     *  as a figure that failed to load rather than as an absence of one. */
    short: string;
    /** SOL, devnet, for transaction fees. Null while unknown — which is NOT zero, and the two must
     *  never be conflated (`playGate` blocks on zero and not on null, for that reason). */
    solBalance: number | null;
    /** DEVNET'S PUBLIC FAUCET, IN-PAGE. Offered on the burner path only; a real visitor is sent to
     *  faucet.solana.com instead, because `requestAirdrop` rate-limits to uselessness (five
     *  consecutive 429s, measured 2026-08-09) and a button that reliably fails is worse than none. */
    airdrop(): Promise<void>;
    airdropping: boolean;
    refresh(): void;

    /** Which signer this page is running: the visitor's own wallet, or the local burner key
     *  (`?signer=burner`). Decided once at load — see `flags.ts`. */
    mode: SignerMode;
    /** The connection state machine. Always `"connected"` in burner mode, where the key exists from
     *  the first paint and none of the other states are reachable. */
    status: WalletStatus;
    /** The last thing the wallet said no with, already turned into player copy. Cleared on a
     *  successful connect. */
    fault: WalletFault | null;
    /** Opens Phantom's approval popup. A no-op in burner mode. */
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    /** SIGN A PLAIN MESSAGE — one prompt, no transaction, no funds moved. Returns the raw 64-byte
     *  detached ed25519 signature.
     *
     *  It exists for exactly one thing: proving to `/api/x/link` that this browser controls this
     *  wallet, so an X identity cannot be attached to somebody else's address. `TWITTER-CONNECT.md`
     *  §4 — OAuth proves control of the X account, this proves control of the wallet, and the two are
     *  bound because the X identity is inside the bytes being signed.
     *
     *  REJECTS WITH `NO_WALLET_MESSAGE` WHEN NOBODY IS CONNECTED, exactly as the other signing paths
     *  do, rather than being absent — a caller gets one sentence it can show a player instead of
     *  having to check a null first and invent its own. */
    signMessage(message: Uint8Array): Promise<Uint8Array>;
  };

  /** WHY THE LOCAL PLAYER CANNOT ACT, or `null` when they can — the single verdict behind every
   *  disabled control on the page (`playGate.ts`).
   *
   *  It exists as one field rather than as a check per surface because SPEC.md's copy rule ("a
   *  button a player cannot press must say why, and what would make it pressable") is only
   *  keepable if there is one answer: six surfaces asking the question independently would give six
   *  answers, and five of them would go stale. The Deploy buttons, the Extract control and its dock,
   *  the wallet panel and the phase copy all render THIS.
   *
   *  It does NOT gate on a session key. A session is an ergonomic upgrade — one approval instead of
   *  one per action — not a precondition; requiring one would invent a rule the chain does not have. */
  gate: PlayBlock | null;

  /** SIMULATED. localStorage, never chain — see contract.ts. Every surface showing one of these
   *  numbers must carry the `SIM` marker. */
  sim: { ledger: SimLedger; actions: SimLedgerActions; refLink: string };

  verify: { result: VerifyResult | null; run(): void; running: boolean };

  /** THE LIVE FIGHT'S OWN WRITE PATH — real transactions this tab is sending into the Ephemeral
   *  Rollup right now (`chain/useFightTicker.ts`).
   *
   *  It matters more than a status readout: `tick()` is what makes the on-chain `hp` genuinely decay
   *  mid-fight. Without someone calling it, every fighter's stored hp sits at their full entry stake
   *  until the round settles, because `catch_up()` runs in exactly three instructions — `tick`,
   *  `extract` and `resolve` — and nothing else in the program touches fighter state.
   *
   *  `ticksSent`/`stepsAdvanced` are a counted ER write rate, not a claimed one — worth surfacing on
   *  the arena screen for exactly that reason. Optional and `undefined` outside a live chain round
   *  (fixture mode sends nothing, and rendering a truthful-looking `0` for it would be the same lie
   *  in a smaller font). */
  ticker?: {
    ticksSent: number;
    stepsAdvanced: number;
    lastSignature: string | null;
    error: string | null;
  };

  toasts: {
    items: ToastItem[];
    push(text: string, kind?: ToastKind): void;
  };

  /** Player-side intent, not an on-chain mode — see `Mode` in contract.ts. */
  mode: Mode;
  setMode(m: Mode): void;

  arenaId: ArenaMeta["id"];
  setArenaId(id: ArenaMeta["id"]): void;

  /** How the field is drawn — presentation only, and read by BOTH the canvas (the lattice) and the
   *  arena view (the frame, the overlays). Persisted across reloads; see `data/useShell.ts`. */
  board: BoardStyle;
  setBoard(b: BoardStyle): void;
}
