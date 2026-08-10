// THE DEFECT THIS FILE EXISTS TO PREVENT IS A FACE THAT NEVER TRIES TO LOAD — and the reason it
// needs a test file rather than a reviewer is that the failure is INVISIBLE, because the fallback is
// CORRECT-LOOKING.
//
// `draw.ts`'s `drawFace` renders a null `Face` as the flat side-coloured disc, and that disc is not a
// placeholder: it is what this field drew before there were faces at all, it is what every unlinked
// fighter draws forever, and every rung of `TWITTER-CONNECT.md` §7.3's ladder — bytes in flight,
// upstream 404, account deleted, operator-suppressed, never linked — lands on it deliberately. So
// "correctly falling back" and "never trying" produce THE SAME PIXELS. A screenshot cannot tell them
// apart, a reviewer stepping through the page cannot tell them apart, and a player never could. Only
// a count of constructed `Image`s can, which is what most of the numbers below are.
//
// THE SECOND DEFECT, from the other direction, is the retry storm. The painter runs 60 times a second
// over up to 16 bodies, every one of them now carrying a src that may be missing. `Entry.settled`
// exists so a failed asset is asked for once rather than 960 times a second forever; nothing on
// screen changes when that guard is dropped either, because a face that fails to load looks exactly
// like a face that fails to load a thousand times.
//
// WHY THIS FILE DID NOT EXIST UNTIL NOW. `faces.ts` reaches for two browser globals — `Image` and
// `document.createElement("canvas")` — and this project has no jsdom and no happy-dom: `npm test`
// runs Vitest in the NODE environment, and no other test in the tree has ever constructed an `Image`
// or touched `document`. So the one module whose entire contract is "what happens while, and after,
// a network resource fails to be a picture" was the one module nothing could exercise. Adding a DOM
// implementation would have solved the wrong problem anyway — a real `Image` settles when it feels
// like it, which turns "the proxy is slow" into a timing hope. Two stubs the test drives by hand turn
// every rung of the ladder into an ordinary assertion.
//
// THE MECHANISM, because the next person must not have to rediscover it:
//
//   * `faces.ts` holds a MODULE-SCOPE `cache` Map. Left alone, the first test to load an avatar makes
//     every later test's "was an Image constructed?" a lie. So every test calls `loadFaces()`, which
//     does `vi.resetModules()` and then a dynamic `await import("./faces.ts")` — a fresh module, a
//     fresh cache, per test. Nothing here may use a static import of `faces.ts`.
//   * `installDom()` stubs `Image` and `document` with fakes that RECORD (into `dom`) and that settle
//     only when a test says so. `vi.unstubAllGlobals()` in `afterEach` puts the node environment
//     back.
//   * `loadFaces()` also hands back the same `contract.ts` instance `faces.ts` itself imported, which
//     is what lets one test below repoint `SIDE_TOKEN` at a token with no artwork and have the
//     mutation die with the test.
//
// WHAT IS NOT TESTED HERE, on purpose: nothing asserts a pixel. `drawFace` is `save → arc → clip →
// drawImage → restore` and its correctness is a matter of looking at it; what this file pins is the
// VALUE it is handed, because that value is the one thing a look cannot check.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaBody } from "./field.ts";

// ------------------------------------------------------------------------------------------------
// The two browser globals `faces.ts` uses, as doubles the test drives
// ------------------------------------------------------------------------------------------------

/** What the fakes recorded during the test currently running. Reassigned by `installDom()`. */
let dom: Dom;

interface Dom {
  /** Every `new Image()`, in construction order. Its LENGTH is the assertion in most tests here. */
  images: TestImage[];
  /** Every `<canvas>` `desaturate()` asked for — i.e. every desaturated copy it began building. */
  canvases: TestCanvas[];
  /** Every `getContext("2d")`. One per `desaturate` that got as far as asking. */
  getContextCalls: number;
  /** Every `drawImage` into an offscreen canvas. One per desaturated copy actually RENDERED, which
   *  is the number `settle`'s idempotence guard is worth. */
  drawImageCalls: number;
}

