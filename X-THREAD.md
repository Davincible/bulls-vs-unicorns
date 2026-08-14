# X copy — Bulls vs Unicorns

**VERIFY BEFORE POSTING: handles — @MagicBlock, @ColosseumOrg (user wrote '@colleseum')**

Both handles are best guesses and neither has been checked against X. `@MagicBlock` is the
commonly-used handle for MagicBlock; `@ColosseumOrg` is the commonly-used handle for Colosseum, the
Solana hackathon org. Confirm both before anything goes out — a wrong @ in tweet 1 of a thread is the
one mistake you cannot edit away.

Everything else in this file is drawn from `COST-MODEL.md`, `programs/bulls-arena/src/lib.rs` and
`er-demo/src/v2/SOCIAL.md`. No number here was invented.

Character counts are the literal length of the tweet body including newlines. Limit is 280.

---

## Deliverable 1 — The explainer thread

**1/**
A fight with 44 fighters costs the same 5 base-layer transactions as a fight with 2.

Not "roughly the same". The same five.

That's Bulls vs Unicorns — a last-one-standing arena running on @MagicBlock Ephemeral Rollups.

Live on devnet: bullsvsunicorns.fun
`[257]`

**2/**
The game: pick a side, enter a round with a stake, and up to 48 fighters brawl on screen in real time. Last ones standing take the pot.

Or extract mid-fight and bank what you're holding — 20% penalty at the bell, decaying to zero.

Devnet: the stakes are paper.
`[262]`

**3/**
The whole round lives on a @MagicBlock Ephemeral Rollup. Every entry, every combat tick, the resolve — all of it executes inside the rollup and never touches the base layer.

What the base layer sees: the round opening, delegating, undelegating, settling. Five transactions.
`[274]`

**4/**
So participants are free.

A 44-fighter round and a 2-fighter round cost the same five transactions and ~0.00007 SOL in fees. Measured on a real devnet round, not projected.

This game is only economically possible because of the ER. That's the whole story.
`[257]`

**5/**
Session keys: you sign once, then fight with no wallet popups.

That matters most at extract — a decision made mid-fight, under time pressure, racing whoever settles the round. A wallet modal there would undercut the entire "real-time because of the rollup" claim.
`[264]`

**6/**
Randomness is a VRF with commit-reveal.

A commitment is published on-chain before anyone can enter, and the seed itself comes from MagicBlock's VRF oracle after the lobby closes.

Nobody can grind seeds against a lobby they can already see. Outcomes aren't ours to pick.
`[271]`

**7/**
The chain enforces a conservation identity:

sum(hp + banked) + penalties == pot

Checkable from the round account alone, at any moment of the fight. Every lamport in the pot is accounted for, and you don't have to take our word for any of it.
`[243]`

**8/**
Why the cap is 48 and not 64 — measured, 400 seeds per lineup:

n=48 → 124s median fight, concludes before the bell 76.2% of the time
n=64 → 62.5%

48 is the biggest board that still clears the bar the 16-fighter version already met.
`[233]`

**9/**
A real round on devnet: 44 fighters, settled in 85 seconds.

Every hit, every extract, every death in that round executed on chain. Not a replay of an off-chain simulation — the simulation *is* the chain.
`[204]`

**10/**
Where it's going: X identity on the board. Your handle and picture become your fighter's face, so you can follow one specific person's disc through a fight and watch the exact moment they extract or die.

Devnet. No token, no real money.

bullsvsunicorns.fun
`[258]`

---

## Deliverable 2 — The ship log

**1/**
ship log:

— round state moved on-chain, onto @MagicBlock Ephemeral Rollups
— 48 fighters/round; a real one with 44 settled in 85s
— 5 base-layer txs whether 2 fight or 44
— VRF seeds, session keys, no popups
— live on devnet

@ColosseumOrg hackathon blitz
bullsvsunicorns.fun
`[276]`

---

## Alternative hooks for the explainer thread

**Alt hook A**
Every combat tick of a 48-fighter brawl executes on-chain, in real time.

The base layer sees five transactions for the entire round.

Bulls vs Unicorns, live on devnet — and it only exists because of @MagicBlock Ephemeral Rollups.
`[231]`

**Alt hook B**
We built a last-one-standing arena on Solana where adding 42 more fighters to a fight costs nothing.

Not "nothing much". The same five base-layer transactions as a 1v1.

Here's how, and why it couldn't have been built any other way.
`[233]`

---

## Notes for whoever posts this

- Tweet 4 is the load-bearing one. If the thread gets cut for length, cut 8 before 4.
- Every figure: 5 txs / 0.00007 SOL / 44 fighters in 85s / 76.2% / 124s / 62.5% / 20% penalty / 48 cap
  comes from `COST-MODEL.md` §1 or the `median fight` table in `programs/bulls-arena/src/lib.rs`.
- Do not add a mainnet or token line. Every draft of this deliberately says devnet out loud.
