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
- **FFA Mayhem: UNSHIPPABLE — small stakes ≈ −40% ROI.** Cause is structural: death
  forfeits the ring, small fighters die more, survivors compound. A pairwise matched cap
  was tried and did not move the number (reverted). FFA launches EXTRACTION-ONLY.

Remaining: arena registry + ws protocol (arena ids), per-community bots, client picker +
per-arena skins (incl. 3-panel layout + FFA roster), USD-unit deposits via prices.ts.
