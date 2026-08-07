# MEGA QUEUE — MagicBlock ER migration (DEVNET ONLY)

Branch `magicblock-er-migration`. Plan: `ER_MIGRATION_PLAN.md`. Research: `MAGICBLOCK_RESEARCH.md`.

Status: `PENDING` · `IN_PROGRESS` · `DONE` · `BLOCKED`

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

### ER-010 · Toolchain · **DONE — UNBLOCKED without admin**

Solved after the sixth approach. The chain that worked, because none of it is obvious:

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

**Built:** `target/deploy/bulls_arena.so`, 331,536 bytes.
**Deployed to devnet:** `BWhnLnryRJpLbRkpybSQvpr68HfnNDsZha7kgouJJ8Dc`
sig `4G1vJwvoNfYHcdcCWbSpVkhx9LmGTJHHioutPNK2bJEE232cCVWYLiMZuTaqyznaqo9PhyKjetymNXhKUq8PJzK7`
**Verified:** executable, owner BPFLoaderUpgradeab1e, on genesis `EtWTRAB…` (devnet); and
`AccountNotFound` on mainnet.

### ER-010-OLD · what had been tried (kept for the record)
**What works:** Solana CLI 4.1.2 installed (extracted from the official installer; its final symlink
step needs admin, so the binaries are used from
`~/.local/share/solana/install/releases/4.1.2/solana-release/bin`). Configured to devnet.
`cargo-build-sbf 4.1.0` / platform-tools v1.54 present. Rust 1.97.1.

**What is blocked:** compiling *any* Rust program. Not the SBF target — the **host** build scripts
(`proc-macro2`, `serde`, `borsh`, `syn`) which must link a native Windows binary.

**Tried, in order:**
1. `cargo install anchor-cli 1.0.2` → failed: Git Bash's GNU coreutils `link` shadows MSVC
   `link.exe`, giving `link: extra operand`. A PATH problem, not a code problem.
2. Ran from PowerShell so GNU `link` is absent → no linker at all: **MSVC is not installed** and
   there is no `link.exe` on the machine.
3. `winget install BrechtSanders.WinLibs.POSIX.UCRT.LLVM --scope user` → succeeded without admin;
   gcc 14.2.0 + full LLVM now available.
4. `rustup default stable-x86_64-pc-windows-gnu` → the GNU host would link fine, but
   `cargo-build-sbf` pins its own toolchain `1.89.0-sbpf-solana-v1.54`, which is **msvc-hosted**, and
   that overrides the rustup default. Host build scripts still resolve the msvc sysroot.
5. Shimmed `link.exe` → `lld-link.exe` (MSVC-compatible, from the LLVM package), placed first on
   PATH. **This worked** — the linker now runs and the error advanced to:
   `lld-link: could not open 'kernel32.lib'`.
6. Hunted the Windows SDK: no `kernel32.lib` anywhere on the machine; `C:\Program Files (x86)\
   Windows Kits` does not exist. MinGW ships GNU-format `libkernel32.a`, which `lld-link` cannot
   consume in MSVC mode.

**Exactly what is needed to unblock — any ONE of:**
- **Visual Studio Build Tools** with the Windows 10/11 SDK (needs admin), or
- the standalone **Windows SDK** (needs admin), or
- an **sbf toolchain with a GNU host**, which MagicBlock/Anza do not currently ship, or
- `cargo install xwin` to fetch the MSVC CRT/SDK headers without admin — itself blocked, because
  installing it requires the very host linker that is missing (circular).

**Consequence, stated plainly:** nothing can be compiled or deployed to devnet from this machine.
Every item below that requires a built `.so` is therefore blocked *on this environment*, not on the
code. Items are still implemented in full so they are reviewable and buildable elsewhere; they are
marked `DONE (unbuilt)` where the source is complete but has never been compiled. I am not marking
anything verified that has not run.

