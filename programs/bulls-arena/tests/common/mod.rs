//! Shared by the integration tests that run the COMPILED program under LiteSVM.
//!
//! Only the binary loader lives here, and only because it carries the staleness guard — "which `.so`
//! am I actually measuring" is the one question two copies must never answer differently. Everything
//! else each test needs is a few lines of its own setup, which is cheaper to read than to share.

pub(crate) fn repo_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// The compiled program, with the staleness check that stops this from measuring last week's build.
pub(crate) fn program_binary() -> Vec<u8> {
    let so = repo_root().join("target/deploy/bulls_arena.so");
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let build = || -> ! {
        panic!(
            "no usable {} — this test measures the COMPILED program, so it cannot run without one.\n\
             Build it with:\n  \
             PATH=\"$HOME/.local/share/solana/install/active_release/bin:$PATH\" \\\n    \
             cargo-build-sbf --manifest-path programs/bulls-arena/Cargo.toml",
            so.display(),
        )
    };
    let Ok(meta) = std::fs::metadata(&so) else { build() };
    // A binary older than the source is worse than no binary: it measures something that is not the
    // program under test, and it agrees with whatever the last run said.
    if let (Ok(bin_t), Ok(src_t)) = (meta.modified(), std::fs::metadata(&src).and_then(|m| m.modified())) {
        if bin_t < src_t {
            build()
        }
    }
    std::fs::read(&so).unwrap_or_else(|e| panic!("could not read {}: {}", so.display(), e))
}
