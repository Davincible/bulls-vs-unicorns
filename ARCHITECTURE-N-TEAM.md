# ARCHITECTURE-N-TEAM.md

Nine arenas, real custody, one system. A design, not a plan of record — every number in
here that is measured says so, and every number that is a guess says that too, with the
measurement that would settle it.

Written 2026-08-09 against `CH7K8rDXgPQRs9CCHG9EK5kd1YSDZyPkCDGArcz4PSNP` (v5 id),
`engine/` at the nine-arena state ARENAS.md records, and `er-demo/src/v2` reading the chain
directly.

---

## 0. The thing that has to be said first

**`engine/src/gameN.ts` is not the reference implementation of the on-chain fight, and it
cannot become one.**

There are two different games in this repository:

| | `engine/src/game.ts` + `gameN.ts` | `programs/bulls-arena` + `engine/src/er-sim.ts` |
|---|---|---|
| Fight | 2D physics — positions, velocities, collision detection, target selection by distance x size ratio | hash chain — `sha256(seed ‖ le64(step))` picks an attacker and a defender |
| Arithmetic | IEEE double | u64, floor division, saturating subtraction |
| Per tick | O(n^2) pairwise collision over `ARENA_N = 900x560`, plus per-fighter steering | one hash, two modulos, one multiply-divide |
| Ticks | `battleMs / tickMs` = 800 | `canonical_cursor`, up to `MAX_STEPS = 4,000` |
| Damage | `sqrt(ring(a)*ring(b)) * base * roll()`, capped, with `SMALL_EDGE`, `SIZE_WEIGHT`, `FINISH_RATIO` | `hp * (4..27) / 100`, `DUST` floor |

The physics sim cannot go on chain. Not "would be expensive" — cannot. Floating-point
determinism across a BPF target and a browser is not a thing you get by being careful, and
800 ticks x 120 pairs x trigonometry is orders of magnitude past 1.4M CU. The on-chain game
is the hash sim, and it always was.

**The consequence, which is the single most important sentence in this document: the
fairness results in ARENAS.md are measurements of `gameN.ts`, and they do not transfer.**

- "3-WAY min matching: 33/35/33 team-win, ROI within +/-2.5%"
- "FFA Extraction: flat (+/-1%) across stakes"
- "**FFA Mayhem: small stakes ~= -40% ROI (structural)**"

All three are 120-round studies of a physics sim with size banding, a small-fighter edge, a
per-hit cap fraction and a dust fraction proportional to deposit. The hash sim has none of
that machinery. It has a flat percentage roll (4-27% of remaining hp), an absolute dust
floor of 1,000 units, and uniform random attacker/defender selection. Those are different
economies. Carrying ARENAS.md's numbers onto the chain game would be this project claiming a
measurement it does not have, which is precisely the failure mode every doc comment in
`lib.rs` is written to prevent.

**What is carried is the DECISION and the MECHANISM, not the number.** FFA ships
extraction-only, no weight classes, no rank payouts, no insurance, no respawn, no bounties —
that stands and is not re-litigated. The mechanism Max identified is structural and is
present in the hash sim too, arguably *more* strongly: death forfeits the whole ring, small
fighters die sooner, survivors compound. The hash sim has no `SMALL_EDGE` and no
`hitCapFrac` to damp it. The prior is that FFA Mayhem on chain is *worse* than -40%, not
better. That prior is worth nothing until Phase 0 measures it, and the design below makes
FFA Mayhem structurally unrepresentable so the measurement is never load-bearing in
production.

---

## 1. Phased sequence

The working assumption was: N-team program -> custody -> engine services -> retire.
**Confirmed on the middle, overturned at both ends.** Two changes, one insertion.

### Phase 0 — Measure the N-team hash sim in TypeScript. No Rust. No deploy.

**0a.** Generalise `engine/src/er-sim.ts` into `er-simN.ts`: N teams, per-mint holdings
vector, economy flag, matched book. Pure TypeScript, BigInt arithmetic, same
mirror-the-Rust-including-its-integer-semantics discipline.

**0b.** Re-run the fairness study — `engine/src/study.ts`'s methodology, 120 rounds per
configuration minimum — against `er-simN` for all nine arena shapes. Report ROI by stake
band and team-win distribution exactly as ARENAS.md does, so the two tables are comparable
and the difference between the physics game and the chain game is visible rather than
assumed.

