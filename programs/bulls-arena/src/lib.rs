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
// FAIRNESS IS PRESERVED, THEN STRENGTHENED. The engine's original scheme publishes sha256(seed)
// before entries open — `open_round` still stores that commitment on-chain before anyone can enter.
// But ER-060 replaced the operator choosing the seed at all: `close_lobby_and_draw` requests
// randomness from MagicBlock's VRF oracle after the lobby closes, and `callback_seed` writes
// whatever the oracle returns — closing the one real gap in commit-reveal, where an operator could
// grind candidate seeds offline against the expected lobby and commit to the most favourable one.
// `seed_commit` is republished as sha256(the VRF output) purely so the browser replay and the
// on-chain anchor format stay unchanged; it is no longer a commitment checked against anything.

use anchor_lang::prelude::*;
// anchor 1.x no longer re-exports solana_program::hash — split crates now. hashv over slices also
// avoids building a 40-byte scratch buffer by hand, one fewer place to get an offset wrong.
use solana_sha256_hasher::hashv;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
// Session Keys (Phase 6, snug-floating-mitten.md) — proven combined with Ephemeral Rollup
// delegation first in a throwaway fork of this program (programs/bulls-arena-session-spike, devnet
// id EJ8dAm3HnBY9UL4mYBUyDzLTvgkDGAp8cT3e2mgaLxQP, commit e3fb149) before landing on the real,
// deployed program. `enter` used that exact pattern verified there; `extract` is the same shape
// applied for the first time here — it wasn't part of the spike, but it's structurally identical
// and arguably matters more: it's the mid-fight decision a player makes under real time pressure,
// and a wallet popup there undercuts the "real-time because of the ER" pitch worse than one at entry.
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

// v2 ADDRESS, and the reason is infrastructure, not code. The original devnet id
// (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW, keypair .devnet/program-keypair.json) is still a
// valid deployment of this same source and every verification signature in MEGA_QUEUE.md /
// MAGICBLOCK_FEEDBACK.md against it stands. But MagicBlock's ER validators cache a program's
// executable bytecode on first use and do not re-clone it after a base-layer upgrade (see
// MAGICBLOCK_FEEDBACK.md) — by the end of this session every public devnet validator was serving a
// pre-Phase-6 build of that id, or gating writes, leaving no route on which a live delegated round
// could run the current code. That cache is keyed by PROGRAM ID, so a fresh id has no stale clone
// anywhere and the first delegation pulls the current bytecode. This is a workaround for their cache,
// not a fix to anything here; the old id can be used again once its clones age out.
declare_id!("4uqVSyHtx7CBaXUL2qy7cN4eV3MzqmvucapGHN1imFYm"); // devnet keypair: .devnet/program-keypair-v2.json

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

