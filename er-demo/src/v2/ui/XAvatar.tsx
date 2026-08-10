// A LINKED PLAYER'S OWN FACE, ON PAPER. The sibling of `TokenIcon.tsx`, written to the same rule.
//
// `TokenIcon` already made this argument for the coins and it applies here unchanged:
//
//   > No rounding: a circle-cropped avatar would be the single most obviously "web app" thing on a
//   > page built to avoid exactly that.
//
// So: a square, a 1px hairline, no radius, set at text scale and aligned to the baseline, exactly
// like the coin artwork it sits beside in the same tables. `SOCIAL.md` §4.6 states the rule as
// **round on the field, square on paper** — the canvas is a simulation of discs and clips a face into
// one; the page is a printed table, and a printed table sets a picture in a box.
//
// THE COLOUR BEND, AND WHY IT IS SIZE AND NOT SATURATION. `base.css` rule 5 reserves colour for the
// two sides. A photograph is full-colour raster and cannot be retinted by `paper.ts` — it is someone
// else's artwork. That bend already happened when `TokenIcon` put full-colour coin logos in these
// same tables, and an avatar is the same class of object: a photographic marker at text scale, in a
// hairline box, sized to the type. The discipline that keeps it honest is SIZE — 16px in tables,
// 24px in the wallet panel, and nowhere else on the DOM. Desaturating was considered and rejected
// (§4.6): it would keep the rule perfectly and destroy the feature, because a grey 16px face is not
// recognisable and recognition is the entire point.
//
// NO PICTURE IS AN ORDINARY STATE, NOT AN ERROR, and it arrives two ways that must render
// identically: `avatarPath === null` ("linked, the bytes have not reached us yet" — a real rung on
// `TWITTER-CONNECT.md` §7.3's ladder and the common one on a first link) and an `<img>` that fails to
// load (a deleted account, a suppressed avatar, images turned off). Both fall back to the LETTERED
// MARK — `TokenIcon`'s own `tico--letter` pattern for a token with no artwork — because reusing the
// established "there isn't a picture" mark is what stops a failed avatar reading as a bug.
//
// SAME-ORIGIN, AND NOT BY CONVENTION. `avatarPath` has already been through `verifyAttestation`,
// which rejects any record whose path is not exactly `/api/avatar/<xId>/<64 hex>.webp` — so there is
// nothing to check here and nothing this component could do to reach a third party. `crossOrigin` is
// deliberately unset: these are genuinely our own bytes, and setting it would break the proxy for no
// gain (`SOCIAL.md` §6.3).

import { useState } from "react";
import type { LinkRecord } from "../data/xLink.ts";
import "./XAvatar.css";

/** The only two sizes that exist on the DOM. `SOCIAL.md` §4.6 makes this the whole discipline that
 *  keeps a colour photograph honest on a monochrome page, so it is a union rather than a number: a
 *  `size={64}` has to be a type error, not a code review. */
export type XAvatarSize = 16 | 24;

export function XAvatar({ link, size = 16 }: { link: LinkRecord; size?: XAvatarSize }) {
  // THE FAILED SRC, NOT A BOOLEAN. A record whose `avatarPath` changes — the picture arriving after a
  // first link, or a re-linked account — must get a fresh attempt rather than staying permanently
  // lettered because an earlier, different URL once 404ed.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = link.avatarPath;

  if (src === null || src === failedSrc) {
    return (
      <span className={`xav xav--${size} xav--letter`} aria-hidden="true">
        {/* The handle's initial. `HANDLE_RE` has already bounded it to `[A-Za-z0-9_]`, so there is
            nothing here that needs escaping and nothing that can be wider than one character. */}
        {link.handle.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className={`xav xav--${size}`}
      src={src}
      // DECORATIVE, AND THAT IS THE ACCESSIBLE CHOICE RATHER THAN THE LAZY ONE. `XIdentity` never
      // renders this without the `@handle` beside it as real text, so the picture carries no
      // information a reader would otherwise lose — and a screen reader announcing the same identity
      // twice on every one of forty rows is worse than silence. This is the one place it differs
      // from `TokenIcon`, which takes `alt={meta.name}` because there are call sites where the coin
      // mark is the only carrier of which side something is on. There is no such call site here.
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      draggable={false}
      // THE ATTRIBUTES, NOT ONLY THE CSS. The stylesheet sizes this too, but a row whose image has
      // no intrinsic size reflows the instant the bytes land — and these load lazily, mid-scroll,
      // down a forty-row table. Stating the box up front means the row is the same height before and
      // after, which is the difference between a face appearing and a table jumping.
      width={size}
      height={size}
      onError={() => setFailedSrc(src)}
    />
  );
}
