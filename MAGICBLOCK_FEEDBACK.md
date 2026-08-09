# Feedback for MagicBlock

A running log, kept as we build against MagicBlock's stack. Each entry says what we found, what
it cost us, and points at the exact code in this repo that reproduces it — not vibes, not "the
docs could be nicer somewhere." Intended to be handed to MagicBlock as-is or trimmed down for a
Discord post / GitHub issue when the list is worth sending.

Format: dated entries, newest first. Each entry tagged **[GAP]** (missing/inaccurate
documentation or capability), **[BUG]**, or **[FEATURE REQUEST]**.

---

## 2026-08-09 — Ephemeral validators don't re-clone a program's bytecode after a base-layer upgrade

Context: fixing a compute-budget bug in our program (`programs/bulls-arena`), we upgraded the
deployed program (base-layer `anchor upgrade`, standard `BPFLoaderUpgradeable` flow) and confirmed
the new bytecode on the base layer before testing. `resolve()` on a *fresh* round, delegated and
run through the default router-selected ER validator (`devnet-as.magicblock.app`), still failed with
the exact pre-fix error — three-plus minutes after the base-layer upgrade had already confirmed.

**[BUG or GAP, unclear which without visibility into the validator's own code]** The ER validator
appears to clone a program's executable bytecode into its own local (`LoaderV4`-owned, from the
account it creates) copy on first use, and does not re-clone it when the base-layer program is
upgraded. A `BPFLoaderUpgradeable` program's own `Program` account never changes on upgrade — only
its separate `ProgramData` account does — so if the validator's cache invalidation subscribes to (or
diffs) the `Program` account rather than `ProgramData`, it would structurally never observe an
upgrade. We didn't have visibility into the validator's actual cache-invalidation logic to confirm
which; this is diagnosis from external behavior (`simulateTransaction` against the ER endpoint
directly, reading `unitsConsumed`/logs), not a source read.

**Cost to us:** a confusing ~15 minutes where a verified, redeployed fix appeared to still be broken
on-chain, before realizing the *base layer* had the fix and the *ER validator* didn't.

**Workaround found:** `delegate_round`'s `DelegateConfig.validator` (passed via
`remaining_accounts[0]`) can pin a specific ER validator instead of accepting the router's default.
Pinning a different validator (`devnet-us.magicblock.app`) on a fresh round got a clean clone of the
current bytecode immediately. Regression-verified for real this way — see `MEGA_QUEUE.md`'s task #15
entry for the full signature trail.

**[FEATURE REQUEST]** Either invalidate the ER-side bytecode cache on a `ProgramData` write (not just
the `Program` account), or document the actual cache lifetime/invalidation trigger explicitly so a
developer redeploying mid-session knows to expect (and how to force past) stale bytecode on
already-warm validators, rather than discovering it by accident.

---

## 2026-08-09 — Phase 0 spike: Session Keys + Ephemeral Rollup delegation

Context: we spent a session verifying whether MagicBlock's Session Keys mechanism
(`github.com/magicblock-labs/session-keys`) works when the account it's authorizing action on is
already delegated to an Ephemeral Rollup. It does — we proved it end-to-end on devnet, twice, plus
a negative control confirming the auth check is real. Full details:
`programs/bulls-arena-session-spike/`, `er-demo/scripts/spike-session-er.mjs`.

Along the way:

**[GAP] No example anywhere combines Session Keys with ER delegation.** We searched
`docs.magicblock.gg`, the `session-keys` repo's own examples, and `magicblock-engine-examples`
(the canonical Anchor Counter / Bolt Counter delegate/undelegate examples). None of them touch a
delegated account with a session-signed instruction. This is a natural, high-value combination —
Session Keys exists specifically to remove wallet-popup friction from frequent actions, and
frequent actions are exactly what people put on an ER in the first place (that's the whole reason
to pay for 10ms blocks). We had to build a throwaway program and run it against real devnet to find
out this works at all. A documented example (even a minimal Anchor counter, delegated, incremented
by a session key) would save every future integrator this exact spike.

**[GAP] `@magicblock-labs/gum-sdk`'s `SDK` class does not expose session creation, despite being
the package name implies is "the SDK."** `gum-sdk`'s `SDK` class
(`node_modules/@magicblock-labs/gum-sdk/src/index.ts`) is a thin AnchorProvider wrapper with no
`createSession`/`revokeSession` methods at all. The actual instruction-building logic
(`create_session` / `create_session_v2` CPI calls against the deployed `gpl_session` program) lives
entirely inside `gum-react-sdk`'s compiled `useSessionKeyManager` **React hook** — which also
bundles browser-only persistence (IndexedDB, `crypto-js` AES encryption of the session keypair in
`localStorage`-adjacent storage) directly into the same function that builds the transaction. There
is no way to create a session server-side, in a bot, in a CLI, or in a test harness through the
published API surface — we had to decompile `gum-react-sdk`'s bundled `lib/index.js` to find the
real logic and reimplement it directly against `@coral-xyz/anchor` and the `gpl_session` IDL
(`node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json`, program id
`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`, same address on every cluster).

**[FEATURE REQUEST] Move session create/revoke instruction-building into `gum-sdk` (framework-
agnostic), and have `gum-react-sdk`'s hook call *that* for the transaction-building part, keeping
only the React-specific bits (state, IndexedDB persistence) in the hook.** This is a small refactor
on MagicBlock's side with a large payoff: anyone doing headless testing, server-authoritative flows,
bots, or non-React frontends currently has to reverse-engineer a minified bundle to use Session Keys
at all.

**[GAP] `gum-react-sdk` ships only compiled output, no source.** The npm package contains
`lib/index.js` + `lib/index.d.ts` and nothing else — no `src/`, no sourcemap. Verifying actual
behavior (which is what led to the finding above) required reading de-minified bundled JS instead
of readable TypeScript. Shipping `src/` (even without publishing it to the package, just in the
GitHub repo in a state that matches the published version) would have saved real time.

**Not a complaint, worth recording as confirmed fact:** `session-keys` crate's own
`Cargo.toml` pins `anchor-lang = { version = ">=0.28, <2.0" }` deliberately wide, specifically so it
resolves to whatever the consumer's workspace already pinned rather than forking the dependency
graph. This worked exactly as documented — our workspace (anchor-lang 1.0.2) and `session-keys`
3.1.1 resolved to a single shared `anchor-lang` entry in `Cargo.lock`, no duplicate. Good design,
noting it so we don't re-litigate it later.

**Not a complaint, minor DX note:** without `features = ["no-entrypoint"]` on the `session-keys`
dependency, the build fails with `the #[global_allocator] in this crate conflicts with global
allocator in: session_keys` — an accurate but slightly confusing error for what's actually a missing
Cargo feature flag. The docs' own installation snippet *does* include the flag; the error message
just doesn't point back at it, so anyone who skims past the Cargo.toml snippet (as we initially did,
working from a plan doc that had dropped the feature flag when transcribing the version string) gets
a generic Rust linker-shaped error instead of "you're missing `no-entrypoint`."