/** How the fake 2d context behaves — `desaturate` has three real paths and only one is the happy one.
 *
 *  `colour`     — `ctx.filter` round-trips, so the greyscale copy is rendered. Every browser we ship
 *                 to, and the default here.
 *  `no-context` — `getContext("2d")` returns null. A real outcome: a tab out of GPU memory, or a
 *                 canvas whose context creation the browser refused.
 *  `no-filter`  — the property assigns but does not stick, which is how a browser without
 *                 `CanvasRenderingContext2D.filter` presents itself. */
type ContextMode = "colour" | "no-context" | "no-filter";

let contextMode: ContextMode = "colour";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error("decode failed"));
  });
  return { promise, resolve, reject };
}

/** One `new Image()`, settling ONLY when a test tells it to.
 *
 *  Deliberately not a subset of `HTMLImageElement` in the type system — `faces.ts` touches exactly
 *  five members of one (`src`, `decoding`, `naturalWidth`, `addEventListener`, `decode`) and a fake
 *  that implemented the other three hundred would be a fake nobody could read. */
class TestImage {
  src = "";
  decoding = "";
  /** `faces.ts`'s honest test of "did this actually decode". 0 for a 404, for a corrupt file, and in
   *  a browser with images turned off. */
  naturalWidth = 0;
  /** `{ once: true }` is reproduced by deleting on fire, so a listener genuinely cannot run twice. */
  private readonly handlers = new Map<string, () => void>();
  private readonly decoding_ = deferred();

  constructor() {
    dom.images.push(this);
  }

  addEventListener(type: string, fn: () => void): void {
    this.handlers.set(type, fn);
  }

  decode(): Promise<void> {
    return this.decoding_.promise;
  }

  private fire(type: string): void {
    const fn = this.handlers.get(type);
    this.handlers.delete(type);
    fn?.();
  }

  /** The bytes arrived and are a picture: `load` fires with a real `naturalWidth`. 128 because
   *  that is what the proxy re-encodes to (`TWITTER-CONNECT.md` §7.2), not an arbitrary number. */
  arrive(width = 128): void {
    this.naturalWidth = width;
    this.fire("load");
  }

  /** `load` fires and there is still nothing there — a browser with images disabled. */
  arriveEmpty(): void {
    this.fire("load");
  }

  /** `error` fires — the 404 rung. `naturalWidth` stays 0, as it does for a real one. */
  fail(): void {
    this.fire("error");
  }

  /** `decode()` resolves. Separate from `arrive` so a test can land the two in either order. */
  finishDecode(width = 128): void {
    this.naturalWidth = width;
    this.decoding_.resolve();
  }

  /** `decode()` rejects — a file that arrived and is not decodable. `faces.ts` passes `settle` as
   *  both handlers, so this must be as harmless as the resolve. */
  failDecode(): void {
    this.decoding_.reject();
  }
}

class TestContext {
  private stored = "none";

  get filter(): string {
    // `no-filter` is the browser that accepts the assignment and ignores it, which is precisely the
    // shape `desaturate`'s round-trip check was written to detect.
    return contextMode === "no-filter" ? "none" : this.stored;
  }

  set filter(v: string) {
    this.stored = v;
  }

  drawImage(): void {
    dom.drawImageCalls += 1;
  }
}

class TestCanvas {
  width = 0;
  height = 0;

  constructor() {
    dom.canvases.push(this);
  }

  getContext(kind: string): TestContext | null {
    // Guarding the argument rather than ignoring it: if `desaturate` ever asks for `webgl` or
    // `bitmaprenderer`, this test file should say so out loud instead of quietly handing back a 2d
    // context and passing.
    if (kind !== "2d") throw new Error(`unexpected getContext(${kind})`);
    dom.getContextCalls += 1;
    return contextMode === "no-context" ? null : new TestContext();
  }
}

function installDom(mode: ContextMode): void {
  contextMode = mode;
  dom = { images: [], canvases: [], getContextCalls: 0, drawImageCalls: 0 };
  vi.stubGlobal("Image", TestImage);
  vi.stubGlobal("document", {
    createElement(tag: string): TestCanvas {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
      return new TestCanvas();
    },
  });
}

/** A fresh `faces.ts`, with a fresh module-scope cache and a fresh pair of fake globals.
 *
 *  EVERY TEST MUST GO THROUGH THIS. A static `import … from "./faces.ts"` would give all of them one
 *  shared cache, and "how many `Image`s did this construct" — the assertion this file is mostly made
 *  of — would then depend on which tests ran first. */
