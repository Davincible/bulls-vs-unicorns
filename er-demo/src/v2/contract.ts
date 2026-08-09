// THE CONTRACT between the v2 page's three layers. Written before any of them, so the data layer
// (`v2/data/`), the canvas (`v2/arena/`) and the views (`v2/views/`, `v2/ui/`) could be built at the
// same time against one agreed vocabulary instead of three guesses at each other's shapes.
//
// Nothing in here imports React, pixi, or @solana/web3.js. It is types, constants and pure
// formatters only — so every layer can import it without dragging the others in.
//
// UNITS. The on-chain program counts in opaque u64 "units" (`Fighter.stake/hp/banked`, `Round.pot`).
// The original game showed dollars. `UNITS_PER_USD` is the one place that mapping lives; every
// display path goes through `usd()`/`unitsToUsd()` rather than dividing inline, so re-pegging it is
// a one-line change and no panel can silently disagree with another about what a number means.

/** Side 0 / side 1, exactly as the program stores them. */
export type Side = 0 | 1;

/** `RoundState.phaseName` from chain/useRound.ts, restated so v2 doesn't have to import it.
 *
 *  `Abandoned` is a lobby that reached its deadline holding fewer than two fighters: it can never
 *  fight, so `abandon_round` ends it. There is no winner, no seed and no fight to verify in one, so
 *  anything that reads a settled round's result must not treat it as settled — every existing check
 *  in v2 is `=== "Settled"`, which is already correct for it. What still wants doing (owned by the
 *  screens, not by this type) is SAYING so: an abandoned round should read "expired — not enough
 *  fighters", not sit blank. */
export type PhaseName = "Lobby" | "Drawing" | "Fight" | "Settled" | "Abandoned";

/** The five top-level screens, same nav as the original web/index.html. */
export type ViewId = "arena" | "leaderboard" | "dashboard" | "referrals" | "history";

/** Mayhem = raids compound in the ring (never extract). Extraction = bank raids as you go.
 *  ON-CHAIN THERE IS ONE MODE: `extract()` exists and any player may call it. This flag is a
 *  PLAYER-SIDE INTENT — it changes what the UI urges you to do (and what the mock ledger models),
 *  not what the program enforces. Label it as such wherever it's shown. */
export type Mode = "mayhem" | "extraction";

/** HOW THE BOARD IS DRAWN UNDER THE FIGHT. Purely a look: nothing about the round, the physics, the
 *  hit stream or a single figure on the page changes with it.
 *
 *  `survey` — the instrument this page was built as: the lattice and its registration crosses on the
 *    field, the 1px frame around it, and the overlays in hairline boxes on white.
 *  `blank` — the playground and nothing else. No grid, no frame, overlays as bare text. What is left
 *    is paper, the fighters, and the score behind them.
 *
 *  It lives here rather than in `arena/` because it is not only the canvas's business — the frame and
 *  the overlays are the VIEW's, and the two halves have to agree or the toggle produces a bordered box
 *  around a gridless field. One word, read by both. */
export type BoardStyle = "survey" | "blank";

/** Which token a side is playing. Only `au` is chain-backed; the rest exist so the arena picker from
 *  the original game is present and honest about being inert. */
export type TokenKey = "ansem" | "uwu" | "sol";

export interface TokenMeta {
  key: TokenKey;
  /** Display name, e.g. "ANSEM". Never hardcode "Bulls"/"Unicorns" in a panel — read this. */
  name: string;
  /** The colour this token's fighters render in. The ONLY colour on the page besides ink. */
  color: string;
  /** Path to the coin's own artwork under `public/`, or null when this repo has none. */
  icon: string | null;
}

export interface ArenaMeta {
  id: "au" | "as" | "us" | "3w" | "ffa";
  label: string;
  tokens: [TokenMeta, TokenMeta] | [TokenMeta, TokenMeta, TokenMeta];
  /** True only for the arena this program actually runs (`au`). Everything else renders as a
   *  selectable-but-unavailable entry — the original had five, and pretending they're all live
   *  would be the one thing this page must not do. */
  live: boolean;
}

/** Colours are SAMPLED FROM THE COINS' LOGOS, and are the same values as `base.css`'s `--a`/`--b`
 *  (see the note there for how they were extracted, and why BOTH are one step down from the logo —
 *  each has to hold AA as text on white). `icon` is a
 *  path under `public/` — the real coin art, so a side is identifiable by its logo and not only by a
 *  colour swatch. `sol` has no artwork in this repo and renders as a lettered mark instead. */
export const TOKENS: Record<TokenKey, TokenMeta> = {
  ansem: { key: "ansem", name: "ANSEM", color: "#278834", icon: "/tokens/ansem.jpg" },
  uwu: { key: "uwu", name: "UWU", color: "#8f09bf", icon: "/tokens/uwu.jpg" },
  sol: { key: "sol", name: "SOL", color: "#b4530a", icon: null },
};

export const ARENAS: ArenaMeta[] = [
  { id: "au", label: "ANSEM vs UWU", tokens: [TOKENS.ansem, TOKENS.uwu], live: true },
  { id: "as", label: "ANSEM vs SOL", tokens: [TOKENS.ansem, TOKENS.sol], live: false },
  { id: "us", label: "UWU vs SOL", tokens: [TOKENS.uwu, TOKENS.sol], live: false },
  { id: "3w", label: "3-WAY", tokens: [TOKENS.ansem, TOKENS.uwu, TOKENS.sol], live: false },
  { id: "ffa", label: "ANSEM FFA", tokens: [TOKENS.ansem, TOKENS.ansem], live: false },
];

