# ARENA-VAULT.md — custody for Bulls vs Unicorns

What it would take to hold real money, what is missing, and what has to be proven before a
dollar is accepted. Written 2026-08-15 against v8
(`ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe`), `MAX_FIGHTERS = 48`, `Round` at 3,248 bytes,
`fee_bps = 100`.

Every number below says whether it is **measured** (in this repo, with a command), **derived**
(arithmetic on measured numbers), **inherited** (taken from another document in this repo and
not re-verified here), or **unverified**. Where this document contradicts
`ARCHITECTURE-N-TEAM.md` §4 it says so out loud, in §9.

---

## 0. The recommendation

**Build it. Do not build it first, and do not accept a real dollar for at least three landings.**

The design is tractable and most of the hard thinking is already done. What is missing is not a
design — it is **three proofs, one of which nobody in this repo, or in MagicBlock's documentation,
has ever attempted.**

**The first thing to build is not code. It is two experiments (§7, E1 and E2), and E1 costs
nothing but a program id this repo has burned seven times already.**

### 0.1 What must be true before the first real dollar

Eleven gates. Nine are work; two are measurements that could come back "no", and if either does,
this design changes shape rather than schedule.

| # | Gate | Status today |
|---|---|---|
| G1 | **The rescue path is exercised against a genuinely unsettleable round** — not reasoned about, run (§7 E1) | **never attempted by anyone** |
| G2 | The mint decision is made and written down: single-mint first, or pay for the vector (§2.1) | **not decided** |
| G3 | `Phase::Drawing` has an exit (§5.2) | open defect, `lib.rs` `abandon_round` says so itself |
| G4 | The vault's solvency is derivable from **the vault's own accounts alone**, with no reference to a delegated account and no daemon (§3.4) | designed here, not built |
| G5 | `enter`'s lineup is pinned: `fighters[i].wallet == entries[i].player` checked on the base layer (§3.5) | designed here, not built |
| G6 | The spend allowance ships in the same deploy as custody (§6) | not built; §6.2 shows why it cannot be deferred |
| G7 | No instruction anywhere in `arena-vault` can send a token to an address that is not a recorded depositor's own ATA or the arena treasury ATA. Asserted by a test that reads the IDL, not by review | designed here |
| G8 | `arena-vault`'s upgrade authority is a Squads multisig on day one (§8.4) | not built |
| G9 | Rent reclamation observed working for a full day at 48 fighters | **still unobserved** — `COST-MODEL.md` §4's own caveat |
| G10 | Canary: 20 rounds at a stake small enough that total value at risk is under the cost of the audit | not run |
| G11 | Audit (§8.3), and the UI stops saying anything custody makes false (§8.5) | not run |

### 0.2 Why this is a "yes, later" and not a "no"

The reason to be careful about custody in a game is usually that nobody knows whether the game
takes money from players in ways the operator did not intend. **Here, that is measured, and it is
the strongest thing this repo has.** `HOUSE-EDGE-STUDY.md` §11, at the live 100 bps rate, against
the mirror asserted byte-identical to `advance_fight`:

- House take is **exactly 1.0000% of gross entries, 95% CI [1.0000, 1.0000]** — degenerate,
  because it is arithmetic at `enter`, not an edge that emerges.
- Conservation held **exactly in all 80,000 round-simulations**, and in `HOUSE-SMALL-STAKE.md`'s
  186 runs (max residual: 0 micro-units).
- The fight is a **martingale in `hp + banked` for every fighter**; `basis = min(attacker.hp,
  defender.hp)` is exactly symmetric, so expected transfer between any two fighters is zero
  whatever their sizes.
- Every stake band sits within one to two standard errors of −1.00%: whale −0.90%, minnow −1.55%,
  **spread −0.6%** against v5's +707.7%.
- The eight-wallet sybil farm that was worth **+$150.87/round** under v5 is worth **−$0.31**.

`ARCHITECTURE-N-TEAM.md` §6 ranks "the fairness numbers do not transfer" as risk 6 and says it is
cheap before launch and expensive after. **It has since been paid for.** That risk is retired for
the two-team, single-economy shape that is actually deployed — and it is retired *only* for that
shape, which is most of §2.1's argument.

So the question is no longer "is the economy safe to custody". It is "is the custody machinery
safe", and that is a smaller, more answerable question.

### 0.3 The one sentence a reader should leave with

**Today the correct trade is to strand rent rather than book a lie (`apply_sweep`'s own comment).
Under custody the correct trade is to strand rent rather than freeze money — and this design
achieves that without waiting for MagicBlock to ship anything.**

---

## 1. What changes, in one picture

```text
                       TODAY                        UNDER CUSTODY
  money                nowhere                      round escrow ATA, base layer, never delegated
  enter                inside the ER                base layer, in arena-vault, CPI to bulls-arena
  delegation           at lobby OPEN                after lobby CLOSE
  extract              ER, moves a struct field     unchanged — still a struct field
  settlement           an off-chain ledger's claim  permissionless claim from the escrow
  who can freeze you   nobody (nothing is held)     nobody — by construction, see §5
  program that churns  bulls-arena (7 ids so far)   bulls-arena only. arena-vault never churns.
```

Two sentences carry the whole design:

1. **The vault keeps its own base-layer record of every deposit, and that record is the ceiling on
   every payout it will ever make.** The rollup can decide *who* gets paid. It can never decide
   *how much in total*.
2. **The vault never needs the operator, the validator, or the delegation program to give a player
   their money back.** Everything the refund path reads was written by the vault itself, on the
   base layer, before delegation.

---

## 2. The scope decision nobody has made yet

### 2.1 One mint or two — and why this is the biggest number in the document

`ARCHITECTURE-N-TEAM.md` §3.1 resolves multi-mint custody with a holdings vector indexed by mint
slot and a price frozen at `open_round`. That resolution is correct and it is not cheap. It is
also **not required by custody** — it is required by *two mints*, and §4 never separated the two.

A two-mint arena forces, all at once:

- `Fighter` gains `ring: [u64; N]` and `banked: [u64; N]`; `penalties_collected` becomes a vector;
  `Round` grows and reshapes. New program id (which custody needs anyway) **and a new fight loop**.
- A price feed **in the money path**, with the audit item §4.6(7) attached: a written argument for
  why a wrong price cannot cause insolvency. §3.1's argument is sound (credit and redemption use
  the same frozen number) and it still has to be re-made against real code.
- Risk #9 — the price authority can tilt a fight, with house bots on the other side — becomes live.
- Three floor divisions per extract plus `units / price` at claim, so dust, so a residue in the
  escrow, so a rounding argument (§4.6(9)).
- **And this is the one that decides it:** the damage basis changes. Today
  `basis = min(attacker.hp, defender.hp)`, one scalar, and that exact symmetry is why the fight is
  a martingale and why every stake band sits on the rake and nowhere else. A slot-preserving raid
  over a vector reads a different basis. **`HOUSE-EDGE-STUDY.md` §11 and `HOUSE-SMALL-STAKE.md`
  do not survive that change, and they are the most valuable measurements in this repository.**

So the two-mint version asks the operator to take custody of real money **and** retire the study
that says the game is fair, in the same deploy. Two irreversible bets, one move.

**Recommendation: the first custodial arena is single-mint.**

What that buys, and it is a lot:

```text
payout(fighter i) = fighters[i].hp + fighters[i].banked          exactly, in tokens
escrow balance    = pot + fees_collected = gross_deposits         exactly, no division
conservation      = sum(hp+banked) + penalties + fees == gross    exactly, checkable on base layer
```

**No price, no oracle, no mint-slot mapping, no division, no dust.** `Round::gross_deposits()`
already exists in `lib.rs` and its doc comment already names this as the left-hand side of the
token-side solvency check. `Fighter.hp` in micro-units becomes token base units directly. Audit
items (4)'s mint↔slot confusion, (7)'s price argument and most of (9)'s rounding argument all
disappear because the things they are about do not exist.

What it costs, said plainly: **the cross-token raid.** "You raided 340 UWU off KESTREL_42" is the
product statement §3.1 is protecting, and a single-mint arena cannot make it. The two sides remain
BULLS and UNICORNS as an identity; the settlement token is one. That is a real product regression
and the operator should decide it, not inherit it.

The path back is not closed. Because the vault is a separate program that never churns ids
(§3.1), the cost of adding the mint vector *later* is exactly one `bulls-arena` deploy — ~2.4 SOL
and twenty rounds of history — with **no migration of funds and no change to the vault at all**,
provided every escrow records the game program it settles against (§3.2). That is the property the
two-program split was chosen for, and it is what makes staging affordable.

### 2.2 48 seats was decided when a seat was free

`MAX_FIGHTERS = 48` was chosen against a fight-length quality bar (76.2% conclude before the
180-second bell, against the 74.2% the old cap met) and its own comment records the reasoning
carefully. It was chosen in a world where `COST-MODEL.md` §1 could say: *"a fight with 44
participants costs the same five transactions as a fight with two."*

**Custody ends that.** Every seat becomes at least one base-layer transaction in and one payout
out, plus a real token position that must exist in a real wallet. §4.3 costs it. This is not an
argument to lower the cap today; it is a bet that has quietly expired and should be re-taken with
the new price attached.

---

## 3. The program boundary

### 3.1 Who owns what

**`programs/arena-vault` — a new program on a fresh id, never delegated, never upgraded for an ER
reason.**

Owns: tokens, the deposit record, the payout record, the spend allowance, and every instruction
that can move a token.