async function loadFaces(mode: ContextMode = "colour") {
  vi.resetModules();
  installDom(mode);
  const faces = await import("./faces.ts");
  // The SAME module instance `faces.ts` just imported: `resetModules` cleared the registry, loading
  // `faces.ts` repopulated it, and this hits that cache rather than making a third copy.
  const contract = await import("../contract.ts");
  return {
    faceFor: faces.faceFor,
    primeFaces: faces.primeFaces,
    maxFaces: faces.MAX_CACHED_FACES,
    maxFailures: faces.MAX_REMEMBERED_FAILURES,
    contract,
  };
}

/** Drains the microtask queue, so a `decode()` that has resolved has actually run `settle`. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

/** `xLink.ts`'s `AVATAR_PATH_RE`, COPIED rather than imported — twice deliberate. The canvas may not
 *  import the data layer (`SOCIAL.md` §6.3) and neither should its test; and an independent copy is
 *  what makes the assertion below a check on the string `faces.ts` actually requests rather than a
 *  tautology against the constant that produced it. */
const SAME_ORIGIN_AVATAR = /^\/api\/avatar\/[0-9]{1,20}\/[0-9a-f]{64}\.webp$/;

/** Built rather than typed out: a hand-counted 64-character literal that came out at 63 would be a
 *  path the real link path refuses, and this file would be testing a shape that can never occur. */
function avatarFor(xId: string, seed: string): string {
  return `/api/avatar/${xId}/${seed.repeat(64).slice(0, 64)}.webp`;
}

const ALICE = avatarFor("1487985654", "a1");
const BOB = avatarFor("998877665544332211", "9f");

/** An `ArenaBody` as `createField` builds one. Only `side` and `avatarSrc` matter to `faceFor`; the
 *  rest is filled honestly rather than cast, so this breaks loudly if the body's shape moves. */
function body(over: Partial<ArenaBody> = {}): ArenaBody {
  return {
    id: 0,
    wallet: "w0",
    side: 0,
    name: "KITE_01",
    isYou: false,
    avatarSrc: null,
    stake: 1_000_000n,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 40,
    rTarget: 40,
    rVel: 0,
    r0: 40,
    rRisk: 0,
    riskShare: 0,
    hp: 1_000_000n,
    banked: 0n,
    worth: 1_000_000n,
    dead: false,
    deadAtMs: -1, // `field.ts`'s private NOT_DEAD.
    ...over,
  };
}

/** How many frames a claim is checked over. The painter runs at 60Hz, so this is one second of a
 *  fight — long enough that a per-frame retry is unmistakable in a count of constructed `Image`s. */
const ONE_SECOND_OF_FRAMES = 60;

// ------------------------------------------------------------------------------------------------

describe("the unlinked fighter, which is the main path", () => {
  it("asks for its own side's coin — not for nothing, and not for the other side's", async () => {
    const { faceFor, contract } = await loadFaces();

    expect(faceFor(body({ side: 0 }))).toBeNull();
    expect(faceFor(body({ side: 1, wallet: "w1" }))).toBeNull();

    expect(dom.images.map((i) => i.src)).toEqual([
      contract.SIDE_TOKEN[0].icon,
      contract.SIDE_TOKEN[1].icon,
    ]);
  });

  it("renders its coin as a complete face once the coin lands — nothing about it is degraded", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ side: 0 });

    faceFor(b);
    dom.images[0].arrive();
    await flush();

    const face = faceFor(b);
    expect(face).not.toBeNull();
    expect(face?.art).toBe(dom.images[0]);
    expect(face?.spent).toBe(dom.canvases[0]);
  });

  it("asks for nothing at all when its side's token has no artwork", async () => {
    const { faceFor, contract } = await loadFaces();
    // WHY THIS NEEDS A MUTATION. `SIDE_TOKEN` is the live arena's pair and both its coins have
    // artwork, so no fixture can reach `faceFor`'s `src === null` branch — but the branch is not dead
    // code: `ARENAS` lists three matchups involving SOL, whose `icon` is null by design (`TokenIcon`
    // draws a letter for it). This repoints side 1 inside THIS TEST'S OWN freshly-imported copy of
    // `contract.ts`; `vi.resetModules()` in the next `loadFaces()` throws that copy away.
    //
    // The defect it pins: without the guard, `lookup(null)` caches an entry under a null key and sets
    // `img.src = "null"` — a request for a path that does not exist, made once per side, per page.
    contract.SIDE_TOKEN[1] = contract.TOKENS.sol;

    expect(faceFor(body({ side: 1 }))).toBeNull();
    expect(dom.images).toHaveLength(0);
  });
});

