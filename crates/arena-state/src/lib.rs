//! THE SHAPE OF A ROUND, AND THE ARITHMETIC THAT SAYS IT ADDS UP — owned by no program.
//!
//! WHY THIS CRATE EXISTS, IN ONE SENTENCE: so that the program which HOLDS the money and the program
//! which RUNS the fight check solvency with the same code, rather than with two implementations that
//! agree until they don't.
//!
//! ARENA-VAULT.md §3.4 is the whole argument and it is worth having here rather than one document
//! away. `arena_vault::lock_settlement` is the instruction that turns a committed `Round` into
//! claimable token payouts, and its step 5 is `Round::conserves()` — is `sum(hp + banked) +
//! penalties_collected == pot`. That check is the DEFINITION of a solvent round, it already exists
//! in `bulls-arena`, and the comment above it (see `Round::players_hold` below, which travelled here
//! with it) says at length why the vault must not write a second one: *"two implementations of a
//! solvency check is how solvency checks come to disagree, and the disagreement is discovered by a
//! player who cannot withdraw."*
//!
//! The same sentence applies twice over to the LAYOUT. The vault has to read the raw bytes of an
//! account another program wrote; if it carried its own copy of `struct Round`, the two copies would
//! be one careless field away from describing different accounts, and the symptom would be a
//! `players_hold()` computed over garbage. So the assertions that pin every byte offset live here —
//! `assert_the_account_layout_is_exactly_what_the_clients_decode`, near the bottom of this file — and
//! there is exactly one struct for them to pin. They are the single most consequential check in this
//! repository; they had two candidate homes and now they have one. They keep the coverage they had
//! by being a function rather than a `#[test]`: `bulls-arena`'s own test suite still calls them, and
//! `arena-vault`'s will too. That function's own comment explains why, and it is worth reading before
//! moving anything here.
//!
//! ------------------------------------------------------------------------------------------------
//! WHAT MUST NEVER GO IN HERE
//!
//!   * **A program id.** No `declare_id!`, no `pub const ID`, no pubkey that names a deployment.
//!     `bulls-arena` burns a fresh id on every deploy that matters, because the ER's validators cache
//!     bytecode by program id and never re-clone it (its file header tells that story, and `.devnet/`
//!     holds the keypairs to count). It will burn more. The vault is the program that must NEVER
//!     churn, and it churns the moment something
//!     it depends on carries an id that changes. An id here would be a second home for a fact that
//!     lives in exactly one place, `bulls-arena`'s `declare_id!`, and the failure mode of the two
//!     disagreeing is every `AccountLoader` in the game program refusing every round.
//!
//!   * **Instructions, contexts, accounts-derives, events, errors.** Anything that can be CALLED
//!     belongs to a program. This crate is a description of bytes and the arithmetic over them.
//!
//!   * **Anything that knows about the ephemeral rollup.** Delegation, commits, session keys, the
//!     VRF. The vault is never delegated and must not compile a line of that.
//!
//!   * **Game rules.** `advance_fight`, `roll_of`, the penalty curve and the lobby predicates stay in
//!     `bulls-arena`. The vault has no business being able to simulate a fight; it only needs to
//!     check that the fight the rollup reports is one where the money adds up. What keeping the
//!     fight out buys is a crate whose every line is either a byte offset or an addition — which is
//!     the property the drift argument above depends on, and the reason it can be reviewed by
//!     someone who has never read `advance_fight`. (`MAX_FIGHTERS`'s doc comment is the exception
//!     that proves it: the fight-length table came along because it is the ARGUMENT for the array's
//!     length, and the array's length is layout. It names a dozen identifiers that do not exist
//!     here, all of them in `bulls-arena`.)
//!
//! ------------------------------------------------------------------------------------------------
//! WHY THE STRUCT HERE IS `RoundState` AND NOT `Round`, WHICH IS THE ONE SURPRISE IN THIS FILE
//!
//! The account is `bulls_arena::Round`. The layout is `arena_state::RoundState`. They are the same
//! 3,240 bytes and neither name is a preference — both are forced, by two different rules, and it is
//! worth reading both before renaming anything.
//!
//! FORCE ONE: THE OWNER IMPL CANNOT LIVE HERE. `#[account(zero_copy)]` expands to `#[zero_copy]` plus
//! four impls — read `anchor-attribute-account-1.0.2/src/lib.rs`, the `owner_impl` binding, rather
//! than taking this on trust. Three are properties of the LAYOUT and would be fine anywhere:
//! `ZeroCopy`, `Discriminator` (derived from the type's ident, so it follows the NAME rather than the
//! file) and `AccountDeserialize`. The fourth is `Owner`, whose body is literally `crate::ID` — a
//! property of a DEPLOYMENT, and the one thing this crate may not know.
//!
//! Nor can it be written in `bulls-arena` instead. Rust's coherence rules forbid it, and this was
//! run rather than reasoned about:
//!
//! ```text
//! error[E0117]: only traits defined in the current crate can be implemented for types defined
//!               outside of the crate
//!   |  impl anchor_lang::Owner for arena_state::RoundState {
//!   = note: define and implement a trait or new type instead
//! ```
//!
//! `Owner` takes no type parameters, so no local type can appear in the impl for coherence to hang it
//! on. The compiler's own suggestion is the new type, and the new type says something true: **the
//! layout is shared; the ownership is one program's opinion about it.** `arena-vault` will hold this
//! same `RoundState` with no `Owner` at all, because it reads rounds it does not own and checks
//! `round.owner == vault_arena.game_program` by hand (§3.4 step 0).
//!
//! FORCE TWO: ANCHOR REFUSES TWO TYPES OF THE SAME NAME IN ONE PROGRAM'S GRAPH — and this is why the
//! struct here could not simply also be called `Round`. It was, briefly, and `anchor build` exits 1:
//!
//! ```text
//! Error: Conflicting accounts names are not allowed.
//! Program: `bulls_arena`
//! Account: `bulls_arena::Round`
//! ```
//!
//! The IDL builder disambiguates same-named types by full path and then rejects any account name
//! containing `::` (`anchor-lang-idl-0.1.2/src/build.rs`, `verify`). The wrapper is the one that has
//! to keep the name `Round`: anchor derives the on-chain discriminator from the ident, so a deployed
//! program, a served IDL and every client are all pinned to `sha256("account:Round")[..8]`. So the
//! layout took the new name, and this crate's own name is the reason `RoundState` is the right one —
//! `Round { state: RoundState }` reads as what it is.
//!
//! WHAT THAT COSTS, SAID PLAINLY: `anchor build`'s OWN IDL now describes `Round` as a single field of
//! type `RoundState` rather than as eighteen flat ones. Nothing in this repo consumes that file —
//! `scripts/idlgen.py` generates the three artefacts that are served and committed, for the reasons
//! its header gives — and borsh cannot tell the two shapes apart anyway, since a `repr(C)` struct of
//! one field serialises as that field. But it is a real divergence and it is written down here rather
//! than left for somebody to discover in `target/idl/`.
//!
//! REJECTED ALTERNATIVES, so the next reader does not re-derive them:
//!   * `declare_id!` here — violates the id rule above; the vault would need rebuilding on every
//!     `bulls-arena` deploy, which is the exact coupling §3.1 created two programs to avoid.
//!   * A `macro_rules!` that emits the struct into each consumer — one source, but TWO TYPES, so the
//!     offsets test would pin one of them and the vault would decode the other. That is the drift
//!     this crate exists to remove, moved one level down where it is harder to see.
//!   * `#[path = "…"] mod` across crate boundaries — same two-types problem, plus a source path that
//!     `cargo package` cannot follow.
//!   * Replacing `AccountLoader<Round>` in the game program with a hand-written `Accounts` impl over
//!     this struct — one type, no wrapper, and it rewrites the account-loading path of a live program
//!     to save a rename. The wrapper is `Deref`; that would have been surgery.
//!   * The vault depending on `bulls-arena` as a library (its `cpi`/`no-entrypoint` features already
//!     allow it) — correct about types, wrong about everything else: it drags
//!     `ephemeral-rollups-sdk`, `session-keys` and the whole fight into a custody program.
//!
//! A NOTE ON THE FIELD DOC COMMENTS BELOW, which still say `Round` throughout. That is deliberate and
//! it is not laziness: every one of them is compared character-for-character against the committed
//! IDL by `scripts/idlgen.py --verify`, so editing one is a failed build and a regenerated IDL. They
//! are also still correct — they describe the ACCOUNT, and the account is still called `Round`.
//!
//! ------------------------------------------------------------------------------------------------
//! WHAT THIS CRATE DOES *NOT* CARRY YET, AND WHY THAT IS NOT AN OVERSIGHT
//!
//! The account's 8-byte anchor discriminator is not a constant here. It does not need to be: the
//! wrapper in `bulls-arena` is named `Round`, so anchor derives the same eight bytes it always did,
//! and `the_wrapper_is_byte_for_byte_the_layout_it_wraps` asserts that against a fresh sha256 rather
//! than against a table. `arena-vault` will need it as a literal — it has no anchor account type to
//! derive it from — and that is the moment to add it, with a test that re-derives it, not before. S1
//! is a move; it is not the place to add the first thing nobody calls.

