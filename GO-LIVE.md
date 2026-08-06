# Go-live runbook — custodial mainnet launch (closed beta)

The mainnet launch is a **closed beta**: real money, whitelisted pre-funded wallets only, opened
only after BOTH the checklist below passes AND a canary round succeeds with Max's explicit go.
Nothing here touches mainnet until every box is checked.

## 0. Prerequisites
- A funded **house vault** keypair (holds real BULL/UWU + SOL float). Key stays in a secret
  manager as `VAULT_SECRET_KEY` — never in git, never in the image.
- `mainnet.json` with the real BULL/UWU mints + vault pubkey (see `mainnet.json.example`).
- A host with a **persistent volume** for the SQLite ledger (Fly/Railway/VPS) — pick at deploy time.
- The whitelist of beta wallet pubkeys.

## 1. Pre-flight checklist (all must be green)
- [ ] `cd engine && npm test` — all tests pass on the commit being shipped.
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
