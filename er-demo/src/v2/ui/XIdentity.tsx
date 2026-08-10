// A VERIFIED X IDENTITY, RENDERED — the face, the handle, and the mark that says where it came from.
//
// ================================================================================================
// THE `@HANDLE` IS ALWAYS RENDERED. There is no prop for it, no variant without it, and no
// truncation mode that drops it.
//
// It is the only unforgeable part of an X identity. A display name is free text — `Ansem` costs
// nothing to type — while `@blknoiz06` cannot be taken from the person who holds it, which is why
// `TWITTER-CONNECT.md` §4.4 names display-name impersonation as the top residual risk and answers it
// with this one rule. X's own display policy (§2.4) requires the handle for the same reason, so this
// is a compliance obligation as well as a security one. `xLink.ts` enforces it a second way, from the
// other side: `LinkRecord.displayName` is deliberately not a `string`, so `{link.displayName}` cannot
// compile into a rendered name, and `identityText()` — used below — cannot return a display name
// without the handle beside it.
//
// AND THE DISPLAY NAME IS NOT RENDERED HERE AT ALL. `SOCIAL.md` §7 lists "storing or displaying the X
// display name" under what we are NOT doing, and §2.6 says it plainly: "Display `@handle`. Never the
// X display name." `identityText()` returns it because the fighter inspector may one day have the
// room and the obligations to carry it; a 12px table row has neither. Nothing here reaches for it.
// ================================================================================================
//
// THE X MARK IS PROVENANCE, NOT BRANDING. §2.4's display obligation is handle + avatar + logo, and
// the logo's job on this page is to answer "who verified this face" in the space of nine pixels. So
// it is monochrome `--ink-3`, the same ink as the wallet key beside it, and it is the last thing in
// the run rather than the first — the face and the name are the content, this is the footnote.
//
// IT IS INLINE SVG RATHER THAN A SYMBOL IN `public/icons.svg`, and that is following the existing
// system rather than departing from it: `icons.svg` is a Phase-0 asset that nothing under `src/v2`
// references — there is no `<use>`, no fetch and no sprite loader anywhere in the v2 page, which
// draws its own marks (`Mark`, `.sim`, the registration crosses in `base.css`) inline. Adding a
// symbol to a sprite nobody reads would be dead weight plus a network request for nine pixels. Its
// own `x-icon` symbol is also a hollow outline variant, which at this size is a smudge; this is the
// solid mark, which is the one that survives being small.

import { identityText, type LinkRecord } from "../data/xLink.ts";
import { XAvatar, type XAvatarSize } from "./XAvatar.tsx";
import "./XIdentity.css";

/** The X mark, solid, in `currentColor`.
 *
 *  `aria-hidden` and `focusable="false"`: it is decoration on top of the handle immediately to its
 *  left, and announcing "X" after every handle on a forty-row board costs a non-sighted reader time
 *  to be told nothing. `focusable` is the IE/Edge legacy attribute that keeps an inline `<svg>` out
 *  of the tab order; it costs one attribute and removes a class of stray tab stop. */
function XMark() {
  return (
    <svg className="xid-x" viewBox="0 0 1200 1227" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M714.163 519.284 1160.89 0h-105.86L667.137 450.887 357.328 0H0l468.492 681.821L0 1226.37h105.866l409.625-476.152 327.181 476.152H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894-377.686-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.828Z"
      />
    </svg>
  );
}

/**
 * The identity, as one run of type: `[face] @handle [X]`.
 *
 * A FLEX ROW ON THE BASELINE, and the two marks are `flex: none`. Under a narrow column the HANDLE is
 * what gives way — it ellipsises — and the face and the mark stay whole. That ordering is deliberate:
 * a clipped handle is still an identifiable identity and the full one is a `title` away, whereas a
 * clipped X mark is a display obligation silently dropped by a media query.
 *
 * `size` is the whole colour discipline (`SOCIAL.md` §4.6) rather than a styling knob: 16 in tables,
 * 24 in the wallet panel, and there is no third value.
 */
export function XIdentity({ link, size = 16 }: { link: LinkRecord; size?: XAvatarSize }) {
  // `identityText` IS THE ONLY SANCTIONED WAY TO PRINT ONE OF THESE, and it hands back the `@`
  // already attached — so there is no template here interpolating a handle, and no arrangement of
  // this component that renders an identity without it.
  const { handle } = identityText(link);
  return (
    <span className={`xid xid--${size}`}>
      <XAvatar link={link} size={size} />
      <span className="xid-h">{handle}</span>
      <XMark />
    </span>
  );
}