// `anchor_lang` rather than `solana-pubkey` + `bytemuck` alone, and it is a type-identity decision
// rather than a convenience. `Pubkey` must be THE SAME TYPE here as in both programs — a
// `Round.arena` of a different `Pubkey` type would not be a compile error at the boundary, it would
// be a `.to_bytes()` round-trip somebody adds to make it build, which is exactly the kind of
// conversion that silently reads the wrong account (see `bulls-arena`'s litesvm pin, which is the
// same argument about the same hazard). Depending on the same `anchor-lang = "=1.0.2"` both programs
// pin makes that identity structural instead of coincidental, and adds nothing to the dependency
// graph that was not already resolved.
use anchor_lang::prelude::*;

/// Hard ceiling on fighters in one round. Sized so the whole round is ONE account and therefore one
/// atomic commit.
///
/// THE STACK NO LONGER DECIDES THIS, AND FOR THE WHOLE LIFE OF THIS PROGRAM IT DID. The old value
/// was 16 because 40 had been tried and blew Solana's 4 KB stack: `Account<'info, Round>`
/// deserialises ONTO THE STACK, so a ~2.45 KB struct overflowed once Anchor's frame was added, and
/// devnet reported it as "Access violation reading 8 bytes at address 0x18" — a message naming
/// neither the stack nor the size. That comment named the fix and this change is it: the account is
/// zero-copy and every context holds an `AccountLoader`, which hands out a reference INTO the account
/// buffer instead of copying it. `size_of::<RoundState>()` is now irrelevant to the frame; what sits
/// on the stack is a pointer. That is asserted where the contexts are — `the_round_never_lands_on_the_stack`
/// in `programs/bulls-arena/src/lib.rs`, which is the only place an `AccountLoader` exists to measure.
///
/// SO THE BINDING CONSTRAINT MOVED, AND IT IS NOW FIGHT DURATION. Measured (400 seeds per lineup,
/// `advance_fight` itself, equal $10 stakes — the sweep in `tests/fight_length.rs`), the steps a
/// fight needs before one side has nobody standing is ~`31 * n^1.5`, so at the round's pace of
/// `2n` steps a second a fight lasts ~`15.5 * sqrt(n)` SECONDS. That grows without limit, and the
/// bell (`FIGHT_TIMEOUT_SECONDS`) is what it eventually outgrows: past that point a round stops
/// ending in a wipeout and starts being settled on who was ahead. The honest measure of "is this
/// lineup still a fight" is therefore the FRACTION OF ROUNDS THAT REACH A CONCLUSION BEFORE THE
/// BELL, and here it is, against the bell this program now rings:
///
/// ```text
///        |      the flat 4..27 die      |    THIS DIE (1..22 + 90@1/32)   |  aggregate spread
///   n    | median fight | before the bell | median fight | before the bell |  4..27  ->  now
/// -------+--------------+-----------------+--------------+-----------------+-----------------
///   16   |     83s      |     87.8%       |     91s      |     91.0%       |  7.36 -> 9.55
///   32   |    111s      |     81.3%       |    114s      |     82.5%       |  5.02 -> 6.63
///   40   |    120s      |     76.0%       |    121s      |     80.0%       |  4.60 -> 6.01
///   48   |    124s      |     76.3%       |    127s      |     77.8%       |  4.19 -> 5.64   <- this cap
///   52   |    133s      |     70.0%       |    134s      |     70.5%       |  4.10 -> 5.32
///   60   |    133s      |     67.3%       |    141s      |     68.5%       |  3.82 -> 5.00
///   64   |    151s      |     62.5%       |    140s      |     67.8%       |  3.41 -> 4.88
/// ```
///
/// (Equal $10 stakes, sides alternating, 400 seeds per cell, `sandbox/house-edge/check-variance-bell.ts`.
/// The 16-fighter row is the OLD cap; under the OLD 120s bell it concluded 74.2% of the time, which
/// is the bar the whole derivation below is against. "Aggregate spread" is the standard deviation of
/// the final side-vs-side split in points of the pot — the deliverable of the variance change, and
/// the reason there are now two dice in this table at all.)
///
/// THE DIE CHANGED AND THIS TABLE HAD TO BE RE-MEASURED, not adjusted. The left half is the original
/// measurement and it reproduces to the tenth of a percent, which is how the rig that produced the
/// right half was validated before any of its numbers were believed. The result worth noticing is
/// that the bell got BETTER at every single lineup size — 76.3% to 77.8% at this cap, and 62.5% to
/// 67.8% at 64 — while the aggregate spread rose by about 1.3x throughout. A heavier tail kills
/// faster than it drags, so the change that was supposed to cost fight length bought some. See
/// `roll_of`, and note that the constraint which actually bound the die was NOT this table but
/// `PENALTY_HORIZON_STEPS` at the SMALL lineups, in the opposite direction.
///
/// 48 IS THE LARGEST LINEUP THAT STILL BEATS WHAT THE LIVE GAME ALREADY SHIPS. That is the whole
/// derivation: 16 fighters against the old 120-second bell concluded 74.2% of the time, so 74.2% is
/// not a target invented for this change — it is the quality bar the deployed program already
/// meets. 48 clears it (76.2%); 52 and above do not. 60 is reachable and nothing structural refuses
/// it — see below — but it would need a 210-second bell to hold the same bar, and a three-and-a-half
/// minute round is a different product, not a bigger board.
///
/// WHAT DOES *NOT* BIND, each checked rather than assumed, because the interesting result is that
/// none of the three things anyone would have guessed is the limit:
///   * THE 4 KB STACK — removed by `zero_copy`, above.
///   * THE ACCOUNT SIZE — `Round::SIZE` is 3,248 B at this cap, against Solana's own
///     `MAX_PERMITTED_DATA_LENGTH` of 10 MiB. Four orders of magnitude of room. It costs rent (see
///     `Round::SIZE`), and rent is reclaimable by `close_round_account`, so it is float rather than
///     cost. SAY WHAT IS ACTUALLY KNOWN, THOUGH: 10 MiB is the BASE LAYER's limit, and it is the
///     only one anybody here has a source for. This repo has quoted "the ER's 10 MiB account limit"
///     since ER_MIGRATION_PLAN.md and MAGICBLOCK_RESEARCH.md lists the runtime limits document as
///     never read; whether MagicBlock imposes anything tighter on a DELEGATED account, or on the
///     size of a commit, is unmeasured. Tripling the account is a much smaller step than the margin
///     to 10 MiB suggests it is, because the margin is to the wrong number. What is known is that
///     the round is committed as one account and this repo has never seen a size-related commit
///     failure at 1,102 B; 3,248 B is the first real test of that.
///   * COMPUTE — bounded by construction rather than by the lineup, and that IS a change this
///     migration had to make. See `MAX_STEPS_PER_CALL`: no single instruction may advance the fight
///     more than a measured number of steps, whatever the cap is. Before this, one constant did
///     both jobs and the fight could not outgrow one transaction; the honest consequence of raising
///     the cap is that a badly-neglected round now takes several transactions to settle rather than
///     one, and `resolve` says so in its own comment.
///
/// One account per fighter was the alternative, and is still rejected: 48 delegations and 48 commits
/// per round, the round stops being atomic, and a partial commit leaves a round half-settled with no
/// obvious way to tell which half is real.
///
/// ARCHITECTURE-N-TEAM.md §7 says "not raise `MAX_FIGHTERS` above 16 — the scaling axis is more
/// concurrent arenas". That recommendation is overruled by the owner, not refuted, and it is worth
/// leaving standing: the two are not exclusive, and its argument (nine arenas of sixteen is nine
/// independent failure domains, one arena of forty-eight is one) is untouched by anything measured
/// here.
pub const MAX_FIGHTERS: usize = 48;

