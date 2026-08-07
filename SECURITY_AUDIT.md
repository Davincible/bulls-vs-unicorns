# Security audit — Bulls ⚔ Unicorns

Adversarial review assuming full source access. Live mainnet custodial system: an off-chain
authoritative engine holding a vault key, ~$110 of house float and real player deposits.

Audited 2026-08-07 against commit at `201 tests`. Scope: `engine/src/**`, `web/**`, deploy config,
dependencies.

**No deployed Solana program.** There is no Anchor/BPF program — settlement is off-chain, the chain
is used for SPL transfers, a Jupiter swap and a memo anchor. So the whole class of on-chain findings
(PDA seeds, CPI, re-init, upgrade authority) does not apply. The custodial vault key is the
equivalent risk concentration, and is covered below.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 4 |
| Medium | 7 |
| Low | 5 |

The two Critical findings are both **secret-exposure through a public endpoint** and **an open
transaction relay** — neither is theoretical; both are reachable right now from the internet.

---

## CRITICAL

### C1 — `/memo` can leak the keyed RPC URL (API key) to the public internet
**File:** `engine/src/memo.ts:211`, exposed via `engine/src/server.ts:938`

```ts
lastError = String((e as Error)?.message || e).slice(0, 220);   // memo.ts:211
if (url === "/memo") { ...res.end(JSON.stringify(memoStats())); }  // public, CORS *
```

`memoStats()` returns `lastError` verbatim on an **unauthenticated endpoint with
`access-control-allow-origin: *`**. Node's `fetch`/undici errors and several web3.js paths embed the
full request URL in the message — and our RPC URL contains the Helius API key.

**Exploit:** poll `GET /memo` until an anchor fails with a network-class error, read the key, then
drain the RPC quota or use the paid endpoint as free infrastructure. This is the *same class* of bug
as the earlier leak where the key was broadcast to every browser.

**Verified:** `/memo` is public and returns `lastError`. A 401 does not embed the URL, but
`TypeError: fetch failed` and DNS/connect errors routinely do. Not proven end-to-end; treated as
Critical because the blast radius is a live credential and the fix is trivial.

**Fix:** redact any `key=`/`api-key=`/`token=` query parameter and any full URL from stored error
strings before they leave the process. Apply at the *sink* (`memoStats`) and at the *source*.

---

### C2 — `relayTx` is an open transaction relay through our paid RPC
**File:** `engine/src/server.ts:1218-1233`

```ts
sig = await broadcastSigned(String(m.signedB64 || ""));
```

Broadcasts **arbitrary caller-supplied signed bytes**. The comment correctly argues that *crediting*
is safe (the `verify*` path checks the vault actually received funds), but broadcasting is a
separate capability from crediting, and it is unconstrained.

**Exploit:** an authenticated (whitelisted) wallet submits any transaction it likes — spam, MEV
bundles, arbitrage — and we pay the RPC cost and wear the reputational association of the endpoint.
The allowlist limits *who*, not *what*.

**Mitigating:** requires auth + allowlist, so today it is limited to the 21 wallets we control plus
Max. That is why this is Critical rather than "already exploited" — the moment the allowlist opens
this becomes an open relay.

**Fix:** before broadcasting, deserialise the transaction and assert it is a deposit we expect:
fee-payer == the authenticated wallet, and it contains a transfer whose destination is the vault.
Reject anything else.

---

## HIGH

### H1 — Vulnerable dependencies (3 high, 5 moderate)
`npm audit`: `bigint-buffer` (buffer overflow, high) reached via `@solana/spl-token` →
`@solana/buffer-layout-utils`; `uuid` (missing buffer check) via `jayson` → `@solana/web3.js`.
`bigint-buffer` parses on-chain account data, i.e. attacker-influenced bytes.
**Fix:** upgrade `@solana/spl-token` and `@solana/web3.js`; re-audit. If no fixed version exists,
pin and document, since we already avoid the affected `toBigIntLE` path in most places.

### H2 — No solvency gate on `convert`
**File:** `engine/src/server.ts:1272+`
`withdraw` and `withdrawSol` both check `isFrozen()`. `convert` does not — yet an OTC convert hands
a player house tokens and changes what the vault owes per asset.
**Exploit:** during a solvency freeze (the exact moment the books are known-bad), a player can still
convert into whichever asset is *better* backed, then withdraw once the freeze lifts.
**Fix:** gate `convert` on `isFrozen()` too.

### H3 — `faucet` is not in `GUARDED`
**File:** `engine/src/auth.ts:13`
`faucet` mints tokens to an arbitrary wallet and is **not** in the guarded set, so it needs no
signature. It is disabled on live chains (`FAUCET_ON` requires a test RPC), which is the only reason
this is not Critical.
**Exploit:** on any test deployment, an unauthenticated caller mints unlimited balance — and if
`SOLANA_RPC` is ever misconfigured to a test URL while real money is present, on mainnet too.
**Fix:** add `faucet` to `GUARDED`. Defence in depth behind the existing `FAUCET_ON` check.

