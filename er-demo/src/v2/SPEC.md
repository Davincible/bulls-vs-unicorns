# v2 — "paper terminal" arena page

The front end for this on-chain game, served at **`/`** (`index.html` → `src/v2/main.tsx` →
`src/v2/App.tsx`), with **`/arena.html`** kept as an alias of the same page — v2 lived there while it
was being built and links to it were shared. The original app moved to **`/legacy.html`**, unchanged
and still building from `src/main.tsx`; it is not deleted because it is a live workstream. v2
shares only `src/chain/**`, `src/sim/**` and `src/ui/verifyRound.ts` with it, **by import only —
never edit a file outside `src/v2/`**.

## What it is

Two things at once:

1. **The real game.** Everything the deployed program can actually do: read the live round, deploy
   into a side, extract mid-fight, watch the fight replay from the VRF seed, and re-derive the
   settled result in-browser to check it.
2. **The whole product shape from `web/index.html`.** Deposits, withdrawals, conversions, the house
   treasury, referrals, the arena picker, the big-wins ticker, the dashboard. The ER program has no
   concept of any of these — so they are **simulated locally** (localStorage), and **every figure
   that isn't chain-derived carries a visible `SIM` marker**. That honesty is not optional; a
   money-shaped number with no backing behind it, unlabelled, is the one thing this page must never
   ship.

## Design

Read `src/v2/styles/base.css` first — it is the design system and its header comment is the law
(no radius, no shadows, no cards, hairlines only, colour reserved for the two sides). Reference
feel: jonway.studio — pure white, black text, fixed black status bars top and bottom, tiny uppercase
mono metadata with numbered section indices (`00-1.2`), dense hairline tables, one big display
number per screen. **The only colour on the page is the game.**

Use the primitives already in `base.css` (`.u`, `.idx`, `.display`, `.h`, `.num`, `.row`, `.kv`,
`.btn`, `.seg`, `.tabs`, `.bar`, `.split`, `.mk`, `.sec`). Add component CSS only for layout that
the primitives genuinely don't cover, in a co-located `.css` file inside your own folder.

## Layers and file ownership

| Layer | Owns | Never touches |
|---|---|---|
| **data** | `src/v2/data/**` | views, arena, base.css |
| **arena canvas** | `src/v2/arena/**` | data, views |
| **shell + arena view** | `src/v2/App.tsx`, `src/v2/ui/**`, `src/v2/views/ArenaView.tsx` (+ its css) | data, arena internals, the other views |
| **other views** | `src/v2/views/{LeaderboardView,DashboardView,ReferralsView,HistoryView}.tsx` (+ their css) | everything above |

`src/v2/contract.ts` is the shared vocabulary — types, constants, formatters. **Import from it;
don't restate its types or re-implement its formatters.**

## The data contract

The data layer is entered through two files, and the split is load-bearing rather than tidy:

```ts
// src/v2/data/ArenaProvider.tsx — components ONLY, so Fast Refresh can hot-swap it
export function ArenaProvider(props: { children: React.ReactNode }): JSX.Element

// src/v2/data/useArena.ts — the hook and the context object
export function useArena(): ArenaContextValue
```

Keep `ArenaProvider.tsx` free of non-component exports. React Fast Refresh can only refresh a module
whose exports are all components, and this one sits at the root of the page's import graph — when it
cannot refresh, it invalidates instead, the context drops to null, and the whole page blanks with
`useArena() must be called inside <ArenaProvider>` on an edit that had nothing to do with it. That
failure is dev-only, which is what makes it expensive: it never reaches a build, and it looks like a
bug in whatever you were editing.

