# sandbox/house-edge

**Nothing in this directory is shipped, deployed, or imported by `engine/`, `er-demo/`, or
`programs/`.** It is a measurement rig for HOUSE-EDGE-STUDY.md at the repo root. It reads
`engine/src/er-sim.ts`; it never writes it.

Run everything from `engine/` (that is where `tsx` lives):

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts                  # RUN THIS FIRST — validates the rig
npx tsx ../sandbox/house-edge/demo-equalizer.ts          # what the deployed fight actually pays
npx tsx ../sandbox/house-edge/check-seat-law.ts          # payout = opposing stake / my side's seats
npx tsx ../sandbox/house-edge/check-positional-bias.ts   # entry order is worth +-15%
npx tsx ../sandbox/house-edge/study-weights.ts  4000 4   # exp 1: what moves ROI by band
npx tsx ../sandbox/house-edge/study-dial.ts     2000 4   # exp 2: the O(n) selection-weight dial
npx tsx ../sandbox/house-edge/study-damage.ts   4000 4   # exp 5: the O(1) damage-basis dial
NODE_OPTIONS=--max-old-space-size=12288 npx tsx ../sandbox/house-edge/study-house.ts 2500  # exp 3
NODE_OPTIONS=--max-old-space-size=12288 npx tsx ../sandbox/house-edge/study-split.ts 2500  # exp 4
```

Every run is seeded (`STUDY_SEED = "house-edge-v1"`, fight seed `sha256("he|<study>|<round>")`) and
reproduces exactly. The heap flag is needed only for the two 16-fighter studies, which retain a lazy
hash table per lobby so that every configuration is scored against identical draws.

## Files

| file | what it is |
|---|---|
| `fight-variant.ts` | the knobbed fight loop. Integer arithmetic only on the hash-to-damage path. |
| `parity.ts` | asserts config `BASELINE` is byte-identical to `engine/src/er-sim.ts`. If this fails, ignore every number the rig produces. |
| `lobby.ts` | lobby generation, bootstrap standard errors, USD/micro-unit conversion. |
| `rng.ts` | mulberry32 — seeds lobbies only, never the fight. |
| `demo-equalizer.ts`, `check-seat-law.ts`, `check-positional-bias.ts` | run against `er-sim.ts` **directly**, not against the variant, so they cannot be accused of measuring the sandbox instead of the game. |
| `study-*.ts` | the five experiments. |
