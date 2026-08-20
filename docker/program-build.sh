#!/usr/bin/env bash
# The container's entrypoint. Two modes and no arguments beyond them, because a build script that
# takes options is a build script that gets run two different ways and compared anyway.
#
#   program-build           build the .so into target/docker/
#   program-build verify    build, then compare against the DEPLOYED bytecode on devnet
#
# IT DOES NOT BUILD AN IDL, AND THAT IS NOT AN OMISSION. `scripts/idlgen.py` owns the IDL in this
# repo and verifies it separately; anchor's generated one is not what ships. An earlier version of
# this header advertised ".so + IDL" and copied `target/idl/bulls_arena.json` if it happened to
# exist, which made the artifact set depend on whether an unrelated step had run.
#
# ============================================================================================
# HOW THIS CAME TO CALL cargo-build-sbf INSTEAD OF anchor build. Kept because the wrong diagnosis
# was written down first, and the correction is the useful part.
#
# The symptom: `anchor build` exited 0 and produced no `bulls_arena.so` anywhere under /build.
#
# FIRST DIAGNOSIS, WRONG: "the SBF step is failing silently under x86 emulation." That would have
# sent the next reader hunting an emulation bug that does not exist. `anchor build` did exactly the
# same thing NATIVELY on the host. The container was faithfully reproducing a local breakage.
#
# WHAT IT ACTUALLY IS: `anchor build` is two steps, and only the first one is the program. It runs
# cargo-build-sbf to produce the `.so`, then compiles the crate AGAIN for the HOST target to extract
# the IDL. The second step links host proc-macros, and that is a different toolchain with different
# ways to fail — on the machine this was diagnosed on it dies at `ld: library not found for -liconv`,
# because `cc` there resolves to a GCC that has no libiconv. The `.so` was fine. Anchor discarded a
# good build over a step this repo does not use.
#
# So the fix is not to make anchor's IDL step work. It is to stop asking for it:
#
#     cd programs/bulls-arena && cargo-build-sbf     # -> target/deploy/bulls_arena.so
#
# which is also what actually built the deployed v9 binary. One step, the one that matters, and no
# second toolchain standing between a correct compile and an artifact.
#
# The image still SHIPS anchor and still prints its version below. That is deliberate: this image
# earned its keep by reproducing host anchor problems (the stale root Anchor.toml, `.devnet/` being
# reachable from a root build context, an anchor 1.0.2 bug where the `overflow-checks` error names
# the workspace root while the check reads the program manifest). Keeping the pinned CLI present
# means it can still do that. The BUILD just no longer depends on it.
# ============================================================================================
#
# `set -euo pipefail` rather than bare `set -e`: the verify path below pipes through `tr` and `wc`,
# and without `pipefail` a failing stage mid-pipe is invisible because only the last stage's status
# survives. That failure mode has already produced a false "success" in this repo.
set -euo pipefail

MODE="${1:-build}"
WORKSPACE="/build"
OUT_DIR="/build/target/docker"
# v9, CONFIRMED against `.devnet/program-keypair-v9.json` rather than copied from a doc: that file's
# pubkey is FcLNVuH9A354Kcjyctxn422naJ1mDm32QCJxaS7x1vQE, and it matches `declare_id!` in
# programs/bulls-arena/src/lib.rs and `[programs.devnet]` in both Anchor.tomls.
#
# NOT hardcoded lightly: v8 (ECD1dX2f...) was CLOSED on 2026-08-18 and a closed program id can never
# be redeployed, so verify mode was pointing at an account that no longer exists.
PROGRAM_ID="FcLNVuH9A354Kcjyctxn422naJ1mDm32QCJxaS7x1vQE"

echo "toolchain"
echo "  rustc   $(rustc --version)"
echo "  solana  $(solana --version)"
echo "  anchor  $(anchor --version)   (installed for parity with the host; NOT used by this build)"
echo

# BUILD FROM THE PROGRAM DIRECTORY. This is the command proven to produce the deployed binary, run
# verbatim rather than reassembled from flags.
#
# It matters less than it used to. Under `anchor build` the working directory chose the anchor
# workspace root and therefore which Anchor.toml and which `[profile.release]` applied, which is why
# this `cd` moved twice during earlier work and why the comments around it ended up contradicting
# each other. cargo has no such ambiguity: it walks up to the real workspace root (/build) from any
# member, so `[profile.release]` in /build/Cargo.toml applies from here, and the artifact lands in
# the WORKSPACE target — /build/target/deploy — not in this directory. That last point is the one
# worth keeping: an earlier version looked for the `.so` next to the source, found nothing, and
# reported a successful build as a failure.
cd "$WORKSPACE/programs/bulls-arena"

