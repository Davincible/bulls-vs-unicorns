# EXECUTION REPORT — MagicBlock ER migration (DEVNET ONLY)

**⚠ Historical snapshot, from a machine that could not compile the program at all (see below).**
Everything this report describes as blocked, unbuilt, or unverified has since shipped and been
verified by execution — compiled, deployed to devnet, and round-tripped for real. For current status
read `MEGA_QUEUE.md`, which is kept up to date; this document is left as-is as the record of that
specific (since-resolved) run rather than rewritten.

Branch `magicblock-er-migration`, forked from `main` at the live mainnet build.
**341 tests green.** Nothing deployed. Nothing on mainnet touched.

---

## 1. Headline

The queue is exhausted, but not completed, and the reason is environmental rather than technical:
**no Rust program can be compiled on this machine.** Everything that does not require a compiler is
done and verified; everything that does is written in full and has never run.

I have not marked anything verified that has not executed. Where source is complete but uncompiled,
it says so.

---

## 2. Completed and verified

### ER-000 · Mainnet kill switch ✅
`engine/src/devnet-guard.ts`. Asserts at import time, before any money path initialises, and **fails
closed** — an allowlist of positively-identified devnet/local hosts, not a denylist. A denylist
silently permits every endpoint nobody thought to ban, including mainnet behind an unfamiliar proxy.

Disabled at source rather than at call sites: real Jupiter swaps, mainnet memo anchoring, and the Fly
target retargeted to `bulls-arena-er-devnet`. `VAULT_SECRET` present in the environment is refused on
**presence**, not on use — its presence means production config was copied across.

*Verified:* mainnet RPC refused; unknown host refused; secrets redacted from the refusal; a mainnet
**fallback** inside an otherwise-devnet list refused; all-devnet env passes. 10 tests.

### ER-001 · Research grounding ✅
`MAGICBLOCK_RESEARCH.md`, from registries and reference source rather than doc prose. Two doc errors
found: the Magic Router page names npm packages that **do not exist** (real ones are scoped
`@magicblock-labs/*`), and the reference example pins the JS SDK and Anchor behind its own declared
versions.

### ER-011 · Workspace ✅ (resolution verified)
Scoped to `programs/bulls-arena` only. Not `programs/*`: that pulls in the dormant `programs/vault`
(Anchor 0.30.1), whose solana-program 1.17 pins `zeroize <1.4` while `ephemeral-rollups-sdk 0.16.2`
needs curve25519-dalek 4.x with `zeroize ^1`. Unsatisfiable, unrelated to either program's correctness.

### ER-012 · Devnet keypair ✅ / funding ⛔
Fork-local keypair `9BAjpGZfJm8sfnqNr1vj1K9X3fY8fjk4LE2KRtSTRCaj`, gitignored, never the production
vault. **Faucet rate-limited** at 2, 1 and 0.5 SOL — a named-legitimate blocker.

### ER-051 · Algorithm parity + properties ✅
`engine/src/er-sim.ts` — a line-for-line TypeScript mirror of the Rust. 13 properties pinned:
determinism, batching-independence, conservation over 25 random lobbies, no self-dealing, teammates
never trading, one-sided lobby stalemate, top-up on repeat entry, convergence, tie-to-side-A, and the
exact sha256 preimage the Rust builds.

### Guarded deploy script ✅
`scripts/deploy-devnet.mjs` verifies the cluster by **genesis hash**, not by URL — a proxy can be
named anything, it cannot forge the cluster it fronts. *Verified live:* reads
`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG (devnet)`, refuses mainnet outright, refuses the
default CLI keypair, and stops cleanly at the unbuilt binary.

---

## 3. The bug the mirror caught

Worth its own section, because it is the strongest argument for having written the mirror at all.

The `tick` damage rule was a percentage of **remaining** hp. That is exponential decay: it approaches
zero and never arrives, and integer division then floors it to `0` while hp is still positive, so the
exchange is skipped forever.

**Measured: 5,000 ticks, ZERO deaths, every fighter stuck at hp = 3.** A round that never resolves.

Deployed to a rollup, that would have presented as an infrastructure problem — rounds hanging, ticks
landing but nothing happening — and been debugged against the ER for a long time before anyone
suspected the arithmetic. Fixed identically in both implementations with a `DUST` floor: below it the
remainder transfers in one blow and the fighter dies. Value still conserved.

One of the three failures was **my test being wrong, not the code**: I asserted 20 bps of 1,000,000
is 200; it is 2,000. Corrected the expectation.

---

## 4. Written in full, never compiled

`programs/bulls-arena/src/lib.rs` — `Arena` + `Round`, `init_arena`, `open_round` (publishes
sha256(seed) **before** entries open), `delegate_round`, `enter`, `tick`, `reveal` (checks the seed
against the commitment — without that check the commitment is decoration), `settle`, `close_round`.