/// SEC finding (independent review). `resolve` used to take `steps: u32` as a free caller-supplied
/// argument. By the time it's callable the seed is already public (`SeedRevealed` fires in
/// `callback_seed`, before `Fight` phase even begins), and `run_fight` is a pure function of
/// (seed, entries, steps) — so anyone could simulate all ~20,000 possible stopping points off-chain
/// in microseconds, find whichever `steps` value favoured them, and race to submit `resolve` first.
/// There was no stored canonical step count to check the call against, so this was strictly more
/// powerful than the already-documented "extract-timing" prediction risk: this let a caller pick the
/// FINAL OUTCOME itself, not just time a decision within it.
///
/// Fix: `steps` is no longer an argument at all. It is derived from real elapsed on-chain time since
/// `Phase::Fight` began (`Round.fight_started_at`, set in `callback_seed`), which nobody — caller,
/// operator, anyone — controls. `resolve` can stay permissionless because there is nothing left to
/// choose; the result is now purely a function of the VRF seed and how much real time has genuinely
/// passed, which is exactly what "provably fair" is supposed to mean.
pub const STEPS_PER_SECOND: u64 = 175;
/// Re-measured this session (task #15) after MAX_STEPS=7,000 — ER-030's number — turned out to have
/// ZERO real margin against the CURRENT `resolve`: a round left open past ~40s failed on-chain with
/// "1,399,850 of 1,399,850 CUs consumed, exceeded CUs meter" (devnet round #9, permanently stuck).
///
/// ER-030's 187.4 CU/step was measured against an OLDER `resolve` — before this session's security
/// fix restructured `steps` from a caller argument into a time-derived value — AND `bench_fight`
/// itself had drifted from `run_fight` by then (see its own comment): one cheap `a % 2 == d % 2`
/// check standing in for THREE real ones (side, wallet, dead), missing the 32-byte Pubkey compare
/// `run_fight` always pays. Re-measured by fixing `bench_fight` to call `run_fight` directly (so it
/// cannot drift again) and sweeping it on a local `solana-test-validator` running the current build
/// — CU accounting is a deterministic property of the bytecode and inputs, not the cluster, so this
/// is as real as a devnet number without spending devnet SOL to get it. Result: cost is NOT linear
/// per step (it falls from ~271 to ~198 CU/step as fighters die and more steps hit the cheap
/// early-`continue` path), and the measured total crosses the 1.4M ceiling between 6,800 steps
/// (1,389,142 CU — the loop alone, 99.2% of the ceiling) and 6,900 (over) — confirming the reported
/// failure at 7,000 was real, not a fluke, and that this bench path (once fixed) reproduces it.
///
/// 4,000 steps measures at 864,996 CU for the loop alone (61.8% of the ceiling) — this constant
/// covers only `run_fight`; the real `resolve` also pays for the `Round` account's borsh
/// deserialise-in and serialise-out (~937 bytes), the `require!`/`Clock::get()` guards, the
/// `RoundSettled` event, and the CPI to the Magic commit program, none of which `bench_fight`'s
/// bare-signer context exercises. There is no verified number for that remainder — ER-030 guessed
/// 30k CU for it and was wrong about the loop itself, so guessing again here would repeat the same
/// mistake. Instead: 4,000 leaves 535,004 CU (38.2%) of headroom for it, which would have to be
/// ~5x any prior guess before this stopped being real margin — and the actual total is checked for
/// real in this session's regression test (a round resolved after the cap, with a real signature),
/// not assumed from this comment.
///
/// STEPS_PER_SECOND unchanged, so the cap is now reached at 4,000 / 175 ≈ 22.9s instead of 40s — a
/// round resolved after that sees a fight frozen at the same outcome no matter how much later it's
/// actually called. This does not shrink `extract()`'s real window: that window is bounded by when
/// `resolve` is actually invoked (an off-chain/keeper decision), not by MAX_STEPS.
pub const MAX_STEPS: u64 = 4_000;
/// A fight must run for at least this long before anyone can resolve it. Without a floor, resolve()
/// could be called the instant Fight begins (steps = 0) and extract() — the mechanic this whole
/// migration exists to make load-bearing — would never get a real window to matter.
pub const MIN_FIGHT_SECONDS: i64 = 5;

