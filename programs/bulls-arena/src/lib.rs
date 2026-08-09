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

// v5 ADDRESS, and the reason is infrastructure, not code — for the FIFTH time, from the same cause.
//
// MagicBlock's ER validators clone a program's executable bytecode on first use and do not re-clone
// it after a base-layer upgrade (MAGICBLOCK_FEEDBACK.md). The cache is keyed by PROGRAM ID, so a
// fresh id has no stale clone anywhere and the first delegation pulls the current build. v1
// (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW), v2 (4uqVSyHtx7CBaXUL2qy7cN4eV3MzqmvucapGHN1imFYm),
// v3 (8s3x42af7gcNXDCTNheDtteQxeBS2D1p9xuU8C5Jgfrt) and v4
// (CchN3JPWta2uVxKhwScBQhtPG5gpsaRzf3RA4aPCDam2) are all still valid deployments of this same
// source, and every verification signature recorded against them stands.
//
// EVERY PRIOR ID IS WRITTEN DOWN HERE FOR A REASON THAT HAS NOW BEEN PAID FOR TWICE. The id appears
// in the IDL in TWO encodings — as a base58 `address` string, and as a 32-byte array under
// `delegate_round.buffer_round_pda.pda.program` — and a propagation that fixed only the string form
// left the byte array pinned to v4 while `declare_id!` said v5. Anything deriving that PDA through
// anchor's IDL resolver then computed a buffer address under the wrong program and the deployed
// program rejected it with `ConstraintSeeds`. It stayed latent only because the demo path derives
// the delegation PDAs through the ephemeral-rollups SDK instead. `scripts/idlgen.py` now rewrites
// pubkeys by VALUE in both encodings and refuses to emit an IDL containing any pubkey that is
// neither this program nor a named external one — see `EXTERNAL_PROGRAMS` there.
//
// v3's note recorded that this was MEASURED rather than inferred, by comparing clone LENGTHS — and
// then corrected itself, because length tracks the deploy's `--max-len` rather than the ELF inside
// it, so two different builds under the same max_len measure identically. The check that actually
// answers the question is comparing the clone's BYTES against the local artifact, and it now lives in
// `er-demo/scripts/erValidator.ts` (`pickValidator`), shared by every verification script.
//
// THIS SESSION'S DATA POINT, from that byte comparison: v3 was upgraded in place on the base layer
// (sig 3u7AtnMkqEF6dEHQBtQpuQ3zHdpZxNhwmMtmpJxCoRtdTa68KBpfQFUBuFNg4cr2wYLnJmrmrxHmVTUbDz1Xo6cM,
// 323,360 B against the previous 316,752 B) and all FOUR validators the router advertises
// (devnet-eu/-tee/-as/-us) reported STALE immediately afterward. Same result as v2's upgrade and v1's
// before it. The preflight cost one second and named the problem exactly, instead of a spent round
// and a confusing error about the code under test — which is the entire return on having written it.
declare_id!("CH7K8rDXgPQRs9CCHG9EK5kd1YSDZyPkCDGArcz4PSNP"); // devnet keypair: .devnet/program-keypair-v5.json

pub const ARENA_SEED: &[u8] = b"arena";
pub const ROUND_SEED: &[u8] = b"round";
/// The house's books, one account per arena — see `Treasury`.
///
/// A SEPARATE PDA RATHER THAN THREE MORE FIELDS ON `Arena`, and the reason is deployability. `Arena`
/// is already live: growing an `#[account]` struct makes every existing account of that type too
/// short to deserialise, so folding the running totals into `Arena` would have made this change
/// undeployable against any arena already in existence. A new PDA has no such problem — it does not
/// exist yet anywhere, so `init_treasury` is the whole migration.
///
/// It is also the shape the custody design already asked for. ARCHITECTURE-N-TEAM.md §4.2 puts the
/// entry fee in an "arena treasury ATA"; an ATA needs an owner, and a PDA that already means "this
/// arena's house account" is exactly that owner — it can sign the transfer out. Had this been three
/// fields on `Arena`, the arrival of real tokens would have needed a new account anyway.
pub const TREASURY_SEED: &[u8] = b"treasury";

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

/// THE MOST THE HOUSE MAY EVER CHARGE TO ENTER — 10%, checked by `init_arena` AND `set_fee_bps`.
///
/// Named rather than written out twice, and the difference is not cosmetic now that the rate is
/// mutable. `init_arena`'s bound was a typo guard on a number the deployer picked once and lived
/// with. `set_fee_bps` re-opens that decision to a live key at any moment, against players who may
/// already be in a lobby — so this constant is the entire answer to "how much can the house raise
/// the rake to", and the two guards being literally the same number is the thing that makes the
/// answer true. Written out twice, one of them drifts and the ceiling silently stops being a
/// ceiling.
///
/// It bounds ENTRY only. `EXTRACT_PENALTY_START_BPS` is a compile-time constant with no setter, so
/// the other house edge cannot be moved at all without a deploy.
pub const MAX_FEE_BPS: u16 = 1_000;

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

/// THE SHORTEST LOBBY THAT IS ACTUALLY ENTERABLE — the floor `open_round` clamps up to.
///
/// The deadline is stamped when `open_round` lands, but NOBODY CAN ENTER until `delegate_round` has
/// handed the account to the ER, and that hand-off is not instant: `er-demo/scripts/admin-open-round
/// .mjs` polls for the ownership change ten times at one-second intervals because it has been seen to
/// need several. So the window a player actually gets is the duration MINUS the delegation lag, and a
/// duration below that lag produces a lobby whose countdown has already expired by the time the first
/// `enter` is even routable. That is the "zero-length lobby nobody can enter" bug, and it is not
/// hypothetical here — it is the default outcome of picking the number the off-chain engine used.
///
/// 20s, matching the ONLINE off-chain engine (`web/index.html`: `w.lobbyMs || 20000`) — a lobby
/// length already proven to be enough for a human to see a round open and get into it. The 9s in
/// `engine/src/round.ts` is the LOCAL default, where the entrants are bots deployed by a timer with
/// no wallet, session key or router round-trip involved, so it is not the relevant precedent.
///
/// THIS WAS 30 (= 20 + a 10s delegation budget) AND THE 10 WAS WRONG. That figure came from
/// `admin-open-round.mjs` polling for the ownership change ten times at one-second intervals — but a
/// poll CEILING is not a measurement, it is the point at which the script gives up. Timed against
/// real devnet in this session, `delegate_round` confirmed in **1.70s and 1.87s**. Budgeting ten
/// seconds into every lobby on the strength of a retry limit was a worst case stacked on top of a
/// soft default, and it cost every round eight seconds of dead air that no player was ever using.
///
/// So the floor is the entry window itself, and the handoff comes out of it: a 20s lobby is ~18s
/// genuinely enterable, which is materially the length the off-chain engine shipped. If the handoff
/// ever regresses past a second or two the assertion in `the_lobby_duration_is_clamped_to_a_range_a_
/// round_can_actually_use` is what should be updated — with a new measurement, not a new guess.
///
/// The floor exists to make the degenerate value impossible, not to suggest a length; any real lobby
/// asks for more than this.
pub const MIN_LOBBY_SECONDS: u32 = 20;

/// THE CEILING. IT USED TO CATCH A UNIT MISTAKE; IT NOW BOUNDS AN OPEN-ENDED WAIT, and the change of
/// job is the whole reason the number moved from 3,600 to a week.
///
/// WHAT IT USED TO BE FOR, and why that argument no longer holds. The one realistic way to get a
/// multi-day lobby is passing MILLISECONDS to an instruction that takes seconds: every prior art in
/// this repo is named `*_MS` (`LOBBY_MS = 9_000`, `w.lobbyMs || 20000`), so `20_000` is exactly the
/// number a hand or a port would carry across, and unclamped that is a five-and-a-half hour lobby. An
/// hour was chosen to be far longer than any round this project runs while still being a length an
/// operator could have meant. That reasoning assumed the deadline was THE MECHANISM — the only thing
/// that ends a lobby — so a wrong duration meant a lobby stuck open for as long as the wrong number
/// said.
///
/// THE DEADLINE IS NO LONGER THE MECHANISM. `close_lobby_and_draw` now takes an authority-signed
/// early close, so the operator ends a lobby when a real player actually turns up. The deadline
/// becomes the BACKSTOP FOR "NOBODY EVER CAME": the thing that guarantees a round still reaches a
/// terminal state if the keeper dies, rather than the thing that decides when the fight starts.
///
/// A backstop wants to be long. The reason is rent, and it is the reason this change exists: nothing
/// ever closes a `Round` account, so every round permanently locks its rent-exempt deposit
/// (~0.0085 SOL). A keeper that cycles rounds on a timer therefore pays that on every cycle whether
/// or not anyone plays, and an idle arena bleeds indefinitely. Holding ONE lobby open until a player
/// arrives is one payment instead of hundreds — and the ceiling is what caps how long "until a player
/// arrives" may be. At one hour an unattended arena still burns 24 rounds a day (~0.2 SOL); at a week
/// it burns 52 a year (~0.45 SOL/year). That is the entire saving the feature is for, and an hour
/// gives back nearly all of it.
///
/// SO WHAT STILL CATCHES THE MILLISECONDS MISTAKE? Not this constant — 20_000 is now inside the
/// range and passes through unclamped, and pretending otherwise would be the dishonest version of
/// this comment. Two things replace it, and only the second is a real guard:
///
///   * THE CONSEQUENCE IS GONE, WHICH MATTERS MORE THAN THE DETECTION. A 5.5-hour lobby opened by
///     mistake is now closed by the authority the moment two fighters are in it, exactly like a
///     20-second one. The duration stopped being load-bearing, so getting it wrong stopped being
///     expensive. The mistake this guard existed to catch no longer has an outcome worth catching.
///   * THE ABSURD IS STILL BOUNDED. `u32::MAX` seconds is 136 years; a lobby that long is a round
///     delegated to an ER validator forever, which is the permanently-stuck state this repo has paid
///     for twice. A week is a length an operator could genuinely mean and a human will notice.
///
/// AND ONE THING THIS CONSTANT DOES NOT CLAIM, said plainly rather than left to be discovered: that a
/// round can actually STAY DELEGATED for a week. The round is delegated for its entire lobby, and the
/// longest delegation this repo has ever exercised is a couple of minutes. ER validators are already
/// documented as losing state in ways this project has been bitten by (MAGICBLOCK_FEEDBACK.md), and
/// nothing here has measured what a multi-day delegation does across a validator restart. The ceiling
/// permits a week; it is not evidence that a week works. Before an operator relies on a lobby held
/// open for days, that needs measuring — and if it does not hold, the fix is a keeper that reopens on
/// a long timer, not a bigger number here.
///
/// CLAMPED, NOT REJECTED, and the clamp is not silent: `lobby_closes_at - lobby_opened_at` is on the
/// account, so an operator who passed nonsense sees the stored value staring back at them the moment
/// they read the round. Rejecting would turn a fat-fingered argument into a failed transaction
/// mid-demo, and the value is a countdown, not a security parameter — nothing downstream is unsafe at
/// any value in this range.
pub const MAX_LOBBY_SECONDS: u32 = 604_800;   // 7 days

/// How long the lobby `open_round` is opening will actually stay open. `u32` on the way in because a
/// negative duration is not a thing an operator can mean, so it is not a state this program has to
/// have an opinion about; `i64` on the way out because it is about to be added to a unix timestamp.
pub fn clamp_lobby_seconds(requested: u32) -> i64 {
    requested.clamp(MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS) as i64
}

/// BOTH ENDS OF THE LOBBY, from the chain's clock and the operator's requested duration. This is the
/// whole of what `open_round` writes, and it lives here rather than inline in the instruction for one
/// reason: inline, the clamp is unreachable from a native test, and "the stored window is always
/// within [MIN, MAX]" — the property `Round.lobby_opened_at`'s doc comment promises anyone can check
/// — would be a claim rather than something `the_stored_lobby_window_is_always_within_the_clamp`
/// actually runs. Dropping `clamp_lobby_seconds` from an inline version passes every other test.
pub fn lobby_window(now: i64, requested: u32) -> (i64, i64) {
    // `saturating_add` rather than `checked_*` + an error: the addend is at most an hour, so the only
    // way this overflows is a clock sysvar reporting a timestamp within an hour of `i64::MAX`, which
    // is not a condition a round can do anything useful about.
    (now, now.saturating_add(clamp_lobby_seconds(requested)))
}

/// IS THERE A FIGHT IN THIS LOBBY? One fighter is not a fight — nobody to exchange with, and
/// `advance_fight` returns immediately below `n = 2`.
///
/// It exists as a function, rather than as `>= 2` written wherever it is needed, because two
/// instructions must agree on it EXACTLY or a round falls between them: `close_lobby_and_draw`
/// refuses without it and `abandon_round` requires its negation, so the two are exhaustive only while
/// they mean the same thing by "enough". Written out twice, someone later raising the bar to two per
/// SIDE closes the draw without opening the abandon — and a two-fighter lobby past its deadline would
/// have no legal instruction at all, which is the permanently-stuck round this whole path exists to
/// prevent. Named once, that mistake is impossible instead of merely unlikely.
pub fn enough_to_fight(fighter_count: u16) -> bool {
    fighter_count >= 2
}

/// THE ONE DEFINITION OF "THE DEADLINE HAS NOT PASSED". Three instructions and the whole UI turn on
/// this comparison, and the failure mode of writing it out three times is not a compile error — it is
/// a one-second window in which entries are refused AND the draw is refused (or, worse, both are
/// allowed), from a `<` that should have been `<=`.
///
/// Phrasing `lobby_may_close` and `lobby_is_dead` in terms of this makes the windows complements BY
/// CONSTRUCTION, so there is nothing left for a test to check about how they fit together — a test
/// that "asserted the tiling" would be asserting `x != !x`. What is NOT structural is which side of
/// the boundary the deadline second itself falls on, and that is pinned by concrete values in
/// `the_deadline_second_belongs_to_the_draw_not_to_entries`.
pub fn lobby_is_open(lobby_closes_at: i64, now: i64) -> bool {
    now < lobby_closes_at
}

/// May the lobby be closed and the seed drawn?
///
/// The deadline is the normal answer. THE SECOND CLAUSE IS A DELIBERATE EARLY EXIT: once
/// `fighter_count == MAX_FIGHTERS`, `enter` rejects every further entry with `RoundFull`, so waiting
/// out the rest of the countdown cannot change the lineup by a single fighter — it can only add dead
/// air to a round that is, as far as anyone watching is concerned, already assembled.
///
/// It hands nobody any power, which is the only reason it is safe to add. Closing early does not
/// influence the seed (the VRF oracle produces it after this call, and nothing the caller supplies
/// reaches it), and it cannot exclude an entrant, because a full lobby already excludes everyone —
/// `enter` rejects on `RoundFull` before it reaches the top-up branch, so the LINEUP AND THE POT are
/// both already frozen at sixteen whether this clause exists or not. That is the whole argument, and
/// it does not rest on filling a lobby being expensive: `enter` requires only `stake > 0` and one
/// wallet may hold both sides, so eight wallets can fill a round with dust for transaction fees. All
/// such a griefer buys is choosing which SECOND the fight starts, and no quantity in this program is
/// a function of that — the pace, the penalty horizon and the bell are all measured from
/// `fight_started_at` itself.
pub fn lobby_may_close(fighter_count: u16, lobby_closes_at: i64, now: i64) -> bool {
    !lobby_is_open(lobby_closes_at, now) || (fighter_count as usize) >= MAX_FIGHTERS
}

/// MAY `close_lobby_and_draw` PROCEED? The permissionless rule above, OR the arena's authority asking
/// for it directly.
///
/// WHY AN EARLY CLOSE HAS TO EXIST. The operator wants to stop paying rent on rounds nobody plays,
/// and nothing ever closes a `Round` account — every one permanently locks its rent-exempt deposit
/// (see `MAX_LOBBY_SECONDS`). The fix is to open ONE lobby, let the house sit in it, and hold it open
/// until a real player turns up. That plan needs exactly one thing the program did not have: a way to
/// start the fight AT THE MOMENT the player arrives. Under `lobby_may_close` alone the keeper could
/// watch someone enter and still be unable to begin, because the deadline had not passed and the
/// lobby was not full — the lobby would sit there with a live player in it, waiting out a clock whose
/// only remaining purpose was to be waited out.
///
/// WHY IT IS AUTHORITY-ONLY, which is the question a reader should have. Permissionless early closing
/// is griefing: a player who does not like the lineup slams the lobby shut and locks everyone else
/// out, and unlike `tick` or `resolve` — permissionless because the caller cannot influence the
/// result — WHO IS IN THE ROUND is exactly the thing an early close decides. That is a caller
/// choosing something, which is the class of power `resolve`'s `steps` argument was removed for.
///
/// IT IS NOT A NEW TRUST ASSUMPTION. The authority already decides when a lobby OPENS (`open_round`
/// is `has_one = authority`), so it already controls the other end of the same window; being able to
/// close it is the same power pointed the other way. And it cannot reach the OUTCOME: the VRF seed is
/// requested by this very instruction and delivered afterwards by `callback_seed`, so at the instant
/// the authority chooses to close, the seed does not exist — not for them, not for anyone. Closing
/// early moves WHEN the fight starts and nothing else, which is the same conclusion `lobby_may_close`
/// already reached for its full-lobby early exit.
///
/// WHAT IT DELIBERATELY DOES NOT DO is let the authority close a lobby that is not a fight. The
/// caller still has to satisfy `enough_to_fight` separately — this predicate answers only "has the
/// waiting requirement been met", never "is there a round here". Folding the two together is what
/// would let an operator draw on a single fighter.
///
/// THE PERMISSIONLESS PATH IS UNTOUCHED, and that is structural rather than a promise: this is a
/// disjunction over `lobby_may_close`, so with `by_authority == false` it IS `lobby_may_close`. That
/// also keeps `lobby_may_close` and `lobby_is_dead` exact complements — the partition
/// `an_under_subscribed_lobby_is_dead_exactly_when_it_can_no_longer_fight` asserts is a property of
/// those two, and adding the authority term here rather than inside `lobby_may_close` is what stops
/// this change from quietly making a round both drawable and abandonable.
pub fn draw_is_permitted(fighter_count: u16, lobby_closes_at: i64, now: i64, by_authority: bool) -> bool {
    by_authority || lobby_may_close(fighter_count, lobby_closes_at, now)
}

