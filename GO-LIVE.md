# Go-live runbook — custodial mainnet launch (closed beta)

The mainnet launch is a **closed beta**: real money, whitelisted pre-funded wallets only, opened
only after BOTH the checklist below passes AND a canary round succeeds with Max's explicit go.
Nothing here touches mainnet until every box is checked.

## ⛔ Known blockers — code changes required BEFORE mainnet

Verified against the real mainnet mints on 2026-08-06 (both `decimals=6`, ~1B supply,
**mintAuthority = none**):

1. **`convert` has no on-chain counterpart.** Swapping BULL↔UWU moves balance between tokens in the
   ledger only. The vault's per-token holdings don't move, so any conversion volume drifts the book
   and the reconciliation daemon will (correctly) freeze withdrawals. Either execute a real swap
   (Jupiter/PumpSwap) on convert, or disable convert on mainnet. **Not optional.**
2. **Bot funding can't mint on mainnet.** `seed-bots.ts` calls `faucet()` → `mintTo`, which needs
   mint authority. ANSEM and UWU have **none** — supply is fixed. Bots must be funded by
   *transferring purchased tokens*, so the script needs a transfer path for mainnet.
3. **Bot float is real capital.** Whatever the bots play with is money you can genuinely lose to
   players. Decide the number deliberately and treat it as a marketing/liquidity budget.

## 0. Prerequisites
- A funded **house vault** keypair (holds real BULL/UWU + SOL float). Key stays in a secret
  manager as `VAULT_SECRET_KEY` — never in git, never in the image.
- `mainnet.json` with the real BULL/UWU mints + vault pubkey (see `mainnet.json.example`).
- A host with a **persistent volume** for the SQLite ledger (Fly/Railway/VPS) — pick at deploy time.
- The whitelist of beta wallet pubkeys.

## 1. Pre-flight checklist (all must be green)
- [ ] `cd engine && npm test` — all tests pass on the commit being shipped.
- [ ] **Pen test passes on a staging copy** (never the live ledger):
      `node pentest.mjs ws://<staging>` → 16/16, and `node pentest-dos.mjs ws://<staging>` survives.
      Covers auth bypass, cross-wallet access, signature forgery/replay, hostile amounts,
      prototype pollution, malformed input, stored XSS, HTTP surface and flooding.
- [ ] **Rate limiting active** — `RATE_LIMIT_OFF` is NOT set. Confirm the boot config uses sane
      RATE_PER_SEC / RATE_BURST / MAX_CONN_PER_IP, and rate-limit at the edge too (behind a proxy
      the engine only sees the proxy's address).
- [ ] **No static file server in front of secrets.** `serve-web.mjs` is dev tooling; the hosted
      frontend must serve `web/` only. Confirm `GET /..%2f<anything>` returns 4xx wherever it runs.
- [ ] `SOLANA_RPC` points at **mainnet**; `CHAIN_CONFIG=./mainnet.json`.
- [ ] `VAULT_SECRET_KEY` set from the secret manager; engine boots and logs the **correct** vault
      pubkey (matches `mainnet.json`). A wrong/missing key now aborts boot by design.
- [ ] Faucets OFF — boot log shows `faucets DISABLED (mainnet-safe)`. (Auto on non-test chains.)
- [ ] Allowlist ENFORCED — boot log shows `allowlist ENFORCED (live chain): N wallet(s)`, N > 0,
      and N equals the intended beta list. `WHITELIST` (or `data/whitelist.txt`) is populated.
- [ ] Reconciliation ENFORCED — it is (live chain). `RECONCILE_OFF` is **not** set.
- [ ] Fresh ledger: `LEDGER_DIR` on the volume is empty (no carried-over test balances).
- [ ] `GET /health` returns 200 with `chain:true` and the right vault.
- [ ] `GET /solvency` returns a report; with an empty ledger it is `ok:true` (no liabilities yet).
- [ ] Vault actually holds the house float on-chain (check Solscan): BULL/UWU + SOL as intended.

## 2. Canary (one real, tiny round)
Use ONE whitelisted wallet with a small pre-funded balance.
- [ ] Deposit **$2**-worth → confirm the ledger credits it and `/solvency` still `ok:true`.
- [ ] Deploy into one round → it settles; balance moves as expected.
- [ ] Withdraw the balance back → arrives on-chain.
- [ ] Capture the **Solscan links** for the deposit, (settlement,) and withdraw.
- [ ] `/solvency` `ok:true` throughout; withdrawals never froze unexpectedly.

## 3. Open to the beta — requires Max's explicit "go"
- [ ] Max reviews the checklist + canary Solscan links and says go.
- [ ] Announce to the whitelisted wallets only.
- [ ] Watch `/health` (200) and `/solvency` (`ok:true`) for the first live rounds.

## Rollback / freeze
- A solvency breach auto-**freezes withdrawals** and `/health` flips to 503 — investigate before
  clearing. To halt fast, stop the engine (in-flight state is flushed to the ledger on shutdown).
- The ledger is crash-safe (atomic SQLite writes); a restart resumes from the last snapshot.

## Deploy quickref
```bash
# from engine/, build the image
docker build -t bulls-engine .
# run (host provides the volume + secrets)
docker run -p 8090:8090 -v bulls-data:/data \
  -e SOLANA_RPC="<mainnet-rpc>" -e CHAIN_CONFIG=./mainnet.json \
  -e VAULT_SECRET_KEY="[...]" -e WHITELIST="wallet1,wallet2" \
  bulls-engine
```
Env reference: `engine/.env.example`. Trust model + local play: `DEPLOY.md`.
