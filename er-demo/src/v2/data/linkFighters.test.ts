// PUTTING A FACE ON A FIGHTER — the two rules that have no visible symptom when they break.
//
// This is the mirror of `houseFighters.test.ts`, deliberately, because `linkFighters.ts` is the
// mirror of `houseFighters.ts` and two subtly different implementations of "stamp a field onto every
// fighter" is how the two end up disagreeing about one roster.
//
// RULE ONE: THE HOUSE HAS NO FACE. `SOCIAL.md` §2.7 — "a face means a person". The keeper seats house
// wallets so a lobby is never empty, and a lobby holding a single house fighter is most of an idle
// arena's life. A photograph on one of those is not cosmetic; it is the misrepresentation that costs
// the most trust, because a fan believes they beat a person. Two of the three guards live on the
// server; this is the third, and the only one that keys off the same `house` mark the roster renders,
// so it is the one a player is actually looking at. Its whole correctness depends on an ORDERING —
// `withLinks` after `withHouseMarks` — and an ordering is not a type. So the wrong order is executed
// below and the face it produces is asserted, because `linkFighters.ts` promises in a comment that
// this test exists and a promise in a comment is not a test.
//
// RULE TWO: IDENTITY IS PRESERVED WHEN NOTHING CHANGED, and this is load-bearing rather than a
// micro-optimisation. `LiveRound` is rebuilt on every poll and on every 250ms clock tick; the canvas,
// the extract terms and the combat feed are all memoised against `live.fighters`. A fresh array of
// identical fighters four times a second invalidates all three, forever, for no change — and the
// common case on this page is exactly that: nobody in the round has linked. Nothing on screen shows
// this failing. It shows up as a page that is inexplicably warm.
//
// The `LinkMap` here is minted by `verifyAttestation` through `linkMapFrom`, never hand-built: a
// `LinkRecord` is branded precisely so that no test can invent one, and a fixture that cast its way
// past the brand would be a second implementation of the wire format agreeing with itself.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { nameFor, shortKey, type FighterView, type LiveRound, type Side } from "../contract.ts";
import { linkFor, markLinkedFighters, withLinks } from "./linkFighters.ts";
import { markHouseFighters, withHouseMarks } from "./houseFighters.ts";
import { avatarPathFor, linkMapFrom, NO_LINKS, type LinkMap } from "./xLink.ts";
import { attestationKeyFrom, signAttestation } from "./xLinkSign.ts";
import type { HouseRoster } from "./keeperStatus.ts";

const KEY = attestationKeyFrom(sha256(new TextEncoder().encode("linkFighters.test key")));
const NOW = 1_800_000_000;

/** 44 base58 characters. The alphabet excludes `0`, `O`, `I` and `l`, and `verifyAttestation` checks
 *  it — so a readable prefix is padded rather than spelled with the four ambiguous glyphs. */
const wallet = (prefix: string) => prefix.padEnd(44, "x");

const HOUSE_A = wallet("HouseWa11etA");
const HOUSE_B = wallet("HouseWa11etB");
const PLAYER = wallet("P1ayerWa11et");
const YOU = wallet("YourWa11et");

const DISCLOSURE = "The house seats wallets so a lobby is never empty.";
const ROSTER: HouseRoster = { house: { wallets: [HOUSE_A, HOUSE_B], disclosure: DISCLOSURE } };

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const AVATAR_PLAYER = avatarPathFor("111000000000000001", HASH_A);
const AVATAR_YOU = avatarPathFor("111000000000000002", HASH_B);
const AVATAR_HOUSE = avatarPathFor("111000000000000003", HASH_A);

interface Claim {
  readonly wallet: string;
  readonly xId: string;
  readonly handle: string;
  /** `""` is the wire's "linked, but we do not have the picture" — a real state, and one this file
   *  cares about because it must not churn the array. */
  readonly avatarHash: string;
}