/** Side 0 is token A, side 1 is token B, in the live arena. */
export const SIDE_TOKEN: [TokenMeta, TokenMeta] = [TOKENS.ansem, TOKENS.uwu];

// ---------------------------------------------------------------------------------------------
// Round + fighter views
// ---------------------------------------------------------------------------------------------

/** One fighter, flattened for display. Derived from `chain/useRound.ts`'s `FighterState` by the data
 *  layer — views never touch a `PublicKey`. */
export interface FighterView {
  /** Index in the on-chain fighter array. MUST match the id the hit-event stream was computed
   *  against — the canvas uses it positionally. */
  id: number;
  wallet: string;
  /** `7xKq…4ab` — for tables where the full key won't fit. */
  short: string;
  /** A stable pseudonym derived from the wallet (see `nameFor`). The original game gave every
   *  fighter a name; a column of base58 is unreadable at a glance. */
  name: string;
  side: Side;
  /** Net-of-fee stake, i.e. starting hp. */
  stake: bigint;
  /** Value still in the ring, from the latest poll. */
  hp: bigint;
  /** Value raided off the other side (and, after an extract, the ring value that was pulled out). */
  banked: bigint;
  /** TRUE FOR A HOUSE WALLET the keeper seated to keep the lobby from being empty.
   *
   *  Resolved in `data/houseFighters.ts` from `keeperStatus.ts`'s `isHouseWallet()`, against the list
   *  the keeper publishes in its own status file. Until that was wired a six-fighter lobby read as
   *  six people; that helper's own comment calls an undisclosed house fighter "a misrepresentation of
   *  who is in the round", and README's go-live list carries bot disclosure as an obligation. Every
   *  surface that lists fighters is expected to say which ones are ours.
   *
   *  `false` when the keeper is silent or absent: the honest default is "not known to be house", and
   *  a page with no keeper has no basis to accuse anyone of being one. WHICH MEANS `false` ALONE IS
   *  NOT A CLAIM THAT A FIGHTER IS A PERSON — a roster of them means either "none of these are ours"
   *  or "nothing told us". `houseDisclosure` on the context is the field that tells those two apart,
   *  and any caption counting these marks must read it rather than counting them itself. */
  house: boolean;
  dead: boolean;
  /** True for the local burner wallet's own fighter. */
  isYou: boolean;
}

/** WHAT LEAVING THE RING COSTS, priced for the round on screen.
 *
 *  `extract()` no longer returns everything in your ring: the house takes
 *  `extract_penalty_bps(fighter_count, cursor)` of it — 20% at the opening bell, straight-lining to
 *  zero across a per-lineup horizon in STEPS (lib.rs `EXTRACT_PENALTY_START_BPS` /
 *  `PENALTY_HORIZON_STEPS` carry the reasoning and the measured table). It is an option premium, and
 *  it decays because the option does: what you give up by leaving is the rest of the fight, which is
 *  everything at the start and nothing at the end.
 *
 *  Every field below is resolved at the CURRENT cursor and the CURRENT lineup, in `data/`, from
 *  `sim/erSim.ts`'s mirror of the Rust — never re-derived by a view. */
export interface ExtractTerms {
  /** The rate an extract landing at this instant would be charged, in basis points. 2,000 (=20%) at
   *  the opening bell, 0 from `freeAtStep` on. */
  penaltyBps: number;
  /** The cursor at which extracting becomes free for THIS lineup (`penalty_horizon_steps(n)`).
   *  Fixed for the round once the lobby closes — the lineup is what sets it. */
  freeAtStep: number;
  /** Steps still to run before that; 0 once there. */
  stepsToFree: number;
  /** The same distance in seconds at this lineup's pace — the unit the fight clock is read in. */
  secondsToFree: number;
  /** THE RATE A LITTLE LATER, so a panel can show that waiting is cheaper as a fact rather than a
   *  promise. Rate only, never a dollar figure: the curve is a pure function of the cursor, but the
   *  hp it would apply to is not — the fight keeps hitting you while you wait. */
  decay: { inSeconds: number; penaltyBps: number }[];
  /** What YOUR fighter would bank, and what the house would take, if you extracted at this instant
   *  — `split_extraction(hp, n, cursor)`. Both null when there is nothing to split: no fighter of
   *  yours, a dead one, or a phase in which `extract()` cannot be called at all. */
  youKeep: bigint | null;
  youForfeit: bigint | null;
}

/** Whether the local player may extract right now, and on what terms. `ok`/`reason`/`hp` answer
 *  "would the transaction land"; `keep`/`forfeit` answer "and what would it cost" — a button that
 *  states only the first is telling half the truth, which is what it did before the penalty existed.
 *  `keep`/`forfeit` are null exactly when `hp` is (nothing to split). */
export interface ExtractEligibility {
  ok: boolean;
  reason: string | null;
  hp: bigint | null;
  keep: bigint | null;
  forfeit: bigint | null;
}

