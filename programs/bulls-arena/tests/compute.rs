//! WHAT AN INSTRUCTION ACTUALLY COSTS, measured against the compiled SBF binary.
//!
//! THIS FILE EXISTS BECAUSE THE LAST TIME THIS NUMBER LIVED IN A COMMENT IT STRANDED A ROUND.
//! `MAX_STEPS` was 7,000 on the strength of a measurement (187.4 CU/step) that had been taken against
//! an older `resolve`, using a `bench_fight` probe that had since drifted from `run_fight` — one
//! cheap `a % 2 == d % 2` check standing in for three real ones. Devnet round #9 failed with
//! "1,399,850 of 1,399,850 CUs consumed, exceeded CUs meter" and is permanently stuck. The lesson was
//! not "measure more carefully"; it was that a measurement nothing re-runs is a rumour with a number
//! in it. So the bound is a TEST now.
//!
//! WHAT MAKES THIS BETTER THAN THE PROBE IT REPLACES. `bench_fight` can only ever measure the fight
//! LOOP: it takes a bare signer, touches no account, and its own doc comment lists what it therefore
//! cannot see — the account's deserialise-in and serialise-out, the guards, the `Clock` read, the
//! event. Those are precisely the terms this migration changes. LiteSVM runs the real bytecode
//! against real account bytes, so what is measured here is `tick` and `resolve` themselves, on a
//! genuine 48-fighter `Round` in `Phase::Fight` — a state that on a real cluster needs the VRF oracle
//! to reach, which is why nobody had measured it before. Building the account bytes directly
//! sidesteps the oracle without weakening anything: the bytes are produced by `bytemuck` from the
//! program's own `Round` type, so they are the same bytes the program would have written.
//!
//! # Running it
//!
//! It needs the compiled program, which `cargo test` does not build:
//!
//! ```text
//! PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH" \
//!   cargo-build-sbf --manifest-path programs/bulls-arena/Cargo.toml
//! cargo +1.89 test -p bulls-arena --test compute
//! ```
//!
//! and it FAILS LOUDLY rather than skipping if the binary is missing or older than the source. A
//! compute gate that quietly no-ops is the failure mode this whole file is a reaction to.
//!
//! # What is NOT measured, stated plainly
//!
//! The commit CPI into MagicBlock's program. `resolve`'s settling path ends with
//! `MagicIntentBundleBuilder::build_and_invoke()`, and that program is not available off-chain. The
//! settling measurement below therefore stops at the CPI boundary and reports everything up to it,
//! which is all of THIS program's work. What is left is a cost this change does not move: the commit
//! records an intent against `magic_context`, it does not copy the round's bytes on chain.

mod common;
use common::program_binary;

use anchor_lang::{Discriminator, InstructionData};
use bytemuck::Zeroable;
use bulls_arena::{
    final_cursor, Arena, Fighter, Phase, Round, Treasury, ARENA_SEED, FIGHT_TIMEOUT_SECONDS,
    MAX_FIGHTERS, MAX_STEPS_PER_CALL, ROUND_SEED, TREASURY_SEED,
};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

/// The per-transaction ceiling every measurement here is held against. Solana's maximum, and the
/// number devnet round #9 hit exactly.
const CU_CEILING: u64 = 1_400_000;

