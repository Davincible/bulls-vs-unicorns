//! THE ROUND THE PROGRAM WRITES IS THE ROUND THE PROGRAM READS BACK — the one claim in the zero-copy
//! migration that no native test can make, run against the compiled binary on a real runtime.
//!
//! WHY IT NEEDED ITS OWN FILE. Everything else about the migration is checkable natively: the layout
//! is `offset_of!`, the size is `size_of`, the arithmetic is pure functions. What is NOT checkable is
//! the handoff — `#[account(init)]` allocates 3,248 bytes and leaves the discriminator all-zero,
//! `load_init()` is the only accessor that will touch an account in that state, Anchor writes the
//! discriminator afterwards in `exit`, and only then does `load_mut()` become legal. Four steps, in
//! three different places, and the failure mode of getting any of them wrong is
//! `AccountDiscriminatorMismatch` or `AccountDiscriminatorAlreadySet` on the FIRST round of a fresh
//! deployment — after ~2.4 SOL of program-data rent has been spent on a new program id that cannot be
//! reused. That is not a risk worth carrying to devnet to find out about.
//!
//! It also happens to be the only end-to-end exercise of `enter` in this repo that does not need a
//! cluster, so it pins the thing that actually matters to a player: a fighter entered in the rollup
//! comes back out of the account with the right side, the right stake, and the fee taken.
//!
//! Needs the compiled program — see `tests/common/mod.rs` for the build command.

mod common;
use common::program_binary;

use anchor_lang::{AccountDeserialize, InstructionData};
use bulls_arena::{Arena, Phase, Round, Treasury, ARENA_SEED, MAX_FIGHTERS, MIN_RETAINED_ROUNDS, ROUND_SEED, TREASURY_SEED};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const FEE_BPS: u16 = 20;
const SYSTEM_PROGRAM: Pubkey = solana_pubkey::pubkey!("11111111111111111111111111111111");
/// Loaded as a stand-in so that `Program<'info, MagicProgram>` resolves in any context `#[commit]`
/// has touched. Nothing here calls through it — the instructions that CPI into MagicBlock cannot be
/// completed off-chain, which is why the terminal round below is built by writing bytes.
const MAGIC_PROGRAM: Pubkey = solana_pubkey::pubkey!("Magic11111111111111111111111111111111111111");

struct Chain {
    svm: LiteSVM,
    authority: Keypair,
}

impl Chain {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(bulls_arena::ID, &program_binary()).expect("load the program");
        svm.add_program(MAGIC_PROGRAM, &program_binary()).expect("commit stand-in");
        let authority = Keypair::new();
        svm.airdrop(&authority.pubkey(), 100_000_000_000).expect("airdrop");
        Self { svm, authority }
    }

    fn send(&mut self, ix: Instruction, extra: &[&Keypair]) {
        let msg = Message::new(&[ix], Some(&self.authority.pubkey()));
        let mut signers: Vec<&Keypair> = vec![&self.authority];
        signers.extend_from_slice(extra);
        let tx = Transaction::new(&signers, msg, self.svm.latest_blockhash());
        if let Err(e) = self.svm.send_transaction(tx) {
            panic!("transaction failed: {:?}\nlogs: {:#?}", e.err, e.meta.logs);
        }
    }

    /// The round account, read back the way a CLIENT reads it: `AccountDeserialize`, which for a
    /// zero-copy account checks the discriminator and casts. If the program left the account in a
    /// state this cannot open, so is every consumer in the repo.
    fn round(&self, key: &Pubkey) -> Round {
        let raw = self.svm.get_account(key).expect("the round account must exist");
        assert_eq!(raw.data.len(), Round::SIZE, "the allocation is `space = Round::SIZE`");
        assert_eq!(raw.owner, bulls_arena::ID);
        Round::try_deserialize(&mut raw.data.as_slice()).expect("a client must be able to open it")
    }
}

fn arena_pda() -> Pubkey {
    Pubkey::find_program_address(&[ARENA_SEED], &bulls_arena::ID).0
}

fn round_pda(arena: &Pubkey, round_no: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[ROUND_SEED, arena.as_ref(), &round_no.to_le_bytes()],
        &bulls_arena::ID,
    )
    .0
}