/** A verified `LinkMap`, minted the only way one can be: signed, then put through the real verifier. */
function linksOf(...claims: readonly Claim[]): LinkMap {
  const attestations = claims.map((c) =>
    signAttestation(
      {
        wallet: c.wallet,
        xId: c.xId,
        handle: c.handle,
        displayName: "",
        avatarPath: c.avatarHash === "" ? "" : avatarPathFor(c.xId, c.avatarHash),
        linkedAt: NOW - 86_400,
      },
      KEY,
      NOW,
    ),
  );
  const { links, rejected } = linkMapFrom({ links: attestations }, [KEY.publicKey], NOW);
  // A fixture that quietly failed verification would make every assertion below pass for the wrong
  // reason — "no face" is what a rejected record and a correct house guard look like alike.
  if (rejected.length > 0) throw new Error(`fixture did not verify: ${rejected.join(", ")}`);
  if (links.size !== claims.length) throw new Error("fixture lost a record");
  return links;
}

const PLAYER_LINKED = linksOf({
  wallet: PLAYER,
  xId: "111000000000000001",
  handle: "player",
  avatarHash: HASH_A,
});

const EVERYONE_LINKED = linksOf(
  { wallet: PLAYER, xId: "111000000000000001", handle: "player", avatarHash: HASH_A },
  { wallet: YOU, xId: "111000000000000002", handle: "you", avatarHash: HASH_B },
  { wallet: HOUSE_A, xId: "111000000000000003", handle: "house", avatarHash: HASH_A },
);

/** Somebody who linked, but whose picture has not been fetched yet — `avatarPath` is null. */
const PLAYER_LINKED_NO_PICTURE = linksOf({
  wallet: PLAYER,
  xId: "111000000000000001",
  handle: "player",
  avatarHash: "",
});

/** A verified link for a wallet that is not in this round at all. */
const STRANGER_LINKED = linksOf({
  wallet: wallet("StrangerWa11et"),
  xId: "111000000000000009",
  handle: "stranger",
  avatarHash: HASH_A,
});

function fighterAt(id: number, w: string, over: Partial<FighterView> = {}): FighterView {
  return {
    id,
    wallet: w,
    short: shortKey(w),
    name: nameFor(w),
    side: (id % 2) as Side,
    stake: 100n,
    hp: 100n,
    banked: 0n,
    house: false,
    dead: false,
    isYou: w === YOU,
    avatarSrc: null,
    ...over,
  };
}

/** The roster as it arrives — no house marks yet. `withHouseMarks` is what stamps them. */
const RAW: FighterView[] = [
  fighterAt(0, YOU),
  fighterAt(1, HOUSE_A),
  fighterAt(2, PLAYER),
  fighterAt(3, HOUSE_B),
];

/** The roster the provider actually hands to `markLinkedFighters`: house marks already stamped. */
const MARKED: FighterView[] = markHouseFighters(RAW, ROSTER);

const avatars = (fighters: readonly FighterView[]) => fighters.map((f) => f.avatarSrc);

