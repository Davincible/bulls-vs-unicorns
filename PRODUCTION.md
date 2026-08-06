# Production architecture & MagicBlock ER — plan (2026-08-06)

## Where we are (honest assessment)
The game works and the money math is proven (conservation, continuity, auth, solvency all
verified). But the structure is a prototype, not production:

- **`server.ts` is a 623-line monolith** doing arena registry, ledger, auth, chain ops, the ws
  protocol, bots and settlement in one file. One bug anywhere touches everything.
- **`web/index.html` is a 1,884-line single file** — patching it has truncated/broken it twice
  this build. It needs to be a real project (modules, a build step).
- **The ledger is a single JSON file**, rewritten on every money event. The atomic-rename trick
  helps, but under real concurrent load or a mid-write crash this is the biggest liability. A
  production ledger must be a transactional DB.
- **No committed test suite** — every check has been a throwaway script. Production needs the
  tests in the repo, run on every change.
- **The vault key sits on disk** (gitignored). For a custodial launch it must live in a secret
  manager and the process must run somewhere we control.

None of this is a rewrite-from-scratch situation — the engine and sim are correct and reusable.
It's a restructure: pull the proven logic into clean services behind interfaces.

## Phase A — custodial launch (our wallet), production-grade
The model you asked for: runs on OUR wallet, no smart contract yet, but done properly.

1. **Ledger → SQLite (WAL) with real transactions.** Every balance change is one atomic DB
   transaction with an idempotency key. Deposits keyed by signature (already have replay
   protection). This kills the single-file-corruption risk. Interface stays the same so the sim
   and arena code don't change.
2. **Split the engine into services:** `ledger` (DB), `chain` (deposits/withdraws/prices),
   `auth` (already built), `arenas` (round runners + bots), `gateway` (ws protocol). Each
   testable in isolation.
3. **Commit the test suite.** The pen-test, conservation, continuity, auth and solvency checks
   become `*.test.ts` that run in CI. Nothing ships that fails them.
4. **Reconciliation daemon.** Every N seconds: assert `ledger liabilities <= vault holdings`
   per asset; if breached, freeze withdrawals and alert. The explorer solvency page goes public.
5. **Secrets + hosting.** Vault key in a secret manager. Engine on a host with a persistent
   volume for the DB (Fly/Railway/VPS). Web on Vercel/Cloudflare. Everything server-side — you
   never run it locally again.
6. **Mainnet cutover:** real ANSEM/UWU mints, native SOL, faucets hard-off (done), fresh ledger,
   canary $2 deposit→play→withdraw verified on Solscan before announce.

## Phase B — MagicBlock Ephemeral Rollup (the hackathon)
**What it is for us:** today we ARE a hand-rolled rollup — an off-chain authoritative engine
with a custodial vault settling periodically. MagicBlock ERs are that pattern done natively:
game state lives in Solana accounts **delegated to a dedicated ~50ms SVM validator**, rounds
execute as real on-chain transactions, then state commits back to mainnet.

**What it changes:**
- **Custodial trust disappears.** Funds sit in program-controlled accounts, not our keypair.
  The withdraw/double-spend/auth questions become enforced by the program, not our JS.
- **The auth layer we just built becomes native** — the ER validates wallet signatures at the
  protocol level.
- **Provable fairness moves on-chain** (VRF or on-chain commit-reveal of the seed).
- **Feel stays fast** — 30-50ms, gasless — so the arena doesn't slow down.

**What it realistically requires:** the round LEDGER + deposit/deploy/settle become an on-chain
program (extend the Anchor vault we already have) with accounts delegated to the ER. The heavy
PHYSICS sim likely stays a deterministic client replay from the on-chain seed — running full
collision physics on-chain every tick is probably too expensive even in an ER, so the honest
design is: on-chain = money + commit-reveal + settlement; client = the visual replay it already
does. That keeps fairness on-chain while keeping the game cheap.

**Hackathon edge — Private ER (TEE):** MagicBlock shipped TEE-secured ERs (Intel TDX). A
"dark-pool arena" where nobody sees stakes/sides until the round starts — hidden state, revealed
at the horn — is exactly their pitch and a differentiated demo. That's the prize angle.

**Why Phase A first makes Phase B easier:** if the ledger is already a clean service behind an
interface, swapping its backend from SQLite to on-chain ER accounts is a contained change, not a
rewrite. Build A properly and B becomes an evolution, not a restart.

## Open decisions for Max
- Launch custodial (Phase A) now for revenue, then migrate to ER? Or go straight for the ER
  build for the hackathon and skip the custodial launch?
- DB choice: SQLite (simplest, single-box) vs Postgres (multi-instance later).
- Host: Fly.io / Railway / bare VPS.