/// MagicBlock's commit program and the context account `#[commit]` injects. Named here rather than
/// reached for through the SDK because the test has to name them as raw addresses in an instruction,
/// and the SDK exposes them as anchor `Id` impls.
const MAGIC_PROGRAM: Pubkey = solana_pubkey::pubkey!("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT: Pubkey = solana_pubkey::pubkey!("MagicContext1111111111111111111111111111111");

/// The fight starts here; every timestamp below is relative to it.
const T0: i64 = 1_700_000_000;

/// `$10` in the game's units, matching the keeper's stake band. Fight length depends on
/// `stake / DUST`, so this is not an arbitrary large number — see `tests/fight_length.rs`.
const STAKE: u64 = 10_000_000;


/// A `Round` in `Phase::Fight` with `n` fighters, all alive, alternating sides, equal stakes.
///
/// Built as the program's own struct and cast to bytes, rather than laid out by hand — a hand-laid
/// account would be a second, drifting description of the layout, which is the mistake `bench_fight`
/// made about the fight loop.
fn fight_round(n: usize, cursor: u64) -> Round { fight_round_for(n, cursor, None) }

/// `owner` takes slot 0, so `extract` has a fighter it can actually pay.
fn fight_round_for(n: usize, cursor: u64, owner: Option<Pubkey>) -> Round {
    let mut r = Round::zeroed();
    r.round_no = 1;
    r.phase = Phase::Fight as u8;
    r.fighter_count = n as u16;
    r.bump = 255;
    r.tick_count = cursor;
    r.fight_started_at = T0;
    r.lobby_opened_at = T0 - 60;
    r.lobby_closes_at = T0;
    r.seed = core::array::from_fn(|i| (i as u8).wrapping_mul(31).wrapping_add(7));
    for (i, f) in r.fighters.iter_mut().enumerate().take(n) {
        *f = Fighter {
            wallet: match owner {
                Some(w) if i == 0 => w,
                _ => Pubkey::new_from_array([(i as u8).wrapping_add(1); 32]),
            },
            side: (i % 2) as u8,
            dead: 0,
            stake: STAKE,
            hp: STAKE,
            banked: 0,
            padding: [0u8; 6],
        };
    }
    r.pot = STAKE * n as u64;
    r
}

fn account_bytes(r: &Round) -> Vec<u8> {
    let mut data = Round::DISCRIMINATOR.to_vec();
    data.extend_from_slice(bytemuck::bytes_of(r));
    assert_eq!(data.len(), Round::SIZE, "the account is exactly Round::SIZE");
    data
}

/// `SetComputeUnitLimit`, hand-built rather than pulled in as another crate: it is one opcode and a
/// `u32`, and the alternative is a dependency whose only job is to concatenate five bytes.
fn compute_budget(units: u32) -> Instruction {
    let mut data = vec![0x02];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: solana_pubkey::pubkey!("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

struct Harness {
    svm: LiteSVM,
    payer: Keypair,
    round: Pubkey,
}

impl Harness {
    /// A rollup at `now`, holding `round` exactly as the program would have left it.
    fn new(round: &Round, now: i64) -> Self {
        Self::at(round, now, Keypair::new(), Pubkey::new_unique())
    }

    fn with_payer(round: &Round, now: i64, payer: Keypair) -> Self {
        Self::at(round, now, payer, Pubkey::new_unique())
    }

    /// As `with_payer`, but the round is placed at a CHOSEN address.
    ///
    /// Every instruction measured above takes the round as a bare `AccountLoader` and is happy
    /// anywhere, so a unique key was enough. `sweep_house_take` is the first one whose context
    /// constrains the round to its real PDA (`seeds = [ROUND_SEED, arena, round_no]`), because it is
    /// the first that runs on the BASE LAYER, where a passer-by could otherwise present a look-alike
    /// account. So the address becomes a parameter rather than an implementation detail.
    fn at(round: &Round, now: i64, payer: Keypair, round_key: Pubkey) -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(bulls_arena::ID, &program_binary()).expect("load the program");

        // `#[commit]` names `magic_program` as a `Program<'info, _>`, which checks the id AND that
        // the account is a real executable, before the body runs. So a stand-in has to be a valid
        // program rather than an empty account — this program's own binary serves, since what is
        // being measured is everything BEFORE the CPI reaches it. The CPI itself then fails on an
        // unknown discriminator, which is the boundary the file header describes.
        svm.add_program(MAGIC_PROGRAM, &program_binary()).expect("load the commit stand-in");

        svm.airdrop(&payer.pubkey(), 100_000_000_000).expect("airdrop");

        svm.set_account(
            round_key,
            Account {
                lamports: 30_000_000,
                data: account_bytes(round),
                owner: bulls_arena::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("round account");

        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = now;
        svm.set_sysvar(&clock);

        Self { svm, payer, round: round_key }
    }

    /// Compute units consumed. `Err` carries the units burned before the failure, which is exactly
    /// what is wanted for `resolve`'s settling path — everything up to the CPI boundary.
    fn run(&mut self, ix: Instruction) -> Result<u64, (u64, String)> {
        self.run_all(&[ix])
    }

    fn run_all(&mut self, ixs: &[Instruction]) -> Result<u64, (u64, String)> {
        let mut all = vec![compute_budget(CU_CEILING as u32)];
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&[&self.payer], msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(m) => Ok(m.compute_units_consumed),
            Err(e) => Err((e.meta.compute_units_consumed, format!("{:?}", e.err))),
        }
    }

    /// The round as the program left it. Without this a CU measurement cannot tell "ran 3,000 steps"
    /// from "bounced off a guard" — which is exactly the failure this file indicts `bench_fight` for.
    fn state(&self) -> Round {
        let raw = self.svm.get_account(&self.round).expect("round");
        *bytemuck::from_bytes::<Round>(&raw.data[8..])
    }

    fn extract(&mut self) -> Instruction {
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new(self.round, false),
                AccountMeta::new_readonly(self.payer.pubkey(), false), // player
                AccountMeta::new_readonly(bulls_arena::ID, false),     // session_token: None
                AccountMeta::new(self.payer.pubkey(), true),           // signer
            ],
            data: bulls_arena::instruction::Extract {}.data(),
        }
    }

    fn tick(&mut self, steps: u32) -> Instruction {
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![AccountMeta::new(self.round, false)],
            data: bulls_arena::instruction::Tick { steps }.data(),
        }
    }

    /// Write an owned-by-this-program account holding `discriminator ‖ borsh(value)`.
    fn put<T: anchor_lang::AnchorSerialize + Discriminator>(&mut self, key: Pubkey, value: &T) {
        let mut data = T::DISCRIMINATOR.to_vec();
        value.serialize(&mut data).expect("borsh");
        self.svm
            .set_account(
                key,
                Account {
                    lamports: 10_000_000,
                    data,
                    owner: bulls_arena::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set account");
    }

    fn sweep(&mut self, arena: Pubkey, treasury: Pubkey, round_no: u64) -> Instruction {
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new_readonly(arena, false),
                AccountMeta::new(self.round, false),
                AccountMeta::new(treasury, false),
            ],
            // `_round_no` with the underscore: the handler never reads the argument, because the
            // `#[instruction(round_no: u64)]` attribute has already spent it deriving the round's
            // PDA seeds. The arg is the address constraint, not an input.
            data: bulls_arena::instruction::SweepHouseTake { _round_no: round_no }.data(),
        }
    }

    fn resolve(&mut self) -> Instruction {
        Instruction {
            program_id: bulls_arena::ID,
            // ORDER IS THE STRUCT'S, and `#[commit]` appends its two accounts in this order:
            // magic_program first, then magic_context. Getting it the other way round produces an
            // account-type error rather than a measurement.
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new(self.round, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM, false),
                AccountMeta::new(MAGIC_CONTEXT, false),
            ],
            data: bulls_arena::instruction::Resolve {}.data(),
        }
    }
}

