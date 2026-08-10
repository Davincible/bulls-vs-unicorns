> ## READ THIS BEFORE QUOTING ANY NUMBER BELOW
>
> **Every fairness number in this document was measured on `engine/src/gameN.ts`, a
> FLOATING-POINT PHYSICS simulation.** It has atomic clashes, size banding, per-stake dust,
> a "small edge" toolkit, ring/banked/stolen-vector holdings, and continuous positions.
>
> **The deployed on-chain game is a different program with different mechanics.**
> `programs/bulls-arena/src/lib.rs` (live: `EpRY6fkv4RcazjYSJyk8rppeVTVMcWhCcVtTVrKkTLT4`),
> mirrored by `engine/src/er-sim.ts`, is an INTEGER HASH simulation: a sha256 chain draws one
> attacker and one defender per step, damage is `min(attacker.hp, defender.hp) * roll / 100`
> with `roll = h[8] % 24 + 4`. No physics, no positions, no clashes at all.
>
> **Therefore the following claims below do NOT describe the deployed game and must not be
> quoted about it:**
> - "3-WAY ... Verified win-neutral: 33/35/33 team-win, ROI within ±2.5%"
> - "FFA Extraction: flat (±1%) across stakes"
> - "**FFA Mayhem: small stakes ≈ −40% ROI (structural).**"
> - "FFA **Extraction is the fair variant** (±1% across stakes)"
> - "money stays fair" / "±2.2% Mayhem, ±0.3% Extraction" in the 3-WAY line
>
> These describe `gameN.ts`. They were measured against it and remain valid statements ABOUT IT.
>
> **What IS measured about the deployed hash game** lives in `HOUSE-EDGE-STUDY.md` §11
> (current state, re-measured at the live 100 bps rate) and `HOUSE-STRATEGY.md` (the operator's
> own book). The one-line result: the deployed hash game is **size-neutral** — pre-fee ROI is
> within ±1% of zero at every stake band from $3 to $100, because `min(attacker.hp, defender.hp)`
> makes every exchange symmetric. So "small stakes ≈ −40%" and "±1% across stakes" are both
> statements about a different simulation.
>
> `engine/` (which runs `gameN.ts`) is a SEPARATE product from the on-chain arena, with its own
> separate fee: `engine/src/arenas.ts:40` `export const FEE = 0.002` (20 bps), whereas the
> on-chain arena charges 100 bps. They are not the same economy and the numbers do not transfer
> in either direction.

# Arena matrix build spec (locked with Max, 2026-08-06)

## Game types (each in Mayhem + Extraction economies)
| Arena | Sides | Notes |
|---|---|---|
| ANSEM vs UWU | 2 teams | today's game |
| ANSEM vs SOL | 2 teams | new |
| UWU vs SOL | 2 teams | new |
| 3-WAY | ANSEM vs UWU vs SOL | matched to the SMALLEST side's total (min rule — Max removed the median rule 2026-08-06); excess of both heavier sides refunded pro-rata; winner = highest ring+banked. Verified win-neutral: 33/35/33 team-win, ROI within ±2.5% |
| FFA (per token) | every fighter solo | BULL-only first (then UWU-only, SOL-only); biggest bag at the horn wins; raids hit anyone |

Mayhem = renamed Normal (pure rename, done). Internal mode key stays "normal".

## Money = USD units, live-priced (decided: live prices)
- `engine/src/prices.ts` (BUILT + TESTED): DexScreener, deepest-liquidity pair,
  ANSEM $0.17 / UWU $0.033 / SOL $74 at test time; 5-min staleness guard — never
  quote on a stale/null price (refuse deposits/withdrawals instead).
- Ledger keeps USD units. Deposit: tokens × price at credit time. Withdraw: units ÷ price
  at payout time. Price drift between the two is the house's exposure — show the quote
  ("you'll receive ~X UWU") before withdraw confirm.
