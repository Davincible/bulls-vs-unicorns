# Making the ER load-bearing — hackathon integration

## The problem with what we have

I measured it: one transaction resolves an entire match (187 CU/step, ~7,300 steps fit in 1.4M CU).
That is a good engineering result and a **bad hackathon result**, because it proves the rollup is
optional. A judge will ask "why does this need an ER?" and the honest answer today is "it doesn't —
`enter` benefits, the fight doesn't."

The root cause is not the integration. It is the game:

> **The fight is already decided before it starts.** Players deploy in the lobby, the outcome is a
> pure function of `(seed, entries)`, and the 40 seconds of animation is theatre — the browser
> replaying a result that already exists.

Nothing that is precomputed needs 10ms blocks. So the ER can only ever be decoration *while the game
works this way*.

---

## The fix: give players agency DURING the fight

If input arrives *while* the fight is running, the outcome cannot be precomputed, state must mutate
at high frequency, and the ER stops being a choice.

**The mechanic already exists in the product and is currently wasted.** Extraction mode says:

> *Normal = raids compound in-ring · Extraction = raids bank to your wallet in real time*

Today that is automatic. Make it a **decision**:

```
        your fighter is up $4.20 and has 60% health left
        ┌──────────────────────────────────────────────┐
        │  EXTRACT NOW          or          KEEP FIGHTING │
        │  bank what you hold               risk it for more │
        └──────────────────────────────────────────────┘
                        18 seconds left
```

That single change does all of this:

| | |
|---|---|
| **Outcome becomes unpredictable** | it depends on when humans press a button, not only on the seed |
| **State mutates constantly** | every extract is a write, mid-fight, from a different wallet |
| **Latency becomes gameplay** | at 400ms base-layer slots, "extract now" is a lie. At 10ms it is real |
| **The ER is load-bearing** | remove it and the mechanic does not work |

That last row is the whole submission. *"Here is a game mechanic that is impossible without an
Ephemeral Rollup"* is a far stronger claim than *"we ported our game to an ER."*

---

## Where each piece then earns its place

### Ephemeral Rollup — the live fight
Fighters take damage and players extract in real time. Hundreds of writes per round from many
wallets. This is exactly the workload ERs exist for, and now we are not pretending.

### Ephemeral SPL — make the metaphor literal
The footer says *"Raids TAKE the enemy's coin into your bag."* Today that is a number in SQLite.
With eATAs it becomes **an actual SPL transfer, per raid, at rollup speed.**

That is the tasteful use: the game's core metaphor stops being a metaphor. A raid is a token
movement. An extraction is a settlement. Nothing is a ledger entry pretending to be a transfer.

### VRF — randomness that cannot be front-run
With players acting mid-fight, per-round randomness is no longer enough: a seed drawn at lobby close
lets a player simulate forward and know exactly when to extract. **Draw randomness per exchange, in
the ER** (`DEFAULT_EPHEMERAL_QUEUE`, ~100ms), so nobody can compute the future — they can only read
the present and decide.

This is where VRF becomes structural rather than a checkbox: it is what stops the extract button
being solved.

---

## What to build, in order

1. **`extract` instruction** — mid-fight, player-signed, banks their holdings and removes them from
   the ring. Small: one instruction, one guard (`phase == Fight`), value moves from `hp` to `banked`.
2. **Fight becomes stepped again — but for a real reason.** Not 125 chunks for no purpose: the
   round advances so that extract decisions land *between* exchanges and actually change the result.
3. **eATA balances** so a raid is a transfer, not a row.
4. **ER-queue VRF per exchange** so the future cannot be simulated.

Note that (2) reverses my own last change. It is not a reversal of the reasoning — with no player
input, one transaction was right, and I would make that call again. Adding agency changes the
premise, and the shape has to follow. Worth saying plainly rather than quietly re-adding ticks.

---

## The demo that makes the point

Two browsers, same round, side by side.

1. Both deploy. Fight starts.
2. One player hits **EXTRACT** at 20 seconds — their bar freezes, banked, safe.
3. The other holds on, takes a big raid, and ends with more.
4. Show the on-chain record: extraction timestamped mid-fight, ~10ms, in the rollup.
5. Then run the same round with the ER swapped for the base layer and let the 400ms latency make
   "extract now" visibly miss.

Point 5 is the argument. Everything else is context.

---

## What this does NOT change

- **Devnet only.** The mainnet lockout stays exactly as built.
- **No private rollup.** Verifiability is the product; a TEE trades away the one thing that answers
  "are the fights rigged".
- **Custody is still the dangerous part.** eATAs move custody to MagicBlock's per-mint vault. Fine
  for a hackathon on devnet; a real decision before anything else.
