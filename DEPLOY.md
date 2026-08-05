# Running & deploying Bulls ⚔ Unicorns

## A. Play it locally (what works today)

Double-click **`run-local.bat`**. It starts, in order:

| # | Piece | Where |
|---|---|---|
| 1 | Solana test validator (WSL) | `http://127.0.0.1:8899` |
| 2 | Game engine (rounds + vault) | `ws://localhost:8090` |
| 3 | Web server + browser | `http://localhost:8123` |

Then in the browser:

1. **Devnet wallet** panel → **Connect Phantom**
   (Phantom → Settings → Developer Settings → **Custom RPC** → `http://127.0.0.1:8899`)
2. **Faucet 🐂 500** / **Faucet 🦄 500** — mints real test tokens to your wallet
3. **Deposit** — Phantom signs a real SPL transfer into the vault; your game balance is credited
4. **Deploy BULL / UWU** in the lobby — the engine enters you into the round
5. **🔐 Verify last round** — your browser recomputes the whole round from the revealed seed
6. **Withdraw** — the vault sends tokens back to your wallet

The mints live in `engine/devnet.json`. They persist as long as the validator ledger
(`~/svalidator` in WSL) is kept. **Never pass `--reset` to `solana-test-validator`** — that
wipes the mints and you must re-run `npm run setup:devnet`.

## B. How the trust model works

- **Rounds are engine-authoritative.** The browser never decides damage. The engine commits
  `sha256(seed)` *before* the lobby opens, reveals the seed when the battle starts, and ships
  the full ordered hit log. The client only replays it.
- **Anyone can verify.** The client recomputes the round from the seed and compares every hit,
  the winner, and every payout. If the engine had altered anything after seeing the bets, the
  hashes would not match.
- **Custody today is custodial** (an engine-held vault keypair). See "What's left" below.

## C. Deploying it online

Frontend and engine deploy fine; **on-chain deposits do not survive the move** unless the
chain the engine points at is publicly reachable — a local validator is not.

1. **GitHub** — upload this folder (drag-drop in the web UI). `engine/.vault-keypair.json`
   is gitignored and must stay that way.
2. **Engine → Railway** — New Project → this repo → Settings → **Root Directory = `engine`**.
   Env vars: `SOLANA_RPC` = a public devnet RPC (or leave unset → rounds run, deposits off).
   Public URL becomes your `wss://…` engine URL.
3. **Frontend → Vercel** — import repo → **Root Directory = `web`** → Deploy.
4. Open `https://your-site.vercel.app/?engine=wss://your-engine.up.railway.app`
   (or bake the URL into the `ENGINE` default in `web/index.html`).

For a **public** devnet demo you must re-create the mints against public devnet:
`SOLANA_RPC=https://api.devnet.solana.com npm run setup:devnet` — which needs ~0.05 devnet SOL
in the vault. The public faucet was rate-limiting this machine; a local validator sidesteps it.

## D. What's left

- **Trustless custody (Anchor vault).** `programs/vault/src/lib.rs` is written — a pooled vault
  with an on-chain fee skim and settlement-authority-gated withdrawals. It is **not deployed**:
  building it needs a C toolchain in WSL (`sudo apt install build-essential`), which requires
  your WSL password. Until then the vault is an engine-held keypair — fine for devnet, must be
  replaced before real money.
- **Mainnet:** point at the real BULL/UWU mints, deploy the Anchor program, fund a house float.
