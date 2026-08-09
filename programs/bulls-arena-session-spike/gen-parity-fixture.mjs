// ER-051. Computes the exact expected outcome of a fixed (seed, entries, steps) fight using the
// TRUSTED TypeScript mirror (engine/src/er-sim.ts), so the Rust `cargo test` in src/lib.rs has real
// numbers to assert against — not numbers re-derived by hand, which would be the same "read to be
// the same" weakness the parity test exists to eliminate, just with extra steps.
//
// Run from the repo root: node --experimental-strip-types programs/bulls-arena/gen-parity-fixture.mjs
//
// If you change the fixture (different seed/entries/steps), re-run this and paste the printed
// numbers into `parity_tests::run_fight_matches_the_typescript_mirror_exactly` in src/lib.rs.
import { newRound, tick, settle } from "../../engine/src/er-sim.ts";

const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const round = newRound(seed);
round.fighters.push(
  { wallet: "w1", side: 0, dead: 0, stake: 100_000n, hp: 100_000n, banked: 0n },
  { wallet: "w2", side: 0, dead: 0, stake: 250_000n, hp: 250_000n, banked: 0n },
  { wallet: "w3", side: 1, dead: 0, stake: 180_000n, hp: 180_000n, banked: 0n },
  { wallet: "w4", side: 1, dead: 0, stake: 90_000n, hp: 90_000n, banked: 0n },
);

tick(round, 50);
const winner = settle(round);

console.log("seed bytes 0..32, steps=50, winner =", winner);
for (const f of round.fighters) {
  console.log(`${f.wallet}: hp=${f.hp} banked=${f.banked} dead=${f.dead}`);
}
const total = round.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
console.log("total (conservation check):", total);