**0c.** Re-measure the pacing table and `PENALTY_HORIZON_STEPS` per arena shape. Both are
`~C*n^1.5` fits measured against the 2-team hash sim. Neither survives N teams unexamined:
`fight_is_over` for FFA means *one fighter left*, not *one team wiped*, which is a
categorically longer fight.

**Gate.** If 3-way min-matching is not money-neutral under the hash sim, or if FFA
Extraction is not flat across stakes, stop. Redesign the fight, not the account layout.

**Why first.** This is the cheapest reversible experiment available and it constrains the
most expensive irreversible commitment. TypeScript iterates in seconds. The Rust iterates in
a program deploy, and deploys cost ~2.3 SOL and all program state each.

### Phase 1 — Fix the denomination. An ADR, not code.

One decision, written down before any account layout exists (§3.1): the fight runs in USD
micro-units; a fighter's holdings are a **vector indexed by mint slot**; the price is frozen
per round; a wrong price is a *fairness* bug and not a *solvency* bug.

Custody is implemented in Phase 3, but custody's denomination decides the shape of
`Fighter`. Build N-teams with a scalar `hp` and then add custody, and you rewrite the account
and the fight loop a second time — another program id, another ~2.3 SOL, another loss of all
round history. **The N-team program comes first, and it must already be wearing custody's
clothes.**

### Phase 2 — The N-team program on a fresh id. No tokens yet.

Arena PDAs keyed by arena id. `Round` carries mint-slot vectors, `economy`, `team_count`,
frozen prices. Entry **moves to the base layer**; delegation moves to **after** the lobby
closes (§4.2). `zero_copy` if the build warns (§3.5).

Gate: Rust <-> `er-simN` parity green for all nine shapes; a `bench_fight` CU sweep per
shape; all nine arenas running rounds on devnet, custodying nothing, before a token moves.

### Phase 3 — Custody, plus the price feed.

A rewritten `programs/arena-vault` as a **separate program** (§4.3). Per-round escrow. Close
the `Drawing`-has-no-exit hole *before* money enters. Emergency drain path for the next
forced id migration. `prices.ts` lands here, not Phase 4, because `enter` needs a price at
the moment it credits a deposit.

Gate: audit (§4.6); a canary round; solvency derivable from accounts alone with no daemon.

### Phase 4 — Port the remaining services.

Bots -> real wallets + keeper. Arena registry -> on-chain `Arena` accounts. History ->
events + indexer. Referrals -> decide: on chain or gone.

### Phase 5 — Strangler. Parallel run, arena by arena.

**The insertion.** `engine/` keeps running each arena while the chain runs the same arena,
and an arena is switched off in `engine/` only after its chain twin has run a measured number
of rounds whose settlement reconciles against the engine's independent recomputation.
`ENABLED_ARENAS` in `engine/src/arenas.ts` is exactly that valve.

A big-bang cutover fails for a specific reason: `engine/` holds real balances in SQLite, and
there is no atomic operation that moves a ledger row into an on-chain escrow. Migration is
per-player withdrawal from the old system and per-player deposit into the new. That is a slow
drain, and it needs both systems alive during it.

### Phase 6 — Delete.

`engine/src/{server,ledger,store,auth,allowlist,limits,redact,round,roundN,game,gameN,bot-bank,chain-ops,swap,memo,recover-float}.ts`, and `web/index.html`. Delete, do not archive.

---

## 2. What the ordering buys, stated as bets

| Bet | If wrong, you find out |
|---|---|
| The hash sim's N-team economics are salvageable | Phase 0, in TypeScript, for free |
| <=3 mints per arena is stable | Phase 1, on paper |
| `Round` at ~1,800 B fits the 4 KB stack | Phase 2, in a build warning |
| N-team `run_fight` fits 1.4M CU | Phase 2, in a `bench_fight` sweep on a local validator |
| Per-round escrow bounds validator trust acceptably | Phase 3, in an audit |
| Players will migrate balances by hand | Phase 5, in the drain rate |

Every one is discovered before the phase that would have made it expensive.

---

## 3. The N-team on-chain design

### 3.1 Denomination — the decision everything else hangs off

Three facts collide:

1. The fight must run in a **common unit**. 100 raw ANSEM ($17) against 100 raw UWU ($3.30)
   is not a fight, it is a mugging.
2. Custody must be **per-mint exact**. A UWU fighter raided to zero by an ANSEM fighter
   leaves the vault holding surplus UWU and owing ANSEM it does not have. **Every cross-token
   raid is a `convert`.**
3. Tokens **cannot enter the ER** (§4.1), so the fight moves abstract quantities while the
   tokens sit on the base layer — and the two must be reconcilable exactly, later, by a
   program.

