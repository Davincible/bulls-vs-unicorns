# MEGA QUEUE — MagicBlock ER migration (DEVNET ONLY)

Branch `magicblock-er-migration`. Plan: `ER_MIGRATION_PLAN.md`. Research: `MAGICBLOCK_RESEARCH.md`.
Hackathon pivot: `HACKATHON_ANGLE.md`. VRF/eSPL/PER recommendation: `ER_DESIGN_DECISIONS.md`.

Status: `PENDING` · `IN_PROGRESS` · `DONE` · `BLOCKED` · `PARKED` (needs a decision, not more work)

**Rewritten 2026-08-09.** The previous version of this doc had Tier 2–5 marked `PENDING` after they
had actually shipped — the queue stopped being updated as work landed on the Windows machine, and a
later session nearly re-did work believing it was still blocked. Status below is re-verified against
the current code and git history, not carried forward from memory.

---

## Tier -1 — Independent security review (2026-08-09) · **4 blocking findings, all fixed**

Full adversarial review of `lib.rs`, `er-sim.ts`, `devnet-guard.ts`, `deploy-devnet.mjs` — run
BEFORE any client integration work, which is exactly what caught these before a canary script would
have hit them at runtime instead.

1. **VRF callback could never reach `round`.** `close_lobby_and_draw` requested randomness with
   `accounts_metas: None`, so the oracle's callback into `callback_seed` never carried the `round`
   account — every round would sit in `Phase::Drawing` forever with no way out. This was live on
   devnet from ER-060's original deploy through this fix; the VRF round-trip had never actually been
   exercised end-to-end. **Fixed:** pass `round` explicitly as a writable, non-signer callback account.
2. **`delegate_round` had no authority check.** Any signer could delegate any open round to a
   validator of their own choosing via `remaining_accounts` — and once delegated, only that validator
   can write the round for the rest of its life. **Fixed:** `has_one = authority` on `arena`,
   mirroring `open_round`.