// `Debug`/`PartialEq` only for tests: the cursor-invariance tests compare whole fighter arrays
// (`ticking_in_chunks_is_identical_to_one_shot` asserts `one_shot == chunked` over `[Fighter; 48]`),
// and a failure there is worth reading rather than guessing at. It costs the deployed binary nothing,
// which matters — the program that ships this crate is size-constrained on devnet (rent scales with
// the binary, against a faucet-limited payer; see MAX_FIGHTERS's doc comment).
//
// `feature = "test-support"` AND NOT `cfg(test)` ALONE, AND THE MOVE INTO THIS CRATE IS WHY. `cfg(test)`
// is true only while compiling THE CRATE UNDER TEST. It was the whole story while `Fighter` lived in
// `bulls-arena`; now that it lives here, `cargo test -p bulls-arena` compiles this crate as an
// ordinary dependency with `cfg(test)` false, and the array comparison stops compiling. The feature
// is how a dependent asks for the derives back, and `bulls-arena` asks in `[dev-dependencies]` —
// which resolver 2 keeps OUT of `cargo build-sbf`, so the deployed binary is unchanged. `cfg(test)`
// stays in the condition so this crate's own tests need no flag.
/// ONE FIGHTER, LAID OUT SO THAT `repr(C)` AND BORSH PRODUCE THE SAME BYTES. That coincidence is not
/// decoration; it is what keeps every client working, and it is the reason the field order changed.
///
/// `#[zero_copy]` puts `#[repr(C)]` on this struct and derives `bytemuck::Pod`, which REFUSES a type
/// with padding — the derive fails to compile rather than silently reinterpreting uninitialised
/// bytes. The old field order (`wallet, side, dead, stake, hp, banked`) has a six-byte hole between
/// `dead` and `stake`, because `u64` wants an eight-byte boundary. So the eight-byte fields are
/// hoisted above the single bytes and the remaining hole is written out as a field.
///
/// WHY IT MATTERS THAT THE HOLE IS EXPLICIT rather than left to the compiler. `@coral-xyz/anchor`
/// 0.32.1 — the version the browser ships — decodes account data as flat borsh whatever the IDL's
/// `serialization`/`repr` say; the bytemuck path exists in its *types* and not in its *coder*. Flat
/// borsh writes fields in order with no gaps. So a `repr(C)` struct whose every gap is a declared
/// `[u8; N]` field decodes correctly under a decoder that knows nothing about alignment, and one with
/// an implicit gap does not — it desyncs at the first hole and every field after it is garbage.
/// `the_account_layout_is_exactly_what_the_clients_decode` pins each field's byte offset so this
/// cannot drift, and it is the test to read before changing anything here.
///
/// 64 B, up from 58. The six bytes are the hole, and they are the price of the account never touching
/// the stack again — see `MAX_FIGHTERS`.
#[zero_copy]
#[derive(Default)]
#[cfg_attr(any(test, feature = "test-support"), derive(Debug, PartialEq, Eq))]
pub struct Fighter {
    pub wallet: Pubkey, // 32
    pub stake: u64,     // 8  — net of fee, what they put in
    pub hp: u64,        // 8  — value still in the ring
    pub banked: u64,    // 8  — value raided from the other side
    pub side: u8,       // 1
    pub dead: u8,       // 1
    /// Alignment, declared rather than implied — see the struct's doc comment. Always zero; nothing
    /// reads it. It exists so `bytemuck::Pod` will accept this type AND so a borsh-shaped decoder
    /// lands on the same offsets the program does.
    pub padding: [u8; 6],
} // 64 B