/** The round currently on screen. */
export interface LiveRound {
  roundNo: bigint;
  phase: PhaseName;
  /** Only meaningful once Settled. */
  winner: Side | null;
  pot: bigint;
  fighters: FighterView[];
  /** Hex, or null before the VRF callback reveals it (Lobby/Drawing). */
  seedHex: string | null;
  seedCommitHex: string;
  /** Epoch ms, or null before Fight. */
  fightStartedAtMs: number | null;
  /** THE INSTANT `enter()` STOPS BEING ACCEPTED, in epoch ms — the program's own `lobby_closes_at`.
   *
   *  It is NOT the same fact as `phase === "Lobby"`, and the difference is the whole reason this
   *  field exists. The program refuses `enter` at or after this deadline (`ArenaError::LobbyClosed`)
   *  while the round's phase is still `Lobby`, because only `close_lobby_and_draw` moves the phase
   *  and that is an operator's transaction which lands whenever it lands. So every round has a
   *  window — sometimes a long one — in which the phase says "Lobby" and the chain refuses deposits.
   *  A page that gates entry on the phase alone offers a button that cannot work, and an automated
   *  deposit gated on the phase alone spends a fee on a transaction that is already doomed.
   *
   *  NULL MEANS THE PROGRAM HAS NO SUCH DEADLINE, which is a real state and not a missing read: the
   *  lobby fields arrived in a later revision of the program, and a round opened by an earlier one
   *  accepts deposits for the whole of its `Lobby` phase. On that program, gating on the phase IS
   *  correct — so null degrades to exactly the right behaviour rather than to a guess. A client that
   *  insisted on the field would simply stop working the moment it ran a revision ahead of the
   *  chain, which during a migration is every deploy.
   *
   *  Use `entriesOpen()`, never a bare phase check, to ask whether a deposit can land. */
  lobbyClosesAtMs: number | null;
  /** On-chain settled step count (0 until Settled). */
  tickCount: bigint;
  /** The fight clock. Live-ticking during Fight; 0 in Lobby and Drawing.
   *
   *  Once SETTLED it freezes at the length the fight actually ran — derived from the chain's own
   *  `tickCount` (`tickCount / stepsPerSecond(fighterCount)`), not reset to 0. A settled round that
   *  reads `0:00` would be making a claim about the round that isn't true, and the same freeze keeps
   *  `stepsNow` at the settled cursor instead of putting the replay playhead back at the un-fought
   *  start. Use `phase`, never `elapsedSec > 0`, to ask whether a fight is running. */
  elapsedSec: number;
  /** Where the replay playhead is right now — the program's own `canonical_cursor()`:
   *  `min(elapsed * stepsPerSecond(fighterCount), MAX_STEPS)`. */
  stepsNow: number;
  /** True once anyone may settle this round: the fight is genuinely over (one side has nobody left
   *  standing) OR the bell has rung (`FIGHT_TIMEOUT_SECONDS`). This is the real deadline an extract
   *  is racing — not a fixed countdown, which is why it's a flag and not a number. */
  resolvable: boolean;
  /** The price of leaving, at this instant, for this lineup — see `ExtractTerms`. Always present:
   *  the curve is a property of the round, not of whether you happen to be standing in it. */
  extractTerms: ExtractTerms;
}

/** A finished (or in-flight) round, as read back from its own account. Powers History, the
 *  leaderboard's all-time tab, and the big-wins ticker. */
export interface RoundSummary {
  roundNo: bigint;
  phase: PhaseName;
  winner: Side | null;
  pot: bigint;
  fighterCount: number;
  tickCount: bigint;
  /** `Round.penalties_collected` — what the house took out of THIS round in extract penalties.
   *
   *  Carried because a settled round's books no longer balance without it: value genuinely leaves a
   *  round now, so the identity is `sum(hp + banked) + penaltiesCollected === pot`, not
   *  `sum(hp + banked) === pot`. A panel that shows a pot beside a column of finals and omits this
   *  is inviting a reader to find a shortfall and conclude the page is wrong. Per-player P/L is
   *  unaffected either way — the penalty is deducted before anything reaches `banked`, so `final`
   *  already has it taken out. */
  penaltiesCollected: bigint;
  /** `Round.fees_collected` — the arena's entry fee this round charged, cumulative over every entry
   *  and top-up.
   *
   *  Carried for a different reason than `penaltiesCollected`, and the difference is the whole point.
   *  The penalty is money that left the RING, so a round's books genuinely do not balance without it.
   *  The fee never entered the ring at all; it was taken at the door, and `pot` is already net of it.
   *  So this term changes no identity — it changes what `pot` MEANS. A page that shows a pot and
   *  calls it "staked" is reporting a number smaller than what players were charged, and
   *  `grossDeposits` is the honest version of that sentence. Per-player figures are unaffected:
   *  `stake` is net, so `pnl` was already like-for-like.
   *
   *  Zero on any round read from a program revision that predates the field — which is the true
   *  value there, not a placeholder, because that revision collected nothing. */
  feesCollected: bigint;
  players: RoundPlayer[];
}

/** WHAT THE HOUSE MADE FROM ONE ROUND — its two sources added up, in one place.
 *
 *  A function rather than a field on `RoundSummary` on purpose. It is derived, exactly, from two
 *  fields already on the record; stored, it would be a third number that fixtures and future
 *  constructors could set inconsistently, and nothing would notice. As a function there is one
 *  definition and no invariant to break. It exists at all because "what did the house make" was
 *  previously a subtraction each caller wrote for itself — or, more often, wrote as
 *  `penaltiesCollected` alone and silently missed half the answer. */
export function houseTook(round: { penaltiesCollected: bigint; feesCollected: bigint }): bigint {
  return round.penaltiesCollected + round.feesCollected;
}

/** THE HOUSE'S OWN BOOKS, read off the chain rather than modelled.
 *
 *  The program keeps a `Treasury` PDA (base layer, one per arena) carrying what it has actually
 *  taken: the entry fee on every deploy, and the decaying premium on every early exit. Until now the
 *  Dashboard rendered a `sim` treasury out of localStorage beside it, which is precisely the tile
 *  `UI-SPEC.md` Part 1 ordered fixed: "should read the treasury ACCOUNT, not the counter."
 *
 *  Nullable, and the distinction matters: `null` means the account has not been read yet or has never
 *  been initialised (`init_treasury` is a separate admin call), which is a different fact from a
 *  treasury holding nothing. The first renders `—`, the second renders a zero. */
