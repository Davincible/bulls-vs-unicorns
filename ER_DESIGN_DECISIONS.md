# VRF · Ephemeral SPL · Private vs Public rollups — recommendation

Three questions raised after the ER lifecycle came up working. Grounded in the docs, not opinion.

---

## 1. Private ER (PER) instead of public — **NO, and it is not close**

PERs run in Intel TDX and shield state. Straight from the docs:

> "Verification becomes more complex — **users cannot independently verify shielded state** like they
> can on public chains" · requires "trust assumption in vendor hardware" · devnet needs an auth token.

That is a direct contradiction of this product's entire trust proposition. The footer we just wrote
says:

> *Provably fair. The engine publishes sha256(seed) before deploys open and reveals the seed when the
> fight starts... Every round is recomputable in your browser from that seed.*

A player cannot recompute a round they cannot read. And the specific accusation this product has to
survive — *"the operator runs the bots, the fights are rigged"* — is answered **only** by
verifiability. Moving rounds into a TEE replaces "check it yourself" with "trust Intel and trust us",
which is a strictly worse answer to the exact question that matters.

**Where a PER would genuinely fit:** hiding *player balances* — a distinct concern from round
fairness, and one nobody has asked for. Even then it buys privacy at the cost of the public
solvency proof (`/solvency`, "1409% backed") that is currently a selling point.

**Verdict: public ER for rounds. Permanently, not "for now".**

---

## 2. Ephemeral SPL tokens — **YES, this is the right answer to a problem I punted on**

This is the strongest of the three ideas, and it addresses something I explicitly scoped OUT of the
migration plan.

I wrote there that balances must stay off-chain because *"a delegated account is unusable by
base-layer programs — withdrawals would freeze for the length of every round."* Ephemeral SPL is
built precisely for that:

| | |
|---|---|
| **eATA** | a lightweight program-owned balance record from `[owner, mint]` — delegatable, mutable at rollup speed. Explicitly *"not a real SPL token account"* |
| **Global Vault** | one per-mint custody account holding the real tokens backing every eATA |
| **Lifecycle** | deposit → transact in the ER → undelegate → withdraw. *"Balances remain fully withdrawable"* |
| Program | `SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2` |

The separation is the trick: real tokens sit still in the vault while balance *records* move at
rollup speed. That is exactly what our game needs — stakes and payouts mutating per round without
freezing anyone's ability to withdraw.

**The tradeoff, stated honestly:** it is still custodial, just custodied differently. Today the risk
is *our* vault keypair on *our* server. With eATAs it becomes MagicBlock's per-mint Global Vault —
one vault backing every user of that mint across every app. That is not obviously better or worse; it
is a different counterparty, and one shared with strangers. Worth deciding deliberately rather than
drifting into.

**Verdict: adopt, but as its own phase after the round loop is solid.** It replaces the custody model,
which is the single most dangerous thing in this codebase to change. Queue it as ER-06x.

---

## 3. VRF instead of commit-reveal — **YES, and for a sharper reason than "better randomness"**

Our commit-reveal is genuinely good: `sha256(seed)` is published **before** entries open, so the
operator cannot see the book and then pick a favourable seed. That closes the obvious attack.

But it leaves one open, and it is worth naming because it is the one a sceptic will find:

> The operator chooses the seed **before** publishing the commitment. Nothing stops grinding
> thousands of candidate seeds offline against the *expected* lobby and committing to the most
> favourable one.

With ~16 fighters and a house running most of them, that is not theoretical. VRF removes seed choice
from the operator entirely — the randomness is produced by an oracle and verified on-chain, so there
is no seed to grind.

**Cost:** a VRF request per round, an oracle dependency in the hot path, and latency where we
currently have none.

**Verdict: adopt for the seed, keep the commit-reveal envelope.** Publish `sha256(vrf_output)` on
`open_round` exactly as now, so the browser-side replay and the on-chain anchor are unchanged. Only
the *source* of the seed changes, which makes this a contained swap rather than a rewrite of the
fairness story.

---

## Recommended order

1. **Finish the round loop** (ER-030/031 — measure real tick throughput near the validator)
2. **VRF for the seed** — small, contained, closes a real grinding attack
3. **Ephemeral SPL for balances** — big, changes custody, do it deliberately
4. **PER** — no

Only #3 changes who holds the money. That is the one to be slow about.
