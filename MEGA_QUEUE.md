# MEGA QUEUE — MagicBlock ER migration (DEVNET ONLY)

Branch `magicblock-er-migration`. Plan: `ER_MIGRATION_PLAN.md`. Research: `MAGICBLOCK_RESEARCH.md`.
Hackathon pivot: `HACKATHON_ANGLE.md`. VRF/eSPL/PER recommendation: `ER_DESIGN_DECISIONS.md`.

Status: `PENDING` · `IN_PROGRESS` · `DONE` · `BLOCKED` · `PARKED` (needs a decision, not more work)

**Rewritten 2026-08-09.** The previous version of this doc had Tier 2–5 marked `PENDING` after they
had actually shipped — the queue stopped being updated as work landed on the Windows machine, and a
later session nearly re-did work believing it was still blocked. Status below is re-verified against
the current code and git history, not carried forward from memory.

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

## Tier 4 — Client · **PENDING — not started**

### ER-040 · Engine as ER client · **PENDING**
`@magicblock-labs/ephemeral-rollups-sdk@0.16.2`, router `https://devnet-router.magicblock.app`.
Routing follows account ownership, not configuration. Confirmed not started: no reference to the
router or the SDK anywhere in `engine/src/server.ts` as of this doc.
**Accept:** the engine drives a round through the ER instead of mutating JS objects.
**Note:** given ER-031's architecture change, what the engine actually needs to drive is `enter` +
real-time `extract` handling + a single `resolve` call timed to end the round — not a tick loop.
Scope this against the current program, not the original tick-based plan.

### ER-041 · Settlement reads the committed account · **PENDING**
**Accept:** the ledger credits from committed on-chain state; `GetCommitmentSignature` replaces
`markAnchored`.

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

### Private ER (TEE) · **REJECTED, not parked**
`ER_DESIGN_DECISIONS.md`: a TEE-shielded rollup contradicts the product's entire trust proposition
("every round is recomputable in your browser from that seed"). Not reconsidered.

---

## Blocked summary

| ID | Blocked on | Needs |
|---|---|---|
| ER-040/041 | Not started | engine integration work, scoped against the current `enter`+`extract`+`resolve` shape, not the original tick-based plan |
| Per-exchange VRF, eATA | Design decisions, not blockers | explicit sign-off before implementation |

Nothing else is blocked as of 2026-08-09 — the toolchain, the compile, the payer funding, and the
redeploy all resolved this session.