3. **`resolve`'s `steps` was a free caller-supplied argument.** By the time it's callable the seed is
   already public, and the fight is a pure function of `(seed, entries, steps)` — so anyone could
   simulate all ~20,000 stopping points off-chain, pick whichever favoured them, and race to submit
   it. This was the sharper finding: authority-gating alone would only have moved the same grinding
   attack to whoever holds authority, which is exactly the actor "provably fair" is supposed to not
   require trusting. **Fixed:** `steps` is no longer an argument. It's derived from real elapsed
   on-chain time since `Phase::Fight` began (new `Round.fight_started_at`, stamped in
   `callback_seed`), capped at `MAX_STEPS` (originally 7,000, under ER-030's measured ~7,293-step
   ceiling — **that number turned out wrong in practice, see task #15 below**) with a
   `MIN_FIGHT_SECONDS` floor (5s) so `extract()` always gets a real window before anyone can force
   early settlement. `resolve` stays permissionless — there's nothing left to choose.
4. **`devnet-guard.ts` only trimmed string ENDS.** An embedded tab/CR/LF (`api.mai\tnnet-beta...`)
   defeated the `MAINNET` regex literal match while still passing `SAFE`, yet the real URL parser
   (`fetch`/`Connection`) strips those characters anywhere in the string before resolving the
   hostname — so the guard could be bypassed by a string that resolves to real mainnet once anything
   actually connects to it. **Fixed:** strip the same character classes the URL parser would, before
   matching either list.

Also fixed while in the area (MEDIUM/LOW, non-blocking but worth having done): stale commit-reveal
comments describing a `settle` function that no longer exists; dead `SeedMismatch` error variant;
`gen-parity-fixture.mjs` — referenced by the ER-051 test's own comment but never actually committed —
now checked in at `programs/bulls-arena/gen-parity-fixture.mjs`; orphaned `Tick` context struct
(dead code from the pre-ER-030/031 design); `bench_fight` gated behind a `bench` Cargo feature so the
CU-measurement probe doesn't ship in the deployed binary by default; stale `BadStepCount` error text.

**Redeployed** to the existing devnet program (same ID, upgrade): slot 482276211, sig
`NDV9uRtu8cC5mMCoF26FAjiwuFYFprnraQ5afkhTgWcV4od2JGZ9gYmcMqRRRD7rjiw57NGdCjC7LntevGjLznS`. The IDL
(`programs/bulls-arena/idl/`) was regenerated to match — `resolve` and `close_round` now take no
arguments, `delegate_round`'s signer account is named `authority` not `payer`.

---

### Task #15 · `MAX_STEPS=7,000` had zero real margin — found by Phase 5, fixed and reverified (2026-08-09)

Phase 5's verification work left a round open past the ~40s design window; `resolve()` at
steps=7,000 failed with "1,399,850 of 1,399,850 CUs consumed, exceeded CUs meter" (devnet round #9,
now permanently stuck — left as-is, historical evidence). Root cause: ER-030's 187.4 CU/step was
measured against an OLDER `resolve`, and `bench_fight` (the measurement tool itself) had quietly
drifted from `run_fight` by the time this session's security fixes landed — one cheap check standing
in for three real ones, missing a 32-byte Pubkey compare `run_fight` always pays. Worse: since
`STEPS_PER_SECOND(175) × 40s = 7,000 = MAX_STEPS` exactly, this wasn't an edge case — *any* round
resolved at or after its normal ~40s design duration already called `resolve` at steps=7,000, so the
bug was latent in the common path, not just a "left it open too long" outlier.

**Fix:** `bench_fight` now calls `run_fight` directly (same function `resolve` calls — cannot drift
again). Re-measured on a local `solana-test-validator` (CU accounting is deterministic on bytecode +
inputs, not cluster-specific, so this is as real as devnet without spending devnet SOL): the loop
alone crosses 1.4M CU between 6,800 steps (1,389,142 CU) and 6,900 (over) — confirming the reported
failure was real. New `MAX_STEPS = 4,000` (864,996 CU for the loop alone, 61.8% of the ceiling,
535,004 CU / 38.2% headroom for `resolve`'s uncounted overhead — account exit/serialise, guards,
event, commit CPI — none of which is precisely measured; see the constant's own comment in `lib.rs`
for the full reasoning). Cap now reached at ~22.9s instead of 40s; does not shrink `extract()`'s real
window, which is bounded by when `resolve` is actually called, not by `MAX_STEPS`.

**Redeployed** (same program ID, upgrade): slot 482314306, sig
`2cEJ5TzFhYdiYHK4eqhAKW42cFCTFZLaMMAXRtbPnMswJCBbJBnspnsyyRKsqwGKD1UYAzJB8RjEdU8jg8QTeyAP`.

**Infra finding, worth knowing for any future redeploy:** the default ER validator this project's
scripts land on (`devnet-as.magicblock.app`) was still running the PRE-fix bytecode ~3 minutes after
the upgrade landed and confirmed on the base layer — resolve() there reproduced the *exact* original
failure ("1,399,850 of 1,399,850") despite the new `MAX_STEPS`. MagicBlock's ephemeral validators
clone a program's executable bytecode into their own local `LoaderV4`-owned account on first use and
don't appear to re-clone it on a base-layer upgrade — plausibly because a `BPFLoaderUpgradeable`
program's own `Program` account never changes on upgrade (only its separate `ProgramData` account
does), so a naive subscription on the invoked program id would never observe the change. Confirmed by
reading `unitsConsumed`/logs directly from a `simulateTransaction` against the ER endpoint.
**Workaround that worked:** `delegate_round`'s `DelegateConfig.validator` (passed via
`remaining_accounts[0]`) can pin a *specific* ER validator instead of taking the router's default —
pinning `devnet-us.magicblock.app` (identity `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd`) on a fresh
round got a clean clone of the current bytecode. **Regression-verified for real** this way: round
#13, waited 93.7s past `Fight` start (past both the old 40s and new ~23s cutoff), `resolve` succeeded
with `tick_count=4000` (steps correctly saturated at the new cap) — sig
`2BqJg5RvEBeVc4pmyVh3J5TFWvydTdDYB5Av72fkQhG4TXNm36voubemxNLbnEHkgjLmD6jcBca6ewUyQUZPnUaZ`. Round
settled correctly (winner side 0, pot conserved). If a future session redeploys again, expect the
*default* router-chosen validator to serve stale bytecode until its own cache turns over — pin a
specific validator (or a fresh one) to verify a fix against the real ER, the same as here.

`cargo +1.89 test` still green (`run_fight_matches_the_typescript_mirror_exactly`, `test_id`) —
`MAX_STEPS` isn't exercised by that fixture, confirmed rather than assumed.

---

## Tier 0 — Safety

### ER-000 · Mainnet kill switch · **DONE**
Allowlist-based devnet guard, fails closed. Real Jupiter swaps, mainnet anchoring and the production
Fly target disabled at source. `VAULT_SECRET` in env refused on presence.
**Accept:** mainnet RPC refused at boot; unknown host refused; secrets redacted. 10 tests. ✅