/// ER-051. The whole fight, pure: no `Context`, no account borrow, no Anchor. This is what `resolve`
/// calls on-chain, and it is ALSO what a native `cargo test` calls off-chain — the same function,
/// not a re-description of it. `engine/src/er-sim.ts` is the line-for-line TypeScript mirror of this
/// exact loop; the test at the bottom of this file runs both implementations against the same seed
/// and entries and asserts byte-identical hp/banked/dead/winner. Before this, parity was "read to be
/// the same" — the weakest form of assurance, and the one EXECUTION_REPORT.md named as the residual
/// risk. This is the test that actually runs the Rust.
pub fn run_fight(fighters: &mut [Fighter; MAX_FIGHTERS], n: usize, seed: &[u8; 32], steps: u32) -> u8 {
    for step in 0..steps {
        let h = hashv(&[seed.as_ref(), (step as u64).to_le_bytes().as_ref()]).to_bytes();
        let a = (u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as usize) % n;
        let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % n;
        if d == a { d = (d + 1) % n; }

        if fighters[a].side == fighters[d].side { continue; }
        if fighters[a].wallet == fighters[d].wallet { continue; }
        if fighters[a].dead == 1 || fighters[d].dead == 1 { continue; }

        let roll = (h[8] as u64) % 24 + 4;
        let mut dmg = fighters[d].hp.saturating_mul(roll) / 100;
        if fighters[d].hp <= DUST || dmg == 0 { dmg = fighters[d].hp; }
        if dmg == 0 { continue; }

        fighters[d].hp = fighters[d].hp.saturating_sub(dmg);
        fighters[a].banked = fighters[a].banked.saturating_add(dmg);
        if fighters[d].hp == 0 { fighters[d].dead = 1; }
    }

    let (mut va, mut vb) = (0u64, 0u64);
    for f in fighters[..n].iter() {
        let v = f.hp.saturating_add(f.banked);
        if f.side == 0 { va = va.saturating_add(v) } else { vb = vb.saturating_add(v) }
    }
    if va >= vb { 0 } else { 1 }
}

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

    /// Open a round and publish the (now vestigial) seed commitment BEFORE anyone can enter.
    ///
    /// The ordering is the whole point: a commitment published after entries are known proves
    /// nothing. Kept for format compatibility even though the real seed now comes from the VRF
    /// oracle via `close_lobby_and_draw`/`callback_seed`, not from a value the operator chose here.
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
        r.fight_started_at = 0;   // meaningful only from callback_seed onward
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
            &ctx.accounts.authority,
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
    ///
    /// SESSION KEYS (Phase 6). `#[session_auth_or]` runs BEFORE the body below: if `session_token`
    /// is present and valid (a real PDA, unexpired, bound to this program as `target_program` and
    /// to `player` as its `authority`), the transaction may be signed by the session key instead of
    /// `player`'s own wallet. With no session token supplied, it falls back to requiring
    /// `signer.key() == player.key()` — ordinary direct-wallet signing, byte-for-byte what this
    /// instruction did before this phase. Either way `who = ctx.accounts.player.key()` below is
    /// what actually gets credited; the session key/signer is never itself the fighter identity.
    #[session_auth_or(
        ctx.accounts.player.key() == ctx.accounts.signer.key(),
        SessionError::InvalidToken
    )]
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
    /// of (seed, entries, steps); splitting it across 125 round-trips does not make it more correct,
    /// it just spreads one computation over 125 confirmations.
    ///
    /// NOR DOES THE PER-HIT DATA BELONG ON-CHAIN. Every blow is recomputable from the seed by
    /// anyone; storing them is publishing our own homework at a cost per byte. Only the inputs
    /// (seed, entries) and the OUTCOME (winner, final holdings) are recorded — which is exactly the
    /// set a sceptic needs to check the result themselves.
    ///
    /// `steps` is DERIVED, not accepted as an argument — see the constants above for why. It is a
    /// pure function of how long `Phase::Fight` has genuinely been running, which nobody controls.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        {
            let r = &mut ctx.accounts.round;
            require!(r.phase == Phase::Fight as u8, ArenaError::NotFighting);

            let n = r.fighter_count as usize;
            require!(n >= 2, ArenaError::NotEnoughFighters);

            let elapsed = (Clock::get()?.unix_timestamp - r.fight_started_at).max(0);
            require!(elapsed >= MIN_FIGHT_SECONDS, ArenaError::FightNotOverYet);
            let steps = ((elapsed as u64).saturating_mul(STEPS_PER_SECOND)).min(MAX_STEPS) as u32;

            let seed = r.seed;
            r.winner = run_fight(&mut r.fighters, n, &seed, steps);
            r.tick_count = steps as u64;
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

    /// EXTRACT — the mechanic that makes the rollup load-bearing.
    ///
    /// A player pulls out mid-fight: whatever they are still holding in the ring is banked, and they
    /// stop being a target. This is the whole reason this game belongs on an ER.
    ///
    /// Without it the fight is a pure function of (seed, entries) — decided before it starts, with
    /// the 40 seconds of animation merely replaying a result that already exists. Nothing
    /// precomputed needs 10ms blocks, so the rollup would be decoration.
    ///
    /// With it, the outcome depends on WHEN humans press a button. State mutates constantly from
    /// many wallets mid-round, the result cannot be computed in advance, and latency stops being a
    /// performance note and becomes the game: at 400ms base-layer slots "extract now" is a promise
    /// you cannot keep.
    ///
    /// Deliberately cheap — one guard, one move of value, no loop. It has to be affordable to call
    /// at any moment by anyone, which is the opposite of the fight itself.
    ///
    /// SESSION KEYS (Phase 6). Same `player`/`signer` split and the same `#[session_auth_or]` guard
    /// as `enter` — see `Enter`'s struct doc comment for the full rationale. This is the more
    /// important of the two to cover: without it, every single extract — the one action this whole
    /// migration exists to make load-bearing — pops a wallet dialog under real time pressure.
    #[session_auth_or(
        ctx.accounts.player.key() == ctx.accounts.signer.key(),
        SessionError::InvalidToken
    )]
    pub fn extract(ctx: Context<Extract>) -> Result<()> {
        let who = ctx.accounts.player.key();
        let r = &mut ctx.accounts.round;
        require!(r.phase == Phase::Fight as u8, ArenaError::NotFighting);

        let n = r.fighter_count as usize;
        let f = r.fighters[..n]
            .iter_mut()
            .find(|f| f.wallet == who && f.dead == 0 && f.hp > 0)
            .ok_or(ArenaError::NothingToExtract)?;

        // Value MOVES from the ring to the bank; it is not created. `banked` is already safe from
        // raids, so this is the whole risk/reward decision in two lines: give up the chance to take
        // more, in exchange for keeping what you have.
        let taken = f.hp;
        f.banked = f.banked.checked_add(taken).ok_or(ArenaError::MathOverflow)?;
        f.hp = 0;
        f.dead = 1;                     // out of the ring — no longer a valid target

        emit!(Extracted { round_no: r.round_no, player: who, amount: taken });
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
    ///
    /// Feature-gated (`bench`) and off by default — this program is unusually size-constrained on
    /// devnet (rent scales with binary bytes against a faucet-limited payer), and a measurement tool
    /// has no reason to cost bytes in every deploy that isn't actively re-measuring.
    #[cfg(feature = "bench")]
    pub fn bench_fight(_ctx: Context<BenchFight>, steps: u32, fighters: u8) -> Result<()> {
        require!(steps > 0 && steps <= 20_000, ArenaError::BadStepCount);
        let n = (fighters as usize).clamp(2, MAX_FIGHTERS);

        // Found while re-measuring for the MAX_STEPS fix (this session): this probe used to be a
        // hand-copied stand-in for `run_fight`'s loop — one check (`a % 2 == d % 2`) doing duty for
        // THREE (side, wallet, dead), no `dead` write, and a bare `u64` HP array instead of the real
        // 58-byte `Fighter`. That undercounts the cost of every step (skips a 32-byte Pubkey compare
        // the real loop always pays) while also never letting anyone go `dead`, so it OVERcounts how
        // often the expensive damage branch fires late in a fight, once real fighters would have
        // started dying. Which error dominated was exactly the kind of thing "estimate carefully" is
        // no substitute for measuring — it drifted enough that steps=7,000 exceeded a 1.4M-CU
        // transaction on the real, current `resolve`. Calling `run_fight` directly — the same
        // function it's meant to describe, per its own doc comment — is the only way this cannot
        // drift again.
        let mut arr = [Fighter::default(); MAX_FIGHTERS];
        for (i, f) in arr.iter_mut().enumerate().take(n) {
            *f = Fighter {
                wallet: Pubkey::new_from_array([(i as u8) + 1; 32]), // distinct per fighter, like real entries
                side: (i % 2) as u8,                                  // alternating, like a real matched book
                dead: 0,
                stake: 1_000_000_000,
                hp: 1_000_000_000,
                banked: 0,
            };
        }
        let seed = [7u8; 32];
        let winner = run_fight(&mut arr, n, &seed, steps);
        // consume the result so the optimiser cannot delete the loop and report a fictitious cost
        msg!("bench {} steps, {} fighters, winner={} hp0={} banked0={}", steps, n, winner, arr[0].hp, arr[0].banked);
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
        // SEC finding (independent review): `accounts_metas: None` meant the oracle's callback into
        // `callback_seed` carried only the auto-injected `vrf_program_identity` signer — `round` was
        // never in the callback's account list, so Anchor could never deserialise `CallbackSeed` and
        // every round would sit in Drawing forever with no way out. The round must be named here
        // explicitly so the oracle attaches it (mutable, not a signer) to the callback instruction.
        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer: ctx.accounts.payer.key(),
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackSeed::DISCRIMINATOR.to_vec(),
            caller_seed: client_seed,
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: ctx.accounts.round.key(),
                is_signer: false,
                is_writable: true,
            }]),
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
        // The clock `resolve` later derives `steps` from — see the constants near DUST for why this
        // has to be real on-chain time rather than a caller-supplied number.
        r.fight_started_at = Clock::get()?.unix_timestamp;
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
    /// Unix timestamp `callback_seed` stamped when `Phase::Fight` began. `resolve` derives `steps`
    /// from elapsed real time against this — see the constants near `DUST` for why.
    pub fight_started_at: i64,
    pub fighters: [Fighter; MAX_FIGHTERS],
}
impl Round {
    // 8 discriminator + 32 arena + 8 round_no + 1 phase + 1 winner + 1 bump + 2 count
    // + 8 ticks + 8 pot + 32 commit + 32 seed + 8 fight_started_at + fighters
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 1 + 2 + 8 + 8 + 32 + 32 + 8 + (58 * MAX_FIGHTERS);
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
///
/// SEC finding (independent review): this previously had NO authority check at all — `arena` was
/// only PDA-derivation-checked, and `#[delegate]` itself injects no signer/owner comparison. Any
/// signer could delegate ANY open round to a validator of their own choosing via `remaining_accounts`
/// — and once delegated, only that validator can write the round for the rest of its life. Whoever
/// controls validator selection controls write authority over the round's state, which is the actual
/// security boundary of the whole migration. `has_one = authority` closes it, mirroring `OpenRound`.
#[delegate]
#[derive(Accounts)]
#[instruction(round_no: u64)]
pub struct DelegateRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ARENA_SEED], bump = arena.bump, has_one = authority)]
    pub arena: Account<'info, Arena>,
    /// CHECK: the round PDA being delegated; validated by seeds in the CPI
    #[account(mut, del)]
    pub round_pda: UncheckedAccount<'info>,
}

