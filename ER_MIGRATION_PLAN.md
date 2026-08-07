# ER migration plan — Bulls ⚔ Unicorns on MagicBlock Ephemeral Rollups

**Devnet only.** Branch `magicblock-er-migration`. Grounding in `MAGICBLOCK_RESEARCH.md`.

---

## 1. The starting position, stated honestly

There is no on-chain program to migrate. The game today is:

```
browser ──ws──► Node engine (authoritative)  ──► SQLite ledger (all balances, all state)
                      │
                      └──► Solana: SPL vault, deposits, withdrawals, Jupiter swaps, memo anchors
```

Every fighter, stake, hit and settlement is a database row. The chain never sees a round — it sees a
32-byte hash of one, after the fact, in a memo.

So this migration is **writing the first on-chain program**, and the ER is where it executes. The
work is dominated by turning ledger rows into account state, not by adding delegation hooks to
something that already exists.

### What that means for scope

A full migration — every balance, every settlement on-chain — is a rewrite of the entire money
system, on a codebase where ~25 money bugs have already been found and fixed. Doing that in one pass
on a fork would produce something unreviewable.

**So the plan targets the round, not the bank.** Round state moves on-chain and into the ER; balances
stay in the existing ledger, and the ER commit becomes the settlement record. That is the slice
where ERs actually earn their keep (10ms mutation of hot state), it is independently verifiable, and
it does not require re-implementing custody. Extending it to balances is a follow-on, noted in §7.

---

## 2. Account mapping

Governed by one hard constraint from the research: **a delegated account cannot be touched by
base-layer programs.** Anything needing composability must not be delegated.

| State | Placement | Reason |
|---|---|---|
| `Arena` (config: tokens, mode, fee bps, authority) | **Base layer**, never delegated | Read by everything; changes rarely |
| `Round` (number, phase, seed commit, revealed seed, winner, pot) | **Base layer → delegated per round** | The hot account. Delegated at lobby open, undelegated at settle |
| `Fighter[]` (wallet, side, stake, hp, x, y, banked) | **Inside `Round`** | ~60 B each; 40 fighters ≈ 2.4 KB, far under the 10 MiB account ceiling. One account keeps the whole round atomically committable |
| Player balances | **Off-chain ledger (unchanged)** | Withdrawals need SPL composability; delegating these would freeze withdrawals mid-round |
| SPL vault | **Base layer (unchanged)** | Must remain a normal token account |
| Treasury / fees | **Off-chain ledger (unchanged)** | Settlement target, no per-tick mutation |
| Round results | **The ER commit itself** | Replaces the memo anchor — the commit *is* the proof |

**Alternative considered — one account per fighter.** Rejected: 40 accounts means 40 delegations and
40 commits per round, the round is no longer atomic, and a partial commit leaves a round half
settled. One `Round` account is committed or it is not.

**Alternative considered — delegating balances too.** Rejected for this fork: it freezes withdrawals
for the duration of a round, which is a worse product than the latency win is worth, and it puts
custody on the critical path of an unproven integration.

---

## 3. Program design

```rust
#[ephemeral]
#[program]
pub mod bulls_arena {
    pub fn init_arena(ctx, cfg)            // base layer, once
    pub fn open_round(ctx, round, commit)  // base layer: create Round, publish sha256(seed)
    pub fn delegate_round(ctx)             // base layer: hand Round to the ER validator
    pub fn enter(ctx, side, stake)         // ER: add a Fighter
    pub fn tick(ctx, steps)                // ER: advance the sim (hot path, ~10ms)
    pub fn settle(ctx, seed)               // ER: reveal seed, decide winner, commit
    pub fn close_round(ctx)                // ER: commit_and_undelegate
}
```

- `open_round` publishes `sha256(seed)` **before** entries open — this preserves the existing
  commit-reveal fairness scheme rather than replacing it, and it is now on-chain rather than in a memo.
- `settle` reveals the seed; anyone can recompute the round from `(seed, fighters, cfg)` exactly as
  the browser does today.
- `close_round` uses `commit_and_undelegate`, returning the account to base-layer ownership with the
  final state committed.

**The commit trap** (from research §3): `tick` and `settle` mutate Anchor state *and* commit in the
same instruction, so both must call `round.exit(&crate::ID)?` before `MagicIntentBundleBuilder`, or
they commit pre-mutation bytes. Silent and wrong. Pinned by a test.

---

## 4. Client / engine changes

The Node engine becomes the **ER client** rather than the authority:

| Today | After |
|---|---|
| `runRound()` mutates JS objects | sends `tick` to the ER via the Magic Router |
| settlement writes SQLite | reads committed `Round`, then credits the existing ledger |
| memo anchor per round | the ER commit is the anchor; store its signature |
| `roundLog` from memory | `roundLog` from committed round accounts |

- Connection: `@magicblock-labs/ephemeral-rollups-sdk@0.16.2`, router `https://devnet-router.magicblock.app`.
- Routing is driven by **account ownership**, not configuration — once `Round` is delegated, the
  router sends its transactions to the ER automatically.
- `GetCommitmentSignature` gives the base-layer signature proving a commit landed; that replaces
  `markAnchored(sig)`.
- The browser keeps its independent replay: it recomputes from the revealed seed, now fetched from
  the account rather than the websocket.

**Tick cadence is the open risk.** At ~10ms slots a 40s fight is ~4,000 ER transactions. Whether we
send one `tick` per slot or batch N steps per transaction is a throughput question that must be
*measured on devnet*, not assumed. ER-030 exists to measure it before the game loop depends on it.

---

## 5. Testing strategy

Nothing counts as done on a unit test alone. Each on-chain item is verified against devnet + the
devnet ER, with a signature recorded.

1. **Unit** — Rust tests for pure logic (damage, settlement arithmetic) with no chain.
2. **Delegation round-trip** (the core proof): `open_round` on devnet → `delegate_round` → confirm
   owner is `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` → `tick` in the ER → `settle` → confirm
   base-layer account shows the committed result → `close_round` → confirm owner reverted.
3. **Parity** — the same seed and entries produce byte-identical settlement in the Rust program and
   the existing TS sim. This is the check that stops the on-chain game silently disagreeing with the
   one players have been watching.
4. **Guard** — every script asserts devnet before touching a keypair (ER-000, already shipped).

---

## 6. Sequencing

Foundation → program → ER loop → client → end-to-end, so nothing depends on something unproven:

- **ER-01x foundation**: Anchor workspace, devnet keypair, airdrop, guarded deploy script
- **ER-02x program**: accounts, init/open, delegate, enter, tick, settle, undelegate
- **ER-03x ER loop**: tick cadence measurement, batching, commit strategy
- **ER-04x client**: engine talks to the ER, settlement reads the committed account
- **ER-05x end-to-end**: full round on devnet ER with signatures, parity against the TS sim

---

## 7. Explicitly out of scope for this fork

- Balances and custody on-chain (§1) — a follow-on, not a step
- Mainnet anything — structurally prevented by ER-000
- VRF adoption — our commit-reveal is already anchored and verifiable; swapping it is a design
  decision, not a migration step
- Economic changes (fees, matching, lobby sizing) — the ER changes *where* the round runs, not the
  rules it runs by
