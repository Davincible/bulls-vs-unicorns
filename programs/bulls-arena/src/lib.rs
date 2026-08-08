// Bulls ⚔ Unicorns — on-chain round state, executed on a MagicBlock Ephemeral Rollup.
//
// DEVNET ONLY. See MEGA_QUEUE.md ER-000: this fork is structurally prevented from reaching mainnet.
//
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
//
// Today the whole game lives in an off-chain engine: every fighter, stake, hit and settlement is a
// row in SQLite, and the chain only ever sees a 32-byte hash of a finished round in a memo. This
// program moves the ROUND on-chain — the part that mutates every tick and therefore actually needs
// an ER. It does NOT move balances or custody: those stay in the existing ledger and vault, because
// a delegated account cannot be touched by base-layer programs, and delegating balances would freeze
// withdrawals for the length of every round.
//
// The round is the natural delegation boundary: delegate at lobby open, mutate through the fight,
// commit and undelegate at settlement. That maps exactly onto the ER lifecycle.
//
// FAIRNESS IS PRESERVED, NOT REPLACED. The engine already publishes sha256(seed) before entries open
// and reveals the seed at fight start, so anyone can recompute a round. That scheme moves here
// intact — `open_round` stores the commitment on-chain BEFORE anyone can enter, and `settle` reveals
// the seed. The improvement is that the commitment is now on-chain ahead of the outcome rather than
// in a memo written after it.

use anchor_lang::prelude::*;
// anchor 1.x no longer re-exports solana_program::hash — split crates now. hashv over slices also
// avoids building a 40-byte scratch buffer by hand, one fewer place to get an offset wrong.
use solana_sha256_hasher::hashv;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams};

declare_id!("3dHbeVh7KuhhjXMCkAw34wsZefwwQUdwKY6DJb12LWXb"); // devnet program keypair: .devnet/program-keypair.json

pub const ARENA_SEED: &[u8] = b"arena";
pub const ROUND_SEED: &[u8] = b"round";

/// Hard ceiling on fighters in one round. Sized so the whole round is ONE account and therefore one
/// atomic commit.
///
/// 40 was the first choice — well under the ER's 10 MiB ACCOUNT limit. It blew the 4 KB STACK
/// instead: `Account<'info, Round>` deserialises onto the stack, and 40 fighters is a ~2.45 KB
/// struct that overflows once Anchor's own frame is added. Devnet reported it as
/// "Access violation reading 8 bytes at address 0x18", which names neither the stack nor the size.
///
/// 16 fits comfortably (~937 B) and matches what the live arena actually fields — the lobby-sizing
/// work settled it at 10-17 per round. Going back above ~24 needs `zero_copy` + `AccountLoader`,
/// which avoids the stack copy entirely; that is the right fix if the cap ever needs to rise, and
/// it is a bigger change than this round-trip should carry.
///
/// One account per fighter was the alternative. Rejected: 40 delegations and 40 commits per round,
/// the round stops being atomic, and a partial commit leaves a round half-settled with no obvious
/// way to tell which half is real.
pub const MAX_FIGHTERS: usize = 16;

/// Basis points denominator, matching the off-chain engine's FEE = 0.002 (20 bps).
pub const BPS: u64 = 10_000;

/// Below this, a fighter is finished off rather than left to decay.
///
/// Damage is a PERCENTAGE of remaining hp, which is exponential decay: it approaches zero and never
/// arrives. Integer division then floors it to 0 while hp is still positive, so the exchange is
/// skipped and the fight runs forever with everyone alive. Caught by the TypeScript mirror before
/// this was ever deployed: 5,000 ticks, 0 deaths, every fighter stuck at hp = 3.
///
/// A dust floor makes the round terminate. Value is still conserved — the remainder MOVES.
pub const DUST: u64 = 1_000;

#[ephemeral]
#[program]
pub mod bulls_arena {
    use super::*;