- Devnet test arenas: test mints map 1 unit = $1 (price service bypassed until real mints).

## Engine restructure
- Arena registry: `{pairing, economy}` → RoundRunner instance + its own bot population
  (bot identities per token community incl. a SOL crowd). Env-tunable per arena.
- Sim: generalize `Side` from 2 hardcoded sides to N teams (teams array; FFA = each
  fighter its own team). Matched book: 2-way = min; 3-way = median rule; FFA = no
  matching (all-vs-all, no side to favour).
- ws protocol: messages gain `arena` id alongside mode; `state` carries the arena list
  for the picker. Keep backwards compat for the current two arenas during migration.

## Client
- Home/picker: cards per arena (live pot, players, next lobby countdown).
- Per-arena skin: ONLY the relevant sides render (SOL vs UWU shows no bull anywhere —
  side panels, deploy buttons, wallets filter by the arena's token set). 3-way renders
  three team panels + tri-color strength bar; FFA renders a single roster.
- Deposits per token (SOL native transfer for SOL side; SPL for the others).

## Order of work (next session)
1. Sim generalization to N teams + median matched book + FFA — with fairness study reruns.
2. Arena registry + protocol + bots per community.
3. Client picker + per-arena skins (2-way SOL pairings first, then 3-way, then FFA).
4. USD-unit deposits wired to prices.ts (real mints only).

## Step 1 results (2026-08-06) — N-team sim BUILT + MEASURED
`engine/src/gameN.ts`: N teams, FFA (teams=0, fighter=own team), median/min/none match
rules, per-team stolen-vector holdings (lose stolen first), same physics/fairness toolkit
(atomic clashes, size banding, per-stake dust, small edge). 11/11 correctness checks:
determinism, conservation incl. refunds in every mode, exact median refunds, degenerate
lobbies (lone fighter, empty team) refund cleanly.

Fairness (120 rounds each):
- 3-WAY median matching: money-neutral in both economies (heavy/mid/light ROI within
  ±2.2% Mayhem, ±0.3% Extraction). Team-WIN skew exists (mid 54% / light 5% in
  Extraction) — the known median-rule trade; money stays fair.
- FFA Extraction: flat (±1%) across stakes. Big stakes win the biggest-bag badge ~21%
  (they start biggest — consider an ROI-based "best multiplier" badge alongside).
- **FFA Mayhem: small stakes ≈ −40% ROI (structural).** Max's call 2026-08-06: ship big FFA anyway, no weight classes / rank payouts / insurance / respawn / bounties — players see the risk. FFA **Extraction is the fair variant** (±1% across stakes) and is the recommended mode. Cause is structural: death
  forfeits the ring, small fighters die more, survivors compound. A pairwise matched cap
  was tried and did not move the number (reverted). FFA launches EXTRACTION-ONLY.

Remaining: arena registry + ws protocol (arena ids), per-community bots, client picker +
per-arena skins (incl. 3-panel layout + FFA roster), USD-unit deposits via prices.ts.

## Step 2 DONE (2026-08-06) — nine arenas live in one engine

`roundN.ts` (commit-reveal orchestrator for N-team arenas) + registry wiring: the engine now
runs **9 arenas concurrently** — au/as/us x mayhem/extraction, plus `3w-normal`,
`3w-extraction`, `ffa-extraction`. Each has its own bot community banked in that arena's
tokens; N-arena entries are keyed `wallet|team` and settle into the team's token field.

Verified live: 3w rounds conserve value exactly and independently recompute from the seed
(454 and 2014 hits reproduced), team totals broadcast per round, winner by highest ring+banked.
Client: arena cards mark 3-WAY and BULLS FFA live and open a live status panel (round, phase,
fighters, per-team totals with win highlight). Players can enter via `enterN` (wallet|team).

Remaining for these two: full canvas replay (client-side N-team sim port, mirroring what
game.ts/simulateRoundJS does for 2-team) so 3-way/FFA render as battles rather than status.