**`programs/bulls-arena` — unchanged in role.**

Owns: the round, the lineup, the fight, the phase machine, the treasury counters. Moves no tokens,
ever, in any version of this design.

**The reason for the split is unchanged from §4.3 and is the strongest argument in that document.**
ER validators cache bytecode by program id and do not invalidate on upgrade
(`MAGICBLOCK_FEEDBACK.md`, four separate entries; `lib.rs`'s file header records seven ids). The
documented workaround for shipping a fix to an ER-delegated program is to deploy a different
program, at ~2.4 SOL and every PDA keyed by the old id. **A game program that also held escrow
would strand player funds on the standard bug-fix procedure.** The vault is never delegated, so it
never meets that cache, so it never needs a new id.

`programs/vault` is not the starting point. Beyond §4.3's objections (a co-signing
`settlement_authority`, two hardcoded mints, `enum Side { Bull, Uwu }`), the workspace `Cargo.toml`
records a harder one: it is Anchor 0.30.1 and *cannot* share a dependency graph with the ER program
(solana-program 1.17 pins `zeroize <1.4`; `ephemeral-rollups-sdk` 0.16.2 needs curve25519-dalek 4.x
with `zeroize ^1`). `arena-vault` is written at `anchor-lang = "=1.0.2"` — the exact pin
`MAGICBLOCK_FEEDBACK.md` records as necessary — and needs **no** `ephemeral-rollups-sdk` dependency
at all, because nothing it owns is ever delegated. Delete `programs/vault` rather than archive it.

### 3.2 Accounts and PDAs

All seeds are under `arena-vault` unless marked.

```rust
/// One per (game program, arena). CREATE-ONLY. There is no setter for any field.
/// PDA: [b"vault_arena", game_program, arena]
pub struct VaultArena {
    pub admin: Pubkey,          // may create arenas. may NOT move a token. see §3.6
    pub game_program: Pubkey,   // the bulls-arena id whose Round accounts these escrows settle against
    pub arena: Pubkey,          // the Arena PDA under that program
    pub mint: Pubkey,           // §2.1: one, for now
    pub treasury_ata: Pubkey,   // owned by [TREASURY_SEED, arena] under game_program
    pub rescue_after_secs: i64, // frozen at creation. §5.1
    pub open_escrows: u32,      // the migration checklist, as one number. §5.5
    pub bump: u8,
}

/// One per round. zero_copy, for the reason MAX_FIGHTERS's comment gives.
/// PDA: [b"escrow", vault_arena, round_no.to_le_bytes()]
pub struct RoundEscrow {
    pub vault_arena: Pubkey,
    pub round: Pubkey,          // the Round PDA, derived and pinned at creation
    pub round_no: u64,
    pub deposited_gross: u64,   // THE CEILING. every payout path is bounded by this.
    pub paid_out: u64,
    pub treasury_owed: u64,     // fees + penalties, written at lock_settlement
    pub locked_at: i64,         // when close_lobby handed the round to the ER. 0 while Open.
    pub entrant_count: u16,
    pub state: u8,              // Open | Locked | Settling | Refunding | Drained
    pub bump: u8,
    pub entries: [EscrowEntry; 48],
}

pub struct EscrowEntry {        // 56 B
    pub player: Pubkey,         // 32
    pub gross: u64,             //  8  what this wallet actually sent
    pub payout: u64,            //  8  written once, at lock_settlement or open_refund
    pub claimed: u8,            //  1
    pub padding: [u8; 7],       //  7  declared, not implied — Fighter's own argument
}

/// The escrow's tokens. An ordinary ATA, owner = the RoundEscrow PDA. Never delegated.
escrow_ata = get_associated_token_address(round_escrow, mint)

/// The SPL delegate a player approves once. One stable address per arena.
/// PDA: [b"spender", vault_arena]     — holds nothing, signs transfers, owns no state
spender_pda

/// Who may spend a player's approval, how much, and until when. §6.
/// PDA: [b"spend", vault_arena, player, delegate]
pub struct SpendAuthorization {
    pub player: Pubkey,
    pub delegate: Pubkey,       // the session signer this authorises
    pub granted: u64,
    pub spent: u64,
    pub per_round_cap: u64,
    pub expires_at: i64,
    pub bump: u8,
}
```

Sizes and rent, at `(128 + size) × 6,960` lamports — the formula that reproduces `Round`'s measured
0.023497 SOL exactly, so this arithmetic is checkable:

| account | bytes | rent | derived/measured |
|---|---|---|---|
| `Round` (unchanged) | 3,248 | 0.023497 SOL | **measured**, `COST-MODEL.md` §1 |
| `RoundEscrow` | ~2,844 | **0.020685 SOL** | derived |
| escrow ATA | 165 | **0.002039 SOL** | derived |
| `SpendAuthorization` | ~104 | 0.001614 SOL | derived, once per player per delegate |

**Custody roughly doubles the rent float of a live round**, from 0.0235 to ~0.0462 SOL. Both halves
are reclaimable; §4.3 costs the float.

`RoundEscrow` at 2,844 B is one account, one write per entry, and one close. The alternative —
a `Receipt` PDA per player — was rejected on float: 48 receipts at ~0.0016 SOL is 0.077 SOL held
per live round against 0.0207 for the array, and it multiplies the account count in every
instruction that has to look a player up.

### 3.3 The interface between the two programs — one direction, one signer, no pointer that can be re-pointed

**`arena-vault` calls `bulls-arena`. `bulls-arena` never calls `arena-vault`.**

```text
arena_vault::enter(round_no, side, gross)                          [base layer]
  1. require escrow.state == Open
  2. SPL transfer  player_ata -> escrow_ata, `gross`
       authority = player            (enter, wallet-signed)
       authority = spender_pda       (enter_delegated, session-signed — §6)
  3. escrow.entries[entrant_count] = { player, gross }
     escrow.deposited_gross += gross
  4. CPI bulls_arena::enter(side, gross), signed by the RoundEscrow PDA
```

and on the other side, in `bulls-arena`:

```rust
/// `enter` no longer takes a player signature at all.
/// The only account that may credit a fighter is the escrow that took the tokens.
#[account(
    seeds = [b"escrow", vault_arena, &round_no.to_le_bytes()],
    seeds::program = arena.vault_program,
    bump,
)]
pub escrow_authority: Signer<'info>,
```

with `Arena.vault_program: Pubkey` **written at `init_arena` and never settable**.

Three consequences, and they are the point:

1. **A fighter cannot be credited without tokens having moved.** Not "a check nobody forgot" — the
   only key that can sign `enter` is the PDA of the account that just received the transfer, and
   the two happen in one instruction. Illegal state unrepresentable, at the `Signer` level.
2. **`arena-vault`'s solvency does not depend on `bulls-arena` at all.** The vault pays only from
   `entries[]`, which the vault wrote. A totally compromised game program can change *who* gets
   paid inside one round; it cannot make the vault pay a lamport more than that round's
   `deposited_gross`. This is §4.4(a)'s bound, enforced by the account that holds the money rather
   than by the address of the account that holds it.
3. **There is no settable `game_program` on the vault, and no CPI from the game program into the
   vault.** §4.3 proposed exactly that seam and called it "one bounded, auditable knob"; §9.2
   records why this design deletes it instead.

### 3.4 Settlement — the vault reads the Round's bytes, and needs no permission to

After `close_round` commits and undelegates:

```text
arena_vault::lock_settlement(escrow, round)                        [base layer, permissionless]
  0. round.owner == vault_arena.game_program        <- the whole authorization. see below.
     round.key  == escrow.round
     discriminator matches Round
  1. phase is Settled or Abandoned
  2. fighter_count == escrow.entrant_count
  3. for every i:  fighters[i].wallet == escrow.entries[i].player       <- §3.5
  4. pot + fees_collected == escrow.deposited_gross
  5. sum(hp + banked) + penalties_collected == pot                      <- Round::conserves()
  6. escrow_ata.amount >= escrow.deposited_gross
  7. entries[i].payout = fighters[i].hp + fighters[i].banked
     escrow.treasury_owed = penalties_collected + fees_collected
     escrow.state = Settling
```

**Step 0 is the entire authorization and it is structural.** A delegated `Round` is owned by
`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, not by the game program, so a delegated round
cannot be read here at all — the same refusal `sweep_house_take`'s comment already documents
`AccountLoader` making. There is no signer, no authority, no operator, and no pointer that could be
moved to make this read the wrong account.

**Steps 4 and 5 are two different checks and both are needed.** Step 5 is `Round::conserves()`,
which lives in `bulls-arena` and is the definition — the vault must not write a second one, for the
reason the code comment gives at length ("two implementations of a solvency check is how solvency
checks come to disagree, and the disagreement is discovered by a player who cannot withdraw"). That
requires a **shared layout crate**, `crates/arena-state`, holding `Round`, `Fighter`, `Phase`, the
identity functions and `the_account_layout_is_exactly_what_the_clients_decode`. Both programs
depend on it. Duplicating the struct in the vault would be the classic drift; the offsets test is
the thing that must have exactly one home.

Step 4 is the vault's own, and it is the one that cannot be delegated to the game program, because
it is the only check that ties the game's arithmetic to the tokens the vault actually holds.

**`lock_settlement` copies the payouts, so the escrow's life is decoupled from the Round's.** This
is not tidiness: `MIN_RETAINED_ROUNDS = 20` at 424 rounds/day is about **68 minutes**, and a player
who claims 90 minutes later must still be paid. After `lock_settlement` the Round can be closed and
`claim` reads nothing but the escrow.

The ordering is chain-enforced rather than keeper-enforced: **`close_round_account` gains a fourth
refusal — it will not close a Round whose escrow still needs to read it.** That mirrors the
swept-first rule exactly, and it needs the same check the swept-first rule got: does it strand
anything? No. An escrow that can never be locked is an escrow whose round is either still delegated
(in which case `AccountLoader` already refuses the close) or non-conserving (in which case the
escrow goes to `Refunding`, which satisfies the rule).

```text
arena_vault::claim(escrow, entry_index)                            [permissionless]
  pays entries[i].payout to get_associated_token_address(entries[i].player, mint)
  init_if_needed on that ATA, payer = whoever called
  entries[i].claimed = 1;  escrow.paid_out += payout