### ER-001 · Research grounding · **DONE**
`MAGICBLOCK_RESEARCH.md`, verified against registries and reference source, not doc prose.
**Accept:** exact versions, endpoints, program IDs, API shapes, cited. ✅

---

## Tier 1 — Foundation

### ER-010 · Toolchain · **DONE — solved twice, on two different machines**

**Windows** (original): unblocked without admin via MinGW+LLVM → `xwin splat` for MSVC import libs
→ `lld-link` standing in for `link.exe` → libraries supplied via `LIB` (not `RUSTFLAGS`, which
`cargo-build-sbf` overrides). Full account kept below for the record.

**macOS** (this machine, migrated 2026-08-08 per `MIGRATION.md`): a *different* local build broke,
for a *different* local reason — worth naming because it looks like the same class of problem and
is not:
- `cargo build-sbf` needs the full Anza/Solana release (not the Homebrew `solana` formula, which
  omits it): `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`.
- Host-side proc-macro crates (`anchor-attribute-*` etc.) failed to link with `ld: library not found
  for -liconv`. Cause: this machine runs Nix, and `/run/current-system/sw/bin/cc` shadows Apple's
  `cc` on `PATH` — a Nix-wrapped compiler that doesn't know about the Xcode SDK's stub libraries.
  Fix: put `/usr/bin` ahead of it on `PATH` for the build (`export
  PATH="$SOLANA_BIN_DIR:/usr/bin:$PATH"`), not a systemwide `xcode-select` change.
- Host `cargo test` (as opposed to `cargo build-sbf`, which pins its own sbf-target toolchain)
  needs rustc ≥1.89; the ambient default here is 1.85. Scoped with `cargo +1.89 test`, not a global
  `rustup default` change.

None of this is a real blocker on a normal Unix machine with Xcode CLT and rustup — it is PATH
precedence, not a missing SDK. Recorded so the next session doesn't re-diagnose it from scratch.

**Built (2026-08-09):** `target/deploy/bulls_arena.so`, 289,392 bytes. First successful compile on
this machine; the program had never been compiled here before this session.
**Native `cargo test` also runs** on this machine (see ER-051) — something the Windows machine could
never do at all, since nothing there could compile as a normal Rust crate outside the SBF pipeline.
**Redeployed to the existing devnet program** (upgrade, same ID — `.devnet/program-keypair.json`
restored into `target/deploy/` first, since `cargo build-sbf` auto-generates a throwaway keypair
when none exists there): `F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW`, slot 482254605, sig
`xmiZZK9bwFpRtPPjxSfQcr7TCmrDgR2EKaCj5E4WWjqVzZEVjS4nSZQf4CFz92vfSoJrggi4G92xnv6HaLUrzaK`. Confirmed
via `solana confirm` and `solana program show` (new slot, new data length). This is the build
carrying `extract()`, single-instruction `resolve()`, and VRF-drawn seeds — the current on-chain
state now matches the current source, for the first time on this machine.

<details><summary>ER-010-OLD — the Windows chain, kept for the record</summary>

Solved after the sixth approach:
1. MinGW + LLVM via `winget --scope user` (no admin) gave a GNU host linker.
2. That broke the circularity on `xwin`: it needs a host linker to install, and installing it under
   the GNU toolchain worked where msvc could not.
3. `xwin splat` fetched the MSVC CRT + Windows SDK **import libraries** without admin. Its header
   splat fails without symlink privilege — and it turns out headers are not needed, because rustc
   links, it does not compile C.
4. `lld-link` (from the same LLVM package) stands in for the absent MSVC `link.exe`.
5. The libraries are supplied via the **`LIB` env var**, not `rustflags`: `cargo-build-sbf` sets
   `RUSTFLAGS` itself and env RUSTFLAGS overrides anything in `.cargo/config.toml`. `lld-link` reads
   `LIB` exactly as MSVC's linker does.

Built there: `target/deploy/bulls_arena.so`, 331,536 bytes. Deployed to devnet
`BWhnLnryRJpLbRkpybSQvpr68HfnNDsZha7kgouJJ8Dc`, sig
`4G1vJwvoNfYHcdcCWbSpVkhx9LmGTJHHioutPNK2bJEE232cCVWYLiMZuTaqyznaqo9PhyKjetymNXhKUq8PJzK7`.
</details>

