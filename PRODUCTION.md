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

## Progress (2026-08-06)
- [x] **Ledger → SQLite (WAL)** — `store.ts`, atomic per-save transactions, legacy JSON auto-import.
- [x] **Committed test suite** — `npm test`, 44 tests (CI on push): sim determinism/conservation/
      no-friendly-fire (2-team, 3-way, FFA); commit-reveal lifecycle for both round runners (seed
      hidden in lobby, revealed seed hashes to the commitment, settlement conserves); ledger
      crash-safety; allowlist gate; reconciliation core (+ NaN/unpriced edge cases); arena registry;
      vault-key loading; auth security (unsigned refused, wrong-key rejected, nonce single-use).
- [~] **Service split** — extracted: `auth.ts`, `arenas.ts` (registry), `ledger.ts` (money state),
      `reconcile.ts`, `allowlist.ts`. server.ts 623 → ~560 lines. Still inside: chain handlers +
      round/bot orchestration + gateway (ws dispatch) — the ws-coupled remainder.
- [x] **Reconciliation daemon** — `reconcile.ts`: per-asset liabilities ≤ vault holdings every 15s,
      FREEZES withdrawals on breach (live-chain only; test chains report but don't freeze).
      Public `solvency` ws query + `GET /solvency` for a proof-of-reserves page.
- [x] **Closed-beta gate** — `allowlist.ts`: on a live chain, only whitelisted (WHITELIST env /
      `data/whitelist.txt`) wallets can authenticate. Matches Max's "whitelisted pre-funded wallets only".
- [x] **HTTP health** — `GET /health` (200 solvent / 503 frozen) wraps the ws server so any host can
      liveness-probe. ws upgrade verified on the shared port.
- [x] **Deploy artifacts** — `engine/Dockerfile` (Node 24, ledger on /data volume, healthcheck),
      `.dockerignore`, `.env.example` (all env vars), `GO-LIVE.md` runbook. Vault key hardened:
      `VAULT_SECRET_KEY` from a secret manager; live chain refuses to auto-generate a new vault.
- [ ] **Secrets + hosting** — DEFERRED by Max ("decide later"); pick Fly/Railway/VPS at deploy time.
      (Image + env + runbook are ready when a host is chosen.)
- [ ] **Mainnet cutover** — gated by BOTH a written checklist AND a $2 canary (Solscan links) with
      Max's explicit go. Closed to the whitelist. Faucets already hard-off on non-test chains. See GO-LIVE.md.

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