/// THE HANDOFF, END TO END: `init` + `load_init` writes it, `load_mut` mutates it, a client reads it.
///
/// Each step is a separate transaction, which is the point — the discriminator is written by Anchor's
/// `exit` at the end of `open_round`, so `enter` succeeding at all is the evidence that the handoff
/// worked. Doing it in one transaction would prove nothing.
#[test]
fn a_round_the_program_opens_is_one_the_program_and_its_clients_can_read_back() {
    let mut c = Chain::new();
    let (arena, authority) = (arena_pda(), c.authority.pubkey());

    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new(arena, false),
                AccountMeta::new(authority, true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: bulls_arena::instruction::InitArena {
                fee_bps: FEE_BPS,
                token_a: Pubkey::new_unique(),
                token_b: Pubkey::new_unique(),
            }
            .data(),
        },
        &[],
    );

    let round_no = 1u64;
    let round = round_pda(&arena, round_no);
    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new(arena, false),
                AccountMeta::new(round, false),
                AccountMeta::new(authority, true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: bulls_arena::instruction::OpenRound {
                round_no,
                seed_commit: [7u8; 32],
                lobby_seconds: 60,
            }
            .data(),
        },
        &[],
    );

    // WHAT `load_init` LEFT BEHIND. If the discriminator had not been written, this deserialise is
    // where it would surface — before any of the field checks below get a chance to.
    let r = c.round(&round);
    assert_eq!(r.round_no, round_no);
    assert_eq!(r.phase, Phase::Lobby as u8);
    assert_eq!(r.arena, arena);
    assert_eq!(r.fighter_count, 0);
    assert_eq!(r.pot, 0);
    assert_eq!(r.seed_commit, [7u8; 32]);
    assert_eq!(r.seed, [0u8; 32]);
    assert!(!r.is_swept());
    assert_eq!(r.padding, [0u8; 2], "declared padding must be zero, not whatever was on the heap");
    assert_eq!(r.lobby_closes_at - r.lobby_opened_at, 60);
    assert!(
        r.fighters.iter().all(|f| f.stake == 0 && f.hp == 0 && f.wallet == Pubkey::default()),
        "an account created by `init` is zeroed, and `load_init` must not have disturbed that",
    );

    // NOW A SECOND TRANSACTION MUTATES IT THROUGH `load_mut`. Fifty entries against a cap of
    // forty-eight: the last two must be refused, which is the only place `MAX_FIGHTERS` is enforced
    // against a real account rather than against an array literal in a test.
    let mut refused = 0;
    for i in 0..(MAX_FIGHTERS + 2) {
        let player = Keypair::new();
        c.svm.airdrop(&player.pubkey(), 1_000_000_000).expect("airdrop");
        let ix = Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new_readonly(arena, false),
                AccountMeta::new(round, false),
                AccountMeta::new_readonly(player.pubkey(), false),
                // `session_token: Option<..>` absent — anchor's convention for a `None` optional
                // account is the program's own id in that position.
                AccountMeta::new_readonly(bulls_arena::ID, false),
                AccountMeta::new(player.pubkey(), true),
            ],
            data: bulls_arena::instruction::Enter { side: (i % 2) as u8, stake: 1_000_000 }.data(),
        };
        let msg = Message::new(&[ix], Some(&c.authority.pubkey()));
        let tx = Transaction::new(&[&c.authority, &player], msg, c.svm.latest_blockhash());
        if c.svm.send_transaction(tx).is_err() {
            refused += 1;
        }
        c.svm.expire_blockhash();
    }
    assert_eq!(refused, 2, "the lobby must fill at exactly MAX_FIGHTERS and refuse after it");

    let r = c.round(&round);
    assert_eq!(r.fighter_count as usize, MAX_FIGHTERS, "every seat was taken");
    // 20 bps of 1,000,000 is 2,000 exactly, so these are facts rather than rounding arguments — and
    // they are read back out of the ACCOUNT, through a client's decoder, not out of a local struct.
    assert_eq!(r.fees_collected, 2_000 * MAX_FIGHTERS as u64);
    assert_eq!(r.pot, 998_000 * MAX_FIGHTERS as u64);
    for (i, f) in r.fighters.iter().enumerate() {
        assert_eq!(f.stake, 998_000, "slot {}", i);
        assert_eq!(f.hp, 998_000, "slot {}", i);
        assert_eq!(f.side, (i % 2) as u8, "slot {}", i);
        assert_eq!(f.dead, 0, "slot {}", i);
        assert_eq!(f.padding, [0u8; 6], "slot {}: declared padding must stay zero", i);
    }

    // AND THE ARENA — a plain borsh `#[account]` — still works alongside it. Worth one line: the
    // migration changed one account type and not the other, and "the ones I did not touch still
    // deserialise" is exactly the assumption that is embarrassing to have left unchecked.
    let raw = c.svm.get_account(&arena).expect("arena");
    let a = Arena::try_deserialize(&mut raw.data.as_slice()).expect("arena still decodes");
    assert_eq!(a.round_counter, 1);
    assert_eq!(a.fee_bps, FEE_BPS);
    assert_eq!(a.authority, authority);
}