### ER-011 · Anchor workspace scaffold · **DONE**
`Cargo.toml` workspace scoped to `programs/bulls-arena` only.
**Deliberately not `programs/*`:** the repo also contains `programs/vault` (Anchor 0.30.1,
dormant — placeholder `declare_id!`, referenced by no engine code). Including it forces one
dependency graph across both, and anchor 0.30.1's solana-program 1.17 pins `zeroize <1.4` while
`ephemeral-rollups-sdk 0.16.2` needs curve25519-dalek 4.x with `zeroize ^1`. Unsatisfiable, and
nothing to do with either program's correctness. Upgrading the vault is separate work.
**Accept:** `cargo metadata` resolves without conflict; `cargo build-sbf` produces a `.so`. ✅

### ER-012 · Devnet keypair + funding · **DONE**
Fork payer `9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj`, gitignored. CLI faucet (`solana airdrop`,
all amounts from 2 down to 0.1 SOL) was rate-limited this session — the same class of block named
repeatedly in this project's history — but topped up via the web faucet (`faucet.solana.com`) to
6.15 SOL, then confirmed by the ER-010/ER-050 redeploy below, which spent ~0.07 SOL net (most of the
buffer rent came back on the successful upgrade). 6.08 SOL remains.

---

## Tier 2 — Program · **DONE**

All of ER-020–025 shipped together in `programs/bulls-arena/src/lib.rs`, deployed to devnet, and
exercised for real — not just written. See commits `a11c6cd`, `8bd8276`, `b591d94`.

