# Bulls ⚔ Unicorns — project context

Single entry point for anyone (human or agent) picking this up cold. Read this first, then
`MIGRATION.md` if you are setting up a new machine.

**This system holds real money on Solana mainnet.** Read §7 before changing anything.

---

## 1. What it is

A real-time PvP betting game on Solana mainnet. Memecoin armies fight 40-second rounds; the winning
side takes value off the losing side. Players deploy real tokens, and real tokens are paid out.

- **Live:** https://bulls-arena-engine.fly.dev
- **Vault:** `6wLK7paKz2es3nG9jdVvrnHMNUCPkognh8yQUFJ7Zete`
- **Tokens:** ANSEM (`9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump`),
  UWU (`UWUy7J86LUiBv5SjAUZ53LMGhtnqvbQ7QNSSkyupump`), SOL
- **Status at time of writing:** PAUSED (`PAUSED=1`). Rounds halted; balances and withdrawals live.

### The shape of a round
1. **Lobby (~9s)** — deposits open. A commitment `sha256(secret)` is published.
2. **Battle (~40s)** — deposits lock. The seed is *derived*, the fight is simulated, the result is
   settled.
3. **Settle** — payouts written to the ledger, the round is anchored on-chain, a new lobby opens.

### Modes
- **Normal** — raids compound in the ring.
- **Extraction** — raids bank to your wallet in real time.

---

## 2. Vision

A game that reads as a **trading terminal, not a casino**. Confident, quiet, dense with real
numbers. Restraint is the aesthetic *and* the trust strategy: this product handles other people's
money, and looking like a slot machine is how you lose the people worth having.

The differentiator is not the fight, it is that **every round is verifiable**. The commitment lands
before anyone can act, the result is anchored on Solana, and any stranger can recompute a round in
their own browser without trusting the operator. That is the thing to protect above all else.

---

## 3. Architecture

```
web/index.html        one self-contained page (~2,500 lines) — canvas game + full UI.
                      No build step. Inline CSS/JS. Strict CSP; the one CDN script is SRI-pinned.
engine/src/
  server.ts           the engine: rounds, ledger, websocket, HTTP API, bots           (~2,000 lines)
  round.ts            2-team round lifecycle + commit/derive/reveal
  roundN.ts           3-way and FFA lifecycle  ⚠ still draws its seed at lobby open (see §8)
  game.ts / gameN.ts  the deterministic fight simulation
  ledger.ts           accounts, treasury, the permanent round log, snapshots
  chain-ops.ts        Solana reads/writes, vault, ATAs, deposit verification
  swap.ts             Jupiter converts (Jito-bundled, slippage-capped)
  memo.ts             on-chain round anchoring
  reconcile.ts        solvency daemon — freezes withdrawals if the books exceed the vault
  recover-float.ts    float re-anchoring + the one-shot over-claim write-down
  er-sim.ts           ⚠ MagicBlock fork work, NOT production (see §9)
programs/             Anchor/Rust on-chain program (fork work)
```

**Model: off-chain authoritative engine + on-chain settlement, custodial vault.** Players deposit
into the vault; balances are ledger entries. The engine is the source of truth for gameplay; the
chain is the source of truth for money.

### Money invariants — do not break these
1. **Conservation.** A round pays out exactly what was staked, minus the 0.2% fee. Asserted per
   round; `CONSERVATION` warnings in the log mean something is wrong.
2. **Solvency.** Player liabilities never exceed vault holdings. Checked every 15s; a breach
   **freezes withdrawals automatically**.
3. **One price per arena-round.** Entry and exit use the same frozen price, so a round cannot mint
   or burn value on a price move.
4. **One source per fact.** Every money figure derives from the engine round log (`/standings`).
   Two panels that can disagree mean one is wrong — this already caused three different P/L numbers
   for one wallet.

### HTTP API
`/health` `/live` `/float` `/solvency` `/memo` `/standings` `/hall` `/history?id=` `/wallets`
`/round/*`

---