/// A `tick` that runs `steps` steps at `n` fighters, from a standing start.
fn tick_cost(n: usize, steps: u32) -> u64 {
    // Far enough past the bell that the whole fight is owed, so the call is limited by `steps` and
    // by nothing else.
    let mut h = Harness::new(&fight_round(n, 0), T0 + FIGHT_TIMEOUT_SECONDS);
    let ix = h.tick(steps);
    h.run(ix).unwrap_or_else(|(cu, e)| panic!("tick({}, {}) failed after {} CU: {}", n, steps, cu, e))
}

/// THE BOUND, ASSERTED — and every case checks the STATE it left behind, not only the units it
/// burned.
///
/// That second half is the whole difference between this and the probe it replaces. A CU number on
/// its own cannot tell "ran three thousand steps" from "bounced off a guard": the failure this
/// file's header indicts `bench_fight` for was a flat 12,758 CU that looked like a comfortable
/// measurement and was a `require!` refusing. So each case below asserts what the round looks like
/// afterwards, and a future edit that makes any of these bail early fails here rather than passing
/// with an enormous and fictitious margin.
///
/// The four cases are the four shapes of expensive call a caller can send:
///   * `tick` at the full per-call budget — the fight loop plus the account and the event.
///   * `resolve` GRINDING — the same work plus the `fight_is_over` scan and the early return. This
///     is the call a neglected round makes several of, and it is measured complete, because it does
///     no CPI.
///   * `resolve` SETTLING at the full budget — the same again plus `settle_sides` and the settle
///     event. It stops at the commit CPI, which is not this program's cost; see the file header.
///   * `extract` — which nothing measured until a review pointed out that this file's own doc claimed
///     it did. It runs the same bounded `catch_up` and then pays out, and it is the one instruction
///     where hitting the ceiling means a player cannot get their money out.
#[test]
fn no_instruction_can_exceed_the_transaction_budget() {
    let n = MAX_FIGHTERS;
    let budget = MAX_STEPS_PER_CALL as u32;
    let bell = T0 + FIGHT_TIMEOUT_SECONDS;

    // ASKS FOR MORE THAN THE BUDGET ON PURPOSE. The work is the same either way — the call is clamped
    // — but requesting exactly the budget would leave the clamp itself unexercised, and this
    // assertion is also what tells a stale binary from a current one (see `tests/common/mod.rs`): a
    // build carrying the old flat `MAX_STEPS` lands on a different cursor.
    let mut h = Harness::new(&fight_round(n, 0), bell);
    let ix = h.tick(budget * 2);
    let ticked = h.run(ix).unwrap_or_else(|(cu, e)| panic!("tick failed after {} CU: {}", cu, e));
    assert_eq!(
        h.state().tick_count, MAX_STEPS_PER_CALL,
        "a tick asking for {} steps must be clamped to the {}-step budget and land exactly on it",
        budget * 2, MAX_STEPS_PER_CALL,
    );

    // Nothing has been ticked and the bell has rung: `resolve` runs its full budget and is still
    // short of the cursor, so it reports progress and returns.
    let mut h = Harness::new(&fight_round(n, 0), bell);
    let ix = h.resolve();
    let grinding = h.run(ix).expect("a grinding resolve does no CPI and must succeed outright");
    let after = h.state();
    assert_eq!(after.tick_count, MAX_STEPS_PER_CALL, "the grind must have run its whole budget");
    assert_eq!(
        after.phase, Phase::Fight as u8,
        "a grinding resolve must NOT settle — if it did, this measurement is of the wrong path",
    );

    // The last call of that sequence: one full budget of steps left, and it settles.
    let start = final_cursor(n) - MAX_STEPS_PER_CALL;
    let mut h = Harness::new(&fight_round(n, start), bell);
    let ix = h.resolve();
    let settling = match h.run(ix) {
        // EXPECTED, AND CHECKED RATHER THAN SHRUGGED AT. Everything of ours runs and then the commit
        // CPI reaches a program that is only a stand-in. Accepting ANY error here would make this
        // indistinguishable from `AccountBorrowFailed` — a live `RefMut` held across the CPI, which
        // is the one zero-copy mistake no native test can see and the reason `resolve` scopes its
        // borrow. So the error must be the CPI's, and the round must have settled before it.
        Err((cu, e)) => {
            assert!(
                !e.contains("AccountBorrowFailed") && !e.contains("BorrowFailed"),
                "resolve failed on a borrow, not on the CPI: {} — the RefMut is still live when the \
                 commit runs, which on devnet is a settled round that never reaches the base layer",
                e,
            );
            cu
        }
        Ok(cu) => cu,
    };
    // NO POST-STATE ASSERTION HERE, AND THAT IS NOT AN OVERSIGHT: this transaction ends at a CPI into
    // a stand-in program, so it REVERTS, and the account still holds the cursor it started with. What
    // proves the work happened is the CU itself — a guard-bounce is ~13,000 CU (the number the file
    // header quotes), and 3,000 steps cannot cost less than the grind that ran the same 3,000.
    assert!(
        settling >= grinding,
        "the settling path burned {} CU against the grinding path's {} — it cannot have run the same \
         steps plus a settle for less, so this is measuring a guard rather than the work",
        settling, grinding,
    );

    // `extract`, on a round one budget behind, by a wallet that is actually in the ring.
    let player = Keypair::new();
    let round = fight_round_for(n, start, Some(player.pubkey()));
    let mut h = Harness::with_payer(&round, bell, player);
    let ix = h.extract();
    let extracted = h.run(ix).unwrap_or_else(|(cu, e)| panic!("extract failed after {} CU: {}", cu, e));
    let after = h.state();
    assert_eq!(after.tick_count, final_cursor(n), "extract must have caught the fight up first");
    assert_eq!(after.fighters[0].hp, 0, "the ring must have been emptied");
    assert_eq!(after.fighters[0].dead, 1, "an extracted fighter leaves the ring");
    assert!(after.penalties_collected > 0 || after.fighters[0].banked > 0, "something must have moved");

    println!(
        "\n  {} fighters, {} steps in one call:\n    tick             {:>9} CU  ({:.1}% of {})\n\
         \x20   resolve grinding {:>9} CU  ({:.1}%)\n    resolve settling {:>9} CU  ({:.1}%, to the CPI boundary)\n\
         \x20   extract          {:>9} CU  ({:.1}%)\n",
        n, budget,
        ticked, 100.0 * ticked as f64 / CU_CEILING as f64, CU_CEILING,
        grinding, 100.0 * grinding as f64 / CU_CEILING as f64,
        settling, 100.0 * settling as f64 / CU_CEILING as f64,
        extracted, 100.0 * extracted as f64 / CU_CEILING as f64,
    );

    // 70% rather than 100%, and the margin is the whole point. What is NOT in these numbers is the
    // commit CPI and the transaction's own overhead; ER-030 guessed 30k CU for that remainder and was
    // wrong about the loop as well, so the answer to an unmeasured term is headroom, not a better
    // guess. At 30% of the ceiling the remainder would have to be ~14x that old guess before this
    // stopped being safe.
    for (name, cu) in [
        ("tick", ticked),
        ("resolve grinding", grinding),
        ("resolve settling", settling),
        ("extract", extracted),
    ] {
        assert!(
            cu < CU_CEILING * 7 / 10,
            "{} costs {} CU at {} fighters and a {}-step budget — over 70% of the {} ceiling. \
             MAX_STEPS_PER_CALL is too high; lower it until this passes. This is the assertion that \
             devnet round #9 did not have.",
            name, cu, n, budget, CU_CEILING,
        );
    }
}