### ER-020 · Account layout (`Arena`, `Round`, `Fighter`) · **DONE**
`MAX_FIGHTERS` is **16**, not the originally planned 40: 40 fighters (~2.45 KB) overflowed the 4 KB
BPF stack frame when Anchor's `Account<'info, Round>` deserialised it — a limit distinct from the
10 MiB account-size ceiling, and the one that actually bit. 16 fits in ~937 B and matches what the
live arena fields in practice (10–17/round). Going back above ~24 needs `zero_copy` +
`AccountLoader` to avoid the stack copy entirely.
**Accept:** sizes computed and asserted; `Round` fits in one account at `MAX_FIGHTERS`. ✅

### ER-021 · `init_arena` / `open_round` (base layer) · **DONE**
`open_round` publishes `sha256(seed)` before entries open. Superseded in spirit by ER-060 (VRF): the
seed is no longer chosen by the operator at all, but the commit-reveal envelope on-chain is
unchanged, so this instruction's shape didn't need to change.
**Accept:** round opens on devnet; commit hash readable before any entry. ✅

### ER-022 · `delegate_round` · **DONE — confirmed on devnet**
Commit `8bd8276`: after delegation the round account's owner is verified as
`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` for real, not asserted from reading the SDK docs.
**Accept:** owner check passed on devnet. ✅

### ER-023 · `enter` (ER) · **DONE — confirmed on devnet**
Commit `b591d94`, part of the full-lifecycle run.
**Accept:** a fighter appears in the delegated account, written via the ER. ✅

### ER-024 · `tick` (ER, hot path) · **SUPERSEDED — see ER-030/031**
Originally a `tick(steps)` instruction called ~125 times per round, mirroring the off-chain engine's
real-time animation loop. Replaced entirely: the fight is a pure function of `(seed, entries)`, so
splitting it across 125 round-trips didn't make it more correct, only slower and more expensive. See
`resolve()` under ER-030/031.

### ER-025 · `settle` + `close_round` (commit_and_undelegate) · **DONE — confirmed on devnet**
Commit `b591d94`, "FULL ER LIFECYCLE WORKING ON DEVNET": open → delegate → enter → resolve → settle
→ close_round, base-layer account shows final state, owner reverted.
**Accept:** all of the above, on devnet, with signatures. ✅

---

## Tier 2.5 — extract() and the hackathon pivot · **DONE**

Not in the original plan. `HACKATHON_ANGLE.md` (commit `be66394`) found that a single-transaction
`resolve()` proves the ER is *optional* for the fight — a judge's first question is "why does this
need a rollup?" and the honest answer had become "it doesn't."

**Fix:** `extract(ctx)` — a player pulls out mid-fight, banking current `hp` and leaving the ring, so
the fight's outcome now depends on *when* a human presses a button, not only on the seed. This is
what actually makes the ER load-bearing: state mutates from many wallets in real time, and at
400ms base-layer slots "extract now" is a promise the chain can't keep, while at ~10ms ER slots it
is real.

5 tests including the one that matters: extracting early must be able to be **worse** than holding
on (otherwise it's decoration, not a real decision). Mirrored byte-for-byte in `engine/src/er-sim.ts`
and pinned by the parity test below.

**Design note, resolved:** `HACKATHON_ANGLE.md` proposed re-introducing stepped on-chain ticking so
"extract decisions land between exchanges." That turned out not to be necessary: `resolve()` still
computes the whole fight in one instruction, but only once *called* — and any `extract()` that lands
on-chain in the real-time window between the VRF seed arriving (`Phase::Fight`) and whoever finally
calls `resolve()` is honoured, because extracted fighters are marked `dead` and skipped as both
attacker and defender for the entire fight computation. The mid-fight decision window is real; it
just isn't implemented as discrete steps. What's still unexercised is the *off-chain* side of that
timing — nothing currently drives "wait ~40s before calling resolve()" in practice, because ER-040
(engine as ER client) hasn't been built. The on-chain mechanic is proven; the real-time orchestration
around it is not yet wired to anything.

---

## Tier 3 — ER loop · **DONE (and it changed the architecture)**

### ER-030 · Measure tick cadence on devnet · **DONE**
Commit `9ac82e8`. Measured, not assumed, on devnet program `3dHbeVh7KuhhjXMCkAw34wsZefwwQUdwKY6DJb12LWXb`
(since closed) via a read-only `bench_fight` compute probe:

| steps | CU |
|---|---|
| 500 | 99,475 |
| 1,000 | 195,182 |
| 4,000 | 752,645 |
| 8,000 | over the 1.4M ceiling |

Marginal ~187.4 CU/step, fixed overhead ~3k. One transaction fits ~7,293 steps — comfortably enough
for a full fight among `MAX_FIGHTERS` (16) entrants.

### ER-031 · Batching + commit strategy · **DONE — resolved by architecture change, not batching**
The measurement in ER-030 made batching unnecessary: since one transaction can run the *entire*
fight, `tick(steps)` × ~125 calls was replaced with a single `resolve(steps)` that runs the fight and
settles in one instruction (see ER-024). Per-hit data was also dropped from on-chain storage — every
blow is recomputable from the seed by anyone, so storing them was "publishing our own homework at a
cost per byte." Only inputs (seed, entries) and outcome (winner, final holdings) are recorded.
**Consequence, stated plainly (from the commit):** with one tx per match, the ER is no longer
load-bearing for the fight itself — only for `enter` (16 mutations/round) and now `extract` (Tier
2.5). That's a real architectural finding, not a disappointment.

---

## Tier 3.5 — VRF · **DONE**

### ER-060 · VRF seed — the operator no longer chooses the randomness · **DONE, deployed to devnet**
Commit `58dc133`. Replaced operator-supplied `reveal()` with `close_lobby_and_draw()` +
`callback_seed()`, using MagicBlock's VRF oracle. Closes a real weakness the old commit-reveal left
open: publishing `sha256(seed)` before entries stopped the operator seeing the book and *then*
choosing a seed, but nothing stopped grinding thousands of candidate seeds offline against the
*expected* lobby and committing to the most favourable one — not theoretical with the house fielding
most of the fighters. Now there is no seed to grind; the oracle produces it after the lobby closes,
before anyone (operator included) can act on it.
`#[vrf_callback]` constrains the caller to a PDA scoped to this program specifically
(`scoped_vrf_identity(&crate::ID)`), not the deprecated global identity — declaring that field by
hand would have left the callback spoofable.
**Open, deliberately not done:** per-exchange VRF (redrawing randomness for every hit, not once per
round) — see Tier 6 below. Round-level VRF is what's shipped.

---

## Tier 4 — Client · **ER-040 core lifecycle DONE (2026-08-09) · ER-041 (live engine wiring) still open**

### ER-040 · Client through the Magic Router · **DONE — proven twice on real devnet**
`engine/scripts/er-client-canary.mjs`. The full lifecycle — init_arena → open_round →
delegate_round → enter ×2 (two real signing wallets) → close_lobby_and_draw → **VRF Drawing→Fight**
→ extract (mid-fight) → resolve → close_round → verified back on the base layer — run twice for
real, both clean. This is the first successful exercise of the VRF round-trip end to end; ER-060's
own changelog notes it had never completed before the accounts_metas fix earlier this session.

