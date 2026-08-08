# Bulls ⚔ Unicorns — full project context

Read this first. It is written for a person or an agent picking the project up cold, on a new
machine, with no memory of how it got here.

**There is real money in this system.** Read §6 before running anything.

---

## 1. What this is

A real-time PvP betting game on Solana. Memecoin armies — ANSEM, UWU, SOL — fight 40-second rounds.
You deploy a stake to one side; fighters raid each other; the winning side takes value from the
losing one. The house takes 0.2% of deploys and 0.3% of converts.

**It is live on Solana mainnet with real funds.** <https://bulls-arena-engine.fly.dev/>

The product's central claim is *verifiability*: the engine publishes `sha256(seed)` before deploys
open, reveals the seed at fight start, and anchors round results on-chain. Anyone can recompute a
round in their browser and check it. That claim is not marketing — it is the answer to the only
question that matters for a product like this: *"are the fights rigged?"*

Everything else in the design is downstream of protecting that answer.

---

## 2. Architecture as it actually is

```
browser (web/index.html, one self-contained file)
   │  websocket
   ▼
Node engine (engine/src/server.ts) ── AUTHORITATIVE
   │
   ├── SQLite ledger  — every balance, stake, settlement  (node:sqlite, WAL)
   │                    LIVES ON THE FLY VOLUME, not in this repo
   │
   └── Solana mainnet — SPL vault, deposits, withdrawals, Jupiter swaps, memo anchors
```

**The engine is the authority.** The browser replays; it never decides. Rounds are simulated
server-side from a committed seed, and the client runs an independent copy of the same physics so it
can verify rather than trust (`web/index.html` carries a hand-written JS port of `engine/src/game.ts`
— they must stay in step; there is a parity test).

**Custody is custodial.** Player balances are ledger rows backed by one on-chain vault. This is the
single most dangerous thing in the system and the thing to be most careful changing.

### Key files

| Path | What |
|---|---|
| `engine/src/server.ts` | the engine — rounds, matching, deposits, withdrawals, HTTP + ws |
| `engine/src/ledger.ts` | balances, standings, round log, treasury. One definition of "what is this worth" |
| `engine/src/game.ts` | the 2-team simulation. Deterministic from the seed |
| `engine/src/reconcile.ts` | solvency guard — freezes withdrawals if the books exceed the vault |
| `engine/src/devnet-guard.ts` | mainnet kill switch (ER fork only) |
| `web/index.html` | the entire front end, self-contained, CSP-locked, CDN script pinned by SRI |
| `programs/bulls-arena/` | the on-chain program (ER fork) |
| `programs/vault/` | dormant Anchor 0.30.1 vault program — written, never deployed, referenced by nothing |

---

## 3. Branches

| Branch | State |
|---|---|
| `main` | **the live mainnet product.** This is what serves players |
| `magicblock-er-migration` | a **devnet-only fork** exploring MagicBlock Ephemeral Rollups. Structurally prevented from reaching mainnet |

**Never merge the ER fork into main without deliberate review.** It disables real swaps, retargets
the deploy, and refuses to boot against a mainnet RPC — all correct for a fork, all catastrophic if
they land on the live product by accident.

---

## 4. The vision

The current product proves people will play. The direction of travel is to make the game itself
*provably* fair rather than *verifiably* fair — the difference being whether you have to trust the
operator's engine at all.

**Where it is going, in order:**

1. **On-chain rounds via MagicBlock Ephemeral Rollups.** The fight executes in a rollup at ~10ms
   blocks and commits to Solana. Working end-to-end on devnet today (see §7).
2. **Player agency mid-fight (`extract`).** Pull out and bank what you are holding, or press on.
   This is what makes the rollup load-bearing rather than decorative — an outcome that depends on
   when a human presses a button cannot be precomputed. Deployed on devnet.
3. **VRF for the seed.** Removes seed choice from the operator entirely. Deployed on devnet.
4. **Ephemeral SPL tokens for balances.** Would make "raids TAKE the enemy's coin" an actual SPL
   transfer at rollup speed rather than a SQLite row. **Not built.** It moves custody to
   MagicBlock's per-mint vault, which is a real decision, not a step.
