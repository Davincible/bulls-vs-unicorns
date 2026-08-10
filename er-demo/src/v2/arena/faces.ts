// A fighter's FACE — the picture drawn inside its disc.
//
// `web/index.html` did this and it is the single reason its field was readable at a glance: the
// circles were not abstract tokens, they were the coins themselves, and in a game whose whole
// premise is that two specific memecoin communities are fighting each other, the coins should be
// visible AS THEMSELVES. `TokenIcon.tsx` already makes that argument for the DOM side of the page;
// this is the same artwork, on the canvas, for the same reason.
//
// EVERY face resolves through `faceFor()`. One function, so "what picture is this fighter" is one
// answer in one place — the coin, or the player's own avatar where they have proved one. See the
// note on it for that branch and for the two things it still refuses.
//
// THE LOADING RULES, which are what most of this file is:
//
//   - ONE Image per src, ever, at module scope. A cache keyed by URL, primed on first ask. The
//     painter runs 60 times a second over 16 bodies; constructing an Image, or touching pixel data,
//     anywhere near that loop is how a flat-vector canvas ends up dropping frames.
//   - NOT READY IS A REAL STATE. `faceFor()` returns null until the bytes are decoded AND the
//     desaturated copy is built, and the painter falls back to the flat side-colour disc it drew
//     before. So the field is correct on frame one, correct with images disabled, correct if the
//     asset 404s, and never shows a hole or a half-drawn disc while loading.
//   - `decode()`, not `load`. `load` fires when the bytes have arrived, which is not when the image
//     is ready to paint: the first `drawImage` then does the decode work, synchronously, inside a
//     frame — a visible hitch exactly at the moment a fighter appears. `decode()` resolves when it
//     is genuinely paintable.
//   - The desaturated variant is rendered ONCE into an offscreen canvas. Per-frame `filter` or
//     `getImageData` would be the same mistake at 60fps.
//
// SAME-ORIGIN ONLY, and that is a rule rather than an accident: these are files in `public/` and
// paths on this app's own origin (`/api/avatar/…`, where our own server holds the bytes). Nothing
// here may reach a third party — not even now that a fighter's face can be someone's X avatar. See
// `faceFor()`.

import { SIDE_TOKEN } from "../contract.ts";
import type { ArenaBody } from "./field.ts";

export interface Face {
  /** The artwork, decoded and ready to `drawImage`. */
  readonly art: CanvasImageSource;
  /** The same artwork with the colour taken out, for fighters that are out of play. Colour on this
   *  page means "in the fight"; a corpse keeps its identity but gives up its chroma. */
  readonly spent: CanvasImageSource;
}

interface Entry {
  face: Face | null;
  /** Decode finished or failed. Either way we stop caring — a failed asset must not be retried on
   *  the next frame, sixty times a second, forever. */
  settled: boolean;
}

const cache = new Map<string, Entry>();

/** Cap on the desaturated copy's size. The largest a disc can get is `BASE_RADIUS_RANGE[1]` ×
 *  `MAX_SCALE` ≈ 100px radius, i.e. ~400 device px across at DPR 2 — but the spent variant is drawn
 *  at a fraction of full strength on a corpse, where resolution is the last thing anyone is reading.
 *  256 keeps two of these under a megabyte of GPU memory between them. */
const SPENT_MAX_PX = 256;

/** Colour out, luminance kept. Falls back to the colour artwork where `ctx.filter` is unsupported:
 *  the painter draws the spent variant at reduced alpha regardless, which carries the reading on its
 *  own — a washed-out face is still unmistakably not a live one. */
function desaturate(img: HTMLImageElement): CanvasImageSource {
  const size = Math.min(img.naturalWidth || SPENT_MAX_PX, SPENT_MAX_PX);
  const off = document.createElement("canvas");
  off.width = size;
  off.height = size;
  const g = off.getContext("2d");
  if (!g) return img;
  g.filter = "grayscale(1)";
  if (g.filter !== "grayscale(1)") return img;
  // Square, matching how the painter draws it: into the disc's square bounding box. Non-square art
  // is squashed rather than cropped, which is what `web/index.html` did and what the DOM icons do.
  g.drawImage(img, 0, 0, size, size);
  return off;
}

function lookup(src: string): Entry {
  const existing = cache.get(src);
  if (existing) return existing;

  const entry: Entry = { face: null, settled: false };
  cache.set(src, entry);

  const img = new Image();
  // No `crossOrigin`: these are same-origin assets, and setting it would ask for a CORS handshake
  // this server never offers. Nothing here is ever pointed off-origin (see the header).
  img.decoding = "async";
  const settle = (): void => {
    // Both `load` and `decode()` can land, in either order. Idempotent by this guard rather than by
    // luck: without it the desaturated copy is rendered twice and one of the two offscreen canvases
    // is immediately garbage, for every face, on every page load.
    if (entry.settled) return;
    entry.settled = true;
    // `naturalWidth` is the honest test of "did this actually decode" — it is 0 for a 404, for a
    // corrupt file, and in a browser with images turned off, all of which land here.
    if (img.naturalWidth > 0) entry.face = { art: img, spent: desaturate(img) };
  };
  img.addEventListener("error", settle, { once: true });
  img.addEventListener("load", settle, { once: true });
  img.src = src;
  // `decode()` resolves when the image is paintable, which `load` does not promise; where it exists
  // it supersedes the `load` listener above (both are idempotent — `settle` only ever assigns).
  // Guarded because it is the one part of this path that isn't universally available.
  if (typeof img.decode === "function") void img.decode().then(settle, settle);

  return entry;
}

