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

// v3 ADDRESS, and the reason is infrastructure, not code — for the third time, from the same cause.
//
// MagicBlock's ER validators clone a program's executable bytecode on first use and do not re-clone
// it after a base-layer upgrade (MAGICBLOCK_FEEDBACK.md). The cache is keyed by PROGRAM ID, so a
// fresh id has no stale clone anywhere and the first delegation pulls the current build. v1
// (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW) and v2 (4uqVSyHtx7CBaXUL2qy7cN4eV3MzqmvucapGHN1imFYm)
// are both still valid deployments of this same source, and every verification signature recorded
// against them stands.
//
// WHAT WAS DIFFERENT THIS TIME: it was measured rather than inferred from a mystifying failure. The
// clone is the raw ELF plus a 48-byte LoaderV4 header, so its length identifies which build a
// validator is serving. After upgrading v2 in place, all FOUR validators the router advertises
// (`getRoutes`: devnet-eu/-as/-us/-tee) still reported 312,792 B — the previous build — while the
// current one measures 316,800 B. Ten minutes and a re-probe later, unchanged. Note v2's earlier
// comment hoped "the old id can be used again once its clones age out": within the timescale of a
// session, they do not. `er-demo/scripts/verify-stepped-fight.ts` now runs that same length check as
// a preflight, so this costs one second and a clear message instead of a spent round and a very
// confusing error about the code under test.
declare_id!("8s3x42af7gcNXDCTNheDtteQxeBS2D1p9xuU8C5Jgfrt"); // devnet keypair: .devnet/program-keypair-v3.json

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
///
/// THAT PROPERTY SURVIVES STEPPED TICKING UNCHANGED. `tick` advances the fight incrementally now, but
/// only ever as far as `canonical_cursor()` — the cursor real elapsed time says the fight has already
/// reached. Nobody can push it past that, so nobody can choose where the fight stops. All that
/// changed is WHEN the arithmetic happens (continuously, in the rollup) rather than what it produces.
///
/// THE RATE IS PER FIGHTER, and that is not a flourish. Measured against the TypeScript mirror
/// (`engine/src/er-sim.ts`, 12 seeds per lineup size, equal stakes), the number of steps a fight needs
/// before one side has nobody left standing is:
///
/// ```text
/// fighters | steps to finish   min /  median /   max
/// ---------+--------------------------------------------
///      2   |                    51 /     69 /     78
///      4   |                   186 /    231 /    310
///      8   |                   445 /    624 /    772
///     16   |                 1,282 /  1,814 /  2,692
/// ```
///
/// — roughly n^1.5, because a bigger brawl needs more kills AND wastes more picks on fighters who are
/// already dead. A FLAT rate therefore cannot give a sane duration at both ends of that range. The old
/// 175/s finished a two-fighter fight in 0.4 SECONDS (nobody could ever have pressed extract inside
/// it), and any flat rate slow enough to make that watchable stretches a sixteen-fighter fight past
/// ten minutes. Dividing the natural length by n leaves ~n^0.5, so a per-fighter rate puts every legal
/// lineup in the same band:
///
/// ```text
/// fighters | rate  | fight lasts
/// ---------+-------+-----------------
///      2   |  4/s  | 12.8s ..  19.5s
///      4   |  8/s  | 23.3s ..  38.8s
///      8   | 16/s  | 27.8s ..  48.3s
///     16   | 32/s  | 40.1s ..  84.1s
/// ```
///
/// `fighter_count` is frozen at lobby close — before the seed exists — so the rate is not something a
/// caller can move, and the security argument above is untouched by making it lineup-dependent.
pub const STEPS_PER_FIGHTER_PER_SECOND: u64 = 2;
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
/// WHAT THIS CONSTANT IS FOR NOW (stepped fight, this session). It is no longer the thing that ends a
/// round — `FIGHT_TIMEOUT_SECONDS` is. It is purely the ceiling on how much fight ANY SINGLE
/// instruction can be made to run in one transaction: `canonical_cursor()` saturates here, and every
/// caller catches the stored cursor up to that cursor and no further, so `tick`, `extract` and
/// `resolve` all inherit this same measured bound whether the round was ticked diligently or ignored
/// completely. With the per-fighter rate below, the largest legal lineup reaches
/// 120s × 32/s = 3,840 steps at the bell — under this cap, so the cap never truncates a real fight;
/// it exists only so an unattended round can never present a caller with unbounded work.
pub const MAX_STEPS: u64 = 4_000;