export interface TreasuryState {
  /** Entry fees accrued, all rounds swept so far. */
  feesAccrued: bigint;
  /** Extract penalties accrued. */
  penaltiesAccrued: bigint;
  /** How many rounds have been swept into it — the coverage of the two figures above, and the reason
   *  neither may be called "all time" while rounds remain unswept. */
  roundsSwept: bigint;
}

/** ONE THING THAT HAPPENED IN THE FIGHT, for the surfaces that narrate it.
 *
 *  Derived in `data/` from the same `hitEvents` stream the canvas already replays — not a second
 *  source. The original game talked to the player continuously ("you raided $4.10 off turboTina",
 *  "gigaGwei hit you for $2.80") and v2 has been silent between Deploy and the settled plate, which
 *  is the largest drop in feel between the two. `mine` is what a toast filter keys on: everything is
 *  worth logging, only your own hits are worth interrupting you for. */
export interface CombatEvent {
  /** Position in the replay, so a consumer can dedupe and order without a clock. */
  step: number;
  attacker: FighterView;
  defender: FighterView;
  amount: bigint;
  /** True when either party is the local player. */
  mine: boolean;
}

/** THE FIGHT'S RECENT PAST, resolved once in `data/` and shaped for the two surfaces that want it.
 *
 *  IT IS A WINDOW, NOT THE STREAM. `hitEvents` is the whole fight — up to `MAX_STEPS` entries,
 *  precomputed the instant the seed reveals — and neither surface that narrates it wants that: a log
 *  shows the last handful, a toast rail shows what happened since it last looked. Handing views the
 *  raw array would put the same cursor arithmetic (where is the playhead, which of these have I
 *  already said out loud) in every one of them, at `stepsPerSecond(n)` and four re-renders a second,
 *  each free to get it subtly differently. This is that arithmetic done once.
 *
 *  ASCENDING BY STEP — oldest first, the same order `hitEvents` itself carries. That order is a
 *  correctness property for the toast path and only a preference for the log: a rail that announces
 *  step 900 before step 890 is telling the player the fight happened in an order it did not. A log
 *  wanting newest-at-top reverses a forty-element array, or renders in `column-reverse` and does not
 *  even do that.
 *
 *  HOW A CONSUMER DEDUPES. Every entry carries `step`, and `at` is the cursor the window was cut at.
 *  Keep the last `at` you acted on; act on everything with a greater `step`; store the new `at`.
 *  Initialise that mark to `at` rather than to 0 on mount — a page opened mid-fight, or one whose
 *  playhead has just jumped from the lobby to a fight in progress, otherwise fires the entire
 *  backlog at once. */
export interface CombatFeed {
  /** The last N hits at or before `at`, ascending. Empty outside Fight/Settled, and empty on a
   *  settled round whose stream was never computed (no seed). */
  recent: CombatEvent[];
  /** The same window filtered to `mine` — the toast rail's source, so it does not re-filter on every
   *  tick. A subset of `recent` by construction: both are cut at the same cursor from the same
   *  window, so a hit in one and not the other is impossible. */
  mine: CombatEvent[];
  /** The replay cursor this window was cut at (`LiveRound.stepsNow`). Everything above has
   *  `step <= at`. */
  at: number;
}

/** WHO IS ACTUALLY IN THE ROUND ON SCREEN — the house's share of it, stated.
 *
 *  The keeper seats house wallets so a lobby is never empty, and README's go-live list carries "Bot
 *  disclosure in UI" as an obligation rather than a feature. This is the counted form of
 *  `FighterView.house`: the marks and the count come out of one pass in `data/`, so a roster showing
 *  five marks and a caption reading "5 house" can never disagree.
 *
 *  BOTH COUNTS ARE NULL TOGETHER, AND NULL IS THE WHOLE POINT OF THE TYPE. `house: false` on every
 *  fighter means one of two completely different things — nobody in this round is ours, or nothing is
 *  publishing a list to check against — and a caption reading "0 house" claims the first while the
 *  page is in the second. Null makes that unrenderable as a number: a view has to reach for `—`,
 *  which is UI-SPEC's rule for an unbacked figure and the honest sentence here. */
export interface HouseDisclosure {
  /** Fighters in the round on screen resolved as the house's. Null when nothing backs the claim. */
  houseFighterCount: number | null;
  /** The rest. Null on exactly the same condition — with no list, "how many are real people" is
   *  equally unanswerable. */
  realFighterCount: number | null;
  /** The keeper's own sentence about why it seats them (`KeeperStatus.house.disclosure`), so the
   *  page quotes the party making the claim rather than paraphrasing it. Null when nothing is
   *  disclosing. */
  note: string | null;
}

/** HOW MUCH OF THIS ARENA'S HISTORY THE FIGURES ON SCREEN WERE COMPUTED OVER.
 *
 *  `standings`, `hall`, `bigWins` and `sideRecord` are all aggregated from `history.rounds`, which is
 *  the NEWEST N round accounts (`useHistory`'s `MAX_ROUNDS`), minus any read that failed, minus any
 *  round whose account the authority has since reclaimed (`close_round_account`). Every one of those
 *  is a window, and every screen showing one of those aggregates has said "all time" over it.
 *
 *  `SideRecord` already carries its own coverage for exactly this reason and refuses the phrase; this
 *  is the same fact for everything else derived from the same log, so no screen has to reconstruct it
 *  out of `history.rounds.length` and a hope about what the denominator is. */
