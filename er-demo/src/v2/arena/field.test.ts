// THE DEFECT THIS FILE EXISTS TO PREVENT IS SOMEONE ELSE'S FACE ON YOUR FIGHTER.
//
// `syncAvatars` is the one thing that writes an identity onto a body after the body exists, and it
// writes it by looking a fighter up. Every lookup is a chance to look up the wrong one — and unlike
// almost anything else on this canvas, getting it wrong is not a cosmetic defect. A round where
// `@mock_otter`'s photograph is drawn on the wallet next to hers is the page making a false claim
// about who is in the fight, which is the failure `xLink.ts` was built to make structurally
// impossible on the wire and which must not be reintroduced two layers downstream by an off-by-one.
//
// SCOPE, STATED HONESTLY: this file covers the identity-sync seam and nothing else in `field.ts`.
// The physics — spawn, separation, the radius spring, steering, walls — has no unit test and is not
// getting one here; it is judged by looking at the field, which for a cosmetic simulation is the
// right instrument. `syncAvatars` is different because it is the one function in the file whose
// output nobody can judge by looking: a wrong face and a right face are equally plausible pictures.
//
// WHAT THIS FILE CANNOT CATCH, and the reason `e2e/links.e2e.ts` exists beside it. Every test below
// calls `syncAvatars` directly. None of them can tell you whether `arenaLoop` ever calls it — and
// "the function was correct and nobody called it" is precisely the bug this function was written to
// fix. That claim is only checkable on the assembled page, against a real canvas, with the request
// log as the witness. If you are reading this because a face stopped appearing, read that file
// first; this one will still be green.

import { describe, expect, it } from "vitest";
import type { FighterView } from "../contract.ts";
import { createField, syncAvatars } from "./field.ts";

const AVATAR = {
  otter: "/api/avatar/9990000000000002/689fad47c35a24fc7abf00987cc4c31a125c77ceabe084db6a2ade61a9471a98.webp",
  vole: "/api/avatar/9990000000000003/e6b1949191480584cfaed4ae0bbf6f008c2b2a5c6b11578d2701d2fe8d70f9dd.webp",
};

const W = 800;
const H = 600;

function fighter(id: number, over: Partial<FighterView> = {}): FighterView {
  return {
    id,
    wallet: `wallet-${id}`,
    short: `w…${id}`,
    name: `NAME_${id}`,
    side: (id % 2) as 0 | 1,
    avatarSrc: null,
    stake: 10_000_000n,
    hp: 10_000_000n,
    banked: 0n,
    house: false,
    dead: false,
    isYou: false,
    ...over,
  };
}

/** The three-fighter lobby every test below starts from: nobody linked, which is the state a round
 *  is always in on its first frame because the link feed has not resolved yet. */
function lobby(): FighterView[] {
  return [fighter(0), fighter(1), fighter(2)];
}

describe("syncAvatars", () => {
  it("delivers a link that arrived after the field was built", async () => {
    const field = createField(lobby(), W, H);
    expect(field.bodies.map((b) => b.avatarSrc)).toEqual([null, null, null]);

    // The feed resolves. Same cast — same ids, same wallets, same stakes — so `lineupChanged` says
    // nothing happened and the field is NOT rebuilt. This call is the only route the face has.
    const linked = lobby();
    linked[1] = fighter(1, { avatarSrc: AVATAR.otter });
    syncAvatars(field, linked);

    expect(field.bodies.map((b) => b.avatarSrc)).toEqual([null, AVATAR.otter, null]);
  });

  it("puts each face on ITS OWN fighter when the array arrives in a different order", async () => {
    // THE IMPERSONATION TEST, and the reason this file is named for a defect rather than a module.
    // `ensureWorld` only calls this when the lineup is unchanged, which does happen to keep the two
    // arrays aligned — so an implementation that walked them in parallel by index would pass every
    // other test here and in production. It would also be one upstream `.sort()` away from drawing a
    // verified photograph of one person on another person's money. Matching on `id` through `byId`
    // is what makes that unrepresentable rather than merely unlikely.
    const field = createField(lobby(), W, H);

    const shuffled = [
      fighter(2, { avatarSrc: AVATAR.vole }),
      fighter(0),
      fighter(1, { avatarSrc: AVATAR.otter }),
    ];
    syncAvatars(field, shuffled);

    const byWallet = new Map(field.bodies.map((b) => [b.wallet, b.avatarSrc]));
    expect(byWallet.get("wallet-2")).toBe(AVATAR.vole);
    expect(byWallet.get("wallet-1")).toBe(AVATAR.otter);
    expect(byWallet.get("wallet-0")).toBeNull();
  });

  it("returns a fighter to its coin when the link is revoked", async () => {
    const field = createField(lobby(), W, H);
    const linked = lobby();
    linked[0] = fighter(0, { avatarSrc: AVATAR.otter });
    syncAvatars(field, linked);
    expect(field.bodies[0].avatarSrc).toBe(AVATAR.otter);

    // Unlinked, suppressed by the operator, or the X account deleted — all three arrive as null, and
    // all three must land on the same flat disc as never having linked. No branch of its own.
    syncAvatars(field, lobby());
    expect(field.bodies[0].avatarSrc).toBeNull();
  });

  it("leaves every physics field exactly where it was", async () => {
    // The lazy fix for the original bug is to widen `lineupChanged` so an avatar counts as a new
    // cast. This test is what that costs, stated: a fighter mid-flight keeps its position, its
    // velocity and its radius spring across a face arriving. Anything that rebuilds instead of
    // writing will move at least one of these.
    const field = createField(lobby(), W, H);
    const b = field.bodies[1];
    b.x = 123.5;
    b.y = 456.25;
    b.vx = -7.5;
    b.vy = 3.25;
    b.r = 41.75;
    b.rVel = -2.5;
    const before = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, rVel: b.rVel };

    const linked = lobby();
    linked[1] = fighter(1, { avatarSrc: AVATAR.otter });
    syncAvatars(field, linked);

    expect(field.bodies[1]).toBe(b); // the same object, not a replacement
    expect({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.r, rVel: b.rVel }).toEqual(before);
  });

  it("skips a fighter that has no body instead of throwing", async () => {
    // This runs inside the paint path, 60 times a second. A poll that lands a fighter the field has
    // not been rebuilt around yet must cost that fighter its face for one frame, not cost the page
    // its canvas — `ensureWorld` rebuilds on the very next frame anyway.
    const field = createField(lobby(), W, H);
    const withNewcomer = [...lobby(), fighter(9, { avatarSrc: AVATAR.vole })];

    expect(() => syncAvatars(field, withNewcomer)).not.toThrow();
    expect(field.bodies).toHaveLength(3);
    expect(field.bodies.every((b) => b.avatarSrc === null)).toBe(true);
  });

  it("is idempotent — the common case, run every frame for the life of the round", async () => {
    const field = createField(lobby(), W, H);
    const linked = lobby();
    linked[2] = fighter(2, { avatarSrc: AVATAR.vole });

    for (let frame = 0; frame < 120; frame++) syncAvatars(field, linked);

    expect(field.bodies.map((b) => b.avatarSrc)).toEqual([null, null, AVATAR.vole]);
  });
});