describe("NOT READY IS A REAL STATE — the contract the whole file is built on", () => {
  // `faceFor` returning null is not "no answer". It is the answer: `drawFace` paints the flat
  // side-coloured disc, which is a complete rendering of a fighter and the one this field shipped
  // with. Every test in this block therefore asserts `null` EXPLICITLY — never `toBeFalsy`, never
  // "did not throw" — because the day someone makes the not-ready case return `undefined`, or throw,
  // or synthesise a placeholder Face, the painter's contract is broken in a way no screenshot shows.

  it("is null on the very first frame, for the unlinked fighter", async () => {
    const { faceFor } = await loadFaces();
    expect(faceFor(body({ side: 0 }))).toBeNull();
  });

  it("is null on the very first frame, for a linked one — the src is known long before the picture is", async () => {
    const { faceFor } = await loadFaces();
    expect(faceFor(body({ avatarSrc: ALICE }))).toBeNull();
    // And the request WAS made. This pair of assertions is the whole point of the file: null with an
    // Image out is "loading"; null with no Image out is "never tried", and they look identical.
    expect(dom.images).toHaveLength(1);
  });

  it("stays null, frame after frame, for as long as the bytes take", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: ALICE });

    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES; frame++) {
      expect(faceFor(b)).toBeNull();
    }
    await flush();
    expect(faceFor(b)).toBeNull();
  });

  it("becomes a Face on the frame after the bytes land, and not before", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: ALICE });

    expect(faceFor(b)).toBeNull();
    dom.images[0].finishDecode();
    // Still null: `decode()` resolves in a microtask, and `settle` has not run yet.
    expect(faceFor(b)).toBeNull();
    await flush();
    expect(faceFor(b)).not.toBeNull();
  });
});

describe("a linked fighter", () => {
  it("resolves its own avatar path, passed through exactly as given", async () => {
    const { faceFor } = await loadFaces();

    faceFor(body({ avatarSrc: ALICE }));

    expect(dom.images).toHaveLength(1);
    expect(dom.images[0].src).toBe(ALICE);
    // NO HOST, NO QUERY, NO CACHE-BUSTER. `SOCIAL.md` §6.1's own draft of this field wrote
    // `/api/avatar/{xId}?s=48`, and a size parameter appended here would miss the proxy's
    // content-hash key and defeat its 24h cache. An absolute URL would be worse: `crossOrigin` is
    // deliberately unset, so an off-origin src would fetch without CORS and taint the canvas.
    expect(dom.images[0].src).toMatch(SAME_ORIGIN_AVATAR);
  });

  it("carries both the artwork and a distinct desaturated copy of it", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: ALICE });

    faceFor(b);
    dom.images[0].arrive();
    await flush();

    const face = faceFor(b);
    expect(face?.art).toBe(dom.images[0]);
    // Distinct, and it is the offscreen canvas rather than the image: a corpse must not be drawn
    // from the same source as a living fighter, which is `draw.ts`'s most important single reading.
    expect(face?.spent).not.toBe(face?.art);
    expect(face?.spent).toBe(dom.canvases[0]);
    expect(dom.canvases[0].width).toBe(128);
    expect(dom.canvases[0].height).toBe(128);
  });
});

