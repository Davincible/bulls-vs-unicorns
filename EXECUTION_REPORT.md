# Execution report

Autonomous run: security audit → mega queue → execution. Live mainnet system throughout.

**Tests: 201 → 233.** All green at every commit. Nine deploys, none rolled back.

---

## 1. Security fixes

### CRITICAL

**SEC-C1 — API key leakable through a public endpoint** · `memo.ts:211`, `server.ts` `/memo`

*Before:* `/memo` returned `lastError` verbatim on an unauthenticated `CORS:*` endpoint. Node's
fetch errors routinely embed the full request URL, and ours carries the Helius API key. Same class
as the leak that already shipped once, when the keyed RPC was broadcast to every browser.

*After:* a redactor applied at **both** the source (where the error is stored) and the sink (where
stats are served), so a future field cannot leak merely by being added. Strips named credential
params, any query string on a URL, byte-array keys, and the exact secrets held in env.

*Judgement call:* I deliberately do **not** redact "any long base58 string". A secret key and a
transaction signature are both ~88 chars and indistinguishable by shape — a length rule would have
destroyed `lastSig`, which is public data we need. Matching the actual secret is precise instead of
clever. 8 tests.

**SEC-C2 — `relayTx` was an open transaction relay** · `server.ts:1218`, `chain-ops.ts`

*Before:* broadcast arbitrary caller-supplied signed bytes through our paid RPC. Crediting was
always safe (the `verify*` path checks the vault really received the money) but **broadcasting is a
separate capability**, and unconstrained it let an authenticated caller push any transaction —
spam, MEV, arbitrage — at our cost and under our endpoint's reputation. The allowlist limited *who*,
not *what*.

*After:* refuses unless the fee payer is the authenticated wallet, every program is one our own
deposit builder emits, and the transaction actually pays the vault. SPL deposits target the vault's
*ATA* rather than the vault pubkey, so the check derives both — a naive pubkey check would have
missed every token deposit.

*Alternative considered:* simulate and inspect balance deltas. Stricter, but costs an RPC round trip
per deposit and still needs this structural check to know what the deltas should be. 6 tests.

### HIGH

| ID | Before → After |
|---|---|
| **SEC-H2** | `convert` ignored the solvency freeze while `withdraw` respected it — so the one moment the books were known-bad was the one moment a player could rotate into whichever asset was better backed. Now gated. |
| **SEC-H3** | `faucet` **mints balance** and required no signature. Disabled on live chains, but that gate is a regex on the RPC URL. Added to `GUARDED` — a second lock, not a second check on the same one. |
| **SEC-H4** | `Number("Infinity") \|\| 0` is `Infinity`, not 0, so `Infinity` reached `Math.round(sol * LAMPORTS_PER_SOL)`. Most paths happened to neutralise it via `Math.min(x, balance)`; `buildSolDepositTx` did not. One `money()` helper at every client-supplied amount. |
| **SEC-H1** | **Cannot be fixed by upgrading** — see below. |

**SEC-H1** deserves a straight answer rather than a tick. `npm audit` reports 3 high / 5 moderate,
all transitive under `@solana/*`. `bigint-buffer@1.1.5` **is** the latest and is still flagged; there
is no fixed version upstream. What makes it acceptable is that the advisory is a buffer overflow in
the **native addon**, and the addon is not loadable in our image — the package falls back to pure JS
on every boot. That is now **asserted by a test**, so a future `npm rebuild` that enables the addon
fails the suite instead of silently reintroducing the exposure. A second test asserts we never call
the affected API directly.

### MEDIUM
**SEC-M2** — `side` was validated by treating anything non-`"bull"` as `"uwu"` and forwarding the raw
string into chain code. Now rejected explicitly.

---

## 2. Correctness and feature work

**A4 — the leaderboard was measuring the wrong population.** It read live balances, which is a
survey of *survivors*: a fighter who won and later retired vanished with their profit, so the
aggregate could only ever look negative. That is what "nobody is profitable" actually was. It now
renders from `/standings`, derived from the permanent round log — and the same rows are committed
on-chain by the results hash, so a sceptic can rebuild the board from Solana without trusting us.