export interface LogCoverage {
  /** Round accounts the aggregates were actually computed over. */
  rounds: number;
  /** How many rounds this arena has EVER opened (`Arena.round_counter`), or null when that has not
   *  been read — which is the state the page is in before the first arena fetch lands, and the
   *  permanent state of the fixture's invented log. */
  roundsEverOpened: bigint | null;
  /** TRUE WHEN "ALL TIME" IS ACTUALLY TRUE — every round the arena ever opened is in the aggregate.
   *  False whenever anything is missing AND whenever the denominator is unknown, so the phrase is
   *  permitted only where it can be backed. */
  complete: boolean;
}

/** WHAT PLAYERS WERE ACTUALLY CHARGED to be in this round — the pot plus the fee taken at the door.
 *
 *  `pot` is the sum of NET stakes and always has been, so it is the money in the ring, not the money
 *  players parted with. Use this wherever the label is "staked", "deposited" or "entry"; use `pot`
 *  wherever the label is "prize" or "at stake". */
export function grossDeposits(round: { pot: bigint; feesCollected: bigint }): bigint {
  return round.pot + round.feesCollected;
}

export interface RoundPlayer {
  wallet: string;
  short: string;
  name: string;
  side: Side;
  /** What they put in (net of fee). */
  stake: bigint;
  /** What they ended with: hp + banked. */
  final: bigint;
  /** `final - stake`. Negative is a loss. */
  pnl: bigint;
  dead: boolean;
  isYou: boolean;
}

/** One wallet's all-time record, aggregated across every round account that exists. Survivorship-free
 *  by construction — it reads the round log, never live balances (UI-SPEC.md's rule). */
export interface StandingsRow {
  wallet: string;
  short: string;
  name: string;
  rounds: number;
  wins: number;
  staked: bigint;
  returned: bigint;
  pnl: bigint;
  /** `returned / staked`, e.g. 1.42 = +42%. Null when `staked` is 0. */
  roi: number | null;
  /** Best single-round pnl. */
  best: bigint;
}

/** THE HEAD-TO-HEAD RECORD between the two sides — rounds won, per side, over the round log.
 *
 *  A different fact from `sideTotals()`, and the two must never be mistaken for each other: that one
 *  is money in play in THIS round and moves on every hit; this one is a count of finished rounds and
 *  does not move until one settles. Anywhere both are shown, both have to be labelled.
 *
 *  IT CARRIES ITS OWN COVERAGE, and that is the whole reason `settled` exists as a field rather than
 *  being left implicit in `wins[0] + wins[1]`. The log it is counted from is whatever `useHistory`
 *  actually fetched — newest-N, capped, and short a round wherever a read failed — so this can never
 *  be labelled "all time" on a page whose discipline is that no figure claims more than it can back.
 *  It is "N settled rounds", stated, and that is true whatever the window did. */
export interface SideRecord {
  /** Rounds won, indexed by `Side`. */
  wins: [number, number];
  /** How many settled rounds were counted. Counted independently of `wins` rather than derived from
   *  it: they agree today only because `summarizeRoundAccount` gives every settled round a winner,
   *  and a scoreboard should not quietly depend on that staying true. */
  settled: number;
}

/** A row in the marquee. It is a WINS ticker — never push a negative amount into it (that was bug #2
 *  in UI-SPEC.md). */
export interface BigWin {
  roundNo: bigint;
  wallet: string;
  name: string;
  side: Side;
  /** Profit, always > 0. */
  amount: bigint;
}

// ---------------------------------------------------------------------------------------------
// Simulated ledger — everything the ER program has no concept of
// ---------------------------------------------------------------------------------------------

/** SIMULATED. The ER program custodies nothing: there are no token accounts, no deposits, no
 *  withdrawals, no house treasury. The original game had all of them, so v2 models them locally
 *  (localStorage) to keep the product shape intact — and every surface that shows one of these
 *  numbers MUST carry the `SIM` marker so nobody mistakes it for chain state. */
export interface SimBalances {
  ansem: number;
  uwu: number;
  sol: number;
}

export interface SimLedger {
  balances: SimBalances;
  /** House take, accrued at `FEE_BPS` on every simulated deploy. */
  treasury: SimBalances;
  /** All-time simulated deposits/withdrawals, for the dashboard bands. */
  deposited: number;
  withdrawn: number;
  /** Referral earnings, 10% of house fee on referred play (original's rate). */
  referralEarned: number;
  referralCount: number;
}

export interface SimLedgerActions {
  deposit(token: TokenKey, amountUsd: number): void;
  withdraw(token: TokenKey, amountUsd: number): void;
  /** `from` -> `to` at 1:1 minus `CONVERT_BPS`, mirroring the original's 0.3% convert fee. */
  convert(from: TokenKey, to: TokenKey, amountUsd: number): void;
  /** The original's "+ $100 & $100" test-money button. */
  topUp(): void;
  reset(): void;
}

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Raw u64 units per displayed dollar. `EnterForm`'s old default stake of 1_000_000 is therefore
 *  "$1.00", which is the peg every v2 surface uses. */
export const UNITS_PER_USD = 1_000_000n;

