# Bulls ⚔ Unicorns — Dev Log & Mainnet Readiness

Last updated: 2026-08-07

---

## 1. Where we actually are

**Live:** `https://bulls-arena-engine.fly.dev` — Fly.io, 1 machine, ~$3.34/mo, **Solana MAINNET**.

| Piece | State |
|---|---|
| Engine (rounds, ledger, settlement) | ✅ working, **bots deploying and settling on mainnet** |
| Security (auth, rate limits, allowlist, XSS, traversal) | ✅ 24/24 adversarial checks |
| Solvency guard + public proof-of-reserves | ✅ verified end-to-end incl. a forced breach |
| **Float integrity** (the whole 2026-08-06 session) | ✅ 4 leak classes found, fixed, instrumented |
| Real on-chain deposits / withdrawals | ✅ proven on devnet AND mainnet |
| Convert → real Jupiter swap | ✅ built, **untested on mainnet** |
| Test suite | ✅ 108 tests, CI on push |
| History tab: all players per round | ✅ built (client), needs a deploy + eyeball |

**Money on-chain, all accounted for:**
- Vault `6wLK7paKz2es3nG9jdVvrnHMNUCPkognh8yQUFJ7Zete` — 0.92 SOL, 1,520 UWU
- Seed `4XVVgtG9kdn6suKKpNZrcBcxe9v9GkXWYofRXbRY1GZr` — 0.06 SOL, 5,400 UWU
- Ledger vs chain visible live at `GET /float` (per token: pool / bots / players vs vault)

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

**Economy invariants** (each has tests + live instrumentation):
- The sim runs in **USD**. Stakes convert in at entry, payouts convert back per side's own token.
- **One price per arena-round**, frozen at first use. Entry and settlement can never use different
  prices, so a round is token-neutral regardless of market moves.
- **Bots never convert.** A ledger-only swap has no on-chain counterpart; a bot that cannot stake
  in its own token is retired and its holdings return to the pool.
- Bot population is sized by `floatUsd() / perBot` — the crowd follows the money.
- Bust threshold == stake minimum. No dead band where a bot can neither play nor be recycled.
- On SIGTERM/SIGINT every open stake is refunded **gross** before the flush (fly.toml: 15s grace).
- Per-round conservation audit logs `CONSERVATION` warnings if a round's outflow/inflow gap differs
  from the deploy fee.

---

## 3. The float-integrity session (2026-08-06) — what was actually wrong

The arena sat at "joined 50 / busted 49 / entries 0" on mainnet with a green suite. Four separate
defects compounded; every one was invisible to /solvency because bot money is house money.

| # | Bug | Mechanism | Fix |
|---|---|---|---|
| 15 | **Unit mixing in the sim** | UWU side entered token counts, SOL side entered dollars; cheap token fielded ~30× the army and won every round | sim runs in USD end-to-end |
| 16 | **1:1 bot swap minted 34×** | top-up moved raw units between tokens; 100 UWU ($2.95) became 100 sol units ($100) | bot conversion removed entirely |
| 17 | **Deploy/bust dead band** | busted at 0.8× min stake but needed 1.0× to play — zombies trapped the float | bust at the stake minimum |
| 18 | **Restart burned the pot** | entries debit immediately, rounds live in memory; ~$19 of a $27 book lost in one restart | gross refund of open stakes on shutdown |