/// THE RECOVERY PATH, COSTED — AND THE MEASUREMENT CHANGED WHAT THE PROGRAM PRESCRIBES.
///
/// `extract` refuses with `FightBehind` when one bounded catch-up cannot reach the present, and tells
/// the caller to tick first. The obvious way for a client to do that without letting the backlog grow
/// between two round-trips is to bundle `tick` and `extract` into ONE transaction — at which point
/// both draw on the same 1.4M budget. It was written that way, and then measured: **~1,278,800 CU,
/// 91.3% of the ceiling.** It fits. It fits by 8.7%, on the one instruction where running out means a
/// player cannot get their money out, with no headroom for a fight state that happens to send more
/// steps down the damage branch.
///
/// So `extract`'s doc now says two transactions, and this test is the reason. It still asserts the
/// bundle is legal — a client that does bundle today is not broken, and turning that into a hard
/// failure would be punishing someone for reading an older comment — but the number is on the record
/// rather than in anybody's head. Nothing needs the bundle: the backlog grows at `2n` = 96 steps a
/// second and a tick clears 3,000, so two transactions converge with enormous margin.
#[test]
fn the_tick_then_extract_bundle_fits_but_only_just() {
    let n = MAX_FIGHTERS;
    let bell = T0 + FIGHT_TIMEOUT_SECONDS;
    // Two budgets behind, so the `tick` genuinely runs a full budget and the `extract` still has one
    // to do — the worst arrangement this bundle can be in.
    let start = final_cursor(n) - 2 * MAX_STEPS_PER_CALL;
    let player = Keypair::new();
    let round = fight_round_for(n, start, Some(player.pubkey()));
    let mut h = Harness::with_payer(&round, bell, player);

    let (tick, extract) = (h.tick(MAX_STEPS_PER_CALL as u32), h.extract());
    let cu = h
        .run_all(&[tick, extract])
        .unwrap_or_else(|(cu, e)| panic!("the prescribed recovery failed after {} CU: {}", cu, e));

    assert_eq!(h.state().fighters[0].dead, 1, "the extract in the bundle must actually have paid out");
    println!("\n  tick + extract in one transaction: {} CU ({:.1}% of {})\n",
             cu, 100.0 * cu as f64 / CU_CEILING as f64, CU_CEILING);
    assert!(
        cu < CU_CEILING,
        "the tick+extract bundle costs {} CU and no longer fits under the {} ceiling. Clients that \
         bundle are now broken; `extract`'s doc already prescribes two transactions, so the fix is to \
         make sure every client has stopped bundling — not to raise anything here.",
        cu, CU_CEILING,
    );
}