### H4 — Unbounded `Infinity` reaches transaction construction
**File:** `engine/src/server.ts:1191`
```ts
const txB64 = await buildSolDepositTx(m.wallet, Number(m.sol) || 0);
```
`Number("Infinity") || 0` is `Infinity`, not 0. It flows into
`Math.round(sol * LAMPORTS_PER_SOL)` → `Infinity` → `BigInt` conversion throws, or produces a
nonsense transaction. Most money paths clamp with `Math.min(x, balance)` which neutralises
`Infinity`; this one does not.
**Fix:** a single `finiteAmount()` helper used at every money boundary — rejects NaN, ±Infinity and
negatives rather than relying on each call site's clamp.

---

## MEDIUM

### M1 — No per-wallet mutex around async money operations
`withdraw` debits synchronously before `await`, which is safe under Node's single-threaded model.
But `convert` performs `await swapExact(...)` **after** debiting and *before* crediting; a second
convert during that window sees the debited balance (correct) yet the cooldown is set before the
swap resolves and cleared on failure. The interleaving is currently benign but is one refactor away
from double-spend. **Fix:** an explicit in-flight set keyed by wallet.

### M2 — `m.side` is not validated
`m.side === "bull" ? a.bull : a.uwu` treats *any* non-`"bull"` value as `"uwu"`, then forwards the
raw string to `mintFor()`. Fails closed today (throws → refund), but it is an unvalidated value
crossing into chain code. **Fix:** validate against the arena's actual sides.

### M3 — Public endpoints have no rate limiting
`connectionAllowed`/`allowMessage` protect the WebSocket. The HTTP endpoints (`/float`, `/standings`,
`/round/*`, `/memo`, `/solvency`) have none, and `/standings` walks the whole round log per request.
**Fix:** a small token bucket per IP on the HTTP server.

### M4 — `/round/*` publishes full wallet addresses
By design (it is the data the on-chain hash commits to), but it means every participant's address
and per-round P&L is queryable by anyone. Worth an explicit product decision rather than an accident.

### M5 — Vault key is a single point of failure
`VAULT_SECRET_KEY` lives in the process. Server compromise = total loss of everything in the vault.
Bounded by keeping the float in bot wallets whose keys are off-server, which is already the design —
recorded here so the residual risk is explicit, not to suggest it is unhandled.

### M6 — `CORS: *` on every HTTP response
Fine for genuinely public proof data, wrong for `/memo` (operational detail) and arguably `/float`.
**Fix:** restrict the operational endpoints to the site origin.

### M7 — Error handling that fails open
`catch { /* leave the last good reading in place */ }` in `refreshChainHoldings` means a persistently
failing RPC leaves `lastChain` stale indefinitely, and `/float` keeps reporting it as current. Add an
age field and treat stale as unknown.

---

## LOW

- **L1** `resync` is a handled WS message with no auth path shown; verify it is inert or guarded.
- **L2** `setName`/`avatar` accept arbitrary URLs (sanitised for scheme, but SSRF-adjacent if ever
  fetched server-side; today only the browser loads them).
- **L3** No `Content-Security-Policy` on the served page.
- **L4** `MEMO_MIN_VAULT_SOL` guards anchoring but nothing guards the *swap* path from draining SOL
  below what withdrawals need.
- **L5** Test-only escape hatches (`BOT_FAKE_BANK`, `FAUCET_ON`) are correctly gated on a test RPC,
  but the gate is a regex on the RPC URL — a keyed devnet URL containing "mainnet" in a path would
  defeat it.

---

## What is genuinely solid

Worth recording, because an audit that only lists problems misleads:

- **Conservation is audited per round in production** and has logged zero violations across
  hundreds of rounds. Money in equals money out, minus the fee.
- **Auth** is ed25519 signature-over-nonce with single-use nonces, constant-time token comparison,
  wallet bound into the signed payload, and expiry inside the HMAC. Six adversarial tests cover
  replay, cross-wallet reuse, tampering and expiry.
- **Solvency** is computed from real on-chain balances and *freezes withdrawals* on a shortfall —
  and that freeze has been verified end-to-end with a deliberately induced breach.
- **Provable fairness** holds: commit-reveal with the browser independently recomputing every round,
  enforced by a test that runs the shipped client port against the engine and requires exact
  agreement.
- **The OTC path cannot over-extend the vault** — capped at 25% of spare holdings after every other
  player is paid.
- **201 tests**, including regression tests for every money bug found so far.