arena_vault::sweep_treasury(escrow)                                [permissionless]
  pays escrow.treasury_owed to vault_arena.treasury_ata

arena_vault::close_escrow(escrow)                                  [permissionless]
  requires every entry claimed and treasury swept; closes the ATA and the escrow;
  rent to whoever paid it; vault_arena.open_escrows -= 1
```

Every one is permissionless and every one has a destination derived from seeds rather than supplied
— `sweep_house_take`'s own argument, applied to real tokens. `claim` creating the ATA is
deliberate: 0.002039 SOL to create an account is cheaper than 0.0227 SOL of escrow held open
indefinitely because a player never made one, and `SOCIAL.md` §5.5.3 already assigns the keeper the
job of claiming for absent players.

### 3.5 What the lineup pin buys

Step 3 above — `fighters[i].wallet == escrow.entries[i].player`, in order, for all `i` — is cheap
(48 pubkey compares) and it is the difference between what §4.4(a) *claims* and what it
*enforces*.

§4.4(a) says a malicious commit "can at worst redistribute one round's pot among that round's own
fighters". Without this check that is not true: the ER owns `fighters[]`, so it could commit a
lineup containing a wallet that never deposited, and conservation would still hold. With it, the
set of payable wallets is fixed on the base layer before delegation, by the program that took the
money. The rollup's power is reduced to permuting amounts among wallets it did not choose.

The ordering property that makes the `==` form legal rather than needing a set comparison:
`entries[]` and `fighters[]` are appended in the same instruction, in the same order, by
`credit_entry`'s existing append-or-top-up. A top-up finds the existing fighter and does not
advance `fighter_count`; the vault must do the same (match on `player`, add to `gross`), which is
the one place the two programs' bookkeeping has to agree by construction rather than by check.

### 3.6 What the admin can do, exhaustively

- Create a `VaultArena`. That is the entire list.

There is no `set_game_program`, no `set_mint`, no `pause`, no `withdraw`, no `set_authority`, and
**no emergency drain.** §4.6 names the emergency drain as "itself the most dangerous function,
needing a timelock or multisig". §9.3 records why this design does not have one at all: the case it
existed for — a forced program id migration with funds in escrow — is answered structurally by
§5.5, and a drain that exists for a case that cannot arise is a key in the threat model earning
nothing.

**A system where the operator can freeze your withdrawal is a system where the operator can freeze
your withdrawal** — `ARCHITECTURE-N-TEAM.md` §5, about `reconcile.ts`. The same sentence forbids a
pause on `claim`, and this design does not have one. If the vault is broken, the response is "stop
opening rounds", which the keeper can do without any on-chain authority at all.

---

## 4. The revised round lifecycle

### 4.1 Where everything moves

```text
BASE LAYER
  bulls_arena::open_round(round_no, seed_commit, lobby_seconds)
  arena_vault::open_escrow(round_no)              creates RoundEscrow + escrow ATA
  arena_vault::enter | enter_delegated            <- MOVED OUT OF THE ER. n of these.
  bulls_arena::close_lobby()                      <- NEW. freezes fighter_count. permissionless
                                                     past the deadline; authority-signed early,
                                                     exactly as close_lobby_and_draw is today.
  arena_vault::lock_escrow()                      escrow.state = Locked, locked_at = now
  bulls_arena::delegate_round(round_no)           <- MOVED. was at lobby OPEN.

EPHEMERAL ROLLUP
  bulls_arena::draw()  ->  callback_seed  ->  tick* / extract*  ->  resolve  ->  close_round
                                                     nothing here touches a token

BASE LAYER
  bulls_arena::sweep_house_take(round_no)         counters, unchanged
  arena_vault::lock_settlement(escrow, round)     verifies and copies the payouts
  arena_vault::claim(escrow, i) × n               permissionless
  arena_vault::sweep_treasury(escrow)
  bulls_arena::close_round_account(round_no)      rent back
  arena_vault::close_escrow(escrow)               rent back
```

`extract` does not move and does not change. It banks `hp` inside the rollup and accrues a penalty
on the round, exactly as today. **The UI consequence §4.1 insists on stating out loud is real and
must be on screen: extract makes your value safe, not liquid.** The decision is real-time and
irreversible at the instant you make it, which is the whole mechanic; the payment was never the
part that needed 10 ms.

### 4.2 What moving delegation does to the keeper and the clock

**Retired outright, and worth recording as removals rather than leaving to be rediscovered:**

- **The cross-domain clock skew hazard is gone.** `lobby_closes_at` is stamped on the base layer by
  `open_round` and compared in the ER by today's `enter`. Measured skew is +0.53 to +0.88 s median
  and +1.72 s worst, systematically ER-ahead — the dangerous direction — against a catastrophic
  threshold of "skew exceeds the whole lobby duration". With entry on the base layer, stamp and
  comparison are the same clock. `Round.lobby_opened_at`'s long doc comment about this can be
  deleted, which is the best outcome a doc comment can have.
- **`MIN_LOBBY_SECONDS`'s reason for existing is gone.** It is 20 because nobody can enter until
  `delegate_round` lands (measured 1.70 s and 1.87 s). Delegating after the lobby closes means the
  hand-off comes out of the *gap between lobby and fight*, not out of the entry window.
- **The unmeasured multi-day delegation is gone.** `MAX_LOBBY_SECONDS = 604_800` and the hold-open
  policy mean a round is currently delegated for up to seven days, and that constant's own comment
  admits: *"The ceiling permits a week; it is not evidence that a week works."* Under this design a
  held-open lobby sits on the base layer, undelegated, indefinitely, and delegation lasts only the
  fight — a couple of minutes, the duration this repo has actually exercised. **This is a strict
  safety improvement and it is the least obvious benefit of the change.**

**Costs, derived from `COST-MODEL.md` §2's measured cadence:**

```text
                    today          under custody