/// A ROUND MAY NOT BE OPENED TWICE. `load_init` refuses an account whose discriminator is already
/// set, and that is the second half of the handoff contract — the half that stops a re-`open_round`
/// from silently resetting a live round's pot to zero.
///
/// It is `init` that refuses first here rather than `load_init`, and that is fine: what is being
/// pinned is that SOMETHING does, on the real runtime, rather than the account being quietly rewritten.
#[test]
fn a_round_cannot_be_opened_over_itself() {
    let mut c = Chain::new();
    let (arena, authority) = (arena_pda(), c.authority.pubkey());
    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new(arena, false),
                AccountMeta::new(authority, true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: bulls_arena::instruction::InitArena {
                fee_bps: FEE_BPS,
                token_a: Pubkey::default(),
                token_b: Pubkey::default(),
            }
            .data(),
        },
        &[],
    );

    let round = round_pda(&arena, 1);
    let open = |c: &Chain| Instruction {
        program_id: bulls_arena::ID,
        accounts: vec![
            AccountMeta::new(arena, false),
            AccountMeta::new(round, false),
            AccountMeta::new(c.authority.pubkey(), true),
            AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
        ],
        data: bulls_arena::instruction::OpenRound {
            round_no: 1,
            seed_commit: [1u8; 32],
            lobby_seconds: 60,
        }
        .data(),
    };
    let ix = open(&c);
    c.send(ix, &[]);
    c.svm.expire_blockhash();

    let ix = open(&c);
    let msg = Message::new(&[ix], Some(&c.authority.pubkey()));
    let tx = Transaction::new(&[&c.authority], msg, c.svm.latest_blockhash());
    assert!(
        c.svm.send_transaction(tx).is_err(),
        "re-opening round 1 must be refused — silently rewriting a live round is the worst outcome \
         the discriminator contract exists to prevent",
    );
}