/// `player`/`signer` split apart on purpose — same shape as `Enter`, see that struct's doc comment
/// for the full rationale. Extracting still credits `player`, not whoever signed.
#[derive(Accounts, Session)]
pub struct Extract<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
    /// CHECK: the fighter identity pulling out — see the struct doc comment for why this is
    /// intentionally not required to sign directly. Nobody extracts on anyone else's behalf: the
    /// `#[session_auth_or]` guard on `extract()` still requires either `signer == player` directly,
    /// or a session token whose `authority` is this exact pubkey.
    pub player: UncheckedAccount<'info>,
    #[session(signer = signer, authority = player.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(mut)]
    pub signer: Signer<'info>,
}

#[cfg(feature = "bench")]
#[derive(Accounts)]
pub struct BenchFight<'info> {
    pub payer: Signer<'info>,
}

/// `player`/`signer` split apart on purpose — this is the whole shape Session Keys forces: `player`
/// is WHO gets credited (the fighter identity written into `Round.fighters`, and the pubkey the
/// SessionToken's `authority` must equal); `signer` is WHOEVER actually signed this transaction (the
/// session key, when one is used, or `player`'s own wallet directly when none is). `player`
/// deliberately can no longer be `Signer<'info>` — requiring the identity itself to sign would
/// defeat the entire point of a session key. It is still safe unsigned: `#[session(authority =
/// player.key())]` below makes `player` a seed the real SessionToken PDA's address must already
/// match (see `SessionToken::validate` in the session-keys crate), so a caller can't just name an
/// arbitrary wallet — only a token that wallet's own signature actually created will resolve.
#[derive(Accounts, Session)]
pub struct Enter<'info> {
    #[account(seeds = [ARENA_SEED], bump = arena.bump)]
    pub arena: Account<'info, Arena>,
    #[account(mut)]
    pub round: Account<'info, Round>,
    /// CHECK: the fighter identity credited by this instruction — see the struct doc comment for
    /// why this is intentionally not required to sign directly.
    pub player: UncheckedAccount<'info>,
    #[session(signer = signer, authority = player.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
    #[account(mut)]
    pub signer: Signer<'info>,
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
#[event] pub struct Extracted { pub round_no: u64, pub player: Pubkey, pub amount: u64 }

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
    #[msg("step count must be 1..=20000")] BadStepCount,
    #[msg("round is not awaiting randomness")] NotDrawing,
    #[msg("a fight needs at least two fighters")] NotEnoughFighters,
    #[msg("nothing in the ring to extract")] NothingToExtract,
    #[msg("arithmetic overflow")] MathOverflow,
    #[msg("the fight must run for MIN_FIGHT_SECONDS before it can be resolved")] FightNotOverYet,
}