// FIGHT PACING IS NOT RESTATED HERE — it is re-exported from `chain/constants.ts`, which is the
// maintained mirror of the program's own constants.
//
// This file originally carried `STEPS_PER_SECOND = 175` and `MIN_FIGHT_SECONDS = 5`, copied from
// lib.rs. Both were wrong within the same session, because the program moved: the fight became
// STEPPED, its pace became PER FIGHTER (`steps_per_second(n) = n * 2`, since a fight's length in
// steps grows ~n^1.5 and no flat rate paces both a 2-fighter duel and a 16-fighter brawl), and the
// 5-second floor was replaced by `FIGHT_TIMEOUT_SECONDS` — the bell — because at the new pace a
// permissionless `resolve` at second five would have let whoever was ahead settle and keep it.
//
// A second hand-copy of a moving constant is how a UI ends up animating a different fight from the
// one being settled. There is one mirror; this is not it.
export {
  MAX_STEPS,
  FIGHT_TIMEOUT_SECONDS,
  STEPS_PER_FIGHTER_PER_SECOND,
  stepsPerSecond,
  canonicalCursor,
} from "../chain/constants.ts";

// NEITHER IS THE EXTRACT PENALTY, for the same reason and from a different mirror: the curve lives
// in `sim/erSim.ts`, whose numbers the Rust's own
// `parity_tests::the_typescript_mirrors_carry_the_same_penalty_curve` parses out of the file and
// fails on if they ever drift. Only the START RATE is re-exported — it is the one figure the page
// says out loud ("20% at the opening bell"). The functions stay in `data/` (`extractTerms.ts`): a
// view that could call `extractPenaltyBps` would eventually call it at the wrong cursor, and there
// is exactly one right one (see that module's note on the canonical cursor).
export { EXTRACT_PENALTY_START_BPS } from "../sim/erSim.ts";

/** The arena's deploy fee, matching `init_arena(fee_bps)` as deployed and the original's 0.2%. */
export const FEE_BPS = 20;

/** The original's convert fee. Simulated-ledger only. */
export const CONVERT_BPS = 30;

/** Stake presets from the original deploy panel, in dollars. */
export const STAKE_PRESETS = [5, 20, 50, 100];

/** The original's per-side cap. */
export const STAKE_CAP_USD = 100;

/** The smallest stake this page will send. `enter` only requires `stake > 0`, so the floor is ours,
 *  not the chain's: a deploy that costs a devnet fee to stake a tenth of a cent is a transaction
 *  nobody meant to send, and it is exactly what a percentage rule degrades into once the balance it
 *  reads runs out. Any rule resolving below this deploys NOTHING and says why. */
export const MIN_STAKE_USD = 0.01;

/** How far ahead of `lobbyClosesAtMs` this page stops treating a lobby as enterable.
 *
 *  The deadline is enforced against the VALIDATOR's clock, and the only clock a browser has is its
 *  own. A tab a few seconds fast would send a deposit the chain rejects — paying a fee to be told it
 *  was late — so the last moments of a lobby are conceded rather than raced. `MIN_LOBBY_SECONDS` is
 *  30 on chain, so this gives up ~7% of the shortest lobby the program permits, and none of a normal
 *  one. It is deliberately larger than any plausible NTP drift and deliberately smaller than the
 *  round-trip of the transaction it is protecting. */
export const ENTRY_CLOSE_GUARD_MS = 2000;

/** Whether a deposit sent RIGHT NOW would be accepted — the question every deploy surface is really
 *  asking, and the one `phase === "Lobby"` does not answer (see `LiveRound.lobbyClosesAtMs`).
 *
 *  Null round, wrong phase, or past the guarded deadline all mean no. */
export function entriesOpen(live: LiveRound | null, nowMs: number): boolean {
  if (live === null || live.phase !== "Lobby") return false;
  // No deadline on this program revision: `Lobby` is the whole answer, and it is the right one.
  if (live.lobbyClosesAtMs === null) return true;
  return nowMs + ENTRY_CLOSE_GUARD_MS < live.lobbyClosesAtMs;
}

/** Seconds left to deposit, floored at 0 — the countdown a lobby should have been showing all along.
 *  Null when there is nothing to count down: no lobby, or a program revision with no deadline in it.
 *  A countdown invented from a client-side constant would be the one thing worse than none. */
export function entrySecondsLeft(live: LiveRound | null, nowMs: number): number | null {
  if (live === null || live.phase !== "Lobby" || live.lobbyClosesAtMs === null) return null;
  return Math.max(0, Math.ceil((live.lobbyClosesAtMs - nowMs) / 1000));
}

// ---------------------------------------------------------------------------------------------
// Pure formatters — shared so two panels can never format the same number two ways
// ---------------------------------------------------------------------------------------------

export function unitsToUsd(units: bigint): number {
  // Number() on the quotient would floor away the cents; scale first, then divide in float.
  return Number(units) / Number(UNITS_PER_USD);
}

export function usdToUnits(usd: number): bigint {
  return BigInt(Math.round(usd * Number(UNITS_PER_USD)));
}