    /// One-time arena config. Base layer; never delegated — everything reads it.
    pub fn init_arena(ctx: Context<InitArena>, fee_bps: u16, token_a: Pubkey, token_b: Pubkey) -> Result<()> {
        require!(fee_bps <= 1_000, ArenaError::FeeTooHigh); // 10% ceiling, not a judgement on the rate
        let a = &mut ctx.accounts.arena;
        a.authority = ctx.accounts.authority.key();
        a.fee_bps = fee_bps;
        a.token_a = token_a;
        a.token_b = token_b;
        a.round_counter = 0;
        a.bump = ctx.bumps.arena;
        Ok(())
    }

    /// Open a round and publish the seed commitment BEFORE anyone can enter.
    ///
    /// The ordering is the whole point: a commitment published after entries are known proves
    /// nothing. `seed_commit` is sha256(seed) and the seed itself stays off-chain until `settle`.
    pub fn open_round(ctx: Context<OpenRound>, round_no: u64, seed_commit: [u8; 32]) -> Result<()> {
        let arena = &mut ctx.accounts.arena;
        require!(round_no == arena.round_counter + 1, ArenaError::RoundOutOfOrder);

        let r = &mut ctx.accounts.round;
        r.arena = arena.key();
        r.round_no = round_no;
        r.phase = Phase::Lobby as u8;
        r.seed_commit = seed_commit;
        r.seed = [0u8; 32];
        r.winner = 0;
        r.pot = 0;
        r.fighter_count = 0;
        r.tick_count = 0;
        r.bump = ctx.bumps.round;

        arena.round_counter = round_no;
        emit!(RoundOpened { round_no, seed_commit });
        Ok(())
    }