**The resolution: value is USD micro-units, and every fighter's holdings are a vector indexed
by mint slot.**

```text
MAX_TOKENS = 3          // 3-WAY is the widest arena in the locked spec.
deposit:   player sends `amt` of mint m; program credits `units = amt * price[m]`
           and the vault holds `amt` of m.
raid:      moves units from D's vector to A's vector, PRESERVING THE SLOT INDEX.
settle:    fighter is owed, per slot i, `units_i / price[i]` of mint i.
```

Per-mint conservation is exact by construction: raids only move units *within* a slot, so
`sum_fighters units_i` is invariant and equals what was deposited in mint `i`.

Three properties fall out, and they are the whole reason to choose this:

- **The swap/solvency blocker disappears by construction.** No Jupiter, no PumpSwap, no
  per-mint drift. The vault never holds a token it was not given.
- **Price is a fairness parameter, not a solvency parameter.** A wrong price makes a stake
  render larger or smaller in the ring. It cannot make the vault insolvent, because credit
  and redemption use the *same* frozen number. Much weaker than the engine's model, where
  price drift between credit and payout is explicitly "the house's exposure".
- **You win the coins you took.** "You raided 340 UWU off KESTREL_42" is a better product
  statement than "you are owed $11.22", and it is the one the chain can prove.

The alternative — settle everyone in their own team's token, house absorbs the imbalance — is
what `engine/` does today. It requires market-making inventory against three pump.fun tokens
forever, with a solvency daemon watching it. That is a second business. Reject.

### 3.2 `Fighter`, `Round`, `Arena`

```rust
pub const MAX_TOKENS: usize = 3;
pub const MAX_FIGHTERS: usize = 16;   // unchanged

pub struct Fighter {
    pub wallet: Pubkey,               // 32
    pub team: u8,                     //  1  0..team_count-1; FFA: == fighter index
    pub dead: u8,                     //  1
    pub stake: u64,                   //  8  gross-of-match, net-of-fee, in units
    pub unmatched: u64,               //  8  matched-book refund, own mint
    pub ring: [u64; MAX_TOKENS],      // 24  in-ring value, BY ORIGIN MINT SLOT
    pub banked: [u64; MAX_TOKENS],    // 24  safe value, BY ORIGIN MINT SLOT
}                                     // 98 B  (was 58)
```

`side: u8` becomes `team: u8` — a team is an index into the arena's team list, and for FFA a
fighter's team *is* its index, exactly as `gameN.ts`'s `teamOf(e, i) = ffa ? i : e.team`.

```rust
pub struct Round {
    // ... arena, round_no, phase, winner_team, bump, fighter_count
    pub team_count: u8,                // frozen at lobby close; FFA sets it = fighter_count
    pub mint_count: u8,                // 1..3, from the Arena
    pub economy: u8,                   // 0 = extraction, 1 = mayhem
    pub pot: [u64; MAX_TOKENS],        // per-mint, in units
    pub penalties: [u64; MAX_TOKENS],  // per-mint — see below
    pub price: [u64; MAX_TOKENS],      // FROZEN at open_round
    pub price_published_at: i64,       // staleness, checkable by anyone
    // ... seed_commit, seed, lobby_opened_at, lobby_closes_at, fight_started_at
    pub fighters: [Fighter; 16],       // 1,568
}
// 8 + 224 + 1,568 = 1,800 B   (was 1,093)
```

`penalties_collected: u64` **must** become a vector. The extract penalty is a slice of a ring
that is a mix of mints; skimming it as a scalar breaks per-mint conservation on the first
extract in a 3-way arena.

The conservation identity, per mint slot `i`:

```text
sum_fighters ( ring[i] + banked[i] ) + penalties[i]
  + sum_fighters unmatched*[i == own_slot]  ==  pot[i]
```

Still exact, still provable from the account alone. Every one of the six existing verifiers
moves with it.

**The Arena PDA seed changes from `[ARENA_SEED]` to `[ARENA_SEED, arena_id]`.** Nine arenas
need nine. This destroys all existing state — which costs nothing extra, because the deploy
carrying it needs a fresh program id anyway. **Bundle every PDA reshape you will ever want
into this one deploy.**

**`match_rule` has no median.** ARENAS.md records that Max removed it on 2026-08-06 in favour
of min. `gameN.ts` still implements it. Do not port the dead branch — an unreachable rule in a
fairness-critical function is a rule someone reaches by accident.

### 3.3 The matched book — on chain, at lobby close