lobby                60s            60s      unchanged
close_lobby            —           ~0.5s     one base-layer transaction
delegate              (at open)    ~1.8s     measured 1.70 / 1.87
fight                124s          124s      unchanged — the fight is untouched
result hold           12s           12s
overhead               8s           ~9s      one extra base-layer round trip
-------------------------------------
cycle                204s          ~207s  ->  417 rounds/day, from 424
```

**Fight length does not move at all**, so the measured table in `MAX_FIGHTERS`'s comment (median
124 s at n=48, 76.2% concluding before the 180 s bell) stands unchanged. That is the one thing
custody must not disturb and does not.

### 4.3 What it costs to run — the part `ARCHITECTURE-N-TEAM.md` §4 does not cost

`COST-MODEL.md`'s headline is **~0.030 SOL/day at 424 rounds/day**, resting on the measured fact
that a 44-fighter round costs **five base-layer transactions**. Custody ends that fact.

Base-layer transactions per round, at n = 48 (**derived**, and the batching factors are guesses
marked as such):

| | today | custody, unbatched | custody, batched |
|---|---|---|---|
| open / delegate / undelegate / sweep / close | 5 | 5 | 5 |
| open + close escrow | 0 | 2 | 2 |
| `enter` | 0 (in the ER) | 48 | ~16 (guess: 3 per tx) |
| `lock_escrow`, `lock_settlement`, `sweep_treasury` | 0 | 3 | 3 |
| `claim` | 0 | 48 | ~7 (guess: 7 per tx) |
| **total** | **5** | **106** | **~33** |
| fees at 5,000 lamports/tx | 0.000073 SOL* | 0.00053 | 0.00017 |
| **plus unreturned delegation** | **0.000405** | 0.000405 | 0.000405 |
| **per day at ~417 rounds** | **0.030 SOL** | **0.22 SOL** | **0.070 SOL** |

\* measured; the others derived from it.

**CORRECTED 2026-08-15.** This table originally costed custody against a ~0.030 SOL/day baseline. The
baseline was wrong by 6x — `DelegateRound` leaves 405,000 lamports/round behind that
`ProcessUndelegation` never returns (COST-MODEL §1.1) — so today's arena is ~0.178 SOL/day, not 0.030.
The custody DELTA below is unaffected, because delegation happens once per round either way; what
changes is that the multiple is smaller than it looks. Custody adds ~0.04-0.19 SOL/day of fees on top
of a 0.178 base, i.e. **~1.2x to ~2.1x**, not the 2.3x-7.4x this section claimed when it was measuring
against a base that was six times too small.

**So custody costs between ~1.11x and ~1.25x the current operating burn.**

**AMENDED after §7 E3 — the guessed band was 0.070-0.22 SOL/day of added fees and the real band is
0.023-0.048.** The old figures rested on guessed batching factors (3 entries per transaction, 7
claims). The correct question was never a measurement: *how many entries fit in 1,232 bytes* is
transaction-encoding arithmetic. The answer is **4** on a legacy transaction — bounded by the 64-byte
signature each entrant contributes, which caps any signed-entry design near 19 — and **~22** on a v0
transaction with an address lookup table, because in the delegated path every per-entry account is a
non-signer and therefore lookup-eligible. Claims go from a guessed 7 to **10** legacy and **~43** with
a table.

    enter    4 per tx legacy   ~22 with an ALT
    claim   10 per tx legacy   ~43 with an ALT
    total   107 unbatched  ->  28 legacy  ->  16 with an ALT
    added fees/day          0.213  ->  0.048  ->  0.023 SOL

The number narrowed twice, both times downward, and both times because a guess was replaced with
arithmetic (it read 2.3x-7.4x when the base was mis-measured at 0.030 SOL/day; see the correction
above), and the whole of the
increase is house bots entering and being claimed for on the base layer. Two facts make that worse
than the table looks:

- **`COST-MODEL.md` §1's "the house wallets do not spend" is retired.** It is currently supported by
  a direct measurement — house wallet 0 has *one transaction in its entire history*. Under custody
  every house seat is a base-layer signature every round: 48 × 417 ≈ 20,000 transactions a day
  across 48 wallets, needing continuous refills rather than the current 0.48 SOL of standing float.
- **The house needs real token inventory.** Forty-eight seats at a $10 stake is **~$480 revolving
  per round**, and it must be liquid in 48 separate wallets at lobby close. `HOUSE-STRATEGY.md`
  measures the house's expected return on those seats as nothing. **This is working capital nobody
  has costed, and it is a bigger practical obstacle than any line of the vault program.** The
  existing treasury rule that caps the house at one fighter when no real players are present is the
  obvious lever, and it should be revisited *before* the vault is written, not after.

The batched figures depend on how many `enter`s fit in one 1,232-byte transaction with ~14 accounts
each, and on the CU of a vault→game CPI. **Both are guesses. §7 E3 is the measurement.**

---

## 5. Every way money can get stuck

This section is the reason the document exists. Each case names the rescue path or says plainly
that there isn't one.

### 5.1 A dead or unreachable ER validator — the case §4.5 calls the largest unknown

**What happens.** The round is delegated. The Delegation Program owns the `Round`. Nothing
undelegates it. `lock_settlement` can never run because `round.owner != game_program`, forever.

**What the repo believes about the platform, inherited and flagged as such.** `COST-MODEL.md` §4.3
records that forced undelegation exists in the delegation program's v3.1.0 API but is **not
deployed on the devnet we run on**, verified twice — a ProgramData write slot ~112–140 days stale,
and a `simulateTransaction` probe with a control. **I did not re-run either probe.** I confirmed
independently only that the delegation program's public instruction set includes `Delegate`,
`CommitState`, `Finalize` and `Undelegate`; I could not confirm the v3.1.0 forced/timeout variant
or its deployment status from public sources. Treat the repo's two probes as the evidence and §7 E2
as the re-check.

**The rescue path, and it does not wait for MagicBlock.**

```text
arena_vault::open_refund(escrow, round)                            [permissionless]
  require now >= escrow.locked_at + vault_arena.rescue_after_secs
  require the round is NOT payable right now:
        round.owner != game_program        (still delegated), or
        phase is not terminal
  escrow.state = Refunding                 ONE WAY. never returns to Settling.
  entries[i].payout = entries[i].gross     for all i

arena_vault::refund(escrow, i)  ==  claim, from the same array, to the same ATA
```

**Why this works when nothing else does: every byte it reads was written by the vault, on the base
layer, before delegation, and the delegation program cannot touch any of it.** The escrow account,
the entries array and the escrow ATA are ordinary base-layer accounts owned by `arena-vault`. No
operator signature. No validator. No delegation program. **`ARCHITECTURE-N-TEAM.md` §4.5's rule —
funds never depend on the operator showing up — becomes satisfiable today, on the devnet we
actually run on.**

A tempting shortcut that must be rejected: reading the *base-layer copy* of the delegated `Round`
for the deposit amounts, instead of keeping our own record. It decodes cleanly
(`MAGICBLOCK_FEEDBACK.md`, 2026-08-10 — Anchor validates the discriminator only, and a delegated
account keeps both discriminator and length), and under this lifecycle the snapshot at delegation
time is exactly the frozen pre-fight lineup. **It is still wrong**, because `resolve` commits
without undelegating, so the base-layer bytes are "the most recent committed state" — which may be
ER-authored. Reading them re-imports the trust the whole design exists to bound. The vault keeps
its own record. This is the single most important design decision in the document.

**Residuals, stated because they are real:**

- **The `Round` account's 0.023497 SOL of rent is stranded permanently.** No instruction can close a
  delegated account. Accepted, and it is exactly the inversion the conservation comment predicts:
  *strand the rent, never the money.*
- **`Treasury.rounds_swept` never reaches `Arena.round_counter` for that round, so the sweep-gap
  stop latches forever.** `COST-MODEL.md` §4's second brake fires at a gap of 25 and "climbs
  monotonically and never recovers if sweeping stops". One dead round permanently halts the keeper.
  **The keeper needs a known-stranded-rounds allowance before custody ships, and that is a change to
  `reclamation.ts`, not to a program.** It is easy to miss and it turns one stuck round into a
  stopped arena.
- **A late commit races the refund.** If the validator returns at T + rescue_window + ε and someone
  calls `resolve`/`close_round` at the same moment as `open_refund`, whichever lands first wins.
  Both outcomes are solvent; the loser of the race is a player who won the fight and gets their
  deposit back instead. Bounded, reachable only after a full outage window, and stated rather than
  designed around.
- **Choosing `rescue_after_secs` is a judgement, not a measurement.** It must be far longer than
  any legitimate settlement (a round is ~207 s) and short enough that a player is not stranded for
  a week. **24 hours** is the recommendation. Nobody has the distribution of MagicBlock validator
  outages, and I do not know how to get it except by running (§7).

### 5.2 `Phase::Drawing` has no exit

**Today a stuck row. Under custody, frozen player funds** — `ARCHITECTURE-N-TEAM.md` §3.7 and risk
3, `GAPS.md` §6, and `abandon_round`'s own doc comment, which names the hole, the cause (the VRF
callback never lands) and the fix.

**Rescue, and it must ship in `bulls-arena` in the same deploy as the vault seam:**

The fix is the one the program already proposes to itself: stamp when the draw was requested —
`fight_started_at` is 0 until `callback_seed` overwrites it and is read nowhere outside
`Phase::Fight`, so it costs no account bytes — and let `abandon_round` accept a `Drawing` round
whose oracle has been silent past a measured timeout. A late callback then fails harmlessly on its
own `Phase::Drawing` guard.

Two changes custody forces on top of that:

1. **`abandon_round` must accept any fighter count.** It currently requires `lobby_is_dead`, i.e.
   fewer than two fighters, because it only ever handled an under-subscribed lobby. A wedged
   `Drawing` round has a full lineup and full escrow.
2. **`refund_abandoned_entry` must generalise, which needs `fee_bps` frozen on the `Round`.** It is
   exact today only because there is exactly one fighter, and its own comment says why: a mid-lobby
   `set_fee_bps` charges two rates inside one round and nothing records which entry paid which.
   `set_fee_bps`'s comment already names the structural fix — stamp the rate at `open_round` — and
   already says it belongs with this work. Do it here.

With those, a wedged `Drawing` round is abandoned, undelegates, and the vault refunds gross through
the ordinary path with no timeout at all. Without them, §5.1's 24-hour path covers it, but at
24 hours instead of minutes and with the Round's rent stranded.

### 5.3 A round that can never reach a terminal phase

**Mostly closed already, and worth recording as closed.** The known instances were CU exhaustion —
this repo produced **two permanently stuck rounds** from "1,399,850 of 1,399,850 CUs consumed". The
current program bounds it structurally: `MAX_STEPS_PER_CALL = 3,000`, `resolve` grinds rather than
reverting, and the doc comment's explicit refusal to make settlement depend on anyone having
ticked. A fight that can never end (one wallet on both sides) is settled by the bell at 180 s, and
there is a test named for it.

The residual is a validator that is alive but will not include our transactions — censorship rather
than death. Indistinguishable from §5.1 from the outside, and covered by the same timeout.

**Watch item, not a rescue gap:** `the_tick_then_extract_bundle_fits_but_only_just` measures a
bundled tick+extract at **1,278,800 CU, 91.3% of the 1.4 M ceiling**. Custody does not touch that
path — the vault is not in the ER — but 8.7% of headroom on the instruction where running out means
a player cannot get their money out deserves re-measuring after any change to `advance_fight`.

### 5.4 A non-conserving commit

**What happens today.** `apply_sweep` requires `r.conserves()` and refuses otherwise. Refusing
strands the round: `close_round_account` requires `house_swept`, so ~0.0235 SOL of rent is locked
with no instruction that can release it. The comment says this is the right trade — *"Losing rent
to learn the rollup lied is a good trade. Booking the lie is not."* — and says the trade inverts
under custody, and that a rescue path is a prerequisite, not a follow-up. That paragraph is correct
and this is the path.

**Rescue.** `lock_settlement` fails at step 4 or 5. The vault goes to `Refunding` **immediately, no
timeout**, because the ledger the refund reads is the vault's own and does not depend on the round
being repairable. Payouts become deposits. `paid_out` is bounded by `deposited_gross` by
construction, so the escrow is solvent whatever the round says.

**This is the "pays out at most `gross_deposits` and never more" that `apply_sweep`'s comment asks
for**, and it lives in the vault rather than in the game program, which is what the comment
predicts ("It belongs with custody rather than here, because today there is nothing to rescue").

**Two things must be said about it.** First: a player who *won* that round gets only their deposit
back. There is no better answer — the round's own numbers say it could not have happened. Second:
this hands the ER validator a way to void a round it dislikes, by breaking conservation
deliberately. That is strictly weaker than the redistribution power §4.4 already grants it, and it
costs the validator the round's fees and penalties, but it is a new capability and it is named
rather than discovered.

### 5.5 A forced program id migration with funds in escrow

**This is risk 2 and the reason for the whole two-program split, and under this design it stops
being an emergency.**

- The vault never churns ids. It is never delegated, so it never meets the bytecode cache.
- Every escrow records the `game_program` it settles against, via its `VaultArena`. Registering a
  new game program creates a *new* `VaultArena`; it does not re-point an existing one, because
  there is no setter. Old escrows keep settling against old rounds.
- In-flight rounds at the moment of migration either settle on the old id, or — if the old id is
  unusable in the ER, which is usually *why* the migration is happening — fall to §5.1's refund
  after the rescue window.
- **The operational rule is therefore "migrate with zero open escrows", and it is checkable as one
  number:** `VaultArena.open_escrows`. If it is 0, the migration is free. If it is not, the operator
  knows exactly how much is exposed and to what.

**No emergency drain is required and none should exist.** §9.3.

### 5.6 A player who never claims

Permissionless `claim` + `init_if_needed` on the ATA + the keeper sweeping claims as a routine task
(`SOCIAL.md` §5.5.3 already assigns it). The escrow's ~0.0227 SOL stays outstanding until the last
entry is claimed.

**There is deliberately no "unclaimed funds revert to the house" path.** A timeout that lets the
operator take a player's money is exactly the instruction this design is built to not have. The
cost is a permanently held rent float on any round with a permanently absent claimant. At 417
rounds/day, if 1% of rounds have one, that is **~0.09 SOL/day of permanently locked float**
(derived) — real, bounded by keeper diligence, and a better outcome than the alternative.

### 5.7 The cases with no rescue path — stated plainly, because this is the most useful paragraph

**1. A bug in `arena-vault` that mis-computes `entries[i].payout`.** There is no recovery
instruction, by design, because the recovery instruction *is* the vulnerability. The only mitigation
is that it be correct before it holds money: the audit, the canary, and the fact that the payout
arithmetic in a single-mint arena is an addition with no division in it (§2.1).

**2. A compromised `arena-vault` upgrade authority.** An upgradeable program that holds tokens has,
in its upgrade authority, a key that can take all of them. There is no structural answer to this
short of burning the authority, and burning it means the next bug is unfixable. §8.4 is the whole
of the mitigation and it is a governance answer, not an engineering one. **This is the single most
irreversible decision in the design.**

**3. The ER validator redistributing one round's pot among that round's own fighters.** Not a
freeze — the money always comes out — but it comes out to the wrong people, and nothing here stops
it. §4.4 is right that it can only be bounded, not argued away, and §3.5 tightens the bound from
"any wallets" to "these exact wallets". The named upgrade path remains a challenge window with
step-by-step re-execution; it is real work, out of scope, and recorded so the design says what
"trustless" would actually cost.

**4. A round both stuck and non-refundable because the vault's own escrow account was never
created.** If `open_escrow` succeeded but `enter` never ran, there is nothing to refund and the
escrow closes empty. Covered. If `open_escrow` never ran, `enter` cannot have run either, because
`enter` writes it. Covered by construction. Listed because it is the case a reader will ask about.

---

## 6. The spend allowance

### 6.1 Why it is forced into the same change

`SOCIAL.md` §5.5.4 states it exactly right and it is worth quoting rather than paraphrasing:

> Today a session key is harmless because there is nothing to spend. The moment custody ships, that
> same key — four fields, no spend cap, no instruction allowlist, valid for a whole day — becomes a
> key that can drain the player's entire custodied balance through repeated `enter` calls. **Custody
> and a session-scoped spend allowance must ship in the same change, or the safety story inverts
> overnight.**

The mechanical reason it could not be built earlier is that an allowance is a **cumulative budget
across rounds**, so it needs a per-player account that persists between rounds — and while `enter`
ran inside the ER it could write nothing but the delegated `Round`. Moving `enter` to the base layer
is what unlocks it. **The same change that makes the allowance necessary is the change that makes
it possible**, which is why they cannot be sequenced apart.

### 6.2 The structural finding that decides the design

**A session key cannot move tokens out of the player's own ATA. Ever.**

An SPL `Transfer` requires the token account's *owner* to sign. A session token authorises
instructions on **our** program; it is not a signature on the SPL Token program's authority field.
So a session-signed `enter` that tried `token::transfer { authority: player }` would fail, because
`player` is not a `Signer` on that path.

There are exactly two ways out, and the choice is the whole of §6.

**Rejected: a vault-held player balance.** Players deposit into a per-player vault account and
`enter` debits it internally. It works, and it makes the operator a custodian of **idle** capital —
money held between rounds, indefinitely, with its own withdraw path, its own accounting and its own
solvency invariant. That is a materially larger regulatory posture (risk 7), a larger attack
surface, and a whole subsystem. Reject.

**Adopted: an SPL delegate approval, so the money ceiling is enforced by the Token program.**

```text
once, wallet-signed:
    spl_token::approve(player_ata, delegate = spender_pda, amount = N)
    arena_vault::grant_spend(delegate = session_signer, per_round_cap, expires_at)