/// `Abandoned` is the terminal state of a lobby that reached its deadline without enough fighters to
/// hold a fight — see `abandon_round`. It is a fifth PHASE rather than a flag on `Settled` because
/// nothing was settled: there is no winner, no seed, no fight to verify, and a client that read
/// `Settled` would go looking for all three. Appended, so every existing phase keeps its number.
// `Copy` so a test can sweep the phase table (`for phase in [Phase::Lobby, ...]`) and still name the
// value it just wrote in the failure message. Costs the deployed binary nothing — this is a
// field-less enum and the cast was always a no-op.
#[derive(Clone, Copy)]
#[repr(u8)]
pub enum Phase { Lobby = 0, Drawing = 1, Fight = 2, Settled = 3, Abandoned = 4 }

/// THE ROUND'S STATE, AND IT IS NO LONGER COPIED ANYWHERE. Zero-copy rather than borsh is the change
/// that let `MAX_FIGHTERS` rise at all: a borsh `#[account]` is deserialised ONTO THE STACK by
/// `Account<'info, T>`, and Solana's frame is 4 KB. See `MAX_FIGHTERS` for the failure that cost a
/// debugging session, and `the_round_never_lands_on_the_stack` in `programs/bulls-arena/src/lib.rs`
/// for the assertion that it cannot come back — it lives there because that is where the
/// `AccountLoader` it measures lives.
///
/// THIS STRUCT IS `RoundState`; THE ACCOUNT IS `bulls_arena::Round`, one `repr(C)` field wide,
/// holding exactly this. The crate header works through why the two names are forced — an `Owner`
/// impl that may not live here and an anchor IDL builder that refuses two types of one name — and
/// why the field doc comments below still, correctly, say `Round`.
///
/// FOUR FIELDS MOVED AND TWO CHANGED TYPE, AND EVERY ONE OF THOSE EDITS IS ALIGNMENT. `repr(C)`
/// inserts padding wherever a field's offset is not a multiple of its alignment, and
/// `bytemuck::Pod`'s derive refuses a struct that has any — so the layout has to be arranged so that
/// none is needed, and whatever is left over has to be a declared field. Concretely: `fighter_count`
/// (a `u16`) sat at offset 43 behind three `u8`s and needed an even offset, so it swapped with
/// `bump`; `house_swept` came up from below to fill the byte after it; and two bytes of `padding`
/// carry the struct to the eight-byte boundary `tick_count` needs. Nothing was reordered for taste.
///
/// THE RESULT IS THAT `repr(C)` AND BORSH AGREE BYTE FOR BYTE, which is not a nicety — it is what
/// keeps the browser reading this account. See `Fighter`, where the same argument is written out in
/// full, and `the_account_layout_is_exactly_what_the_clients_decode`, which pins every offset.
///
/// `#[zero_copy]` AND NOT `#[account(zero_copy)]`, WHICH IS WHAT THIS CARRIED IN `bulls-arena`. The
/// two produce the same bytes and the same `repr(C)`; what `#[account]` adds on top is an `Owner`
/// impl returning `crate::ID`, and an id is the one thing this crate refuses to know. Nothing about
/// the ACCOUNT changes: the wrapper is named `Round`, so the discriminator is the same eight bytes,
/// and it is one `repr(C)` field wide, so it is the same 3,240.
#[zero_copy]
pub struct RoundState {
    pub arena: Pubkey,
    pub round_no: u64,
    pub phase: u8,
    pub winner: u8,
    /// Moved ahead of `bump` for alignment — see the struct's doc comment. A `u16` at offset 43
    /// would have made `repr(C)` insert a byte the clients' decoder does not know about.
    pub fighter_count: u16,
    pub bump: u8,
    /// Has `sweep_house_take` already taken this round's `fees_collected + penalties_collected` onto
    /// the arena's `Treasury`? One byte, so a permissionless sweep cannot be run twice.
    ///
    /// `u8` RATHER THAN `bool`, AND NOT BY PREFERENCE. `bytemuck` does not implement `Pod` for
    /// `bool` and is right not to: `bool` has exactly two valid bit patterns and a zero-copy cast
    /// would happily hand out a `bool` holding 0x02, which is undefined behaviour rather than a
    /// surprising value. A `u8` has no invalid pattern. Read it through `Round::is_swept()` so the
    /// call sites still say what they mean; the only place the raw byte appears is where it is set.
    ///
    /// ON THE ROUND RATHER THAN INFERRED, because there is nothing to infer it from: the sweep moves
    /// no value out of the round (the totals stay for auditing — zeroing them would destroy the very
    /// record conservation is checked against), so after a sweep the account is byte-identical to
    /// before it except for this flag. Without it the second call is indistinguishable from the
    /// first and the house's total inflates by one round every time anyone presses the button.
    pub house_swept: u8,
    /// Alignment, declared rather than implied — see the struct's doc comment and `Fighter`'s.
    /// Always zero; nothing reads it.
    pub padding: [u8; 2],
    pub tick_count: u64,
    pub pot: u64,
    /// THE LEAK, NAMED. Extract penalties taken out of this round for the house, cumulative.
    ///
    /// Until this field existed, every fighter's `hp + banked` summed to exactly `pot` forever, and
    /// this repo checks that in six places — the Rust tests, the TypeScript mirror's `totalValue`, the
    /// browser's `verifyRound`, and the devnet scripts. `extract` now moves value OUT of the round, so
    /// that identity is no longer true and the honest response is to record where the difference went
    /// rather than to weaken the check. Conservation becomes:
    ///
    /// ```text
    /// sum(hp + banked) + penalties_collected == pot
    /// ```
    ///
    /// — still exact, still provable from the account alone, and now it also proves the house took
    /// precisely what the published curve says it should. A silently-subtracted penalty would have
    /// been unauditable AND would have made every existing verifier report a false mismatch on any
    /// round where somebody extracted, which reads as an accusation of cheating rather than as a
    /// missing field.
    ///
    /// It is a RECORD, not custody: this program deliberately holds no balances (see the file header),
    /// so the treasury is paid off-chain from the ledger, and this is the number that settlement is
    /// owed against.
    pub penalties_collected: u64,
    /// THE OTHER HOUSE TAKE — the arena's entry fee, cumulative across every `enter` this round saw,
    /// top-ups included. AND UNTIL THIS SESSION IT WAS NOT RECORDED ANYWHERE AT ALL.
    ///
    /// WHAT THE BUG ACTUALLY WAS. `enter` has always computed `stake × fee_bps / BPS`, subtracted it
    /// from the player, and credited the fighter the remainder. The fee itself was a local that went
    /// out of scope one line later. Not stored, not transferred, not emitted. Every player paid it,
    /// every round, and the house received nothing — `Arena.fee_bps` was a number whose only effect
    /// was to make stakes smaller. The pot was net of a fee that existed nowhere.
    ///
    /// WHY IT SURVIVED, WHICH IS THE PART WORTH KNOWING. It was not an oversight in the arithmetic;
    /// there was no legal destination. `enter` executes INSIDE THE ROLLUP — the round is delegated
    /// from lobby open — and `Arena` lives on the base layer and is never delegated. A rollup
    /// transaction cannot write a base-layer account, so at the instant the fee is charged the only
    /// writable account in scope is the round itself. `penalties_collected` had already met that
    /// exact wall and answered it exactly this way; the fee simply never got the same treatment, and
    /// the asymmetry is what let one house edge be plumbed while the other evaporated in silence.
    ///
    /// So this field is the answer, and `sweep_house_take` is where it goes afterwards, once the
    /// round has undelegated and a base-layer account is reachable again.
    ///
    /// CONSERVATION, RESTATED IN GROSS TERMS. `pot` is the sum of NET stakes, so the old identity
    /// was never wrong — it was narrow. It described the money INSIDE the ring and said nothing
    /// about what players had actually been charged to get there. Three quantities, the third of
    /// which is the one this whole change exists to produce:
    ///
    /// ```text
    /// players_hold   = sum(hp + banked)                    still owed to fighters
    /// house_took     = penalties_collected + fees_collected the house's take from this round
    /// gross_deposits = pot + fees_collected                what players were actually charged
    ///
    /// players_hold + house_took == gross_deposits
    /// ```
    ///
    /// BE CLEAR ABOUT WHAT THAT IS AND IS NOT. Algebraically it is the old identity with
    /// `fees_collected` added to both sides, because the fee is the one quantity here that never
    /// entered the ring — it was taken at the door. So it does not make the check STRONGER, and a
    /// verifier that dropped the term from both sides would still pass. What it makes is the
    /// statement HONEST: `pot` stops being mistakable for what players paid, and `house_took` — the
    /// number the whole exercise is about — becomes a named quantity every verifier computes instead
    /// of a subtraction each one does differently or not at all.
    ///
    /// The thing that actually pins the fee is therefore NOT this identity, and pretending otherwise
    /// would be the more dangerous kind of test. It is `enter` itself, asserted directly against a
    /// known gross stake in `the_fee_is_recorded_rather_than_discarded`, and the `Entered` event,
    /// which publishes the gross and the fee per entry so any single charge can be re-checked
    /// against the published rate.
    ///
    /// A RECORD, NOT CUSTODY, exactly as `penalties_collected` is: this program holds no balances
    /// (see the file header), so both are claims the off-chain treasury is settled against until
    /// ARCHITECTURE-N-TEAM.md §4 lands. See `sweep_house_take` for which half of that survives.
    pub fees_collected: u64,
    pub seed_commit: [u8; 32],
    pub seed: [u8; 32],
    /// WHEN THE LOBBY OPENED, AND WHEN IT STOPS TAKING ENTRIES — the countdown, as chain truth.
    ///
    /// WHY THESE ARE ON THE ACCOUNT AT ALL. A lobby used to stay open until an operator chose to call
    /// `close_lobby_and_draw`, and the only timestamp a round carried was `fight_started_at` — which
    /// does not exist yet while the lobby is open. So a UI counting down to "entries close in 0:12"
    /// was counting down to a number it had invented, describing an intention the chain had never
    /// been told about. Every other figure this project puts on screen is re-derivable from the
    /// account by a sceptic; the countdown was the one that wasn't. Now `lobby_closes_at - now` is
    /// the number, `enter` refuses past it and `close_lobby_and_draw` refuses before it, so the clock
    /// on screen is the same clock the program is enforcing.
    ///
    /// BOTH ENDS, NOT JUST THE DEADLINE — the second timestamp earns its eight bytes twice:
    ///   * A progress bar needs the DURATION, not the remaining time. The off-chain original drew
    ///     exactly this bar (`web/index.html`: `roundbar.style.width = (1 - left/LMS) * 100 + "%"`),
    ///     and with only `lobby_closes_at` a client would have to supply `LMS` from a constant of its
    ///     own — the same invented number moved to a different file.
    ///   * It makes `open_round`'s clamp self-evident instead of taken on trust:
    ///     `lobby_closes_at - lobby_opened_at` IS the duration the chain used, so an operator who
    ///     passed nonsense sees the clamped value by reading the round, and anyone can check it lies
    ///     within [MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS] without going to find the opening
    ///     transaction's block time.
    ///
    /// STAMPED ON THE BASE LAYER, COMPARED IN THE ROLLUP — for a long time the one assumption in the
    /// whole feature that had NOT been measured. IT HAS NOW BEEN; the numbers are at the bottom of
    /// this block. `open_round` runs before `delegate_round`, so `Clock` here is the base layer's,
    /// while `enter`'s and `close_lobby_and_draw`'s comparisons against it happen in the ER against
    /// the ER's. This is the program's FIRST cross-domain time comparison — `fight_started_at` is
    /// stamped and read entirely inside the ER by design — so nothing in this repo had ever
    /// exercised it.
    ///
    /// Nothing else is derived from these two numbers, so a skew shifts the deadline by that skew and
    /// corrupts nothing. But THE TWO DIRECTIONS ARE NOT SYMMETRIC and only one of them is benign:
    ///   * ER clock BEHIND the base layer: the lobby simply lasts longer than asked. Harmless.
    ///   * ER clock AHEAD by more than the whole duration: the round opens ALREADY EXPIRED. Every
    ///     `enter` fails `LobbyClosed`, the lobby reaches its deadline at zero fighters, and the only
    ///     outcome is `abandon_round` — for every round, forever, reported as an error that names the
    ///     wrong cause. `MIN_LOBBY_SECONDS` (20) is the entire margin against this and carries no term
    ///     for clock skew, because there is no measurement to put one on.
    ///
    ///     AND THAT MARGIN HAS SINCE BEEN CUT, WHICH IS WORTH STATING PLAINLY RATHER THAN LEAVING FOR
    ///     SOMEONE TO DISCOVER. The floor was 30 = a 20s entry window + a 10s delegation budget. The
    ///     10 was then shown to be wrong — it came from `admin-open-round.mjs`'s poll CEILING, and the
    ///     hand-off measures 1.70s/1.87s against live devnet — so the floor came down to 20. That
    ///     reasoning is sound about DELEGATION and says nothing whatever about SKEW: the same ten
    ///     seconds happened to be the only thing standing between an unmeasured skew and a program
    ///     that opens every round pre-expired. Removing slack for a measured reason still removes it
    ///     from the unmeasured one it was also, accidentally, protecting.
    ///
    /// MEASURED, 2026-08-09, AND THE MARGIN HOLDS. `Clock::unix_timestamp` was read from the base
    /// layer (`api.devnet.solana.com`) and from all four ER validators the router advertises, 38
    /// samples across two runs separated in time. Each reading is bracketed by local send/recv times
    /// and referenced to their midpoint, and the base/ER pair is differenced PER SAMPLE, so the
    /// measuring machine's own clock cancels and never enters the result. Signed skew, ER minus base,
    /// in seconds — positive is ER-ahead, the dangerous direction:
    ///
    /// ```text
    /// validator     median (run 1 / run 2)   worst observed
    /// devnet-eu           +0.84 / +0.88          +0.88
    /// devnet-tee          +0.72 / +0.75          +1.72
    /// devnet-as           +0.68 / +0.67          +1.68
    /// devnet-us           +0.53 / +0.53          +1.55
    /// ```
    ///
    /// Medians reproduce across the two runs to within 0.04s, so this is stable, not drifting. The
    /// per-validator spread (~1.0-1.7s) is essentially the +/-1s quantisation of differencing two
    /// whole-second clocks; the true skew is sub-second. Worst case is 8.6% of `MIN_LOBBY_SECONDS`
    /// and 2.9% of the 60s lobbies actually opened, against a catastrophic threshold of "skew
    /// exceeds the WHOLE duration" — a factor of twelve away even at the floor. NO SKEW TERM IS
    /// NEEDED in `MIN_LOBBY_SECONDS`, which is why there still isn't one.
    ///
    /// TWO CAVEATS, because the number is more comforting than it should be:
    ///   * The skew is SYSTEMATIC, not noise around zero — all four validators sit ahead of base, in
    ///     the one direction that can wedge a round. It is the base layer's stake-weighted timestamp
    ///     oracle lagging real time (base ran ~1.0s behind the measuring machine; the ERs within
    ///     ~0.2s of it). Being structural, it will not average away, and a future base-layer change
    ///     that widens that lag moves this number without anything here changing.
    ///   * It measures VALIDATOR CLOCKS, not the program-observed pairing. What was checked is that
    ///     each endpoint's served `Clock` sysvar equals `getBlockTime` for its own slot — i.e. it is
    ///     the bank clock a transaction sees, not an RPC artefact — and that the ERs report their own
    ///     slot heights rather than mirroring base. The honest end-to-end version is `lobby_opened_at`
    ///     (base) against a live `enter` (ER) on one round, which only became possible once this
    ///     program was deployed.
    ///
    /// IF IT EVER GOES BAD, the fix is not a bigger constant: move the stamp to the enforcing clock —
    /// store the duration at `open_round` and stamp both ends on the first ER-side instruction — so
    /// the two are the same clock, as they already are for `fight_started_at`.
    pub lobby_opened_at: i64,
    pub lobby_closes_at: i64,
    /// Unix timestamp `callback_seed` stamped when `Phase::Fight` began. `resolve` derives `steps`
    /// from elapsed real time against this — see the constants near `DUST` for why.
    pub fight_started_at: i64,
    pub fighters: [Fighter; MAX_FIGHTERS],
}
impl RoundState {
    // 8 discriminator + 32 arena + 8 round_no + 1 phase + 1 winner + 2 count + 1 bump
    // + 1 house_swept + 2 padding + 8 ticks + 8 pot + 8 penalties_collected + 8 fees_collected
    // + 32 commit + 32 seed + 8 lobby_opened_at + 8 lobby_closes_at + 8 fight_started_at + fighters
    //
    // 3,248 bytes, up from 1,102, and BOTH halves of that increase are worth separating because only
    // one of them is the feature. The header grew by two bytes (the alignment `padding`); the rest is
    // the fighter array going from 16x58 to 48x64 — three times the seats, plus six bytes per seat
    // for `Fighter`'s own alignment hole.
    //
    // WHAT IT COSTS: rent-exempt deposit goes 0.008561 -> 0.023497 SOL per round ((128 + size) x
    // 6,960 lamports). That is float rather than cost — `close_round_account` returns every lamport
    // of it once a round leaves the retention window — but it is float the keeper has to be FUNDED
    // for, and the standing balance scales with `MIN_RETAINED_ROUNDS`: twenty retained rounds now
    // hold 0.470 SOL against 0.171 before. The per-round unrecoverable cost is unchanged at
    // ~0.00041 SOL, because none of this increase is consumed.
    //
    // 10 MiB is the BASE LAYER's `MAX_PERMITTED_DATA_LENGTH`, and this is 0.03% of it. Whether the
    // ER imposes anything tighter on a DELEGATED account is unmeasured — `MAX_FIGHTERS`'s doc comment
    // makes that point at length and this line used to contradict it by asserting the ceiling was the
    // ER's. It is not; nobody here has a source for the ER's.
    //
    // WRITTEN OUT AS ARITHMETIC RATHER THAN AS `8 + size_of::<Round>()`, which would be shorter and
    // could not be wrong. That is exactly why: `size_of` would make this line agree with the struct
    // BY CONSTRUCTION, and the thing worth catching is a field added to the struct without anyone
    // thinking about the account. `the_account_layout_is_exactly_what_the_clients_decode` asserts
    // this tally against `size_of` and against every individual field offset, so the two have to be
    // reconciled by a person once, and by the test forever after.
    //
    // THE 8 IS A DISCRIMINATOR THIS STRUCT DOES NOT ITSELF CARRY, which is worth saying now that the
    // struct and the account live in different crates. `arena_state::Round` is a plain `#[zero_copy]`
    // layout (see its doc comment); the eight bytes belong to the ACCOUNT, written by anchor in the
    // program that owns it. So this constant is "how big the account is", not "how big this struct
    // is" — the two differ by exactly those eight bytes, `size_of::<Round>()` is 3,240, and a reader
    // decoding a round starts at `data[8..]`. Both numbers are asserted against each other in
    // `the_account_layout_is_exactly_what_the_clients_decode`.
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 2 + 1 + 1 + 2 + 8 + 8 + 8 + 8 + 32 + 32 + 8 + 8 + 8
        + (core::mem::size_of::<Fighter>() * MAX_FIGHTERS);

