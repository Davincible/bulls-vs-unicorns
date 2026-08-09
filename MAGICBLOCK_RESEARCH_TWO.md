# MagicBlock executive architecture manual

## A high-level guide for system architects and technical decision makers

> **Correction (2026-08-09, verified against current docs.magicblock.gg + github.com/magicblock-labs
> by an independent research pass — not recalled):** this document is a general MagicBlock overview,
> not source-cited the way `MAGICBLOCK_RESEARCH.md` is. One claim below is wrong and worth flagging
> rather than silently leaving: **"Private Payment API" (§3) is not a real, separate product.** It
> does not exist as a distinct SDK or docs section. What's real is **"Private Payments,"** a *use
> case* built entirely on **Ephemeral SPL Token** running with private `visibility` — the same
> custody-changing primitive already tracked as PARKED in `MEGA_QUEUE.md` (there called "ephemeral
> SPL / eATA"), not a fourth, separate, low-complexity thing. Treat §3 below as historical/aspirational
> rather than actionable.
>
> The same pass surfaced one real, missing, directly relevant product not mentioned anywhere in this
> document: **Session Keys** (`github.com/magicblock-labs/session-keys`, part of MagicBlock's "Gum"
> integration) — lets a session sign repeated transactions without a wallet popup per action.
> Concretely relevant here because `enter` and `extract` both require the player's own wallet to sign
> on-chain, and `extract` needs to be pressable mid-fight without a Phantom popup every time. See
> `MEGA_QUEUE.md` for current status.

### Executive summary

MagicBlock extends Solana with a **real-time execution layer** that allows selected application state to execute in **high-speed, specialized SVM runtimes** while remaining **native to Solana’s asset and program model**.

The core architectural concept is **state delegation**: instead of moving an application to a separate chain, specific Solana accounts are temporarily delegated to a faster execution environment called an **Ephemeral Rollup (ER)**. The application’s programs remain on Solana; only the delegated state executes in the accelerated runtime.

For architects, MagicBlock should be viewed as a **performance and capability layer** that can be selectively applied to latency-sensitive or privacy-sensitive components of a Solana application.

---

# The architectural stack

## Base layer: Solana

Solana remains the system of record.

Use Solana for:

- asset custody
- canonical state
- program deployment
- composability
- settlement
- interoperability with the Solana ecosystem

Documentation:

- https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/why

---

## Execution extension: Ephemeral Rollups

Ephemeral Rollups provide:

- sub-50ms execution
- gasless transactions
- configurable execution environments
- elastic scaling
- dedicated runtimes for specific workloads

The key distinction is that ERs execute **delegated state**, not an independent application chain.

Use ERs when:

- user interactions require Web2-level responsiveness
- throughput is high
- transaction costs are a UX bottleneck
- execution should be geographically localized
- workloads benefit from isolated execution environments

Primary documentation:

- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/why
- https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup

---

# Product portfolio

## 1. Ephemeral Rollup (ER)

### What it is

A specialized SVM runtime that temporarily executes delegated Solana accounts.

### Primary value

Real-time execution without leaving the Solana ecosystem.

### When to use

Choose ER if the application requires:

- multiplayer synchronization
- high-frequency trading
- real-time order books
- interactive consumer applications
- low-latency payment flows
- rapid state updates

### Do not use ER when

- latency is not user-visible
- execution volume is low
- standard Solana confirmation times are acceptable
- simplicity is more important than performance

### Architectural impact

ER introduces a second execution layer but preserves:

- native assets
- native programs
- Solana composability
- Solana settlement

Documentation:

- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/why
- https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup

---

## 2. Private Ephemeral Rollup (PER)

### What it is

A confidential execution environment built on top of Ephemeral Rollups using trusted execution environments.

### Primary value

Private execution with Solana settlement.

### When to use

Use PER for:

- private payments
- confidential order matching
- hidden game state
- enterprise workflows
- regulated financial applications
- AI inference requiring confidentiality

### Decision criterion

If the application requires **private computation**, PER is the primary MagicBlock privacy primitive.

Documentation:

- https://docs.magicblock.gg/pages/overview/products

---

## 3. Private Payments (a use case, not a separate product) — see correction above

### What it actually is

Not a distinct SDK. "Private Payments" is Ephemeral SPL Token run with private `visibility` — the
same primitive as PER's confidential state, applied to token transfers specifically. There's a demo
app (`private-payments.magicblock.app`, repo `magicblock-labs/private-payments-demo`) and a CLI
(`mirage`) for testing it, but no separate package to integrate.

### Primary value

Confidential transfers, when you've already decided to take on Ephemeral SPL Token / PER's custody
model.

### When to use

Same decision as PER (§2): only if the application genuinely needs to hide balances or transfer
amounts from other participants. Does not reduce PER's integration complexity or its custody
tradeoff — it is PER's token-transfer use case, not a lighter-weight alternative to it.

Documentation:

- https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/api-reference/per/introduction
- https://github.com/magicblock-labs/private-payments-demo

---

## 3.5 Session Keys — real, missing from this document originally

### What it is

A signer delegation mechanism (`github.com/magicblock-labs/session-keys`) letting a short-lived
session key sign a scoped set of actions on a player's behalf, so the wallet doesn't have to approve
every single transaction.

### Primary value

Removes the wallet-popup-per-action tax on any flow with frequent player-signed transactions.

### When to use

Any real-time application where a player signs on-chain actions repeatedly and quickly — exactly the
shape of a fight where `extract` needs to be pressable the instant a player decides, not after a
Phantom round-trip.

Documentation:

- https://docs.magicblock.gg/pages/tools/session-keys/installation

---

## 4. Solana VRF

### What it is

Verifiable randomness integrated with MagicBlock’s execution environment.

### Primary value

Provably fair randomness for applications.

### When to use

Use VRF for:

- games
- raffles
- lotteries
- NFT mint randomness
- procedural generation
- probabilistic protocols

Documentation:

- https://docs.magicblock.gg/pages/overview/products

---

# Core infrastructure components

## Delegation Program

### What it is

The protocol that transfers execution authority over specific Solana accounts to an Ephemeral Rollup.

### Why it matters

This is the **foundation of the entire architecture**.

Delegation determines:

- which accounts move
- how long they execute remotely
- synchronization frequency
- session lifecycle

### Architectural role

Think of the Delegation Program as a **state routing protocol**.

Every ER integration ultimately depends on delegation.

Documentation:

- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup
- https://github.com/magicblock-labs/delegation-program

---

## Magic Router

### What it is

An RPC routing layer that automatically sends transactions to either:

- Solana
- the appropriate Ephemeral Rollup

### Primary value

Transparent execution routing.

### Why architects care

Without the router, clients would need explicit awareness of multiple execution environments.

Magic Router allows applications to present a **single endpoint** while the infrastructure manages execution placement.

Use Magic Router whenever ERs are introduced.

Documentation:

- https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup

---

# Application architecture patterns

## Pattern 1: Solana only

Best for:

- wallets
- token applications
- governance
- simple DeFi
- NFT platforms

MagicBlock adds little value.

---

## Pattern 2: Hybrid real-time

Architecture:

- Solana: settlement and assets
- ER: interactive execution

Best for:

- games
- prediction markets
- social applications
- collaborative applications

This is the **recommended default architecture** for most MagicBlock integrations.

---

## Pattern 3: Confidential hybrid

Architecture:

- Solana: public assets
- PER: confidential execution
- Solana: settlement

Best for:

- institutional finance
- private trading
- enterprise applications
- regulated workflows

---

# Decision framework

## The latency test

Ask:

**Does a 400ms interaction noticeably degrade user experience?**

If yes, evaluate ER.

Examples:

- game movement
- order placement
- chat
- collaborative editing
- real-time coordination

---

## The cost test

Ask:

**Will users perform hundreds or thousands of state updates?**

If yes, ER’s gasless execution becomes valuable.

---

## The privacy test

Ask:

**Should other participants be unable to observe intermediate state?**

If yes, evaluate PER.

Examples:

- hidden bids
- private balances
- confidential strategies
- secret game information

---

## The randomness test

Ask:

**Does fairness depend on unpredictable outcomes?**

If yes, use VRF.

---

# Integration complexity

## Low complexity

### VRF

Minimal protocol changes.

### Session Keys

Minimal application changes — a signer delegation layer, not a state architecture change.

---

## Medium complexity

### Magic Router

Primarily infrastructure integration.

---

## High complexity

### Ephemeral Rollups

Requires:

- delegation integration
- session management
- state lifecycle design
- execution partitioning

### Private Ephemeral Rollups

Requires all ER considerations plus:

- confidentiality design
- access control
- private state architecture

---

# Migration strategy

## Existing Solana application

Recommended sequence:

1. keep core program unchanged
2. identify latency-critical accounts
3. add delegation hooks
4. integrate Magic Router
5. selectively accelerate workflows

MagicBlock is designed for **incremental adoption**, not complete architectural replacement.

Documentation:

- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart

---

# What remains on Solana

A common architectural misconception is that MagicBlock moves applications off Solana.

The following should generally remain on Solana:

- token accounts
- NFT ownership
- treasury assets
- governance
- protocol settlement
- long-term state
- interoperability points

ERs should primarily host **high-frequency operational state**.

---

# The most important architectural concept

## State partitioning

Successful MagicBlock architectures separate state into:

### Canonical state

Characteristics:

- durable
- composable
- settlement-critical

Lives on Solana.

### Operational state

Characteristics:

- frequently updated
- latency-sensitive
- session-oriented

Delegated to ER.

This partitioning usually determines whether a MagicBlock integration succeeds.

---

# Documentation map

## Start here

Product overview:

https://docs.magicblock.gg/pages/overview/products

Architecture overview:

https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup

Why ERs exist:

https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/why

---

## Architecture and protocol

Delegation lifecycle:

https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup

JIT state delegation:

https://www.magicblock.xyz/blog/how-ephemeral-rollups-delegate-state

Conceptual architecture:

https://www.magicblock.xyz/blog/a-guide-to-ephemeral-rollups

---

## Integration

Quickstart:

https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart

Delegation Program:

https://github.com/magicblock-labs/delegation-program

GitHub organization:

https://github.com/magicblock-labs

---

## Use cases

Games:

https://docs.magicblock.gg/pages/get-started/use-cases/games

---

## Research

Original ER paper:

https://arxiv.org/abs/2311.02650

---

# Executive recommendation

For most production architectures, evaluate MagicBlock in this order:

1. **Magic Router** — execution abstraction
2. **Ephemeral Rollups** — latency and cost
3. **VRF** — fairness
4. **Session Keys** — signer UX for frequent player-signed actions
5. **Private Ephemeral Rollups** (incl. Private Payments via Ephemeral SPL Token) — confidentiality

Treat MagicBlock as a **selective execution accelerator**, not a new blockchain. The strongest architectures keep **assets and canonical state on Solana** while moving only the **latency-critical operational state** into Ephemeral Rollups.