each round, session-signed:
    arena_vault::enter_delegated(...)
        token::transfer(player_ata -> escrow_ata, gross, authority = spender_pda)
            -> SPL decrements delegated_amount by `gross`, itself
        require spend_auth.delegate == session_token.session_signer
        require spend_auth.expires_at > now
        require gross <= spend_auth.per_round_cap
        spend_auth.spent += gross
```

Why this is the right shape:

- **The hard ceiling is the SPL Token program's `delegated_amount`, not our code.** It decrements on
  every transfer and clears the delegate when it hits zero. §5.4's "a budget… it never tops itself
  up. The budget is the budget" becomes an invariant of a program we did not write and cannot get
  wrong.
- **Idle capital is never custodied.** The tokens sit in the player's own ATA until a round actually
  takes them, and winnings return there. "Leave your capital in for unlimited time" becomes "leave
  an approval in place", and the operator holds nothing between rounds. That is a *better* product
  claim than the one the pitch was reaching for, and it is true.
- **Revocation is `spl_token::revoke` — one standard instruction that works even if our program is
  broken, our server is compromised, and we are unreachable.** §5.4 asks for exactly one kill switch
  with that property and identifies `revokeSession()` as it. Now there are two, and this one does
  not depend on MagicBlock's session program either.
- **`SpendAuthorization` carries what SPL cannot express** — which delegate, until when, per-round
  cap, scoped to one arena — and nothing that has to be right for solvency. If it is wrong, the loss
  is bounded by `delegated_amount`.

**Two instructions, not one branch.** `enter` (player signs, no allowance touched, no
`SpendAuthorization` account in the context at all) and `enter_delegated` (session signs,
`SpendAuthorization` is a required account). A single instruction with an optional allowance account
is precisely the shape in which someone later forgets the branch. Anchor's account struct makes the
requirement structural only if the account is not optional.

### 6.3 The integration hazard this creates, which nothing has flagged yet

Session tokens are scoped to a `target_program`. Under this design `enter_delegated` lives in
`arena-vault` and `extract` lives in `bulls-arena`. **A player therefore needs two session tokens.**

`MAGICBLOCK_FEEDBACK.md` records that `useSessionKeyManager` generates a keypair only when it has
none and that `createSession` cannot replace an existing session, failing with a bare
`custom program error: 0x0`. Naively, this becomes two wallet popups at session creation and a
renewal path that is already known to be awkward.

The fix is available and this repo has already done the hard part: it reimplemented session creation
directly against `@coral-xyz/anchor` and the `gpl_session` IDL. **Both tokens should be created for
the same session signer keypair in one transaction, two `create_session` instructions, one wallet
approval.** Whether that composes cleanly is **unverified** — §7 E4.

---

## 7. The experiments, before the code

Four. Two are gates. None needs the vault to exist.

**E1 — Produce a round that can never be undelegated, and run the rescue against it.**

**THE METHOD THIS SECTION USED TO PRESCRIBE DOES NOT WORK, AND IT WAS TESTED.** It said: upgrade
`bulls-arena` in place, confirm the validators go STALE, delegate a round to one, and the round
wedges. Measured 2026-08-17 with `er-demo/scripts/er-bytecode-probe.ts`:

```text
before upgrade   BASE 4d38b52b -> 4/4 validators FRESH 4d38b52b
after  upgrade   BASE 80f30c9f -> 4/4 validators STALE 4d38b52b
```

All four went stale **and the arena kept running.** Round 743 fought 39 fighters, settled, swept and
closed. See §11 for why the reasoning failed. The principle that replaces it:

**A STALE ER VALIDATOR IS NOT A BROKEN ONE.** It is executing a complete, self-consistent,
previously-working build against an account the base layer produced. It wedges only if:

1. the old bytecode and the account **disagree about layout**, so the decode fails;
2. the round needs an instruction the old build **does not have**;
3. the owner program **cannot execute on the base layer**, so undelegation's callback CPI cannot land.

An upgrade that changes behaviour *inside a fixed layout* satisfies none of them. That is a **safety
property, not merely a null result**: an accidental in-place upgrade of the live program does not
strand rounds. §3.1's conclusion survives; only its stated reason needs narrowing.

### E1-M1 — Kill a local ephemeral validator. RECOMMENDED. Zero SOL, zero program ids, repeatable.

MagicBlock ships a local ER validator (`docs.magicblock.gg`, verified 2026-08-20). **This program can
already pin it**: `delegate_round` passes `DelegateConfig { validator: ctx.remaining_accounts.first()
.map(|a| a.key()), .. }` — `lib.rs:1804`, the mechanism `MAGICBLOCK_FEEDBACK.md`'s 2026-08-09 entry
found and never retired.

```text
1. solana-test-validator, cloning DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
2. deploy bulls-arena + arena-vault locally; init_arena, init_treasury, open_escrow
3. arena_vault::enter x n            <- real deposits into a real escrow ATA
4. delegate_round with remaining_accounts[0] = the LOCAL validator's identity
5. confirm the round is live in the rollup: tick it once
6. SIGKILL the ephemeral-validator. Never restart it.
7. base layer: round.owner == DELeGGvXpW... forever
8. advance past rescue_after_secs; arena_vault::open_refund, then refund x n
```

**Why step 6 is permanent.** A delegation names a validator, and the pinned identity is the only key
that may commit or undelegate that account. When it never runs again, nothing can. `round.owner` is
`DELeGG...`, which is exactly and only what §5.1's rescue reads.

- **Proves:** all of §5.1 — that the refund executes against a round nothing can undelegate, reading
  only vault-owned bytes, with no operator, validator or delegation-program cooperation. This is G1.
- **Costs:** nothing. No devnet SOL, no program id, no contact with the live arena.
- **Cleanup:** `solana-test-validator --reset`. **The wedge is disposable** — the property no devnet
  method has.
- **UNVERIFIED, and it is M1's only failure mode:** whether a locally-run `ephemeral-validator`
  accepts a delegation naming its identity. Thirty minutes to find out — run steps 1-5 and read
  `round.owner`. If it refuses, fall to M2.

**G1 SHOULD NOT BE AN EXPERIMENT. IT SHOULD BE A TEST.** `tests/compute.rs`'s header states the
doctrine: *"a measurement nothing re-runs is a rumour with a number in it."* A rescue path proven
once and never re-run is `bench_fight` wearing a rescue's clothes. M1 is cheap enough for CI.

### E1-M2 — Layout divergence on a sacrificial program id.

Deploy `bulls-arena` unchanged on a fresh id S, play a round to warm the cache, then upgrade S in
place with `MAX_FIGHTERS = 49` (`Round` 3,248 -> 3,312 B). Open a round: the base layer allocates
3,312 bytes; the ER serves the 48-fighter clone. `AccountLoader::load*` ends in
`bytemuck::from_bytes`, which **requires the slice length to equal `size_of::<Round>()` exactly and
panics otherwise** — `lib.rs`'s own `declare_id!` note, lines 115-123. Every instruction aborts.

- **Proves** what M1 does, plus that the wedge survives on real public devnet infrastructure.
- **Costs less than this document assumed:** the ~2.4 SOL is a **deposit, not a burn** — v4 returned
  2.43720408 SOL and v5 returned 2.28341592 SOL on closing, signatures on record. Irrecoverable: the
  wedged round's 0.023497 SOL rent and 405,000 lamports of delegation escrow — **precisely the
  residual §5.1 predicts**, so M2 measures it rather than deriving it.
- **A sacrificial id is required, not optional.** `ARENA_SEED` is a singleton, so wedging a round on
  the live id would permanently halt the live keeper's reclamation.

### E1-M4 — Close the owner program while a round is delegated.

Delegate on the sacrificial id, then `solana program close` it. A closed id has no executable and can
never be redeployed, so the undelegation callback CPI can never land.

- **Cheapest of the three on devnet** — closing is the act that reclaims the ~2.4 SOL.
- **Wedges from the base-layer side**, so the rollup can keep committing. It is the only method that
  produces a round **committed with ER-authored bytes visible on the base layer while still
  delegated** — the §10 row marked *believed, unverified*, settled as a by-product.
- **Risk:** rests on a documentation claim about the undelegation CPI. A negative result would be
  *more* valuable — it would mean a closed program does not strand its delegated accounts, changing
  §5.5.

### Is a dead delegation even reachable here? Yes — and §5.1 names the wrong cause.

**The terminal state is trivially reachable** — three constructions above, one free.

**But none is the cause §5.1 names.** §5.1 models a MagicBlock validator dying. Nothing here can
cause that and nobody can measure its probability: `MAGICBLOCK_FEEDBACK.md` asks MagicBlock for that
guarantee and records no answer. The single datum is 3,600 seconds of continuous delegation.

**The empirically dominant cause is not MagicBlock. It is this repo:**

- **Nine program ids**, at least two closed permanently — `solana program close` with a delegated
  round outstanding is E1-M4, performed by accident.
- **Two permanently stuck rounds** already, from `1,399,850 of 1,399,850 CUs consumed`.
- **A layout migration that could not be deployed in place** — E1-M2, by accident.
- **`Phase::Drawing` has no exit** (§5.2). A round whose VRF callback never lands reaches the
  identical terminal state **with no infrastructure failure at all.**

**RECOMMENDED AMENDMENT: retitle §5.1 from "A dead or unreachable ER validator" to "A round that can
never be undelegated", with four causes — validator death, layout divergence, a closed owner program,
and `Phase::Drawing`.** Three of the four are operator error, and operator error has a track record
here. That is a more defensible reason to build a permissionless refund than an outage distribution
nobody has.

**E2 — Re-probe forced undelegation.** `COST-MODEL.md`'s two probes are ~1 day old at the time of
writing but the underlying ProgramData was already ~4 months stale, so this will not change often.
Re-run both (ProgramData write slot; `simulateTransaction` with a control) before the vault ships,
and file `MAGICBLOCK_FEEDBACK.md`'s open question — the 2026-08-10 entry asking for a delegation
lifetime guarantee is the right vehicle and this is sharper than anything currently in it. **If it
lands, it becomes a second rescue that also recovers the `Round`'s rent. It is not a prerequisite
under this design, and that is the point.**

**E3 — Measure the entry path.** CU and transaction size for `arena_vault::enter_delegated` with
its vault→game CPI (~14 accounts), and how many fit in one 1,232-byte transaction. This decides
whether §4.3's operating cost is 0.070 or 0.22 SOL/day. LiteSVM, following `tests/compute.rs`'s
existing discipline of calling the real instruction rather than a stand-in — the discipline this
repo earned the hard way when a hand-copied `bench_fight` drifted enough to make a real `resolve`
exceed 1.4 M CU.

**E4 — Two session tokens, one transaction, one signer keypair.** Devnet, against the deployed
`gpl_session` program. Ten lines.

**And one observation that is not an experiment: G9.** `COST-MODEL.md` §4 is explicit that rent
reclamation **has never run at 48 fighters** — v8's counter is at 4 against a twenty-round retention
window. Custody roughly doubles the per-round rent (§3.2). Do not add a second rent-bearing account
per round to a reclamation mechanism that has not yet been observed working once at the current
size. Continuous mode reaches round 20 in about seventy minutes.

---

## 8. The sequenced plan

### 8.1 Order

**S0 — No program code. Independently valuable. Start here.**
- E1, E2, E3, E4.
- Observe one full day of rent reclamation at 48 fighters (G9). Watch `Treasury.rounds_swept`
  against `Arena.round_counter`.
- `reclamation.ts`: a known-stranded-rounds allowance in the sweep-gap stop, so one wedged round
  cannot permanently halt the keeper (§5.1).
- Decide §2.1 and write it down as an ADR. This is a product decision, not an engineering one.

**Deliberately not in S0: the `Phase::Drawing` fix.** It requires a fresh program id (the fix runs
in the ER, and the ER will not re-clone an upgrade), which costs ~2.4 SOL and every round of
history. Today the hole costs 0.0235 SOL of rent per occurrence and has apparently never fired. **Do
not burn an id for a rent-only defect.** It ships in S2's deploy, where it is a money defect. This
is the same trade `apply_sweep`'s comment makes, applied one level up.

**S1 — `crates/arena-state`.** Extract `Round`, `Fighter`, `Phase`, the four book-keeping functions
and the layout test into a shared crate; `bulls-arena` depends on it and is otherwise unchanged.
Ships alone, changes no behaviour, and is a strictly better home for
`the_account_layout_is_exactly_what_the_clients_decode`.

**S2 — `arena-vault` v1 + `bulls-arena` v-next, wallet-signed only.**
`open_escrow`/`enter`/`lock_escrow`/`lock_settlement`/`claim`/`sweep_treasury`/`close_escrow`, and
in the game program: the escrow-authority signer on `enter`, `Arena.vault_program`, `close_lobby`,
delegation moved, `fee_bps` frozen on the `Round`, the `Drawing` exit, the generalised abandon
refund, the escrow-locked rule on `close_round_account`. One `bulls-arena` deploy carrying every
reshape — §3.2's "bundle every PDA reshape you will ever want into this one deploy".

**S3 — The allowance and the session path.** `approve`/`revoke` flow, `grant_spend`,
`enter_delegated`, two session tokens. Ships behind the same deploy or as a vault upgrade (the vault
*can* be upgraded safely; that is the point of it not being delegated).

**S4 — Keeper and client.** Keeper gains `lock_settlement`, batched `claim`, `sweep_treasury`,
`close_escrow`, and the stranded-round allowance. The v2 cashier stops being `localStorage`;
`simLedger.ts` and every `SIM` marker come out. This is where the effort actually is.

**S5 — Canary, audit, real money.** Twenty rounds at a stake small enough that total value at risk
is under the audit fee. Then G11.

### 8.2 Honest scope

| | estimate | confidence |
|---|---|---|
| S0 | 3–5 days | good — E1 is the unknown, and it is unknown in outcome, not in effort |
| S1 | 1–2 days | good |
| S2 `arena-vault` program | 5–8 days | fair. ~1,200–1,600 lines at this repo's comment density, 8 instructions, the arithmetic is additions |
| S2 `bulls-arena` changes | 4–6 days | fair. Seven changes, one deploy, and the deploy is the risky part |
| S3 allowance | 3–4 days | fair |
| S4 keeper + client | **8–12 days** | **poor, and it is the biggest number** |
| S5 canary + audit cycle | 2 weeks elapsed, mostly waiting | — |
| **total build before canary** | **~5–7 weeks of one engineer** | |

**The usual surprise is in S4, and it is the line to distrust.** The program is the small half. The
keeper gains four new tasks with retry semantics and a new class of stuck state; the client gains a
real cashier, an approval flow, a revoke control, a two-token session, and the deletion of every
`SIM` marker in a codebase where `SIM` is load-bearing honesty. `ARCHITECTURE-N-TEAM.md` §5 says
"the engine port — where the effort actually is", and it is right about this too.

### 8.3 What has to be audited

§4.6's list, amended for this design. Items (3), (7) and (8) shrink or disappear; two are added.

1. **`claim`/`refund` authorization** — own ATA only, once, that escrow only, `paid_out <=
   deposited_gross` checked, and `entries[i].claimed` unforgeable.
2. **Escrow PDA seeds and the transfer signer seeds.** The escrow ATA's authority is the escrow PDA;
   getting the seeds wrong is the whole ballgame.
3. **`lock_settlement`'s six checks**, especially step 0 (owner) and step 3 (the lineup pin), and
   that `Refunding` and `Settling` are mutually absorbing states with no path between them.
4. **`enter`'s token math and the CPI.** The escrow-authority signer, the append-or-top-up agreeing
   with `credit_entry`, and `gross` reaching both the transfer and the CPI unaltered.
5. **`close_lobby`'s lineup freeze**, including degenerate lobbies.
6. **Phase totality, `Drawing` included** — a money property now.
7. **The allowance**: that `enter_delegated` cannot run without a `SpendAuthorization`, that
   `spent` cannot be decremented, and that `grant_spend` requires the player's own signature.
8. **NEW — the negative property, and it should be a test, not a review note:** enumerate every
   instruction in the vault's IDL and assert that none has a token destination that is not
   (a) a recorded entry's own ATA or (b) `vault_arena.treasury_ata`. This is G7 and it is the
   cheapest strong statement in the audit.
9. **NEW — the shared layout crate.** That `arena-state`'s `Round` is the *same* definition both
   programs compile, and that the offsets test lives with it.
10. **Rounding.** In a single-mint arena there is one floor division in the whole money path
    (`split_entry`'s fee) and `HOUSE-EDGE-STUDY.md` §11.1 has already measured its direction and
    bound: it goes the player's way, one unit per entry, **$0.000016/round at 16 seats**, and cannot
    be farmed. That is a measurement the auditor can be handed rather than an argument.

Per README's checklist: the settlement authority is gone entirely under this design, and what
remains — the vault's *upgrade* authority — is §8.4.

### 8.4 The upgrade authority, which is the one thing engineering cannot solve

An upgradeable program holding tokens has a key that can take them. Burning the authority makes the
next bug unfixable. There is no third option.

**Recommendation: Squads multisig from day one, and a written intent — with a date — to burn the
authority after the audit plus a soak period.** Say which it is in the UI. This is the decision to
be slowest about, and it is the one this document cannot make.

### 8.5 What the UI must stop saying, and start saying

- **Not "non-custodial".** The ER validator can rewrite a round's final state and that state decides
  who gets paid (§4.4). `SOCIAL.md` §5.5 already carries this rule; custody makes it enforceable
  rather than advisory.
- **"Extract makes your value safe, not liquid"**, at the extract button, not in a FAQ.
- **The rescue window, in the deposit dialog.** "If the rollup validator fails, your deposit is
  refundable after 24 hours by anyone, including you." That sentence is the product of this entire
  document and it should be on the screen where the money leaves.
- **The economy, honestly.** `HOUSE-EDGE-STUDY.md` §11.4: at 100 bps the median seat's ROI is
  **−3.75%**, **54.33% of seats lose money**, and the rake exceeds a one-standard-deviation swing
  after **1,528 rounds** — about six weeks of continuous play. These are measured, they are not
  hidden anywhere else in the repo, and a product that takes real money should say them.

---

## 9. Where this departs from `ARCHITECTURE-N-TEAM.md` §4

Recorded rather than quietly diverged from, per that document's own register discipline.

### 9.1 §4.2 has `enter` making two transfers. It must make one.

§4.2: *"SPL: player ATA -> round escrow ATA … SPL: player ATA -> arena treasury ATA (fee_bps)"*.

That was written before `refund_abandoned_entry` landed, and the two are incompatible. That function
exists because *"a token transfer out of a round that never ran is a charge for a service not
rendered"* — and if the fee left at `enter`, the vault could not give it back without reaching into
the treasury. So: **one transfer of the gross into the escrow; fees and penalties leave together at
`sweep_treasury`, after the round is terminal.**

This also makes the escrow's invariant exact and stated in the program's own words:
`Round::gross_deposits()`'s doc comment already says *"`escrow_balance == gross_deposits` for a
round whose fee has not yet been swept to the treasury ATA, and `escrow_balance == pot` once it
has."* The design now matches the comment.

### 9.2 §4.3's seam is inverted, and the settable pointer is deleted.

§4.3: *"the vault stores a settable `game_program` pubkey and releases only on a CPI signed by a PDA
of the registered game program. One bounded, auditable knob versus stranded funds on every forced
migration — and the exact line the audit should concentrate on."*

The knob is unnecessary. The vault does not need a CPI to release funds; it needs to *read* a
`Round` whose owner is the game program that took the deposit (§3.4). Reading an account's owner is
strictly stronger than trusting a signer derived from a stored pubkey, and it needs no setter — so
the CPI runs **vault → game** (to credit the fighter), never game → vault.

What that deletes: the settable pointer, the release CPI's signer seeds, the audit item about what
the knob can do in the wrong hands, and the class of incident where the pointer is set wrong. What
it costs: the shared layout crate (§3.4), which is a cost worth paying anyway.

### 9.3 §4.6(8)'s emergency drain should not exist.

§4.6 lists *"the emergency drain — itself the most dangerous function, needing a timelock or
multisig, not a hot key."* It is not needed. Its case — a forced id migration with funds in escrow —
is answered by §5.5: escrows pin their game program, the vault never migrates, and
`open_escrows` makes the exposure one number. Its other case — a stuck round — is answered by §5.1,
which is permissionless and pays only depositors.

A drain that exists for cases that cannot arise is a key in the threat model earning nothing, and
`ARCHITECTURE-N-TEAM.md` §4.3 already makes the argument in the other direction about `claim`:
*"Strictly stronger, and it deletes a key from the threat model."* Same argument, one function
further.

### 9.4 §4.5's open question is closable today, without MagicBlock.

§4.5: *"the one hole that cannot be closed from here … If none, a validator outage freezes that
round's escrow indefinitely… This is the single largest unknown in the custody design and must be
answered before real money."*

It is closable, and the reason is a consequence of §4.2's own decision that §4.5 does not connect to
it: **once `enter` is on the base layer, the vault can keep a deposit record the rollup has never
been able to touch.** The rescue then reads only base-layer accounts the vault itself wrote. Forced
undelegation stops being a prerequisite and becomes an optimisation that recovers the `Round`'s
rent.

The unknown does not disappear — it moves. It is now **§7 E1: has anyone actually run a refund
against a genuinely dead delegation?** No. That is a smaller, cheaper, and answerable question.

### 9.5 §3.1's mint vector is deferred, and that is a real deviation.

§1's Phase 1 argues the denomination must be fixed before the account layout exists, because
otherwise `Fighter` is rewritten twice. §2.1 argues the other way: the vector changes the damage
basis, so shipping it with custody retires `HOUSE-EDGE-STUDY.md` and takes two irreversible bets in
one move.

**The rewrite-twice cost is real and it is bounded and known: one `bulls-arena` deploy, ~2.4 SOL and
twenty rounds of history, with no migration of funds and no change to the vault.** That is exactly
the property the two-program split was chosen to buy, so spending it here is spending it as
intended.

### 9.6 The one premise that had moved, evaluated properly

§4.1 says *"tokens never enter the ER"* and §7 says *"Not put tokens in the ER. Structurally
impossible."* **That is no longer true as stated.** MagicBlock's Ephemeral SPL Token program
(`SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`) exists: an **eATA** is a program-owned PDA from
`[owner, mint]` holding a `u64` balance, delegatable to a rollup; a per-mint **Global Vault** PDA
from `[mint]` custodies the real tokens. The docs state that a program PDA can own an eATA and that
"the custody PDA signs the transfer — no user signature required", and that plain PDA-owned ATAs
cannot be delegated — token custody on the ER goes through an eATA. (Verified against
`docs.magicblock.gg` in this session, not inherited. `ER_DESIGN_DECISIONS.md` §2 reached the same
facts and recommended adopting it "as its own phase"; `MEGA_QUEUE.md` has it **PARKED**.)

**Rejected anyway, for three reasons, in descending order of strength.**

**1. It destroys the one-account atomic commit, which is a property this program already paid for.**
`MAX_FIGHTERS`'s doc comment rejects one-account-per-fighter in exactly these words: *"48
delegations and 48 commits per round, the round stops being atomic, and a partial commit leaves a
round half-settled with no obvious way to tell which half is real."* Paying fighters in eATAs
requires each fighter's eATA to be delegated — 48 delegated accounts plus the escrow — which is that
rejected design wearing a token program. The `Round` is one account and one commit, and that is
load-bearing.

**2. It trades a blast radius we control for one we do not.** §4.4(a)'s entire argument is that
per-round escrow *addresses* bound a malicious commit to one round's own pot. Under eATAs the
balance record is per-round but the tokens are in a **shared per-mint Global Vault backing every
eATA of that mint across every application**. Whether a validator that rewrites a delegated eATA
balance can withdraw against that shared vault depends on invariants inside a program we did not
write, cannot fix, and — critically — **cannot re-deploy on a fresh id when it has a bug**, because
it is not ours. `ER_DESIGN_DECISIONS.md` §2 names this honestly: *"it is still custodial, just
custodied differently… a different counterparty, and one shared with strangers."* **Whether the
eATA program enforces a per-mint solvency invariant at commit time is unknown to me and is the
experiment that would reopen this decision.**

**3. It buys nothing this design needs.** Nothing pays out mid-fight. `extract` makes value safe,
not liquid, by intent — that is the mechanic, not a limitation. Moving the escrow at rollup speed
would accelerate a transfer that has no reason to happen until the round is over.

**So the conclusion of §4.1 stands and its justification is replaced.** Not "structurally
impossible" — *possible, evaluated, and rejected*, because it breaks atomicity, widens the blast
radius from one round to one mint across every application, and delivers no capability the product
uses. The bet in §9 of that document — *"custody stays in its own program; expires when MagicBlock
invalidates the bytecode cache on ProgramData writes"* — gains a sibling: **this bet expires if
MagicBlock publishes and audits a per-mint conservation invariant on the Global Vault, and if
per-fighter payout ever has to happen mid-round.**

---

## 10. What I am not confident about

| Claim | Status | What would settle it |
|---|---|---|
| A stale ER bytecode clone is by itself enough to wedge a round | **MEASURED FALSE, 2026-08-17** | Settled. `er-bytecode-probe.ts`: `BASE 80f30c9f` against `4/4 STALE 4d38b52b`, and round 743 fought, settled, swept and closed. See §11 |
| The base-layer refund path works against a round that can never be undelegated | **the load-bearing unknown — and now runnable for nothing** | §7 E1-M1: delegate to a local `ephemeral-validator` pinned through `delegate_round`'s existing `DelegateConfig.validator` (`lib.rs:1804`), kill it, run the refund. Zero SOL, and it belongs in CI |
| A local `ephemeral-validator` accepts a delegation pinned to its own identity | **unverified — the single step E1-M1 can fail on** | Thirty minutes: run it, delegate, read `round.owner`. Falls back to E1-M2 |
| A closed owner program permanently strands its delegated accounts | **derived** from the undelegation callback being a validator CPI into the `#[ephemeral]`-injected processor | §7 E1-M4. A negative result would be more valuable — it would change §5.5 |
| How many `enter`s fit one 1,232-byte transaction | **derived arithmetic, no longer a guess: 4 legacy, ~22 with an ALT.** The binding term is one 64-byte signature per entrant | §7 E3-a — build the instruction from the program's own `to_account_metas` and serialize it, so an added account fails the test |
| 48 seats is still the right cap once a seat costs a transaction and an inventory position | **half-settled: the transaction half is answered and is negligible.** The inventory half is now the whole question | price the ~$480 revolving float and the 48 wallets' SOL |
| Forced undelegation is absent on our devnet | **inherited** from `COST-MODEL.md` §4.3's two probes; I confirmed only that the delegation program exposes `Delegate`/`CommitState`/`Finalize`/`Undelegate` | §7 E2 |
| `enter_delegated` + CPI fits, and 3 fit in one transaction | **guess** | §7 E3, LiteSVM, calling the real instruction |
| Two session tokens, one signer, one transaction | **unverified** | §7 E4, ten lines against devnet |
| 33 base-layer transactions per round, 0.070 SOL/day | **derived** from a measured 5-tx round and guessed batching | count what the keeper actually produces, as `COST-MODEL.md` §8 does for round cadence |
| `RoundEscrow` at ~2,844 B → 0.020685 SOL | **derived** arithmetic on a formula that reproduces `Round`'s measured rent exactly | borsh/`size_of` it in the size test |
| A committed-but-still-delegated `Round` can have ER-authored bytes visible on the base layer | **believed, unverified** — it is why §5.1 refuses to read them. The owner check makes the design safe either way | read a round's base-layer bytes immediately after `resolve` and before `close_round` |
| 24 hours is the right rescue window | **judgement, not a measurement** | the distribution of MagicBlock validator outages, which nobody has. If E1 becomes routine, start with 24h and lower it on evidence |
| The eATA program enforces a per-mint solvency invariant at commit | **unknown** | read the Ephemeral SPL Token program's source. It is the only thing that would reopen §9.6 |
| The two-mint vector changes the martingale result | **prior, from mechanism only** — `basis = min(a.hp, d.hp)` becomes a different quantity over a vector | re-run `sandbox/house-edge/` against a vector variant. It is a sandbox change, not a deploy, and it is cheap |
| 48 seats is still the right cap once a seat costs a transaction and an inventory position | **unanalysed** | §4.3's cost table, against the fight-length table's quality bar |
| Rent reclamation works at 48 fighters | **still unobserved**, `COST-MODEL.md` §4's own caveat | one day of continuous mode |

