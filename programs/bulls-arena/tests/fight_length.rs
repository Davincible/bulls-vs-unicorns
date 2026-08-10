//! HOW LONG A FIGHT ACTUALLY LASTS, measured against the real `advance_fight` rather than described.
//!
//! `PENALTY_HORIZON_STEPS` in `lib.rs` is a table of `C * n^1.5`, and both halves of that — the
//! exponent and the constant — are EMPIRICAL. They were fitted once, by hand, against lineups of at
//! most sixteen, and written into a doc comment. Raising `MAX_FIGHTERS` extrapolates that fit three
//! times past the range it was measured over, which is exactly the move a doc comment cannot justify.
//!
//! So the fit is executable now. This file re-derives it from the same function the chain runs, and
//! the test that matters (`the_penalty_table_still_errs_short_of_the_measured_fight`) asserts the
//! property the table was chosen for rather than the numbers it happens to hold: every horizon sits
//! UNDER the median fight it belongs to, so the penalty reaches zero inside a real round.
//!
//! `--ignored` on the expensive one. The full 400-seed sweep is ~10^8 hashes; the cheap version runs
//! in every `cargo test`.

use anchor_lang::prelude::Pubkey;
use ::bulls_arena::{advance_fight, fight_is_over, penalty_horizon_steps, Fighter, MAX_FIGHTERS};
use solana_sha256_hasher::hashv;

/// THE STAKE BAND THE ARENA ACTUALLY RUNS, in the game's units ($5, $10, $20 at 1e6 units per
/// dollar) — the keeper's `HOUSE_STAKE_MIN/MAX_USD`.
///
/// IT IS A PARAMETER BECAUSE FIGHT LENGTH DEPENDS ON IT, which is a fact the published derivation of
/// `PENALTY_HORIZON_STEPS` never mentions and which this test found the hard way. Damage is a
/// percentage of the smaller ring, so hp decays geometrically and the number of blows to kill goes as
/// `log(stake / DUST)` — a $1 lineup finishes in about three quarters of the steps a $10 one needs.
/// A horizon that sits comfortably inside a $10 fight can therefore equal the whole of a $1 one, and
/// at three fighters it does exactly that. Sweeping the band is the difference between asserting the
/// property and asserting it at one arbitrary point.
const STAKE_BAND: [u64; 3] = [5_000_000, 10_000_000, 20_000_000];

/// A lineup of `n` fighters, equal stakes, distinct wallets. `alternating` lays the sides out
/// 0,1,0,1... (a perfectly matched book); otherwise sides come off the seed, which is the messier and
/// more realistic shape — see `PENALTY_HORIZON_STEPS`, where both rows are tabulated.
fn lineup(n: usize, seed: &[u8; 32], alternating: bool, stake: u64) -> Vec<Fighter> {
    let mut f = Vec::with_capacity(n);
    for i in 0..n {
        let side = if alternating {
            (i % 2) as u8
        } else {
            // Deterministic per (seed, slot) — a "random" assignment that is still reproducible.
            hashv(&[seed.as_ref(), &(i as u64).to_le_bytes()]).to_bytes()[0] & 1
        };
        let mut x = Fighter::default();
        x.wallet = Pubkey::new_from_array([(i as u8).wrapping_add(1); 32]);
        x.side = side;
        x.stake = stake;
        x.hp = stake;
        f.push(x);
    }
    f
}

/// Steps until one side has nobody standing, or `None` if it never happens inside `cap`.
///
/// One step at a time so the answer is exact rather than rounded to a chunk size — the smallest
/// lineups finish in ~70 steps, where a chunked probe would be all error.
fn steps_to_finish(n: usize, seed: &[u8; 32], alternating: bool, stake: u64, cap: u64) -> Option<u64> {
    let mut f = lineup(n, seed, alternating, stake);
    // A lineup that landed entirely on one side is over before it starts and is not a fight; the
    // caller drops it rather than counting a zero into the median.
    if fight_is_over(&f, n) {
        return None;
    }
    for step in 0..cap {
        advance_fight(&mut f, n, seed, step, 1);
        if fight_is_over(&f, n) {
            return Some(step + 1);
        }
    }
    None
}

fn seed_of(s: u64) -> [u8; 32] {
    hashv(&[b"penalty-horizon", &s.to_le_bytes()]).to_bytes()
}

