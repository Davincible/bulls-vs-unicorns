# Hosting setup — Fly.io (engine) + Vercel (frontend)

Decided 2026-08-06. The engine is the money service and needs a persistent disk, always-on
uptime and WebSockets → **Fly.io**. The web app is static files → **Vercel**.

> Account creation, logins and payment details are yours to do — I can't and won't do those.
> Everything else below is already configured in the repo (`engine/fly.toml`, `engine/Dockerfile`,
> `web/vercel.json`).

---

## Part 1 — Engine on Fly.io

### 1.1 Install flyctl and sign in
```bash
curl -L https://fly.io/install.sh | sh
```
```bash
fly auth login
```

### 1.2 Create the app (no deploy yet)
Run from the `engine/` directory — `fly.toml` lives there.
```bash
fly apps create bulls-arena-engine
```
If that name is taken, pick another and update `app =` in `engine/fly.toml` to match.

### 1.3 Create the ledger volume — DO THIS BEFORE THE FIRST DEPLOY
The SQLite ledger holds real balances. Without a volume it lives in the container and is
**destroyed on every deploy**.
```bash
fly volumes create bulls_data --size 1 --region iad
```
Use the same region as `primary_region` in `fly.toml`.

### 1.4 Set secrets (never in fly.toml, never in git)
Start on **devnet** to prove the deploy, then switch to mainnet at cutover.
```bash
fly secrets set SOLANA_RPC="https://api.devnet.solana.com"
```
The vault key as a JSON byte array. Generate a FRESH one for mainnet — the devnet key was exposed
by the path-traversal bug and must be treated as burned:
```bash
fly secrets set VAULT_SECRET_KEY="$(cat ~/.config/solana/id.json)"
```

### 1.5 Deploy
```bash
fly deploy
```

### 1.6 Verify before trusting it
```bash
fly status
```
```bash
curl https://bulls-arena-engine.fly.dev/live
```
```bash
curl https://bulls-arena-engine.fly.dev/health
```
- `/live` must be `200` — that's the platform's liveness check.
- `/health` reports solvency (`200` solvent, `503` when a breach froze withdrawals). It is
  deliberately NOT the platform check: restarting cannot fix a money problem, and wiring Fly to it
  would restart-loop during an incident.
- Watch the boot log for `engine live`, the correct vault pubkey, and (on mainnet)
  `faucets DISABLED` + `allowlist ENFORCED`:
```bash
fly logs
```

### ⚠️ Never scale past one machine
The ledger is SQLite on a single volume. A second instance splits the book.
```bash
fly scale count 1
```
`auto_stop_machines = false` and `min_machines_running = 1` are already set — leave them. Rounds,
bots and the reconciliation daemon must run continuously.

---

## Part 2 — Frontend on Vercel

1. Import the GitHub repo at vercel.com → **New Project**.
2. Set **Root Directory = `web`**. No build command — it's static (`web/vercel.json` handles
   headers and output).
3. Deploy.
4. Open the site pointed at the engine:
   `https://<your-site>.vercel.app/?engine=wss://bulls-arena-engine.fly.dev`
5. Once it works, bake the URL in as the default `ENGINE` in `web/index.html` so players don't
   need the query string, and check the proof-of-reserves page:
   `https://<your-site>.vercel.app/solvency.html`

Note: no strict CSP is set because the app loads `@solana/web3.js` from a CDN. If that's ever
bundled locally, add a CSP — it's the one meaningful hardening still available to the frontend.

---

## Part 3 — Cutover to mainnet

Do **not** do this until the devnet deploy above is verified working end to end. Then follow
`GO-LIVE.md` in full — checklist + $2 canary + your explicit go, closed to the whitelist:
```bash
fly secrets set SOLANA_RPC="<mainnet-rpc>" CHAIN_CONFIG="./mainnet.json" VAULT_SECRET_KEY="<fresh key>" WHITELIST="wallet1,wallet2"
```
Then wipe any devnet ledger off the volume so no test balances carry into production, redeploy,
and work through `GO-LIVE.md`.

## Costs (approximate)
- Fly: ~$5/mo (shared-cpu-1x, 512MB, 1GB volume).
- Vercel: free tier is fine for static hosting.
