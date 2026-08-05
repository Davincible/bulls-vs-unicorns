# Arena matrix build spec (locked with Max, 2026-08-06)

## Game types (each in Mayhem + Extraction economies)
| Arena | Sides | Notes |
|---|---|---|
| ANSEM vs UWU | 2 teams | today's game |
| ANSEM vs SOL | 2 teams | new |
| UWU vs SOL | 2 teams | new |
| 3-WAY | ANSEM vs UWU vs SOL | matched to the MEDIAN side's total; heaviest side's excess refunded pro-rata; winner = highest ring+banked |
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
