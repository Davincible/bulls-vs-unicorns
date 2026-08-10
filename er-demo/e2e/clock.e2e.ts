// DEFECT #1 — A PHASE RENDERING A CLOCK THAT IS NOT RUNNING.
//
// THE INCIDENT. All three compact clock surfaces — the top bar's telemetry, 00-1's hero, and the
// strip over the field — rendered `clock(live.elapsedSec)` unconditionally. That is the FIGHT clock,
// and outside a fight it is zero. A lobby the keeper was deliberately holding open at no cost until
// a real player arrived therefore printed `0:00` in three places at once. `0:00` on a countdown means
// the time is up; nothing was up. A visitor read a broken clock over the healthiest resting state
// this arena has.
//
// WHERE THE THIRD ONE IS NOW, because "the strip over the field" stopped being true and the count
// below did not. The field's clock is background ink on the canvas — the third row of the scoreboard
// watermark, centred under `ROUNDS WON · N SETTLED` (`arena/scoreboard.ts`). Painted ink cannot be
// queried, so that surface renders `RoundClockSlot` at `.sr` beside the canvas as its text
// alternative, and the canvas is handed the same `ClockSlot` object rather than a number. That is
// what keeps this file's assertion meaningful: three surfaces, one decision, and the largest of them
// still has a handle. A change that deleted the `.sr` node would take a clock off the accessibility
// tree and out of this suite in the same move, which is why it must not be treated as spare markup.
//
// THE FIX WAS `ClockSlot` + `RoundClockSlot`, and `roundPhaseCopy.test.ts` already holds the
// DECISION: given a round, a clock and a keeper cadence, what belongs in the slot. What no unit test
// can hold is whether the three surfaces actually ASK — the original bug was three call sites that
// never consulted anything. That is what this file checks, on the assembled page, in every phase.
//
// THE RULE, STATED PRECISELY, because "shows a clock only when one is ticking" is not quite it:
//
//   Lobby, held open    no figure. The word OPEN. Nothing counts, because nothing is waiting on a
//                       clock — the lobby is waiting on a person.
//   Lobby, closing      a figure, and it DECREASES as time passes. A countdown that does not count
//                       down is the defect wearing a different number.
//   Drawing             no figure. `—`. There is no deadline on a VRF draw.
//   Fight               a figure, and it INCREASES. This one counts up: it is how long the fight has
//                       been running, which is what the step gauge beside it is measured against.
//   Settled             a figure, and it is STATIC — legitimately so. It is a completed duration
//                       ("the fight ran for 1:34"), not a countdown, and `clockSlotFor` says so in
//                       as many words. This test asserts it does not move, so that a future change
//                       that made it live would have to come here and say why.
//   Any phase           never `0:00`. That string is the whole incident.
//
// `Abandoned` is not covered: the fixture round never reaches it (`useFixtureRound.ts` runs
// Lobby → Drawing → Fight → Settled and stops), and there is no flag that produces one. Its branch —
// `noClock()`, on the grounds that `elapsedSec` is 0 because no fight ever started — is held by
// `roundPhaseCopy.test.ts` and by nothing here.

import { describe, expect, it } from "vitest";
import {
  DRAWING_ENDS_SEC,
  FIGHT_ENDS_SEC,
  LOBBY_ENDS_SEC,
  VIEWS,
  assertNoPageErrors,
  clockSlots,
  goToView,
  keeperStates,
  open,
  phaseWord,
  useBrowser,
  until,
  waitForPhase,
} from "./harness.ts";

/** `0:07`, `12:40` — a figure, as `contract.ts#clock` formats one. */
const CLOCK_FIGURE = /^\d+:\d\d$/;

/** Seconds behind a `m:ss` figure, so two readings can be compared as numbers rather than as text. */
function seconds(figure: string): number {
  const [m, s] = figure.split(":");
  return Number(m) * 60 + Number(s);
}

/** Every slot on screen, once the page has settled into `phase`. Fails loudly if the page renders no
 *  slot at all — an empty list would make every assertion below trivially true, which is precisely
 *  the kind of green this suite exists not to produce. */
async function slotsIn(session: Awaited<ReturnType<typeof open>>, phase: string): Promise<string[]> {
  await waitForPhase(session.page, phase);
  const slots = await clockSlots(session.page);
  expect(slots.length, `no clock slot rendered in ${phase}`).toBeGreaterThan(0);
  return slots;
}