    /// Has this round's house take already been swept? See `house_swept` for why the field is a
    /// `u8` and this is a method.
    pub fn is_swept(&self) -> bool { self.house_swept != 0 }

    // ---------------------------------------------------------------------------------------
    // THE ROUND'S BOOKS, AS THE PROGRAM'S OWN ARITHMETIC.
    //
    // These four functions are the three quantities `fees_collected`'s doc comment defines and the
    // identity that ties them together. Until now their only executable form was a
    // `#[cfg(test)]` helper called `books` in `house_tests` — which is to say the shipped program
    // could state the identity in prose but could not evaluate it.
    //
    // THAT WAS FINE WHILE CONSERVATION WAS A PROPERTY OF A LEDGER NOBODY SETTLED AGAINST, AND IT
    // STOPS BEING FINE THE MOMENT A TOKEN ESCROW HAS TO HOLD EXACTLY THESE NUMBERS.
    // ARCHITECTURE-N-TEAM.md §4.4(b) makes a base-layer conservation check the thing that stops a
    // dishonest rollup commit from INFLATING a round (it cannot stop redistribution — see §4.4(a)),
    // and a custody program that re-derived the identity for itself would be a second
    // implementation of a solvency check. Two implementations of a solvency check is how solvency
    // checks come to disagree, and the disagreement is discovered by a player who cannot withdraw.
    // One definition, here, called by the tests, by `apply_sweep`, and by whatever eventually holds
    // the tokens.
    //
    // "HERE" USED TO MEAN `programs/bulls-arena/src/lib.rs`, AND THAT IS WHY THIS CRATE EXISTS. The
    // paragraph above was written while the sentence "one definition" was a promise the file could
    // not keep on its own: a second program cannot call a function it cannot link to, so the vault's
    // only options were to depend on the whole game program or to write the check again. This crate
    // is the third option, and it is the one ARENA-VAULT.md §3.4 asks for by name. Nothing about the
    // arithmetic changed in the move — it is the same four functions, byte for byte — and that is
    // the point: the extraction was worth doing precisely because it was not worth rewriting.
    //
    // EVERY ONE RETURNS `Option`, AND THAT IS NOT DEFENSIVE STYLE. The fighters these read came
    // back from an ephemeral rollup over a commit this program did not compute, which is the entire
    // reason to check conservation in the first place. `fighter_count` is a `u16` in that committed
    // buffer and nothing on the base layer has ever constrained it to `<= MAX_FIGHTERS`. A verifier
    // that panics on the malicious input it exists to reject is not a verifier — it is a denial of
    // service with the round's rent inside it.
    // ---------------------------------------------------------------------------------------