/// THE BELL. Once this much real time has passed since `Phase::Fight` began, anyone may settle the
/// round even with fighters still standing. This is the guarantee that a round can never become
/// unsettleable — a failure mode this repo has already paid for twice (two permanently-stuck rounds
/// from the compute-budget bug in task #15), and the reason `resolve` runs whatever steps remain
/// rather than requiring someone to have ticked first.
///
/// It REPLACES `MIN_FIGHT_SECONDS` (5s), which stopped meaning what it said the moment the fight
/// became stepped. At 175 steps/s, 5 seconds was 875 steps — past the natural end of any small fight
/// — so "you may not resolve before 5s" was in practice "you may not resolve before the fight is
/// over", and the floor read as a formality. At the pace a watchable fight actually needs, 5 seconds
/// is about a tenth of a two-fighter fight, and `resolve` is permissionless: whoever happened to be
/// ahead at second five could have settled and kept it. That is a caller choosing the outcome, which
/// is the exact class of bug the `steps` argument was removed for — so the guard now says what it
/// always meant. Settle when the fight is genuinely OVER (one side has nobody left standing), or when
/// the bell rings, whichever comes first.
///
/// 120s clears the longest lineup in the table above (16 fighters, 84.1s worst case) with margin.
pub const FIGHT_TIMEOUT_SECONDS: i64 = 120;

/// The fight's pace for a given lineup — see `STEPS_PER_FIGHTER_PER_SECOND` for the measurements.
pub fn steps_per_second(fighter_count: usize) -> u64 {
    (fighter_count as u64).saturating_mul(STEPS_PER_FIGHTER_PER_SECOND)
}

/// HOW FAR THE FIGHT HAS GENUINELY PROGRESSED at `now`. This one function is the definition of the
/// round's state: every instruction that reads or moves the fight brings the stored cursor up to this
/// and never past it.
///
/// Saying it once, here, is what keeps `hp` from becoming "whatever the last person who bothered to
/// call `tick` left behind". Two fighters who both simply decline to tick must not thereby freeze the
/// fight and get their stakes back — that is the free-undo bug this session exists to remove, and it
/// would come straight back in a subtler form if any payout path trusted the stored cursor instead of
/// this one.
pub fn canonical_cursor(fight_started_at: i64, fighter_count: usize, now: i64) -> u64 {
    let elapsed = now.saturating_sub(fight_started_at).max(0) as u64;
    elapsed.saturating_mul(steps_per_second(fighter_count)).min(MAX_STEPS)
}