**Every one of these sits in front of a gate, and only one of them sits in front of a program
deploy** — E3, which is measurable on a local validator for no SOL. That is the property
`ARCHITECTURE-N-TEAM.md` §8 calls the only one worth defending hard, and it is preserved here.

---

## 11. What this document got wrong on the way

Kept because the corrections are the useful part, per `COST-MODEL.md` §7.

**E1's METHOD WAS WRONG, and the way it was wrong is the useful part.** The first draft said a dead
delegation could be manufactured by upgrading `bulls-arena` in place so the validators serve stale
bytecode. Tested 2026-08-17: all four went STALE **and the arena kept running** — round 743 fought 39
fighters, settled, swept and closed.

The error was treating *"the validator is serving different bytes"* as equivalent to *"the validator
cannot run the program."* A stale clone is a complete, previously-working build. It wedges only on a
layout disagreement, a missing instruction, or an owner program that cannot execute. The upgrade
changed only behaviour inside a fixed layout.

**The method was wrong before the answer was.** The document had a real mechanism — bytecode caching,
four `MAGICBLOCK_FEEDBACK.md` entries, seven forced ids — and reasoned from it to a consequence
without checking that the mechanism produced that consequence. **That is the same shape as the
`bench_fight` failure `tests/compute.rs` exists to indict:** a claim derived from a probe that had
drifted from the thing it described.