## 4. Provable fairness — read before touching `round.ts`

**The seed must not exist while anyone can still act on it.**

The obvious design draws randomness when the lobby opens. It looks fine — players only see the hash.
It is not fine: the *engine* then knows the outcome while entries are still open. "Provably fair"
cannot rest on the operator declining to use knowledge it holds.

So:
- **Lobby open:** generate a secret, publish `sha256(secret)`.
- **Lobby close:** derive `seed = sha256(secret | canonical(entries))`, then simulate.

Until entries lock, the seed exists for nobody. The moment it exists, nobody can act on the round.

Verification is two links, both checkable by a stranger:
```
sha256(secret)  == the commit published before deploys opened
seed            == sha256(secret | canonical(entries))
```

**`canonical()` is load-bearing** — sorted, fixed field order, stake to 8dp. Without it, map
iteration order or a float's tail decides whether verification passes, which is the same as it not
verifying. `web/index.html`'s `deriveSeedJS` mirrors the engine and **must stay byte-identical**;
`engine/src/tests/derive-parity.test.ts` reads the shipped implementation out of the page and
compares. If they ever drift, every honest round reports "MISMATCH", which reads as the operator
being caught cheating — worse than having no verifier.

---

## 5. Economics

| | |
|---|---|
| Deploy fee | 0.2% |
| Convert fee | 0.3% |
| Matched book | slightly favours smaller positions (deliberate) |
| Float | ~$115 across 20 real pool wallets |
| Fighters | synthetic ledger ids (`arena:bot:N`), **not** wallets |

**Two pots that must never mix.** The **pool wallets** are the operator's own capital, entered as a
participant and at risk like anyone else's. The **treasury** is fee income. If fees could fund
fighters, the operator would be playing with money taken from players and keeping the winnings.
`poolAccounts()` only ever returns configured pool ids and the treasury is not among them; pinned by
`engine/src/tests/treasury-wall.test.ts`.

**The float does not need topping up — it circulates.** A round is zero-sum plus the fee, so what
one fighter loses another holds. A fighter short of one token plays the side it *can* afford; side
is a free per-round choice, not an identity. Refilling a wallet from a reservoir is the most obvious
tell that it is not a person, so it is not done.

---

## 6. Running it

```bash
cd engine && npm install
npm test                     # ~340 tests, ~4s
npm start                    # needs env — see MIGRATION.md
```

Deploy (from the repo root):
```bash
fly deploy . --config engine/fly.toml --dockerfile engine/Dockerfile --ha=false --app bulls-arena-engine
```

**Check which branch you are on first.** See §9.

---

## 7. Rules for changing this system

1. **Verify against the live system, not against your reasoning.** Almost every bug found here was
   found by measuring. Several confident diagnoses were wrong.
2. **Never measure within ~2 minutes of a deploy.** Every deploy restarts the engine, resetting
   per-boot counters and disturbing the ledger/chain reconciliation window. Measuring in that trough
   produced three separate false alarms, including a "$28 loss" that did not exist.
3. **Run the tests.** `engine/src/tests/` — ~340 of them, 4 seconds. Client-side static checks live
   in `client.test.ts`; they catch missing-element and TDZ bugs that a syntax check does not.
4. **A figure with no backing shows `—`, never `0`.** Zero is a claim.
5. **A ratio is only worth showing when its denominator is stable.** "3541% backed" was arithmetic-
   ally correct and useless; it moved 4x in an hour because player liability is tiny next to the
   float. Show the fact, not the derived number.
6. **Do not spend the operator's money.** Converts, swaps and transfers are theirs to authorise.

---

## 8. Known open items