Design decisions and the alternatives rejected:

| Decision | Alternative considered | Why rejected |
|---|---|---|
| One `Round` account holds all fighters | One account per fighter | 40 delegations + 40 commits per round; the round stops being atomic; a partial commit leaves it half-settled |
| Delegate the round, not balances | Delegate balances too | A delegated account is unusable by base-layer programs — withdrawals would freeze for the length of every round |
| Keep commit-reveal RNG | Adopt MagicBlock VRF | Ours is already anchored and browser-verifiable; swapping it is a design decision, not a migration step |
| Target the round, not the bank | Full custody migration | A rewrite of the entire money system on a codebase with ~25 known-and-fixed money bugs — unreviewable in one pass |

It carries the commit trap from the research: `settle` and `close_round` call `round.exit(&crate::ID)?`
before building the bundle, because Anchor serialises at instruction end while the commit reads
account info during it. Without it you commit pre-mutation bytes, silently.

---

## 5. BLOCKED

### ER-010 · Toolchain — no Windows SDK, no admin
**Works:** Solana CLI 4.1.2 (devnet-configured), `cargo-build-sbf` 4.1.0, platform-tools v1.54,
Rust 1.97.1.
**Fails:** linking the **host** build scripts (`proc-macro2`, `serde`, `borsh`, `syn`) — not the SBF
target.

Six approaches, in order:
1. `cargo install anchor-cli` → Git Bash's GNU `link` shadows MSVC `link.exe` (`link: extra operand`)
2. From PowerShell → no linker at all; **MSVC is not installed**
3. `winget install …WinLibs…LLVM --scope user` → succeeded without admin; gcc 14.2.0 + LLVM
4. `rustup default …-gnu` → `cargo-build-sbf` pins its own **msvc-hosted** toolchain, overriding it
5. Shimmed `link.exe` → `lld-link.exe` → **worked**; advanced to `could not open 'kernel32.lib'`
6. Hunted the SDK → no `kernel32.lib` anywhere; `Windows Kits` absent; MinGW ships GNU-format `.a`

**To unblock, any one of:** VS Build Tools with the Windows SDK (admin) · standalone Windows SDK
(admin) · a GNU-hosted sbf toolchain (not shipped) · `cargo install xwin` (circular — needs the
missing linker to install).

### ER-012 funding · devnet faucet rate-limited
Fund via <https://faucet.solana.com> or retry later.

### Downstream of ER-010 — nothing built, nothing deployed
ER-021 → ER-025, ER-030, ER-031, ER-040, ER-041, ER-050. Source exists for the program; the client
integration (ER-040/041) was not written, because writing a client against an IDL that has never been
generated would be guessing at its own shape.

---

## 6. Performance vs baseline

**Not measured, and I will not estimate it.** ER-030 exists precisely because a 40s fight at ~10ms
slots is ~4,000 ER transactions, and whether that is one tick per slot or batched is a throughput
question to be *measured*. Nothing has run on the ER, so there is no observation to report. The
pre-migration baseline is known — rounds settle off-chain in single-digit milliseconds because it is
a JS loop over an in-memory array — and that is exactly why the comparison would be meaningless
without real ER numbers.

---

## 7. Residual risks before this fork could go anywhere

1. **The program has never been compiled.** It is reviewable, not proven. Expect real compile errors;
   the SDK's macro expansions (`#[ephemeral]`, `#[delegate]`, `#[commit]`) are the likeliest source.
2. **Parity is one-sided.** The TS mirror is tested; the Rust is not. They are asserted to be
   identical by reading, which is the weakest form of assurance. ER-051 is only half done.
3. **The dormant `programs/vault` is untouched** and still on Anchor 0.30.1. If it is ever revived it
   will collide with the ER SDK's dependency graph.
4. **Commit cadence is unknown.** Docs say "periodically or on-demand" without naming the automatic
   frequency parameter; `DelegateConfig`'s non-`validator` fields are hidden behind
   `..Default::default()` in every example.
5. **Custody is unchanged.** This fork moves the round, not the money. Anyone reading "migrated to
   ER" should understand balances are still a SQLite row behind a custodial keypair.
6. **This is a fork and must stay one.** The mainnet guard is why it is safe; do not port the guard
   off and the program on.

---

## 8. Recommended next

1. Install VS Build Tools + Windows SDK, or move the build to Linux/CI. Everything below is blocked
   on this and nothing else.
2. `cargo-build-sbf` → expect and fix macro-expansion errors → generate the IDL.
3. Fund the devnet payer, deploy, run the delegation round-trip (ER-050) and record signatures.
4. Close ER-051 properly: run the Rust against the same seeds as `er-sim.ts` and diff the settlement
   byte-for-byte. Until that passes, the on-chain game is not known to be the game players watch.
5. Only then ER-030/031 — measure before designing the tick loop around an assumption.
