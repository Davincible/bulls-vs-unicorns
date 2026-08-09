// Builds the Pixi display objects for one fighter: a colored avatar circle, a truncated wallet
// label, and an hp bar. Pulled out of PixiCanvas.tsx so that component stays focused on Application
// lifecycle/wiring rather than drawing details — this module is pure pixi.js scene-graph
// construction, no lifecycle, no state beyond what's passed in.
import { Container, Graphics, Text } from "pixi.js";
import { FIGHTER_RADIUS } from "./arena/ArenaScene.ts";

const SIDE_COLOR: Record<0 | 1, number> = { 0: 0x4da3ff, 1: 0xff6b6b };
const DEAD_COLOR = 0x555a63;
const HP_BAR_WIDTH = 48;
const HP_BAR_HEIGHT = 6;
const HP_BAR_Y_OFFSET = FIGHTER_RADIUS + 10;

export interface FighterSprite {
  id: number;
  side: 0 | 1;
  /** Positioned once per frame from the matching Matter body — see gameLoop.ts's sync step. */
  root: Container;
  /** The circle itself — what impactFx.ts's glow pulse and hit-flash target. */
  avatar: Graphics;
  hpFill: Graphics;
  hpBarWidth: number;
}

function truncateWallet(wallet: string): string {
  return wallet.length <= 10 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

export function createFighterSprite(id: number, side: 0 | 1, wallet: string): FighterSprite {
  const root = new Container();
  root.label = `fighter-sprite-${id}`;

  const avatar = new Graphics().circle(0, 0, FIGHTER_RADIUS).fill({ color: SIDE_COLOR[side] });
  avatar.label = "avatar";

  const label = new Text({
    text: truncateWallet(wallet),
    style: { fontFamily: "monospace", fontSize: 11, fill: 0xffffff, align: "center" },
  });
  label.anchor.set(0.5, 0);
  label.position.set(0, -FIGHTER_RADIUS - 18);

  const hpBarBg = new Graphics()
    .roundRect(-HP_BAR_WIDTH / 2, HP_BAR_Y_OFFSET, HP_BAR_WIDTH, HP_BAR_HEIGHT, 2)
    .fill({ color: 0x1a1c22 });

  const hpFill = new Graphics();
  hpFill.position.set(-HP_BAR_WIDTH / 2, HP_BAR_Y_OFFSET);

  root.addChild(hpBarBg, hpFill, avatar, label);

  return { id, side, root, avatar, hpFill, hpBarWidth: HP_BAR_WIDTH };
}

/** Redraws the hp fill bar and dims the whole sprite once dead — called once per frame from
 *  gameLoop.ts's sync step with the fighter's current shadow-fight hp/stake/dead. `ratio` is clamped
 *  defensively (hp should never exceed stake, but a ratio > 1 would draw outside the bar background
 *  if it ever did). */
export function updateFighterSprite(sprite: FighterSprite, hp: bigint, stake: bigint, dead: boolean): void {
  const ratio = stake > 0n ? Math.max(0, Math.min(1, Number(hp) / Number(stake))) : 0;
  const color = dead ? DEAD_COLOR : SIDE_COLOR[sprite.side];

  sprite.hpFill.clear();
  if (ratio > 0) {
    sprite.hpFill.rect(0, 0, sprite.hpBarWidth * ratio, HP_BAR_HEIGHT).fill({ color: dead ? DEAD_COLOR : 0x4ade80 });
  }

  sprite.avatar.tint = color;
  sprite.root.alpha = dead ? 0.4 : 1;
}