/** `Intl.NumberFormat` instances, one per decimal-place count, built on first use.
 *
 *  WHY THIS CACHE EXISTS — it is a measurement, not a habit. `Number.prototype.toLocaleString(locale,
 *  options)` constructs a whole new `Intl.NumberFormat` on EVERY call: it has nowhere to keep one, so
 *  the options object it is handed forces a fresh format-negotiation each time. Benchmarked here at
 *  12.2µs per call against 302ns for a reused formatter — 40x, for byte-identical output.
 *
 *  That was invisible while it stayed a per-render cost, and stopped being invisible when the arena
 *  canvas started calling it from inside a 60Hz loop: `draw.ts` formats a worth label for every body
 *  every frame, `scoreboard.ts` two more, `impact.ts` one per damage figure. At the program's maximum
 *  sixteen fighters that is ~1,200 calls a second, and a CPU profile of a mid-fight window put `usd`
 *  at 2.7% of all samples — the single largest application-code cost on the page, more than the
 *  entire canvas draw and ~25x the label layout everyone assumed was the hot spot.
 *
 *  THE KEY SET IS BOUNDED, which is what makes an unevicted Map the right structure rather than a
 *  leak: `dp` is a code-chosen literal at every call site (0, 2, or `impact.ts`'s 3 for sub-cent
 *  raids), never user input and never derived from a value. Three entries, for the life of the page.
 *
 *  Locale is pinned to `en-US`, exactly as before — these are dollar figures matched to a `$` this
 *  module prepends itself, and picking up the visitor's locale would put a `,` decimal separator
 *  after a `$`. */
const USD_FORMATTERS = new Map<number, Intl.NumberFormat>();

function usdFormatter(places: number): Intl.NumberFormat {
  let f = USD_FORMATTERS.get(places);
  if (f === undefined) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
    USD_FORMATTERS.set(places, f);
  }
  return f;
}

/** `$1,240.50`. `dp` defaults to 2 below $1,000 and 0 above it — long money columns stay aligned
 *  without the decimals eating the column width. */
export function usd(units: bigint, dp?: number): string {
  const v = unitsToUsd(units);
  const places = dp ?? (Math.abs(v) >= 1000 ? 0 : 2);
  return `$${usdFormatter(places).format(v)}`;
}

/** Same, but with an explicit sign — for P/L columns, where "+" carries information.
 *
 *  EXACTLY ZERO GETS NO SIGN. `+$0.00` reads as a win of nothing, which is a different claim from
 *  "broke even" and a very different one from "hasn't played" — and in a P/L column full of real
 *  gains it scans as the former. A player who staked and got precisely their stake back is the only
 *  case this renders, and it should look like the neutral fact it is. A row with NO data is not this
 *  function's job at all: that is `<Dash/>`, per UI-SPEC.md's rule that an unbacked figure never
 *  renders as a number. */
export function usdSigned(units: bigint, dp?: number): string {
  const s = usd(units < 0n ? -units : units, dp);
  if (units === 0n) return s;
  return units < 0n ? `−${s}` : `+${s}`;
}

/** ONE CENT, IN UNITS. Exact by construction — the peg is dollars and `UNITS_PER_USD` is a power of
 *  ten — so no float ever touches this threshold.
 *
 *  It is the floor below which a dollar figure on this page is printed as a BOUND (`<$0.01`) rather
 *  than as a number, because two decimal places print a real amount as `$0.00`, and "the house takes
 *  nothing" is a different claim from "the house takes less than a cent". Exported so the one rule
 *  has one home: `usdCompact` below and `ArenaView`'s full-precision `penaltyText`/`keepText` render
 *  at different resolutions but must agree on where the floor is. */
export const ONE_CENT_UNITS = UNITS_PER_USD / 100n;

/** The compact ladder, ascending, each step 1,000x the last. `T` is the top because it is the top:
 *  a u64 is at most 18,446,744,073,709,551,615 units, i.e. $18.4T at this peg, so nothing this
 *  program can hold ever needs a suffix beyond it. Lowercase `k`, uppercase for the rest — SI's own
 *  casing, and what `Intl`'s uppercase `13K` gets wrong beside a lowercase-heavy mono column. */
const COMPACT_STEPS = ["k", "M", "B", "T"] as const;

/** MONEY THAT FITS IN A TABLE CELL — `$13.2k`, `$1.4M`, `$980.50`, `<$0.01`.
 *
 *  WHY THIS EXISTS. `usd()` prints in full, and in full a live round's figures are up to twenty
 *  characters (`$13,487,910,540,099`) against 70–88px mono columns in the rosters and standings.
 *  Grid tracks are fixed, so the surplus does not widen the column — it spills, and because money
 *  columns are right-aligned it spills LEFTWARD, straight over the figure next door. Three columns
 *  of that is what Max saw: not a wide table, an unreadable one. The fixture never showed it (its
 *  stakes are $6–$100); the chain path does, on every row.
 *
 *  THE THRESHOLDS, and what each is protecting:
 *    · under $1,000 — two decimals, exactly as `usd()` already behaves there. Cents are load-bearing
 *      at this game's stake sizes: the per-side cap is $100 and real fighters sit at $8–$100, so a
 *      $12.40 fighter and a $12.90 one must not both read "$12".
 *    · from $1,000 — `k` at one decimal. One is the most a mono column can spend and still fit the
 *      widest case (`−$999.9k`, eight characters ≈ 56px) inside the narrowest money track on the
 *      page (66px). Two decimals would cost another 7px for a digit nobody acts on at that scale.
 *    · from $1,000,000 / $1,000,000,000 / $1,000,000,000,000 — `M`, `B`, `T` on the same rule.
 *  A trailing `.0` is stripped, so it reads `$13k` and not `$13.0k`. The tier is chosen from the
 *  ROUNDED figure, not the raw one, so $999,999 comes out `$1M` rather than the `$1000.0k` a naive
 *  divide-then-round produces at the top of every tier.
 *
 *  HAND-ROLLED, NOT `Intl`'s `notation: "compact"`. Measured, not assumed: `Intl` emits `13K` (wrong
 *  case), collapses `0.02` to `0` at `maximumFractionDigits: 1` (a real balance rendered as nothing),
 *  and its width is locale-negotiated — `de-DE` gives `1,4 Mio.`, seven characters and a space where
 *  `en-US` gives four. Figures on this page are tabular mono in fixed tracks; a formatter whose
 *  output length depends on the visitor's locale is a formatter that breaks the column somewhere
 *  else. This one's output is bounded at eight characters, always.
 *
 *  IT IS FOR CONSTRAINED CONTEXTS ONLY — table cells, the dock, the sticky bar, canvas labels. It
 *  loses money by design (`$13.2k` hides up to $50), so anywhere a reader is meant to CHECK a
 *  number, `usd()` still runs: the 00-1 hero pot, 00-3.1's bank/penalty ledger, 00-7's verify
 *  comparison and History's expanded round detail. Wherever it does run, the exact `usd()` string is
 *  carried in a `title` on the cell — a truncated number with no way to reach the real one is a
 *  worse lie than a wide column. */