describe("the failure ladder — every rung is the flat disc, and none of them retries", () => {
  /** One rung, run in its own module instance, reduced to what the painter can observe. */
  async function rung(settleIt: (img: TestImage) => void) {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: ALICE });
    faceFor(b);
    settleIt(dom.images[0]);
    await flush();
    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES; frame++) faceFor(b);
    return { face: faceFor(b), images: dom.images.length, desaturations: dom.drawImageCalls };
  }

  it("a 404 mid-round settles to null and is NEVER retried", async () => {
    // The defect: without `Entry.settled`, a missing avatar is re-requested on every frame it is
    // painted — 60 requests a second, per fighter, for the rest of the round, at a proxy that will
    // 404 every one of them. Nothing on screen changes; the network panel is the only witness.
    const notFound = await rung((img) => img.fail());

    expect(notFound.face).toBeNull();
    expect(notFound.images).toBe(1);
    expect(notFound.desaturations).toBe(0);
  });

  it("images disabled settles to null, and the painter cannot tell it from the 404", async () => {
    // Same rung, different cause: `load` fires and `naturalWidth` is still 0. It MUST NOT be
    // distinguishable — §8's rule is that the identity feature's absence looks exactly like a player
    // who chose not to link, and a face that renders "differently broken" for one cause than another
    // is how that leaks.
    const disabled = await rung((img) => img.arriveEmpty());
    const notFound = await rung((img) => img.fail());

    expect(disabled.face).toBeNull();
    expect(disabled).toEqual(notFound);
  });

  it("a decode that rejects is the same rung again, and does not escape as a rejection", async () => {
    // `faces.ts` passes `settle` as BOTH handlers of `img.decode()`. If it ever passed only the
    // fulfil handler, an undecodable file would become an unhandled promise rejection inside the
    // paint path — a thrown error 60 times a second from a fighter that merely has a bad picture.
    const undecodable = await rung((img) => img.failDecode());

    expect(undecodable.face).toBeNull();
    expect(undecodable.images).toBe(1);
  });

  it("a slow proxy is null for as long as it takes — no throw, no retry, and no coin substituted", async () => {
    const { faceFor, contract } = await loadFaces();
    const b = body({ side: 0, avatarSrc: ALICE });

    // Neither event fires and `decode()` never resolves: the proxy is still fetching upstream, which
    // §7.2 gives a 3s timeout — ~180 frames of a fight during which this fighter must simply be a
    // disc.
    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES * 4; frame++) {
      expect(faceFor(b)).toBeNull();
    }
    await flush();
    expect(faceFor(b)).toBeNull();
    expect(dom.images).toHaveLength(1);

    // ONCE A BODY HAS AN `avatarSrc`, ITS FACE IS THAT AVATAR OR NOTHING, and that is deliberate:
    // `??` reads the src, not the readiness. Falling back to the coin here would make a linked
    // fighter flash its side's logo and then swap to a photograph mid-round, and two pictures in one
    // round reads as the fighter changing sides.
    expect(dom.images[0].src).toBe(ALICE);
    expect(dom.images.map((i) => i.src)).not.toContain(contract.SIDE_TOKEN[0].icon);
  });
});

describe("the link changing mid-round", () => {
  it("a link that ARRIVES resolves on the next rebuild, and disturbs no other fighter's face", async () => {
    const { faceFor, contract } = await loadFaces();
    const coin = contract.SIDE_TOKEN[0].icon;

    // Two side-0 fighters, both unlinked. One coin between them.
    const neighbour = body({ id: 1, wallet: "w1", side: 0 });
    let alice = body({ id: 0, wallet: "w0", side: 0 });
    faceFor(alice);
    faceFor(neighbour);
    expect(dom.images).toHaveLength(1);
    dom.images[0].arrive();
    await flush();
    const coinFace = faceFor(neighbour);
    expect(coinFace).not.toBeNull();

    // The link lands. `createField` rebuilds every identity field from the `FighterView` on each
    // call and carries only position and the radius spring forward, so the same wallet comes back
    // with a src on it — this object is that rebuild.
    alice = { ...alice, avatarSrc: ALICE };
    expect(faceFor(alice)).toBeNull(); // her bytes have not arrived; her disc stays flat, correctly
    expect(dom.images).toHaveLength(2);
    expect(dom.images[1].src).toBe(ALICE);
    dom.images[1].arrive();
    await flush();
    expect(faceFor(alice)?.art).toBe(dom.images[1]);

    // Her neighbour is untouched — the SAME cached Face object, and no second request for the coin.
    expect(faceFor(neighbour)).toBe(coinFace);
    expect(dom.images.filter((i) => i.src === coin)).toHaveLength(1);
  });

  it("a link that is REVOKED returns the fighter to its coin, with no flat-disc frame in between", async () => {
    const { faceFor, primeFaces } = await loadFaces();

    // What `arenaLoop` does before the first frame, and the reason this transition is instant rather
    // than a visible pop back to a disc: the coins are already decoded before anyone revokes.
    primeFaces();
    for (const img of dom.images) img.arrive();
    await flush();
    expect(dom.images).toHaveLength(2);
    const coinFace = faceFor(body({ side: 0 }));
    expect(coinFace).not.toBeNull();

    let alice = body({ side: 0, avatarSrc: ALICE });
    faceFor(alice);
    dom.images[2].arrive();
    await flush();
    expect(faceFor(alice)?.art).toBe(dom.images[2]);

    // Unlinked, suppressed by the operator, or the account deleted — all of them arrive here as
    // `avatarSrc: null`, and all of them must land on the same disc as never having linked.
    alice = { ...alice, avatarSrc: null };
    expect(faceFor(alice)).toBe(coinFace);
    expect(dom.images).toHaveLength(3);
  });
});