Supporting tooling that came out of it:
- `GET /float` — ledger vs chain per token, split pool/bots/players. This caught the drift.
- `resyncPoolToChain` (`RESYNC_POOL_ON_BOOT=1`, one boot then remove) — re-anchors the house float
  to the vault. Refuses to write DOWN an over-claiming ledger (that's insolvency, not drift).
- `recoverInPlace` is now one-shot (persisted marker) and repairs **wipes only** (≤1% of deposit) —
  a bot's honest losses can never be re-credited.
- `observe.mjs` — protocol-correct spectator: entries, stakes, winners, per-side totals.
- Per-round conservation audit in the engine itself.

**Bug #19 (found by the audit's absence of warnings):** the "drift" measured at random moments was
partly sampling error — staked money is out of the accounts mid-round. Measure at a fixed phase
(after settle) or trust the in-engine audit.

**Bug #20 — the house charged itself.** 0.2% of every *bot* stake went to the treasury counter
while the tokens left the accounts. Bots are house money and play ~9 rounds/min, so the house was
farming its own bankroll: books slid 1520 → 362 UWU in ~40 minutes with zero real players, and the
conservation audit blessed it because a fee is "expected shrinkage". Bot fees now return to the
pool; treasury and house-take stats grow **only on real-player fees** — which also makes the
dashboard revenue honest instead of self-dealing.

---

## 4. Blockers to opening the doors

### 🔴 B2 — Public RPC will throttle
Retry + rotation exist (`SOLANA_RPC_FALLBACK`), but a paid mainnet endpoint (Helius/QuickNode) is
still needed before real players arrive. `/float` chain readings already cache 60s to protect it.

### 🔴 B3 — Operator wallet not whitelisted
Whitelist has the 20 bots only. Max cannot play. Needs his Phantom address in `WHITELIST`.

### 🟡 B4 — Soak the fixed build
200-round soak of the current build in progress (float trend at fixed phase, conservation warnings,
one-sided ratio). Must be flat-minus-fees before inviting anyone.

### 🟡 B5 — Mainnet convert never exercised for real
Convert is now token-general (bull/uwu/sol, any pair) and works on the live UWU/SOL arena — before,
it only knew ANSEM/UWU and did nothing there. Server logic, mint/decimals mapping, SOL leg, and
refund-on-failure are covered by 116 tests; the UWU↔SOL Jupiter routes quote sanely (100 UWU →
0.039 SOL, 1 hop). The **real on-chain swap has still never run for real money** — that is the one
thing the canary must exercise: deposit → play → convert → withdraw with Solscan links.

### ✅ B3 — Operator wallet whitelisted (2026-08-07)
`BTYdc2awdFDZnDc8wVs3wv61UEYDDMQ329Zy3KC9JHVZ` added to WHITELIST (21 wallets total). Max can play.

### ✅ B2 — Paid mainnet RPC live (2026-08-07)
Helius mainnet is now the primary RPC (`mainnet.helius-rpc.com`, existing key works cross-network),
public endpoint as fallback. Verified the key is NEVER sent to browsers (clients get the public URL).

### ✅ B6 — History tab (2026-08-07)
All-players round history verified live: every settled round shows every player, stake, payout, P&L.

---

## 5. What "done" looks like

- [x] B1 float recovered, bots deploying, rounds settling ✅ 2026-08-06
- [x] B2 paid RPC as primary, public as fallback ✅ 2026-08-07 (Helius mainnet)
- [x] B3 operator wallet whitelisted ✅ 2026-08-07
- [x] B4 soak: **float PROVEN flat** — `/float` `trueTotal` (accounts + open stakes) swung **$0.00** across 8 samples while accounts-only wobbled $2.77 (the sampling artifact); 0 conservation warnings over hundreds of rounds ✅ 2026-08-07
- [ ] B5 canary: deposit → play → convert → withdraw, Solscan links (**only remaining action, needs Max + real money**)
- [x] B6 History tab verified in the browser ✅ 2026-08-07
- [x] Solvency `ok:true`, `/health` 200 ✅; `/float` real-player gap = 0 (idle house float re-anchored via resync)
- [ ] Explicit go from Max before opening to anyone

**The float "drift" — CLOSED.** Twice I misread a falling `/float` number as a leak. It was a
measurement artifact: `/float` counted account balances only, and between rounds the stakes are on
the table (held by the round runner, not accounts), so any mid-cycle snapshot reads low. Proven
definitively: `/float` now also reports `open` (staked-but-unsettled, from the conservation flow
map) and `trueTotal` = accounts + open. Sampled 8× across several rounds, **trueTotal swung $0.00**
while accounts-only swung $2.77. Combined with **0 conservation warnings** over hundreds of live
rounds, the money is conserved to the penny. The only real historical drift was ~10 rapid dev
redeploys each settling with a little round-noise; `RESYNC_POOL_ON_BOOT=1` re-anchors after a spree,
and even then the ledger only ever *under*-claims (idle house float still in the vault), never
over-claims — no player is ever short-changed.

**Security re-audit (2026-08-07), full current build, isolated engine + throwaway ledger:**
pentest 16/16 · pentest2 8/8 (convert over-mint/negative/spam H1-H3, bot-account isolation, staked
funds locked from withdrawal) · DoS probe survived 300-socket + 20k-message floods + free-account
attempts. Convert's new `{from,to}` fields fuzz-tested: garbage keys fall back to real fields,
from==to re-resolves, amount clamps to holdings.

---

## 6. Operating notes

**Deploy:** `fly deploy . --config engine/fly.toml --dockerfile engine/Dockerfile --ha=false`
(build context is the REPO ROOT — the image ships `web/` too).

**Never** `fly scale count 2` — the ledger is SQLite on one volume; a second instance splits the book.

**Watch it:** `node engine/observe.mjs wss://bulls-arena-engine.fly.dev 5` · `curl /float` ·
`fly logs | grep CONSERVATION`

**Key locations** (none on the server except the vault):
- `~/mainnet-vault.json` (WSL) — vault, also a Fly secret
- `~/seed-wallet.json` (WSL) — the float
- `engine/data/bot-wallets-mainnet.json` — 20 bot keys
- NEVER delete any wallet key. Ever.

**One-boot maintenance flags** (set, deploy, verify log line, then UNSET — leaving either on can
mint):
- `RECOVER_FLOAT_ON_BOOT=1` — repair wiped pool wallets from deposit records (one-shot marker
  guards a second run, but don't rely on it)
- `RESYNC_POOL_ON_BOOT=1` — top the house float up to what the vault holds

**Gotchas that cost hours:**
- `CHAIN_CONFIG` defaults to `devnet.json` (local-validator mints) → confusing `TokenAccountNotFoundError`
- Windows `pkill -f tsx` kills the wrapper, not the node child holding the port — use `taskkill //F //PID <netstat pid>`
- Fly restart is needed for `initBotBank` to pick up newly deposited float
- `/float` mid-round undercounts by the open stakes — sample after a settle
- The test suite was green for every bug above. Watch the live system; `observe.mjs` exists for that.
