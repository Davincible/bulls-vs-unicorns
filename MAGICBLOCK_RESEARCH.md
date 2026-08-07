# MagicBlock Ephemeral Rollups — research grounding

Phase 1 of the ER migration. **Devnet only.** Everything below was verified against live sources on
2026-08-08, not recalled: package versions come from the npm/crates registries, and the API shapes
come from reading the reference program's source rather than from doc prose.

---

## 0. The finding that shapes everything else

**CORRECTION (found while building):** I first wrote that there is *no* on-chain program. That was
wrong, and I found it only because my `programs/*` workspace glob picked up a package I did not know
existed. `programs/vault` is a 223-line Anchor 0.30.1 program with `initialize` / `deposit` /
`withdraw` / admin instructions.

It is **dormant**, not live: its `declare_id!` is the placeholder `VauLt111…` marked "replaced at
deploy", and **no engine code references it** — the running game uses a custodial keypair vault, not
this program. So the substance below holds (nothing on-chain drives a round; every balance is a
SQLite row), but the flat claim was false and stating it confidently was the mistake.

**No on-chain program drives the game.** Bulls ⚔ Unicorns is an off-chain authoritative engine
(TypeScript, Node) with:

- a **custodial vault** holding SPL tokens and SOL,
- a **ledger** in `node:sqlite` — every balance, stake and settlement is a database row,
- the chain used only for **deposits, withdrawals, swaps and memo anchoring**.

The mission brief speaks of "delegation hooks", "ER-compatible instructions" and "Anchor constraint
changes" as if a program exists to modify. It does not. There is no Anchor workspace, no `programs/`
directory, no `declare_id!`, no IDL.

This is not a blocker, but it changes the shape of the work fundamentally, and pretending otherwise
would produce a plan that collapses at the first item:

> **This is not a migration of an on-chain program to the ER. It is writing the game's first on-chain
> program, with the ER as its execution environment.**

Everything the engine currently does in a SQLite row has to become account state before any of it
can be delegated. That is the real body of work, and `ER_MIGRATION_PLAN.md` is written against that
reality.

---

## 1. The integration model

### Lifecycle: delegate → execute → commit → undelegate

| Phase | What happens |
|---|---|
| **Delegate** | Account ownership transfers to the **Delegation Program** `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`. You specify the validator, lifetime and sync frequency via `DelegateConfig`. |
| **Execute** | Only the designated **ER validator** may write to the account. The first ER transaction clones the account from base layer into the rollup. State then mutates at ER speed (~10ms blocks) with no base-layer fee per move. |
| **Commit** | ER state is pushed back to the base layer, "periodically or on-demand". Finalisation uses a fraud-proof window overseen by a Security Committee. |
| **Undelegate** | State is committed and ownership reverts from the Delegation Program to the original owner. |

The critical constraint for us: **a delegated account is unusable by base-layer programs while
delegated.** Only the ER validator can write it. So anything that must stay composable — anything a
DEX, a wallet, or a token program needs to touch — cannot be delegated while that is true.

### Magic Router

- **HTTP** `https://devnet-router.magicblock.app`
- **WSS** `wss://devnet-router.magicblock.app`

The router inspects transaction metadata and the **owner of the writable accounts** to decide
whether a transaction goes to the ER or to Solana. That owner check is why delegation state, not
configuration, drives routing — you do not tell the router where to go, the accounts do.

A specific regional ER validator can also be addressed directly; the reference test uses
`https://devnet-as.magicblock.app/` (+ `wss://`) rather than the router.

---

## 2. Exact versions (verified against registries, not docs)

| Package | Registry | Version | Notes |
|---|---|---|---|
| `ephemeral-rollups-sdk` (Rust) | crates.io | **0.16.2** | updated 2026-07-22 |
| `@magicblock-labs/ephemeral-rollups-sdk` | npm | **0.16.2** | for `@solana/web3.js` |
| `@magicblock-labs/ephemeral-rollups-kit` | npm | **0.16.2** | for `@solana/kit` |
| `anchor-lang` | crates.io | **1.0.2** | per reference program manifest |

**Two discrepancies worth stating rather than smoothing over:**

1. The docs index and `Anchor.toml` say `anchor_version = "1.0.2"`, but the reference example's
   `package.json` pins `@coral-xyz/anchor` at `0.32.1` and the JS ER SDK at `0.14.3` — both behind
   the current npm releases. The example lags the SDK.
2. The unscoped names `ephemeral-rollups-sdk` / `ephemeral-rollups-kit` that the Magic Router doc
   page names **do not exist on npm**. The real packages are scoped `@magicblock-labs/…`. Following
   the doc verbatim gives a 404 at install time.

**Decision:** pin Rust to the versions the reference program actually compiles against
(`anchor-lang 1.0.2`, `ephemeral-rollups-sdk 0.16.2`), and take the JS SDK at npm-latest `0.16.2`
rather than the example's stale `0.14.3`, since it matches the Rust side.

---

## 3. Program-side API (read from source, `counter/anchor`)