describe("one Image per src, ever — the file's central performance rule", () => {
  it("two bodies sharing an avatar, painted every frame, construct exactly one Image", async () => {
    const { faceFor } = await loadFaces();
    // Not hypothetical: one X account across a rejoin, or a player holding two seats, both land here
    // as two wallets with one src.
    const a = body({ id: 0, wallet: "w0", side: 0, avatarSrc: ALICE });
    const b = body({ id: 1, wallet: "w1", side: 1, avatarSrc: ALICE });

    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES; frame++) {
      faceFor(a);
      faceFor(b);
    }
    dom.images[0].arrive();
    await flush();
    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES; frame++) {
      faceFor(a);
      faceFor(b);
    }

    expect(dom.images).toHaveLength(1);
    // And they share the Face object itself — one decode, one desaturated copy, two fighters.
    expect(faceFor(a)).toBe(faceFor(b));
    expect(dom.drawImageCalls).toBe(1);
  });

  it("a full lineup of distinct avatars constructs exactly one Image each", async () => {
    const { faceFor } = await loadFaces();
    // The program's cap is 16 fighters. This is the worst case the painter can be handed.
    const lineup = Array.from({ length: 16 }, (_, i) =>
      body({ id: i, wallet: `w${i}`, side: (i % 2) as 0 | 1, avatarSrc: avatarFor(`${1000 + i}`, "c3") }),
    );

    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES; frame++) for (const b of lineup) faceFor(b);

    expect(dom.images).toHaveLength(16);
    expect(new Set(dom.images.map((i) => i.src)).size).toBe(16);
  });

  it("primeFaces primes the two coins and nothing else, however often it is called", async () => {
    const { primeFaces, contract } = await loadFaces();

    primeFaces();
    expect(dom.images.map((i) => i.src)).toEqual([
      contract.SIDE_TOKEN[0].icon,
      contract.SIDE_TOKEN[1].icon,
    ]);

    // Idempotent, because `lookup` is a cache — and still only the coins. Priming avatars here would
    // be up to sixteen speculative fetches at loop start for a lineup this function cannot see.
    primeFaces();
    primeFaces();
    expect(dom.images).toHaveLength(2);
  });
});

describe("settling exactly once", () => {
  // `settle` is reachable from three places — the `load` listener, the `error` listener, and both
  // arms of `decode()` — and the file's own comment says an unguarded version renders the desaturated
  // copy twice "for every face, on every page load", throwing one of the two offscreen canvases away
  // immediately. That is a claim about a number, so here is the number.

  it("load first, then decode: one desaturated copy", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: ALICE });
    faceFor(b);

    dom.images[0].arrive();
    dom.images[0].finishDecode();
    await flush();

    expect(dom.getContextCalls).toBe(1);
    expect(dom.drawImageCalls).toBe(1);
    expect(dom.canvases).toHaveLength(1);
    expect(faceFor(b)?.spent).toBe(dom.canvases[0]);
  });

  it("decode first, then load: one desaturated copy", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: BOB });
    faceFor(b);

    dom.images[0].finishDecode();
    await flush();
    dom.images[0].arrive();
    await flush();

    expect(dom.getContextCalls).toBe(1);
    expect(dom.drawImageCalls).toBe(1);
    expect(dom.canvases).toHaveLength(1);
  });

  it("a face that already failed is not rebuilt when a late event lands on it", async () => {
    const { faceFor } = await loadFaces();
    const b = body({ avatarSrc: ALICE });
    faceFor(b);

    dom.images[0].fail();
    // The proxy's bytes turn up after the error — `serve the last good bytes` retries upstream, so a
    // late `load` is a real sequence. It must not resurrect a face the painter has already settled
    // on, because a fighter acquiring a photograph seconds after everyone read it as a plain disc is
    // the flicker `settled` exists to make impossible.
    dom.images[0].arrive();
    await flush();

    expect(faceFor(b)).toBeNull();
    expect(dom.drawImageCalls).toBe(0);
  });
});

