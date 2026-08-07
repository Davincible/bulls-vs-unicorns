# Mega queue — security findings + development backlog

Ordered: Critical security → High security → existing backlog interleaved with Medium/Low fixes that
touch the same files (fix while in there).

Status: `PENDING` · `IN_PROGRESS` · `DONE` · `BLOCKED`

---

## Tier 1 — Critical security

### SEC-C1 · Redact secrets from public error surfaces · **DONE**
`/memo` returns `lastError` verbatim on a public, `CORS *` endpoint; Node fetch errors embed the
full RPC URL, which carries our Helius API key.
**Accept:** a URL with `?api-key=…` passed through the redactor emits no key; test asserts no
`api-key`/`token=`/`key=` survives; applied at both source and sink.

### SEC-C2 · Constrain `relayTx` to genuine deposits · **DONE**
Currently broadcasts arbitrary signed bytes through our paid RPC.
**Accept:** deserialise before broadcast; require fee-payer == authenticated wallet AND a transfer
to the vault; reject everything else. Tests: a foreign fee-payer is rejected, a non-vault
destination is rejected, a real deposit still relays.

---

## Tier 2 — High security

### SEC-H1 · Upgrade vulnerable dependencies · **MITIGATED (no upstream fix exists)**
3 high / 5 moderate. `bigint-buffer` overflow reachable via spl-token; `uuid` via web3.js.
**Accept:** `npm audit` shows 0 high; full suite green. If unfixable upstream, document the pin.

### SEC-H2 · Gate `convert` on the solvency freeze · **DONE**
**Accept:** convert refuses while frozen, with a test.

### SEC-H3 · Add `faucet` to GUARDED · **DONE**
**Accept:** unauthenticated faucet is refused; test.

### SEC-H4 · `finiteAmount()` at every money boundary · **DONE**
`Number("Infinity") || 0` is `Infinity`, which reaches transaction construction.
**Accept:** one helper rejecting NaN/±Infinity/negative, used at every `Number(m.*)` money site;
tests for each hostile input.

---

## Tier 3 — Money correctness (backlog, highest user impact)

### A3 · In-ring size reads $0 while staked · **DONE**
**Accept:** shows the live staked amount after a mid-round join or reconnect.

### A4 · Wire `/standings` into the Leaderboard tab · **DONE**
Engine already derives survivorship-free standings; UI still reads live balances.
**Accept:** Leaderboard renders from `/standings`; winners appear; a retired winner still counts.

### A5 · Battle report figures + all-time stolen · **PENDING**
**Accept:** dashboard shows current per-side deployed and per-currency stolen, round and all-time.

---

## Tier 4 — Gameplay

### B2 · Verify normal engagement after the self-target fix · **PENDING**
**Accept:** fighters from *different* wallets still converge and clash; test asserts hits occur.

### B3 · Sub-cent damage visible on screen · **PENDING**
**Accept:** `$0.001` renders in floaters and standings rather than `$0.00`.

### B4/B5 · Auto-deploy reliable, always at round start · **DONE**
**Accept:** fires exactly once per round while enabled, at lobby open.

### B6 · Reactive whale response · **DONE**
Bots match only at the moment a player enters; they should keep watching and raise if a whale
enters later. Overage is refunded by the matched book, so over-committing is free.
**Accept:** a late large entry triggers additional bot stake in the same lobby.

### B7 · Queue deposits during a live round · **PENDING**
**Accept:** a deposit requested mid-round is accepted and applied at the next lobby.

### B8 · Server-side auto-deploy · **PENDING**
**Accept:** continues playing with the tab closed; opt-in; bounded by balance.

---

## Tier 5 — UI

### C1 previous rounds under the arena · C2 expandable rows · C3 Solscan link + timestamp — **DONE**
### Remaining:
### C4 X share on one line · C5 stolen-vs-deployed bar · C6 profile viewer — all **PENDING**

---

## Tier 6 — Operational + Medium/Low security

### D1 · Auto-rebalance the pool when the vault's token mix changes · **DONE**
Has needed a manual `RESYNC_POOL_ON_BOOT` three times. Most fragile thing left.
**Accept:** detects ledger-vs-chain divergence and re-anchors automatically, with the same
"never write down an over-claiming ledger" guard.

### SEC-M1 per-wallet mutex · SEC-M2 validate `m.side` · SEC-M3 HTTP rate limiting ·
### SEC-M6 tighten CORS · SEC-M7 stale chain reads · SEC-L1 `resync` · SEC-L3 CSP — all **PENDING**

---

## BLOCKED — needs Max

### BLK-1 · Fee-payer wallet (SEC-M5 / D2) · **BLOCKED**
Network fees come from the vault, which holds player SOL. Needs a funded operator keypair.
*Interim guard already shipped:* anchoring halts below a 0.05 SOL reserve.

### BLK-2 · Mainnet canary · **BLOCKED**
The real Jupiter swap has never run with real money. Only Max can spend funds.

### BLK-3 · Add float · **BLOCKED**
~$110 supports the current arena; bigger lobbies need more. Product decision.

### BLK-4 · Full seed in memo (D3) · **BLOCKED-ish**
Currently 16 hex chars — anchors but cannot recompute. ~48 bytes/round more. Cheap, but changes the
published format, so worth Max confirming before there is history worth preserving.


---

## Run summary (see EXECUTION_REPORT.md)

DONE: SEC-C1, SEC-C2, SEC-H2, SEC-H3, SEC-H4, SEC-M2, A3, A4, B4, B5, B6, C1, C2, C3, D1, plus
token-denominated P&L (raised mid-run). SEC-H1 mitigated and asserted — no upstream fix exists.

BLOCKED: fee-payer keypair, mainnet canary, added float, full memo seed — all need Max.

NOT REACHED (not blocked, ran out of context): A5, B2, B3, B7, B8, C4-C6, SEC-M1/M3/M6/M7.

Tests 201 -> 236, green at every commit.