/// Median steps-to-finish over `seeds` draws, and how many draws were actually fights.
fn median_length(n: usize, seeds: u64, alternating: bool, stake: u64) -> (u64, usize) {
    let cap = 3_000 * (n as u64) * (n as u64); // far above C*n^1.5 for any C this game could have
    let mut lengths: Vec<u64> = (0..seeds)
        .filter_map(|s| steps_to_finish(n, &seed_of(s), alternating, stake, cap))
        .collect();
    lengths.sort_unstable();
    assert!(!lengths.is_empty(), "n = {}: no lineup ever finished", n);
    (lengths[lengths.len() / 2], lengths.len())
}

/// The constant the table is built from — `median / n^1.5`, per lineup size.
fn fitted_c(n: usize, median: u64) -> f64 {
    median as f64 / (n as f64).powf(1.5)
}

/// THE PROPERTY THE TABLE EXISTS FOR, and the only one worth asserting: the penalty reaches zero
/// before the fight it belongs to ends.
///
/// Asserted as an INEQUALITY against a fresh measurement rather than as equality against remembered
/// numbers, because the table is a deliberate under-estimate — `PENALTY_HORIZON_STEPS` explains why
/// erring short is the safe direction. An equality test would have to be rewritten every time the
/// measurement moved by one step, and would say nothing about whether the number was still right.
///
/// Cheap enough to run every time: 32 seeds is a coarse median, and the margin it is checked against
/// (the table sits ~30-45% under the measured fit under the shipped damage rule) is far wider than
/// the sampling error at that count.
#[test]
fn the_penalty_table_still_errs_short_of_the_measured_fight() {
    const SEEDS: u64 = 32;
    // EVERY SMALL LINEUP AND A SAMPLE OF THE LARGE ONES. Not a compromise for its own sake: the
    // margin is TIGHTEST at the bottom — the horizon is 65% of a two-fighter fight and under 45% of
    // a forty-eight-fighter one — and cost goes as `n^1.5`, so sweeping the small end exhaustively
    // and the large end sparsely puts the samples where the assertion can actually fail while
    // keeping this inside a second or two of `cargo test`. The full sweep is the ignored test below.
    let lineups = (2..=16).chain((20..=MAX_FIGHTERS).step_by(4));
    for &stake in STAKE_BAND.iter() {
        for n in lineups.clone() {
            let horizon = penalty_horizon_steps(n);
            let (median, fights) = median_length(n, SEEDS, true, stake);
            assert!(fights as u64 >= SEEDS * 3 / 4, "n = {}: only {} of {} draws were fights", n, fights, SEEDS);
            assert!(
                horizon < median,
                "n = {} at a stake of {}: horizon {} is not inside the median fight ({} steps) — the \
                 penalty would still be running when the round ends, which is the failure mode the \
                 table exists to avoid",
                n, stake, horizon, median,
            );
        }
    }
}

/// THE MEASUREMENT ITSELF, at the resolution the published table was derived at. Run it with
///
/// ```text
/// cargo +1.89 test --release -p bulls-arena --test fight_length -- --ignored --nocapture
/// ```
///
/// and read the two `C` columns: the table is `round(C * n^1.5)` for a C chosen under the balanced
/// row and above the random one. If a future change to the fight makes either column drift out of
/// the band printed at the bottom, the table needs re-deriving — not nudging.
#[test]
#[ignore = "the full 400-seed sweep; run it deliberately, see the doc comment"]
fn print_the_fight_length_fit() {
    const SEEDS: u64 = 400;
    println!(
        "\n{:>4} | {:>9} {:>7} | {:>9} {:>7} | {:>8} {:>8}",
        "n", "bal med", "C", "rnd med", "C", "table", "table/n^1.5",
    );
    let (mut bal_lo, mut bal_hi) = (f64::MAX, f64::MIN);
    let (mut rnd_lo, mut rnd_hi) = (f64::MAX, f64::MIN);
    for n in 2..=MAX_FIGHTERS {
        let (bal, _) = median_length(n, SEEDS, true, 10_000_000);
        let (rnd, _) = median_length(n, SEEDS, false, 10_000_000);
        let (cb, cr) = (fitted_c(n, bal), fitted_c(n, rnd));
        let table = penalty_horizon_steps(n);
        bal_lo = bal_lo.min(cb); bal_hi = bal_hi.max(cb);
        rnd_lo = rnd_lo.min(cr); rnd_hi = rnd_hi.max(cr);
        println!(
            "{:>4} | {:>9} {:>7.1} | {:>9} {:>7.1} | {:>8} {:>11.1}",
            n, bal, cb, rnd, cr, table, fitted_c(n, table),
        );
    }
    println!(
        "\nC over lineups 2..={}:  balanced {:.1}..{:.1}   random {:.1}..{:.1}",
        MAX_FIGHTERS, bal_lo, bal_hi, rnd_lo, rnd_hi,
    );
}
