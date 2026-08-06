# Phase B — MagicBlock Ephemeral Rollup (the hackathon build)

Grounded in MagicBlock's current docs (fetched 2026-08-06), not from memory.
Source: https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/rust-program

## 0. Where things build and run (read this first)

Two different things get conflated constantly, so to be explicit:

| Piece | Language | Where it BUILDS | Where it RUNS |
|---|---|---|---|
| Engine | TypeScript | nothing to compile | **a host** (Fly/Railway/VPS), 24/7 |
| Web app | HTML/JS | nothing to compile | **static hosting** (Vercel/Cloudflare) |
| Vault program | Rust/Anchor | **once**, into a `.so` | **on Solana itself** — no server of ours |

The on-chain program is not a service that "runs online" on a machine we rent. It is compiled once
into a binary and **deployed to the blockchain**, where Solana's validators execute it. The Rust
toolchain is therefore a *build* tool, not a runtime dependency.

**So Max does NOT need to install anything.** `.github/workflows/anchor-build.yml` compiles the
program on a GitHub runner and uploads the `.so` + IDL as a downloadable artifact. Deploying that
artifact needs only the `solana` CLI — **already installed in WSL (4.1.1)** — plus a funded keypair:

```bash
solana program deploy bulls_vault.so --url devnet
```

A local toolchain is optional (faster iteration), not required. Installing it on this machine has
failed twice before, so the cloud build is the recommended path. Verified state today, for reference:

| Tool | Windows | WSL (Ubuntu 24.04.3) | Needed |
|---|---|---|---|
| `solana` | missing | **4.1.1 (Agave)** | docs state 3.1.9 — see note |
| `rustc` / `cargo` | missing | **missing** (no `~/.cargo`) | 1.89.0 |
| `anchor` | missing | **missing** | required |
| `cc` / `gcc` | missing | **missing** | required to link |
| `node` | **24.13.0** ✓ | — | 24.10.0 |

**Optional** — only if you want to build locally instead of in CI (in WSL; the first needs sudo):

```bash
sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev
```
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . "$HOME/.cargo/env" && rustup default 1.89.0
```
```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force && avm install latest && avm use latest
```

Note on Solana version: the installed CLI is **4.1.1** while the docs quote **3.1.9**. Newer is
usually fine, but if `anchor build`/deploy misbehaves, pin the toolchain rather than fight it.
Once the above is done, `cargo build-sbf` and `anchor build` should work and Phase B can start.

## 1. What the ER actually changes for us

Today we ARE a hand-rolled rollup: an off-chain authoritative engine with a custodial vault. An
Ephemeral Rollup is that same pattern done natively — state accounts are **delegated** to a
dedicated ~50ms SVM validator, transactions run there gaslessly, and state **commits back** to
mainnet.

- **Custodial trust disappears.** Funds sit in program-controlled PDAs, not our keypair. The
  withdraw / double-spend / auth questions become program-enforced instead of enforced by our JS.
- **Provable fairness moves on-chain** (commit-reveal of the seed, or VRF).
- **The feel stays fast** — the arena does not slow down.

## 2. The honest architecture (what goes on-chain vs stays off)

Running full collision physics on-chain every tick is too expensive even in an ER. So:

- **On-chain (in the ER):** the money and the truth — deposits, per-round stake escrow,
  commit-reveal of the seed, and settlement.
- **Client:** the visual replay, exactly as it already does — deterministic from the revealed seed.

This keeps fairness verifiable on-chain while keeping the game cheap. It is also why Phase A's
`ledger.ts` extraction matters: swapping its backend from SQLite to ER accounts is a contained
change, not a rewrite.

## 3. Concrete integration (from the current docs)

- **Crate:** `ephemeral-rollups-sdk`.
- **Program macro:** `#[ephemeral]` — injects the undelegation callback discriminator and
  processor automatically.
- **Delegate:** CPI `delegate_account`, passing the PDA seeds and target validator via
  `DelegateAccounts` + `DelegateConfig`. Accounts required: payer, PDA, owner program, delegation
  buffer, delegation record, delegation metadata, delegation program, system program.
- **Commit / undelegate (ER side):** `MagicIntentBundleBuilder`
  → `.commit(&[account])` or `.commit_and_undelegate(&[account])` → `.build_and_invoke()`.
- **Undelegation callback discriminator:** `[196, 28, 41, 206, 48, 37, 51, 167]`, which calls
  `undelegate_account` back on the base layer.

## 4. Build order (once unblocked)

1. **Extend the existing vault program** (`programs/vault/src/lib.rs`, 223 lines, written, never
   deployed) with a per-round PDA: `round { seed_hash, phase, entries[], settled }`.
2. Add `#[ephemeral]` + the `ephemeral-rollups-sdk` dependency.
3. **Delegate the round PDA** at lobby open; run deploy/commit-reveal inside the ER;
   `commit_and_undelegate` at settlement so the result lands on mainnet.
4. Point the engine's ledger service at the program instead of SQLite (interface already isolated).
5. Verify on devnet: deposit → deploy → settle → withdraw, with the round recomputable from the
   on-chain seed.

## 5. Hackathon edge — Private ER (TEE)

MagicBlock ships TEE-secured ERs. A **dark-pool arena** — nobody sees stakes or sides until the
horn, hidden state revealed at round start — is exactly their pitch and a differentiated demo.
That is the prize angle, and it is a genuinely better game mode, not a gimmick.

## 6. Risk

The toolchain has failed twice on this machine before (no MSVC on Windows; Git Bash `link`
shadowing `link.exe`; no C compiler in WSL). **Build in WSL, not Windows.** If `avm`/`cargo`
install fails again, that is the signal to stop and reassess rather than burn hours — Phase A
ships without any of this.
