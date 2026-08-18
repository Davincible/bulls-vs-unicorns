#!/usr/bin/env bash
# The container's entrypoint. Two modes and no arguments beyond them, because a build script that
# takes options is a build script that gets run two different ways and compared anyway.
#
#   program-build           build the .so and the IDL into target/docker/
#   program-build verify    build, then compare against the DEPLOYED bytecode on devnet
#
# STATUS: NOT YET PRODUCING AN ARTIFACT, AND THE CAUSE IS NOT DOCKER. Everything up to and including
# `anchor build` works — the toolchain installs, the workspace resolves, anchor runs and EXITS 0 —
# but no `bulls_arena.so` appears anywhere under /build afterwards.
#
# This note first blamed "the SBF step failing silently under x86 emulation". That was wrong, and it
# would have sent the next reader hunting an emulation bug that does not exist. `anchor build` does
# exactly the same thing NATIVELY on the host: exit 0, no output, no artifact. The container was
# faithfully reproducing a local breakage.
#
# What works, and what actually built the deployed v9 binary:
#
#     cd programs/bulls-arena && cargo-build-sbf     # -> target/deploy/bulls_arena.so
#
# So the fix here is probably to call `cargo-build-sbf` directly rather than going through `anchor
# build` at all — this image does not need anchor's IDL generation, because `scripts/idlgen.py` owns
# the IDL in this repo and verifies it separately.
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
# v9. NOT hardcoded lightly: v8 (ECD1dX2f...) was CLOSED on 2026-08-18 and a closed program id
# can never be redeployed, so verify mode was pointing at an account that no longer exists.
PROGRAM_ID="FcLNVuH9A354Kcjyctxn422naJ1mDm32QCJxaS7x1vQE"

echo "toolchain"
echo "  rustc   $(rustc --version)"
echo "  solana  $(solana --version)"
echo "  anchor  $(anchor --version)"
echo

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
# the deployed id exactly, which is the single most important thing this build could get wrong.
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