/// THE SWEEP READS EVERY FIGHTER NOW, AND IT STILL FITS THE DEFAULT BASE-LAYER BUDGET.
///
/// WHY THIS TEST EXISTS AT ALL. `apply_sweep` gained `Round::conserves()` — a fold over the whole
/// live lineup with two checked adds per fighter — so `sweep_house_take` went from O(1) to O(n) in a
/// program whose fighter cap is 48. Nothing in this file measured it before, because until now every
/// instruction here ran inside the rollup and the sweep is the one that does not. An unmeasured
/// instruction that just grew a loop is exactly the shape of the two permanently stuck rounds this
/// repo already paid for.
///
/// THE BUDGET IT IS HELD TO IS 200,000, NOT THE 1.4M CEILING THE OTHERS USE. A rollup transaction is
/// sent by this project's own keeper, which sets its own limit; `sweep_house_take` is PERMISSIONLESS
/// on the base layer, so the caller may well be a wallet sending a bare transaction with Solana's
/// default per-instruction budget and no `SetComputeUnitLimit` at all. The bound that matters is the
/// one an ordinary caller gets for free, and asserting against 1.4M here would be measuring a
/// generosity nobody is obliged to extend.
///
/// It is measured at MAX_FIGHTERS with every seat filled and a real extract behind it, so the fold
/// runs its longest and `penalties_collected` is non-zero — a conservation check over an all-zero
/// round would pass while doing almost none of the work.
///
/// MEASURED: 13,142 CU at 48 fighters — 6.6% of the 200,000 an ordinary caller gets. Recorded rather
/// than only bounded, so the next person to add work here can see how much room they are spending
/// rather than only whether they have run out.
#[test]
fn the_permissionless_sweep_fits_an_ordinary_callers_budget() {
    const DEFAULT_IX_BUDGET: u64 = 200_000;
    const ROUND_NO: u64 = 7;

    let (arena_key, arena_bump) = Pubkey::find_program_address(&[ARENA_SEED], &bulls_arena::ID);
    let (treasury_key, treasury_bump) =
        Pubkey::find_program_address(&[TREASURY_SEED, arena_key.as_ref()], &bulls_arena::ID);
    let (round_key, round_bump) = Pubkey::find_program_address(
        &[ROUND_SEED, arena_key.as_ref(), &ROUND_NO.to_le_bytes()],
        &bulls_arena::ID,
    );

    // A finished round: fought to the bell, one fighter having extracted, so both house takes are
    // non-zero and the identity has real terms on both sides.
    let mut r = fight_round(MAX_FIGHTERS, final_cursor(MAX_FIGHTERS));
    r.arena = arena_key;
    r.round_no = ROUND_NO;
    r.bump = round_bump;
    r.phase = Phase::Settled as u8;
    r.fees_collected = 12_345;
    let taken = r.fighters[0].hp;
    r.fighters[0].banked += taken / 2;
    r.fighters[0].hp = 0;
    r.fighters[0].dead = 1;
    r.penalties_collected = taken - taken / 2;
    assert!(r.conserves(), "the fixture must be a round the program could actually have produced");

    let mut h = Harness::at(&r, T0 + FIGHT_TIMEOUT_SECONDS, Keypair::new(), round_key);
    h.put(arena_key, &Arena {
        authority: Pubkey::new_unique(),
        token_a: Pubkey::new_unique(),
        token_b: Pubkey::new_unique(),
        round_counter: ROUND_NO,
        fee_bps: 100,
        bump: arena_bump,
    });
    h.put(treasury_key, &Treasury {
        arena: arena_key,
        fees_accrued: 0,
        penalties_accrued: 0,
        rounds_swept: 0,
        bump: treasury_bump,
    });

    let ix = h.sweep(arena_key, treasury_key, ROUND_NO);
    let cu = h.run(ix).unwrap_or_else(|(cu, e)| panic!("the sweep failed after {cu} CU: {e}"));

    // THE STATE IT LEFT BEHIND, not only the units — the same discipline the case above argues for.
    // A sweep that bounced off a guard is cheap and proves nothing.
    let after = h.state();
    assert!(after.is_swept(), "the measured call must actually have swept, not refused");

    assert!(
        cu < DEFAULT_IX_BUDGET,
        "sweep_house_take burned {cu} CU at {MAX_FIGHTERS} fighters — an ordinary caller gets \
         {DEFAULT_IX_BUDGET} by default, and a permissionless instruction that needs a compute \
         budget instruction to succeed is not permissionless in practice",
    );
}

