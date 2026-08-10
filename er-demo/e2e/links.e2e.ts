// DEFECT #7 — A FACE THAT REACHED EVERY LAYER EXCEPT THE ONE THAT DRAWS IT.
//
// THE INCIDENT, in full, because it is the cleanest example this suite has of what it is for.
// `?fixture=1&links=mock` built a verified link map, `FighterView.avatarSrc` was populated, the
// roster had it, `faces.ts` had 23 unit tests pinning exactly what to do with it — and the page made
// ZERO requests for an avatar. Every module was correct. `createField` is the only thing that copies
// `avatarSrc` onto a body, `arenaLoop`'s `ensureWorld` calls it only when the LINEUP changed, and a
// link resolving changes no id, no wallet and no stake. So the bodies kept the `null` they were born
// with and every fighter drew its side's coin, forever.
//
// AND IT WAS INVISIBLE, twice over. The flat side-coloured disc is not an error state — it is what
// this field drew before there were faces at all and what every unlinked fighter draws for good
// (`TWITTER-CONNECT.md` §8). So "the avatar never arrived" and "this player never linked" are the
// same picture. The unit suite could not see it either, by construction: `faces.test.ts` calls
// `faceFor` on bodies it built itself with the field already set, so it proves what the painter does
// with an avatar and can say nothing about whether one ever reaches it. The gap was between two
// correct functions, which is the only kind of defect in this directory.
//
// WHY THE ASSERTION IS A REQUEST LOG. There is no way to ask a canvas what it drew, and sampling
// pixels off a disc whose position is decided by a physics settle would be a test that fails on a
// resize. But an avatar is a network resource: `faces.ts` constructs one `Image` per src, and that
// `Image` puts a line in the page's request log the moment the painter first asks for that face. A
// request for `/api/avatar/...` is therefore proof that the path travelled all the way from the
// verified attestation to the inside of a paint frame. No request is proof that it did not.
//
// THE WINDOW IS THE LOBBY, AND THAT IS THE WHOLE DESIGN OF THIS TEST. The fixture's lineup is fixed
// for the eight seconds of its lobby and `fightStartedAtMs` is null throughout, so `lineupChanged`
// is false on every frame after the first and the field is built EXACTLY ONCE. Leaving the lobby
// would flip `fightStartedAtMs`, rebuild the field, and hand the bodies their avatars through
// `createField` — which is to say the bug repairs itself the moment the fight starts, and a test
// that ticked past second eight would pass with the defect fully present. Everything below happens
// before then, on purpose. If this test is ever loosened, that is the sentence to re-read.

import { describe, expect, it } from "vitest";
import {
  BASE_URL,
  LOBBY_ENDS_SEC,
  assertHermetic,
  assertNoPageErrors,
  assertRendered,
  keeperStates,
  open,
  phaseWord,
  until,
  useBrowser,
} from "./harness.ts";

/** `xLink.ts`'s `AVATAR_PATH_RE`, mirrored rather than imported for this suite's standing reason:
 *  these tests drive the page from outside, and a test that imported the constant that built the
 *  path would be agreeing with the implementation by construction. Anchored, absolute-path-only, no
 *  scheme and no authority — `//evil.example/x` starts with a slash and resolves off-origin, and
 *  this shape is what forbids it. */
const AVATAR_PATH = /^\/api\/avatar\/[0-9]{1,20}\/[0-9a-f]{64}\.webp$/;

/** The page-time budget, spent in 50ms slices so the page's own rAF frames actually run — the clock
 *  is faked, so the canvas paints only when this test says so. Six is comfortably inside the lobby's
 *  eight, which is the property the whole test rests on (see the header). */
const LOBBY_SECONDS_TO_SPEND = 6;

function avatarPaths(requests: readonly string[]): string[] {
  return requests
    .filter((u) => u.startsWith(`${BASE_URL}/api/avatar/`))
    .map((u) => u.slice(BASE_URL.length));
}

