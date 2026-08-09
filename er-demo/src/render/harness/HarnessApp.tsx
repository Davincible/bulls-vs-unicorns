// TEMPORARY VERIFICATION HARNESS — Phase 4 (snug-floating-mitten.md). NOT part of the real app.
//
// Feeds `PixiCanvas` the exact checked-in parity fixture (`hitEvents.test.ts`'s `FIXTURE_SEED` /
// `FIXTURE_ENTRIES`) so the render layer can be exercised end-to-end — connect, watch a real fight
// play out, confirm impact FX and hp bars track the real `applyHitEvent` math — WITHOUT needing
// Phase 3's store or a live devnet round. Reached at `/harness.html`, a second Vite HTML entry point
// (see that file + `render/harness/main.tsx`) added specifically so this doesn't require touching
// `App.tsx` or `state/store.ts`, both off-limits to this phase (a separate agent owns them
// concurrently this session).
//
// INTEGRATION NOTE for whoever picks this up next: this whole `render/harness/` directory plus
// `harness.html` at the repo root exist ONLY to verify PixiCanvas.tsx in isolation. Once Phase 3's
// `App.tsx` wires `PixiCanvas` in for real (using `render/adapt.ts` on live `useRound()` data), this
// harness has no further purpose and can be deleted — nothing else imports from this directory.
import { useMemo, useState } from "react";
import { settle } from "../../sim/erSim.ts";
import { runFullFight, type HitEventEntry } from "../../sim/hitEvents.ts";
import { fromERFighters } from "../adapt.ts";
import { PixiCanvas } from "../PixiCanvas.tsx";

// Identical to hitEvents.test.ts's FIXTURE_SEED/FIXTURE_ENTRIES/FIXTURE_STEPS — the same fixture
// `programs/bulls-arena/gen-parity-fixture.mjs` generated and `parity_tests::
// run_fight_matches_the_typescript_mirror_exactly` in lib.rs checks against. Reusing the exact
// values (not just "a plausible lineup") means this harness's output is independently checkable
// against numbers already proven correct three ways (TS mirror, Rust parity test, hitEvents.test.ts)
// — if the render layer ever shows a different winner or different final hp/banked than that fixture,
// the render layer itself is the thing that's wrong, not the data feeding it.
const FIXTURE_SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const FIXTURE_ENTRIES: HitEventEntry[] = [
  { wallet: "w1-alpha", side: 0, stake: 100_000n },
  { wallet: "w2-bravo", side: 0, stake: 250_000n },
  { wallet: "w3-charlie", side: 1, stake: 180_000n },
  { wallet: "w4-delta", side: 1, stake: 90_000n },
];
const FIXTURE_STEPS = 50;

/** Real elapsed time compressed into a short demo window: at the real on-chain pace
 *  (`STEPS_PER_SECOND` = 175), the fixture's last event (real step 49) would fire well under a
 *  second in — far too fast to visually verify fighters converging or FX timing. `SPEED_DIVISOR`
 *  multiplies every event's `step` before handing it to `PixiCanvas`, which stretches the SAME
 *  ordering and hit amounts over `SPEED_DIVISOR` times as much wall-clock time (49 * 50 / 175 ≈ 14s)
 *  without touching gameLoop.ts's pacing math at all — `gameLoop.ts` always paces by the real
 *  `STEPS_PER_SECOND` constant, exactly as it must for a live round; this harness just tells it about
 *  a fight whose steps happen to be spaced further apart, which is a legitimate (if synthetic) input,
 *  not a special mode gameLoop.ts needs to know about. */
const SPEED_DIVISOR = 50;

export function HarnessApp() {
  const { round, events } = useMemo(() => {
    const result = runFullFight(FIXTURE_SEED, FIXTURE_ENTRIES, FIXTURE_STEPS);
    settle(result.round); // runFullFight doesn't settle on its own (see hitEvents.ts) — do it here
    // purely so this harness can display the expected winner alongside what's rendered.
    return result;
  }, []);
  const fighters = useMemo(() => fromERFighters(FIXTURE_ENTRIES.map((e) => ({
    wallet: e.wallet, side: e.side, dead: 0 as const, stake: e.stake, hp: e.stake, banked: 0n,
  }))), []);

  // `fightStartedAtMs` is set once at mount and only ever updated explicitly by the "restart
  // playback" button below (never recomputed as a side effect of an unrelated re-render) — a plain
  // `useState` initializer, not a `useMemo` keyed on `runKey`, since the value doesn't derive FROM
  // `runKey`, it's set alongside it.
  const [runKey, setRunKey] = useState(0);
  const [fightStartedAtMs, setFightStartedAtMs] = useState(() => Date.now());
  const restartPlayback = () => {
    setRunKey((k) => k + 1);
    setFightStartedAtMs(Date.now());
  };

  const lastEvent = events[events.length - 1];
  const finalStepScaled = lastEvent ? (Number(lastEvent.step) / 175) * SPEED_DIVISOR : 0;

  return (
    <main style={{ fontFamily: "monospace", padding: 16, color: "#e6e8ef", background: "#05060a", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 16 }}>render/ verification harness — Phase 4 (temporary, see file header)</h1>
      <p>
        fixture: seed=bytes 0..32, {FIXTURE_ENTRIES.length} fighters, {FIXTURE_STEPS} steps &nbsp;|&nbsp;
        expected winner: side {round.winner} &nbsp;|&nbsp; events emitted: {events.length} &nbsp;|&nbsp;
        last event scheduled at real step {lastEvent ? String(lastEvent.step) : "n/a"} (~{finalStepScaled.toFixed(1)}s
        into this harness's {SPEED_DIVISOR}x-slowed playback)
      </p>
      <button type="button" onClick={restartPlayback}>
        restart playback
      </button>
      <div style={{ marginTop: 12 }}>
        <HarnessCanvas key={runKey} fighters={fighters} events={events} fightStartedAtMs={fightStartedAtMs} />
      </div>
    </main>
  );
}

/** Wraps `PixiCanvas` with the scaled-time HitEvent array the harness needs (see `SPEED_DIVISOR`
 *  above) — kept as a tiny separate component so `HarnessApp`'s `key={runKey}` cleanly remounts
 *  (and therefore fully resets) `PixiCanvas` on "restart playback" rather than needing it to notice
 *  a prop change mid-flight. */
function HarnessCanvas({
  fighters,
  events,
  fightStartedAtMs,
}: {
  fighters: ReturnType<typeof fromERFighters>;
  events: ReturnType<typeof runFullFight>["events"];
  fightStartedAtMs: number;
}) {
  const scaledEvents = useMemo(
    () => events.map((e) => ({ ...e, step: e.step * BigInt(SPEED_DIVISOR) })),
    [events],
  );
  return (
    <PixiCanvas
      fighters={fighters}
      hitEvents={scaledEvents}
      fightStartedAtMs={fightStartedAtMs}
      phase="Fight"
    />
  );
}