### ER-011 · Anchor workspace scaffold · **DONE (unbuilt)**
`Cargo.toml` workspace scoped to `programs/bulls-arena` only.
**Deliberately not `programs/*`:** the repo already contains `programs/vault` (Anchor 0.30.1,
dormant — placeholder `declare_id!`, referenced by no engine code). Including it forces one
dependency graph across both, and anchor 0.30.1's solana-program 1.17 pins `zeroize <1.4` while
`ephemeral-rollups-sdk 0.16.2` needs curve25519-dalek 4.x with `zeroize ^1`. Unsatisfiable, and
nothing to do with either program's correctness. Upgrading the vault is separate work.
**Accept:** `cargo metadata` resolves without conflict. ✅ (resolution verified; compilation blocked by ER-010)

### ER-012 · Devnet keypair + funding · **DONE**
Fork payer `9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj`, gitignored. The public faucet was
rate-limited at 2/1/0.5 SOL, so it was funded from the pre-existing **devnet** vault
`4iDuXiq95uRT74xvGkz4icqnu6ma9qKZmzDuquRZGAFy` (verified NOT the mainnet vault before use).
sigs `4w93mrgq…` and `5bM63wqn…`. Balance 3.18 SOL.
**Accept:** a fork-local keypair under `.devnet/`, never the production vault; funded by devnet
faucet; guard asserts devnet before use.

---

## Tier 2 — Program

### ER-020 · Account layout (`Arena`, `Round`, `Fighter`) · **PENDING**
One `Round` account holding the fighter array — 40 × ~60 B ≈ 2.4 KB, far under the 10 MiB ceiling,
and it keeps the round atomically committable.
**Accept:** sizes computed and asserted; `Round` fits in one account at max fighters.

### ER-021 · `init_arena` / `open_round` (base layer) · **PENDING**
`open_round` publishes `sha256(seed)` before entries open, preserving the existing commit-reveal
scheme on-chain rather than replacing it.
**Accept:** round opens on devnet; commit hash readable before any entry.

### ER-022 · `delegate_round` · **PENDING**
**Accept:** after delegation the account owner is `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`.

### ER-023 · `enter` (ER) · **PENDING**
**Accept:** a fighter appears in the delegated account, written via the ER.

### ER-024 · `tick` (ER, hot path) · **PENDING**
Must call `round.exit(&crate::ID)?` before committing — Anchor serialises at instruction end, so a
commit built first writes pre-mutation bytes. Silent and wrong.
**Accept:** a test asserts committed state reflects the mutation, not the prior value.

### ER-025 · `settle` + `close_round` (commit_and_undelegate) · **PENDING**
**Accept:** seed revealed on-chain; base-layer account shows final state; owner reverted.

---

## Tier 3 — ER loop

### ER-030 · Measure tick cadence on devnet · **PENDING**
A 40s fight at ~10 ms slots is ~4,000 ER transactions. Whether to send one tick per slot or batch N
steps per transaction is a throughput question to be **measured, not assumed**.
**Accept:** observed tx/s and latency recorded before the game loop depends on either shape.

### ER-031 · Batching + commit strategy · **PENDING**
**Accept:** a full 40s round completes within its wall-clock budget on devnet.

---

## Tier 4 — Client

### ER-040 · Engine as ER client · **PENDING**
`@magicblock-labs/ephemeral-rollups-sdk@0.16.2`, router `https://devnet-router.magicblock.app`.
Routing follows account ownership, not configuration.
**Accept:** the engine drives a round through the ER instead of mutating JS objects.

### ER-041 · Settlement reads the committed account · **PENDING**
**Accept:** the ledger credits from committed on-chain state; `GetCommitmentSignature` replaces
`markAnchored`.

---

## Tier 5 — End-to-end

### ER-050 · Delegation round-trip on devnet · **PENDING**
open → delegate → tick → settle → commit → undelegate, with signatures recorded.

### ER-051 · Parity: Rust program vs TS sim · **PENDING**
Same seed and entries must produce byte-identical settlement. This is the check that stops the
on-chain game silently disagreeing with the one players have been watching.
**Accept:** identical winner and per-fighter payouts across both implementations.

---

## Blocked summary

| ID | Blocked on | Needs |
|---|---|---|
| ER-010 | No Windows SDK / MSVC on the machine; no admin | VS Build Tools **or** Windows SDK **or** a GNU-hosted sbf toolchain |
| ER-012, ER-02x, ER-03x, ER-04x, ER-05x | Downstream of ER-010 — nothing can be built or deployed | resolution of ER-010 |