Run 1 (round #5): `open_round` `66aih9Y…kWjZCa9` · `delegate_round` `2c5wjSX…gCaLdqjU` · `enter` A
`3Lz1T9a…SMgqicn` · `enter` B `2xeTXdM…9od9ZSHg9` · `close_lobby_and_draw` `3Btk4t7…raFv3jv` ·
`extract` A `3E8Tho1…fsPxwhf` · `resolve` `u6vpUNA…VMLFuE` · `close_round` `54GJ8WQ…U33vTz6YZ`.
Final: `phase=Settled, winner=side 0, pot=1,746,500, tick_count=1225`. Player A (extracted before any
hits landed, since hits only compute inside `resolve()`): `hp=0 banked=998,000 dead=1` — exactly net
stake, zero gain/loss, matching the "extracting locks in current value" design. Player B (untouched,
since A's `dead=1` skipped every one of the 1,225 iterations with only 2 fighters in the round):
`hp=748,500 banked=0 dead=0`. `998,000 + 748,500 = 1,746,500 = pot` — conserved exactly. Run 2
(round #6) reproduced identically in shape.

**Five real findings from actually running this, not from reading docs:**
1. **Anchor camelCases the IDL at load time.** `new Program(idl, provider)` runs the raw snake_case
   IDL through `convertIdlToCamelCase` before building the client — every instruction, account key,
   and decoded field comes back camelCase (`open_round`→`openRound`, `fight_started_at`→
   `fightStartedAt`). Not documented anywhere in the IDL JSON itself.
2. **`AnchorProvider.rpc()`/`.sendAndConfirm()` don't route through `ConnectionMagicRouter` at all**
   — they fetch a blockhash via the connection's plain `getLatestBlockhash`, bypassing the router's
   overridden account-aware `sendTransaction`/`getLatestBlockhashForTransaction`. Every `.rpc()` call
   against the router failed with "Blockhash not found." Fix: build with `.transaction()`, drive the
   send path manually.
3. **The generic router refuses `close_lobby_and_draw` outright** — its writable accounts mix `round`
   (ER-delegated) with `oracle_queue` (the VRF singleton, whose delegation record names the System
   Program as authority), which the router can't reconcile and rejects as "accounts delegated to
   different ER nodes." Fix: resolve the round's specific validator via
   `router.getDelegationStatus(round).fqdn` and send that one instruction straight there, bypassing
   the generic router.
4. **`resolve()` needs an explicit compute budget.** Up to 7,000 steps at ~187 CU/step plus
   settlement and the commit CPI comfortably exceeds Solana's ~200,000 CU default. Needs
   `ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000})` as a preInstruction — the 1.4M
   figure the program's own comments already assume, but nothing requests automatically.
5. **Public devnet RPC read-after-write lag** (~1-2s) between the node that processed a transaction
   and the node a later read hits. Poll account state after writes rather than trusting a single read
   immediately after confirmation.

Program itself needed ZERO changes — every result above matches `lib.rs`'s specified behavior
exactly. 364/364 engine tests green before and after (one pre-existing property-test flake in
isolation, confirmed unrelated on retry).

**Accept:** the engine drives a round through the ER instead of mutating JS objects. ✅ — proven via
a standalone script; wiring this into `server.ts`'s live round runner (replacing the in-memory
lobby/battle loop with real on-chain calls, for real players) is ER-041, still open.

### ER-041 · Wire the live engine to the ER (not just a proof script) · **PENDING**
`er-client-canary.mjs` proves the mechanics work; nothing in `engine/src/server.ts`/`round.ts` calls
any of this yet. Turning the canary's sequence into the actual round runner means: replacing
`roundN.ts`'s in-memory phase machine with calls through this same client, deciding who calls
`resolve()` and when (the canary waits a fixed buffer past `MIN_FIGHT_SECONDS`; the live engine needs
a real policy — likely "resolve at the same ~40s the off-chain game already uses"), wiring
`extract`'s player-signed transaction into the browser (a NEW client capability — today `web/
index.html` sends websocket messages, not signed on-chain transactions, for the deploy action), and
crediting the off-chain ledger from the committed `Round` account rather than in-memory state.
**Accept:** a live round, played by a real connected wallet (not the canary's throwaway keypairs),
settles through the ER with the ledger crediting from committed on-chain state.

---

## Tier 5 — End-to-end · **DONE**

### ER-050 · Delegation round-trip on devnet · **DONE**
Commit `705e981` (found a stack overflow the tests could not — the ER-020 `MAX_FIGHTERS` story),
completed in `8bd8276`/`b591d94`: open → delegate → enter → resolve → settle → close_round, with
signatures, on devnet.

### ER-051 · Parity: Rust program vs TS sim · **DONE (2026-08-09) — closed properly, not asserted**
Previously the single biggest named residual risk (`EXECUTION_REPORT.md`: "Parity is one-sided...
asserted to be identical by reading, which is the weakest form of assurance"). That is no longer
true: the fight loop was extracted into a pure `run_fight(fighters, n, seed, steps)` — no `Context`,
no account borrow — called by `resolve()` on-chain AND by a native `cargo +1.89 test` on this
machine. The test constructs the same seed and entries as a fixture generated by actually *running*
`engine/src/er-sim.ts` (not hand-derived), and asserts byte-identical `hp`/`banked`/`dead`/`winner`.
Both pass. This is the first time the compiled Rust and the TS mirror have been run against each
other rather than read side-by-side.
**Accept:** identical winner and per-fighter payouts across both implementations, verified by
execution. ✅

---

## Tier 6 — Parked (real decisions, not more engineering)

These are named explicitly in `HACKATHON_ANGLE.md` / `ER_DESIGN_DECISIONS.md` as things to be
deliberate about rather than drift into. Not attempted without a decision first.

### Per-exchange VRF · **PARKED**
`HACKATHON_ANGLE.md`'s stated reason for VRF: a player who can read the revealed round seed can, in
principle, compute the entire deterministic hit sequence in advance and pick the mathematically
optimal extraction moment — round-level VRF (ER-060) doesn't stop this on its own. The proposed fix
(redraw randomness *per exchange*, not per round) directly conflicts with ER-030/031's finding that a
single cheap `resolve()` transaction is what makes the fight affordable at all: an oracle round-trip
per hit reintroduces the exact latency and cost problem the batch design just solved. Needs a real
design decision (e.g. a hybrid — VRF the *step ordering* rather than every roll) before implementation,
not a quick patch.

### Ephemeral SPL (eATA) for balances · **PARKED**
Would make "raids TAKE the enemy's coin" an actual token transfer instead of a struct field. Explicitly
the one to be slow about: it changes *custody* — today the risk is this program's own devnet vault;
with eATAs it becomes MagicBlock's shared per-mint Global Vault. `ER_DESIGN_DECISIONS.md`: "worth
deciding deliberately rather than drifting into." Devnet-only either way; not a mainnet question yet
because this fork cannot reach mainnet by construction (ER-000).

### Session Keys for `enter`/`extract` · **DONE (2026-08-09) — shipped on both instructions**

> **This entry's original "PARKED" verdict was overtaken the same day.** Kept below, unedited, as the
> record of what was actually known at decision time — both of its "concrete blockers" turned out to
> be answerable rather than blocking, and the note on `session_auth_or`'s ownership check "not being a
> drop-in given that shape" was correct and is exactly what the `player`/`signer` split resolves.
>
> **What shipped:** `#[derive(Accounts, Session)]` + `#[session_auth_or(...)]` on BOTH `enter` and
> `extract` in the real program, with `player` (the credited fighter identity, now `UncheckedAccount`)
> split from `signer` (whoever actually signed — the session key, or the player's own wallet when no
> session is active) and an `Option<Account<SessionToken>>`. The no-session path is byte-for-byte
> unchanged: with no token, the guard's fallback requires `signer == player`. Client side:
> `er-demo/src/chain/session/useSessionKeyManager.ts` (the only file importing `gum-react-sdk`,
> enforcing the anchor-version boundary by import location) + `ui/SessionButton.tsx`.
>
> **How the two "blockers" resolved:** (1) the React-only client SDK stopped being a blocker once the
> demo became its own React app (`er-demo/`), which is *why* React was adopted; (2) the untested
> ER-delegation combination was answered by building it — Phase 0's spike proved it works against a
> throwaway program first (commit `e3fb149`), with a negative control, before the real program was
> touched. That sequencing is what made this safe to ship rather than a gamble.
>
> **What is PROVEN, and what is not — the distinction matters more than a green tick.**
> `er-demo/scripts/verify-session-base.mjs` proves **8 authorization properties** against the real
> deployed bytecode (sha256-matched to `target/deploy/bulls_arena.so`), with real signatures, for BOTH
> `enter` and `extract`: a session key may sign on the player's behalf and **the player is what gets
> credited** (session key absent from `Round.fighters`, side and net-of-fee stake asserted); a forged
> signer is rejected with or without a token; **an attacker's own valid token aimed at someone else's
> fighter is rejected**; a token scoped to a different `target_program` is rejected; an expired token
> is rejected even when presented by its own real session key; and with no token at all,
> `signer == player` is still required and still works (the unmodified pre-Phase-6 path).
>
> That third one nearly slipped through. Every negative control originally varied the *signer* and
> held `player` fixed — so they only ever exercised the `session_signer` seed, and the
> `authority`↔`player` binding had **zero coverage**. Under a regression there, anyone holding any
> valid session could **force-extract any live fighter mid-fight**, banking their hp and pulling them
> from the ring — directly moving the round's outcome — and every existing assertion would still have
> passed. It is now a permanent test, not an ad-hoc check.
>
> **NOW ALSO PROVEN (`er-demo/scripts/verify-session-extract.mjs`, round #6):** a session-signed
> `extract()` **landing in real Fight phase**, on a real ER validator, after a real VRF callback —
> sig `3MiotyrGHQAjERfyKqC3v49Mqd127HuM4pBv3fBKBP4ode8Gv9X5mCoTbifqRywK8hQVFcvDpQHGDVpjHHdgSCak`.
> `hp 499000 -> banked 499000, dead=1`, asserted exactly. Player A's wallet signed **once**
> (`create_session`) and never signed the extract itself — which is the entire point of the feature.
> Unblocked by the v2 program id (see below); it had been blocked purely by MagicBlock's stale
> validator caches, never by anything in this code.
>
> **One real bug this shook out, worth remembering:** `anchor-lang = "1.0.2"` (Cargo's default caret
> range) silently resolved to **1.1.2**, whose `anchor-syn` migration from syn 1.x to syn 2.0 broke
> `#[derive(Accounts, Session)]` + `#[session(...)]` **with no compile error at all** — it only
> surfaced on real devnet as `AnchorError ... account: player. Error Code: AccountNotSigner`, on an
> `UncheckedAccount` field whose expanded code contains no path that could produce it. Now pinned
> `anchor-lang = "=1.0.2"` (exact), matching every other toolchain pin in this repo. A silent
> dependency drift breaking a security-relevant macro is precisely the class of failure that only
> real on-chain verification catches — a green local build proved nothing here.

Real and directly relevant: `enter`/`extract` both require the player's own wallet (`Signer<'info>`),
and `extract` needs to be pressable mid-fight without a Phantom popup per press. Researched properly
before touching the program again, given this session already found and fixed 4 real bugs in it.

**The mechanism** (`github.com/magicblock-labs/session-keys`, crates.io `session-keys` v3.1.1, MIT):
compiled directly into our program, not a CPI — `#[derive(Session)]` on the Accounts struct,
`#[session_auth_or(...)]` wrapping the instruction, a `SessionToken` PDA (minted by a *separate*
`create_session` instruction the client submits directly to the session-keys program, seeds
`[SEED_PREFIX, target_program, session_signer, authority]`).

**Two concrete blockers, not just "needs care":**
1. **No non-React client SDK confirmed.** The only real published client package is
   `@magicblock-labs/gum-react-sdk` (React-specific). `web/index.html` is vanilla JS with a stated
   no-build-step constraint — adopting this means either taking on React or hand-rolling the
   client-side session flow without their SDK, which is a materially bigger scope than "add a
   library."
2. **Untested combination with ER delegation.** `SessionToken` lives on the BASE layer; `Round` is
   delegated to the ER when `enter`/`extract` run. No evidence anywhere (their own test suite, issue
   trackers on either repo) that anyone has combined Session Keys with ephemeral-rollups-sdk
   delegation — this fork would be the first integration test of that combination, not a known-good
   pattern.

Also: `Enter`/`Extract`'s current design keys fighters by wallet lookup inside the account array, not
a separate "authority" field — `session_auth_or`'s ownership check isn't a drop-in given that shape.
And an open upstream issue (`session-keys#1`) flags incomplete interop with some Anchor signer
constraint shapes — likely doesn't block us (we use plain `Signer<'info>`), but signals the library's
Anchor-constraint testing isn't exhaustive.

**Verdict:** prototype `#[session_auth_or]` on `extract` alone, in isolation, before touching `enter`
— and budget a real review pass before redeploying, same rigor as this session's fixes, not less.
Not attempted this session; parked with this research so a future pass starts grounded, not guessing.

### Private ER (TEE) · **REJECTED, not parked**
`ER_DESIGN_DECISIONS.md`: a TEE-shielded rollup contradicts the product's entire trust proposition
("every round is recomputable in your browser from that seed"). Not reconsidered.

---

## Blocked summary

| ID | Blocked on | Needs |
|---|---|---|
| ER-041 | Not started | wire the proven client sequence (`er-client-canary.mjs`) into `server.ts`'s live round runner and the browser's signing flow |
| Per-exchange VRF, eATA, Session Keys | Design decisions, not blockers | explicit sign-off before implementation — see Tier 6 |

Nothing else is blocked as of 2026-08-09 — the toolchain, the compile, the payer funding, and the
redeploy all resolved this session.
