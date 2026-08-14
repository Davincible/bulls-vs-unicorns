#!/usr/bin/env bash
# The container's entrypoint. Two modes and no arguments beyond them, because a build script that
# takes options is a build script that gets run two different ways and compared anyway.
#
#   program-build           build the .so and the IDL into target/docker/
#   program-build verify    build, then compare against the DEPLOYED bytecode on devnet
#
# STATUS: NOT YET PRODUCING AN ARTIFACT, and that is stated here rather than discovered. Everything
# up to and including `anchor build` works — the toolchain installs, the workspace resolves, anchor
# runs and EXITS 0 — but no `bulls_arena.so` appears anywhere under /build afterwards (checked with
# `find`, in both the workspace target and the program-local one). Something in the SBF step is
# failing silently under x86 emulation.
#
# THE LOCAL BUILD IS UNAFFECTED: `cd programs/bulls-arena && anchor build` on the host works and is
# what the deploy uses. This image is a reproducibility nicety, not a dependency of shipping.
#
# It has already earned its keep by finding three things the host was silently tolerating: the stale
# root Anchor.toml (see its header), `.devnet/` being reachable from a root build context (see the
# .dockerignore), and an anchor 1.0.2 bug where the `overflow-checks` error names the workspace root
# while the check reads the program manifest (see programs/bulls-arena/Cargo.toml). Finishing it is
# worth doing; it is not worth blocking a deploy on.
#
# `set -euo pipefail` rather than bare `set -e`: this pipes through `tee` and `sha256sum`, and
# without `pipefail` a failing build whose output is piped exits 0 and the script reports success on
# an artifact that was never produced.
set -euo pipefail

MODE="${1:-build}"
WORKSPACE="/build"
OUT_DIR="/build/target/docker"
PROGRAM_ID="ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe"

echo "toolchain"
echo "  rustc   $(rustc --version)"
echo "  solana  $(solana --version)"
echo "  anchor  $(anchor --version)"
echo

# BUILT FROM THE WORKSPACE ROOT, and this reversed once. The first version of this script built from
# programs/bulls-arena/ because the root Anchor.toml was stale — it declared a non-member program at
# an invalid pubkey and failed with `String is the wrong size`. That workaround then caused a SECOND
# failure that took longer to understand: `anchor build` treats the directory holding Anchor.toml as
# the workspace root, so building from programs/bulls-arena/ meant `[profile.release]` in the ROOT
# Cargo.toml no longer applied, and a source-built anchor refused with
#
#     Error: `overflow-checks` is not enabled
#
# while `overflow-checks = true` sat on line 30 of the very file it was declining to read. Both
# errors had one cause, and the root Anchor.toml is now repaired instead — see its header. The cargo
# workspace root and the anchor workspace root are the same directory again, which is the only
# arrangement in which a profile setting means what it says.
# Build from the PROGRAM directory. Proven, not assumed: this is the only configuration observed
# to compile in this container. From the workspace root, `anchor build` tries to build both members
# and dies on `bulls-arena-session-spike`, whose keypair lives in the `.devnet/` this image refuses
# to import; and `-p` rejects both `bulls_arena` and `bulls-arena`. From here it builds one program
# and writes to the real cargo workspace target, which is why SO_SRC below points at $WORKSPACE and
# not at this directory — an earlier version looked here, found nothing, and reported a build that
# had actually succeeded as a failure.
cd "$WORKSPACE/programs/bulls-arena"

# `-p bulls_arena` RATHER THAN A BARE `anchor build`, and this is forced by the security boundary
# rather than being an optimisation.
#
# The workspace has two members. The second, `bulls-arena-session-spike`, is a scratch program whose
# `declare_id!` is pinned to a keypair living in `.devnet/` — and `.devnet/` is exactly what
# `program-build.Dockerfile.dockerignore` exists to keep out of this container, because it also holds
# the arena authority and forty-eight house wallet secret keys. So anchor cannot see that keypair,
# generates a fresh one, and refuses the whole build on a mismatch it created itself:
#
#     Error: Program ID mismatch detected for program 'bulls_arena_session_spike'
#
# Building only `bulls_arena` is therefore the correct resolution and not a workaround: the spike is
# not deployed, not part of the artifact, and CANNOT be built here without importing the very
# directory this image refuses to import. `--ignore-keys` would also silence it, and is rejected —
# it disables the check for BOTH programs, including the one whose id must match the deployed
# ECD1dX2f... exactly, which is the single most important thing this build could get wrong.
anchor build

mkdir -p "$OUT_DIR"
SO_SRC="$WORKSPACE/target/deploy/bulls_arena.so"
[ -f "$SO_SRC" ] || { echo "FAILED: anchor build exited 0 but produced no .so at $SO_SRC" >&2; exit 1; }

cp "$SO_SRC" "$OUT_DIR/bulls_arena.so"
[ -f "$WORKSPACE/target/idl/bulls_arena.json" ] \
  && cp "$WORKSPACE/target/idl/bulls_arena.json" "$OUT_DIR/bulls_arena.json"

BUILT_HASH="$(sha256sum "$OUT_DIR/bulls_arena.so" | cut -d' ' -f1)"
echo
echo "built    $OUT_DIR/bulls_arena.so"
echo "  bytes  $(stat -c%s "$OUT_DIR/bulls_arena.so")"
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
BUILT_SIZE="$(stat -c%s "$OUT_DIR/bulls_arena.so")"
head -c "$BUILT_SIZE" /tmp/onchain.so > /tmp/onchain-prefix.so
ONCHAIN_HASH="$(sha256sum /tmp/onchain-prefix.so | cut -d' ' -f1)"

echo "  built    $BUILT_HASH"
echo "  onchain  $ONCHAIN_HASH  (first $BUILT_SIZE bytes of $(stat -c%s /tmp/onchain.so))"

if [ "$BUILT_HASH" = "$ONCHAIN_HASH" ]; then
  if tail -c +"$((BUILT_SIZE + 1))" /tmp/onchain.so | tr -d '\0' | head -c1 | read -r _; then
    echo "  MATCH ON THE PREFIX, but the tail past $BUILT_SIZE is not all zeros — investigate." >&2
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
