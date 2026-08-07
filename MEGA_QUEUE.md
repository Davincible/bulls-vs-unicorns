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

### B2 · Verify normal engagement after the self-target fix · **DONE**
5 tests. The risk was an over-broad owner check silently disarming everyone — a battle where
nothing connects still settles, still conserves, and still passes every other test.

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
### C4 arena-aware share text · **DONE** — hardcoded $BULL/$UWU went out publicly on a UWU/SOL win
### C5 raided-vs-deployed bar · **DONE**
### C6 profile viewer · **DONE** — and it closed the profile-vs-leaderboard ROI mismatch
### SEC-L1 `resync` · **ASSESSED, NO CHANGE** — not an endpoint; boot-only, before any round exists,
so openStakes is 0 and the mid-round sampling flaw cannot apply.
### B8 server-side auto-deploy — **PENDING, deliberately not rushed** (stakes real money unattended)
### Hall of Legends one line · **DONE** (and removed the dead #hof list)
### Two-line top bar + wallet pinned top-right · **DONE**
### Ticker stacking · **VERIFIED** — isolation:isolate confirmed computed, was previously unproven

---

## Tier 6 — Operational + Medium/Low security

### D1 · Auto-rebalance the pool when the vault's token mix changes · **DONE**
Has needed a manual `RESYNC_POOL_ON_BOOT` three times. Most fragile thing left.
**Accept:** detects ledger-vs-chain divergence and re-anchors automatically, with the same
"never write down an over-claiming ledger" guard.

### SEC-M1 · **DONE** — but not as scoped
The audit guessed "per-wallet mutex". The withdraw/withdrawSol/convert paths already debit before
their await, so the double-SPEND was covered. The real exposure was crediting: both deposit
verifiers did check-then-act across an await, so one on-chain deposit could be credited TWICE by
sending the same relayTx message twice. Signatures are now reserved before the await, released on
failure so a retry still works.

### SEC-M3 HTTP rate limiting · **DONE**
Token bucket per IP off Fly's client-ip header, bounded table, /live exempt.
Verified live: 80 concurrent -> 49x200 / 31x429; sequential traffic untouched.

### SEC-M2 validate `m.side` · **DONE**
### SEC-M7 stale chain reads · **DONE**
Reads committed as one snapshot (a mid-sequence failure used to leave one token fresh and two
stale under the OLD timestamp), and auto-rebalance now refuses to spend on a reading older than
5 min. /float publishes ageSec + stale.

### SEC-L3 CSP · **DONE (with stated limits)**
'unsafe-inline' is unavoidable while the app is one inline script, so this does not stop injected
script running - it stops it exfiltrating (connect-src/img-src) or pulling more code (script-src).

### SRI on the CDN script · **DONE** (not in the original audit — found while writing the CSP)
@solana/web3.js was loaded from unpkg with no integrity check, on a page where people sign real
mainnet transactions. Now pinned by sha384.

### SEC-M6 tighten CORS · **ASSESSED, DELIBERATELY NOT CHANGED**
All endpoints are GET-only unauthenticated public data, no cookies, /wallets already truncates.
Tightening gains nothing curl cannot do. Rate limiting was the real control and it shipped.

### SEC-L1 `resync` — **PENDING**

### B7 queued deposits · **DONE**
A deploy asked for mid-fight is held and replayed at the next lobby instead of refused.

### A5 battle report all-time stolen · **DONE**
Moved to the engine (per-arena, persisted, from the authoritative hit log). The browser tally
zeroed on reload and on arena switch and only counted hits that tab witnessed.

### B3 sub-cent damage on screen · **DONE**
Under a tenth of a cent now reads "<$0.001" rather than "$0.000".

### Big-wins ticker showed losses · **DONE**
It rendered deposited->current standing, which goes red when a raider is down overall. A raid is
always a gain; the lifetime standing is a different number. Now shows the raid, and the standing
only when it is actually up.

### All-time leaderboard ROI · **DONE (removed)**
ROI was measured against TOTAL STAKED, so re-staking $1 fifty times read as "staked $50". The
profile computed it differently, so both figures were defensible and they disagreed. Replaced with
the coin-denominated net + win rate.

### "All-time total 9000" · **DONE (labelled)**
Not wrong - cumulative deploy volume across ~480 rounds including bots. Now named as volume, with
the basis stated, instead of reading as money that exists.

### Round counter reset on every deploy · **DONE**
restore() ran three lines AFTER the runners that read roundsByArena. Pure statement order.

### Previous rounds unrelated/mislabelled · **DONE**
Two renderers writing the same element from different histories; arena panel unfiltered; labels
were literally "A"/"B" and resolved from the live picker rather than each round's own arena.

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

---

## Ledger correction — APPLIED 2026-08-07

**Question that prompted it:** how can the ledger claim more than the vault holds, when it is our
own money circulating with only fees removed?

**Answer: it cannot, and it did not.** Nothing left the vault. Measured on-chain across all 641
vault transactions, network fees total 0.0032 SOL and no token-account rent was ever paid. (I had
guessed ATA rent was the cause; the chain disproved that.) Circulation is conservative — zero
CONSERVATION warnings, aggregate reconciling at exactly -0.200% = the fee.

The gap was ledger balance that never had coin behind it. The pre-fix auto-rebalance sampled the
books mid-round, when open stakes had left the accounts but the coin was still in the vault, so it
read live stakes as unowned float and credited the house a second time for money already on the
table: +211.28 UWU and +0.128 SOL in one cycle, no chain movement behind either.

**Applied** via one-shot WRITEDOWN_OVERCLAIM=1, then immediately disarmed:

    writedown: uwu 1751.6129 -> 1674.2750  (wrote off 77.3379)
    writedown: bull skipped — no chain reading
    writedown: sol   70.8982 ->   64.7307  (wrote off 6.1675 USD)

    UWU delta  +76.875   -> +0.465
    SOL delta  +0.082647 -> +0.000041
    NET        +$8.26    -> +$0.02

Players fully backed throughout: 191.92 UWU owed against 1866.20 held, 0.0245 SOL against 0.9022.
Residual $0.02 is rounds settling between correction and measurement.

---

## Pot sizing — RESOLVED (config, not code)

Chased in the wrong place twice. BOT_COMMIT 0.35-0.85 -> 0.12-0.32: no effect. Then the per-fighter
floor BOT_STAKE_USD_MIN -> 0.60: also no effect. Both were guesses about the sizing formula rather
than measurements of what rounds actually contained.

The round log answered it in one read:

    round 797   37 fighters  $24.56  ($0.66 each)
    round 798   41 fighters  $25.81  ($0.63 each)

Per-fighter stake was already small — the pot was large because FORTY fighters were in it.
PLAY_MIN/PLAY_MAX cap entrants per side and were both 0 (uncapped), so every solvent bot entered
every round. Now 5-9 per side:

    round 799   17 fighters  $11.87
    round 800   16 fighters   $9.91
    round 801   14 fighters   $8.60   (per fighter still $0.61 — only headcount moved)

**Correction on record:** asked "how we got like 40 players now?", I answered that the arena ran
10-14 and the 40 was the leaderboard's cumulative rows. That was wrong — there really were ~40
fighters per round. My reading was stale, taken before the population grew off the funding fix.

Live settings: PLAY_MIN=5 PLAY_MAX=9 BOT_STAKE_USD_MIN=0.60 BOT_COMMIT_MIN=0.12 BOT_COMMIT_MAX=0.32
