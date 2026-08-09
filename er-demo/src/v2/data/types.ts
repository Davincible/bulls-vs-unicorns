// The single object every v2 view reads from. Split out of `ArenaProvider.tsx` so the views can
// import the TYPE without importing the provider's implementation (and everything it pulls in:
// anchor, web3.js, the session SDK) — and so the real provider and the mock one are provably the
// same shape.

import type { HitEvent } from "../../sim/hitEvents.ts";
import type { VerifyResult } from "../../ui/verifyRound.ts";
import type { AutoDeployHandle } from "./autoDeploy.ts";
import type {
  ArenaMeta,
  BigWin,
  BoardStyle,
  ExtractEligibility,
  LiveRound,
  Mode,
  RoundPlayer,
  RoundSummary,
  Side,
  SideRecord,
  SimLedger,
  SimLedgerActions,
  StandingsRow,
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
  /** The full precomputed hit stream for the current fight; empty outside Fight/Settled. */
  hitEvents: HitEvent[];

  history: {
    /** Newest first. Every round account that exists, not just settled ones. */
    rounds: RoundSummary[];
    loading: boolean;
    error: string | null;
    refresh(): void;
  };
  /** All-time, from the round log only — never from live balances. Best P/L first. */
  standings: StandingsRow[];
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

  session: {
    active: boolean;
    busy: boolean;
    error: string | null;
    start(): Promise<void>;
    end(): Promise<void>;
  };

  wallet: {
    pubkey: string;
    short: string;
    /** SOL, devnet, for transaction fees. Null while unknown. */
    solBalance: number | null;
    airdrop(): Promise<void>;
    airdropping: boolean;
    refresh(): void;
  };

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