/// ER-051. The fight, pure: no `Context`, no account borrow, no Anchor. This is what the on-chain
/// instructions call, and it is ALSO what a native `cargo test` calls off-chain — the same function,
/// not a re-description of it. `engine/src/er-sim.ts` is the line-for-line TypeScript mirror of this
/// exact loop; the test at the bottom of this file runs both implementations against the same seed
/// and entries and asserts byte-identical hp/banked/dead/winner. Before this, parity was "read to be
/// the same" — the weakest form of assurance, and the one EXECUTION_REPORT.md named as the residual
/// risk. This is the test that actually runs the Rust.
///
/// CURSOR-BASED (this session): it runs steps `[cursor, cursor + steps)` instead of always `0..steps`,
/// so a fight can be advanced a few steps at a time, from wherever it got to, by separate
/// transactions. The step number is hashed with the seed, so the same absolute cursor produces the
/// same exchange no matter how it was reached — running 0..200 in one call and in fifty calls of four
/// are byte-identical, which `ticking_in_chunks_is_identical_to_one_shot` asserts rather than assumes.
///
/// Worth naming plainly: the TypeScript mirror NEVER stopped working this way (`round.tickCount` has
/// always been its cursor). It was the Rust that diverged when `resolve` was made one-shot. This is
/// the Rust coming back into line with the mirror, not a new shape for both to chase.
pub fn advance_fight(fighters: &mut [Fighter; MAX_FIGHTERS], n: usize, seed: &[u8; 32], cursor: u64, steps: u64) {
    if n < 2 { return; }        // mirrors `if (n < 2) break;` in er-sim.ts; unreachable in Fight phase
    for step in cursor..cursor.saturating_add(steps) {
        let h = hashv(&[seed.as_ref(), step.to_le_bytes().as_ref()]).to_bytes();
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
}

/// Side value is `hp + banked`; ties go to side A. Mirrors `settle` in `er-sim.ts`.
///
/// Note what it does NOT require: that the fight ran to a finish. Settling a fight still in progress
/// is a well-defined question — who is holding more right now — which is what makes the bell in
/// `FIGHT_TIMEOUT_SECONDS` a legitimate ending rather than an abandonment.
pub fn settle_sides(fighters: &[Fighter; MAX_FIGHTERS], n: usize) -> u8 {
    let (mut va, mut vb) = (0u64, 0u64);
    for f in fighters[..n].iter() {
        let v = f.hp.saturating_add(f.banked);
        if f.side == 0 { va = va.saturating_add(v) } else { vb = vb.saturating_add(v) }
    }
    if va >= vb { 0 } else { 1 }
}

/// True when there is nothing left to play: one side has no fighter still standing.
///
/// An EXTRACTED fighter counts as out of the ring (`dead == 1`), and that is deliberate rather than
/// incidental — pull the last opponent out and the fight really is over, because there is nobody left
/// to raid. A lineup that is entirely on one side satisfies this from the first instant, which is
/// also correct rather than a special case: same-side pairs never exchange, so such a round contains
/// no fight at all and should be settleable immediately.
pub fn fight_is_over(fighters: &[Fighter; MAX_FIGHTERS], n: usize) -> bool {
    let (mut a, mut b) = (0u32, 0u32);
    for f in fighters[..n].iter().filter(|f| f.dead == 0) {
        if f.side == 0 { a += 1 } else { b += 1 }
    }
    a == 0 || b == 0
}

/// The whole fight from a standing start, then the winner. Kept as one function because the parity
/// fixture and the `bench` compute probe both describe the fight that way, and because it is the
/// shape `engine/src/er-sim.ts`'s own tests use (`tick(round, steps)` then `settle(round)`).
pub fn run_fight(fighters: &mut [Fighter; MAX_FIGHTERS], n: usize, seed: &[u8; 32], steps: u32) -> u8 {
    advance_fight(fighters, n, seed, 0, steps as u64);
    settle_sides(fighters, n)
}

/// Bring a round's stored fight state up to `canonical_cursor`, running at most `limit` steps, and
/// report how many actually ran.
///
/// EVERY instruction that depends on the fight's state calls this first, and that rule is the whole
/// design. `hp` is not "whatever the last person who bothered to tick left behind"; it is a function
/// of real elapsed time, and any payout path that trusted the stored cursor instead could be starved
/// into paying out a stale — i.e. larger — number simply by nobody ticking.
///
/// Work is bounded by construction: `canonical_cursor` saturates at `MAX_STEPS`, so no single call can
/// run more than MAX_STEPS steps however long a round has been left unattended. That is the same
/// ceiling `resolve` was measured and devnet-verified against in task #15, not a new one to re-earn —
/// and in the normal case, where anything at all is ticking, each call runs a handful of steps.
fn catch_up(r: &mut Round, now: i64, limit: u64) -> u64 {
    let n = r.fighter_count as usize;
    if n < 2 { return 0; }
    let target = canonical_cursor(r.fight_started_at, n, now);
    let from = r.tick_count;
    if target <= from { return 0; }
    let steps = (target - from).min(limit);
    let seed = r.seed;
    advance_fight(&mut r.fighters, n, &seed, from, steps);
    r.tick_count = from + steps;
    steps
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

    /// TICK — advance the live fight, on-chain, mid-round. THE instruction that makes the rollup
    /// load-bearing rather than described as such.
    ///
    /// WHY THIS EXISTS AGAIN, HAVING BEEN DELETED ONCE. ER-024's original `tick` was removed by
    /// ER-030/031 for a good reason: with no player input, the fight was a pure function of
    /// (seed, entries, steps), and splitting one computation across 125 confirmations bought nothing.
    /// That reasoning was correct AND its premise is now false. `extract` gives players a decision
    /// DURING the fight, and a decision can only be about state that exists — so the fight has to
    /// actually be somewhere when the button is pressed. `HACKATHON_ANGLE.md` predicted this exact
    /// reversal ("Fight becomes stepped again — but for a real reason"); this is it, not a drift back.
    ///
    /// The concrete bug it fixes: `run_fight` used to be called in ONE place, at the very end of
    /// `resolve`, so for the entire Fight phase every fighter's `hp` was still their full entry stake
    /// and `extract` therefore returned 100% of it whenever it was pressed. A free undo button, while
    /// the browser animated health draining that the chain did not believe in.
    ///
    /// PERMISSIONLESS, AND NOT LOOSELY SO. There is no authority check because there is nothing to
    /// protect: this call cannot advance the fight past `canonical_cursor()`, which is fixed by real
    /// elapsed time and the lobby-frozen fighter count. So the strongest thing any caller can do is
    /// make the stored state agree with the state that already, definitionally, holds — and calling
    /// it more often, in bigger chunks, from more wallets, or not at all, all produce the same fight.
    /// A caller who ticks aggressively is doing the round a favour at their own expense; a caller who
    /// refuses to tick achieves nothing, because `extract` and `resolve` catch up themselves.
    /// Front-running someone's `extract` with a tick is likewise no attack: it can only move the
    /// cursor to where the clock already says it is, which is precisely what that `extract` was about
    /// to do anyway.
    ///
    /// WHO DRIVES IT: whoever is watching. The browser client ticks once a second while it has a
    /// round in Fight phase (`er-demo/src/chain/useFightTicker.ts`) — every open tab, including
    /// spectators, using a session key so it costs no wallet dialogs. A keeper can do it too. Nobody
    /// HAS to: an unticked round is still settled correctly by `resolve`, just with the arithmetic
    /// deferred. That is the difference between a liveness helper and a dependency.
    ///
    /// `steps` is a hint, not a promise: the call runs `min(steps, cursor_backlog)` and succeeds
    /// having done nothing when the fight is already up to date. Deliberate — two clients ticking the
    /// same round must not make each other's transactions fail.
    pub fn tick(ctx: Context<Tick>, steps: u32) -> Result<()> {
        require!(steps > 0, ArenaError::BadStepCount);
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        require!(r.phase == Phase::Fight as u8, ArenaError::NotFighting);
        require!(r.fighter_count >= 2, ArenaError::NotEnoughFighters);

        let ran = catch_up(r, now, steps as u64);
        // The one on-chain artifact of a tick that is legible in an explorer. The account diff is the
        // real evidence, but a log line saying "advanced 4 steps to cursor 48" is what makes a stream
        // of these transactions self-evidently a live fight rather than a stream of no-ops.
        emit!(Ticked { round_no: r.round_no, cursor: r.tick_count, steps: ran as u32 });
        Ok(())
    }

    /// Finalise the round: bring the fight up to date, decide the winner from where it stands, settle,
    /// commit.
    ///
    /// IT NO LONGER RUNS THE FIGHT FROM SCRATCH — it runs whatever steps `tick` has not already done.
    /// That was a deliberate choice between two options, and the other one is a trap: "require the
    /// fight to have been fully ticked before you may resolve" would make settlement depend on
    /// somebody having done optional work, which is exactly how a round becomes permanently stuck.
    /// This repo already has two of those (task #15) and does not need a third failure mode. So
    /// `resolve` is self-sufficient: it can always finish the job alone, and ticking only ever makes
    /// it cheaper. In the fully-unticked worst case it does precisely what the old one-shot `resolve`
    /// did, against the same MAX_STEPS bound that was measured and devnet-verified for it.
    ///
    /// WHEN IT MAY BE CALLED: once the fight is genuinely over (one side has nobody standing), or once
    /// the bell has rung (`FIGHT_TIMEOUT_SECONDS`), whichever comes first — see that constant for why
    /// this replaced a flat 5-second floor, and why leaving the floor in place would have handed a
    /// permissionless caller the power to settle a live fight at the moment it favoured them.
    ///
    /// The catch-up runs BEFORE that check on purpose: a fight that ends inside the very steps this
    /// call is about to run is over, and should settle now rather than making someone call twice.
    ///
    /// PER-HIT DATA STILL DOES NOT BELONG ON-CHAIN. Every blow is recomputable from the seed by
    /// anyone; storing them is publishing our own homework at a cost per byte. Only the inputs
    /// (seed, entries), the CURSOR, and the outcome (winner, final holdings) are recorded — which is
    /// exactly the set a sceptic needs to check the result themselves.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        {
            let now = Clock::get()?.unix_timestamp;
            let r = &mut ctx.accounts.round;
            require!(r.phase == Phase::Fight as u8, ArenaError::NotFighting);

            let n = r.fighter_count as usize;
            require!(n >= 2, ArenaError::NotEnoughFighters);

            catch_up(r, now, u64::MAX);

            let elapsed = now.saturating_sub(r.fight_started_at).max(0);
            require!(
                fight_is_over(&r.fighters, n) || elapsed >= FIGHT_TIMEOUT_SECONDS,
                ArenaError::FightNotOverYet
            );

            r.winner = settle_sides(&r.fighters, n);
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
    /// IT BANKS WHAT REMAINS, AND ONLY NOW DOES THAT MEAN ANYTHING. The code here is almost unchanged
    /// — it always banked `f.hp` — but until the fight actually advanced on-chain, `f.hp` was still
    /// the full entry stake at every moment of the Fight phase, so this paid out 100% no matter when
    /// it was pressed. Verified empirically before the change: hp=499000 -> banked=499000. The
    /// mechanic was decoration. With `tick`/`catch_up` moving `hp` for real, pulling out late banks
    /// less than pulling out early, which is the entire decision the round is built around.
    ///
    /// THE ONE REAL CHANGE IS THE `catch_up` BELOW, and it is not optional. Banking `f.hp` at the
    /// STORED cursor would mean the payout depends on whether anyone happened to tick recently — so a
    /// player could simply not tick, hope nobody else did, and extract at a cursor where they still
    /// held everything. That is the free-refund bug wearing a different hat. Settling the ring to the
    /// current time first makes the payout a function of the clock, not of anyone's diligence.
    ///
    /// The cost of that is bounded, not unbounded: `catch_up` can never run more than `MAX_STEPS`
    /// steps (see `canonical_cursor`), the same ceiling `resolve` is measured against. In the normal
    /// case — anything at all ticking — it runs single digits, and this stays the cheap instruction it
    /// needs to be. Clients should still request the CU ceiling on it, because the bound that makes
    /// this safe is a worst case, not a typical one.
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
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        require!(r.phase == Phase::Fight as u8, ArenaError::NotFighting);

        // Settle the ring up to THIS INSTANT before paying anyone out — see the doc comment above.
        // Note the ordering consequence, which is correct and not an edge case: a fighter killed by
        // one of the steps this call just ran is dead, and their extract fails with NothingToExtract.
        // You cannot outrun a blow that has already landed in real time.
        catch_up(r, now, u64::MAX);

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

// `Debug` only under `cfg(test)`: the cursor-invariance tests compare whole fighter arrays, and a
// failure there is worth reading rather than guessing at. It costs the deployed binary nothing, which
// matters here — this program is size-constrained on devnet (see MAX_FIGHTERS's doc comment).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
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

/// `tick` names ONE account and declares no signer of its own.
///
/// That is the honest encoding of what the instruction is: it takes no authority, credits nobody, and
/// cannot reach a state the clock does not already imply (see `tick`'s doc comment). Adding a
/// `Signer` field would suggest a permission that is not being checked. The transaction still has a
/// fee payer, as every transaction must — this instruction simply has no opinion about who it is.
///
/// No `#[commit]` either: a tick mutates rollup state and leaves it there. Committing every tick to
/// the base layer would pay for a settlement per exchange and defeat the reason the round is
/// delegated at all; `resolve`/`close_round` remain the only commit points.
#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut)]
    pub round: Account<'info, Round>,
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
/// `steps` is how many this call actually ran (0 when the fight was already up to date), `cursor` is
/// where the fight now stands.
#[event] pub struct Ticked { pub round_no: u64, pub cursor: u64, pub steps: u32 }
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
    #[msg("step count out of range")] BadStepCount,
    #[msg("round is not awaiting randomness")] NotDrawing,
    #[msg("a fight needs at least two fighters")] NotEnoughFighters,
    #[msg("nothing in the ring to extract")] NothingToExtract,
    #[msg("arithmetic overflow")] MathOverflow,
    #[msg("both sides still have fighters standing and the bell has not rung")] FightNotOverYet,
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

    fn four_fighters() -> [Fighter; MAX_FIGHTERS] {
        let mut f = [Fighter::default(); MAX_FIGHTERS];
        f[0] = Fighter { wallet: pk(1), side: 0, dead: 0, stake: 100_000, hp: 100_000, banked: 0 };
        f[1] = Fighter { wallet: pk(2), side: 0, dead: 0, stake: 250_000, hp: 250_000, banked: 0 };
        f[2] = Fighter { wallet: pk(3), side: 1, dead: 0, stake: 180_000, hp: 180_000, banked: 0 };
        f[3] = Fighter { wallet: pk(4), side: 1, dead: 0, stake:  90_000, hp:  90_000, banked: 0 };
        f
    }

    /// The property the whole stepped design rests on. If advancing a fight in small chunks produced
    /// anything other than what advancing it in one call produces, then how diligently a round was
    /// ticked would change its outcome — and `tick` would stop being the outcome-neutral operation
    /// its permissionlessness is justified by.
    #[test]
    fn ticking_in_chunks_is_identical_to_one_shot() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);

        let mut one_shot = four_fighters();
        advance_fight(&mut one_shot, 4, &seed, 0, 200);

        // Deliberately RAGGED chunk sizes, not a clean divisor: a real round is ticked by whatever
        // clients happen to be watching, at whatever moments their timers fire.
        let mut chunked = four_fighters();
        let mut cursor = 0u64;
        for steps in [1u64, 7, 3, 40, 11, 60, 2, 76] {
            advance_fight(&mut chunked, 4, &seed, cursor, steps);
            cursor += steps;
        }
        assert_eq!(cursor, 200);
        assert_eq!(one_shot, chunked);
        assert_eq!(settle_sides(&one_shot, 4), settle_sides(&chunked, 4));
    }

    /// THE POINT OF THIS SESSION'S CHANGE, as an assertion rather than a claim.
    ///
    /// Before it, `run_fight` ran in exactly one place — the end of `resolve` — so `hp` was still the
    /// full entry stake for the whole Fight phase and `extract` always returned 100% of it. This test
    /// fails against that behaviour: it extracts a fighter partway through a genuinely-advanced fight
    /// and requires the banked amount to be strictly less than what they put in.
    #[test]
    fn extracting_partway_through_banks_less_than_the_stake() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mut f = four_fighters();
        let stake = f[0].stake;

        advance_fight(&mut f, 4, &seed, 0, 40);
        assert!(f[0].hp < stake, "hp must have genuinely decayed by step 40, got {}", f[0].hp);

        // `extract` itself, inlined — the instruction adds only the account plumbing and the guards.
        let taken = f[0].hp;
        f[0].banked += taken;
        f[0].hp = 0;
        f[0].dead = 1;

        assert!(
            f[0].banked < stake,
            "extracting mid-fight must bank LESS than the entry stake: banked {} vs stake {}",
            f[0].banked, stake,
        );

        // ...and value is still conserved: the fighter's losses moved to their attackers, they were
        // not deleted. This is the invariant that catches an economics bug in one line.
        let total: u64 = f[..4].iter().map(|x| x.hp + x.banked).sum();
        assert_eq!(total, 620_000);

        // Extracted fighters leave the ring: the rest of the fight must not touch them again.
        let banked_at_extract = f[0].banked;
        advance_fight(&mut f, 4, &seed, 40, 160);
        assert_eq!(f[0].hp, 0);
        assert_eq!(f[0].banked, banked_at_extract);
        let total: u64 = f[..4].iter().map(|x| x.hp + x.banked).sum();
        assert_eq!(total, 620_000);
    }

    /// The security property the `steps`-as-an-argument fix bought, restated for the stepped design:
    /// how far the fight has got is a function of the clock and the lobby-frozen lineup, and nothing
    /// else. Nobody can reach a cursor by calling more often, or in bigger chunks.
    #[test]
    fn canonical_cursor_is_time_derived_and_capped() {
        let start = 1_700_000_000i64;
        assert_eq!(canonical_cursor(start, 4, start), 0);
        assert_eq!(canonical_cursor(start, 4, start + 1), 8);       // 4 fighters × 2 steps/s
        assert_eq!(canonical_cursor(start, 2, start + 10), 40);
        assert_eq!(canonical_cursor(start, 16, start + 10), 320);
        // Clock skew must never rewind the fight.
        assert_eq!(canonical_cursor(start, 4, start - 500), 0);
        // The MAX_STEPS ceiling holds for every lineup, however long the round is left unattended —
        // this is what bounds a single catch-up's compute cost.
        for n in 2..=MAX_FIGHTERS {
            assert_eq!(canonical_cursor(start, n, start + 86_400), MAX_STEPS);
        }
        // The bell is reachable before the ceiling for the biggest legal lineup, so the cap never
        // truncates a real fight.
        assert!(canonical_cursor(start, MAX_FIGHTERS, start + FIGHT_TIMEOUT_SECONDS) < MAX_STEPS);
    }

    #[test]
    fn fight_is_over_only_when_one_side_has_nobody_standing() {
        let mut f = four_fighters();
        assert!(!fight_is_over(&f, 4));

        f[2].dead = 1;
        assert!(!fight_is_over(&f, 4), "side 1 still has a fighter standing");

        f[3].dead = 1;
        assert!(fight_is_over(&f, 4), "side 1 has nobody left — nothing remains to play");

        // Extraction is the same signal: pull the last opponent out and the fight really is over.
        let mut g = four_fighters();
        g[2].dead = 1;
        g[3].hp = 0; g[3].dead = 1;         // extracted, not killed
        assert!(fight_is_over(&g, 4));

        // A one-sided lobby has no fight in it and must be settleable from the first instant, rather
        // than sitting until the bell.
        let mut one_sided = four_fighters();
        one_sided[2].side = 0;
        one_sided[3].side = 0;
        assert!(fight_is_over(&one_sided, 4));
    }

    /// THE BELL IS NOT BELT-AND-BRACES — there are real lineups whose fight can never end on its own,
    /// and without `FIGHT_TIMEOUT_SECONDS` they would be permanently unsettleable. This repo already
    /// has two permanently-stuck rounds from a different cause; the point of testing this is that
    /// "resolve requires the fight to be over" is a perfectly reasonable-sounding rule that would have
    /// added a third.
    ///
    /// The case here is one wallet holding BOTH sides, which `enter` explicitly allows (a repeat entry
    /// on the other side is a second fighter). No exchange is ever possible — `advance_fight` skips
    /// same-wallet pairs — so nobody ever dies, both sides always have someone standing, and
    /// `fight_is_over` stays false for the entire MAX_STEPS. Only the clock can end it.
    #[test]
    fn a_fight_that_can_never_end_is_still_settleable_when_the_bell_rings() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mut f = [Fighter::default(); MAX_FIGHTERS];
        f[0] = Fighter { wallet: pk(1), side: 0, dead: 0, stake: 100_000, hp: 100_000, banked: 0 };
        f[1] = Fighter { wallet: pk(1), side: 1, dead: 0, stake: 100_000, hp: 100_000, banked: 0 };

        advance_fight(&mut f, 2, &seed, 0, MAX_STEPS);
        assert_eq!(f[0].hp, 100_000, "a wallet must never be able to raid itself");
        assert!(!fight_is_over(&f, 2), "both sides still standing after the whole fight");

        // `resolve`'s guard, restated exactly as the instruction evaluates it.
        let start = 1_700_000_000i64;
        let settleable = |now: i64| fight_is_over(&f, 2) || (now - start).max(0) >= FIGHT_TIMEOUT_SECONDS;
        assert!(!settleable(start + FIGHT_TIMEOUT_SECONDS - 1), "not yet — this is what stops an early settle");
        assert!(settleable(start + FIGHT_TIMEOUT_SECONDS), "the bell must always end it");

        // And it settles to something well-defined rather than erroring: side A on the tie rule.
        assert_eq!(settle_sides(&f, 2), 0);
    }

    /// `resolve` runs whatever `tick` did not, so a round that nobody ticked and a round that was
    /// ticked every step must settle to the same thing. This is what makes ticking optional — and
    /// therefore what makes it impossible for an unticked round to become unsettleable.
    #[test]
    fn a_ticked_round_and_an_untouched_one_settle_identically() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);

        let mut untouched = four_fighters();
        advance_fight(&mut untouched, 4, &seed, 0, 120);

        let mut ticked = four_fighters();
        for cursor in 0..120u64 {
            advance_fight(&mut ticked, 4, &seed, cursor, 1);
        }

        assert_eq!(untouched, ticked);
        assert_eq!(settle_sides(&untouched, 4), settle_sides(&ticked, 4));
    }
}