```text
totals[t] = sum over fighters on team t of stake
cap       = min over t of totals[t]            (match_rule == min)
in_play   = (stake * cap) / totals[team]       clamped at stake
unmatched = stake - in_play
```

On chain, in `close_lobby`, for three reasons: it determines payouts (anything that decides
money is a chain fact); lobby close is the moment the lineup is frozen and the seed does not
yet exist, so no participant can act on knowing the book; and the cost is two passes over
<=16 fighters against a loop that runs thousands of hash steps.

Refunds are **recorded, not paid** at lobby close — 16 SPL transfers in one instruction risks
the size and CU limits. `unmatched` rides through the fight untouched and pays at claim.

### 3.4 `advance_fight` at N teams

The hash chain, the modulo selection, the `d == a` bump, the roll, the `DUST` floor and the
`% 100` are **byte-identical to today**. Deliberate and non-negotiable: one seed derivation,
one mirror, nine arenas. Three things change, all inside damage application:

**(a) Same-team skip.** `side` -> `team`. Identical cost, very different *frequency* — that is
the CU story (§3.5).

**(b) Take order.** Stolen slots first, largest first, then own:

```text
order = slots except own_slot(d), sorted by ring[slot] DESCENDING, STABLY
        (ties keep ascending slot index)
then own_slot(d)
```

The stability is not pedantry. `gameN.ts` uses `Array.prototype.sort`, stable since ES2019, so
a tie between equal stolen pots resolves by ascending index. Rust's `sort_by` is stable;
`sort_unstable_by` is not. Getting it wrong diverges only when two stolen pots are exactly
equal — which with integer units and equal stakes is **common, not rare**. Use `sort_by`, and
put the tie in the parity fixture explicitly.

**(c) Economy.** Extraction: taken value lands in `attacker.banked[origin]`. Mayhem: it lands
in `attacker.ring[origin]`, re-raidable. One branch — and note the deployed program has no
such branch, so today's live arena is really `au-extraction`.

**FFA Mayhem must be made unrepresentable, not defaulted-off.** `init_arena` rejects
`match_rule == none && economy == mayhem`. A config default is a thing someone changes at 2am;
a `require!` is not.

**Winner remains a badge.** No payout depends on it — settlement is per-fighter
`ring + banked + unmatched`.

### 3.5 Account size and compute — with the guesses labelled

```text
Fighter      58 B  ->    98 B      (+69%)
Round     1,093 B  -> 1,800 B      (+65%)
rent      0.0085  ->  0.0134 SOL
```

The 4 KB stack binds, because `Account<Round>` deserialises onto it. The recorded failure was
40 fighters at 58 B ~= 2.45 KB. 1,800 B leaves ~27% margin to an observed break point that is
itself not clean.

**Measurement is one command:** `cargo build-sbf` emits `Stack offset of N exceeded max offset
of 4096` at compile time. Build the struct and read the log.

**Recommendation regardless: convert `Round` to `#[account(zero_copy)]` + `AccountLoader` in
Phase 2.** It removes the stack copy entirely — the fix `MAX_FIGHTERS`'s own comment already
names as correct — decouples size from an invisible limit, and deletes deserialisation from
`resolve`'s unmeasured remainder. Cost: `repr(C)`, no `Option`, no enums, `load()`/`load_mut()`
everywhere, and every client read path changes. A real change, not a decorator. Still correct.

**Compute — guessing, and here is exactly how.** Measured today: ~271 CU/step early falling to
~198 as fighters die; 4,000 steps = 864,996 CU (61.8% of ceiling).

1. **Skip rate collapses.** 2 teams: ~half of pairs are same-team and take the cheap
   `continue`. 3 teams: ~1/3. **FFA: zero.** Dominant effect, and combinatorics, not a guess.
2. **Damage path heavier.** `ring_total` over <=3 slots, a stable sort of <=3, up to 3
   subtract/add pairs, a re-sum for `dead`. **Guess: +60 to +120 CU.** No basis for tighter.
3. **FFA fights are longer** — `fight_is_over` means one fighter standing.

```text
arena shape        guessed CU/step     4,000 steps      verdict
2-team             ~300-320            1.20-1.28M       86-91% of ceiling, loop alone
3-way              ~320-350            1.28-1.40M       at or past the ceiling
FFA                ~350-400            1.40-1.60M       OVER
```