*Found while wiring it:* the client never handled `roundHistory` or `roundLogged` **at all**. The
server-side log shipped earlier was complete but nothing consumed it — the browser was still keeping
its own in-memory list, which is why history appeared to reset on every reconnect.

**C1/C2/C3** — previous rounds now appear under the arena page, rows expand, and each carries a real
timestamp plus a link to the memo transaction that anchored *that* round. The engine reports which
rounds each signature covers, so a row links to its own proof rather than to whichever memo happened
to be most recent.

**D1 — the pool re-anchors itself.** A convert moves the vault's token mix on-chain but leaves the
ledger pool untouched, so the float strands: 1,588 UWU once sat in the vault owned by nobody while
the arena could field three fighters. This had needed a manual resync **three times**. The daemon
only credits the house up to what the chain backs, never touches player balances, skips the SOL leg
when there is no price rather than valuing it at zero, refuses outright on an over-claiming ledger,
and ignores gaps under $5.

**Token-denominated P&L — your observation, and you were right.** USD P&L conflates whether you won
rounds with whether the coin moved. The live board makes the case better than any argument:
`d8kU…VtX` shows **+$0.49 profit while down 0.18 SOL and 10.85 UWU**. Dollars said winner, coins said
loser. Standings now carry a per-token net alongside USD.

Worth noting what was already right: *within* a round USD is price-neutral, because entry and exit
use one frozen rate. The drift only enters when summing across rounds.

---

## 3. BLOCKED — needs you

**BLK-1 · Operator fee-payer wallet.** Network fees come from the vault, which also holds player
SOL. *Tried:* charging fees to the treasury's own SOL (done — the house pays out of revenue) and a
0.05 SOL reserve that halts anchoring before it could threaten a withdrawal (done). *Cannot proceed
without:* a funded keypair. Until then the lamports still physically leave the vault, even though
they are booked against the house.

**BLK-2 · Mainnet canary.** The real Jupiter swap has never run with real money. Everything around
it is proven — routes quote sanely, decimals fixed, refund-on-failure tested, Jito bundling live.
*Cannot proceed without:* you spending ~$2. This is the last genuinely unproven path.

**BLK-3 · Add float.** ~$104 supports 6–15 fighters. Bigger lobbies need more. Product decision.

**BLK-4 · Full seed in the memo.** Currently 16 hex chars — enough to *anchor* a round, not to
*recompute* it. ~48 bytes/round more, trivially affordable. Held because it changes a published
format and is cheaper to decide now than after there is history worth preserving.

---

## 4. Not reached

B4/B5 auto-deploy reliability · B6 reactive whale response · B7 queued deposits · B8 server-side
auto-deploy · A3 in-ring size · A5 battle report totals · C4 X share on one line · C5 stolen-vs-
deployed bar · C6 profile viewer · SEC-M1 per-wallet mutex · M3 HTTP rate limiting · M6 CORS
tightening · M7 stale chain reads.

None are blocked; I ran out of context, not options. `MEGA_QUEUE.md` has them ordered.

---

## 5. Residual risk

1. **The vault key is a single point of failure.** Server compromise = loss of everything in the
   vault. Bounded by keeping the float in bot wallets whose keys are off-server, which is already
   the design. Stated so it is explicit, not because it is unhandled.
2. **`/round/*` publishes full wallet addresses.** By design — it is the data the on-chain hash
   commits to — but it deserves to be a decision rather than an accident.
3. **HTTP endpoints have no rate limiting.** The WebSocket does. `/standings` walks the whole round
   log per request.
4. **`isFrozen()` is now checked on withdraw, withdrawSol and convert** — but any *future* money path
   must remember to check it. A single guarded wrapper would make that structural.
5. **8 dependency advisories remain open upstream** with no fixed version. Mitigated and asserted,
   not eliminated.

## 6. Recommended next

1. **Do the canary** (BLK-2). It is the only unproven money path and costs ~$2.
2. **Fund a fee-payer** (BLK-1) so operations never touch player-backed SOL.
3. **B4/B5 auto-deploy** — the most user-visible remaining bug.
4. **SEC-M3 rate limiting** before the allowlist opens to anyone.