/// THE TWO ANCHOR CODEGEN PATHS THAT ARE DIFFERENT FOR A LOADER, ON A REAL RUNTIME.
///
/// Both of these are constraints whose GENERATED CODE changed when `Round` became zero-copy, and
/// neither is reachable from a native test:
///
///   * **`close = authority` on an `AccountLoader`** — `AccountsClose` has a separate implementation
///     for loaders. This instruction is irreversible and its own doc calls it "the only one that
///     destroys anything", so "the close path compiles" is not the same statement as "the close path
///     works".
///   * **`has_one = arena` and `bump = round.load()?.bump` on an `AccountLoader`** — anchor emits
///     `round.load()?.<field>` for a loader-typed field rather than a plain field access, so the
///     constraint that binds a round to its arena, and the one that pins the PDA, are both running
///     code that has never executed. They also take the account's `RefCell` while `try_accounts` is
///     still running, which is the class of mistake that fails as `AccountBorrowFailed` at runtime
///     and as nothing at all at compile time.
///
/// The route to both is the keeper's own end-of-life sequence, so this doubles as the first
/// off-chain exercise of it: sweep, then close, then check the rent came back.
#[test]
fn the_loader_constraints_and_the_close_path_work_against_a_real_runtime() {
    let mut c = Chain::new();
    let (arena, authority) = (arena_pda(), c.authority.pubkey());
    let treasury = Pubkey::find_program_address(&[TREASURY_SEED, arena.as_ref()], &bulls_arena::ID).0;

    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new(arena, false),
                AccountMeta::new(authority, true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: bulls_arena::instruction::InitArena {
                fee_bps: FEE_BPS,
                token_a: Pubkey::default(),
                token_b: Pubkey::default(),
            }
            .data(),
        },
        &[],
    );
    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new_readonly(arena, false),
                AccountMeta::new(treasury, false),
                AccountMeta::new(authority, true),
                AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
            ],
            data: bulls_arena::instruction::InitTreasury {}.data(),
        },
        &[],
    );

    // A round has to be OLDER than the retention window before it may be closed, so the arena needs
    // to be past it. Rounds 2.. are opened and left alone; only round 1 is worked.
    //
    // The clock is not advanced here — these lobbies never need to expire, because round 1 is taken
    // terminal by writing its bytes rather than by letting its deadline pass.
    let round = round_pda(&arena, 1);
    for round_no in 1..=(MIN_RETAINED_ROUNDS + 1) {
        c.send(
            Instruction {
                program_id: bulls_arena::ID,
                accounts: vec![
                    AccountMeta::new(arena, false),
                    AccountMeta::new(round_pda(&arena, round_no), false),
                    AccountMeta::new(authority, true),
                    AccountMeta::new_readonly(SYSTEM_PROGRAM, false),
                ],
                data: bulls_arena::instruction::OpenRound {
                    round_no,
                    seed_commit: [1u8; 32],
                    lobby_seconds: 60,
                }
                .data(),
            },
            &[],
        );
        c.svm.expire_blockhash();
    }

    // TAKE ROUND 1 TO A TERMINAL STATE BY WRITING THE BYTES, not by calling `abandon_round`.
    //
    // That instruction ends in the commit CPI, which off-chain reaches only a stand-in and fails —
    // so the honest options were to stop here or to build the state directly. Directly is fine and
    // is not weaker: what is under test is the SWEEP and CLOSE constraints, and they read the phase,
    // the swept flag and the bump off the account. The bump in particular is read back out of the
    // account the PROGRAM wrote rather than recomputed, so `bump = round.load()?.bump` is still being
    // checked against a real PDA derivation.
    {
        let mut raw = c.svm.get_account(&round).expect("round");
        let r: &mut Round = bytemuck::from_bytes_mut(&mut raw.data[8..]);
        r.phase = Phase::Abandoned as u8;
        r.fees_collected = 12_345;      // so the sweep has something to move
        c.svm.set_account(round, raw).expect("terminal round");
    }
    assert_eq!(c.round(&round).phase, Phase::Abandoned as u8);

    // SWEEP — `has_one = arena` on the loader, plus `bump = round.load()?.bump`, both on the round.
    c.svm.expire_blockhash();
    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new_readonly(arena, false),
                AccountMeta::new(round, false),
                AccountMeta::new(treasury, false),
            ],
            data: bulls_arena::instruction::SweepHouseTake { _round_no: 1 }.data(),
        },
        &[],
    );
    assert!(c.round(&round).is_swept(), "the sweep must have set the flag through the loader");
    let t = c.svm.get_account(&treasury).expect("treasury");
    assert_eq!(Treasury::try_deserialize(&mut t.data.as_slice()).unwrap().rounds_swept, 1);

    // CLOSE — the irreversible one. `close = authority` on a loader, and the rent has to come back.
    let rent = c.svm.get_account(&round).expect("round").lamports;
    assert!(rent > 20_000_000, "a 3,248-byte account's deposit, {} lamports", rent);
    let before = c.svm.get_account(&authority).expect("authority").lamports;
    c.svm.expire_blockhash();
    c.send(
        Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new_readonly(arena, false),
                AccountMeta::new(round, false),
                AccountMeta::new(authority, true),
            ],
            data: bulls_arena::instruction::CloseRoundAccount { _round_no: 1 }.data(),
        },
        &[],
    );

    // GONE, and the deposit is back. `get_account` on a closed account returns either nothing or a
    // zero-lamport husk depending on the runtime's bookkeeping; either is "closed", and what is not
    // ambiguous is the lamports having moved.
    let after = c.svm.get_account(&round).map(|a| a.lamports).unwrap_or(0);
    assert_eq!(after, 0, "the round account must be drained");
    let recovered = c.svm.get_account(&authority).expect("authority").lamports;
    assert!(
        recovered > before,
        "the authority funded the round and must get the deposit back: {} -> {}", before, recovered,
    );

    // AND THE WINDOW IS ENFORCED THROUGH THE LOADER TOO. Round 2 is inside the retention window, so
    // it must be refused — the guard reads `round.load()?`, so this is the same code path again.
    c.svm.expire_blockhash();
    let msg = Message::new(
        &[Instruction {
            program_id: bulls_arena::ID,
            accounts: vec![
                AccountMeta::new_readonly(arena, false),
                AccountMeta::new(round_pda(&arena, 2), false),
                AccountMeta::new(authority, true),
            ],
            data: bulls_arena::instruction::CloseRoundAccount { _round_no: 2 }.data(),
        }],
        Some(&authority),
    );
    let tx = Transaction::new(&[&c.authority], msg, c.svm.latest_blockhash());
    assert!(c.svm.send_transaction(tx).is_err(), "a round inside the retention window must not close");
}