If near right, **`MAX_STEPS = 4,000` does not survive N teams and must become per-arena** — and
lowering it collides with the bell (16 fighters x 32 steps/s x 120 s = 3,840 steps). The knobs
are `FIGHT_TIMEOUT_SECONDS` and `STEPS_PER_FIGHTER_PER_SECOND`, per arena.

**The measurement that settles it:** extend `bench_fight` to `(steps, fighters, teams, mints,
economy)`, keep it calling `run_fight` directly — the discipline earned the hard way when a
hand-copied stand-in drifted enough to make a real `resolve` exceed 1.4M CU — and sweep on a
local `solana-test-validator`. CU is deterministic in bytecode and inputs, so this is as real
as devnet and costs no SOL. Then verify the actual total with a real settled round.

### 3.6 Keeping the mirror byte-identical

1. **One hash chain for all nine arenas.** One `advance_fight`, one mirror, not nine.
2. **`er-simN.ts` is the mirror; `gameN.ts` is not and never was.** What survives `gameN.ts` is
   `study.ts`'s *methodology*, repointed.
3. **The fixture generalises, not multiplies** — one case per arena shape, plus three the
   current fixture does not cover: a stolen-slot tie (pins the stable-sort tie-break), a Mayhem
   re-raid (exercises ring/banked routing both ways), and a min-matched 3-way with uneven
   totals (pins `unmatched` in the fixture, not only in a unit test).
4. **`the_typescript_mirrors_carry_the_same_penalty_curve` extends to every new per-arena
   constant.** A constant in two files and checked in neither has already drifted.

### 3.7 Two existing defects that N teams makes worse

**`extract` does not say which fighter.** `enter` keys on `(wallet, side)`, so one wallet can
hold a fighter on both sides — and `extract` pulls whichever appears first, not the one the
player meant. With three teams it is worse; with real money it is a support ticket with a
transaction hash attached. Fix: `extract` takes a `team: u8`. (Preferred over one-entry-per-
round: hedging across teams under the min rule is a real strategy, and forbidding it is a
bigger product change than adding an argument.)

**`Phase::Drawing` has no exit.** Today a stuck row. **With custody, frozen player funds.**
Close it in Phase 2, so it is proven on a round holding nothing.

---

## 4. Custody

### 4.1 The crux, stated plainly

A delegated account cannot be touched by base-layer programs. That is not a limitation you
engineer around — it is what delegation *is*. An SPL token account whose owner is changed to
the Delegation Program is no longer a token account.

**Therefore: tokens never enter the ER.** The ER holds the round's game state — the part that
mutates every tick and genuinely needs 10 ms blocks — and nothing else.

The consequence must be said in the UI, not buried: **`extract` makes your value safe, not
liquid.** Pressing extract moves your ring into `banked` inside the rollup, where nothing can
raid it. Tokens arrive when the round settles, undelegates and you claim. This does not weaken
the latency argument at all — the *decision* is real-time and irreversible at the instant you
make it, which is the entire mechanic. The *payment* was never the thing that needed 10 ms.

### 4.2 The lifecycle

```text
BASE LAYER
  open_round(arena, round_no, lobby_seconds, price[])
      Round created, Lobby, prices FROZEN + stamped. Refuses on a stale price.
  enter(team, amount_tokens)                       <- MOVED FROM THE ER
      SPL: player ATA -> round escrow ATA (team's mint slot)
      SPL: player ATA -> arena treasury ATA (fee_bps)
      credit Fighter { team, stake = net * price[slot] }
      session-key signable, exactly as today
  close_lobby()        freeze lineup, team_count, matched book, unmatched. Permissionless.
  delegate_round()     <- MOVED: was at lobby OPEN. Escrow ATAs are never delegated.

EPHEMERAL ROLLUP
  close_lobby_and_draw -> callback_seed -> tick* / extract* -> resolve -> close_round

BASE LAYER
  claim(fighter_index)
      permissionless; pays ONLY that fighter's own ATAs
      per slot i: tokens = (ring[i] + banked[i]) / price[i], plus unmatched in own slot
      last claim closes the escrow ATAs and the Round, returning rent to the opener
  sweep_penalties()    house claims penalties[] per mint from the same escrow
```

**Moving `enter` to the base layer is forced, and it retires two documented hazards for free.**

- `MIN_LOBBY_SECONDS` exists because nobody can enter until `delegate_round` lands, so the
  hand-off (measured 1.70 s / 1.87 s) comes out of the entry window. Delegating *after* the
  lobby closes deletes that interaction.
- The cross-domain clock skew (measured +0.53 to +0.88 s median, +1.72 s worst, systematically
  ER-ahead) exists because the deadline is stamped on base and compared in the ER. With entry
  on the base layer, stamp and comparison are the same clock. **The hazard stops existing.**

