# ADR-001 — The first custodial arena settles in TWO mints

**Status:** accepted, 2026-08-20. Operator decision.
**Supersedes:** `ARENA-VAULT.md` §2.1's recommendation, which was single-mint-first.
**Blocks:** S2. Nothing in S1 depends on this.

---

## The decision

Each side deposits and is paid in **its own token**. Bulls stake ANSEM, Unicorns stake UWU, and a
raid moves the other side's token. `ARENA-VAULT.md` §3.1's holdings-vector design applies: `Fighter`
carries `ring: [u64; N]` and `banked: [u64; N]` indexed by mint slot, with a price frozen at
`open_round`.

`ARENA-VAULT.md` §2.1 recommended single-mint first and was overruled deliberately. The reason it
gave for two mints is the reason it was overruled:

> "You raided 340 UWU off KESTREL_42" is the product statement §3.1 is protecting, and a single-mint
> arena cannot make it. The two sides remain BULLS and UNICORNS as an identity; the settlement token
> is one. That is a real product regression and the operator should decide it, not inherit it.

They decided it. The cross-token raid **is** the product, and an arena where the sides are
decoration is a different product wearing the same name.

---

## What this obligates, and it is not a schedule slip

### 1. THE HOUSE-EDGE STUDY IS RETIRED AND MUST BE RE-MEASURED. This is the real cost.

This is the consequence §2.1 argued hardest about, and accepting two mints accepts it:

> the damage basis changes. Today `basis = min(attacker.hp, defender.hp)`, one scalar, and that exact
> symmetry is why the fight is a martingale and why every stake band sits on the rake and nowhere
> else. A slot-preserving raid over a vector reads a different basis. **`HOUSE-EDGE-STUDY.md` §11 and
> `HOUSE-SMALL-STAKE.md` do not survive that change, and they are the most valuable measurements in
> this repository.**

What is being retired is not a document. It is these measured facts, all against the single-scalar
basis:

- house take **exactly 1.0000% of gross entries**, 95% CI [1.0000, 1.0000] — degenerate, because it
  is arithmetic at `enter` rather than an edge that emerges
- conservation exact in **all 80,000 round-simulations**, and in `HOUSE-SMALL-STAKE.md`'s 186 runs
- the fight is a **martingale in `hp + banked` for every fighter**
- every stake band within one to two standard errors of −1.00%; **spread −0.6%** against v5's +707.7%
- the eight-wallet sybil farm worth **+$150.87/round under v5** now worth **−$0.31**

**None of those carry over.** They are properties of `min(a.hp, d.hp)` being one number.

**So a new gate, G12, ahead of any real money:** re-run `sandbox/house-edge/` against the vector
fight and reproduce, at minimum, (a) exact conservation, (b) a house take that does not depend on
which mint a player brought, and (c) no stake band and no sybil shape with positive expectation.
`ARCHITECTURE-N-TEAM.md` §6 ranks "the fairness numbers do not transfer" as risk 6 and notes it is
cheap before launch and expensive after — it was paid once and is now owed again.

This is a **sandbox** change, not a deploy. It is cheap. It is also the thing most likely to be
skipped because the numbers were true once.

### 2. A price feed enters the money path

With it, `ARENA-VAULT.md` §4.6(7)'s audit item becomes live: a written argument for why a wrong price
cannot cause insolvency. §3.1's argument is sound in principle — credit and redemption use the same
frozen number — and has to be re-made against real code.

And risk #9 goes live: **the price authority can tilt a fight**, with the arena's own wallets on the
board. That is a governance problem, not an engineering one, and it needs an owner before launch.

### 3. Rounding stops being free

Single-mint has one floor division in the whole money path, with a measured bound
(`HOUSE-EDGE-STUDY.md` §11.1: one unit per entry, the player's way, $0.000016/round at 16 seats,
unfarmable). Two mints adds three floor divisions per extract plus `units / price` at claim — so
dust, so a residue in the escrow, so §4.6(9)'s rounding argument has to be made properly rather than
handed to the auditor as a finished measurement.

### 4. `Round` reshapes, and the deploy that carries it is the one to bundle into

`Fighter` gains two vectors and `penalties_collected` becomes one. The account grows past 3,248
bytes. Per §3.2, **bundle every PDA reshape you will ever want into that single deploy** — it is one
`bulls-arena` program id and one reset of history, and a second one costs the same again.

---

## What this does NOT change

- **The two-program split.** §3.1's argument is about ER bytecode caching and program-id churn, and
  is independent of how many mints exist. `arena-vault` still never churns ids.
- **The rescue path.** §5.1's refund reads the vault's own base-layer deposit ledger. A vector of
  deposits is still a vector the vault wrote.
- **E1-M1.** The dead-delegation test is about delegation, not denomination.
- **The cost model.** §4.3's transaction arithmetic is per-entry and per-claim, not per-mint.

---

## What was given up

The single-mint arena's exactness, stated plainly so nobody rediscovers it as a surprise:

```text
payout(fighter i) = fighters[i].hp + fighters[i].banked      exactly, in tokens
escrow balance    = pot + fees_collected = gross_deposits     exactly, no division
conservation      = sum(hp+banked) + penalties + fees == gross  exactly, on the base layer
```

No price, no oracle, no mint-slot mapping, no division, no dust. That is now a design we are not
building, and every one of those lines becomes a thing to prove rather than a thing that is true by
construction.

---

## The honest summary

The product reason is good and the operator is right that a decorative side is a different product.
The cost is that **the strongest evidence this repo has — that the game is provably fair — expires
on the day the vector lands, and has to be re-earned before anyone deposits real money.**

Re-earning it is cheap and it is a sandbox job. Forgetting to is the failure mode, which is why it
is written here as G12 rather than left in a paragraph.
