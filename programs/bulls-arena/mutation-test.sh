#!/bin/bash
# MUTATION TESTS FOR THE FIGHT — a test that survives its own mutation is decoration.
#
#   ./programs/bulls-arena/mutation-test.sh
#
# Every mutation below REVERTS one line of a fix that shipped, and names the test that must fail as a
# result. A mutation reported as SURVIVED means the named test does not actually constrain the
# behaviour it is named after — which is the failure mode this repo has already been bitten by twice:
# a parity fixture that never executed the branches it protected, and a typecheck that checked zero
# files. Both were green. Green is not the same as guarded.
#
# The three groups came from the sessions that fixed the economics, and each guards a defect that was
# found by MEASUREMENT rather than review:
#   1. the biased defender draw          — `(d+1)%n` made one slot unreachable and another twice as likely
#   2. the defender-only damage basis    — let an exhausted attacker annihilate a healthy defender
#   3. off-by-one variants of the fix    — the near misses that a single happy-path test would not catch
#
# HOW IT EDITS THE PROGRAM, and why that is safe here. Each mutation rewrites exactly one anchor in
# `src/lib.rs`, runs one named test, and restores. `python3` asserts the anchor matches EXACTLY ONCE,
# so a patch that would hit the wrong place fails loudly instead of silently mutating something else.
# The script refuses to start if lib.rs has uncommitted changes — a hard kill mid-run would otherwise
# restore over your work — and re-verifies the restore at the end against git itself.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LIB="$HERE/src/lib.rs"
BAK="$(mktemp -t bulls-arena-lib.XXXXXX.rs)"

cd "$REPO"

# macOS: cargo test links against libiconv and will not find it without the SDK on the library path.
# Failing here reads as a broken toolchain rather than a missing env var, so it is set rather than
# documented.
if command -v xcrun >/dev/null 2>&1; then
  SDKROOT="$(xcrun --show-sdk-path)"; export SDKROOT
  export LIBRARY_PATH="$SDKROOT/usr/lib:${LIBRARY_PATH:-}"
fi

# THE GUARD. This script's whole method is "edit the program, run a test, put it back". If it is
# killed between the edit and the restore, the trap does not run and the working copy keeps a
# mutation — which, against an uncommitted lib.rs, is unrecoverable. Committed work is always
# recoverable with git, so that is the bar.
if ! git diff --quiet -- "$LIB" || ! git diff --cached --quiet -- "$LIB"; then
  echo "REFUSING TO RUN: $LIB has uncommitted changes."
  echo "This script rewrites it in place and restores afterwards; if it is killed mid-run, your"
  echo "uncommitted work is what gets overwritten. Commit or stash lib.rs first."
  exit 1
fi

cp "$LIB" "$BAK"
restore() { cp "$BAK" "$LIB"; }
trap 'restore; rm -f "$BAK"' EXIT

# THE TOOLCHAIN IS PINNED, and not as a preference. This repo has no `rust-toolchain.toml`, so
# `cargo test -p bulls-arena` picks up whatever rustup's default is — 1.85.1 on this machine — and
# fails before running a single test, because solana-address and seven of its siblings require
# 1.89.0. The failure is a dependency-resolution error, so a script that did not pin would report
# BASELINE IS RED and look exactly like a broken test.
#
# Overridable, because pinning a version in a script is how a script stops working in eighteen
# months. A repo-level `rust-toolchain.toml` would be the better fix and would make plain
# `cargo test` work for everyone; it is deliberately not done here, because it changes how every
# other build in this workspace resolves and the program is live.
TOOLCHAIN="${BULLS_TOOLCHAIN:-1.89}"
if ! rustup run "$TOOLCHAIN" rustc --version >/dev/null 2>&1; then
  echo "REFUSING TO RUN: rust toolchain '$TOOLCHAIN' is not installed."
  echo "  install it with:  rustup toolchain install $TOOLCHAIN"
  echo "  or point this at another one:  BULLS_TOOLCHAIN=<name> $0"
  exit 1
fi
CARGO_TEST=(cargo "+$TOOLCHAIN" test -p bulls-arena --lib)
run_one() { "${CARGO_TEST[@]}" "$1" -- --exact >/dev/null 2>&1 && echo PASS || echo FAIL; }

survived=0

# $1 label · $2 anchor · $3 replacement · $4.. tests that MUST fail
mutate() {
  local label="$1" old="$2" new="$3"; shift 3
  restore
  if ! python3 - "$LIB" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
n = src.count(old)
assert n == 1, f"anchor matched {n} times, need exactly 1"
open(path, "w").write(src.replace(old, new))
PY
  then
    echo "  !! patch anchor no longer matches — the code moved: $label"
    survived=$((survived + 1))
    return
  fi
  echo "MUTATION: $label"
  for t in "$@"; do
    if [ "$(run_one "$t")" = FAIL ]; then
      echo "  caught by            $t"
    else
      echo "  *** SURVIVED         $t   <- that test is decoration"
      survived=$((survived + 1))
    fi
  done
  restore
}

echo "=== baseline: every named test must PASS before any mutation means anything ==="
for t in parity_tests::the_defender_draw_is_uniform_over_everyone_but_the_attacker \
         parity_tests::no_blow_can_move_more_than_the_attackers_own_ring \
         parity_tests::an_exhausted_attacker_cannot_annihilate_a_healthy_defender \
         parity_tests::run_fight_matches_the_typescript_mirror_exactly; do
  r="$(run_one "$t")"
  echo "  $r  $t"
  [ "$r" = PASS ] || { echo "BASELINE IS RED — fix that first; mutation results would be meaningless."; exit 1; }