# `--locked` IS THE POINT OF THIS IMAGE, not a precaution. A build that may re-resolve its own
# dependency graph is not reproducible, and this repo has already been bitten by exactly that: an
# unpinned `anchor-lang = "^1.0.2"` silently resolved 1.1.2, whose syn 2.0 migration broke session
# signing on a DEPLOYED program with no compile error (see programs/bulls-arena/Cargo.toml). If the
# lockfile does not already satisfy the manifests, this must stop and say so — the compose file
# mounts Cargo.lock read-only, so the alternative is a confusing write failure instead of a clear
# one. `--` separates cargo's arguments from cargo-build-sbf's own.
cargo-build-sbf -- --locked

mkdir -p "$OUT_DIR"
SO_SRC="$WORKSPACE/target/deploy/bulls_arena.so"
[ -f "$SO_SRC" ] || { echo "FAILED: cargo-build-sbf exited 0 but produced no .so at $SO_SRC" >&2; exit 1; }

cp "$SO_SRC" "$OUT_DIR/bulls_arena.so"

BUILT_SIZE="$(stat -c%s "$OUT_DIR/bulls_arena.so")"
BUILT_HASH="$(sha256sum "$OUT_DIR/bulls_arena.so" | cut -d' ' -f1)"
echo
echo "built    $OUT_DIR/bulls_arena.so"
echo "  bytes  $BUILT_SIZE"
echo "  sha256 $BUILT_HASH"

if [ "$MODE" != "verify" ]; then
  echo
  echo "NOT compared against chain. Run \`docker compose run --rm program-build verify\` for that."
  exit 0
fi

# VERIFY MODE. The comparison this makes honest: COST-MODEL.md §7 records a staleness probe that
# reported four ER validators as out of date when the validators were fine and the PROBE was wrong —
# it diffed them against a locally rebuilt .so from a different toolchain. A mismatch below is
# therefore only evidence when the toolchain is the pinned one, which inside this image it is.
echo
echo "comparing against deployed bytecode for $PROGRAM_ID"
solana program dump "$PROGRAM_ID" /tmp/onchain.so --url devnet >/dev/null

# The dump is right-padded with zeros to the allocated program-data length, so a byte-for-byte diff
# against a freshly built .so always differs on length alone. Truncating the dump to the built size
# and comparing the prefix is the comparison that means something — and the trailing bytes are
# checked separately, because "the rest is zeros" is an assumption worth failing on rather than
# trusting.
head -c "$BUILT_SIZE" /tmp/onchain.so > /tmp/onchain-prefix.so
ONCHAIN_HASH="$(sha256sum /tmp/onchain-prefix.so | cut -d' ' -f1)"

echo "  built    $BUILT_HASH"
echo "  onchain  $ONCHAIN_HASH  (first $BUILT_SIZE bytes of $(stat -c%s /tmp/onchain.so))"

if [ "$BUILT_HASH" = "$ONCHAIN_HASH" ]; then
  # COUNTING THE NON-ZERO BYTES, because the previous form of this check could not fail. It was:
  #
  #     if tail -c +$((BUILT_SIZE + 1)) ... | head -c1 | read -r _; then
  #
  # and `read` returns non-zero on input with no trailing newline — which is every possible input
  # here, since `head -c1` emits one raw byte. So the branch was unreachable and the script reported
  # "the tail is all zeros" without ever having looked. A check that cannot fail is worse than no
  # check: it is a claim nobody will re-examine.
  TAIL_NONZERO="$(tail -c +"$((BUILT_SIZE + 1))" /tmp/onchain.so | tr -d '\0' | wc -c)"
  if [ "$TAIL_NONZERO" -ne 0 ]; then
    echo "  MATCH ON THE PREFIX, but $TAIL_NONZERO byte(s) past $BUILT_SIZE are not zero — investigate." >&2
    exit 1
  fi
  echo "  MATCH — the deployed program is this source, built with this toolchain."
else
  echo "  DIFFER — deployed bytecode is not this source under this toolchain."
  echo "  Before concluding the deploy is stale, note that a Rust build is only reproducible"
  echo "  against an identical toolchain; this image pins one, so a difference here is real"
  echo "  ONLY IF the deploy was also made from this image. If it was not, this proves nothing."
  exit 1
fi
