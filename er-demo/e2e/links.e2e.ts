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
  type Session,
} from "./harness.ts";

/** `xLink.ts`'s `AVATAR_PATH_RE`, mirrored rather than imported for this suite's standing reason:
 *  these tests drive the page from outside, and a test that imported the constant that built the
 *  path would be agreeing with the implementation by construction. Anchored, absolute-path-only, no
 *  scheme and no authority — `//evil.example/x` starts with a slash and resolves off-origin, and
 *  this shape is what forbids it. */
const AVATAR_PATH = /^\/api\/avatar\/[0-9]{1,20}\/[0-9a-f]{64}\.webp$/;

/** Page time the second test spends proving an ABSENCE, in 50ms slices so the page's own rAF frames
 *  actually run — the clock is faked, so the canvas paints only when this test says so. Six is
 *  comfortably inside the lobby's eight, which is the property both tests rest on (see the header). */
const LOBBY_SECONDS_TO_SPEND = 6;

function avatarPaths(requests: readonly string[]): string[] {
  return requests
    .filter((u) => u.startsWith(`${BASE_URL}/api/avatar/`))
    .map((u) => u.slice(BASE_URL.length));
}

/** AVATAR PATHS THE PAGE ASKED FOR THAT NO `<img>` IN THE DOCUMENT IS POINTING AT — i.e. the ones
 *  the CANVAS asked for.
 *
 *  THIS DISTINCTION IS THE TEST. `ui/ConnectPanel.tsx` renders the local player's own linked identity
 *  as an ordinary DOM `<img>`, so `you`'s avatar is fetched by React whether or not the canvas ever
 *  asks for anything at all. An earlier draft of this file asserted only that SOME avatar had been
 *  requested — and passed with the fix reverted, on the strength of that one `<img>`, which is the
 *  same false green in miniature as the defect it was written for.
 *
 *  `faces.ts` fetches through `new Image()`, which is never attached to the document. So a path that
 *  was requested and that no element claims is a path the canvas asked for and nothing else could
 *  have. The fixture links three fighters and only one of them is the local player, which is what
 *  leaves something for this to find; if a DOM surface ever renders EVERY fighter's avatar too, this
 *  returns empty and the test fails rather than quietly proving nothing — at which point it needs a
 *  new discriminator, not a looser assertion. */
async function canvasAvatarPaths(s: Session): Promise<string[]> {
  const claimed = new Set(
    await s.page.evaluate(() =>
      Array.from(document.querySelectorAll("img"), (i) => i.getAttribute("src") ?? ""),
    ),
  );
  return avatarPaths(s.requests).filter((p) => !claimed.has(p));
}

/** One rAF frame of page time per poll. */
const FRAME_MS = 16;

/** THE PAGE-TIME CEILING FOR THE WHOLE TEST, and it is an assertion in disguise. Everything below
 *  has to happen while the fixture is still in its lobby: at second eight `fightStartedAtMs` flips,
 *  `lineupChanged` goes true, and the field is rebuilt through `createField` — which copies
 *  `avatarSrc` itself and would hand this test a pass with the defect fully present. Four seconds is
 *  half the lobby and roughly two hundred and fifty frames, which is two orders of magnitude more
 *  than the canvas needs. */
const PAGE_TIME_BUDGET_MS = 4000;

/** Advance the page one frame at a time until `condition` holds, spending from a budget shared
 *  across the test.
 *
 *  SEPARATE FROM `until` BECAUSE THE TWO WAIT ON DIFFERENT THINGS. `until` polls in real time and is
 *  right for anything the network owes us; this one polls a page that cannot make progress unless it
 *  is given frames. Mixing them — spending page time to wait for the network — is what makes a test
 *  like this flaky, and it is bounded here precisely so that it cannot. */
async function tickUntil(
  s: Session,
  condition: () => Promise<boolean>,
  what: string,
): Promise<void> {
  let spentMs = 0;
  await until(async () => {
    if (await condition()) return true;
    if (spentMs + FRAME_MS > PAGE_TIME_BUDGET_MS) {
      throw new Error(`spent the whole ${PAGE_TIME_BUDGET_MS}ms page-time budget`);
    }
    await s.tick(FRAME_MS / 1000);
    spentMs += FRAME_MS;
    return await condition();
  }, what);
}