Cost: entry runs at 400 ms slots instead of ER speed. For a 60-second lobby that is not a cost.
Session keys work identically — the `SessionToken` PDA is a normal base-layer account.

### 4.3 Two programs, not one

**Custody goes in a separate program.** `programs/arena-vault`, a rewrite of `programs/vault`.

The argument is program id churn. ER validators cache bytecode by program id and do not
invalidate on upgrade — four ids so far. **The documented workaround for shipping a fix to an
ER-delegated program is to deploy a different program**, at ~2.3 SOL and total loss of every
PDA keyed by the old id. Today that loses round history. With custody in the same program, **it
would strand player funds in escrow PDAs of a program you can no longer usefully upgrade.**

The seam: the vault stores a settable `game_program` pubkey and releases only on a CPI signed
by a PDA of the registered game program. One bounded, auditable knob versus stranded funds on
every forced migration — and the exact line the audit should concentrate on.

**Do not use `programs/vault` as written.** Its `withdraw` requires `settlement_authority` to
co-sign, making one hot key sufficient to move funds (constrained in destination, not amount or
entitlement). Under this design `claim` needs **no operator signature at all** — the entitlement
is a settled on-chain Round. Strictly stronger, and it deletes a key from the threat model. It
also hardcodes two mints and `enum Side { Bull, Uwu }`.

### 4.4 Where the trust boundary actually sits

**The ER validator can rewrite the round's final state, and that state decides who gets paid.**
It cannot be argued away, only bounded.

**(a) Per-round escrow, not a pooled treasury.** The important one, and purely architectural.
Escrow PDAs per `[ESCROW_SEED, arena, round_no, mint]`. A malicious commit can then at worst
**redistribute one round's pot among that round's own fighters** — it cannot reach another
round, another arena, or the treasury. That converts "the validator can drain the house" into
"the validator can decide who wins one round it is already refereeing". Make illegal states
unrepresentable: the escrow's *address* is the bound, not a check someone remembers to write.

**(b) Conservation enforced at claim time on the base layer.** The vault re-derives the §3.2
identity per mint and refuses if it fails. Does not stop redistribution; stops **inflation**.

**(c) Pin the validator.** `DelegateConfig { validator }` is already threaded through. For a
custodial closed beta, run your own — and **say so in the UI. Do not claim "non-custodial"
while an operator-selected validator can rewrite settlement.**

**(d) The named upgrade path: a challenge window.** The fight is a pure function of
`(seed, entries, cursor)`, so a fraud proof is the right shape: commit optimistically, let a
challenger force step-by-step re-execution over a bounded range, slash on mismatch. Real work,
out of scope, named so the design records what "trustless" would actually require.

### 4.5 Liveness — funds must never depend on the operator showing up

```text
fight running    -> anyone may `resolve` once fight_is_over OR the bell rings
Settled          -> anyone may `close_round`
undelegated      -> anyone may `claim(i)`, paying only fighter i's own ATAs
under-subscribed -> anyone may `abandon_round`; every stake refunds at claim
Drawing stalled  -> MUST become abandonable on a timeout (§3.7) — today it is not
```

No step requires the arena authority. An operator who walks away costs players nothing but gas.

**The one hole that cannot be closed from here, flagged as an open question rather than
guessed:** what happens to a delegated account whose ER validator is permanently down? Is there
a base-layer forced-undelegation path, and after what timeout? If none, a validator outage
freezes that round's escrow indefinitely — and per-round escrow is the only thing keeping that
from freezing everything.

**This is the single largest unknown in the custody design and must be answered before real
money.** Read the Delegation Program source for a timeout-based undelegate; if none, ask
MagicBlock — `MAGICBLOCK_FEEDBACK.md` is the vehicle and this is sharper than anything in it.

### 4.6 What has to be audited

Not "the vault". These: (1) `claim`'s authorization — own ATA only, once, that round's escrow
only, and `sum payouts <= escrow` per mint, checked; (2) escrow PDA seeds and the release CPI's
signer seeds; (3) the vault<->game seam and what the settable `game_program` can do in the wrong
hands; (4) `enter`'s token math — fee skim, `amount * price`, u128 intermediates, mint<->slot
mapping (a confusion here credits the wrong pool and is silently unrecoverable); (5)
`close_lobby`'s matched book, including degenerate lobbies; (6) phase totality, `Drawing`
included — a money property now; (7) the price path and a written argument for why a wrong price
cannot cause insolvency; (8) the emergency drain — itself the most dangerous function, needing a
timelock or multisig, not a hot key; (9) rounding — three floor-divisions per extract, `units /
price` at claim, dust falling to the house and never below zero.