describe("the round clock", () => {
  const browser = useBrowser();

  it("says OPEN rather than 0:00 while the keeper holds the lobby open for a real player", async () => {
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      // Arena is the screen with all three slots on it — the exact three that printed 0:00.
      const slots = await slotsIn(s, "LOBBY");
      expect(slots.length, "arena should carry three clock slots").toBe(3);
      expect(slots).toEqual(["OPEN", "OPEN", "OPEN"]);

      // AND IT STAYS OPEN AS TIME PASSES. A slot that said OPEN once and then began counting the
      // backstop down would pass a single-reading assertion and be the original defect at a
      // different number.
      await s.tick(3);
      expect(await clockSlots(s.page), "held-open lobby began counting something").toEqual([
        "OPEN",
        "OPEN",
        "OPEN",
      ]);

      assertNoPageErrors(s, "held-open lobby");
    } finally {
      await s.close();
    }
  });

  it("counts a committed lobby deadline down, and the figure actually moves", async () => {
    // The keeper has a real player in the room and has published when it will close entries.
    const s = await open(browser(), { keeper: keeperStates.closingLobby(30) });
    try {
      const before = await slotsIn(s, "LOBBY");
      expect(before.length).toBe(3);
      for (const slot of before) expect(slot).toMatch(CLOCK_FIGURE);
      // Everything on screen agrees, because all three read one `useRoundPhase()` object.
      expect(new Set(before).size, `slots disagreed: ${before.join(" / ")}`).toBe(1);
      expect(seconds(before[0])).toBeGreaterThan(0);

      await s.tick(5);
      await until(
        async () => (await clockSlots(s.page))[0] !== before[0],
        "the lobby countdown to advance",
      );
      const after = await clockSlots(s.page);
      for (const slot of after) expect(slot).toMatch(CLOCK_FIGURE);
      expect(
        seconds(after[0]),
        `countdown did not decrease: ${before[0]} -> ${after[0]}`,
      ).toBeLessThan(seconds(before[0]));

      assertNoPageErrors(s, "closing lobby");
    } finally {
      await s.close();
    }
  });

  it("shows no figure at all while the seed is being drawn", async () => {
    const s = await open(browser(), { keeper: keeperStates.silent() });
    try {
      await s.jump(LOBBY_ENDS_SEC + 1);
      const slots = await slotsIn(s, "DRAWING");
      expect(slots.length).toBe(3);
      // `—` is this page's standing mark for a slot with no figure in it. What matters for the
      // incident is that none of them is a clock.
      for (const slot of slots) expect(slot).not.toMatch(CLOCK_FIGURE);
      expect(new Set(slots)).toEqual(new Set(["—"]));

      assertNoPageErrors(s, "drawing");
    } finally {
      await s.close();
    }
  });

  it("counts the fight up while it runs", async () => {
    const s = await open(browser(), { keeper: keeperStates.silent() });
    try {
      await s.jump(DRAWING_ENDS_SEC + 2);
      const before = await slotsIn(s, "FIGHT");
      expect(before.length).toBe(3);
      for (const slot of before) expect(slot).toMatch(CLOCK_FIGURE);
      expect(new Set(before).size, `slots disagreed: ${before.join(" / ")}`).toBe(1);

      await s.tick(5);
      await until(
        async () => (await clockSlots(s.page))[0] !== before[0],
        "the fight clock to advance",
      );
      const after = await clockSlots(s.page);
      expect(
        seconds(after[0]),
        `fight clock did not advance: ${before[0]} -> ${after[0]}`,
      ).toBeGreaterThan(seconds(before[0]));

      assertNoPageErrors(s, "fight");
    } finally {
      await s.close();
    }
  });

  it("holds the fight's finished length once the round has settled, and does not restart it", async () => {
    const s = await open(browser(), { keeper: keeperStates.silent() });
    try {
      await s.jump(FIGHT_ENDS_SEC + 6);
      const settled = await slotsIn(s, "SETTLED");
      expect(settled.length).toBe(3);
      for (const slot of settled) expect(slot).toMatch(CLOCK_FIGURE);
      expect(new Set(settled).size).toBe(1);
      // A settled round that reported a zero-length fight would be the incident again, arriving
      // through the one phase where a static figure is legitimate.
      expect(seconds(settled[0])).toBeGreaterThan(0);

      // Static, and that is the documented contract — see this file's header.
      await s.tick(10);
      expect(await clockSlots(s.page)).toEqual(settled);

      assertNoPageErrors(s, "settled");
    } finally {
      await s.close();
    }
  });

  it("never renders 0:00, in any phase, on any screen", async () => {
    // THE BROAD NET, and the one assertion that is a direct restatement of the incident. Both keeper
    // states are walked, because the held-open lobby is where it happened and the ordinary one is
    // where a regression would be likeliest to go unnoticed.
    const samples: { where: string; slots: string[] }[] = [];

    for (const keeper of [keeperStates.heldOpenLobby(), keeperStates.closingLobby(30)]) {
      const s = await open(browser(), { keeper });
      try {
        const stops: [string, number][] = [
          ["lobby", 0],
          ["drawing", LOBBY_ENDS_SEC + 1],
          ["fight", DRAWING_ENDS_SEC + 5],
          ["settled", FIGHT_ENDS_SEC + 6],
        ];
        let at = 0;
        for (const [name, second] of stops) {
          if (second > at) {
            await s.jump(second - at);
            at = second;
          }
          for (const view of VIEWS) {
            await goToView(s.page, view);
            const slots = await clockSlots(s.page);
            expect(slots.length, `no clock slot on ${view} in ${name}`).toBeGreaterThan(0);
            samples.push({ where: `${name}/${view}/${await phaseWord(s.page)}`, slots });
          }
        }
        assertNoPageErrors(s, "the phase walk");
      } finally {
        await s.close();
      }
    }

    // NON-VACUITY, ASSERTED. 2 keeper states x 4 phases x 5 screens = 40 readings; a refactor that
    // removed the slots entirely would otherwise turn this test green by emptying it.
    expect(samples.length).toBe(40);
    const zeroes = samples.filter((s) => s.slots.includes("0:00"));
    expect(zeroes.map((z) => z.where), "a clock slot read 0:00").toEqual([]);
  });
});
