// The static floor of the arena: a faint tinted band per side, a dividing line between them, and a
// corner label naming each side. Built once at mount, never touched again — no per-frame cost, no
// state, nothing for gameLoop.ts to update.
//
// Why it exists (Phase 7 polish, snug-floating-mitten.md): before this, the canvas was 960x540 of
// flat near-black with a couple of small circles on it, which reads as an unfinished placeholder
// rather than a deliberate arena. It also left the single most useful fact about the fight —
// which colour is which side — visible only in the sidebar table. ArenaScene.ts already spawns side
// 0 into the upper band and side 1 into the lower one (its own "purely so two teams read as
// visually distinct" comment); this just makes that existing structure visible.
//
// Presentation only, exactly like the lanes it draws: the on-chain fight has no positions, no
// bands, and no geometry of any kind — `hash(seed, step) % n` picks the pair.

import { Container, Graphics, Text } from "pixi.js";
import { SIDE_COLOR } from "../fighterSprite.ts";

const BAND_ALPHA = 0.055;
const DIVIDER_ALPHA = 0.16;
const LABEL_ALPHA = 0.4;
const LABEL_INSET = 14;

/** Returns a single container holding the whole backdrop — the caller adds it to the stage BELOW
 *  the fighters and fx layers. Destroying that container (with `children: true`) is the only
 *  cleanup this module needs. */
export function createArenaBackdrop(width: number, height: number): Container {
  const root = new Container();
  root.label = "backdrop";
  // Purely decorative and never interactive — skip it entirely during hit-testing rather than
  // walking its children on every pointer event.
  root.eventMode = "none";

  const half = height / 2;

  const bands = new Graphics()
    .rect(0, 0, width, half)
    .fill({ color: SIDE_COLOR[0], alpha: BAND_ALPHA })
    .rect(0, half, width, height - half)
    .fill({ color: SIDE_COLOR[1], alpha: BAND_ALPHA });

  const divider = new Graphics()
    .moveTo(0, half)
    .lineTo(width, half)
    .stroke({ width: 1, color: 0xffffff, alpha: DIVIDER_ALPHA });

  root.addChild(bands, divider, sideLabel(0, LABEL_INSET, half - LABEL_INSET, 1), sideLabel(1, LABEL_INSET, half + LABEL_INSET, 0));

  return root;
}

/** `anchorY` of 1 bottom-aligns the label against the divider, 0 top-aligns it — so both labels sit
 *  just inside their own band, tight to the line between them. */
function sideLabel(side: 0 | 1, x: number, y: number, anchorY: 0 | 1): Text {
  const text = new Text({
    text: `SIDE ${side}`,
    style: { fontFamily: "monospace", fontSize: 11, fontWeight: "bold", fill: SIDE_COLOR[side], letterSpacing: 2 },
  });
  text.anchor.set(0, anchorY);
  text.position.set(x, y);
  text.alpha = LABEL_ALPHA;
  return text;
}