describe("markLinkedFighters", () => {
  it("stamps the verified avatar onto the wallet it belongs to, and onto nobody else", () => {
    expect(avatars(markLinkedFighters(MARKED, PLAYER_LINKED))).toEqual([
      null,
      null,
      AVATAR_PLAYER,
      null,
    ]);
  });

  it("never gives a house fighter a face, even holding a verified record for its wallet", () => {
    // CLIENT GUARD THREE, and the record here is genuinely verified — signed by a trusted key, inside
    // its seven days, same-origin path. It is refused anyway, because a fighter labelled HOUSE in the
    // roster beside it cannot simultaneously wear a person's photograph. See `SOCIAL.md` §2.7.
    const marked = markLinkedFighters(MARKED, EVERYONE_LINKED);
    expect(marked[1].house).toBe(true);
    expect(marked[1].avatarSrc).toBeNull();
    expect(avatars(marked)).toEqual([AVATAR_YOU, null, AVATAR_PLAYER, null]);
    // And the record is there to be found — the guard is doing the refusing, not an empty map.
    expect(EVERYONE_LINKED.get(HOUSE_A)?.avatarPath).toBe(AVATAR_HOUSE);
  });

  it("hands back the very same array when the map is empty", () => {
    // The overwhelmingly common case: nobody in this round has linked. It must allocate nothing.
    expect(markLinkedFighters(MARKED, NO_LINKS)).toBe(MARKED);
  });

  it("hands back the very same array when the map holds nobody from this round", () => {
    expect(markLinkedFighters(MARKED, STRANGER_LINKED)).toBe(MARKED);
  });

  it("hands back the very same array on a second pass over unchanged input", () => {
    // The poll case. The first call lands the avatars; every one after it — four times a second, for
    // the rest of the round — must be a no-op, or the canvas, the extract terms and the combat feed
    // all rebuild for a fact that did not move.
    const first = markLinkedFighters(MARKED, PLAYER_LINKED);
    expect(first).not.toBe(MARKED);
    expect(markLinkedFighters(first, PLAYER_LINKED)).toBe(first);
  });

  it("hands back the very same array for a link with no picture yet", () => {
    // "Linked, avatar in flight" (`TWITTER-CONNECT.md` §7.3) is a real rung on the failure ladder and
    // renders as the ordinary flat disc. The subtle failure it guards against: reading
    // `links.get(w)?.avatarPath` WITHOUT the `?? null` yields `undefined` for a record whose
    // `avatarPath` is null, `undefined !== null` marks the array changed, and the round then churns
    // every 250ms for as long as that player stays unpictured. Nothing on screen would differ.
    const marked = markLinkedFighters(MARKED, PLAYER_LINKED_NO_PICTURE);
    expect(marked).toBe(MARKED);
    expect(avatars(marked)).toEqual([null, null, null, null]);
  });

  it("produces a new array when a link arrives mid-round", () => {
    // The inverse of the identity cases: when something DID change, the memos must be invalidated.
    const before = markLinkedFighters(MARKED, NO_LINKS);
    const after = markLinkedFighters(before, PLAYER_LINKED);
    expect(after).not.toBe(before);
    expect(after[2].avatarSrc).toBe(AVATAR_PLAYER);
  });

  it("produces a new array when a link is revoked mid-round", () => {
    // `TWITTER-CONNECT.md` §6.2: unlinking takes a face off within one refresh. A revocation arrives
    // as the record simply being absent from the next poll, and the face has to come off — an array
    // reused here would leave somebody's photograph on the board after they asked for it to go.
    const linked = markLinkedFighters(MARKED, PLAYER_LINKED);
    const revoked = markLinkedFighters(linked, NO_LINKS);
    expect(revoked).not.toBe(linked);
    expect(avatars(revoked)).toEqual([null, null, null, null]);
  });

  it("leaves every field except `avatarSrc` untouched", () => {
    const marked = markLinkedFighters(MARKED, EVERYONE_LINKED);
    // Positional ids especially: the hit stream names its parties by index into this array, so a
    // reorder here would silently repoint every hit in the fight.
    expect(marked.map((f) => f.id)).toEqual([0, 1, 2, 3]);
    expect(marked.map((f) => f.wallet)).toEqual(MARKED.map((f) => f.wallet));
    expect(marked.map((f) => f.house)).toEqual([false, true, false, true]);
    expect(marked[2]).toEqual({ ...MARKED[2], avatarSrc: AVATAR_PLAYER });
  });

  it("copes with an empty round without inventing a fighter", () => {
    const empty: FighterView[] = [];
    expect(markLinkedFighters(empty, EVERYONE_LINKED)).toBe(empty);
  });
});