Per README's checklist: the settlement authority — reduced here to admin functions only —
should be a Squads multisig.

---

## 5. The engine port — where the effort actually is

**Carries.** `prices.ts` (logic survives; consumer changes completely — it stops feeding SQLite
and starts feeding an on-chain price the program freezes per round). Bot communities
(`bot-wallets`, `seed-bots`, `strategy`) — bots become ordinary wallets calling `enter`/`extract`
via a keeper with session keys; ~5,000 lamports per fighter-round, ~0.02 SOL/hour at nine arenas.
`arenas.ts` as a client-side mirror, with `ENABLED_ARENAS` as Phase 5's valve. **`study.ts`'s
methodology** — the most valuable thing in `engine/` and the only reason ARENAS.md is credible.

**`bot-bank.ts` dies and its invariant survives, enforced by the chain instead of by
accounting** — a bot wallet can stake exactly what its ATA holds. The best outcome a module can
have.

**`reconcile.ts` changes role from control to alarm.** Under per-round escrow with a
program-enforced conservation check, solvency is structural. Keep `evaluate()` as a monitor: if
it fires it means a program bug or a bad commit, and the response is "halt new rounds", not
"freeze withdrawals". **A system where the operator can freeze your withdrawal is a system where
the operator can freeze your withdrawal.**

**Dies:** `server.ts` and the ws protocol; `ledger.ts` + `store.ts` (the point of the migration);
`round.ts`/`roundN.ts`; `game.ts`/`gameN.ts`; `bot-bank.ts`; `swap.ts`; `memo.ts` (anchoring a
hash is meaningless when the round *is* on chain); `chain-ops.ts`'s deposit-verify and its
double-credit machinery; `recover-float.ts`. And with `server.ts`: `auth.ts`, `allowlist.ts`,
`limits.ts`, `redact.ts`, the rate limiter, the pen test and the DoS test. **That is a large
attack surface deleted, and it is a real benefit of the migration nobody has written down.**

**Three things with no home yet — decide, do not drift:**

1. **Round history.** The v2 page reads round *accounts*; §8 says accounts must be closable or
   rent kills you. **Incompatible.** History moves to events + a light indexer. Correct boundary
   anyway: a chain account is not a database.
2. **Referrals.** Real money path, no on-chain construct in any design here. Either it becomes
   one (`referrer: Option<Pubkey>`, treasury split at `enter`) or it is dropped. **Do not keep an
   off-chain ledger "just for referrals"** — two sources of truth for money is the debt being
   repaid.
3. **Names, avatars, per-arena stats.** `nameFor()` already derives a stable pseudonym from the
   wallet with no lookup. Avatars and cumulative stats belong to the indexer, or they go.

**Front end.** `Side = 0 | 1` appears **77 times across 27 files**. The load-bearing two are
`SIDE_TOKEN: [TokenMeta, TokenMeta]` and `sideTotals(): [bigint, bigint]` — both fixed-arity
tuples that become `readonly T[]` indexed by team. Per ARENAS.md: only the relevant sides render.

---

## 6. Risks, ranked

1. **The ER validator is trusted with the pot** (§4.4). Bound with per-round escrow, a
   conservation check, a pinned validator, and an honest UI.
2. **A forced program id migration with funds in escrow** (§4.3). Four ids in three sessions.
   Reason for a structural decision, not a monitoring item.
3. **`Phase::Drawing` has no exit** (§3.7). Today a stuck row; with custody, frozen funds.
4. **The CU ceiling, worst case FFA** (§3.5). This repo already produced **two permanently stuck
   rounds** from exactly this ("1,399,850 of 1,399,850 CUs consumed").
5. **The 4 KB stack** (§3.5). 27% margin against a threshold that is not clean.
6. **The fairness numbers do not transfer** (§0). Cheap in Phase 0, expensive after launch, and
   reputationally expensive in a repo whose register is "measured, not asserted".
7. **Regulatory.** Nine arenas is nine products; real custody makes the operator a custodian in
   fact; and **the FFA Mayhem measurement is now written down** — shipping a configuration your
   own repo records as grinding small stakes to -40% is a materially different posture from
   shipping it unmeasured. Hence `require!`, not a default.
