// SANDBOX. Seeded PRNG so every table in HOUSE-EDGE-STUDY.md is reproducible from the seed printed
// beside it. This drives LOBBY GENERATION ONLY — the fight itself is driven by sha256(seed ‖ step),
// exactly as on chain, and never by this.

/** mulberry32 — small, fast, good enough for choosing stake sizes; not for anything adversarial. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