describe("withLinks", () => {
  const live = { fighters: MARKED, roundNo: 7n } as unknown as LiveRound;

  it("hands back the same round object when no avatar changed", () => {
    // Identity all the way up to the `LiveRound`, as `withHouseMarks` does — every memo keyed on
    // `live` rather than on `live.fighters` depends on it.
    expect(withLinks(live, NO_LINKS)).toBe(live);
    expect(withLinks(live, STRANGER_LINKED)).toBe(live);
    expect(withLinks(live, PLAYER_LINKED_NO_PICTURE)).toBe(live);
  });

  it("rebuilds only when an avatar actually lands, and carries the rest of the round with it", () => {
    const next = withLinks(live, PLAYER_LINKED);
    expect(next).not.toBe(live);
    expect(avatars(next?.fighters ?? [])).toEqual([null, null, AVATAR_PLAYER, null]);
    expect(next?.roundNo).toBe(7n);
  });

  it("passes a missing round straight through", () => {
    expect(withLinks(null, EVERYONE_LINKED)).toBeNull();
  });
});

describe("the ordering `linkFighters.ts` promises", () => {
  // THIS IS THE TEST THE COMMENT ON `withLinks` SAYS EXISTS. The house guard reads
  // `FighterView.house`, which `withHouseMarks` is what stamps. Run the two in the other order and
  // every fighter is still `house: false` when the guard runs, so the guard passes everybody — and
  // the house mark then lands on top of a fighter that is already wearing a face.
  //
  // Nothing types this. Both compositions compile, both return a `LiveRound`, and the wrong one is
  // wrong only for the fighters the keeper seated. So it is asserted rather than commented.
  const raw = { fighters: RAW, roundNo: 7n } as unknown as LiveRound;

  it("nulls the house fighter's avatar when links are applied after the house marks", () => {
    const right = withLinks(withHouseMarks(raw, ROSTER), EVERYONE_LINKED);
    const houseFighter = (right?.fighters ?? []).find((f) => f.wallet === HOUSE_A);
    expect(houseFighter?.house).toBe(true);
    expect(houseFighter?.avatarSrc).toBeNull();
  });

  it("would put a face on a HOUSE-tagged fighter if the two were composed the other way round", () => {
    // The failure, executed. This is what the page renders if somebody reorders the provider: a row
    // carrying the HOUSE tag and a real person's photograph at the same time.
    const wrong = withHouseMarks(withLinks(raw, EVERYONE_LINKED), ROSTER);
    const houseFighter = (wrong?.fighters ?? []).find((f) => f.wallet === HOUSE_A);
    expect(houseFighter?.house).toBe(true);
    expect(houseFighter?.avatarSrc).toBe(AVATAR_HOUSE);
  });
});

describe("linkFor", () => {
  it("returns nothing for a house fighter, whatever the map says", () => {
    // The same rule as the array pass, at the DOM surfaces — so a leaderboard row or a history row
    // cannot reach around the round's `avatarSrc` and render the handle instead.
    expect(linkFor(EVERYONE_LINKED, HOUSE_A, true)).toBeNull();
  });

  it("returns nothing for a wallet that never linked", () => {
    // The ordinary state for most of the board, and never an error — `TWITTER-CONNECT.md` §8.
    expect(linkFor(EVERYONE_LINKED, HOUSE_B, false)).toBeNull();
    expect(linkFor(NO_LINKS, PLAYER, false)).toBeNull();
  });

  it("returns the record itself for a linked player", () => {
    const record = linkFor(EVERYONE_LINKED, PLAYER, false);
    expect(record?.handle).toBe("player");
    expect(record?.avatarPath).toBe(AVATAR_PLAYER);
    // The very record in the map, so every surface renders one identity rather than a copy that
    // could be trimmed differently on the way out.
    expect(record).toBe(EVERYONE_LINKED.get(PLAYER));
  });

  it("agrees with the avatar stamped on the round, for every fighter", () => {
    // The two paths — `avatarSrc` on the canvas, `linkFor` on the DOM — answer the same question and
    // must never disagree in front of a reader: a disc with a photograph beside a row with no handle,
    // or worse, the reverse.
    const marked = markLinkedFighters(MARKED, EVERYONE_LINKED);
    for (const f of marked) {
      expect(f.avatarSrc, f.wallet).toBe(linkFor(EVERYONE_LINKED, f.wallet, f.house)?.avatarPath ?? null);
    }
  });
});