/// A STEP COSTS MORE AT A BIG LINEUP THAN AT A SMALL ONE, which is why `MAX_STEPS_PER_CALL` is
/// calibrated at the cap.
///
/// With few fighters most steps hit an early `continue` — same side, or one of the pair already dead
/// — and with many, a larger share reach the damage branch. The measured curve rises from ~145
/// CU/step at two fighters to ~215 by eight and then FLATTENS, so the honest claim is the one
/// asserted here (big is dearer than small) rather than the tidier one I first wrote (cost rises
/// with the lineup, full stop), which the sweep does not support past n=8. The distinction matters
/// only in one direction and that is the direction that bites: a bound calibrated on a small lineup
/// is optimistic, and a bound calibrated on a large one is not.
#[test]
fn a_step_is_dearer_at_a_big_lineup_than_at_a_small_one() {
    const STEPS: u32 = 1_000;
    let (small, large) = (tick_cost(4, STEPS), tick_cost(MAX_FIGHTERS, STEPS));
    assert!(
        large > small,
        "{} fighters cost {} CU for {} steps and 4 cost {} — if the cost no longer rises with the \
         lineup, MAX_STEPS_PER_CALL may be being calibrated against the wrong case",
        MAX_FIGHTERS, large, STEPS, small,
    );
}