```ts
interface ArenaContextValue {
  you: { pubkey: string; short: string; name: string };

  status: {
    programReady: boolean;
    programError: string | null;   // fatal — nothing on the page can talk to the chain
    roundError: string | null;
    loading: boolean;              // first round fetch only
    roundNo: bigint | null;
  };

  /** null until the first successful round fetch. */
  live: LiveRound | null;
  /** Full precomputed hit stream for the current fight; [] outside Fight/Settled. */
  hitEvents: HitEvent[];           // from sim/hitEvents.ts

  history: {
    rounds: RoundSummary[];        // newest first, every round account that exists
    loading: boolean;
    error: string | null;
    refresh(): void;
  };
  standings: StandingsRow[];       // all-time, derived from `history`, best pnl first
  bigWins: BigWin[];               // profit only, newest first, for the ticker
  hall: RoundPlayer[];             // best single-round performances all-time
  /** Rounds won per side over `history.rounds`, carrying the coverage it was counted over — that
   *  log is a newest-N window, so nothing derived from it may be labelled "all time".
   *  `null` = not read yet, which is NOT the same fact as a nil-all and must not render as one. */
  sideRecord: SideRecord | null;

  actions: {
    enter(side: Side, stakeUnits: bigint): Promise<string>;  // resolves to a signature, throws Error
    extract(): Promise<string>;
    entering: boolean;
    extracting: boolean;
    /** `ExtractEligibility` (contract.ts): `ok`/`reason`/`hp` answer "would it land", and
     *  `keep`/`forfeit` answer "what would it cost" — extracting is not free, see `ExtractTerms`. */
    extractEligible: ExtractEligibility;
  };

  /** THE SESSION KEY IS HOW THIS PAGE SIGNS, not a feature anyone opts into: the first deploy or
   *  extract opens one (one Phantom approval, 0.02 SOL, an hour) and everything after it signs
   *  silently; a lapsed one is replaced by the next move. `data/autoSession.ts` holds the whole
   *  decision AND the words for it — no surface writes its own sentence about signing. */
  session: {
    active: boolean; busy: boolean; error: string | null;
    opening: boolean;      // a session is being opened/renewed — the only state that needs approval
    auto: boolean;         // false after an explicit Stop; in memory only, a reload re-arms it
    plan: SigningPlan;     // how the NEXT move gets signed — the source of every signing sentence
    start(): Promise<void>; end(): Promise<void>;
    life: SessionLife;     // INFERRED and advisory — see data/sessionExpiry.ts
  };

  wallet: {
    pubkey: string; short: string;
    solBalance: number | null;     // SOL, devnet, for fees
    airdrop(): Promise<void>; airdropping: boolean;
    refresh(): void;
  };

  /** SIMULATED — see contract.ts. Everything here is localStorage, never chain. */
  sim: { ledger: SimLedger; actions: SimLedgerActions; refLink: string };

  verify: { result: VerifyResult | null; run(): void; running: boolean };  // ui/verifyRound.ts

  toasts: {
    items: { id: number; text: string; kind: "info" | "error" | "a" | "b" }[];
    push(text: string, kind?: "info" | "error" | "a" | "b"): void;
  };

  mode: Mode; setMode(m: Mode): void;                 // player-side intent only (contract.ts)
  arenaId: ArenaMeta["id"]; setArenaId(id: ArenaMeta["id"]): void;  // only "au" is live
  board: BoardStyle; setBoard(b: BoardStyle): void;   // how the field is drawn; localStorage-backed
}
```

## The canvas contract

`src/v2/arena/ArenaCanvas.tsx` exports:

```ts
export interface ArenaCanvasProps {
  fighters: FighterView[];
  hitEvents: HitEvent[];
  fightStartedAtMs: number | null;
  phase: PhaseName;
  /** `BoardStyle` (contract.ts). The canvas's share of it is the lattice, and only that. */
  board: BoardStyle;
  /** `SideRecord` (contract.ts) — rounds won per side, folded out of the round log in `data/`.
   *  `null` means the log hasn't been read yet, and the record band is not drawn. */
  sideRecord: SideRecord | null;
  onSelect?(fighterId: number): void;
  /** Hovered/selected fighter, drawn with a ring. */
  selectedId?: number | null;
}
export function ArenaCanvas(props: ArenaCanvasProps): JSX.Element
```