/** THE ONE PLACE a fighter's picture is decided: the player's own avatar where they have proved one,
 *  the coin their side is playing where they have not.
 *
 *  `web/index.html` had exactly this branch — `if (p.avatar && window.avatarImg) { … art = av; }` —
 *  and this function kept its shape through the whole time the seam was empty, which is why filling
 *  it is the one line below rather than a rewrite of the painter.
 *
 *  THE CANVAS STILL TOUCHES NO DATA, which is the constraint that decided the shape. `b.avatarSrc`
 *  is a plain string that `field.ts` copied off the `FighterView`; nothing in this file fetches an
 *  identity, looks one up, imports a profile, or knows that X exists. An avatar is just another src
 *  through the same cache, obeying the same four loading rules in this file's header, and the whole
 *  of `SOCIAL.md` §6.3 is that sentence.
 *
 *  THE TWO REFUSALS THIS FUNCTION HAS ALWAYS RECORDED ARE STILL LIVE. Both are honoured by the new
 *  branch rather than overridden by it:
 *
 *    - NO THIRD-PARTY AVATAR SERVICE. The field still makes no off-origin request, and that is the
 *      point of the path's shape. `/api/avatar/<xId>/<hash>.webp` is OUR origin proxying bytes we
 *      hold — which is an ANSWER to the objection, not an exemption from it. Hotlinking would send
 *      every player's IP and `Referer` to a third-party CDN for every fighter, every round,
 *      including the players who never linked (`TWITTER-CONNECT.md` §7.1); the proxy is what stops
 *      that, and `data/xLink.ts`'s `verifyAttestation` is what stops a path being anything else —
 *      it rejects any avatar path that is not exactly that anchored shape, so a leaked signing key
 *      still cannot point this at another host.
 *    - NO GENERATED IDENTICON. An absent avatar is still `null` and still draws the flat
 *      side-coloured disc. A procedural picture of nothing, dressed up as a person's face, is the
 *      loudest version of the lie this page refuses everywhere else — `TokenIcon` draws a letter
 *      rather than a logo for SOL for the same reason.
 *
 *  UNLINKED IS THE MAIN PATH, not a degraded one. Most players never link; the coin face plus a
 *  `nameFor()` pseudonym is a complete rendering of a player, and it is the rendering this field
 *  shipped with. Every rung of `TWITTER-CONNECT.md` §7.3's ladder — bytes in flight, upstream 404,
 *  operator-suppressed, never linked — lands on the same disc, and none of them is distinguishable
 *  to the painter. That indistinguishability is a feature: the absence of the identity service must
 *  look exactly like a player who chose not to link.
 *
 *  ONCE A BODY HAS AN `avatarSrc`, ITS FACE IS THAT AVATAR OR NOTHING. `??` reads the src, not the
 *  readiness — a linked fighter whose bytes are still coming draws the flat disc and never flashes
 *  the coin on the way to its avatar. Two different pictures inside one round would read as the
 *  fighter changing sides.
 *
 *  `crossOrigin` STAYS UNSET (see `lookup`): these paths are genuinely same-origin, so setting it
 *  would ask for a CORS handshake this server does not offer and break the proxy for no gain.
 *
 *  Returns `null` while the artwork is still decoding, when it failed, and for a side whose token
 *  has no artwork in the repo at all (SOL). The painter treats all of them the same way: flat side
 *  colour. */
export function faceFor(b: ArenaBody): Face | null {
  const src = b.avatarSrc ?? SIDE_TOKEN[b.side].icon;
  if (src === null) return null;
  return lookup(src).face;
}

/** Starts the decode before anything asks to draw one.
 *
 *  Without this, the first fighter to appear in a lobby is drawn as a flat disc for however long the
 *  fetch and decode take, then pops into artwork. Priming at loop start moves that whole window into
 *  the empty pre-entry field, where there is nothing to pop. Idempotent — `lookup` is a cache.
 *
 *  THE TWO COINS ONLY, deliberately, now that a face can also be an avatar. The coins are two known
 *  paths that every round needs; avatars are up to sixteen per-player fetches that this function has
 *  no lineup to know about and would be guessing at. They prime on first paint instead, and the coin
 *  is the correct rendering until they land rather than a placeholder for them. */
export function primeFaces(): void {
  for (const token of SIDE_TOKEN) {
    if (token.icon !== null) lookup(token.icon);
  }
}