describe("desaturation, when the browser will not do it", () => {
  // Both branches return the COLOUR artwork, and both are load-bearing rather than defensive: the
  // painter draws `face.spent` for every corpse on the field, at reduced alpha. If `desaturate`
  // returned null or undefined here, `drawImage` would be handed nothing inside the 60Hz loop and
  // the first death in the round would take the canvas down. The reading survives either way — a
  // faded full-colour face is still unmistakably not a live one.

  it("with no 2d context, the spent variant is the colour artwork", async () => {
    const { faceFor } = await loadFaces("no-context");
    const b = body({ avatarSrc: ALICE });
    faceFor(b);
    dom.images[0].arrive();
    await flush();

    const face = faceFor(b);
    expect(face).not.toBeNull();
    expect(face?.spent).toBe(face?.art);
    expect(dom.getContextCalls).toBe(1);
    expect(dom.drawImageCalls).toBe(0);
  });

  it("with a filter the browser silently ignores, the spent variant is the colour artwork", async () => {
    const { faceFor } = await loadFaces("no-filter");
    const b = body({ avatarSrc: ALICE });
    faceFor(b);
    dom.images[0].arrive();
    await flush();

    const face = faceFor(b);
    expect(face).not.toBeNull();
    expect(face?.spent).toBe(face?.art);
    // It got as far as asking for a context and bailed BEFORE rendering — the round-trip check is
    // what stands between us and a full-colour copy shipped under the name `spent`.
    expect(dom.getContextCalls).toBe(1);
    expect(dom.drawImageCalls).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------

/** A distinct, well-formed proxy path per index — distinct in the xId, which is the part the proxy
 *  actually keys on. */
function avatarN(i: number): string {
  return avatarFor(`${1_000_000 + i}`, "d4");
}

/** Land every image that has not settled yet. Already-settled ones are no-ops: their `{once:true}`
 *  listener is gone and `settle`'s own guard would turn it away regardless. */
async function settleAllPending(): Promise<void> {
  for (const img of dom.images) img.arrive();
  await flush();
}

describe("eviction — the cache stopped being a fixed set of two the day faces became per-player", () => {
  // THE DEFECT: every distinct avatar used to be held forever, along with the offscreen canvas
  // `desaturate` built for it. A tab left open across an evening of rounds with a rotating cast is
  // the design intent of this page, and a few hundred faces at an image plus a 256² canvas each is
  // tens of megabytes that can never come back — on a tab also running a 60fps canvas. The only
  // symptom is jank hours later, which is the hardest kind of fault to attribute to its cause, and
  // nothing in the browser will ever point at this Map.

  it("never evicts the coins, however much avatar traffic passes through", async () => {
    const { faceFor, primeFaces, maxFaces, contract } = await loadFaces();
    const coin = contract.SIDE_TOKEN[0].icon;
    primeFaces();
    await settleAllPending();
    const coinFace = faceFor(body({ side: 0 }));
    expect(coinFace).not.toBeNull();

    // A cast several times the cap, ALL of them linked — so nothing in this stretch ever asks for a
    // coin. That is the case an implicit "the coins are always the most recently used" argument gets
    // wrong, and the reason the exemption is written down rather than reasoned about.
    for (let i = 0; i < maxFaces * 3; i++) faceFor(body({ avatarSrc: avatarN(i) }));
    await settleAllPending();

    // The SAME Face object: not re-decoded, not re-requested. A coin re-decoding mid-fight is a
    // visible pop on the next fighter to draw one.
    expect(faceFor(body({ side: 0 }))).toBe(coinFace);
    expect(dom.images.filter((i) => i.src === coin)).toHaveLength(1);
  });

  it("holds a bounded number of faces, dropping the least recently used", async () => {
    const { faceFor, maxFaces } = await loadFaces();
    for (let i = 0; i < maxFaces + 50; i++) faceFor(body({ avatarSrc: avatarN(i) }));
    await settleAllPending();

    const before = dom.images.length;
    // The newest is still held — no second Image.
    faceFor(body({ avatarSrc: avatarN(maxFaces + 49) }));
    expect(dom.images).toHaveLength(before);

    // The oldest is gone, and asking again is a fresh request rather than a silent null. Re-decoding
    // a face nobody has looked at in two rounds is exactly what the budget is buying.
    faceFor(body({ avatarSrc: avatarN(0) }));
    expect(dom.images).toHaveLength(before + 1);
    expect(dom.images[dom.images.length - 1].src).toBe(avatarN(0));
  });

  it("measures recency by USE, so a fighter still on the field keeps its face", async () => {
    // The distinction between this and insertion-order FIFO is a real player: someone who entered
    // early and is still standing is the OLDEST entry and the one being painted every frame. Evicting
    // them mid-fight to make room for a newcomer is precisely backwards.
    const { faceFor, maxFaces } = await loadFaces();
    for (let i = 0; i < maxFaces; i++) faceFor(body({ avatarSrc: avatarN(i) }));
    await settleAllPending();

    // The painter touches the oldest entry, as it does every frame for a fighter still in the ring.
    faceFor(body({ avatarSrc: avatarN(0) }));

    // One more face arrives, so exactly one must go.
    faceFor(body({ avatarSrc: avatarN(maxFaces) }));
    await settleAllPending();

    const before = dom.images.length;
    faceFor(body({ avatarSrc: avatarN(0) }));
    expect(dom.images).toHaveLength(before); // touched, therefore kept
    faceFor(body({ avatarSrc: avatarN(1) }));
    expect(dom.images).toHaveLength(before + 1); // untouched, therefore the victim
  });

  it("does not turn a failed avatar back into a request once the cache has churned", async () => {
    // THE ONE THING EVICTION MUST NOT BREAK. `settled` exists so a 404 is asked for once rather than
    // sixty times a second forever; an eviction policy that forgets failures would reinstate exactly
    // that storm, one round later, for every fighter whose avatar is missing.
    const { faceFor, maxFaces } = await loadFaces();
    const broken = avatarN(99_999);
    faceFor(body({ avatarSrc: broken }));
    dom.images[0].fail();
    await flush();

    // Three rosters' worth of unrelated faces — far past the cap, so everything evictable has been
    // evicted several times over.
    for (let i = 0; i < maxFaces * 3; i++) faceFor(body({ avatarSrc: avatarN(i) }));
    await settleAllPending();

    const before = dom.images.length;
    for (let frame = 0; frame < ONE_SECOND_OF_FRAMES; frame++) {
      expect(faceFor(body({ avatarSrc: broken }))).toBeNull();
    }
    expect(dom.images).toHaveLength(before); // not sixty retries, and not even one
  });

  it("bounds what it remembers about failures too", async () => {
    // Otherwise "failures are never evicted" is just a second unbounded map with a friendlier name.
    // The bound is deliberately loose — a remembered failure is a string, and forgetting one costs a
    // single request — so this pins that the bound EXISTS, not where it sits.
    const { faceFor, maxFailures } = await loadFaces();

    const first = avatarN(0);
    faceFor(body({ avatarSrc: first }));
    dom.images[0].fail();
    await flush();

    for (let i = 1; i <= maxFailures; i++) {
      faceFor(body({ avatarSrc: avatarN(i) }));
      dom.images[dom.images.length - 1].fail();
    }
    await flush();

    // The oldest memory has been dropped, so this one src is asked about once more. Once.
    const before = dom.images.length;
    faceFor(body({ avatarSrc: first }));
    expect(dom.images).toHaveLength(before + 1);
    faceFor(body({ avatarSrc: first }));
    expect(dom.images).toHaveLength(before + 1);
  });
});