    /// What this round's fighters are still owed: `sum(hp + banked)` over the live prefix.
    ///
    /// `None` if `fighter_count` is past the array (a corrupt or hostile commit) or if the sum
    /// overflows — both of which mean "do not trust this round", which is what the caller does with
    /// it.
    pub fn players_hold(&self) -> Option<u64> {
        let n = self.fighter_count as usize;
        if n > MAX_FIGHTERS {
            return None;
        }
        self.fighters[..n]
            .iter()
            .try_fold(0u64, |acc, f| acc.checked_add(f.hp)?.checked_add(f.banked))
    }

    /// The house's take from this round: the entry fee at the door plus the extract penalties from
    /// the ring. This is the figure `sweep_house_take` moves onto the `Treasury`.
    pub fn house_took(&self) -> Option<u64> {
        self.penalties_collected.checked_add(self.fees_collected)
    }

    /// What players were actually charged to be in this round — `pot + fees_collected`.
    ///
    /// NAMED, BECAUSE `pot` IS ROUTINELY MISTAKEN FOR IT. `pot` is the sum of NET stakes; the fee
    /// never entered the ring. Under ARCHITECTURE-N-TEAM.md §4.2 this is precisely the quantity a
    /// round's escrow receives, so it is the left-hand side of the token-side solvency check that
    /// does not exist yet: `escrow_balance == gross_deposits` for a round whose fee has not yet been
    /// swept to the treasury ATA, and `escrow_balance == pot` once it has.
    pub fn gross_deposits(&self) -> Option<u64> {
        self.pot.checked_add(self.fees_collected)
    }