done
echo

echo "=== 1. the fixes themselves ==="
mutate "defender draw reverted to the (d+1)%n bump" \
'    let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % (n - 1);
    if d >= a { d += 1; }' \
'    let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % n;
    if d == a { d = (d + 1) % n; }' \
  parity_tests::the_defender_draw_is_uniform_over_everyone_but_the_attacker \
  parity_tests::run_fight_matches_the_typescript_mirror_exactly

mutate "damage basis reverted to the defender's ring alone" \
'        let basis = fighters[a].hp.min(fighters[d].hp);' \
'        let basis = fighters[d].hp;' \
  parity_tests::no_blow_can_move_more_than_the_attackers_own_ring \
  parity_tests::run_fight_matches_the_typescript_mirror_exactly

mutate "dust clause re-fused to 'hp <= DUST || dmg == 0'" \
'        if fighters[d].hp <= DUST { dmg = fighters[d].hp; }' \
'        if fighters[d].hp <= DUST || dmg == 0 { dmg = fighters[d].hp; }' \
  parity_tests::an_exhausted_attacker_cannot_annihilate_a_healthy_defender

echo
echo "=== 2. near misses on the defender draw — the off-by-ones a happy-path test sails past ==="
D=parity_tests::the_defender_draw_is_uniform_over_everyone_but_the_attacker
mutate "d >= a  ->  d > a      (lets the defender collide with the attacker)" \
  "if d >= a { d += 1; }" "if d > a { d += 1; }" "$D"
mutate "% (n-1)  ->  % n       (reintroduces the collision the fix removed)" \
  "as usize) % (n - 1);" "as usize) % n;" "$D"
mutate "d += 1  ->  d += 2     (skips past the wrong slot)" \
  "if d >= a { d += 1; }" "if d >= a { d += 2; }" "$D"
mutate "shift removed entirely" \
  "if d >= a { d += 1; }" "if false { d += 1; }" "$D"

echo
echo "=== 3. the brawl vector must guard the branches the calm one cannot reach ==="
# THIS GROUP IS WHY `the_mirror_agrees_where_fighters_die_and_blows_round_to_nothing` EXISTS, and the
# distinction is the whole point of it.
#
# `run_fight_matches_the_typescript_mirror_exactly` is the CALM vector: a fixture whose fighters never
# die and whose blows never round to nothing. It is a real test and it catches real drift — groups 1
# and 2 above show it catching the defender draw and the damage basis. But it cannot catch a mutation
# to a branch it never executes, and it never executes the dust clause or the zero-skip. That was the
# original defect here: a parity fixture that never ran the branches it was believed to protect, green
# the entire time.
#
# So only the BRAWL vector is asserted. The calm one is reported alongside it, unasserted, because
# watching it sail past these three is the evidence that the two vectors cover different ground — and
# an assertion that it must fail would be asserting the bug back into existence.
V=parity_tests::the_mirror_agrees_where_fighters_die_and_blows_round_to_nothing
CALM=parity_tests::run_fight_matches_the_typescript_mirror_exactly

observe() {   # runs a test under the CURRENT mutation and reports without asserting
  if [ "$(run_one "$1")" = FAIL ]; then
    echo "  (also caught by       $1)"
  else
    echo "  (as expected, the calm vector does not reach this branch: $1)"
  fi
}

mutate_and_observe() {  # $1 label · $2 anchor · $3 replacement — asserts $V, observes $CALM
  local label="$1" old="$2" new="$3"
  restore
  python3 - "$LIB" "$old" "$new" <<'PY' || { echo "  !! patch anchor no longer matches: $label"; survived=$((survived + 1)); return; }
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
n = src.count(old)
assert n == 1, f"anchor matched {n} times, need exactly 1"
open(path, "w").write(src.replace(old, new))
PY
  echo "MUTATION: $label"
  if [ "$(run_one "$V")" = FAIL ]; then
    echo "  caught by            $V"
  else
    echo "  *** SURVIVED         $V   <- that test is decoration"
    survived=$((survived + 1))
  fi
  observe "$CALM"
  restore
}

mutate_and_observe "Rust re-fuses the dust clause while TS is unchanged" \
'        if fighters[d].hp <= DUST { dmg = fighters[d].hp; }' \
'        if fighters[d].hp <= DUST || dmg == 0 { dmg = fighters[d].hp; }'
mutate_and_observe "Rust drops the dust branch entirely" \
'        if fighters[d].hp <= DUST { dmg = fighters[d].hp; }' \
'        if false { dmg = fighters[d].hp; }'
mutate_and_observe "Rust turns the zero-skip into a kill" \
  "if dmg == 0 { continue; }" "if dmg == 0 { dmg = fighters[d].hp; }"

restore
echo
echo "=== restored — confirming the working copy is byte-identical to HEAD ==="
if git diff --quiet -- "$LIB"; then
  echo "  lib.rs clean"
else
  echo "  *** lib.rs DIFFERS FROM HEAD — restore failed, run: git checkout -- $LIB"
  exit 1
fi
cargo "+$TOOLCHAIN" test -p bulls-arena 2>&1 | grep -E "test result" | head -2

echo
if [ "$survived" -eq 0 ]; then
  echo "ALL MUTATIONS CAUGHT — every named test constrains what it is named after."
else
  echo "$survived MUTATION(S) SURVIVED — see the lines marked above; those tests do not guard their subject."
  exit 1
fi