    /// Hand the round account to the ER validator. Base layer.
    ///
    /// After this the account is owned by the Delegation Program and only the ER validator may write
    /// it — which is also what tells the Magic Router to route this round's transactions to the ER.
    /// Routing follows account ownership, not client configuration.
    pub fn delegate_round(ctx: Context<DelegateRound>, round_no: u64) -> Result<()> {
        ctx.accounts.delegate_round_pda(
            &ctx.accounts.payer,
            &[ROUND_SEED, ctx.accounts.arena.key().as_ref(), &round_no.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Add a fighter. Runs in the ER once the round is delegated.
    ///
    /// `stake` is the GROSS amount; the fee is taken here so the on-chain arithmetic matches the
    /// engine's, where a stake is recorded net of the deploy fee.
    pub fn enter(ctx: Context<Enter>, side: u8, stake: u64) -> Result<()> {
        let arena_fee = ctx.accounts.arena.fee_bps as u64;
        let r = &mut ctx.accounts.round;
        require!(r.phase == Phase::Lobby as u8, ArenaError::NotInLobby);
        require!(side == 0 || side == 1, ArenaError::BadSide);
        require!(stake > 0, ArenaError::ZeroStake);
        require!((r.fighter_count as usize) < MAX_FIGHTERS, ArenaError::RoundFull);

        // One entry per wallet per side — a repeat tops up rather than spawning a second fighter,
        // mirroring the engine, where a duplicate id merges into the existing entry.
        let who = ctx.accounts.player.key();
        let fee = stake.checked_mul(arena_fee).ok_or(ArenaError::MathOverflow)? / BPS;
        let net = stake.checked_sub(fee).ok_or(ArenaError::MathOverflow)?;

        let n = r.fighter_count as usize;   // read the count BEFORE borrowing fighters mutably
        if let Some(f) = r.fighters[..n]
            .iter_mut()
            .find(|f| f.wallet == who && f.side == side)
        {
            f.stake = f.stake.checked_add(net).ok_or(ArenaError::MathOverflow)?;
            f.hp = f.hp.checked_add(net).ok_or(ArenaError::MathOverflow)?;
        } else {
            let i = n;
            r.fighters[i] = Fighter { wallet: who, side, stake: net, hp: net, banked: 0, dead: 0 };
            r.fighter_count += 1;
        }
        r.pot = r.pot.checked_add(net).ok_or(ArenaError::MathOverflow)?;
        Ok(())
    }

    /// Run the ENTIRE fight and settle it, in one instruction.
    ///
    /// This replaced a `tick(steps)` that had to be called ~125 times per round. That design was
    /// copying the off-chain engine's shape — which ticks in real time because it is DRAWING the
    /// fight — without asking whether the chain needed it. It did not. The fight is a pure function
    /// of (seed, entries); splitting it across 125 round-trips does not make it more correct, it
    /// just spreads one computation over 125 confirmations.
    ///
    /// NOR DOES THE PER-HIT DATA BELONG ON-CHAIN. Every blow is recomputable from the seed by
    /// anyone; storing them is publishing our own homework at a cost per byte. Only the inputs
    /// (seed, entries) and the OUTCOME (winner, final holdings) are recorded — which is exactly the
    /// set a sceptic needs to check the result themselves.
    pub fn resolve(ctx: Context<Resolve>, steps: u32) -> Result<()> {
        {
            let r = &mut ctx.accounts.round;
            require!(r.phase == Phase::Fight as u8, ArenaError::NotFighting);
            require!(steps > 0 && steps <= 20_000, ArenaError::BadStepCount);

            let n = r.fighter_count as usize;
            require!(n >= 2, ArenaError::NotEnoughFighters);

            // The fight, start to finish, in local memory. No account write per step.
            for step in 0..steps {
                let h = hashv(&[r.seed.as_ref(), (step as u64).to_le_bytes().as_ref()]).to_bytes();
                let a = (u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as usize) % n;
                let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % n;
                if d == a { d = (d + 1) % n; }

                if r.fighters[a].side == r.fighters[d].side { continue; }
                if r.fighters[a].wallet == r.fighters[d].wallet { continue; }
                if r.fighters[a].dead == 1 || r.fighters[d].dead == 1 { continue; }

                let roll = (h[8] as u64) % 24 + 4;
                let mut dmg = r.fighters[d].hp.saturating_mul(roll) / 100;
                if r.fighters[d].hp <= DUST || dmg == 0 { dmg = r.fighters[d].hp; }
                if dmg == 0 { continue; }

                r.fighters[d].hp = r.fighters[d].hp.saturating_sub(dmg);
                r.fighters[a].banked = r.fighters[a].banked.saturating_add(dmg);
                if r.fighters[d].hp == 0 { r.fighters[d].dead = 1; }
            }
            r.tick_count = steps as u64;

            // settle in the same instruction — there is nothing to wait for
            let (mut va, mut vb) = (0u64, 0u64);
            for f in r.fighters[..n].iter() {
                let v = f.hp.saturating_add(f.banked);
                if f.side == 0 { va = va.saturating_add(v) } else { vb = vb.saturating_add(v) }
            }
            r.winner = if va >= vb { 0 } else { 1 };
            r.phase = Phase::Settled as u8;
            emit!(RoundSettled { round_no: r.round_no, winner: r.winner, pot: r.pot });
        }

        // Anchor serialises on return; the commit reads account info DURING the instruction. Without
        // this the committed bytes are the PRE-fight state — a settled round that still says lobby.
        ctx.accounts.round.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.round.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// COMPUTE PROBE — measures what a fight costs, and cannot change anything.
    ///
    /// Needed because `resolve` refuses outside the Fight phase, so simulating it only ever measured
    /// the guard (a flat 12,758 CU however many steps were requested — the giveaway that nothing was
    /// running). Reaching Fight phase legitimately requires the VRF oracle, which is a dependency the
    /// measurement should not need.
    ///
    /// This runs the IDENTICAL inner loop over a local array and writes NOTHING — no account is
    /// mutable in its context, so it is a read-only probe rather than a test backdoor. It cannot
    /// settle a round, change a phase, or move value.
    pub fn bench_fight(_ctx: Context<BenchFight>, steps: u32, fighters: u8) -> Result<()> {
        require!(steps > 0 && steps <= 20_000, ArenaError::BadStepCount);
        let n = (fighters as usize).clamp(2, MAX_FIGHTERS);
        let seed = [7u8; 32];
        let mut hp = [1_000_000_000u64; MAX_FIGHTERS];
        let mut banked = [0u64; MAX_FIGHTERS];

        for step in 0..steps {
            let h = hashv(&[seed.as_ref(), (step as u64).to_le_bytes().as_ref()]).to_bytes();
            let a = (u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as usize) % n;
            let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % n;
            if d == a { d = (d + 1) % n; }
            if a % 2 == d % 2 { continue; }              // stand-in for the same-side check
            let roll = (h[8] as u64) % 24 + 4;
            let mut dmg = hp[d].saturating_mul(roll) / 100;
            if hp[d] <= DUST || dmg == 0 { dmg = hp[d]; }
            if dmg == 0 { continue; }
            hp[d] = hp[d].saturating_sub(dmg);
            banked[a] = banked[a].saturating_add(dmg);
        }
        // consume the results so the optimiser cannot delete the loop and report a fictitious cost
        msg!("bench {} steps, {} fighters, hp0={} banked0={}", steps, n, hp[0], banked[0]);
        Ok(())
    }

    /// Close the lobby and ASK THE ORACLE for the seed.
    ///
    /// WHY THE REQUEST HAPPENS HERE AND NOT AT open_round.
    ///
    /// The obvious design is to draw randomness when the round opens. It is wrong: the seed would
    /// then be readable on-chain while entries are still open, so anyone could replay the fight
    /// before deciding which side to back. The round would be decided before it was played.
    ///
    /// Requesting AFTER the lobby closes means nobody — operator included — knows the seed while
    /// anyone can still act on it.
    ///
    /// This also closes the one real weakness of the old commit-reveal. That scheme stopped the
    /// operator seeing the book before choosing a seed, but nothing stopped grinding candidate
    /// seeds offline against the EXPECTED lobby and committing to the most favourable one. With the
    /// house fielding most of the fighters, that was not theoretical. The operator no longer
    /// chooses the seed at all.
    pub fn close_lobby_and_draw(ctx: Context<DrawSeed>, client_seed: [u8; 32]) -> Result<()> {
        {
            let r = &mut ctx.accounts.round;
            require!(r.phase == Phase::Lobby as u8, ArenaError::NotInLobby);
            require!(r.fighter_count >= 2, ArenaError::NotEnoughFighters);
            r.phase = Phase::Drawing as u8;
        }
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackSeed::DISCRIMINATOR.to_vec(),
            caller_seed: client_seed,
            accounts_metas: None,
            ..Default::default()
        });
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// The oracle delivers the seed. `#[vrf_callback]` enforces that ONLY the VRF program can call
    /// this — without it, anyone could hand us a seed of their choosing and the whole scheme is
    /// theatre.
    pub fn callback_seed(ctx: Context<CallbackSeed>, randomness: [u8; 32]) -> Result<()> {
        let r = &mut ctx.accounts.round;
        require!(r.phase == Phase::Drawing as u8, ArenaError::NotDrawing);
        r.seed = randomness;
        // Publish sha256(seed) too. The seed is already public at this point, so this is not a
        // commitment any more — it keeps the browser replay and the anchor format unchanged, so the
        // client verifying a round does not need to know which scheme produced the seed.
        r.seed_commit = hashv(&[randomness.as_ref()]).to_bytes();
        r.phase = Phase::Fight as u8;
        emit!(SeedRevealed { round_no: r.round_no, seed: randomness });
        Ok(())
    }

    /// Final commit + hand the account back to the base layer.
    pub fn close_round(ctx: Context<Resolve>) -> Result<()> {
        require!(ctx.accounts.round.phase == Phase::Settled as u8, ArenaError::NotSettled);
        ctx.accounts.round.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.round.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Fighter {
    pub wallet: Pubkey, // 32
    pub side: u8,       // 1
    pub dead: u8,       // 1
    pub stake: u64,     // 8  — net of fee, what they put in
    pub hp: u64,        // 8  — value still in the ring
    pub banked: u64,    // 8  — value raided from the other side
} // 58 B

#[repr(u8)]
pub enum Phase { Lobby = 0, Drawing = 1, Fight = 2, Settled = 3 }

#[account]
pub struct Arena {
    pub authority: Pubkey,
    pub token_a: Pubkey,
    pub token_b: Pubkey,
    pub round_counter: u64,
    pub fee_bps: u16,
    pub bump: u8,
}
impl Arena { pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 2 + 1; }

#[account]
pub struct Round {
    pub arena: Pubkey,
    pub round_no: u64,
    pub phase: u8,
    pub winner: u8,
    pub bump: u8,
    pub fighter_count: u16,
    pub tick_count: u64,
    pub pot: u64,
    pub seed_commit: [u8; 32],
    pub seed: [u8; 32],
    pub fighters: [Fighter; MAX_FIGHTERS],
}
impl Round {
    // 8 discriminator + 32 arena + 8 round_no + 1 phase + 1 winner + 1 bump + 2 count
    // + 8 ticks + 8 pot + 32 commit + 32 seed + fighters
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 1 + 2 + 8 + 8 + 32 + 32 + (58 * MAX_FIGHTERS);
}

// ---------------------------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitArena<'info> {
    #[account(init, payer = authority, space = Arena::SIZE, seeds = [ARENA_SEED], bump)]
    pub arena: Account<'info, Arena>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_no: u64)]
pub struct OpenRound<'info> {
    #[account(mut, seeds = [ARENA_SEED], bump = arena.bump, has_one = authority)]
    pub arena: Account<'info, Arena>,
    #[account(init, payer = authority, space = Round::SIZE,
              seeds = [ROUND_SEED, arena.key().as_ref(), &round_no.to_le_bytes()], bump)]
    pub round: Account<'info, Round>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `#[delegate]` supplies `delegate_round_pda` and the delegation-program accounts.
#[delegate]
#[derive(Accounts)]
#[instruction(round_no: u64)]
pub struct DelegateRound<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ARENA_SEED], bump = arena.bump)]
    pub arena: Account<'info, Arena>,
    /// CHECK: the round PDA being delegated; validated by seeds in the CPI
    #[account(mut, del)]
    pub round_pda: UncheckedAccount<'info>,
}