    /// `sum(hp + banked) + penalties_collected == pot` — conservation, from the account alone.
    ///
    /// THE RING FORM, NOT THE GROSS FORM, AND DELIBERATELY. The gross identity
    /// `players_hold + house_took == gross_deposits` is algebraically this one with
    /// `fees_collected` added to both sides (see `fees_collected`'s doc comment, which says so at
    /// length), so checking it would be checking the same thing while looking like more. The fee is
    /// pinned by `the_fee_is_recorded_rather_than_discarded` and by the `Entered` event, not by an
    /// identity it cancels out of.
    ///
    /// A `false` here means one of two things and neither is survivable: the rollup committed a
    /// state this program's own fight loop could not have produced, or this program has a bug. Both
    /// answer "stop", which is why the caller is `apply_sweep`.
    pub fn conserves(&self) -> bool {
        let Some(held) = self.players_hold() else { return false };
        let Some(ring) = held.checked_add(self.penalties_collected) else { return false };
        ring == self.pot
    }
}

// ------------------------------------------------------------------------------------------------
// THE LAYOUT. Native, no runtime, no network.
//
// THIS IS MOST OF THE REASON THE CRATE EXISTS. The assertions below were written in `bulls-arena`,
// where they pinned the offsets of the only `Round` there was. The moment a second program has to
// decode those bytes, "the only `Round` there was" stops being true by itself and has to be MADE
// true — which is what one struct in one crate does, and what a copied struct plus a copied test
// only appears to do. ARENA-VAULT.md §3.4: "the offsets test is the thing that must have exactly one
// home."
//
// SO WHY IS THE BODY A `pub fn` AND NOT SIMPLY A `#[test]`? Because `cfg(test)` is true only while
// compiling THE CRATE UNDER TEST, and the commands this repo actually documents do not test this
// crate. `programs/bulls-arena/src/lib.rs` tells a developer to run
// `cargo test --manifest-path programs/bulls-arena/Cargo.toml`; `programs/bulls-arena/mutation-test.sh`
// runs `cargo test -p bulls-arena --lib`. Neither builds this crate's `#[cfg(test)]` items. Leaving
// the assertions as a private test would have moved the single most consequential check in the
// repository somewhere that only `cargo test --workspace` reaches — i.e. it would have kept ONE home
// and quietly given up the coverage, which is the worse half of the trade.
//
// One body, two call sites: this crate's own `#[test]` below, and `bulls-arena`'s test of the same
// name, which reaches it through the `test-support` feature its `[dev-dependencies]` turns on. The
// assertions cannot drift because there is only one copy of them; the coverage cannot vanish because
// the program's own test suite calls it.
// ------------------------------------------------------------------------------------------------