**§4.3's BATCHING FACTORS WERE GUESSES, AND THE GUESS WAS NOT THE REAL ERROR.** The band rested on "3
entries per transaction" and "7 claims", both marked as guesses and both scheduled for measurement
under E3. But how many instructions fit in a 1,232-byte packet is not measurable — it is arithmetic,
and asking for a measurement where arithmetic was needed deferred the answer for no reason. **The
document asked for a measurement where it needed a design decision.** The finding the guess hid: an
address lookup table takes entries to ~22 per transaction, collapsing the band to 0.023-0.048
SOL/day. The consequence is that §2.2's seat-cap re-take **can no longer be argued on transaction
cost at all** — only on working capital, which §4.3 had already called *"a bigger practical obstacle
than any line of the vault program"* and which is now the only obstacle left.

**The first draft had `enter` transferring the fee straight to the treasury, copying §4.2.** It
survived until `refund_abandoned_entry` was read, at which point the design had a fee it had already
spent and a round that never happened. The method was wrong before the answer was: taking a design
statement from a document written before a defect was fixed, without checking whether the fix
changed it.

**The first draft kept §4.3's settable `game_program` and its release CPI.** It was only on writing
out `lock_settlement`'s checks that the pointer turned out to be doing nothing an owner check does
not do better. A knob inherited from a design note is still a knob, and the audit was going to be
asked to concentrate on it.

**The first draft made the "measure the economy first" gate the headline recommendation**, on the
strength of `ARCHITECTURE-N-TEAM.md` §0 and risk 6. `HOUSE-EDGE-STUDY.md` §11 and
`HOUSE-SMALL-STAKE.md` had already retired it — 20,000-round and 186-run studies at the live rate,
against the mirror asserted byte-identical to `advance_fight`. **The gate was a stale reading of a
document that says, correctly, that the numbers do not transfer — written before somebody went and
transferred them.** It is the single largest correction in this file, and it moved the
recommendation from "not yet, and measure the game" to "not yet, and prove the rescue".