/// No mutable accounts at all — the probe cannot write, by construction rather than by discipline.
#[derive(Accounts)]
pub struct BenchFight<'info> {
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Enter<'info> {
    #[account(seeds = [ARENA_SEED], bump = arena.bump)]
    pub arena: Account<'info, Arena>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    pub player: Signer<'info>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

/// `#[vrf]` supplies the accounts the randomness request CPI needs.
#[vrf]
#[derive(Accounts)]
pub struct DrawSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    /// CHECK: validated against the known queues by the VRF program
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// `#[vrf_callback]` injects `vrf_program_identity` as a Signer constrained to
/// `scoped_vrf_identity(&crate::ID)` — a PDA bound to THIS program, not the global identity (which
/// the SDK marks deprecated). Its presence as a signer is what proves the callback came from the
/// VRF program for this program specifically. Declaring it by hand would have got the constraint
/// wrong and left the callback spoofable by anything the VRF program also calls.
#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackSeed<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
}

/// `#[commit]` supplies `magic_context` and `magic_program`.
#[commit]
#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub round: Account<'info, Round>,
}

// ---------------------------------------------------------------------------------------------

#[event] pub struct RoundOpened { pub round_no: u64, pub seed_commit: [u8; 32] }
#[event] pub struct SeedRevealed { pub round_no: u64, pub seed: [u8; 32] }
#[event] pub struct RoundSettled { pub round_no: u64, pub winner: u8, pub pot: u64 }

#[error_code]
pub enum ArenaError {
    #[msg("fee exceeds the 10% ceiling")] FeeTooHigh,
    #[msg("rounds must open in sequence")] RoundOutOfOrder,
    #[msg("round is not in the lobby phase")] NotInLobby,
    #[msg("round is not fighting")] NotFighting,
    #[msg("round has not settled")] NotSettled,
    #[msg("side must be 0 or 1")] BadSide,
    #[msg("stake must be greater than zero")] ZeroStake,
    #[msg("round is full")] RoundFull,
    #[msg("step count must be 1..=256")] BadStepCount,
    #[msg("revealed seed does not match the published commitment")] SeedMismatch,
    #[msg("round is not awaiting randomness")] NotDrawing,
    #[msg("a fight needs at least two fighters")] NotEnoughFighters,
    #[msg("arithmetic overflow")] MathOverflow,
}