/// EVERY FIELD'S BYTE OFFSET, PINNED. The single most consequential test in this file, and it
/// replaces one that could no longer be written.
///
/// WHAT IT REPLACES AND WHY. This used to borsh-encode a real `Round` and assert the length,
/// because borsh field order WAS the account layout. `#[account(zero_copy)]` has no borsh
/// encoder to call — the account IS the struct's `repr(C)` bytes — so that test cannot compile.
/// Deleting it and asserting only `size_of` would be a real loss: the size can be right while
/// every field sits somewhere the clients do not expect.
///
/// AND THE CLIENTS ARE THE POINT. `@coral-xyz/anchor` 0.32.1, which the browser ships, decodes
/// account data as flat borsh no matter what the IDL says about `repr` — the bytemuck path exists
/// in its types and not in its coder. Flat borsh means "each field immediately after the last,
/// no gaps". So this program's `repr(C)` layout is readable by the browser if and ONLY IF it has
/// no implicit padding, which is exactly what these assertions state, field by field:
/// `offset_of!(f_k+1) == offset_of!(f_k) + size_of(f_k)`, all the way down. One hole anywhere and
/// every field after it decodes as garbage — silently, in a browser, against real money.
///
/// Two other things fall out of the same list and are asserted alongside:
///   * `Round::SIZE` is reconciled against BOTH the hand-written tally (which is what a reader
///     checks) and `size_of` (which is what the runtime allocates against).
///   * `er-demo/scripts/verify-session-extract.mjs` decodes these bytes by hand, offset by
///     literal offset. The numbers it needs are the ones printed here.
#[cfg(any(test, feature = "test-support"))]
pub fn assert_the_account_layout_is_exactly_what_the_clients_decode() {

    use core::mem::{offset_of, size_of};

    // (name, offset, size) in declaration order. A field added to the struct and forgotten here
    // shows up as the final total disagreeing with `size_of::<Round>()`.
    let fields: &[(&str, usize, usize)] = &[
        ("arena",               offset_of!(RoundState, arena),               32),
        ("round_no",            offset_of!(RoundState, round_no),             8),
        ("phase",               offset_of!(RoundState, phase),                1),
        ("winner",              offset_of!(RoundState, winner),               1),
        ("fighter_count",       offset_of!(RoundState, fighter_count),        2),
        ("bump",                offset_of!(RoundState, bump),                 1),
        ("house_swept",         offset_of!(RoundState, house_swept),          1),
        ("padding",             offset_of!(RoundState, padding),              2),
        ("tick_count",          offset_of!(RoundState, tick_count),           8),
        ("pot",                 offset_of!(RoundState, pot),                  8),
        ("penalties_collected", offset_of!(RoundState, penalties_collected),  8),
        ("fees_collected",      offset_of!(RoundState, fees_collected),       8),
        ("seed_commit",         offset_of!(RoundState, seed_commit),         32),
        ("seed",                offset_of!(RoundState, seed),                32),
        ("lobby_opened_at",     offset_of!(RoundState, lobby_opened_at),      8),
        ("lobby_closes_at",     offset_of!(RoundState, lobby_closes_at),      8),
        ("fight_started_at",    offset_of!(RoundState, fight_started_at),     8),
        ("fighters",            offset_of!(RoundState, fighters),            64 * MAX_FIGHTERS),
    ];

    let mut expected = 0usize;
    for &(name, offset, size) in fields {
        assert_eq!(
            offset, expected,
            "`{}` sits at byte {} but a gapless layout puts it at {} — repr(C) inserted padding, \
             and every field after this one now decodes as garbage in the browser. Declare the \
             hole as a `[u8; N]` field instead of letting the compiler own it.",
            name, offset, expected,
        );
        expected += size;
    }
    assert_eq!(
        expected, size_of::<RoundState>(),
        "the fields listed here total {} B but `RoundState` is {} B — either a field is missing from \
         this list or there is trailing padding",
        expected, size_of::<RoundState>(),
    );
    assert_eq!(size_of::<RoundState>(), 3_240, "the struct, without the 8-byte discriminator");
    // ALIGNMENT, WHICH THE WALK ABOVE DOES NOT IMPLY. A gapless field list is also true of
    // `repr(packed)`, and packed would break `load()` rather than the decoder:
    // `bytemuck::from_bytes_mut(&mut data[8..])` requires the slice to satisfy the type's
    // alignment, and the runtime hands out an account region aligned to 8. Put a `u128` in this
    // struct and the failure is an abort on chain with no message, on a fresh program id.
    assert_eq!(core::mem::align_of::<RoundState>(), 8, "RoundState must stay 8-aligned for `load()`");
    assert_eq!(core::mem::align_of::<Fighter>(), 8);

    // `Fighter` is the same argument one level down, and it is the one with a real hole in it:
    // 32 + 8 + 8 + 8 + 1 + 1 = 58 bytes of content in a 64-byte struct.
    assert_eq!(offset_of!(Fighter, wallet), 0);
    assert_eq!(offset_of!(Fighter, stake), 32);
    assert_eq!(offset_of!(Fighter, hp), 40);
    assert_eq!(offset_of!(Fighter, banked), 48);
    assert_eq!(offset_of!(Fighter, side), 56);
    assert_eq!(offset_of!(Fighter, dead), 57);
    assert_eq!(offset_of!(Fighter, padding), 58);
    assert_eq!(size_of::<Fighter>(), 64, "a Fighter must be exactly its declared bytes");

    // `Round::SIZE` is what `#[account(init, space = ...)]` allocates. Get it wrong and the
    // account is a byte-for-byte plausible round that fails the moment anything writes past the
    // end — on devnet, as a runtime error nobody can read.
    assert_eq!(
        RoundState::SIZE, 8 + size_of::<RoundState>(),
        "RoundState::SIZE ({}) does not match 8 + the real struct ({})", RoundState::SIZE, 8 + size_of::<RoundState>(),
    );
    assert_eq!(RoundState::SIZE, 3_248, "the published account size, for the rent arithmetic");
}

#[cfg(test)]
mod layout_tests {
    /// The offsets, run against this crate on its own — `cargo test -p arena-state`.
    ///
    /// A one-line test calling a shared body, and both halves are deliberate: the body is shared so
    /// it cannot drift, and the `#[test]` is here so that this crate is honest on its own rather than
    /// only when something depends on it. `bulls-arena` carries the same test, under the same name,
    /// calling the same function.
    #[test]
    fn the_account_layout_is_exactly_what_the_clients_decode() {
        super::assert_the_account_layout_is_exactly_what_the_clients_decode();
    }
}