| Item | Status |
|---|---|
| `roundN.ts` (3-way, FFA) still draws its seed at lobby open | **Real weakness.** Fix before those modes take real money. 2-team is fixed. |
| BLK-2 canary | One real mainnet convert (SOL→UWU) reconciled exactly. UWU→SOL never run. `engine/mainnet-canary.mjs` (dry-run by default). |
| UI redesign | `UI-REDESIGN-BRIEF.md` — Parts 0–5 largely shipped; Part 4 Bands B/C and floating panels done, dashboard polish remains. |
| Ledger drift | ~$1.3–1.8 per 5-min cycle, always chain-ahead-of-ledger (safe direction), consistent with rounding. Auto-corrected since the deadband went $5 → $1. |
| `main` is 8 commits behind | All recent production work sits on `magicblock-er-migration`. See §9. |

---

## 9. ⚠ The branch situation — read this before deploying

There are **two workstreams in one repo**:

- **The mainnet product** (this document).
- **A MagicBlock "ephemeral rollup" migration** — `er-*.ts`, `programs/`, `ER_*.md`,
  `MAGICBLOCK_RESEARCH.md`. **Devnet only, by construction.**

They collided once and took production down. The fork carries `engine/src/devnet-guard.ts`, a
mainnet kill switch. When those commits reached the branch being deployed, the mainnet app called it
at boot, threw, and restart-looped until the machine gave up.

Two of its three hooks failed **silently**, which was worse:
- `memo.ts` gated anchoring on `isDevnetUrl(RPC)` — false on mainnet, so on-chain anchoring switched
  itself off with no error and no log line.
- `swap.ts` would have refused real converts.

All three are severed, and `engine/src/tests/no-fork-coupling.test.ts` fails if any returns. The
fork's own `devnet-guard.ts` is untouched — it is correct *for the fork*.

**Current state:** `HEAD` is `magicblock-er-migration`, 8 commits ahead of `main`, and production has
been deployed from it. `main` lacks the fork severance and the client tests.

**Recommended:** cherry-pick the production work onto `main`, deploy only from `main`, and keep the
fork on its own branch. Until then, check `git branch --show-current` before every deploy.

`er-sim.test.ts` is green (18/18) — the fork's own mirror, including the parity properties from the
commit *"a bug the mirror caught"*. As of 2026-08-09 the on-chain program also compiles and has its
own native `cargo test` proving the compiled Rust and the TS mirror produce byte-identical output for
the same seed/entries — see `MEGA_QUEUE.md` for current fork status, which moves faster than this
document. Production imports none of the fork's code either way. To run the production suite only:
```bash
node --experimental-strip-types --test $(ls engine/src/tests/*.test.ts | grep -v "er-")
```

---

## 10. Future plans

**Near term**
- Resume from pause; validate lobby scaling with real players.
- Finish the UI redesign (`UI-REDESIGN-BRIEF.md`).
- Fix `roundN.ts` seed timing so 3-way/FFA can take real money.
- Complete BLK-2 with a UWU→SOL convert.

**Medium**
- Onboarding that does not assume Solana fluency.
- More arenas; partner tokens (`ARENAS.md`).
- Referral programme (built, `?ref=`, 10% of house fee).

**Longer / speculative**
- **MagicBlock ephemeral rollups** — move round execution on-chain so fairness is enforced rather
  than asserted. `ER_MIGRATION_PLAN.md`, `ER_DESIGN_DECISIONS.md`. Devnet only today.
- Mobile.
- Hosting move if Fly becomes limiting (`HOSTING.md`).

---

## 11. Other documents

| File | What it holds |
|---|---|
| `MIGRATION.md` | **Machine setup and migration. Start here on new hardware.** |
| `README.md` | Short overview |
| `UI-REDESIGN-BRIEF.md` | Front-end rebuild brief, written from the live build |
| `MEGA_QUEUE.md` | Work queue with resolutions |
| `EXECUTION_REPORT.md` | Autonomous-run report |
| `DEPLOY.md` `PRODUCTION.md` `MAINNET.md` `GO-LIVE.md` `HOSTING.md` | Operational runbooks |
| `ARENAS.md` | Arena/token configuration |
| `DEVLOG.md` `DEVLIST.md` `QUEUE.md` | History and backlog |
| `ER_*.md` `MAGICBLOCK_RESEARCH.md` `HACKATHON_ANGLE.md` | Fork workstream |
