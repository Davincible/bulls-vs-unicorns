# Bulls ⚔ Unicorns — Dev Log & Mainnet Readiness

Last updated: 2026-08-06

---

## 1. Where we actually are

**Live:** `https://bulls-arena-engine.fly.dev` — Fly.io, 1 machine, ~$3.34/mo, **pointed at Solana MAINNET**.

| Piece | State |
|---|---|
| Engine (rounds, ledger, settlement) | ✅ working |
| Security (auth, rate limits, allowlist, XSS, traversal) | ✅ 24/24 adversarial checks |
| Solvency guard + public proof-of-reserves | ✅ verified end-to-end incl. a forced breach |
| Real on-chain deposits / withdrawals | ✅ proven on devnet AND mainnet |
| Convert → real Jupiter swap | ✅ built, **untested on mainnet** |
| Bot money backed by real deposits | ✅ architecture done |
| Test suite | ✅ 74 tests, CI on push |
| **Rounds actually running on mainnet** | ❌ **blocked — float not credited** |

**Money on-chain, all accounted for:**
- Vault `6wLK7paKz2es3nG9jdVvrnHMNUCPkognh8yQUFJ7Zete` — 0.92 SOL, 1,520 UWU
- Seed `4XVVgtG9kdn6suKKpNZrcBcxe9v9GkXWYofRXbRY1GZr` — 0.06 SOL, 5,400 UWU
- Funded 1.30 SOL + 7,000 UWU → 0.32 SOL spent (96% recoverable rent + unspent float; **$0.04 actual fees**)

---

## 2. Architecture

```
  SEED WALLET (operator holds key)         <- the float lives here
        │  funds
        ▼
  20 BOT WALLETS (keys on operator PC)     <- server NEVER holds these
        │  real on-chain deposit
        ▼
  VAULT (key = Fly secret, on server)      <- only ever holds DEPOSITED money
        │
        ▼
  ENGINE (off-chain authoritative rounds)  <- ledger, commit-reveal, settlement
```

Why it's split this way: the vault key must live on the server to sign withdrawals, so anything it
holds is exposed to server compromise. Keeping the float in a seed wallet the operator controls
bounds that exposure to deposited funds only.

**Room config:** `ENABLED_ARENAS` env. Currently `us-extraction` (UWU vs SOL).
**Bot sizing:** USD-denominated (`BOT_BANK_USD_MIN/MAX`, `BOT_STAKE_USD_MIN`), converted at live price.

---

## 3. Bugs found and fixed (this build)

Ordered by severity. Every one of these passed a green test suite at the time.

| # | Bug | Impact | Status |
|---|---|---|---|
| 1 | **Vault private key readable over HTTP** — `%2f` path traversal in `serve-web.mjs` | total vault compromise | ✅ fixed, 5 variants blocked |
| 2 | **Busted bots destroyed real money** — delete without returning balance | float erased from ledger on mainnet | ✅ fixed (`retireBot`) + test |
| 3 | **Stored XSS via display names** | attacker JS in every player's browser | ✅ fixed server + client |
| 4 | **No-funds DoS** — free account creation × O(n) leaderboard | CPU/payload collapse | ✅ fixed + rate limits |
| 5 | **Helius API key published to every visitor** | quota theft | ✅ fixed (public RPC to clients) |
| 6 | **Boot prune deleted the funded bot wallets** | float wiped every restart | ✅ fixed |
| 7 | **Engine crash-loop** when `ENABLED_ARENAS` excluded `au-normal` | total outage | ✅ fixed |
| 8 | **HTML served with no cache headers** | players stuck on old builds | ✅ fixed |
| 9 | **Token counts rendered as dollars** (bull+uwu summed) | meaningless house figures | ✅ fixed (USD accrual) |
| 10 | **`ReferenceError` in N-arena bot entry** (`myTok` vs `tok`) | 3-way/FFA bot entry threw | ✅ fixed + coverage tests |
| 11 | **1:1 convert minted ~6× value** | free money | ✅ fixed (real rate) |
| 12 | **Stake minimum in token counts** — $1.03 ANSEM vs $6.00 SOL | SOL army could never deploy | ✅ fixed (USD) |
| 13 | Win banner hardcoded "BULLS WIN" | wrong winner shown in UWU/SOL | ✅ fixed |
| 14 | N-arenas never resynced on connect/mode switch | empty arena for up to 60s | ✅ fixed |

**Pattern worth naming:** the test suite was green for every one of these. Tests prove the paths
they enter, nothing more. Bugs 2, 6 and 10 were all found by *watching a live system*, not by CI.

---

## 4. Blockers to a real launch

### 🔴 B1 — Float not credited to the ledger
1,520 UWU sits in the vault; the ledger shows nobody owning it (bug #2 erased it). Bots have no
money, so no rounds fill.
**Fix ready:** `npm run recover:float` (dry-run by default, refuses if the vault can't back it).
Must run on the server against the live ledger.

### 🔴 B2 — Public RPC will throttle
`api.mainnet-beta.solana.com` returned 429s on a 20-wallet read. Under player load it will stall
deposits and withdrawals.
**Partly fixed:** retry + endpoint rotation (`SOLANA_RPC_FALLBACK`). **Still needs a paid mainnet
endpoint** (Helius mainnet / QuickNode / Triton).

### 🔴 B3 — Operator wallet not whitelisted
Whitelist contains the 20 bots only. Max cannot play. Needs his Phantom address.

### 🟡 B4 — Fixed build unproven over time
The money-destroying bug appeared within minutes of live traffic. The fix has a unit test but has
**not** been watched over hundreds of rounds. Needs a devnet soak.

### 🟡 B5 — Mainnet convert never exercised
On devnet, convert is an oracle simulation; on mainnet it's a real Jupiter swap. That path has
never run for real. Must be part of the canary.

---

## 5. What "done" looks like

- [ ] B1 float recovered, bots deploying, rounds settling
- [ ] B2 paid RPC configured as primary, public as fallback
- [ ] B3 operator wallet whitelisted
- [ ] B4 devnet soak: float stable across ≥200 rounds, no unexplained drift
- [ ] B5 canary: deposit → play → **convert** → withdraw, with Solscan links
- [ ] Solvency `ok:true` throughout, `/health` 200
- [ ] Explicit go from Max before opening to anyone

---

## 6. Operating notes

**Deploy:** `fly deploy . --config engine/fly.toml --dockerfile engine/Dockerfile --ha=false`
(build context is the REPO ROOT — the image ships `web/` too).

**Never** `fly scale count 2` — the ledger is SQLite on one volume; a second instance splits the book.

**Key locations** (none on the server except the vault):
- `~/mainnet-vault.json` (WSL) — vault, also a Fly secret
- `~/seed-wallet.json` (WSL) — the float
- `engine/data/bot-wallets-mainnet.json` — 20 bot keys

**Gotchas that cost hours:**
- `CHAIN_CONFIG` defaults to `devnet.json` (local-validator mints) → confusing `TokenAccountNotFoundError`
- Windows `pkill -f tsx` kills the wrapper, not the node child holding the port — use `taskkill //F //PID <netstat pid>`
- Fly restart is needed for `initBotBank` to pick up newly deposited float