/// THE TABLE, for the doc comment on `MAX_STEPS_PER_CALL`. Not an assertion — a measurement to read.
///
/// ```text
/// cargo +1.89 test -p bulls-arena --test compute -- --ignored --nocapture
/// ```
#[test]
#[ignore = "prints the sweep; the bound itself is asserted by no_instruction_can_exceed_the_transaction_budget"]
fn print_the_compute_profile() {
    println!("\n  steps |{}", (0..4).map(|_| "").collect::<String>());
    print!("  {:>5} |", "steps");
    for n in [2usize, 4, 8, 16, 32, MAX_FIGHTERS] {
        print!(" {:>10}", format!("n={}", n));
    }
    println!("   (CU for one `tick`)");
    // Stops at the bound: `tick` clamps anything larger, so a bigger row would duplicate this one.
    for steps in [1u32, 100, 500, 1_000, 2_000, MAX_STEPS_PER_CALL as u32] {
        print!("  {:>5} |", steps);
        for n in [2usize, 4, 8, 16, 32, MAX_FIGHTERS] {
            print!(" {:>10}", tick_cost(n, steps));
        }
        println!();
    }

    // The marginal cost, which is what a bound has to be set from: the fixed part of a `tick` is
    // paid once and the per-step part is what scales.
    let (one, full) = (tick_cost(MAX_FIGHTERS, 1), tick_cost(MAX_FIGHTERS, MAX_STEPS_PER_CALL as u32));
    println!(
        "\n  at {} fighters: fixed ~{} CU, marginal ~{:.1} CU/step over {} steps\n\
         \x20 the ceiling would be reached at ~{} steps\n",
        MAX_FIGHTERS,
        one,
        (full - one) as f64 / (MAX_STEPS_PER_CALL - 1) as f64,
        MAX_STEPS_PER_CALL,
        ((CU_CEILING - one) as f64 / ((full - one) as f64 / (MAX_STEPS_PER_CALL - 1) as f64)) as u64,
    );
}