/// Was an early close asked for by the arena's own authority, and did they sign with the right key?
///
/// Three outcomes, not two, and the third is the one worth having: no `authority` account supplied
/// means an ordinary permissionless call (`false`, the deadline rule applies); the arena's authority
/// means yes; ANY OTHER signer is an error rather than a silent `false`. Falling through would answer
/// a misconfigured keeper with `LobbyStillOpen` — a message about the clock, when the actual problem
/// is the key — and this program already treats "tell them the true reason" as worth a branch (see
/// `enter` checking `RoundFull` before the deadline).
///
/// Takes the pubkey rather than the `Signer`, so the rule is reachable from a native test. That is
/// not incidental: the whole security of the early close is this comparison, and inside a `Context`
/// nothing could execute it without a validator — which is precisely how the discarded entry fee
/// survived review for the life of this program.
pub fn authority_close_requested(supplied: Option<Pubkey>, arena_authority: Pubkey) -> Result<bool> {
    match supplied {
        None => Ok(false),
        Some(key) if key == arena_authority => Ok(true),
        Some(_) => Err(ArenaError::NotTheAuthority.into()),
    }
}

/// THE DEAD LOBBY: past its deadline holding fewer than two fighters, so it can never become a fight.
///
/// This is a terminal state, not a slow one. `enter` refuses past the deadline — which is what makes
/// the countdown mean what it says — so `fighter_count` can never rise again, and
/// `close_lobby_and_draw`'s `>= 2` guard (which one fighter cannot satisfy, and a fight of one is not
/// a fight) can never be satisfied either. Without a way out, such a round would sit in `Lobby`
/// forever: this repo has already paid for two permanently-stuck rounds and the whole design of
/// `FIGHT_TIMEOUT_SECONDS` is the promise not to add a third. `abandon_round` is that way out.
///
/// It is derivable from the account by anyone, in exactly this form, which is what lets the UI say
/// "this lobby expired without a fight" instead of showing a dead countdown at 0:00 forever.
///
/// The `!enough_to_fight` is the SAME predicate `close_lobby_and_draw` requires — see that function
/// for why it is named rather than written out, which is what makes these two exits exhaustive rather
/// than merely adjacent.
pub fn lobby_is_dead(fighter_count: u16, lobby_closes_at: i64, now: i64) -> bool {
    !lobby_is_open(lobby_closes_at, now) && !enough_to_fight(fighter_count)
}

/// WHAT PULLING OUT COSTS AT THE OPENING BELL — and it decays to nothing by the end of the fight.
///
/// THE BUG THIS CLOSES. Making the fight advance on-chain gave `extract` real teeth late in a round,
/// but it left the OPENING free: at cursor 1 of a 236-step fight you have taken essentially no damage,
/// so extracting returned ~99% of the stake. "Enter, let one tick land, leave" was therefore close to
/// optimal — a near-riskless option on the round, priced at nothing. That is not a decision, and the
/// decision is the entire reason this game is on a rollup. A free option also inverts what the
/// mechanic is FOR: `extract` is supposed to be the choice to stop risking what you hold, and a choice
/// with no cost is not a choice.
///
/// SO THE PENALTY IS AN OPTION PREMIUM, AND IT DECAYS BECAUSE THE OPTION DOES. What a player gives up
/// by leaving is the rest of the fight; at the opening bell that is the whole fight, and by the end it
/// is nothing at all. Charging a FLAT rate — the first thing tried on paper — gets this exactly
/// backwards at the far end: a fighter who has stood in the ring for the entire round, taken every
/// blow the seed had for them, and pressed the button one step before the bell would pay the same 20%
/// as the tourist who never took a hit. That taxes nerve, which is the behaviour the round is trying
/// to buy. Decaying to zero means holding on is rewarded twice over: you keep whatever you defended,
/// and it costs you nothing to bank it.
///
/// 20% AT THE START, chosen against what it has to beat. Riding the round out is, before variance, a
/// break-even proposition (the house's cut is taken at `enter`, 20 bps), so the instant-bail strategy
/// has to be made strictly worse than that to stop being dominant — and a rate small enough to shrug
/// off (5%) would leave "bail immediately" merely slightly worse rather than clearly worse. 20% is
/// also within the band a player can read off a screen and reason about in the two seconds this
/// decision actually gets. It is deliberately NOT tied to `Arena.fee_bps`: that is the deploy fee on
/// every stake, this is the price of one optional action, and coupling them would mean re-pricing the
/// game every time the house re-prices entry.
///
/// WHERE IT GOES: the house, recorded in `Round.penalties_collected` — see that field. Not the pot
/// (which would pay the penalty straight back to the opponents who were about to raid you, and hand
/// a wallet holding both sides a way to launder it), and not burned (this program moves no value; a
/// burn on-chain would be a fiction the off-chain ledger could not honour).
pub const EXTRACT_PENALTY_START_BPS: u64 = 2_000;

/// HOW LONG THE PENALTY TAKES TO REACH ZERO, per lineup, IN STEPS.
///
/// AGAINST THE CURSOR, NOT THE WALL CLOCK — and the two are not interchangeable even though
/// `canonical_cursor` is linear in elapsed time. Three reasons, in order of how much they matter:
///
///   * The penalty must be RECOMPUTABLE FROM WHAT IS STORED. `tick_count` is on the account and in
///     the `Extracted` event; the block time of the transaction that extracted is in neither. Against
///     the clock, a sceptic checking a settled round could not re-derive the rate a player was charged
///     without going and finding the transaction. Against the cursor they can do it from the event
///     alone, which is the standard the rest of this round already meets.
///   * The cursor is what actually happened to the player. Elapsed time is a proxy for it, and stops
///     being one at `MAX_STEPS`, where the cursor saturates and the clock keeps running: a
///     clock-based penalty would keep falling through a stretch of round in which the fight, by
///     definition, is no longer moving.
///   * It is the same quantity every other payout path is a function of (`catch_up`, `resolve`), so
///     there is one definition of "how far along are we" rather than two that agree by coincidence.
///
/// THE HORIZON IS PER-LINEUP BECAUSE A FIGHT'S LENGTH IS. This is the same problem
/// `STEPS_PER_FIGHTER_PER_SECOND` solves for pacing, and it does not solve it here: per-fighter pacing
/// divides an ~n^1.5 fight length by n, which leaves ~n^0.5 — so at the rate this round actually runs,
/// the median duel lasts 19.5 SECONDS and the median sixteen-way lasts 54.4. A flat horizon in seconds
/// (i.e. a horizon linear in n) therefore misses by ~3x at the ends: pick 45s and a duel spends its
/// entire life in the first third of the decay curve, never getting below a 12% rate — nerve
/// unrewarded, in the most common lineup this demo runs. A flat horizon in STEPS is worse still (26x),
/// and the two obvious "free" horizons are both far too long for the same reason: `MAX_STEPS` (4,000)
/// leaves a duel paying 19.6% at its natural end, and the bell
/// (`FIGHT_TIMEOUT_SECONDS × steps_per_second`) leaves it paying 17.1%.
///
/// MEASURED, this session, the same way the pacing table was — `engine/src/er-sim.ts`, equal stakes,
/// 400 seeds per lineup size, counting steps until one side has nobody standing. Fitting `C × n^1.5`:
///
/// ```text
/// lineup shape          | C = median steps / n^1.5   min .. max   median of C
/// ----------------------+---------------------------------------------------
/// balanced (alternating)|                           24.2 .. 30.1         27.2
/// random sides          |                           21.2 .. 25.8         23.5
/// ```
///
/// The wobble in the balanced row is even/odd and is an artifact of the measurement, not the game:
/// alternating sides makes every ODD lineup structurally one fighter short on one side, and a short
/// side gets wiped sooner. Random side assignment removes the wobble entirely and shifts C down,
/// because an unbalanced book finishes faster. Real lobbies are matched but not perfectly, so the
/// truth is between the rows: **C = 25**, tabulated below.
///
/// ERRING SHORT IS THE SAFE DIRECTION, which is why C=25 sits under the balanced median rather than
/// on it. Too LONG and the penalty never reaches zero inside a real fight — the design goal fails
/// outright. Too SHORT and the last stretch of a long fight is free, which is where the curve was
/// heading anyway; by then the player has already taken the damage the penalty exists to make them
/// risk, and banking hp they could equally have left in the ring (settlement counts `hp + banked`
/// alike) buys them nothing. One failure mode breaks the mechanic; the other lands on its intended
/// endpoint slightly early.
///
/// A TABLE RATHER THAN THE FORMULA, because `n` has fifteen legal values and `n^1.5` does not exist in
/// integer arithmetic. The alternative is an integer square root, written out FOUR times — here and in
/// each TypeScript mirror — to compute fifteen numbers that were never going to change. This repo has
/// already been bitten twice by exactly that shape of duplication (the DUST floor, and `bench_fight`
/// drifting from `run_fight`), and a table has the additional property that a player can read their
/// own lineup's horizon straight off it. `parity_tests::the_typescript_mirrors_carry_the_same_penalty_curve`
/// parses both mirrors and compares them to this array, so the copies cannot drift in silence.
const PENALTY_HORIZON_STEPS: [u16; MAX_FIGHTERS - 1] = [
    /* n= 2 */    71, /* n= 3 */   130, /* n= 4 */   200, /* n= 5 */   280,
    /* n= 6 */   367, /* n= 7 */   463, /* n= 8 */   566, /* n= 9 */   675,
    /* n=10 */   791, /* n=11 */   912, /* n=12 */ 1_039, /* n=13 */ 1_172,
    /* n=14 */ 1_310, /* n=15 */ 1_452, /* n=16 */ 1_600,
];

/// The fight's pace for a given lineup — see `STEPS_PER_FIGHTER_PER_SECOND` for the measurements.
pub fn steps_per_second(fighter_count: usize) -> u64 {
    (fighter_count as u64).saturating_mul(STEPS_PER_FIGHTER_PER_SECOND)
}

/// The cursor at which extracting becomes free, for a lineup of `fighter_count` — see
/// `PENALTY_HORIZON_STEPS` for the measurement behind the table.
///
/// The clamp is not defensive padding: `fighter_count` is a `u16` field on an account, and a lineup
/// below 2 cannot reach `Phase::Fight` at all, so the only thing the clamp really does is make the
/// divisor in `extract_penalty_bps` structurally non-zero instead of non-zero-by-argument.
pub fn penalty_horizon_steps(fighter_count: usize) -> u64 {
    PENALTY_HORIZON_STEPS[fighter_count.clamp(2, MAX_FIGHTERS) - 2] as u64
}

/// The penalty rate, in basis points, for extracting at `cursor`. Linear from
/// `EXTRACT_PENALTY_START_BPS` down to zero across `penalty_horizon_steps`, and zero from there on.
pub fn extract_penalty_bps(fighter_count: usize, cursor: u64) -> u64 {
    let horizon = penalty_horizon_steps(fighter_count);
    let remaining = horizon.saturating_sub(cursor);
    EXTRACT_PENALTY_START_BPS.saturating_mul(remaining) / horizon
}

/// Split what a fighter pulls out of the ring into what they KEEP and what the house takes.
///
/// `u128` for the one multiply, rather than this file's usual `checked_mul` — not a style break but
/// the stronger form of the same idea. `taken × 2_000` genuinely can exceed `u64` for a large enough
/// stake, and the choice is between an error path that a caller can do nothing useful with and simply
/// widening the intermediate so the overflow cannot exist. The result is bounded by
/// `taken × 2_000 / 10_000`, i.e. a fifth of `taken`, so the narrowing back to `u64` is exact and the
/// subtraction cannot go negative — both facts are asserted, not just argued, in
/// `parity_tests::the_penalty_can_never_exceed_what_was_taken`.
pub fn split_extraction(taken: u64, fighter_count: usize, cursor: u64) -> (u64, u64) {
    let bps = extract_penalty_bps(fighter_count, cursor) as u128;
    let penalty = (taken as u128 * bps / BPS as u128) as u64;
    (taken - penalty, penalty)
}