describe("a linked fighter's avatar, on the assembled page", () => {
  const browser = useBrowser();

  it("is requested from our own origin when the link lands after the field was built", async () => {
    // THE ORDERING IS THE TEST, so it is established rather than waited for. The identity fixture is
    // HELD at the route until this test has watched the canvas paint a field with nobody linked on
    // it; only then is it released. Without that hold the page is free to resolve the links before
    // the first frame, in which case `ensureWorld` builds the field through `createField` — which
    // copies `avatarSrc` itself — and the defect is completely masked. That is not a hypothetical:
    // an earlier draft of this test waited for the fixture first, and it passed with the fix
    // reverted. A test for a race that does not pin the race proves nothing.
    let releaseLinks = (): void => {};
    const linksHeld = new Promise<void>((resolve) => {
      releaseLinks = resolve;
    });

    const s = await open(browser(), {
      query: "fixture=1&links=mock",
      keeper: keeperStates.heldOpenLobby(),
      routes: async (page) => {
        await page.route("**/links.mock.json", async (route) => {
          await linksHeld;
          await route.continue();
        });
      },
    });
    try {
      await assertRendered(s.page, "the arena under ?links=mock");

      // TWO CLOCKS, AND NEITHER MAY BE SLEPT ON. The canvas paints only when this test advances PAGE
      // time (the clock is faked, so `requestAnimationFrame` is too); the identity pipeline runs in
      // REAL time. Page time is the scarce one — there are eight seconds of lobby and then the field
      // rebuilds — so it is spent deliberately, in single frames, and never as a way of waiting for
      // the network.

      // STEP ONE — THE FIELD EXISTS AND NOBODY IS LINKED. The canvas's own `aria-label` is written
      // by the loop's `frame()` out of `field.bodies`, so a label naming a fighter count is proof
      // that `ensureWorld` has run and built the world. Until it says so, the defect has nothing to
      // be a defect about.
      // `arenaLoop`'s `updateLabel` composes this out of `field.bodies`; the canvas ships with a bare
      // "Arena field" until the loop has run at least once with a world in it.
      const painted = async (): Promise<boolean> =>
        /\d+ of \d+ fighters? in play/.test(
          (await s.page.locator("canvas").getAttribute("aria-label")) ?? "",
        );
      expect(PAGE_TIME_BUDGET_MS / 1000).toBeLessThan(LOBBY_ENDS_SEC);
      await tickUntil(s, painted, "the canvas to paint a field with fighters on it");

      // Guaranteed, not hoped for: the fixture response is still held at the route.
      expect(await canvasAvatarPaths(s)).toEqual([]);

      // STEP TWO — THE LINK LANDS, mid-round, on a field that is already up. This is the whole
      // scenario, and `TWITTER-CONNECT.md` §8.4 asks for it by name.
      releaseLinks();

      // Costs no page time at all, so it can wait out a loaded machine without eating the lobby.
      await until(
        async () => s.requests.some((u) => u.includes("mockLinks-")),
        "the mock link fixture to be fetched and its signer to load",
      );

      // STEP THREE — PAINT AGAIN. Nothing about the cast changed, so `lineupChanged` is false and
      // `createField` will not run: the only route left for a path to reach a body is the in-place
      // sync. THE DEFECT, AS A NUMBER — this wait times out if the canvas never asks for a face.
      await tickUntil(
        s,
        async () => (await canvasAvatarPaths(s)).length > 0,
        "the canvas to request a linked fighter's avatar",
      );
      const paths = await canvasAvatarPaths(s);

      // Still in the lobby, therefore the field was never rebuilt out from under the assertion.
      // Uppercase because `phaseWord` reads `innerText` and the top bar is `text-transform`d — the
      // same spelling `clock.e2e.ts` asserts, deliberately, so both read the word a player sees.
      expect(await phaseWord(s.page)).toBe("LOBBY");

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
