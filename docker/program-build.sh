#!/usr/bin/env bash
# The container's entrypoint. Two modes and no arguments beyond them, because a build script that
# takes options is a build script that gets run two different ways and compared anyway.
#
#   program-build           build the .so and the IDL into target/docker/
#   program-build verify    build, then compare against the DEPLOYED bytecode on devnet
#
# `set -euo pipefail` rather than bare `set -e`: this pipes through `tee` and `sha256sum`, and
# without `pipefail` a failing build whose output is piped exits 0 and the script reports success on
# an artifact that was never produced.
set -euo pipefail

MODE="${1:-build}"
PROGRAM_DIR="/build/programs/bulls-arena"
OUT_DIR="/build/target/docker"
PROGRAM_ID="ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe"

echo "toolchain"
echo "  rustc   $(rustc --version)"
echo "  solana  $(solana --version)"
echo "  anchor  $(anchor --version)"
echo

# BUILT FROM programs/bulls-arena, NEVER FROM THE REPO ROOT. The root Anchor.toml declares a program
# that is not a workspace member, at a placeholder id that is not a valid pubkey, and `anchor build`
# there fails with `String is the wrong size` — an error naming neither the file nor the field. This
# `cd` is the whole fix and it is why the Dockerfile has no WORKDIR pointing at the root.
cd "$PROGRAM_DIR"

anchor build

mkdir -p "$OUT_DIR"
SO_SRC="$PROGRAM_DIR/target/deploy/bulls_arena.so"
[ -f "$SO_SRC" ] || { echo "FAILED: anchor build exited 0 but produced no .so at $SO_SRC" >&2; exit 1; }

cp "$SO_SRC" "$OUT_DIR/bulls_arena.so"
[ -f "$PROGRAM_DIR/target/idl/bulls_arena.json" ] \
  && cp "$PROGRAM_DIR/target/idl/bulls_arena.json" "$OUT_DIR/bulls_arena.json"

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