export function usdCompact(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const sign = negative ? "−" : "";

  // Below a cent but not nothing. Stated as a bound at both resolutions, so this is the one string
  // the compact and full-precision paths share — see `ONE_CENT_UNITS`.
  if (magnitude > 0n && magnitude < ONE_CENT_UNITS) return `${sign}<$0.01`;

  // The tier boundary is tested against what the two-decimal path WOULD PRINT, not against the raw
  // value: $999.999 formats as "$1,000.00", nine characters with a thousands separator in it, which
  // is neither compact nor a shape this ladder ever means to emit. Rounding first sends it to "$1k".
  const dollars = unitsToUsd(magnitude);
  if (Math.round(dollars * 100) / 100 < 1000) return `${sign}$${usdFormatter(2).format(dollars)}`;

  let scaled = dollars / 1000;
  let step = 0;
  // Step up while ROUNDING would carry past this tier's ceiling: 999,999 scales to 999.999, which
  // renders "1000.0k" if taken at face value and "$1M" once the carry is honoured.
  while (step < COMPACT_STEPS.length - 1 && Math.round(scaled * 10) / 10 >= 1000) {
    scaled /= 1000;
    step += 1;
  }
  const figure = scaled.toFixed(1);
  return `${sign}$${figure.endsWith(".0") ? figure.slice(0, -2) : figure}${COMPACT_STEPS[step]}`;
}

/** Compact, with an explicit sign — the P/L columns' formatter, and `usdSigned`'s rules exactly.
 *
 *  EXACTLY ZERO GETS NO SIGN, for the reason spelled out on `usdSigned`: `+$0.00` in a column of
 *  real gains scans as a tiny win rather than as breaking even. A sub-cent loss reads `−<$0.01` and
 *  never `−$0.00`, which is the same floor `ArenaView`'s extract panel has always applied — a player
 *  being charged something must never be told they are being charged nothing. */
export function usdCompactSigned(units: bigint): string {
  const magnitude = usdCompact(units < 0n ? -units : units);
  if (units === 0n) return magnitude;
  return units < 0n ? `−${magnitude}` : `+${magnitude}`;
}

/** A basis-point rate as a percentage: `20%`, `9.3%`, `0%`.
 *
 *  One decimal, and none when the figure is whole. The extract penalty moves through every value
 *  between 2,000 bps and 0 as the cursor advances, so a fixed `toFixed(2)` would spend the whole
 *  fight showing a jittering hundredths digit nobody can act on, while `toFixed(0)` would round the
 *  last few percent to a flat "0%" while the house is still taking money. */
export function bpsPct(bps: number): string {
  const v = bps / 100;
  return `${v.toFixed(Number.isInteger(v) ? 0 : 1)}%`;
}

/** `7xKq…4ab` */
export function shortKey(wallet: string): string {
  return wallet.length <= 10 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

const NAME_HEAD = [
  "KITE", "ONYX", "RONIN", "ASH", "VELVET", "NORI", "COBALT", "SABLE", "FLINT", "AZURE",
  "MOTH", "IVORY", "TALON", "CINDER", "SUMI", "HOLLOW", "ORCHID", "QUARTZ", "RIFT", "VESPER",
  "GLASS", "NOMAD", "PALE", "SIREN", "TUNDRA", "UMBER", "WICK", "YARROW", "ZEPHYR", "BRACKEN",
  "CANDOR", "DUSK", "EMBER", "FABLE", "GRAVEL", "HALO", "INDIGO", "JUNIPER", "KESTREL", "LUMEN",
];

/** A stable, wallet-derived pseudonym: same wallet always reads the same, no lookup table, no
 *  network. The original gave every fighter a name and a column of raw base58 is unreadable in a
 *  roster — but the wallet is always shown alongside, so this is a label, never an identity claim. */
export function nameFor(wallet: string): string {
  let h = 0;
  for (let i = 0; i < wallet.length; i++) h = (h * 31 + wallet.charCodeAt(i)) >>> 0;
  const head = NAME_HEAD[h % NAME_HEAD.length];
  return `${head}_${(h % 97).toString().padStart(2, "0")}`;
}

/** `0:14` — elapsed fight clock. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

/** `hp + banked` — a fighter's total worth right now, which is what the winner is decided on. */
export function worth(f: { hp: bigint; banked: bigint }): bigint {
  return f.hp + f.banked;
}

/** Per-side totals of `worth`, used by the strength bar and the winner readout. */
export function sideTotals(fighters: { side: Side; hp: bigint; banked: bigint }[]): [bigint, bigint] {
  let a = 0n;
  let b = 0n;
  for (const f of fighters) {
    if (f.side === 0) a += worth(f);
    else b += worth(f);
  }
  return [a, b];
}