It fills its parent (the parent owns the 1px border and the aspect ratio). It is white: white field,
black hairline detail, fighters in `--a`/`--b`. No glow, no bloom, no particles-as-confetti — impact
reads as a hard black ring and a mono damage figure that fades. This is a technical instrument that
happens to be a game.

**The damage figure is the one exception to "black", and it is deliberate.** It is set in the
ATTACKING side's colour, and in `--hot` for a blow that finishes a fighter. Everything else a hit
draws — the ring, the echo, the spall fan, the connector — stays ink, which is what lets the figure
be the loud thing. The argument is that a damage figure is not decoration applied to the field, it is
the fight's only published number and it says whose money just moved; `draw.ts`'s `drawEnemyWedge`
already fills part of a disc in the OPPOSITE side's colour to say the same thing about money already
taken, so this is a reading of the existing vocabulary rather than a new licence. `base.css` rule 5's
list of where colour may appear predates the figure and should be read as including it. All three
values clear WCAG AA as text on white (`--a` 4.51:1, `--b` 7.10:1, `--hot` 5.71:1) and the figure is
cased in `--paper` the way `draw.ts` cases every label. See `arena/impact.ts`'s header.

**Board style.** `board` is a LOOK, and the two halves of it live on either side of this boundary:
the canvas skips `drawLattice()` under `"blank"`, and the arena view drops the frame's border and the
overlays' box for the same word. Nothing else changes — not the physics, not a figure, not a state.

