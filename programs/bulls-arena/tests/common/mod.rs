//! Shared by the integration tests that run the COMPILED program under LiteSVM.
//!
//! Only the binary loader lives here — "which `.so` am I actually measuring" is the one question two
//! copies must never answer differently. Everything else each test needs is a few lines of its own
//! setup, which is cheaper to read than to share.

pub(crate) fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// The compiled program. `cargo test` does not build it, so its absence is a hard failure with the
/// command that fixes it — a compute gate that silently skips is worth nothing.
///
/// THIS USED TO COMPARE MTIMES AGAINST `src/lib.rs` AND THAT WAS WRONG, in the direction that gets a
/// gate switched off rather than the direction that ships a bug. Git touches mtimes as a matter of
/// routine — `checkout`, `stash`, `worktree`, and committing through anything that rewrites the file
/// — so the guard fired on a binary that matched its source byte for byte, and it fired during an
/// ordinary commit. A check that fails when nothing is wrong teaches people to ignore it, and the
/// one time it is right they will.
///
/// STALENESS IS CAUGHT BEHAVIOURALLY INSTEAD, WHICH IS THE STRONGER CHECK ANYWAY, because it asks
/// whether the binary implements the constants this source declares rather than which file is
/// younger. A `.so` built before this change disagrees with the source on all three constants that
/// matter, and each one is already asserted against the running program:
///
///   * `MAX_FIGHTERS` — `account.rs` fills a lobby and requires that seat 48 is accepted and 49 is
///     refused. A 16-fighter binary refuses seat 17.
///   * `Round::SIZE` — `account.rs` requires the allocated account is exactly `Round::SIZE` bytes.
///     A pre-migration binary allocates 1,102.
///   * `MAX_STEPS_PER_CALL` — `compute.rs` requires a `tick` asking for more than the budget lands
///     exactly on it. A binary with the old flat `MAX_STEPS` lands somewhere else.
///
/// So a stale binary fails with a message about the constant it disagrees on, which is more useful
/// than one about a timestamp, and a merely-touched file says nothing at all.
pub(crate) fn program_binary() -> Vec<u8> {
    let so = repo_root().join("target/deploy/bulls_arena.so");
    std::fs::read(&so).unwrap_or_else(|_| {
        panic!(
            "no {} — this test runs the COMPILED program, so it cannot run without one.\n\
             Build it with:\n  \
             PATH=\"$HOME/.local/share/solana/install/active_release/bin:$PATH\" \\\n    \
             cargo-build-sbf --manifest-path programs/bulls-arena/Cargo.toml",
            so.display(),
        )
    })
}