describe("a linked fighter's avatar, on the assembled page", () => {
  const browser = useBrowser();

  it("is requested from our own origin while the round is already on screen", async () => {
    const s = await open(browser(), {
      query: "fixture=1&links=mock",
      keeper: keeperStates.heldOpenLobby(),
    });
    try {
      await assertRendered(s.page, "the arena under ?links=mock");

      // TWO CLOCKS, AND NEITHER MAY BE SLEPT ON. The link pipeline runs in REAL time — fetch the
      // fixture, fetch the signing chunk `useLinks` imports dynamically, derive the key, sign every
      // record, verify every signature, re-render — while the canvas paints only when this test
      // advances PAGE time. So each poll advances a few frames and then asks whether the avatar has
      // been requested yet.
      //
      // A FIXED RUN OF TICKS IS THE WRONG SHAPE HERE, and it is worth naming because it looked
      // right: `for (i = 0; i < 6; i++) await s.tick(1)` spends the whole lobby in about fifty
      // milliseconds of REAL time, so it can comfortably outrun the fetch it is waiting for. That
      // version of this test passed twice and then failed on the third run with nothing underneath
      // it having changed — a false green for the same reason the harness header gives for banning
      // `waitForTimeout`.
      const TICK_MS = 50;
      const BUDGET_MS = LOBBY_SECONDS_TO_SPEND * 1000;
      let spentMs = 0;
      const t0 = Date.now();
      let polls = 0;
      await until(async () => {
        polls += 1;
        if (avatarPaths(s.requests).length > 0) return true;
        // Bounded, and bounded INSIDE the lobby. Crossing second eight flips `fightStartedAtMs`,
        // rebuilds the field, and hands the bodies their avatars through `createField` — which would
        // make this test pass with the defect fully present. The budget is what stops that.
        if (spentMs + TICK_MS > BUDGET_MS) return false;
        await s.tick(TICK_MS / 1000);
        spentMs += TICK_MS;
        return avatarPaths(s.requests).length > 0;
      }, "the canvas to request a linked fighter's avatar");
      console.log(`MEASURE polls=${polls} pageMs=${spentMs} realMs=${Date.now() - t0}`);
      const paths = avatarPaths(s.requests);

      // Still in the lobby, therefore the field was never rebuilt, therefore the only way a path
      // reached a body is the in-place sync. This assertion is load-bearing — see the file header.
      // Uppercase because `phaseWord` reads `innerText` and the top bar is `text-transform`d — the
      // same spelling `clock.e2e.ts` asserts, deliberately, so both read the word a player sees.
      expect(await phaseWord(s.page)).toBe("LOBBY");
      expect(LOBBY_SECONDS_TO_SPEND).toBeLessThan(LOBBY_ENDS_SEC);

      // THE DEFECT, AS A NUMBER. Zero here is the bug: the canvas never asked for a face.
      expect(paths.length).toBeGreaterThan(0);

      // Every one is the proxy path and nothing else — no host, no query, no cache-buster. A size
      // parameter would miss the proxy's content-hash key; an absolute URL would fetch off-origin
      // with `crossOrigin` unset and taint the canvas.
      for (const path of paths) expect(path).toMatch(AVATAR_PATH);

      // One `Image` per src, ever — `faces.ts`'s central performance rule, observed on the real page
      // rather than against a stubbed global. A duplicate here is a face being re-requested inside
      // the paint loop.
      expect(new Set(paths).size).toBe(paths.length);

      // The path resolves to actual bytes. Without this, an avatar that 404'd would still have been
      // requested and would still have passed everything above, while rendering as the same flat
      // disc as never having linked.
      const served = await s.page.evaluate(async (path: string) => {
        const res = await fetch(path);
        return { ok: res.ok, type: res.headers.get("content-type") };
      }, paths[0]);
      expect(served.ok).toBe(true);
      expect(served.type).toContain("image/");

      // §7.1's first rule, checked rather than intended: the whole reason avatars are proxied is
      // that hotlinking would send every player's IP and Referer to a third-party CDN, for every
      // fighter, every round, including the players who never linked.
      assertHermetic(s);
      assertNoPageErrors(s, "the arena under ?links=mock");
    } finally {
      await s.close();
    }
  });

  it("asks for nothing at all when no identity source is configured", async () => {
    // The other half of the same claim, and the one that keeps the feature honest: without
    // `?links=`, the page is the page it has always been. `LINK_SOURCE` is `off`, no link fetch is
    // made, no avatar is requested, and every fighter is a coin — which is what §8 calls the main
    // path rather than a degraded one.
    const s = await open(browser(), { keeper: keeperStates.heldOpenLobby() });
    try {
      for (let ms = 0; ms < LOBBY_SECONDS_TO_SPEND * 1000; ms += 50) await s.tick(0.05);

      expect(avatarPaths(s.requests)).toEqual([]);
      expect(s.requests.filter((u) => u.includes("links.mock.json"))).toEqual([]);
      await assertRendered(s.page, "the arena with no identity source");
      assertHermetic(s);
      assertNoPageErrors(s, "the arena with no identity source");
    } finally {
      await s.close();
    }
  });
});
