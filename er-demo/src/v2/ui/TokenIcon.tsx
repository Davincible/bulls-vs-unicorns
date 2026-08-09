// The coins' own artwork, as an inline glyph.
//
// WHY THIS EXISTS AT ALL, given `Mark` already carries the side colour: a 7px colour square says
// "side 0" to someone who has already learned the key. The logo says ANSEM to someone who has never
// seen this page. In a game whose whole premise is that two specific memecoin communities are
// fighting each other, the coins should be visible as themselves.
//
// WHY IT STAYS SMALL AND SQUARE. `base.css` forbids radius, shadows and filled panels, and the page
// is otherwise ink on paper — so the artwork is the one photographic element on it. It is set at
// text scale, aligned to the baseline, and given a 1px hairline so it reads as a marker in a row of
// type rather than as an image someone dropped into the layout. No rounding: a circle-cropped avatar
// would be the single most obviously "web app" thing on a page built to avoid exactly that.

import { TOKENS, type TokenKey, type TokenMeta } from "../contract.ts";
import "./TokenIcon.css";

type IconSize = "sm" | "md" | "lg";

export function TokenIcon({
  token,
  size = "sm",
  title,
}: {
  token: TokenKey | TokenMeta;
  size?: IconSize;
  /** Overrides the tooltip. The name is always exposed to assistive tech regardless. */
  title?: string;
}) {
  const meta = typeof token === "string" ? TOKENS[token] : token;
  const label = title ?? meta.name;

  // No artwork in the repo (SOL): a lettered mark in the token's own colour, same footprint, so a
  // row of icons stays aligned whether or not every token has a picture. Inventing a logo would be
  // worse than admitting there isn't one.
  if (!meta.icon) {
    return (
      <span
        className={`tico tico--${size} tico--letter`}
        style={{ color: meta.color, borderColor: meta.color }}
        title={label}
        role="img"
        aria-label={meta.name}
      >
        {meta.name.slice(0, 1)}
      </span>
    );
  }

  return (
    <img
      className={`tico tico--${size}`}
      src={meta.icon}
      alt={meta.name}
      title={label}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

// An icon+name `TokenLabel` was written here and removed unused: every call site already had the
// name in hand and wanted control over the order and the label's own styling, so the pairing was
// always spelled out inline instead. Left out rather than left in — a component nothing calls is a
// second definition of "how a token is labelled" waiting to disagree with the first.
