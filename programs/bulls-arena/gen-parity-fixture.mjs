// ER-051. Computes the exact expected outcome of fixed (seed, entries, steps) fights using the
// TRUSTED TypeScript mirror (engine/src/er-sim.ts), so the Rust `cargo test` in src/lib.rs has real
// numbers to assert against — not numbers re-derived by hand, which would be the same "read to be
// the same" weakness the parity test exists to eliminate, just with extra steps.
//
// Run from the repo root: node --experimental-strip-types programs/bulls-arena/gen-parity-fixture.mjs
//
// If you change a fixture (different seed/entries/steps), re-run this and paste the printed numbers
// into `parity_tests` in src/lib.rs.
//
// THERE ARE TWO FIXTURES, AND THE SECOND ONE EXISTS BECAUSE THE FIRST ONE PROVES LESS THAN IT LOOKS.
// `calm` is the original: four healthy fighters, 50 steps, nobody dies, minimum hp ~20,000 — twenty
// times DUST. It never executes `if hp_d <= DUST { dmg = hp_d }` and never executes
// `if dmg == 0 { continue }`. Those two branches are the entire subject of the seat-law fix, and for
// a while they were the only lines in the fight that NO cross-language vector covered: the Rust
// could have disagreed with both mirrors about either one and every test in the repo would still
// have passed. `brawl` is chosen to exercise both — measured, not hoped: 3 dust-finishes, 3
// zero-damage skips, 3 deaths. The 3- and 7-unit entries are legal today (`enter` requires only
// `stake > 0`) and are what reaches the zero-damage path.
import { newRound, tick, settle } from "../../engine/src/er-sim.ts";

const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

const FIXTURES = [
  {
    name: "calm — four healthy fighters, nobody dies",
    steps: 50,
    entries: [
      ["w1", 0, 100_000n],
      ["w2", 0, 250_000n],
      ["w3", 1, 180_000n],
      ["w4", 1,  90_000n],
    ],
  },
  {
    name: "brawl — deaths, dust finishes, and blows that round to nothing",
    steps: 400,
    entries: [
      ["w1", 0, 50_000n],
      ["w2", 0,      3n],   // sub-dust: its blows round to zero and move nothing
      ["w3", 1, 40_000n],
      ["w4", 1,      7n],   // sub-dust on the other side, so neither side is a special case
    ],
  },
];

for (const fx of FIXTURES) {
  const round = newRound(seed);
  for (const [wallet, side, stake] of fx.entries) {
    round.fighters.push({ wallet, side, dead: 0, stake, hp: stake, banked: 0n });
  }
  tick(round, fx.steps);
  const winner = settle(round);

  console.log(`\n=== ${fx.name}`);
  console.log(`seed bytes 0..32, steps=${fx.steps}, winner = ${winner}`);
  for (const f of round.fighters) {
    console.log(`${f.wallet}: hp=${f.hp} banked=${f.banked} dead=${f.dead}`);
  }
  const total = round.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
  const staked = fx.entries.reduce((n, [, , s]) => n + s, 0n);
  console.log(`total (conservation check): ${total}  [staked ${staked}, ${total === staked ? "OK" : "BROKEN"}]`);
}
console.log("");