/// Split a GROSS stake into what reaches the ring and what the house takes at the door. The entry
/// half of `split_extraction`, and deliberately the same shape: one function, one rounding rule,
/// asserted rather than argued.
///
/// `u128` for the multiply for the same reason `split_extraction` uses it, and it is a FIX here
/// rather than a matching flourish. This arithmetic used to be `stake.checked_mul(fee_bps)? / BPS`
/// inline in `enter`, which returns `MathOverflow` for any stake above `u64::MAX / fee_bps` —
/// refusing an entry over an intermediate that never needed to be 64 bits. Widening the intermediate
/// makes the overflow not exist instead of reporting it, and the result is bounded by
/// `stake × 1_000 / 10_000`, a tenth of `stake`, so narrowing back is exact and `stake - fee` cannot
/// go negative. Both facts are asserted in `the_entry_fee_can_never_exceed_the_ceiling`.
///
/// Floors, so the house rounds DOWN and the player rounds up. That direction is the safe one: a
/// fee that rounded up could exceed the published rate on small stakes, and "the house never takes
/// more than `fee_bps`" is a statement worth being able to make without a caveat.
pub fn split_entry(stake: u64, fee_bps: u64) -> (u64, u64) {
    let fee = (stake as u128 * fee_bps as u128 / BPS as u128) as u64;
    (stake - fee, fee)
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

/// WHO SWINGS AT WHOM this step: an attacker, and a defender who is never the attacker.
///
/// It reads `h[0..8]` and returns a pair that is uniform over all `n * (n - 1)` ORDERED pairs of
/// distinct slots. Requires `n >= 2`; `advance_fight` is the only caller and returns before this on
/// `n < 2`, which is what makes the `n - 1` divisor safe.
///
/// WHY IT IS A FUNCTION AND NOT TWO LINES INLINE. It used to be two lines inline, and they were
/// wrong:
///
/// ```text
/// let mut d = u32::from_le_bytes(h[4..8]) % n;
/// if d == a { d = (d + 1) % n; }          // <- measured, and biased
/// ```
///
/// Re-rolling a collision onto `a + 1` is not a re-draw, it is a gift to one specific slot. Slot
/// `a + 1` absorbs every bumped draw, so it is targeted `2/n` of the time against `1/n` for
/// everyone else; and slot `a` collects a bonus VALID attack whenever that bump happens to land
/// cross-side. Whether it lands cross-side depends entirely on how the two sides are laid out
/// across the array — which is to say, on WHICH TRANSACTION CONFIRMED FIRST.
///
/// Measured on the TypeScript mirror, 4,000 seeds, eight fighters all staking exactly $10, so that
/// nothing but slot index distinguishes them (`sandbox/house-edge/check-positional-bias.ts`):
///
/// ```text
/// arrival order        result
/// 0,0,0,0,1,1,1,1      slots 3 and 7 earn +15.1% and +15.0%; every other slot -5%;
/// (each side a block)  slots 0 and 4 die 90.6% of the time against 64% for the rest
/// 0,1,0,1,0,1,0,1      flat — every slot within +-0.8%
/// ```
///
/// About 11 sigma against Monte-Carlo error. Teams arriving in waves is the LIKELY production
/// layout, not the exotic one, so this was a live +15%/-5% tax on entry order.
///
/// THE FIX IS TO DRAW FROM THE RIGHT SET IN THE FIRST PLACE. There are `n - 1` fighters who are not
/// the attacker; draw a rank in `0..n-1` and shift it past `a`. Every non-attacker gets exactly one
/// rank, so each is picked with probability `1/(n-1)` whatever `a` is and wherever the sides sit —
/// and because `a` itself is uniform, every ordered pair is equally likely. No retry loop to prove
/// terminating, no second hash byte consumed, and `h[0..9]` still drives the whole step, so the
/// hash-byte layout documented for this program is unchanged.
///
/// Modulo bias is unchanged in kind and negligible in size: a 32-bit draw reduced mod at most 15
/// skews a slot's share by under 2^-28.
fn draw_pair(h: &[u8; 32], n: usize) -> (usize, usize) {
    let a = (u32::from_le_bytes([h[0], h[1], h[2], h[3]]) as usize) % n;
    // A rank among the n-1 fighters who are NOT the attacker, then shifted past the attacker's slot.
    let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % (n - 1);
    if d >= a { d += 1; }
    (a, d)
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
///
/// # Damage is a percentage of the SMALLER ring — you cannot take more than you brought
///
/// `basis = min(ring_attacker, ring_defender)`. This one line replaced `basis = ring_defender`, and
/// the reason is the largest economics defect this program has shipped.
///
/// Under the old rule the fractional LOSS was symmetric — every ring decayed at `roll%` per hit —
/// but the GAIN was an absolute amount fixed entirely by the defender, credited to an attacker drawn
/// uniformly. So every seat collected at the same rate in dollars while paying at the same rate in
/// percent. Run to the bell that has a closed form, and it was measured and verified to 0.3% mean
/// error (`HOUSE-EDGE-STUDY.md` §0, `sandbox/house-edge/check-seat-law.ts`):
///
/// ```text
/// payout_i  ~=  (total stake on the OPPOSING side) / (number of seats on MY side)
/// ```
///
/// A fighter's own deposit does not appear. It enters only as the denominator of ROI. Deposits
/// bought nothing; SEATS bought everything. Measured over 4,000 rounds of eight fighters: a whale
/// returned -52.5% +- 0.36 per round and a minnow +660.9% +- 6.30. Worse, it was farmable by anyone
/// with no capital and no latency edge — an $80 budget split across eight wallets earned about $152
/// per round more than the same $80 entered as one fighter.
///
/// Reading the smaller of the two rings restores the shape the ORIGINAL physics sim already had
/// (`sqrt(ring_a * ring_b)`: damage set by both parties, not one) at a fraction of the compute, and
/// states a rule a player can be told in one sentence. Measured after: whale -0.31% +- 0.27, minnow
/// +0.51% +- 0.57 — size-neutral inside the noise — and the eight-wallet split is worth $0.30 per
/// round, which is indistinguishable from zero.
///
/// WHY `min` AND NOT THE BLEND. The study offered a dial,
/// `basis = (P*ring_d + (BPS - P)*min(ring_a, ring_d)) / BPS`, with `P = 0` reproducing this line.
/// Two reasons it is not here. First, every `P > 0` sells back exactly the exploit being closed, in
/// proportion to `P` — at `P = 100` bps the eight-wallet farm is worth $8/round again. Second, that
/// expression cannot be evaluated in `u64`: `BPS * ring` overflows above a ring of `u64::MAX/10_000`,
/// so an honest port needs `u128`, and a `u128` multiply-and-divide on BPF is far dearer than the
/// study's "+6 to +20 CU/step" estimate, which was made against BigInt arithmetic that cannot
/// overflow. `min` needs no multiply, no divide and no widening: one load and one compare. If a
/// deliberate tilt toward small stakes is ever wanted, take it from `fee_bps` — which is already
/// implemented, already bounded by `MAX_FEE_BPS`, settable without a deploy, and immune to splitting.
///
/// THE DUST CLAUSE HAD TO SPLIT IN TWO, and this is the subtle half. It used to read
/// `if hp_d <= DUST || dmg == 0 { dmg = hp_d; }` — one branch serving one purpose, because under a
/// defender-only basis `dmg == 0` could ONLY mean "the defender has almost nothing left"
/// (`dmg == 0` implies `hp_d <= 24`, which is far below `DUST`). Under a basis that reads the
/// attacker, `dmg == 0` acquires a second meaning — "the ATTACKER has almost nothing left" — and the
/// old branch would then hand that exhausted attacker the defender's ENTIRE ring. It is not
/// hypothetical: `enter` requires only `stake > 0`, so a 3-unit entry (a third of a millionth of a
/// dollar) one-shots any fighter it is drawn against, and the study's recommended code block has
/// this bug. Verified against the sandbox before it was written out, and asserted below by
/// `an_exhausted_attacker_cannot_annihilate_a_healthy_defender`.
///
/// So: dust-finishing keys on the DEFENDER'S ring, and a blow that rounds to nothing simply moves
/// nothing. Termination still holds. A fighter's ring only falls when they defend, `hp <= DUST`
/// kills them the next time they are drawn as defender, and a blow between two fighters both above
/// `DUST` always registers — `min > DUST` gives `dmg >= DUST*4/100 = 40`. A gnat below the floor can
/// waste its own steps, but it dies the first time it is targeted.
///
/// `dmg` can never exceed `hp_d`, so no clamp is needed and none is paid for: `basis <= hp_d` and
/// `roll <= 27` give `dmg <= 0.27*hp_d`; and in the one case where `saturating_mul` clips, it clips
/// to `u64::MAX/100`, which is smaller still than the `basis > u64::MAX/27` that provoked it. So
/// `saturating_sub` below never truncates — it can reach exactly zero and no further — and
/// conservation is exact per blow rather than approximately so.
///
/// WHERE THE MIRRORS STOP BEING BYTE-IDENTICAL, stated because "byte-identical" is this project's
/// core fairness claim and an unqualified claim would be false. `saturating_mul` clips; the
/// TypeScript mirrors use BigInt, which does not. The first input on which they disagree is
/// `min(ring_a, ring_d) = 683_212_743_470_724_138` at `roll = 27` — Rust yields
/// `184_467_440_737_095_516`, TypeScript `...517`. That needs BOTH fighters holding ~6.8e17 units,
/// i.e. ~$683 billion each at `UNITS_PER_USD = 1e6`. Representable in `u64`, unreachable in this
/// game. The class is older than this change and this change SHRANK it: the bound used to be on the
/// defender's ring alone, and is now on the smaller of the two.
///
/// THE ONE RESIDUAL STAKE-INDEPENDENT TRANSFER is the dust finish, and its size is worth naming
/// rather than leaving implicit. Every other exchange is symmetric — `P(i attacks j)` equals
/// `P(j attacks i)` after the `draw_pair` fix, and `min` is symmetric in the pair — so each
/// fighter's expected net flow per step is exactly zero whatever they staked. The dust branch is the
/// exception: a 3-unit attacker finishing a 1,000-unit defender collects 1,000. It is bounded by
/// `DUST` per death, and a fighter can cross below `DUST` only once, so the whole-round exposure is
/// at most `MAX_FIGHTERS * DUST = 16_000` units — about $0.016. That is the entire surviving
/// remnant of a mechanism that used to move 660% of a minnow's stake per round.
pub fn advance_fight(fighters: &mut [Fighter; MAX_FIGHTERS], n: usize, seed: &[u8; 32], cursor: u64, steps: u64) {
    if n < 2 { return; }        // mirrors `if (n < 2) break;` in er-sim.ts; unreachable in Fight phase
    for step in cursor..cursor.saturating_add(steps) {
        let h = hashv(&[seed.as_ref(), step.to_le_bytes().as_ref()]).to_bytes();
        let (a, d) = draw_pair(&h, n);

        if fighters[a].side == fighters[d].side { continue; }
        if fighters[a].wallet == fighters[d].wallet { continue; }
        if fighters[a].dead == 1 || fighters[d].dead == 1 { continue; }

        let roll = (h[8] as u64) % 24 + 4;
        let basis = fighters[a].hp.min(fighters[d].hp);
        let mut dmg = basis.saturating_mul(roll) / 100;
        // Finish off a defender already down to dust. This is the TERMINATION rule and it is
        // load-bearing — see DUST. It keys on the DEFENDER'S ring and on nothing else.
        if fighters[d].hp <= DUST { dmg = fighters[d].hp; }
        // A blow too small to register moves nothing. It is NOT a kill; see `draw_pair`'s sibling
        // note below on why those two had to stop sharing a branch.
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

/// EVERYTHING `enter` WRITES, once its guards have passed: the fee off the top, the fighter credited
/// or topped up, the pot, and the house's take. Returns `(net, fee)` for the event.
///
/// It is a function for the same reason `lobby_window` is one — inline, none of it is reachable from
/// a native test, and "the fee is recorded" would be a claim rather than something
/// `the_fee_is_recorded_rather_than_discarded` actually runs. That is not a hypothetical standard
/// here: the fee being computed and then dropped is the bug this function exists because of, and it
/// survived because nothing could execute this arithmetic without a validator.
///
/// The caller has already checked the phase, the side, the deadline and `stake > 0`, so the failures
/// left in here are arithmetic — every add is checked, because `pot`, `hp` and `fees_collected` are
/// all cumulative over an unbounded number of top-ups — and a full lobby.
///
/// `RoundFull` IS RE-CHECKED HERE EVEN THOUGH `enter` ALREADY REFUSED, and it is not defensive
/// padding. `enter` checks it early on purpose, so a player arriving at a full lobby is told the
/// lobby is FULL rather than that they were too slow — that ordering is a message, not a guard, and
/// it belongs where it is. But the write below indexes `fighters` by a count, and a helper that
/// PANICS on an unguarded call is a hazard the moment it has a second caller. `get_mut` turns the
/// only unbounded index in this program into a total function for one comparison the bounds check
/// was already paying for.
fn credit_entry(r: &mut Round, who: Pubkey, side: u8, stake: u64, fee_bps: u64) -> Result<(u64, u64)> {
    let (net, fee) = split_entry(stake, fee_bps);

    let n = r.fighter_count as usize;   // read the count BEFORE borrowing fighters mutably
    if let Some(f) = r.fighters[..n]
        .iter_mut()
        .find(|f| f.wallet == who && f.side == side)
    {
        f.stake = f.stake.checked_add(net).ok_or(ArenaError::MathOverflow)?;
        f.hp = f.hp.checked_add(net).ok_or(ArenaError::MathOverflow)?;
    } else {
        let slot = r.fighters.get_mut(n).ok_or(ArenaError::RoundFull)?;
        *slot = Fighter { wallet: who, side, stake: net, hp: net, banked: 0, dead: 0 };
        r.fighter_count += 1;
    }
    r.pot = r.pot.checked_add(net).ok_or(ArenaError::MathOverflow)?;
    // The house's cut, RECORDED rather than merely subtracted — the same discipline `extract`
    // already applies to the penalty. See `Round.fees_collected`.
    r.fees_collected = r.fees_collected.checked_add(fee).ok_or(ArenaError::MathOverflow)?;
    Ok((net, fee))
}

/// EVERYTHING `sweep_house_take` WRITES — the guards that make a permissionless sweep safe, the flag
/// that makes it once-only, and the two additions. Returns what this round contributed.
///
/// Hoisted out of the instruction for the same reason as `credit_entry`: the properties that matter
/// here are "it cannot be run twice" and "it cannot be run before the numbers stop moving", and
/// neither is checkable from a native test while they live inside a `Context`. `the_sweep_cannot_be_
/// double_claimed` and `an_unfinished_round_cannot_be_swept` run this exact function.
///
/// The flag is set BEFORE the additions, not after. It makes no difference to correctness — a failed
/// instruction reverts every write — but it puts the guard and the thing it guards adjacent, so
/// there is no version of this function where an early return lands between them.
fn apply_sweep(r: &mut Round, t: &mut Treasury) -> Result<(u64, u64)> {
    require!(
        r.phase == Phase::Settled as u8 || r.phase == Phase::Abandoned as u8,
        ArenaError::RoundNotTerminal
    );
    require!(!r.house_swept, ArenaError::AlreadySwept);
    r.house_swept = true;

    let (fees, penalties) = (r.fees_collected, r.penalties_collected);
    t.fees_accrued = t.fees_accrued.checked_add(fees).ok_or(ArenaError::MathOverflow)?;
    t.penalties_accrued = t.penalties_accrued.checked_add(penalties).ok_or(ArenaError::MathOverflow)?;
    t.rounds_swept = t.rounds_swept.checked_add(1).ok_or(ArenaError::MathOverflow)?;
    Ok((fees, penalties))
}

#[ephemeral]
#[program]
pub mod bulls_arena {
    use super::*;

    /// One-time arena config. Base layer; never delegated — everything reads it.
    pub fn init_arena(ctx: Context<InitArena>, fee_bps: u16, token_a: Pubkey, token_b: Pubkey) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ArenaError::FeeTooHigh); // a ceiling, not a judgement on the rate
        let a = &mut ctx.accounts.arena;
        a.authority = ctx.accounts.authority.key();
        a.fee_bps = fee_bps;
        a.token_a = token_a;
        a.token_b = token_b;
        a.round_counter = 0;
        a.bump = ctx.bumps.arena;
        Ok(())
    }

    /// RE-PRICE ENTRY. Authority only, same 10% ceiling `init_arena` applies.
    ///
    /// WHY IT HAS TO EXIST: `fee_bps` was written once at `init_arena` and never again, so moving
    /// 20 bps to 100 bps meant standing up a WHOLE NEW ARENA — new PDA, new round counter, every
    /// round of history stranded behind the old one — to change one `u16`. That is not a re-pricing
    /// mechanism, it is a migration, and it made the rate effectively immutable for the life of a
    /// deployment. A number the operator is expected to tune should not be welded to an account's
    /// birth.
    ///
    /// THE CEILING IS THE SAME CHECK, NOT A SECOND ONE, and that matters more here than at
    /// `init_arena`. An init-time bound is a typo guard on a value the deployer chose deliberately;
    /// this is a bound on a value that can be changed at any moment, by a live key, against players
    /// who are mid-lobby. `MAX_FEE_BPS` is what makes "the house can raise the rake"
    /// a bounded statement rather than an open one — the worst an authority (or a stolen authority
    /// key) can do is 10%, and it is 10% on ENTRY only, since nothing else in the round reads this.
    /// `EXTRACT_PENALTY_START_BPS` is deliberately a constant and stays out of reach entirely.
    ///
    /// WHAT IT DOES NOT DO: freeze the rate for a round already in progress. `enter` reads
    /// `arena.fee_bps` live, so a change that lands mid-lobby charges later entrants a different
    /// rate from earlier ones in the same round, and nothing on the round records which rate applied
    /// to whom. Two things bound that, and they are worth stating rather than leaving to be found:
    ///   * The round is still self-describing IN AGGREGATE — `fees_collected / (pot +
    ///     fees_collected)` is the rate the round ACTUALLY charged, which is stronger evidence than
    ///     a stored nominal rate would be — and `Entered` carries the exact gross and fee per entry,
    ///     so the per-wallet rate is recoverable from the log even across a mid-lobby change.
    ///   * The operational rule is simply to re-price between rounds. `FeeBpsChanged` is emitted so
    ///     that when it was changed is a matter of record and not of recollection.
    ///
    /// The structural fix is to stamp the rate onto the round at `open_round`, and it belongs with
    /// the work that already does exactly that: ARCHITECTURE-N-TEAM.md §4.2 freezes the price feed
    /// onto the round at open, and `enter` moves to the base layer in the same change. The fee
    /// should be frozen in that same pass, alongside the prices, by the same argument. Doing it here
    /// instead would cost `Round` two bytes and change `Enter`'s account list for a hazard that is
    /// operational today and disappears entirely when that work lands.
    pub fn set_fee_bps(ctx: Context<SetFeeBps>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, ArenaError::FeeTooHigh);
        let a = &mut ctx.accounts.arena;
        let previous = a.fee_bps;
        a.fee_bps = fee_bps;
        emit!(FeeBpsChanged { arena: a.key(), previous, current: fee_bps });
        Ok(())
    }

    /// Open a round, publish the (now vestigial) seed commitment BEFORE anyone can enter, and STAMP
    /// THE DEADLINE the lobby closes at.
    ///
    /// The commitment's ordering is the whole point: a commitment published after entries are known
    /// proves nothing. Kept for format compatibility even though the real seed now comes from the VRF
    /// oracle via `close_lobby_and_draw`/`callback_seed`, not from a value the operator chose here.
    ///
    /// `lobby_seconds` is a DURATION, not an absolute deadline, and that is the whole reason the
    /// countdown can be trusted. An absolute `lobby_closes_at` supplied by the caller would be a
    /// number relative to the caller's own clock, written into an account that everything else reads
    /// against the chain's — so the operator's laptop being 40 seconds fast would silently shorten
    /// every lobby, and nobody reading the round could tell. Taking a duration means the chain stamps
    /// both ends itself and the only clock involved is the one the guards use.
    pub fn open_round(ctx: Context<OpenRound>, round_no: u64, seed_commit: [u8; 32], lobby_seconds: u32) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
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
        r.penalties_collected = 0;
        r.fees_collected = 0;
        r.house_swept = false;
        r.fighter_count = 0;
        r.tick_count = 0;
        (r.lobby_opened_at, r.lobby_closes_at) = lobby_window(now, lobby_seconds);
        r.fight_started_at = 0;   // meaningful only from callback_seed onward
        r.bump = ctx.bumps.round;

        arena.round_counter = round_no;
        emit!(RoundOpened {
            round_no,
            seed_commit,
            lobby_opened_at: r.lobby_opened_at,
            lobby_closes_at: r.lobby_closes_at,
        });
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
    /// THE FEE IS NOW RECORDED, AND UNTIL THIS SESSION IT WAS NOT. It was computed, subtracted from
    /// the player, and dropped on the floor when the local went out of scope — every round, for the
    /// whole life of this program. See `Round.fees_collected` for why that happened (there was no
    /// account a rollup transaction could legally write it to) and what the identity looks like now
    /// that it is on the books.
    ///
    /// `Entered` carries the GROSS stake and the fee, because this instruction is the only place
    /// either number ever exists. `Round` stores the fee only in aggregate and each fighter's
    /// `stake` net, so without the event the fee a PARTICULAR wallet paid is unrecoverable from
    /// chain state — and separating house-bot fees from player fees is the whole of the question
    /// "what does the fee actually earn". `Extracted` publishes `amount`/`penalty` for exactly the
    /// same reason.
    ///
    /// THE DEADLINE IS ENFORCED HERE, not only at the draw, and that is what makes the countdown on
    /// screen honest rather than advisory. If entries were still accepted past `lobby_closes_at` — as
    /// they would be if only `close_lobby_and_draw` checked it — then "entries close in 0:07" would
    /// mean "the operator MAY close in 0:07", the button would keep working after zero, and the
    /// number would be back to describing an intention instead of a rule. It also fixes the lineup at
    /// a knowable instant: `fighter_count` stops moving at the deadline, and the fight's pace and
    /// penalty horizon are both functions of it.
    ///
    /// The cost of saying it here is one `Clock::get()` on the round's hottest instruction, which is
    /// a sysvar read of a value the runtime already has — the same call `tick`, `extract` and
    /// `resolve` each already make.
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
        let now = Clock::get()?.unix_timestamp;
        let r = &mut ctx.accounts.round;
        require!(r.phase == Phase::Lobby as u8, ArenaError::NotInLobby);
        require!(side == 0 || side == 1, ArenaError::BadSide);
        require!(stake > 0, ArenaError::ZeroStake);
        // Checked separately from the deadline, and before it, so a player who arrives at a full
        // lobby is told the lobby is FULL rather than that they were too slow — two different things
        // to be told, and only one of them is worth waiting for the next round over.
        require!((r.fighter_count as usize) < MAX_FIGHTERS, ArenaError::RoundFull);
        require!(lobby_is_open(r.lobby_closes_at, now), ArenaError::LobbyClosed);

        // One entry per wallet per side — a repeat tops up rather than spawning a second fighter,
        // mirroring the engine, where a duplicate id merges into the existing entry.
        let who = ctx.accounts.player.key();
        let (_net, fee) = credit_entry(r, who, side, stake, arena_fee)?;

        emit!(Entered { round_no: r.round_no, player: who, side, stake, fee });
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
    /// IT IS NOT FREE, AND IT IS CHEAPEST LAST. What leaves the ring is split: the fighter keeps most
    /// of it, the house takes `extract_penalty_bps(fighter_count, cursor)` — 20% at the opening bell,
    /// decaying linearly to nothing by the time the fight would normally be over. See
    /// `EXTRACT_PENALTY_START_BPS` for why the penalty exists at all (without it, "enter, let one tick
    /// land, leave" was a near-riskless option priced at nothing) and `PENALTY_HORIZON_STEPS` for why
    /// it decays against the CURSOR and over a per-lineup horizon.
    ///
    /// NO EXEMPTIONS, INCLUDING THE LAST FIGHTER STANDING — and that is a decision, not an omission.
    /// The tempting special case is "don't charge someone whose opponents are all gone, they aren't
    /// escaping any risk". It is unnecessary, because such a player is not being made to pay anything:
    /// once `fight_is_over`, nothing can touch their `hp` again, and `settle_sides` counts `hp` and
    /// `banked` identically — so standing still until `resolve` gives them the same value for free,
    /// and extracting is simply a button they have no reason to press. Adding the exemption would
    /// instead create a reason to ENGINEER that state (a wallet holding both sides can retire one to
    /// make the other's exit free), and would make the rate un-derivable from the cursor alone, which
    /// is the property that lets anyone re-check the penalty from the `Extracted` event.
    ///
    /// The penalty ROUNDING TO ZERO is likewise left alone. Integer division floors, so a fighter with
    /// a small enough remainder late enough in the fight pays nothing at all. That is the curve
    /// arriving where it was always going, one step early, on an amount too small for the difference
    /// to be worth a branch.
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
        // Read AFTER `catch_up`, so this is the cursor the fight has genuinely reached — the same
        // number the payout itself is computed at, and the one the event publishes so anyone can
        // re-derive the rate that was charged.
        let cursor = r.tick_count;
        let f = r.fighters[..n]
            .iter_mut()
            .find(|f| f.wallet == who && f.dead == 0 && f.hp > 0)
            .ok_or(ArenaError::NothingToExtract)?;

        // Value MOVES: out of the ring, and then in two directions — most of it to the fighter's own
        // bank (already safe from raids), a decaying slice of it out of the round entirely, to the
        // house. That is the whole risk/reward decision: give up the chance to take more, pay for the
        // privilege of being certain, and pay less the longer you were willing to stand there.
        let taken = f.hp;
        let (kept, penalty) = split_extraction(taken, n, cursor);
        f.banked = f.banked.checked_add(kept).ok_or(ArenaError::MathOverflow)?;
        f.hp = 0;
        f.dead = 1;                     // out of the ring — no longer a valid target

        // The leak, recorded rather than merely subtracted — this is the term that keeps conservation
        // provable now that a round can legitimately end holding less than its pot. See the field.
        r.penalties_collected = r.penalties_collected.checked_add(penalty).ok_or(ArenaError::MathOverflow)?;

        emit!(Extracted { round_no: r.round_no, player: who, amount: taken, penalty, cursor });
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
    ///
    /// IT NOW REFUSES BEFORE THE DEADLINE (or before the lobby is full — see `lobby_may_close`). The
    /// operator used to decide when a lobby ended, which made the end of a lobby an intention rather
    /// than a fact, and left the countdown a client wants to draw as a guess about that intention.
    /// With this guard the countdown is the rule: the transaction that ends the lobby cannot land
    /// early, so `lobby_closes_at` is the earliest instant a fight can possibly begin, verifiable by
    /// anyone against the account.
    ///
    /// THE `>= 2` GUARD BELOW IS NOW LOAD-BEARING RATHER THAN A FORMALITY. Before the deadline, an
    /// under-subscribed lobby could simply be left open until it filled. It cannot now — `enter`
    /// refuses past the deadline — so a lobby that reaches it holding fewer than two fighters is
    /// finished, and this instruction is the thing that must never pretend otherwise. `abandon_round`
    /// is where such a round goes; see `lobby_is_dead`.
    pub fn close_lobby_and_draw(ctx: Context<DrawSeed>, client_seed: [u8; 32]) -> Result<()> {
        {
            let now = Clock::get()?.unix_timestamp;
            // Resolved BEFORE the round is borrowed mutably, and it is the whole of the new
            // permission: see `authority_close_requested` for why a wrong key errors here rather than
            // falling through to the deadline rule.
            let by_authority = authority_close_requested(
                ctx.accounts.authority.as_ref().map(|s| s.key()),
                ctx.accounts.arena.authority,
            )?;
            let r = &mut ctx.accounts.round;
            require!(r.phase == Phase::Lobby as u8, ArenaError::NotInLobby);
            require!(
                draw_is_permitted(r.fighter_count, r.lobby_closes_at, now, by_authority),
                ArenaError::LobbyStillOpen
            );
            require!(enough_to_fight(r.fighter_count), ArenaError::NotEnoughFighters);
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

    /// THE WAY OUT FOR A LOBBY THAT DIED UNDER-SUBSCRIBED — the deadline's other half.
    ///
    /// Adding a deadline created a state that could not previously exist: a round past
    /// `lobby_closes_at` holding fewer than two fighters. It can never fight (`enter` refuses past the
    /// deadline, so `fighter_count` cannot rise, and `close_lobby_and_draw` needs two), so without
    /// this it would sit in `Lobby` forever — delegated to an ER validator, counted by every history
    /// query, showing a countdown that expired and never resolved into anything. This repo has two
    /// permanently-stuck rounds in its history already and treats "a round can always reach a terminal
    /// state" as a promise (see `FIGHT_TIMEOUT_SECONDS`); a deadline without this instruction would
    /// have quietly broken that promise for the one case it introduced.
    ///
    /// EXTENDING THE DEADLINE WAS THE OTHER OPTION, AND IT IS THE WRONG ONE. A lobby that reopens
    /// itself when nobody shows up is a countdown that can be moved, which is exactly the "invented
    /// number" this whole change exists to delete — a clock a client cannot trust to mean what it says
    /// is worse than no clock. `Abandoned` says the true thing plainly, and the UI can say it too.
    ///
    /// PERMISSIONLESS, for the same reason `tick` and `resolve` are: every precondition is chain
    /// truth (the phase, the deadline, the frozen count) and nothing about the outcome is chosen by
    /// the caller. A round whose operator has walked away must not need that operator to come back.
    ///
    /// WHAT THIS DOES NOT COVER, said plainly rather than left to be discovered: `Phase::Drawing`
    /// still has no exit. `close_lobby_and_draw` moves a round there and then depends on the VRF
    /// oracle to call `callback_seed`, which only the VRF program may call — so if the callback never
    /// lands (queue down, callback transaction fails, validator restart between request and delivery)
    /// the round sits in `Drawing` forever with no instruction any signer can send. That hole
    /// PREDATES the lobby deadline and this change narrows rather than widens the way in (reaching
    /// `Drawing` now requires the deadline as well as two fighters), so closing it is separate work,
    /// not a regression to fix here. The shape of the fix, for whoever picks it up: stamp the moment
    /// the draw was requested — `fight_started_at` is 0 until `callback_seed` overwrites it and is
    /// read nowhere outside `Phase::Fight`, so it costs no account bytes — and let `abandon_round`
    /// also accept a `Drawing` round whose oracle has been silent for longer than a measured timeout.
    /// An abandoned `Drawing` round is the same terminal state for the same reason: no seed, no
    /// fight, no winner, nothing custodied. A late callback then fails harmlessly on its own
    /// `Phase::Drawing` guard.
    ///
    /// NOTHING IS REFUNDED, BECAUSE NOTHING WAS TAKEN. This program custodies no balances at all (see
    /// the file header) — `enter` records a stake, it does not move one — so an abandoned round owes
    /// nobody anything on-chain. Any single fighter who entered is recorded in `fighters` exactly as
    /// they were, for the off-chain ledger to settle to zero against, and their `stake`/`hp` are
    /// untouched so the round still reads as what it was.
    ///
    /// ONE INSTRUCTION WHERE SETTLEMENT TAKES TWO (`resolve` then `close_round`). That split exists so
    /// a settled round's result is committed to the base layer while players are still watching it in
    /// the rollup, and undelegated separately afterwards. An abandoned round has no result to publish
    /// and nobody watching, so there is nothing to do between the two halves: it commits and
    /// undelegates in one call, and the keeper's recovery path is a single transaction.
    pub fn abandon_round(ctx: Context<Resolve>) -> Result<()> {
        {
            let now = Clock::get()?.unix_timestamp;
            let r = &mut ctx.accounts.round;
            require!(r.phase == Phase::Lobby as u8, ArenaError::NotInLobby);
            require!(
                lobby_is_dead(r.fighter_count, r.lobby_closes_at, now),
                ArenaError::LobbyNotAbandonable
            );
            r.phase = Phase::Abandoned as u8;
            emit!(RoundAbandoned { round_no: r.round_no, fighter_count: r.fighter_count });
        }

        // Same reason as `resolve`: Anchor serialises on return, the commit reads account info DURING
        // the instruction, so without this the committed bytes still say `Lobby`.
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

    /// Open the house's books for this arena. Authority only, once.
    ///
    /// SEPARATE FROM `init_arena` RATHER THAN FOLDED INTO IT, and the reason is that an arena
    /// already exists. Folding this in would have made the running totals reachable only by a
    /// deployment that also creates a fresh arena — which is to say, only by abandoning the round
    /// history keyed to the current one. As its own instruction, an arena that predates the whole
    /// idea of a treasury gains one with a single transaction and nothing else changes.
    ///
    /// The cost of the split is that it can be FORGOTTEN, and `sweep_house_take` then fails on a
    /// missing account until someone runs it. That is a loud, recoverable, one-transaction failure
    /// on a keeper path — the right shape of failure to trade for not stranding history.
    pub fn init_treasury(ctx: Context<InitTreasury>) -> Result<()> {
        let t = &mut ctx.accounts.treasury;
        t.arena = ctx.accounts.arena.key();
        t.fees_accrued = 0;
        t.penalties_accrued = 0;
        t.rounds_swept = 0;
        t.bump = ctx.bumps.treasury;
        Ok(())
    }

    /// SWEEP — move a finished round's house take onto the arena's running total.
    ///
    /// THIS IS THE STEP THAT MAKES THE HOUSE'S REVENUE A NUMBER RATHER THAN A PILE OF ROUNDS. Both
    /// house takes are recorded per-round, in the rollup, because that is the only account a rollup
    /// transaction can write (see `Round.fees_collected`). Per-round is where they have to be
    /// COLLECTED and it is a useless place to READ them: "what has the house made" would mean
    /// fetching every round account ever opened and adding them up, forever, and the answer would
    /// silently change meaning the first time a round account was closed for rent.
    ///
    /// WHY IT CANNOT RUN ANY EARLIER. The round is delegated for its entire playable life, which
    /// means its base-layer account is owned by the Delegation Program — and `Account<'info, Round>`
    /// checks owner before anything else, so a delegated round cannot even be deserialised here.
    /// That is not a guard someone remembered to write; it is the account model refusing. Only after
    /// `close_round` (or `abandon_round`) commits and undelegates does this instruction become
    /// callable at all.
    ///
    /// PERMISSIONLESS, on exactly the argument `tick`, `resolve` and `abandon_round` already make:
    /// every precondition is chain truth (the phase, the swept flag) and NOTHING about the outcome
    /// is chosen by the caller. The amounts come off the round, and the destination is derived from
    /// seeds rather than supplied — `treasury` is `[TREASURY_SEED, arena]` with `has_one = arena`,
    /// so there is no account a caller could pass that would send this anywhere else. That property
    /// is what lets it stay permissionless when it starts moving real tokens: ARCHITECTURE-N-TEAM.md
    /// §4.5 requires that no step of the money path depend on the operator showing up, and a sweep
    /// only the authority could call would be the first one that did.
    ///
    /// THE PHASE GUARD IS LOAD-BEARING AND IS NOT A FORMALITY. `open_round` runs before
    /// `delegate_round`, so there is a window in which a brand-new round sits on the base layer,
    /// undelegated, in `Lobby`, with `fees_collected == 0`. Without the guard, any passer-by could
    /// sweep it in that window, take nothing, set `house_swept`, and permanently forfeit every fee
    /// that round went on to collect. Permissionless plus a mutable flag needs the flag to only ever
    /// be settable once the underlying number can no longer move — and `Settled`/`Abandoned` are
    /// exactly the phases where it cannot.
    ///
    /// DOUBLE-CLAIM IS STOPPED BY A FLAG ON THE ROUND, and the alternative is worth recording
    /// because it looked better. A watermark on the treasury (`sweep round n only if n == swept + 1`,
    /// mirroring `open_round`'s `RoundOutOfOrder`) costs zero bytes and proves the total is COMPLETE
    /// rather than merely a subset. It was rejected on liveness: one round that can never be swept
    /// — the `Phase::Drawing` hole `abandon_round` documents has no exit, so such a round never
    /// undelegates — would block every later round's fees forever. A per-round flag makes one stuck
    /// round cost exactly one stuck round. `Treasury.rounds_swept` recovers most of what the
    /// watermark offered: a count that can be held against the arena's `round_counter`.
    ///
    /// WHICH HALF OF THIS SURVIVES CUSTODY, said plainly so the next person does not have to guess:
    ///   * THE STOPGAP is the fee half. Today the program moves no value at all (see the file
    ///     header), so `fees_accrued` is a ledger the off-chain treasury is paid against. Under
    ///     §4.2 `enter` moves to the base layer and transfers the fee to the arena's treasury ATA in
    ///     the same instruction that charges it — at which point the fee never touches `Round` and
    ///     this half of the sweep has nothing left to do. `fees_accrued` then becomes a mirror of a
    ///     balance rather than a claim on one.
    ///   * THE PART THAT SURVIVES is the penalty half, and the account this all writes to. Penalties
    ///     are charged mid-fight, INSIDE the rollup, where the treasury ATA is unreachable by
    ///     construction — so they must keep accruing on the round and being swept afterwards. §4.2
    ///     names that instruction `sweep_penalties()`; this is it, one phase early. When custody
    ///     lands, the body gains a token transfer out of the round's escrow and this same PDA is the
    ///     ATA's owner, signing with `[TREASURY_SEED, arena, bump]`. The guards, the phase check,
    ///     the flag, the permissionlessness and the seeds are all unchanged by that; only the
    ///     increment becomes a transfer.
    pub fn sweep_house_take(ctx: Context<SweepHouseTake>, _round_no: u64) -> Result<()> {
        let round_no = ctx.accounts.round.round_no;
        let (fees, penalties) = apply_sweep(&mut ctx.accounts.round, &mut ctx.accounts.treasury)?;
        let t = &ctx.accounts.treasury;
        emit!(HouseSwept {
            round_no,
            fees,
            penalties,
            fees_accrued: t.fees_accrued,
            penalties_accrued: t.penalties_accrued,
        });
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
    /// Has `sweep_house_take` already taken this round's `fees_collected + penalties_collected` onto
    /// the arena's `Treasury`? One bit, so a permissionless sweep cannot be run twice.
    ///
    /// ON THE ROUND RATHER THAN INFERRED, because there is nothing to infer it from: the sweep moves
    /// no value out of the round (the totals stay for auditing — zeroing them would destroy the very
    /// record conservation is checked against), so after a sweep the account is byte-identical to
    /// before it except for this flag. Without it the second call is indistinguishable from the
    /// first and the house's total inflates by one round every time anyone presses the button.
    pub house_swept: bool,
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
impl Round {
    // 8 discriminator + 32 arena + 8 round_no + 1 phase + 1 winner + 1 bump + 2 count
    // + 8 ticks + 8 pot + 8 penalties_collected + 8 fees_collected + 1 house_swept
    // + 32 commit + 32 seed + 8 lobby_opened_at + 8 lobby_closes_at + 8 fight_started_at + fighters
    //
    // 1,102 bytes, up from 1,093. The house's books cost nine of them — eight for `fees_collected`
    // and one for `house_swept` — i.e. 62,640 more lamports of rent-exempt deposit per round
    // (9 × 6,960 = 0.00006 SOL). Worth stating because this program's payer is a rate-limited
    // faucet, and worth keeping in proportion: at 20 bps a single 1 SOL entry pays that back
    // thirty times over, and it was previously paying it to nobody.
    //
    // NINE RATHER THAN THE EIGHT A NEW `u64` COSTS. The ninth is the double-claim guard, and the
    // alternatives that cost zero bytes were both worse: a sweep watermark on the treasury couples
    // every later round's fees to one round that can never be swept (see `sweep_house_take`), and a
    // sixth `Phase` would have to be duplicated for the abandoned branch and would break every
    // client that reads `phase == 3` as "settled, forever".
    //
    // Checked rather than recited: `the_account_is_exactly_the_size_its_layout_needs` borsh-encodes a
    // real `Round` and asserts the length, so a field added without touching this line fails a native
    // test instead of failing on devnet as a serialisation error nobody can read.
    pub const SIZE: usize = 8 + 32 + 8 + 1 + 1 + 1 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 32 + 8 + 8 + 8 + (58 * MAX_FIGHTERS);
}

/// THE HOUSE'S BOOKS FOR ONE ARENA — where a finished round's take goes to be added up.
///
/// `Round.fees_collected` and `Round.penalties_collected` are where the house's money is COLLECTED,
/// because a rollup transaction can write nothing else. They are a poor place to read it from: the
/// answer to "what has this arena made" would be a scan of every round account ever opened, which
/// gets slower forever and stops being answerable at all the first time a settled round is closed
/// for its rent. This account is that answer, in one fetch, and `sweep_house_take` is the only thing
/// that writes it.
///
/// THE TWO SOURCES ARE KEPT APART ON PURPOSE. They are not the same kind of money and they do not
/// have the same future. `fees_accrued` is a rate the house SETS, charged on every entry; under
/// ARCHITECTURE-N-TEAM.md §4.2 it stops passing through here at all, because a base-layer `enter`
/// transfers it straight to the treasury ATA. `penalties_accrued` is a behavioural charge on a
/// decision players MAKE mid-fight, it can only ever be collected inside the rollup, and it will
/// still be swept exactly like this when tokens are real. Summed into one field they would be
/// indistinguishable the moment anyone asked which half was which — and the first question anyone
/// asks of a revenue number is where it came from.
///
/// `rounds_swept` is the completeness check. The sweep is per-round and independent (see
/// `sweep_house_take` for why it is not a watermark), so nothing structurally guarantees the totals
/// cover every round — but `rounds_swept` against `Arena.round_counter` says how many are missing,
/// in one subtraction, without fetching anything.
///
/// WHAT IT BECOMES: the owner of the arena's treasury ATA. §4.2's "arena treasury ATA" needs an
/// authority that can sign transfers out, and `[TREASURY_SEED, arena]` is already exactly the thing
/// that means "this arena's house account". The fields here then read as the ledger against that
/// balance rather than in place of it.
#[account]
pub struct Treasury {
    pub arena: Pubkey,
    /// Sum of `Round.fees_collected` over every swept round — the entry fee, cumulative.
    pub fees_accrued: u64,
    /// Sum of `Round.penalties_collected` over every swept round — early-exit penalties, cumulative.
    pub penalties_accrued: u64,
    /// How many rounds have been swept into the two totals above. Hold it against
    /// `Arena.round_counter` to see how many finished rounds are still unswept.
    pub rounds_swept: u64,
    pub bump: u8,
}
impl Treasury { pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 1; }

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

/// `has_one = authority` is the whole authorization, and it is the same one `OpenRound` uses. The
/// arena stores its authority; only that key may re-price entry.
#[derive(Accounts)]
pub struct SetFeeBps<'info> {
    #[account(mut, seeds = [ARENA_SEED], bump = arena.bump, has_one = authority)]
    pub arena: Account<'info, Arena>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(seeds = [ARENA_SEED], bump = arena.bump, has_one = authority)]
    pub arena: Account<'info, Arena>,
    #[account(init, payer = authority, space = Treasury::SIZE,
              seeds = [TREASURY_SEED, arena.key().as_ref()], bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// NO SIGNER FIELD BEYOND THE FEE PAYER, and no authority anywhere in it — see `sweep_house_take`
/// for the argument. What makes that safe is entirely structural and lives in these constraints:
///
///   * `round` is pinned by its seeds to `round_no` under THIS arena, and `has_one = arena` ties it
///     to the arena the treasury also belongs to. A round of some other arena cannot be swept into
///     this one's books.
///   * `treasury` is pinned by its seeds to that same arena, with `has_one = arena` again. THE
///     DESTINATION IS DERIVED, NOT SUPPLIED — there is no account a caller can pass that would send
///     the sweep anywhere else, which is the property that has to hold when this instruction starts
///     moving tokens rather than incrementing a counter.
///   * `round` being an `Account<'info, Round>` is itself a guard: a delegated round is owned by the
///     Delegation Program, so it fails the owner check before any of this is reached.
///
/// `Box`ED, AND THIS IS THE FOURTH-KNOWN-BY-NAME APPEARANCE OF THE SAME 4 KB STACK. `Account<'info,
/// T>` deserialises onto the stack inside the generated `try_accounts`, and this is the first context
/// in the program to name THREE of them at once. `cargo build-sbf` on the unboxed version:
///
/// ```text
/// Error: Function ...SweepHouseTake as anchor_lang::Accounts...::try_accounts overflows the maximum
/// allowed frame space by accessing an offset 128 bytes greater than the maximum of 4096.
/// Estimated function frame size: 4224 bytes.
/// ```
///
/// 128 bytes over. `Round` is 1,192 B on the stack (measured in
/// `the_account_is_exactly_the_size_its_layout_needs`) and anchor materialises it more than once
/// across deserialise-and-move, so a context holding it alongside two others has no headroom left.
/// Boxing moves the deserialised `Round` to the heap and the frame drops under the ceiling.
///
/// SHIPPING IT UNBOXED WOULD NOT HAVE FAILED THE BUILD — `build-sbf` prints this and exits 0. It
/// would have failed on devnet, as "Access violation reading 8 bytes at address 0x18": a message
/// that names neither the stack nor the size, and which cost this repo a full debugging session at
/// `MAX_FIGHTERS = 40` (see that constant). Checking the build output is the only reason this was
/// caught here rather than there.
#[derive(Accounts)]
#[instruction(round_no: u64)]
pub struct SweepHouseTake<'info> {
    #[account(seeds = [ARENA_SEED], bump = arena.bump)]
    pub arena: Account<'info, Arena>,
    #[account(mut, has_one = arena,
              seeds = [ROUND_SEED, arena.key().as_ref(), &round_no.to_le_bytes()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, has_one = arena,
              seeds = [TREASURY_SEED, arena.key().as_ref()], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
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
///
/// `arena` IS READ HERE, IN THE ROLLUP, AND THAT IS ALREADY PROVEN RATHER THAN ASSUMED. This
/// instruction runs in the ER (the round is delegated from lobby open) and `Arena` is a base-layer
/// account that is never delegated — but `enter` has read `arena.fee_bps` from exactly this position
/// since the migration, so a rollup transaction taking an undelegated account read-only is a path
/// this program already exercises every round. It is needed for one field: `arena.authority`, which
/// is the only place the early-close permission is written down.
///
/// `authority` IS OPTIONAL, AND ITS ABSENCE IS THE ORDINARY CASE. Supplying it is a statement of
/// intent — "I am deliberately cutting this lobby short" — which is why it is a separate account
/// rather than an inference from who paid. `payer` is already a `Signer` and comparing IT against
/// `arena.authority` would have worked with no new accounts at all; it was rejected because an
/// instruction that behaves differently depending on who happened to fund it is a privilege you can
/// acquire by accident, and because the transaction would no longer say on its face which of the two
/// close rules was used. Read back from an explorer, `close_lobby_and_draw` carrying an `authority`
/// means the operator chose the moment; without one it means the clock did.
///
/// `has_one = arena` on the round rather than trusting the singleton: `ARENA_SEED` has no
/// discriminator so there is exactly one arena per program and the seeds already pin it, which makes
/// this constraint redundant TODAY. It is here because "there is only one arena" is a fact about the
/// current seeds, not an invariant anything enforces, and the failure it would allow — closing a
/// round against some other arena's authority — is the one thing this context exists to prevent.
///
/// `round` IS NOT BOXED, AND THAT WAS MEASURED RATHER THAN ASSUMED. `SweepHouseTake` had to be, so
/// the tempting move is to box every context holding a `Round`. Adding a second `Account<'info, T>`
/// here was checked against `cargo build-sbf` and produces no `Stack offset ... exceeded` — so a box
/// would be weight carried for a failure that does not exist. If a future field on `Round` changes
/// that, the build says so; the guard is reading that output, not boxing pre-emptively. See
/// `SweepHouseTake` for what the failure looks like and why it must never be shipped unnoticed.
#[vrf]
#[derive(Accounts)]
pub struct DrawSeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [ARENA_SEED], bump = arena.bump)]
    pub arena: Account<'info, Arena>,
    #[account(mut, has_one = arena)]
    pub round: Account<'info, Round>,
    /// CHECK: validated against the known queues by the VRF program
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
    pub authority: Option<Signer<'info>>,
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

/// Carries the deadline as well as the commitment, so a listener that never fetches the account can
/// still draw the same countdown — the log is the one place a client learns a round exists at all.
#[event] pub struct RoundOpened { pub round_no: u64, pub seed_commit: [u8; 32], pub lobby_opened_at: i64, pub lobby_closes_at: i64 }
/// A lobby that reached its deadline without enough fighters to hold a fight — see `abandon_round`.
/// `fighter_count` is included because it is the whole story: 0 means nobody came, 1 means one wallet
/// was left standing alone, and neither is a fight.
#[event] pub struct RoundAbandoned { pub round_no: u64, pub fighter_count: u16 }
#[event] pub struct SeedRevealed { pub round_no: u64, pub seed: [u8; 32] }
#[event] pub struct RoundSettled { pub round_no: u64, pub winner: u8, pub pot: u64 }
/// `steps` is how many this call actually ran (0 when the fight was already up to date), `cursor` is
/// where the fight now stands.
#[event] pub struct Ticked { pub round_no: u64, pub cursor: u64, pub steps: u32 }
/// `amount` is GROSS — everything that left the ring. Of that, `penalty` went to the house and the
/// rest (`amount - penalty`) was added to the fighter's `banked`; a client showing "you banked X,
/// penalty Y" wants exactly that subtraction. `cursor` is where the fight stood when the button
/// landed, which is what makes the rate checkable from this event alone: it must equal
/// `extract_penalty_bps(fighter_count, cursor)`, and `fighter_count` was frozen at lobby close.
#[event] pub struct Extracted { pub round_no: u64, pub player: Pubkey, pub amount: u64, pub penalty: u64, pub cursor: u64 }
/// `stake` is GROSS — what the player was charged. `fee` is the house's cut of it, and the fighter
/// was credited `stake - fee`; a client showing "you staked X, fee Y" wants exactly that
/// subtraction, the same shape `Extracted` already publishes for the penalty.
///
/// THIS IS THE ONLY PLACE EITHER NUMBER SURVIVES. `Round` stores each fighter's stake NET and the
/// fee only in aggregate (`fees_collected`), so without this event neither the gross a particular
/// wallet paid nor the fee it paid is recoverable from chain state at all. That matters for one
/// question in particular: with house wallets entering every round, most of `fees_collected` can be
/// the house paying itself, and telling real revenue from circular revenue needs the fee attributed
/// per wallet. It also makes a single charge checkable against the published rate — `fee` must equal
/// `stake × Arena.fee_bps / 10_000` at the rate in force when this landed.
#[event] pub struct Entered { pub round_no: u64, pub player: Pubkey, pub side: u8, pub stake: u64, pub fee: u64 }
/// A round's house take moved onto the arena's books. `fees`/`penalties` are what THIS round
/// contributed; `fees_accrued`/`penalties_accrued` are the arena's running totals after it, so a
/// listener that never fetches the `Treasury` account still has the current position. Emitted once
/// per round and never again — `Round.house_swept` makes a second one impossible.
#[event] pub struct HouseSwept { pub round_no: u64, pub fees: u64, pub penalties: u64, pub fees_accrued: u64, pub penalties_accrued: u64 }
/// Entry was re-priced. Both ends, because "the fee is now 100 bps" is only half a fact — what an
/// auditor reconciling a round against a rate needs is which rate stopped applying and when.
#[event] pub struct FeeBpsChanged { pub arena: Pubkey, pub previous: u16, pub current: u16 }

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
    // Appended, so every error above keeps the code a deployed client may already be matching on.
    #[msg("the lobby deadline has passed — this round is no longer taking entries")] LobbyClosed,
    #[msg("the lobby deadline has not passed and the round is not full")] LobbyStillOpen,
    #[msg("this lobby can still become a fight — it may not be abandoned")] LobbyNotAbandonable,
    #[msg("this round has not finished — its house take cannot be swept yet")] RoundNotTerminal,
    #[msg("this round's house take has already been swept")] AlreadySwept,
    #[msg("only the arena's authority may close a lobby before its deadline")] NotTheAuthority,
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
        //
        // These numbers MOVED when the defender draw stopped favouring slot `a + 1` and the damage
        // basis became `min(ring_a, ring_d)`. Both implementations changed in the same commit and
        // this fixture was regenerated from the mirror rather than adjusted to fit — the old vectors
        // are deleted, not commented out, because a stale expectation kept "for reference" is the
        // one somebody eventually restores.
        assert_eq!(winner, 0);
        assert_eq!((fighters[0].hp, fighters[0].banked, fighters[0].dead), (20787, 93784, 0));
        assert_eq!((fighters[1].hp, fighters[1].banked, fighters[1].dead), (220501, 103285, 0));
        assert_eq!((fighters[2].hp, fighters[2].banked, fighters[2].dead), (52229, 59189, 0));
        assert_eq!((fighters[3].hp, fighters[3].banked, fighters[3].dead), (20702, 49523, 0));

        // Conservation, restated here rather than trusted from elsewhere: this exact run must not
        // create or destroy value, on top of matching the TS mirror's numbers.
        let total: u64 = fighters[..4].iter().map(|f| f.hp + f.banked).sum();
        assert_eq!(total, 620_000);
    }

    /// DEFECT 2, AS A TEST THAT CANNOT PASS WITHOUT THE FIX.
    ///
    /// Nothing in this repo could previously catch the `d = (d + 1) % n` bias, because every test
    /// asserted the fight's OUTPUT and the bias is a property of its INPUT distribution. So this
    /// asserts the draw itself: over a fixed prefix of the hash chain, every ordered pair of distinct
    /// slots must come up about equally often, for every legal lineup size.
    ///
    /// Deterministic despite being a counting argument — the hash chain is fixed, so this is one
    /// fixed computation with one fixed answer, not a sampled test that might flake.
    ///
    /// The `f64` below is the tolerance arithmetic and nothing else. It is inside `#[cfg(test)]`, so
    /// it is never compiled into the program; the fight path itself remains integer-only, which the
    /// rest of this file depends on for determinism.
    ///
    /// It bites hard on the old rule: the bump sends every collision to slot `a + 1`, so that one
    /// pair comes up twice as often as the rest — a deviation of `mean`, against a 6-sigma tolerance
    /// of `6*sqrt(mean)`, which at these counts is a factor of two clear.
    #[test]
    fn the_defender_draw_is_uniform_over_everyone_but_the_attacker() {
        const DRAWS: u64 = 50_000;
        let seed: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(7));

        // The hash depends only on (seed, step), so one chain serves every lineup size.
        let chain: Vec<[u8; 32]> = (0..DRAWS)
            .map(|s| hashv(&[seed.as_ref(), s.to_le_bytes().as_ref()]).to_bytes())
            .collect();

        for n in 2..=MAX_FIGHTERS {
            let mut counts = vec![0u64; n * n];
            for h in &chain {
                let (a, d) = draw_pair(h, n);
                assert!(a < n && d < n, "draw out of range for n = {}: ({}, {})", n, a, d);
                assert_ne!(a, d, "a fighter was drawn against itself at n = {}", n);
                counts[a * n + d] += 1;
            }

            let cells = n * (n - 1);
            let mean = DRAWS as f64 / cells as f64;
            let tolerance = 6.0 * mean.sqrt();
            for a in 0..n {
                for d in 0..n {
                    let got = counts[a * n + d];
                    if a == d {
                        assert_eq!(got, 0, "n = {}: slot {} drawn against itself", n, a);
                        continue;
                    }
                    assert!(
                        (got as f64 - mean).abs() <= tolerance,
                        "n = {}: pair ({} -> {}) came up {} times, expected {:.1} +- {:.1}. \
                         A defender draw that favours any slot is a tax on ENTRY ORDER.",
                        n, a, d, got, mean, tolerance,
                    );
                }
            }
        }
    }

    /// THE SAME CROSS-LANGUAGE VECTOR, ON A FIGHT THAT ACTUALLY REACHES THE INTERESTING BRANCHES.
    ///
    /// `run_fight_matches_the_typescript_mirror_exactly` proves less than it looks. Its lineup runs
    /// 50 steps, nobody dies, and the lowest hp any fighter reaches is 20,702 — twenty times `DUST`.
    /// So it never executes `if hp_d <= DUST { dmg = hp_d }` and never executes
    /// `if dmg == 0 { continue }`, which are the two branches the seat-law fix edited. For a while
    /// those were the only lines in the fight with NO cross-language coverage at all: the Rust could
    /// have disagreed with both TypeScript mirrors about either one, and every test in this repo
    /// would still have been green. `mirrorParity.test.ts` does not close it either — it compares
    /// the two mirrors to each other, so a mistake made in both by the same hand survives.
    ///
    /// This vector is chosen to reach them, and the coverage was measured rather than assumed:
    /// 3 dust-finishes, 3 zero-damage skips, 3 deaths. The 3- and 7-unit entries are legal today
    /// (`enter` requires only `stake > 0`) and are what drives a blow to round to nothing.
    #[test]
    fn the_mirror_agrees_where_fighters_die_and_blows_round_to_nothing() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);

        let mut f = [Fighter::default(); MAX_FIGHTERS];
        f[0] = Fighter { wallet: pk(1), side: 0, dead: 0, stake: 50_000, hp: 50_000, banked: 0 };
        f[1] = Fighter { wallet: pk(2), side: 0, dead: 0, stake:      3, hp:      3, banked: 0 };
        f[2] = Fighter { wallet: pk(3), side: 1, dead: 0, stake: 40_000, hp: 40_000, banked: 0 };
        f[3] = Fighter { wallet: pk(4), side: 1, dead: 0, stake:      7, hp:      7, banked: 0 };

        let winner = run_fight(&mut f, 4, &seed, 400);

        // From gen-parity-fixture.mjs against engine/src/er-sim.ts, same seed/entries/steps.
        assert_eq!(winner, 0);
        assert_eq!((f[0].hp, f[0].banked, f[0].dead), (22686, 40007, 0));
        assert_eq!((f[1].hp, f[1].banked, f[1].dead), (0, 0, 1));
        assert_eq!((f[2].hp, f[2].banked, f[2].dead), (0, 27317, 1));
        assert_eq!((f[3].hp, f[3].banked, f[3].dead), (0, 0, 1));

        let total: u64 = f[..4].iter().map(|x| x.hp + x.banked).sum();
        assert_eq!(total, 90_010, "value was created or destroyed");

        // The point of the lineup, asserted rather than left to the comment: a fighter whose ring is
        // too small to land a blow banks NOTHING, and does not take the ring of whoever it swung at.
        assert_eq!(f[1].banked, 0, "a sub-dust attacker must not collect");
        assert_eq!(f[3].banked, 0, "a sub-dust attacker must not collect");
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
    /// and requires that the ring has really decayed and that leaving is really charged.
    ///
    /// IT USED TO ASSERT `banked < stake`, and that assertion was retired deliberately rather than
    /// because it became inconvenient. It was a PROXY that only tracked its intent while this
    /// particular fighter happened to be losing: under the `min(ring_a, ring_d)` damage basis, slot 0
    /// is ahead at step 40 (83,297 banked on a 100,000 stake), so a fighter who is winning and pulls
    /// out now walks away with more than they brought — which is the game working, not a free undo.
    /// What "not a free undo" actually means is asserted below, and it is lineup-independent: the
    /// ring genuinely decayed, and the exit was priced. Both still fail against the one-shot
    /// behaviour this test was written to catch, where `hp` never moved and `extract` returned the
    /// whole stake.
    #[test]
    fn extracting_partway_through_is_a_priced_decision_not_a_free_undo() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mut f = four_fighters();
        let stake = f[0].stake;

        advance_fight(&mut f, 4, &seed, 0, 40);
        assert!(f[0].hp < stake, "hp must have genuinely decayed by step 40, got {}", f[0].hp);

        // `extract` itself, inlined — the instruction adds only the account plumbing and the guards.
        let taken = f[0].hp;
        let (kept, penalty) = split_extraction(taken, 4, 40);
        f[0].banked += kept;
        f[0].hp = 0;
        f[0].dead = 1;

        assert!(penalty > 0, "leaving at step 40 of a 200-step horizon must cost something");
        assert!(
            kept < taken,
            "what reaches the bank must be strictly less than what left the ring: {} vs {}",
            kept, taken,
        );

        // ...and value is still conserved — but the identity has a third term now: what the ring
        // holds, plus what has been banked, plus what has LEFT for the house, is the pot. This is the
        // invariant that catches an economics bug in one line, and the penalty is inside it rather
        // than quietly outside it.
        let total: u64 = f[..4].iter().map(|x| x.hp + x.banked).sum::<u64>() + penalty;
        assert_eq!(total, 620_000);

        // Extracted fighters leave the ring: the rest of the fight must not touch them again.
        let banked_at_extract = f[0].banked;
        advance_fight(&mut f, 4, &seed, 40, 160);
        assert_eq!(f[0].hp, 0);
        assert_eq!(f[0].banked, banked_at_extract);
        let total: u64 = f[..4].iter().map(|x| x.hp + x.banked).sum::<u64>() + penalty;
        assert_eq!(total, 620_000);
    }

    /// DEFECT 1, AS A TEST THAT CANNOT PASS WITHOUT THE FIX.
    ///
    /// "You cannot take more than you brought", checked blow by blow rather than in aggregate. The
    /// fight is advanced ONE step at a time and the arrays diffed, so every individual exchange is
    /// inspected — which is the only level at which the old rule is visibly wrong. In aggregate it
    /// looked like a fair game; per blow, a $0.10 fighter was collecting $27 off a $1,000 one.
    ///
    /// The lineup is deliberately lopsided (two small against two large, small side first) so that
    /// most exchanges have the attacker as the smaller party — the case the old rule got wrong.
    #[test]
    fn no_blow_can_move_more_than_the_attackers_own_ring() {
        let seed: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_add(3));
        let mut f = [Fighter::default(); MAX_FIGHTERS];
        f[0] = Fighter { wallet: pk(1), side: 0, dead: 0, stake:     100_000, hp:     100_000, banked: 0 };
        f[1] = Fighter { wallet: pk(2), side: 0, dead: 0, stake:     100_000, hp:     100_000, banked: 0 };
        f[2] = Fighter { wallet: pk(3), side: 1, dead: 0, stake: 100_000_000, hp: 100_000_000, banked: 0 };
        f[3] = Fighter { wallet: pk(4), side: 1, dead: 0, stake: 100_000_000, hp: 100_000_000, banked: 0 };

        let mut blows = 0u32;
        let mut bound_by_the_attacker = 0u32;

        for step in 0..2_000u64 {
            let before = f;
            advance_fight(&mut f, 4, &seed, step, 1);
            if f == before { continue; }

            // Exactly one fighter gained and one lost — find them by diffing rather than by
            // re-deriving the draw, so this test cannot agree with a broken draw by construction.
            let attacker = (0..4).find(|&i| f[i].banked > before[i].banked).expect("a blow with no attacker");
            let defender = (0..4).find(|&i| f[i].hp < before[i].hp).expect("a blow with no defender");
            let moved = f[attacker].banked - before[attacker].banked;
            assert_eq!(moved, before[defender].hp - f[defender].hp, "value appeared or vanished mid-blow");

            let (ring_a, ring_d) = (before[attacker].hp, before[defender].hp);
            blows += 1;

            if ring_d <= DUST {
                // The termination rule, and the one case where a blow may exceed the attacker's
                // ring: a defender already down to dust is finished off whoever is swinging.
                assert_eq!(moved, ring_d, "a dust defender must be finished off exactly");
            } else {
                assert!(
                    moved <= ring_a,
                    "step {}: slot {} banked {} while holding only {} — an attacker collected more \
                     than it had at risk, which is the seat law this fix exists to kill",
                    step, attacker, moved, ring_a,
                );
                if ring_a < ring_d { bound_by_the_attacker += 1; }
            }
        }

        // Non-vacuity, stated as an assertion rather than hoped for: if no blow was actually limited
        // by the attacker's ring, the bound above was never exercised and this test proves nothing.
        assert!(blows > 100, "only {} blows landed — the lineup stopped exercising the rule", blows);
        assert!(
            bound_by_the_attacker > 50,
            "only {} blows had the attacker as the smaller party; the assertion above was never \
             put under load",
            bound_by_the_attacker,
        );
    }

    /// THE TRAP IN THE OBVIOUS VERSION OF THE FIX, as an assertion.
    ///
    /// `min(ring_a, ring_d)` combined with the OLD dust clause — `if hp_d <= DUST || dmg == 0` — is
    /// catastrophic, and it is what `HOUSE-EDGE-STUDY.md` §2 recommends porting. Once the basis reads
    /// the attacker, `dmg == 0` stops meaning "the defender is spent" and starts also meaning "the
    /// ATTACKER is spent", at which point that branch pays a spent attacker the defender's whole
    /// ring.
    ///
    /// It needs no exotic state to reach. `enter` requires only `stake > 0`, so a 3-unit entry — a
    /// third of a millionth of a dollar — has a ring so small that `3 * roll / 100` floors to zero
    /// for every legal roll. Under the old clause that fighter one-shots whoever it is drawn
    /// against, for a 33,000,000x return.
    ///
    /// Restore `|| dmg == 0` to that branch and this test fails on the seeds where the gnat swings
    /// first, which is about half of them.
    #[test]
    fn an_exhausted_attacker_cannot_annihilate_a_healthy_defender() {
        const WHALE: u64 = 100_000_000;   // $100
        const GNAT: u64 = 3;              // three raw units, and a legal entry today

        for s in 0..200u8 {
            let seed: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(31).wrapping_add(s));
            let mut f = [Fighter::default(); MAX_FIGHTERS];
            f[0] = Fighter { wallet: pk(1), side: 0, dead: 0, stake: WHALE, hp: WHALE, banked: 0 };
            f[1] = Fighter { wallet: pk(2), side: 1, dead: 0, stake: GNAT,  hp: GNAT,  banked: 0 };

            advance_fight(&mut f, 2, &seed, 0, 500);

            // A blow the gnat cannot afford moves nothing at all, so the only exchange that ever
            // lands is the whale finishing the gnat off. The whale keeps everything it brought and
            // collects the gnat's three units; the gnat leaves with nothing.
            assert_eq!(
                (f[0].hp, f[0].banked, f[0].dead), (WHALE, GNAT, 0),
                "seed {}: a 3-unit fighter moved a $100 ring", s,
            );
            assert_eq!((f[1].hp, f[1].banked, f[1].dead), (0, 0, 1), "seed {}", s);
            assert_eq!(f[0].hp + f[0].banked + f[1].hp + f[1].banked, WHALE + GNAT, "seed {}", s);
        }
    }

    /// THE MECHANIC THIS SESSION EXISTS TO PRICE, as an assertion. Two fighters, identical stakes,
    /// identical fight — one bails at the opening bell, one holds on. The early exit must be charged
    /// materially more than the late one, and the late one must be charged nothing at all.
    #[test]
    fn bailing_early_is_charged_and_holding_on_is_not() {
        let n = 4;
        let horizon = penalty_horizon_steps(n);
        assert_eq!(horizon, 200, "4-fighter horizon, from the measured table");

        // At the opening bell the option is worth the whole fight, and is priced accordingly.
        assert_eq!(extract_penalty_bps(n, 0), EXTRACT_PENALTY_START_BPS);
        // Halfway through, half price. Linear is linear.
        assert_eq!(extract_penalty_bps(n, horizon / 2), EXTRACT_PENALTY_START_BPS / 2);
        // At the horizon and beyond, free — nerve costs nothing.
        assert_eq!(extract_penalty_bps(n, horizon), 0);
        assert_eq!(extract_penalty_bps(n, horizon * 10), 0);
        assert_eq!(extract_penalty_bps(n, MAX_STEPS), 0);

        // The same 1,000,000 held in the ring, banked at two different moments.
        let (kept_early, penalty_early) = split_extraction(1_000_000, n, 1);
        let (kept_late, penalty_late) = split_extraction(1_000_000, n, 180);
        assert_eq!((kept_early, penalty_early), (801_000, 199_000));
        assert_eq!((kept_late, penalty_late), (980_000, 20_000));
        assert!(
            penalty_early > penalty_late * 5,
            "the whole point is a STEEP early cost decaying to a cheap late one: {} vs {}",
            penalty_early, penalty_late,
        );

        // Monotone all the way down, for every legal lineup — a curve that ever ticked UP would give
        // a player a reason to wait for a cheaper instant, which is a timing game inside the timing
        // game and not one anybody designed.
        for count in 2..=MAX_FIGHTERS {
            let mut prev = u64::MAX;
            for cursor in 0..=penalty_horizon_steps(count) + 5 {
                let bps = extract_penalty_bps(count, cursor);
                assert!(bps <= prev, "rate rose at cursor {} for {} fighters", cursor, count);
                assert!(bps <= EXTRACT_PENALTY_START_BPS);
                prev = bps;
            }
            assert_eq!(extract_penalty_bps(count, 0), EXTRACT_PENALTY_START_BPS);
            assert_eq!(extract_penalty_bps(count, penalty_horizon_steps(count)), 0);
        }
    }

    /// The horizon has to be reachable inside a real fight, or the penalty never decays to zero in
    /// practice and the "hold your nerve" half of the design is decoration. Checked against the
    /// pacing the round actually runs at, and against the two hard ceilings a fight can hit.
    #[test]
    fn every_lineups_horizon_is_reachable_before_the_bell_and_the_cap() {
        for n in 2..=MAX_FIGHTERS {
            let horizon = penalty_horizon_steps(n);
            assert!(horizon <= MAX_STEPS, "{} fighters: horizon {} past the step cap", n, horizon);
            let at_the_bell = canonical_cursor(0, n, FIGHT_TIMEOUT_SECONDS);
            assert!(
                horizon < at_the_bell,
                "{} fighters: horizon {} is not reached by the bell ({} steps) — the penalty would \
                 still be running when the round ends",
                n, horizon, at_the_bell,
            );
            // ...and it is not so short that it is over before the fight is worth watching: the
            // horizon must outlast the first few seconds, which is the window the instant-bail
            // exploit lived in.
            assert!(horizon > canonical_cursor(0, n, 5), "{} fighters: horizon gone within 5s", n);
        }
    }

    /// Two arithmetic promises `split_extraction` makes by construction rather than by check, stated
    /// here so that "by construction" is a fact rather than a claim: the house can never take more
    /// than a fifth, and can never take more than there was.
    #[test]
    fn the_penalty_can_never_exceed_what_was_taken() {
        for taken in [0u64, 1, 2, 999, 1_000, 4_999, u64::MAX / 2, u64::MAX] {
            for n in 2..=MAX_FIGHTERS {
                for cursor in [0u64, 1, 37, 199, 200, 1_599, 1_600, MAX_STEPS, u64::MAX] {
                    let (kept, penalty) = split_extraction(taken, n, cursor);
                    assert_eq!(kept.checked_add(penalty), Some(taken), "the split must be exact");
                    assert!(penalty <= taken / 5 + 1, "penalty {} over a fifth of {}", penalty, taken);
                }
            }
        }

        // Rounding: a tiny remainder late in the fight is charged nothing, because a fifth of nearly
        // nothing floors to zero. Deliberate — see `extract`'s doc comment.
        assert_eq!(split_extraction(4, 4, 199), (4, 0));
        assert_eq!(split_extraction(0, 4, 0), (0, 0));
    }

    /// THE INVARIANT THE WHOLE REPO CHECKS AGAINST, restated with its new third term and exercised by
    /// two extracts at genuinely different points of one fight. If this ever fails, either value is
    /// being created or the house's take is not being recorded — and the second is worse, because it
    /// is the one that looks fine.
    #[test]
    fn conservation_holds_once_the_penalty_is_counted() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mut f = four_fighters();
        let pot: u64 = f[..4].iter().map(|x| x.stake).sum();
        let mut penalties_collected = 0u64;

        let ring = |f: &[Fighter; MAX_FIGHTERS], p: u64| -> u64 {
            f[..4].iter().map(|x| x.hp + x.banked).sum::<u64>() + p
        };

        advance_fight(&mut f, 4, &seed, 0, 10);
        let (kept, penalty) = split_extraction(f[0].hp, 4, 10);
        f[0].banked += kept; f[0].hp = 0; f[0].dead = 1;
        penalties_collected += penalty;
        assert_eq!(ring(&f, penalties_collected), pot, "conservation after the early extract");
        let early_rate = extract_penalty_bps(4, 10);

        advance_fight(&mut f, 4, &seed, 10, 170);
        // Both extracts must actually move money, or the identity below is being checked against
        // nothing — a dead fighter extracts zero and passes every assertion vacuously.
        assert!(f[1].hp > 0, "the late extractor must still be standing at cursor 180");
        let (kept, penalty) = split_extraction(f[1].hp, 4, 180);
        f[1].banked += kept; f[1].hp = 0; f[1].dead = 1;
        penalties_collected += penalty;
        assert_eq!(ring(&f, penalties_collected), pot, "conservation after the late extract");
        let late_rate = extract_penalty_bps(4, 180);

        assert!(early_rate > late_rate, "{} must exceed {}", early_rate, late_rate);
        assert!(penalties_collected > 0, "the house must actually have taken something");

        // And the rest of the fight cannot disturb it: an extracted fighter is out, and the penalty
        // already left.
        advance_fight(&mut f, 4, &seed, 180, MAX_STEPS - 180);
        assert_eq!(ring(&f, penalties_collected), pot, "conservation to the end of the fight");
    }

    /// THE COPIES CANNOT DRIFT IN SILENCE. The penalty curve lives in three places — here, and in each
    /// TypeScript mirror — and a mirror that disagreed would pay a player one number on-chain while
    /// the browser told them another, which is the same class of failure `run_fight_matches_the_
    /// typescript_mirror_exactly` exists to prevent. So this reads the mirrors' own source and
    /// compares the numbers, rather than trusting that somebody remembered.
    /// The repo root, from this crate's manifest — every mirror path below is relative to it.
    fn repo_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
    }

    /// Pull `NAME = <integer>` out of a TypeScript source, ignoring `_` digit separators and BigInt
    /// `n` suffixes. Hoisted out of the penalty-curve test below so the constants test can use the
    /// same parser rather than growing a second one — a duplicated parser is its own drift risk, and
    /// this module exists to stop exactly that.
    fn scalar(src: &str, name: &str) -> u64 {
        let start = src.find(name).unwrap_or_else(|| panic!("{} missing from the mirror", name));
        let eq = start + src[start..].find('=').expect("no = after the name");
        let tail = &src[eq + 1..];
        let end = tail.find(|c: char| c == ';' || c == '\n').unwrap_or(tail.len());
        tail[..end].trim().replace('_', "").replace('n', "").parse().expect("not a number")
    }

    /// EVERY CHAIN FACT THE BROWSER HAND-COPIES, checked against the constant it was copied from.
    ///
    /// `er-demo/src/chain/constants.ts` calls itself the mirror of this file and was checked by
    /// nobody — the penalty-curve test below reads only the two fight simulators. That mattered
    /// immediately: the lobby deadline added two more copied constants (`MIN_LOBBY_SECONDS`,
    /// `MAX_LOBBY_SECONDS`) to a file already carrying the fight pacing, and a client whose floor
    /// disagreed with the program's would offer an operator a lobby length the chain then silently
    /// clamped — the "your number and my number differ" failure this repo has now been bitten by
    /// twice.
    #[test]
    fn the_browser_carries_the_same_chain_constants() {
        let src = std::fs::read_to_string(repo_root().join("er-demo/src/chain/constants.ts"))
            .expect("could not read er-demo/src/chain/constants.ts");

        // Matched on the DECLARATION (`export const NAME`), not the bare name: every one of these
        // also appears in that file's prose, and a parser that grabbed the first mention would be
        // checking a comment rather than a value.
        for (name, expected) in [
            ("export const STEPS_PER_FIGHTER_PER_SECOND", STEPS_PER_FIGHTER_PER_SECOND),
            ("export const MAX_STEPS", MAX_STEPS),
            ("export const FIGHT_TIMEOUT_SECONDS", FIGHT_TIMEOUT_SECONDS as u64),
            ("export const MIN_LOBBY_SECONDS", MIN_LOBBY_SECONDS as u64),
            ("export const MAX_LOBBY_SECONDS", MAX_LOBBY_SECONDS as u64),
        ] {
            assert_eq!(scalar(&src, name), expected, "chain/constants.ts drifted on {}", name);
        }

        // The demo's own lobby length is NOT a chain fact — the program only clamps, it has no view
        // on pacing — but it has to be a value the program will actually honour, or every round the
        // app opens is silently clamped to something else.
        let default_lobby = scalar(&src, "export const DEFAULT_LOBBY_SECONDS");
        assert_eq!(
            default_lobby, clamp_lobby_seconds(default_lobby as u32) as u64,
            "DEFAULT_LOBBY_SECONDS ({}) is outside [{}, {}] and would be clamped on-chain",
            default_lobby, MIN_LOBBY_SECONDS, MAX_LOBBY_SECONDS,
        );

        // The phase table is a mirror too, and the one whose drift is hardest to see: a missing name
        // makes `PHASE_NAME[phase]` undefined, which `useRound.ts` turns into "Lobby" — a settled or
        // abandoned round rendering as an open, enterable lobby.
        let phases = src
            .find("export const PHASE_NAME")
            .map(|at| {
                let open = at + src[at..].find('[').expect("no [ after PHASE_NAME");
                let close = open + src[open..].find(']').expect("unterminated PHASE_NAME");
                src[open + 1..close].matches('"').count() / 2
            })
            .expect("PHASE_NAME missing from chain/constants.ts");
        assert_eq!(
            phases, Phase::Abandoned as usize + 1,
            "chain/constants.ts PHASE_NAME has {} entries, the Rust Phase enum has {}",
            phases, Phase::Abandoned as usize + 1,
        );
    }

    /// THE IDL IS A MIRROR TOO, and until now the only one nothing checked.
    ///
    /// `anchor idl build` cannot run on this machine (upstream proc-macro breakage), so the IDL is
    /// produced by `scripts/idlgen.py`, which re-derives every discriminator with anchor's own rule
    /// and lifts every doc block straight out of this file. `--verify` runs those checks WITHOUT
    /// writing, against the committed IDL and the committed source, so a doc block edited here and
    /// committed without regenerating fails the build instead of silently shipping an IDL that
    /// describes the previous program.
    ///
    /// WHY THIS TEST EARNS ITS PLACE, stated plainly because the tool arrived with a bug rather than
    /// despite one: while the generator lived in a scratch directory it mis-parsed the one-line
    /// `#[event]` structs — `docs_above` treated only a LEADING `}` as an item boundary, so it walked
    /// over the complete one-line `RoundAbandoned` and handed both `SeedRevealed` and `RoundSettled`
    /// that struct's doc block. Every name still resolved and the IDL still loaded; nothing could
    /// have caught it, because nothing ran the generator except the person running it. That is the
    /// argument FOR wiring it in here, not against.
    ///
    /// Shells out rather than reimplementing the checks in Rust: two implementations of "what does
    /// anchor emit" is precisely the duplication this module exists to prevent.
    #[test]
    fn the_idl_generator_still_reproduces_the_committed_idl() {
        let script = repo_root().join("scripts").join("idlgen.py");
        let out = std::process::Command::new("python3")
            .arg(&script)
            .arg("--verify")
            .output()
            .expect("could not run scripts/idlgen.py — python3 must be on PATH");
        assert!(
            out.status.success(),
            "scripts/idlgen.py --verify failed — the committed IDL no longer matches this source:\n{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }

    #[test]
    fn the_typescript_mirrors_carry_the_same_penalty_curve() {
        /// Pull `NAME = [ ... ]` out of a TypeScript source and parse the integers, ignoring line
        /// comments, `_` digit separators and BigInt `n` suffixes.
        fn table(src: &str, name: &str) -> Vec<u64> {
            let start = src.find(name).unwrap_or_else(|| panic!("{} missing from the mirror", name));
            let open = start + src[start..].find('[').expect("no [ after the name");
            let close = open + src[open..].find(']').expect("unterminated table");
            src[open + 1..close]
                .lines()
                .map(|l| l.split("//").next().unwrap_or(""))
                .collect::<Vec<_>>()
                .join(",")
                .split(',')
                .map(|t| t.trim().replace('_', "").replace('n', ""))
                .filter(|t| !t.is_empty())
                .map(|t| t.parse::<u64>().unwrap_or_else(|_| panic!("not a number: {:?}", t)))
                .collect()
        }
        let root = repo_root();
        let mirrors = ["engine/src/er-sim.ts", "er-demo/src/sim/erSim.ts"];
        let expected: Vec<u64> = PENALTY_HORIZON_STEPS.iter().map(|&h| h as u64).collect();

        for mirror in mirrors {
            let src = std::fs::read_to_string(root.join(mirror))
                .unwrap_or_else(|e| panic!("could not read {}: {}", mirror, e));
            // Matched on the DECLARATION, not the bare name — the name also appears in each mirror's
            // prose, and a parser that grabbed the first mention would be checking a comment.
            assert_eq!(
                table(&src, "const PENALTY_HORIZON_STEPS"), expected,
                "{} horizon table drifted", mirror,
            );
            assert_eq!(
                scalar(&src, "const EXTRACT_PENALTY_START_BPS"), EXTRACT_PENALTY_START_BPS,
                "{} start rate drifted", mirror,
            );
        }
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

// ---------------------------------------------------------------------------------------------
// THE LOBBY DEADLINE. Native host tests, same command as the parity module above.
//
// What these are protecting is a PROMISE MADE TO THE SCREEN: the countdown a client draws from
// `lobby_closes_at` is only worth drawing if the program refuses entries after it and refuses the
// draw before it. Every test below is phrased in the same pure predicates the instructions call
// (`lobby_is_open`, `lobby_may_close`, `lobby_is_dead`, `clamp_lobby_seconds`) rather than restating
// their conditions — this repo has been bitten twice by a test that described the code instead of
// running it (`bench_fight` drifting from `run_fight`, the DUST floor), and a re-description of a
// boundary condition is exactly the kind that agrees right up until the `<` should have been `<=`.
// ---------------------------------------------------------------------------------------------
#[cfg(test)]
mod lobby_tests {
    use super::*;

    const OPENED: i64 = 1_700_000_000;

    /// The two bugs the clamp exists to make unrepresentable, from both ends: a lobby too short for
    /// anyone to enter, and a lobby nobody will still be watching when it closes.
    #[test]
    fn the_lobby_duration_is_clamped_to_a_range_a_round_can_actually_use() {
        // Zero is the degenerate case the brief for this field named: the countdown would already be
        // over when `delegate_round` lands, so the lobby could never accept a single entry.
        assert_eq!(clamp_lobby_seconds(0), MIN_LOBBY_SECONDS as i64);
        assert_eq!(clamp_lobby_seconds(1), MIN_LOBBY_SECONDS as i64);
        assert_eq!(clamp_lobby_seconds(MIN_LOBBY_SECONDS - 1), MIN_LOBBY_SECONDS as i64);
        // THE CEILING NO LONGER CATCHES THE MILLISECONDS MISTAKE, AND THAT IS ASSERTED RATHER THAN
        // LEFT TO BE NOTICED. `20_000` — milliseconds passed where seconds were meant, the realistic
        // way to get a multi-day lobby given every prior art in this repo is named `*_MS` — used to
        // clamp to an hour. At a week's ceiling it passes straight through as 5.5 hours.
        //
        // That is a deliberate loss, not an oversight, and this line is here so that anyone lowering
        // the ceiling back has to read `MAX_LOBBY_SECONDS`'s reasoning first: the deadline stopped
        // being the mechanism that ends a lobby (the authority's early close is), so a wrong duration
        // stopped having a consequence. What replaced the guard is that the mistake no longer costs
        // anything — not a different guard.
        assert_eq!(clamp_lobby_seconds(20_000), 20_000, "no longer clamped — see MAX_LOBBY_SECONDS");
        // The absurd is still bounded, which is the job the ceiling kept. u32::MAX seconds is 136
        // years — a round delegated to an ER validator forever, i.e. the permanently-stuck state.
        assert_eq!(clamp_lobby_seconds(u32::MAX), MAX_LOBBY_SECONDS as i64);
        assert!(MAX_LOBBY_SECONDS <= 604_800, "a backstop longer than a week is not a backstop");
        // ...and in between, the operator's number is used exactly as given.
        for requested in [MIN_LOBBY_SECONDS, 45, 60, 120, 600, 20_000, 86_400, MAX_LOBBY_SECONDS] {
            assert_eq!(clamp_lobby_seconds(requested), requested as i64);
        }

        // The floor's DERIVATION, as an assertion rather than a number to take on faith. The bug it
        // exists to prevent is a lobby whose countdown expires before a player could have entered it
        // at all — the deadline is stamped by `open_round`, but nobody can enter until
        // `delegate_round` has handed the account to the ER.
        //
        // The handoff figure is MEASURED, and that matters: it was 10 here, taken from
        // `admin-open-round.mjs` polling ten times at one-second intervals, which is the point the
        // script gives up rather than how long the thing takes. Timed against real devnet:
        // 1.70s and 1.87s. 3 is that, doubled, and it is the number to revisit — with a stopwatch —
        // if the handoff ever regresses.
        const DELEGATION_HANDOFF_SECONDS: u32 = 3;
        assert!(
            MIN_LOBBY_SECONDS > DELEGATION_HANDOFF_SECONDS,
            "a lobby must outlive the delegation hand-off, or nobody can ever enter it",
        );
        // And what is left over has to be a window a human can actually act inside. 15s is the floor
        // below which this stops being a lobby and starts being a formality — deliberately under the
        // off-chain engine's 20s default, because that default was a chosen round number and this is
        // the point at which the feature breaks.
        assert!(
            MIN_LOBBY_SECONDS - DELEGATION_HANDOFF_SECONDS >= 15,
            "the entry window left after the hand-off must still be one a player can use",
        );
        assert!(MIN_LOBBY_SECONDS < MAX_LOBBY_SECONDS);
    }

    /// WHICH SIDE OF THE BOUNDARY THE DEADLINE SECOND FALLS ON — the one thing about the two windows
    /// that is a decision rather than a consequence.
    ///
    /// That they tile at all is structural: `lobby_may_close` and `lobby_is_dead` are both phrased in
    /// terms of `lobby_is_open`, so "either taking entries or closeable, never both, never neither"
    /// holds for any definition of the boundary and a test asserting it would be asserting `x != !x`.
    /// What is NOT structural is the direction of the inequality, and it decides real behaviour: the
    /// deadline second belongs to the DRAW. "Entries close at 12:00:30" has to mean 12:00:30 is too
    /// late, because that is what a countdown reaching 0:00 means to the person reading it — and if
    /// it meant the opposite, an entry could land in the same second the lineup was frozen for the
    /// draw, which is the one moment `fighter_count` must not move.
    #[test]
    fn the_deadline_second_belongs_to_the_draw_not_to_entries() {
        let closes_at = OPENED + 60;

        // Concrete values on both sides of the boundary, so a `<` silently becoming `<=` fails here
        // rather than showing up as a one-second window nobody can act in.
        assert!(lobby_is_open(closes_at, closes_at - 1), "one second early is still open");
        assert!(!lobby_is_open(closes_at, closes_at), "the deadline second is closed to entries");
        assert!(!lobby_may_close(2, closes_at, closes_at - 1), "...and not yet drawable");
        assert!(lobby_may_close(2, closes_at, closes_at), "...but drawable from that second on");
    }

    /// The guard `close_lobby_and_draw` runs, exercised through the function the instruction itself
    /// calls. Before this existed the operator decided when a lobby ended; now the clock does.
    #[test]
    fn a_lobby_may_not_be_drawn_before_its_deadline() {
        let closes_at = OPENED + 60;
        for fighters in [2u16, 3, 8, 15] {
            assert!(!lobby_may_close(fighters, closes_at, OPENED), "an empty countdown is not a deadline");
            assert!(!lobby_may_close(fighters, closes_at, closes_at - 1), "one second early is early");
            assert!(lobby_may_close(fighters, closes_at, closes_at), "the deadline must actually arrive");
            assert!(lobby_may_close(fighters, closes_at, closes_at + 3_600));
        }
    }

    /// The early exit, and the reason it gives nobody anything: a full lobby cannot gain a fighter, so
    /// the only thing waiting out the countdown produces is dead air.
    #[test]
    fn a_full_lobby_may_be_drawn_the_instant_it_fills() {
        let closes_at = OPENED + 600;
        let full = MAX_FIGHTERS as u16;

        assert!(lobby_may_close(full, closes_at, OPENED), "a full lobby has nothing left to wait for");
        // One short of full is NOT enough — the sixteenth entry is still possible, and cutting the
        // lobby short there would be an operator excluding a player who was entitled to enter.
        assert!(!lobby_may_close(full - 1, closes_at, OPENED));
        // And a full lobby is never dead — it has the most fighters a round can hold.
        assert!(!lobby_is_dead(full, closes_at, closes_at + 1));
    }

    /// THE DEGENERATE PATH, stated exactly. It should practically never happen — house wallets keep
    /// lobbies populated — but "practically never" is how the two permanently-stuck rounds in this
    /// repo's history got their guards left out, so the state is defined rather than assumed away.
    #[test]
    fn an_under_subscribed_lobby_is_dead_exactly_when_it_can_no_longer_fight() {
        let closes_at = OPENED + 60;

        // Before the deadline nothing is dead: one more `enter` can still turn a lonely lobby into a
        // fight, so `abandon_round` must refuse.
        for fighters in 0u16..=MAX_FIGHTERS as u16 {
            assert!(!lobby_is_dead(fighters, closes_at, closes_at - 1), "{} fighters, still enterable", fighters);
        }

        // After it, THE TWO EXITS PARTITION THE STATE. A lobby at its deadline is either drawable or
        // abandonable — never both (which would let the same round be drawn and written off), and
        // never neither (which is the permanently-stuck round this whole path exists to prevent).
        // Stated against the FULL guard each instruction applies, not against half of it: the draw
        // needs `lobby_may_close` AND two fighters, and `abandon_round` needs `lobby_is_dead`.
        for fighters in 0u16..=MAX_FIGHTERS as u16 {
            let drawable = lobby_may_close(fighters, closes_at, closes_at) && enough_to_fight(fighters);
            let abandonable = lobby_is_dead(fighters, closes_at, closes_at);
            assert_ne!(
                drawable, abandonable,
                "{} fighters at the deadline: drawable={} abandonable={} — exactly one must hold",
                fighters, drawable, abandonable,
            );
        }

        // Nobody came at all is the same terminal state as one wallet left standing alone — there is
        // no fight in either, and the program custodies nothing, so there is nothing else to do.
        assert!(lobby_is_dead(0, closes_at, closes_at + 86_400));
        assert!(lobby_is_dead(1, closes_at, closes_at + 86_400));
    }

    /// THE EARLY CLOSE, AND THE FACT THAT ONLY THE ARENA'S OWN AUTHORITY GETS IT.
    ///
    /// MUTATION-TESTED BY CONSTRUCTION, and the mutation is the obvious one: make
    /// `authority_close_requested`'s last arm `Ok(true)` instead of `Err(NotTheAuthority)` — i.e.
    /// "somebody signed, that will do" — and the stranger case below fails. Delete the `by_authority`
    /// term from `draw_is_permitted` and the first block fails. Neither mutation is caught by anything
    /// else in this file, which is the point of both.
    #[test]
    fn only_the_arenas_own_authority_can_close_a_lobby_early() {
        let closes_at = OPENED + 604_800;          // a lobby held open, in the shape this feature is for
        let authority = Pubkey::new_from_array([9; 32]);
        let stranger = Pubkey::new_from_array([8; 32]);

        // Before the deadline, with a real fight in the room, the permissionless rule refuses and the
        // authority does not. This is precisely the situation the feature exists for: a player has
        // arrived and the clock is a week away.
        assert!(!draw_is_permitted(2, closes_at, OPENED, false), "the clock says no");
        assert!(draw_is_permitted(2, closes_at, OPENED, true), "the authority says now");

        // WHO COUNTS. No account supplied is an ordinary permissionless call, not a refusal — the
        // deadline rule then applies on its own.
        assert_eq!(authority_close_requested(None, authority).unwrap(), false);
        assert_eq!(authority_close_requested(Some(authority), authority).unwrap(), true);
        // ...and anybody else is an ERROR rather than a quiet `false`. A silent fall-through would
        // answer a misconfigured keeper with `LobbyStillOpen`, which is a message about the clock when
        // the problem is the key.
        assert!(
            authority_close_requested(Some(stranger), authority).is_err(),
            "a signer who is not the arena's authority must be refused, not ignored",
        );

        // THE FIGHT REQUIREMENT STILL BINDS ON BOTH PATHS. `draw_is_permitted` answers only "has the
        // waiting requirement been met" — `close_lobby_and_draw` checks `enough_to_fight` separately,
        // and folding the two together is what would let an operator draw on a single fighter.
        for count in 0u16..2 {
            assert!(draw_is_permitted(count, closes_at, OPENED, true), "timing is satisfied...");
            assert!(!enough_to_fight(count), "...but {} fighters is not a fight", count);
        }
        assert!(enough_to_fight(2));
    }

    /// THE PERMISSIONLESS PATH IS BYTE-FOR-BYTE WHAT IT WAS. `draw_is_permitted` is a disjunction over
    /// `lobby_may_close`, so with `by_authority == false` it IS `lobby_may_close` — asserted here over
    /// the whole grid rather than argued, because "I only added a term" is exactly the claim that
    /// turns out to be false when the term was added in the wrong place.
    ///
    /// The wrong place would have been inside `lobby_may_close` itself: `lobby_is_dead` is phrased as
    /// its complement, so an authority term there would have made a round both drawable AND
    /// abandonable — the partition
    /// `an_under_subscribed_lobby_is_dead_exactly_when_it_can_no_longer_fight` asserts. That test
    /// still passes because the term went into the wrapper, and this one says why that mattered.
    #[test]
    fn the_authority_path_leaves_the_permissionless_rule_untouched() {
        let closes_at = OPENED + 60;
        for count in 0u16..=MAX_FIGHTERS as u16 {
            for now in [OPENED, closes_at - 1, closes_at, closes_at + 86_400] {
                assert_eq!(
                    draw_is_permitted(count, closes_at, now, false),
                    lobby_may_close(count, closes_at, now),
                    "{} fighters at {}: the permissionless answer must be unchanged", count, now,
                );
                // And the authority path never REFUSES something the clock already allowed — it can
                // only ever add. A wrapper that returned `by_authority` alone would break this.
                assert!(draw_is_permitted(count, closes_at, now, true));
            }
        }

        // The two exits still partition the state at the deadline, with the authority in play. An
        // authority close needs two fighters; a dead lobby has fewer than two. They cannot overlap.
        for count in 0u16..=MAX_FIGHTERS as u16 {
            let drawable = draw_is_permitted(count, closes_at, closes_at, true) && enough_to_fight(count);
            let abandonable = lobby_is_dead(count, closes_at, closes_at);
            assert_ne!(
                drawable, abandonable,
                "{} fighters: an early close and an abandon must never both be legal", count,
            );
        }
    }

    /// A LOBBY HELD OPEN FOR DAYS IS A THING THE PROGRAM NOW PERMITS, which is the point of the
    /// ceiling change — one round's rent instead of one per keeper cycle. Asserted against the
    /// duration an operator would actually pass, not just against the constant.
    #[test]
    fn a_lobby_can_be_held_open_until_somebody_turns_up() {
        for days in [1u32, 2, 7] {
            let requested = days * 86_400;
            let (opened_at, closes_at) = lobby_window(OPENED, requested);
            assert_eq!(closes_at - opened_at, requested as i64, "{} days must survive the clamp", days);
            // Still taking entries the whole way, right up to the last second.
            assert!(lobby_is_open(closes_at, closes_at - 1));
            // Nobody may draw it on the clock during that time...
            assert!(!lobby_may_close(2, closes_at, opened_at));
            // ...but the authority may, the instant there is a fight to start.
            assert!(draw_is_permitted(2, closes_at, opened_at, true));
        }

        // AND IT STILL TERMINATES. The backstop is what stops a held-open lobby becoming the
        // permanently-stuck round this repo has paid for twice: once the week is up, the ordinary
        // permissionless rules take over with no operator involved — a fight if two turned up, an
        // abandon if they did not.
        let (_, closes_at) = lobby_window(OPENED, u32::MAX);
        assert_eq!(closes_at - OPENED, MAX_LOBBY_SECONDS as i64);
        assert!(lobby_may_close(2, closes_at, closes_at), "the backstop must fire without an authority");
        assert!(lobby_is_dead(1, closes_at, closes_at), "and a lobby nobody joined must still die");
    }

    /// WHAT `open_round` ACTUALLY WRITES, which no other test in this module reaches.
    ///
    /// Everything else here exercises the guards in isolation, and all of them pass against an
    /// `open_round` that stamped `now + lobby_seconds` with the clamp dropped entirely — the single
    /// mutation `MIN_LOBBY_SECONDS` and `MAX_LOBBY_SECONDS` exist to prevent. This runs the exact
    /// composition the instruction runs, and asserts the property `Round.lobby_opened_at`'s doc
    /// comment promises a sceptic can check for themselves: the stored window is the requested one,
    /// clamped, and always inside the published range.
    #[test]
    fn the_stored_lobby_window_is_always_within_the_clamp() {
        for requested in [0u32, 1, 29, MIN_LOBBY_SECONDS, 45, 60, 600, MAX_LOBBY_SECONDS, 20_000, u32::MAX] {
            let (opened_at, closes_at) = lobby_window(OPENED, requested);
            let window = closes_at - opened_at;

            assert_eq!(opened_at, OPENED, "the open timestamp is the chain's clock, untouched");
            assert_eq!(window, clamp_lobby_seconds(requested), "requested {}", requested);
            assert!(
                (MIN_LOBBY_SECONDS as i64..=MAX_LOBBY_SECONDS as i64).contains(&window),
                "requested {} stored a {}s window, outside the published range", requested, window,
            );
            // The deadline must be strictly ahead of the stamp, or the round opens already expired
            // and `lobby_is_open` is false from the first instant — a lobby nobody can enter.
            assert!(lobby_is_open(closes_at, opened_at), "requested {} opened already closed", requested);
        }

        // Clock skew cannot make the window negative, and a timestamp near the end of time saturates
        // rather than wrapping into the past.
        let (_, closes_at) = lobby_window(i64::MAX, MAX_LOBBY_SECONDS);
        assert_eq!(closes_at, i64::MAX);
    }

    /// `Round::SIZE` is what `#[account(init, space = ...)]` allocates. Get it wrong by the eight bytes
    /// a new field costs and the account is a byte-for-byte plausible round that fails to serialise
    /// the moment anything writes past the end — on devnet, as a runtime error nobody can read. So the
    /// size is MEASURED off a real borsh encoding here rather than recited from the comment above it.
    ///
    /// The second assertion is the 4 KB STACK, which this program has already been bitten by once:
    /// `Account<'info, Round>` deserialises onto the stack, and at 40 fighters devnet reported the
    /// overflow as "Access violation reading 8 bytes at address 0x18" — a message that names neither
    /// the stack nor the size (see `MAX_FIGHTERS`). MEASURED with the house's books in: 1,192 B of a
    /// 4,096 B frame, up from 1,184 — `fees_collected` and `house_swept` cost eight of those, the
    /// ninth borsh byte disappearing into the `u64`'s alignment. The margin is recorded as a number
    /// rather than asserted to be "plenty", and the bound is checked rather than remembered.
    /// `cargo build-sbf` reports no `Stack offset ... exceeded` for this build.
    #[test]
    fn the_account_is_exactly_the_size_its_layout_needs() {
        let round = Round {
            arena: Pubkey::default(),
            round_no: 1,
            phase: Phase::Lobby as u8,
            winner: 0,
            bump: 255,
            fighter_count: 0,
            tick_count: 0,
            pot: 0,
            penalties_collected: 0,
            fees_collected: 0,
            house_swept: false,
            seed_commit: [0u8; 32],
            seed: [0u8; 32],
            lobby_opened_at: OPENED,
            lobby_closes_at: OPENED + 60,
            fight_started_at: 0,
            fighters: [Fighter::default(); MAX_FIGHTERS],
        };
        // `AnchorSerialize::serialize` rather than a hand-added-up byte count: it is the SAME encoder
        // `#[account]`'s own `exit` uses to write the account back, which is the only reason measuring
        // it here proves anything about `space = Round::SIZE`.
        let mut encoded = Vec::<u8>::new();
        round.serialize(&mut encoded).expect("a Round must borsh-encode");
        assert_eq!(
            8 + encoded.len(), Round::SIZE,
            "Round::SIZE ({}) does not match 8 + the real encoding ({})", Round::SIZE, 8 + encoded.len(),
        );

        let stack = core::mem::size_of::<Round>();
        assert!(stack < 2_048, "Round is {} B on the stack — the frame is 4 KB, see MAX_FIGHTERS", stack);
    }

    /// The same measurement for `Treasury`, for the same reason and before it can bite: this account
    /// is created by `init_treasury` with `space = Treasury::SIZE` exactly once per arena, and an
    /// under-allocation would present as `sweep_house_take` failing to serialise a value it had
    /// already, from the caller's point of view, successfully computed.
    #[test]
    fn the_treasury_is_exactly_the_size_its_layout_needs() {
        let treasury = Treasury {
            arena: Pubkey::default(),
            fees_accrued: 0,
            penalties_accrued: 0,
            rounds_swept: 0,
            bump: 255,
        };
        let mut encoded = Vec::<u8>::new();
        treasury.serialize(&mut encoded).expect("a Treasury must borsh-encode");
        assert_eq!(
            8 + encoded.len(), Treasury::SIZE,
            "Treasury::SIZE ({}) does not match 8 + the real encoding ({})",
            Treasury::SIZE, 8 + encoded.len(),
        );
    }
}

// ---------------------------------------------------------------------------------------------
// THE HOUSE'S BOOKS. Native host tests, same command as the modules above.
//
// WHAT THESE ARE PROTECTING is a number that was zero for the whole life of this program while
// players were being charged for it every round. `enter` computed the fee, subtracted it, and let
// the local go out of scope — see `Round.fees_collected`. Nothing caught it, and the reason nothing
// caught it is the reason these tests are shaped the way they are: the arithmetic lived inside an
// instruction body, where no native test can reach it, so the only thing that could ever have
// noticed was someone reading the four lines and seeing that `fee` was never used again.
//
// So every test below runs `credit_entry` and `apply_sweep` — the ACTUAL functions the instructions
// call, hoisted out for exactly this purpose — rather than a restatement of what they do. This repo
// has been bitten three times by a test that described the code instead of running it (`bench_fight`
// drifting from `run_fight`, the DUST floor, and the `#[event]` doc extractor), and a re-description
// of an accounting rule is the worst of the three: it agrees with the bug.
// ---------------------------------------------------------------------------------------------
#[cfg(test)]
mod house_tests {
    use super::*;

    const FEE_BPS: u64 = 20;        // the deployed rate, matching the engine's FEE = 0.002
    fn pk(b: u8) -> Pubkey { Pubkey::new_from_array([b; 32]) }

    /// A `Round` as `open_round` leaves it: everything zeroed, phase Lobby.
    fn fresh_round() -> Round {
        Round {
            arena: Pubkey::default(),
            round_no: 1,
            phase: Phase::Lobby as u8,
            winner: 0,
            bump: 255,
            fighter_count: 0,
            tick_count: 0,
            pot: 0,
            penalties_collected: 0,
            fees_collected: 0,
            house_swept: false,
            seed_commit: [0u8; 32],
            seed: [0u8; 32],
            lobby_opened_at: 1_700_000_000,
            lobby_closes_at: 1_700_000_060,
            fight_started_at: 0,
            fighters: [Fighter::default(); MAX_FIGHTERS],
        }
    }

    fn fresh_treasury() -> Treasury {
        Treasury { arena: Pubkey::default(), fees_accrued: 0, penalties_accrued: 0, rounds_swept: 0, bump: 255 }
    }

    /// The three quantities `Round.fees_collected`'s doc comment defines, computed the way every
    /// verifier in the repo now computes them.
    fn books(r: &Round) -> (u64, u64, u64) {
        let n = r.fighter_count as usize;
        let players_hold: u64 = r.fighters[..n].iter().map(|f| f.hp + f.banked).sum();
        let house_took = r.penalties_collected + r.fees_collected;
        let gross_deposits = r.pot + r.fees_collected;
        (players_hold, house_took, gross_deposits)
    }

    /// THE BUG, AS AN ASSERTION. Four entries and a top-up, against a rate whose arithmetic is exact
    /// so that every expected number below is a fact rather than a rounding argument.
    ///
    /// MUTATION-TESTED BY CONSTRUCTION: delete `r.fees_collected = ...` from `credit_entry` — which
    /// is precisely the state this program shipped in — and the first assertion fails on
    /// `0 != 2_000`. Nothing else in the file catches that deletion, which is the whole reason this
    /// test is phrased against the total rather than against the identity: the fee cancels out of the
    /// conservation identity (see the field's doc comment), so an identity test would pass happily
    /// against the bug.
    #[test]
    fn the_fee_is_recorded_rather_than_discarded() {
        let mut r = fresh_round();

        // 1 SOL-ish, four ways. 1_000_000 × 20 / 10_000 = 2_000 exactly, no rounding anywhere.
        for (i, side) in [(1u8, 0u8), (2, 0), (3, 1), (4, 1)] {
            let (net, fee) = credit_entry(&mut r, pk(i), side, 1_000_000, FEE_BPS).unwrap();
            assert_eq!((net, fee), (998_000, 2_000), "entry {}", i);
        }
        assert_eq!(r.fees_collected, 8_000, "four entries at 20 bps on 1_000_000 each");
        assert_eq!(r.pot, 3_992_000, "the pot is the sum of NET stakes");
        assert_eq!(r.fighter_count, 4);

        // A TOP-UP IS AN ENTRY. The same wallet on the same side merges into its existing fighter
        // rather than spawning a second one — and the fee is charged and recorded on the top-up
        // exactly as on the first entry. A fee counter incremented only on the `else` branch of
        // `credit_entry`'s find-or-insert would pass every assertion above and fail here.
        let (net, fee) = credit_entry(&mut r, pk(1), 0, 500_000, FEE_BPS).unwrap();
        assert_eq!((net, fee), (499_000, 1_000));
        assert_eq!(r.fighter_count, 4, "a top-up must not add a fighter");
        assert_eq!(r.fighters[0].stake, 998_000 + 499_000);
        assert_eq!(r.fighters[0].hp, r.fighters[0].stake, "hp starts at the whole net stake");
        assert_eq!(r.fees_collected, 9_000, "the top-up's fee is on the books too");
        assert_eq!(r.pot, 3_992_000 + 499_000);

        // The same wallet on the OTHER side is a second fighter, and is charged again.
        let (_, fee) = credit_entry(&mut r, pk(1), 1, 1_000_000, FEE_BPS).unwrap();
        assert_eq!(fee, 2_000);
        assert_eq!(r.fighter_count, 5, "both sides of one wallet are two fighters");
        assert_eq!(r.fees_collected, 11_000);

        // And the whole point, stated as the identity: what players were charged is the pot plus
        // what the house took at the door, to the lamport.
        let gross_charged = 4 * 1_000_000 + 500_000 + 1_000_000;
        assert_eq!(r.pot + r.fees_collected, gross_charged);

        // A FULL LOBBY REFUSES RATHER THAN PANICS. `enter` refuses first, with a better message —
        // but this function must be total on its own, because the write below the find-or-insert is
        // an index by a count, and a helper that panics on an unguarded call is a hazard as soon as
        // it has a second caller.
        while (r.fighter_count as usize) < MAX_FIGHTERS {
            let filler = pk(r.fighter_count as u8 + 100);
            credit_entry(&mut r, filler, 0, 1_000, FEE_BPS).unwrap();
        }
        let (full_fees, full_pot) = (r.fees_collected, r.pot);
        assert!(credit_entry(&mut r, pk(200), 0, 1_000_000, FEE_BPS).is_err(), "a full lobby must refuse");
        assert_eq!((r.fees_collected, r.pot), (full_fees, full_pot), "a refused entry charges nothing");
    }

    /// EVERY LAMPORT CHARGED IS EITHER STILL OWED TO A PLAYER OR WAS TAKEN BY THE HOUSE — with BOTH
    /// house takes non-zero at once, which no test in this repo previously exercised because one of
    /// them could not be non-zero.
    ///
    /// The identity is checked at four moments, and the two house terms are asserted to be non-zero
    /// before it is trusted: a conservation test in which nothing ever leaked passes against any
    /// implementation at all.
    #[test]
    fn conservation_holds_with_both_fees_and_penalties_nonzero() {
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mut r = fresh_round();

        // Deliberately RAGGED stakes, so a fee that rounded the wrong way or was counted once for
        // two entries shows up as a mismatch rather than cancelling.
        for (i, side, stake) in [(1u8, 0u8, 1_000_003u64), (2, 0, 2_500_000), (3, 1, 1_800_007), (4, 1, 900_000)] {
            credit_entry(&mut r, pk(i), side, stake, FEE_BPS).unwrap();
        }
        let gross_charged = 1_000_003 + 2_500_000 + 1_800_007 + 900_000u64;
        assert!(r.fees_collected > 0, "the fee must actually have been charged");

        let check = |r: &Round, where_: &str| {
            let (players_hold, house_took, gross_deposits) = books(r);
            assert_eq!(players_hold + house_took, gross_deposits, "conservation {}", where_);
            // ...and `gross_deposits` really is what players paid, not a number derived to fit.
            assert_eq!(gross_deposits, gross_charged, "gross {}", where_);
        };
        check(&r, "at lobby close");

        r.phase = Phase::Fight as u8;
        let n = r.fighter_count as usize;

        // An early extract, priced steeply, and a late one priced at almost nothing — so the penalty
        // total is the sum of two genuinely different rates rather than one doubled.
        advance_fight(&mut r.fighters, n, &seed, 0, 10);
        r.tick_count = 10;
        let (kept, penalty) = split_extraction(r.fighters[0].hp, n, 10);
        assert!(penalty > 0, "the early extractor must actually be charged");
        r.fighters[0].banked += kept; r.fighters[0].hp = 0; r.fighters[0].dead = 1;
        r.penalties_collected += penalty;
        check(&r, "after the early extract");

        advance_fight(&mut r.fighters, n, &seed, 10, 170);
        r.tick_count = 180;
        assert!(r.fighters[1].hp > 0, "the late extractor must still be standing at cursor 180");
        let (kept, penalty) = split_extraction(r.fighters[1].hp, n, 180);
        r.fighters[1].banked += kept; r.fighters[1].hp = 0; r.fighters[1].dead = 1;
        r.penalties_collected += penalty;
        check(&r, "after the late extract");

        advance_fight(&mut r.fighters, n, &seed, 180, MAX_STEPS - 180);
        r.tick_count = MAX_STEPS;
        check(&r, "at the end of the fight");

        // BOTH terms carried weight. Without this the identity above could hold vacuously.
        assert!(r.penalties_collected > 0 && r.fees_collected > 0);

        // THE DECOMPOSITION, WHICH IS THE PART THAT IS ACTUALLY FALSIFIABLE. The fee cancels out of
        // the identity above — it never entered the ring — so these two halves are what a mutation
        // has to survive: the ring conserves against the NET pot, and the gross is the pot plus the
        // fee. Drop the fee from `credit_entry` and the second line fails.
        let (players_hold, _, _) = books(&r);
        assert_eq!(players_hold + r.penalties_collected, r.pot, "the ring conserves against the pot");
        assert_eq!(r.pot + r.fees_collected, gross_charged, "the gross is the pot plus the fee");
    }

    /// THE SWEEP MOVES A ROUND'S TAKE ONCE — and the second attempt is refused rather than ignored.
    ///
    /// A permissionless instruction that silently no-ops on a repeat would be the friendlier design
    /// and the wrong one: `sweep_house_take` is the only writer of a running total, and "did my sweep
    /// land" must have a truthful answer. Refusing says so; succeeding-having-done-nothing does not.
    #[test]
    fn the_sweep_cannot_be_double_claimed() {
        let mut r = fresh_round();
        credit_entry(&mut r, pk(1), 0, 1_000_000, FEE_BPS).unwrap();
        credit_entry(&mut r, pk(2), 1, 1_000_000, FEE_BPS).unwrap();

        // A REAL extract at the opening bell rather than a fabricated penalty total. The difference
        // is not pedantry: a penalty that did not come out of somebody's `hp` breaks conservation,
        // and the assertion further down would then be checking a round that could not exist. (It
        // caught exactly that while this test was being written.)
        let (kept, penalty) = split_extraction(r.fighters[0].hp, 2, 0);
        assert_eq!(penalty, 199_600, "20% of 998_000 at the opening bell");
        r.fighters[0].banked += kept; r.fighters[0].hp = 0; r.fighters[0].dead = 1;
        r.penalties_collected += penalty;
        r.phase = Phase::Settled as u8;

        let mut t = fresh_treasury();
        let (fees, penalties) = apply_sweep(&mut r, &mut t).unwrap();
        assert_eq!((fees, penalties), (4_000, 199_600));
        assert_eq!((t.fees_accrued, t.penalties_accrued, t.rounds_swept), (4_000, 199_600, 1));
        assert!(r.house_swept);

        // Again, and it must refuse. Checked on the TOTALS as well as the error, because the failure
        // that matters is not "an error was not returned" — it is a treasury that grew twice.
        assert!(apply_sweep(&mut r, &mut t).is_err(), "a swept round must never be swept again");
        assert_eq!((t.fees_accrued, t.penalties_accrued, t.rounds_swept), (4_000, 199_600, 1));

        // THE RECORD SURVIVES THE SWEEP. Zeroing the round's totals would have made the flag
        // unnecessary — and would have destroyed the numbers every conservation check is run
        // against, turning a settled round into one whose books no longer balance.
        assert_eq!((r.fees_collected, r.penalties_collected), (4_000, 199_600));
        let (players_hold, house_took, gross_deposits) = books(&r);
        assert_eq!(players_hold + house_took, gross_deposits, "a swept round still balances");

        // A SECOND ROUND ACCUMULATES ON TOP rather than replacing — the whole point of the account.
        let mut r2 = fresh_round();
        r2.round_no = 2;
        credit_entry(&mut r2, pk(3), 0, 5_000_000, FEE_BPS).unwrap();
        r2.phase = Phase::Abandoned as u8;   // an under-subscribed lobby still charged its one entry
        apply_sweep(&mut r2, &mut t).unwrap();
        assert_eq!((t.fees_accrued, t.penalties_accrued, t.rounds_swept), (14_000, 199_600, 2));
    }

    /// THE PHASE GUARD, AND IT IS THE ONE THAT MAKES PERMISSIONLESSNESS SAFE. `open_round` runs
    /// before `delegate_round`, so a brand-new round is briefly undelegated, on the base layer, in
    /// `Lobby`, with nothing collected yet. Without this guard any passer-by could sweep it in that
    /// window — taking nothing, setting `house_swept`, and permanently forfeiting every fee the
    /// round went on to collect. A one-way flag may only be settable once the number it guards can
    /// no longer move.
    #[test]
    fn an_unfinished_round_cannot_be_swept() {
        for phase in [Phase::Lobby, Phase::Drawing, Phase::Fight] {
            let mut r = fresh_round();
            credit_entry(&mut r, pk(1), 0, 1_000_000, FEE_BPS).unwrap();
            r.phase = phase as u8;

            let mut t = fresh_treasury();
            assert!(apply_sweep(&mut r, &mut t).is_err(), "phase {} must not be sweepable", phase as u8);
            assert!(!r.house_swept, "a refused sweep must not have set the flag");
            assert_eq!((t.fees_accrued, t.rounds_swept), (0, 0));
        }

        // Both terminal phases ARE sweepable — an abandoned lobby can hold a fee from the one entry
        // it took before it died, and that fee is owed to the house exactly like any other.
        for phase in [Phase::Settled, Phase::Abandoned] {
            let mut r = fresh_round();
            credit_entry(&mut r, pk(1), 0, 1_000_000, FEE_BPS).unwrap();
            r.phase = phase as u8;
            let mut t = fresh_treasury();
            assert_eq!(apply_sweep(&mut r, &mut t).unwrap(), (2_000, 0));
        }
    }

    /// THE CEILING, AND WHAT IT ACTUALLY BOUNDS. `set_fee_bps` re-opens a decision that used to be
    /// welded to `init_arena`, so this constant is the whole answer to "how much can the house raise
    /// the rake to" — and the answer has to hold at the boundary and for every stake, not just for
    /// the rates anyone expects to use.
    #[test]
    fn the_entry_fee_can_never_exceed_the_ceiling() {
        assert_eq!(MAX_FEE_BPS, 1_000, "the published ceiling is 10%");
        assert!((MAX_FEE_BPS as u64) < BPS, "a fee at or above 100% would take the whole stake");

        for bps in [0u64, 1, 20, 100, 500, MAX_FEE_BPS as u64] {
            for stake in [1u64, 2, 999, 1_000, 1_000_003, u64::MAX / 2, u64::MAX] {
                let (net, fee) = split_entry(stake, bps);
                // Exact, in both directions: nothing is created and nothing is lost to the split.
                assert_eq!(net.checked_add(fee), Some(stake), "the split must be exact");
                // Never more than the ceiling, whatever the rate asked for — this is the promise.
                assert!(fee <= stake / 10, "fee {} over a tenth of {} at {} bps", fee, stake, bps);
                // ...and never more than the rate asked for either, because it FLOORS.
                assert!((fee as u128) * BPS as u128 <= stake as u128 * bps as u128);
            }
        }

        // THE OVERFLOW THAT USED TO EXIST. `stake.checked_mul(fee_bps)? / BPS` returned MathOverflow
        // for any stake above `u64::MAX / fee_bps` — refusing a legitimate entry over an intermediate
        // that never needed to be 64 bits wide. The u128 intermediate makes it not a failure case.
        assert_eq!(split_entry(u64::MAX, 20), (u64::MAX - 36_893_488_147_419_103, 36_893_488_147_419_103));
        // Free entry is a legal configuration and must cost exactly nothing.
        assert_eq!(split_entry(1_000_000, 0), (1_000_000, 0));
    }
}
