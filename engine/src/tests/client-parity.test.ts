// PROVABLE FAIRNESS DEPENDS ON THIS TEST.
//
// The browser recomputes every round from the revealed seed and checks it against the engine —
// that is what the "Verify last round" button does, and what lets a player trust a result they did
// not compute. It only works because web/index.html contains a hand-written JS port of
// engine/src/game.ts. Two implementations of the same physics, kept in sync by hand.
//
// Any divergence silently breaks the guarantee: the replay desyncs, verification reports a
// mismatch, and the fighters on screen stop matching the money. Tuning the physics (radius floor,
// knockback, hit cooldown) means editing FIVE copies, so this test extracts the real port out of
// the shipped HTML and runs it against the engine on identical input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { simulateRound, type Entry } from "../game.ts";
import { newRoundConfig } from "../round.ts";

const HTML = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "web", "index.html");

/** Pull the client's sim port out of index.html and evaluate it in isolation. */
function loadClientSim(): (seed: string, entries: any[], cfg: any) => any {
  const html = readFileSync(HTML, "utf8");
  const start = html.indexOf("function xmur3(str)");
  // the final statement of simulateRoundJS - line-ending agnostic, unlike hunting for a brace
  const tailMark = 'return {winner:bullV>=uwuV?"bull":"uwu",hits:s.hits,settlement};';
  const tailIdx = html.indexOf(tailMark);
  assert.ok(start > 0 && tailIdx > start, "could not locate the client sim block in index.html");
  // helpers the sim block relies on but which live further up index.html (line ~355)
  const prelude = "const clamp=(v,a,b)=>v<a?a:v>b?b:v, rand=(a,b)=>a+Math.random()*(b-a);";
  const src = prelude + String.fromCharCode(10)
            + html.slice(start, tailIdx + tailMark.length) + String.fromCharCode(10) + "}";
  return new Function(src + ";return simulateRoundJS;")();
}

const lobby = (): Entry[] => {
  const sides = ["bull", "uwu"] as const;
  const out: Entry[] = [];
  // deliberately mixed sizes: dust, mid and whale, so caps/finisher/dust paths all run
  const stakes = [0.5, 0.5, 1.2, 3, 7.5, 0.8, 22, 41, 0.5, 9];
  stakes.forEach((stake, i) => out.push({ id: "p" + i, side: sides[i % 2], stake }));
  return out;
};

for (const mode of ["normal", "extraction"] as const) {
  test(`client replay matches the engine exactly — ${mode}`, () => {
    const simulateRoundJS = loadClientSim();
    const entries = lobby();
    const cfg = newRoundConfig(mode, 1);
    const seed = "parity-seed-" + mode;

    const eng = simulateRound(seed, entries, cfg);
    const cli = simulateRoundJS(seed, entries.map(e => ({ id: e.id, side: e.side, stake: e.stake })), cfg);

    assert.equal(cli.winner, eng.winner, "winner must agree");
    assert.equal(cli.hits.length, eng.hits.length, "hit count must agree");

    let worst = 0;
    for (const [k, v] of Object.entries(eng.settlement)) {
      const m = cli.settlement[k];
      assert.ok(m, `client is missing a settlement entry for ${k}`);
      worst = Math.max(worst, Math.abs((v as any).bull - m.bull), Math.abs((v as any).uwu - m.uwu));
    }
    assert.ok(worst < 1e-9, `settlement diverged by ${worst} — the browser would fail verification`);
  });
}

test("the two ports share identical physics constants", () => {
  const html = readFileSync(HTML, "utf8");
  const engine = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "game.ts"), "utf8");

  const eCombat = engine.match(/COMBAT = \{ speed: (\d+), accel: (\d+), hitCd: (\d+), knock: (\d+) \}/);
  assert.ok(eCombat, "engine COMBAT shape changed — update this test");
  const [, spd, acc, cd, knock] = eCombat;

  // every client copy of the tuning must carry the same numbers
  const clientCombats = [...html.matchAll(/SCOMBAT(?:_N)?=\{speed:(\d+),accel:(\d+),hitCd:(\d+),knock:(\d+)\}/g)];
  assert.ok(clientCombats.length >= 2, "expected the 2-team and N-team client constants");
  for (const c of clientCombats) {
    assert.deepEqual([c[1], c[2], c[3], c[4]], [spd, acc, cd, knock], "client physics constants drifted from the engine");
  }

  // radius formula: floor, coefficient and cap must match across every copy
  const eRad = engine.match(/clamp\((\d+) \+ ([\d.]+) \* Math\.sqrt\(ring\(f\)\), (\d+), (\d+)\)/);
  assert.ok(eRad, "engine radiusFor shape changed — update this test");
  const rads = [...html.matchAll(/clamp\((\d+)\+([\d.]+)\*Math\.sqrt\([a-zA-Z]+\([a-zA-Z]\)\),(\d+),(\d+)\)/g)];
  assert.ok(rads.length >= 3, "expected renderer + 2-team verifier + N verifier radius copies");
  for (const r of rads) {
    assert.deepEqual([r[1], r[2], r[3], r[4]], [eRad[1], eRad[2], eRad[3], eRad[4]],
                     "a client radius formula drifted from the engine");
  }
});