**The score is the floor of the arena.** `arena/scoreboard.ts` draws it behind the fight, in that
side's colour at watermark alpha — after the paper and the lattice, before the fighters, in **both**
board styles, and never on an empty field (that state is `drawEmpty()`'s). **Two scores, captioned
so they can never be read as one:**

| band | what | where from | behaviour |
|---|---|---|---|
| `THIS ROUND` | each side's total worth (`hp + banked`) and its share | `field.bodies`, after the frame's replay sync — via `contract.ts`'s `sideTotals` | moves on every hit |
| `ROUNDS WON · N SETTLED` | rounds won, per side | `deriveSideRecord(history.rounds)`, in `data/` | static until a round settles |

The record is **never** labelled "all time": `useHistory` reads the newest rounds **still on chain** —
a walk back from `round_counter` that stops on a short run of reclaimed accounts, capped at
`MAX_ROUNDS` — and tolerates a failed read, so `SideRecord` carries the coverage it was counted over
and the caption states it. Since `close_round_account` that window is close to `MIN_RETAINED_ROUNDS`
rather than in the hundreds, so the caption is load-bearing on an ordinary arena, not a distant one.
`sideRecord === null` is "not read yet" and draws nothing — an empty-but-loaded log is a real 0–0 and
does render.

## Screens

Nav (bottom chrome): `ARENA · LEADERBOARD · DASHBOARD · REFERRALS · HISTORY` — same five as the
original.

**00 ARENA** — hero line (pot on the table + fighter count + phase + fight clock); the canvas with
its overlays (two-sided strength bar, round tag, your-position HUD, result banner, help line);
`EXTRACT` as the single most prominent control during Fight; the deploy strip (stake presets,
custom amount + slider, side buttons, repeat-every-round, mode toggle); the two side rosters as
hairline tables (index, marker, name, hp bar, ring value, banked, status); round standings; previous
rounds; the provably-fair strip (commit, seed, verify, anchors).

**01 LEADERBOARD** — tabs: this round / all-time / hall of fame. One line per row.

**02 DASHBOARD** — the three bands from `UI-SPEC.md` §Part 2: the arena right now, your position,
the house. Follow its rules: every figure names its unit, no figure without backing data (show `—`,
never `0`), nothing derived from live balances.

**03 REFERRALS** — link, copy, share, earnings. `SIM`.

**04 HISTORY** — my previous rounds (deploy → got back → P/L, expandable to the round's hit log) and
every round with every player.

Plus: an intro takeover on first visit (what the game is, mayhem vs extraction, provably fair), a
fighter profile overlay on click, and the wallet/session panel.

## Copy: every state answers "what now?"

**A status line that describes the situation without telling the player what to do is a bug.**

The offending pattern, verbatim from this page and the reason this section exists:

> "This round has settled. Deposits reopen at the next lobby."

It reads as informative and answers nothing. *How* do I get into the next lobby? *When* is it? Do I
need to do something, or wait? It leaves the player with more questions than they arrived with —
which is worse than saying nothing, because it looks like an answer.

Every state the player can land in must carry three things, in this order:

1. **What is true now** — one clause, no hedging.
2. **What they can do about it** — the action, or plainly that there is none *right now*.
3. **When it changes** — a real number where one exists (a countdown to `lobby_closes_at`, to the
   bell), and an honest "waiting on X" where one genuinely does not (the VRF draw has no deadline).

Rewrite the four round phases against that test. Sketches, not final copy:

| Phase | Instead of "deposits reopen at the next lobby" |
|---|---|
| Lobby | "Deposits are open — **0:14** left to get in." |
| Drawing | "Entries are locked. Waiting on the VRF seed — the fight starts as soon as it lands, usually a few seconds. Nothing for you to do." |
| Fight | "The fight is running. You can **extract** until someone settles the round." |
| Settled | "Round over. Next lobby opens in **0:08**." |

And the honesty rule still binds: if no keeper is running, the Settled state must say *that* — not
count down to a round nobody is going to open. A timer to an event with no cause is the same class
of lie as an unbacked money figure.

The same test applies to every disabled control on the page: a button a player cannot press must say
why, and what would make it pressable.

## Non-negotiables

- **Never invent a chain number.** If it isn't in `LiveRound`/`RoundSummary`, it's `SIM` or it's `—`.
- Token names come from `contract.ts`'s `TOKENS`/`SIDE_TOKEN`, never hardcoded strings.
- Money figures go through `usd()`/`usdSigned()`; the fight clock through `clock()`.
- Fight pacing comes from `contract.ts`, which **re-exports** `chain/constants.ts` (the maintained
  mirror of `lib.rs`). The fight is **stepped** and its pace is **per fighter**:
  `stepsPerSecond(n) = n * 2`, and the round becomes settleable when the fight is genuinely over
  **or** the bell rings at `FIGHT_TIMEOUT_SECONDS = 180`. There is no flat step ceiling any more —
  `MAX_STEPS` used to be one, doing two unrelated jobs at once (how long a fight may run, and how
  much work one transaction may do), and the two stopped agreeing the moment the fighter cap grew
  past 16. They are now two different constants: `MAX_STEPS_PER_CALL` is a compute bound that
  belongs only on `roundIx.tick`'s `steps` argument (`chain/round.ts`), and `finalCursor(fighterCount)`
  — `FIGHT_TIMEOUT_SECONDS * stepsPerSecond(fighterCount)` — is the per-lineup bell every progress
  bar, playhead clamp and precompute budget on this page wants: 720 steps for a duel, 17,280 at the
  48-fighter ceiling. **Never use a flat number where a lineup is in scope.**
  There is no flat `STEPS_PER_SECOND` and no `MIN_FIGHT_SECONDS` — both existed earlier in this
  session, were copied into `contract.ts`, and were wrong within hours. Never hand-copy a chain
  constant a second time; a UI that disagrees is animating a different fight from the one settling.
- TypeScript is strict with `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax`, and
  **`.ts`/`.tsx` extensions in every relative import** — match the existing code exactly.
- `bun run tsc -b --noEmit` and `bun run lint` must pass clean for the files you own.
- React 18. No new dependencies.