```rust
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

#[ephemeral]           // on the #[program] module
#[program]
pub mod my_program { … }
```

**Delegate** — `#[delegate]` on the context, `#[account(mut, del)]` on the PDA:

```rust
#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: the pda to delegate
    #[account(mut, del)]
    pub pda: UncheckedAccount<'info>,
}

ctx.accounts.delegate_pda(
    &ctx.accounts.payer,
    &[COUNTER_SEED],
    DelegateConfig {
        validator: ctx.remaining_accounts.first().map(|a| a.key()),
        ..Default::default()
    },
)?;
```

**Commit / undelegate** — `#[commit]` on the context, which supplies `magic_context` and
`magic_program`:

```rust
MagicIntentBundleBuilder::new(
    ctx.accounts.payer.to_account_info(),
    ctx.accounts.magic_context.to_account_info(),
    ctx.accounts.magic_program.to_account_info(),
)
.commit(&[ctx.accounts.counter.to_account_info()])          // or .commit_and_undelegate(&[…])
.build_and_invoke()?;
```

**The non-obvious bit:** when an instruction *mutates* Anchor state and then commits in the same
call, the reference program calls `counter.exit(&crate::ID)?` **before** building the bundle. Anchor
normally serialises account data at the end of the instruction; the commit reads the account info
*during* it, so without the explicit `exit` you commit the pre-mutation bytes. Silent and wrong.

**Client-side** — `GetCommitmentSignature` from `@magicblock-labs/ephemeral-rollups-sdk` retrieves
the base-layer signature for a commit made in the ER, which is how you prove a commit landed.

---

## 4. Devnet endpoints and IDs

| Thing | Value |
|---|---|
| Base layer RPC | `https://api.devnet.solana.com` |
| Magic Router HTTP | `https://devnet-router.magicblock.app` |
| Magic Router WSS | `wss://devnet-router.magicblock.app` |
| Regional ER (example uses) | `https://devnet-as.magicblock.app/` · `wss://devnet-as.magicblock.app/` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |

Env var names used by the reference project: `PROVIDER_ENDPOINT`, `EPHEMERAL_PROVIDER_ENDPOINT`,
`ROUTER_ENDPOINT`, `TEE_PROVIDER_ENDPOINT`.

All of these are allowlisted by `engine/src/devnet-guard.ts` (they contain `devnet`); a mainnet
router or RPC is refused at boot. See ER-000.

---

## 5. What this means for our accounts

Applying the delegated-accounts-are-not-composable constraint to our state:

| State | Today | ER placement | Why |
|---|---|---|---|
| Round state (phase, entries, fighter positions/health, RNG cursor) | SQLite rows | **ER** | Mutates every tick; this is precisely what ERs exist for |
| Per-round stakes while a round is live | SQLite | **ER** | In-flight only; settled back at round end |
| Player balances / vault holdings | SQLite + SPL vault | **Base layer** | Must stay composable — deposits, withdrawals, SPL transfers |
| Treasury (fee revenue) | SQLite row | **Base layer** | Settlement target, no per-tick mutation |
| Round results / anchors | memo tx | **Base layer via commit** | The commit *is* the anchor — replaces the memo path |

The natural boundary is the round: **delegate at lobby open, mutate through the fight, commit and
undelegate at settlement.** That maps exactly onto the lifecycle the SDK provides, and it keeps
balances on the base layer where withdrawals need them.

---

## 6. Open questions carried into Phase 2

1. **Commit cadence.** Docs say "periodically or on-demand" without naming the automatic frequency
   parameter. `DelegateConfig` has fields beyond `validator` that `..Default::default()` hides in
   the example. Needs the SDK source or `runtime-limits.md` before we rely on automatic commits.
2. **Runtime limits.** Not yet read (`introduction/runtime-limits.md`). Compute and account-size
   ceilings in the ER decide whether a 40-fighter round fits in one account or must be split.
3. **RNG.** Our provably-fair commit-reveal is off-chain. MagicBlock ships VRF; whether to keep our
   scheme (already anchored, already verifiable) or adopt VRF is a real design decision, not a
   detail.
4. **Who pays.** ER transactions still need a fee payer. On devnet that is an airdropped keypair;
   the model for a real deployment is out of scope for this fork by construction.

---

## Sources

- `https://docs.magicblock.gg/llms.txt` — documentation index
- `…/ephemeral-rollups-ers/introduction/ephemeral-rollup.md` — delegation/commit/undelegation lifecycle, Delegation Program ID
- `…/ephemeral-rollups-ers/introduction/magic-router.md` — router endpoints and routing logic
- `…/ephemeral-rollups-ers/how-to-guide/anchor.md` — Anchor integration overview
- `github.com/magicblock-labs/magicblock-engine-examples` @ `main`, `counter/anchor/` — program source, `Cargo.toml`, `Anchor.toml`, `.env.example`, `package.json`, `tests/public-counter.ts`
- `registry.npmjs.org` and `crates.io/api/v1/crates/ephemeral_rollups_sdk` — version verification