5. **UI rebuild** per `UI-REDESIGN-BRIEF.md`. The interface still reads as a prototype.

**Explicitly rejected:** Private Ephemeral Rollups. The docs are clear that users cannot
independently verify shielded state, which contradicts the entire product. See `ER_DESIGN_DECISIONS.md`.

---

## 5. Hard-won lessons — read before changing money code

These are not hypotheticals. Each cost real money or real time.

- **Restarts used to strand ~$30 of ledger claim.** The shutdown handler called `refundOpenRounds()`
  then `flush()` — but not `persist()`. The refund was computed, applied in memory, and thrown away.
  It hid because *no money is lost*: the coin stays in the vault, the ledger just stops claiming it,
  and the rebalance daemon re-credits it minutes later. The safety net was suppressing its own alarm.
- **Never sample the books mid-round.** A stake leaves the account the instant it is placed while the
  vault still holds the coin, so `gap = (chain − ledger) + open`. Reading in that window produced
  both false "INSOLVENT" alarms and a real double-credit.
- **A deadband a leak can hide beneath is a blind spot, not a safety margin.** `REBALANCE_MIN_GAP_USD`
  was $5; stranded float accumulated to just under it and sat there permanently.
- **Units are the recurring bug.** The ledger holds bull/uwu in *tokens* but SOL in *USD*. Two
  endpoints reported "SOL" and disagreed by 75×. Every figure must name its unit.
- **Three different P/L numbers for one wallet** came from three parallel accounting systems. Only
  `/standings` (the engine round log) is authoritative.
- **Measuring across a restart is how you report a loss that never happened.** I did it three times.
  Any reading taken within ~2 minutes of a deploy is untrustworthy.
- **Auto-convert was ON by default** and fired a real Jupiter swap on any balance over $1. Removed
  entirely — raided coin never needs converting; you can deploy or withdraw either token directly.

---

## 6. Safety rules

1. **`main` is live with real money.** A bad deploy affects real players' funds.
2. **Never delete wallet keys.** `engine/data/bot-wallets-mainnet.json` holds real mainnet keys.
3. **Do not run mainnet transactions to "test".** The devnet fork exists for that.
4. **Confirm before anything that moves funds.** Swaps, transfers, withdrawals, ledger write-downs.
5. **The ER fork must stay devnet-only.** `engine/src/devnet-guard.ts` enforces this; do not weaken it.

---

## 7. Current state (2026-08-08)

**Live product (`main`):** running, ~361 tests green, solvency ok, books reconciling to the cent.
Round counter in the 800s. Recent work: fixed the shutdown persist bug, the rebalance deadband,
matching (bots could not answer a player's bet at all), pot sizing (it was headcount, not stake size),
one-line Hall of Fame, arena-aware labels, CSP + SRI, backing pill.

**ER fork (`magicblock-er-migration`):** full lifecycle working on devnet —
`open_round → delegate → enter → VRF seed → resolve → commit → undelegate`, verified by the account's
owner flipping to the delegation program and back. `extract` deployed. Measured 187 CU/step; one
transaction fits ~7,300 steps.

**Not done:** ephemeral SPL, the UI rebuild, the mainnet canary (BLK-2 — the real Jupiter swap has
never been run deliberately with real funds, though one happened accidentally via auto-convert and
landed correctly).

---

## 8. Where the documents are

| File | What |
|---|---|
| `AGENTS.md` | this file — start here |
| `MIGRATION.md` | how to set this up on a new machine |
| `UI-REDESIGN-BRIEF.md` | the front-end rebuild, written from what the live build actually does |
| `MAGICBLOCK_RESEARCH.md` | ER integration model, verified against registries and source |
| `ER_MIGRATION_PLAN.md` | account mapping, program design, testing strategy |
| `ER_DESIGN_DECISIONS.md` | VRF / ephemeral SPL / private-rollup analysis and verdicts |
| `HACKATHON_ANGLE.md` | how to make the ER load-bearing rather than decorative |
| `MEGA_QUEUE.md` | the work queue, with what is done, blocked, and why |
| `SECURITY_AUDIT.md` | adversarial audit findings |