// ---------------------------------------------------------------------------------------------
// ER-051 parity. Native host test — no SBF, no deploy, `cargo test --manifest-path
// programs/bulls-arena/Cargo.toml`. Runs the ACTUAL `run_fight` that `resolve` calls on-chain,
// against the same (seed, entries, steps) as `engine/src/er-sim.ts`'s `tick`+`settle`, and asserts
// byte-identical hp/banked/dead/winner. The TS numbers below were captured by running the TS mirror
// once (`node --experimental-strip-types programs/bulls-arena/gen-parity-fixture.mjs`, checked into
// the repo — re-run it and diff if this fixture ever needs to change), not hand-derived. If this
// ever fails, the on-chain game has diverged from the game players are watching, which is the single
// worst outcome this migration could produce.
// ---------------------------------------------------------------------------------------------
#[cfg(test)]
mod parity_tests {
    use super::*;

    fn pk(b: u8) -> Pubkey { Pubkey::new_from_array([b; 32]) }

    #[test]
    fn run_fight_matches_the_typescript_mirror_exactly() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);   // bytes 0..32, same as the TS fixture

        let mut fighters = [Fighter::default(); MAX_FIGHTERS];
        fighters[0] = Fighter { wallet: pk(1), side: 0, dead: 0, stake: 100_000, hp: 100_000, banked: 0 };
        fighters[1] = Fighter { wallet: pk(2), side: 0, dead: 0, stake: 250_000, hp: 250_000, banked: 0 };
        fighters[2] = Fighter { wallet: pk(3), side: 1, dead: 0, stake: 180_000, hp: 180_000, banked: 0 };
        fighters[3] = Fighter { wallet: pk(4), side: 1, dead: 0, stake: 90_000, hp: 90_000, banked: 0 };

        let winner = run_fight(&mut fighters, 4, &seed, 50);

        // From gen-parity-fixture.mjs against engine/src/er-sim.ts, same seed/entries/steps.
        assert_eq!(winner, 0);
        assert_eq!((fighters[0].hp, fighters[0].banked, fighters[0].dead), (15158, 84062, 0));
        assert_eq!((fighters[1].hp, fighters[1].banked, fighters[1].dead), (201600, 116021, 0));
        assert_eq!((fighters[2].hp, fighters[2].banked, fighters[2].dead), (26975, 48467, 0));
        assert_eq!((fighters[3].hp, fighters[3].banked, fighters[3].dead), (42942, 84775, 0));

        // Conservation, restated here rather than trusted from elsewhere: this exact run must not
        // create or destroy value, on top of matching the TS mirror's numbers.
        let total: u64 = fighters[..4].iter().map(|f| f.hp + f.banked).sum();
        assert_eq!(total, 620_000);
    }
}