8. **Rent and round-count economics.** ~0.0134 SOL per Round; nine arenas at a ~2-minute cadence
   is ~270 rounds/hour ~= **3.6 SOL/hour if rounds are never closed.** Round accounts must be
   closable and rent reclaimed at claim-out — which forces the History-from-events decision. A
   first-order constraint that reads like a detail.
9. **The price authority.** An operator can tilt a fight by mispricing, and with house bots on
   the other side that is self-dealing. Bounded, not eliminated.
10. **Multi-team entry against the min rule.** Hedging also inflates the matched cap.
    Unquantified — add a multi-team-entrant config to the Phase 0 study.
11. **Cross-domain clock skew.** *Retired* by moving `enter` to the base layer (§4.2). Listed so
    the removal is recorded rather than forgotten.

---

## 7. What I would not do

- **Not port `gameN.ts` on chain** (§0). Floating point, O(n^2), 800 ticks. Impossible, not
  expensive.
- **Not put tokens in the ER.** Structurally impossible, and it would freeze every balance for
  the length of every round.
- **Not raise `MAX_FIGHTERS` above 16.** **The scaling axis is more concurrent arenas, not
  bigger rounds** — which is what the nine-arena matrix is.
- **Not ship FFA Mayhem, and not merely default it off.** `require!` it.
- **Not keep the median match rule.** Removed 2026-08-06; `gameN.ts` still has the branch.
- **Not vary the hash chain per arena.** One mirror, one parity test, one fairness claim.
- **Not use `programs/vault` as written** (§4.3).
- **Not fold custody into the game program** (§4.3) — the one decision driven entirely by
  borrowed scenery rather than by anything in the code.
- **Not keep an off-chain ledger for referrals or stats.**
- **Not retire `engine/` before a measured parallel run** (Phase 5).
- **Not do a per-arena program.** Nine deployments, nine audit surfaces, nine chances to be
  forced onto a new id.
- **Not make `resolve` depend on anyone having ticked.** With custody, a permanently
  unsettleable round is permanently frozen money.
- **Not put per-hit data on chain.** Recomputable from the seed; at nine arenas it is nine times
  the cost of publishing your own homework.
- **Not add weight classes, rank payouts, insurance, respawn or bounties to FFA.** Max's call,
  2026-08-06. Carried, not re-opened.

---

## 8. Where I am guessing

| Claim | Status | What would settle it |
|---|---|---|
| `Round` ~= 1,800 B | derived arithmetic | borsh-encode it in the size test |
| 1,800 B fits the 4 KB stack | **guess** (27% margin to an observed, not clean, break) | `cargo build-sbf`, grep `Stack offset ... exceeded` |
| N-team damage path +60-120 CU | **guess**, no basis for tighter | `bench_fight(steps, fighters, teams, mints, economy)` swept locally |
| FFA needs `MAX_STEPS` < 4,000 | **guess** from the above | same sweep, then a real settled round |
| FFA Mayhem is worse than -40% on chain | **prior**, from mechanism only | Phase 0's `er-simN` study |
| 3-way min matching is money-neutral on chain | **unknown** — measured only on `gameN.ts` | Phase 0's `er-simN` study |
| Forced base-layer undelegation exists after a validator outage | **unknown** | read the Delegation Program source; else ask MagicBlock |
| Multi-team entry vs the min rule is not exploitable | **unanalysed** | add the config to the Phase 0 study |
| ~270 rounds/hour at nine arenas | assumption from a ~2-minute cadence | count what the keeper produces |

Every one sits in front of a phase gate, and none sits behind a program deploy. **That is the
only property of this plan worth defending hard.**

---

## 9. The bets, and when to revisit them

| Bet | Expires when |
|---|---|
| <=3 mints per arena | a fourth token joins one arena |
| 16 fighters is enough | real lobbies fill and turn players away |
| The hash sim is the game | someone wants the physics fight on chain — a different program, not a tuning change |
| The ER validator is trustworthy enough, bounded per round | third-party validators, or value-at-risk making dishonest refereeing worth more |
| Price is a fairness parameter, not a solvency one | anyone proposes settling in a token other than the one raided |
| Custody stays in its own program | MagicBlock invalidates the bytecode cache on `ProgramData` writes |
| The base layer is fast enough for `enter` | lobbies get short enough that 400 ms slots bite |

The last one plainly: this design bets that **entry is not latency-critical and extraction is.**
Everything about where the ER boundary sits follows from that one sentence. If it is wrong, the
boundary moves and most of §4 is rewritten. It is the load-bearing bet — and the pitch was never
"depositing is fast".
