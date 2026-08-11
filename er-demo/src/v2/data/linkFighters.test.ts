// PUTTING A FACE ON A FIGHTER — the rules that have no visible symptom when they break.
//
// RULE ONE: ONLY A VERIFIED RECORD BECOMES A FACE. `linkFor` asks the runtime register rather than
// trusting the type, because `LinkRecord`'s compile-time brand stops the accidental construction and
// not every one — `{ ...someoneElsesRecord, handle: "blknoiz06" }` is a value TypeScript accepts, and
// it is the exact defect this whole feature exists to delete. A record that fails renders the player
// as unlinked, which is the ordinary state for most of the board and never an error.
//
// RULE TWO: IDENTITY IS PRESERVED WHEN NOTHING CHANGED, and this is load-bearing rather than a
// micro-optimisation. `LiveRound` is rebuilt on every poll and on every 250ms clock tick; the canvas,
// the extract terms and the combat feed are all memoised against `live.fighters`. A fresh array of
// identical fighters four times a second invalidates all three, forever, for no change — and the
// common case on this page is exactly that: nobody in the round has linked. Nothing on screen shows
// this failing. It shows up as a page that is inexplicably warm.
//
// THERE USED TO BE A THIRD RULE IN HERE — THE HOUSE HAS NO FACE — AND ITS TESTS WENT WITH THE GUARD
// THEY COVERED RATHER THAN AHEAD OF IT. `linkFor` took a `house` flag, `markLinkedFighters` refused a
// face to any fighter wearing one, and this file executed the WRONG composition order on purpose to
// pin what that failure looked like on screen. The browser is no longer told which wallets are the
// arena's own (`keeperStatus.ts`, schema 5), so the flag could only ever be false and the branch
// could only ever pass everybody; the rule itself now sits on the server at both ends of a link's
// life, and `linkFighters.ts`'s header carries the argument in full. Deleting a test whose subject
// has been deleted is the honest move here. What would NOT be honest is leaving it green against a
// guard that no longer decides anything — a passing test for a branch that cannot fire is worse than
// no test, because it reads as coverage.
//
// The `LinkMap` here is minted by `verifyAttestation` through `linkMapFrom`, never hand-built: a
// `LinkRecord` is branded precisely so that no test can invent one, and a fixture that cast its way
// past the brand would be a second implementation of the wire format agreeing with itself.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { nameFor, shortKey, type FighterView, type LiveRound, type Side } from "../contract.ts";
import { linkFor, markLinkedFighters, withLinks } from "./linkFighters.ts";
import { avatarPathFor, linkMapFrom, NO_LINKS, type LinkMap } from "./xLink.ts";
import { attestationKeyFrom, signAttestation } from "./xLinkSign.ts";

const KEY = attestationKeyFrom(sha256(new TextEncoder().encode("linkFighters.test key")));
const NOW = 1_800_000_000;

/** 44 base58 characters. The alphabet excludes `0`, `O`, `I` and `l`, and `verifyAttestation` checks
 *  it — so a readable prefix is padded rather than spelled with the four ambiguous glyphs. */
const wallet = (prefix: string) => prefix.padEnd(44, "x");

/** Four wallets in one round: the reader, two other entrants who have linked, and one who never did.
 *  `NEVER_LINKED` is not padding — "absent from the map" is the state most of a real board is in, and
 *  several rules below are only interesting when at least one fighter is in it. */
const RIVAL = wallet("Riva1Wa11et");
const NEVER_LINKED = wallet("Un1inkedWa11et");
const PLAYER = wallet("P1ayerWa11et");
const YOU = wallet("YourWa11et");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const AVATAR_PLAYER = avatarPathFor("111000000000000001", HASH_A);
const AVATAR_YOU = avatarPathFor("111000000000000002", HASH_B);
const AVATAR_RIVAL = avatarPathFor("111000000000000003", HASH_A);

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
  // A fixture that quietly failed verification would make half the assertions below pass for the
  // wrong reason: "this wallet has no face" is what a correctly-unlinked player and a silently
  // rejected record look like alike, and only one of those is what the test meant to set up.
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

/** Everyone in the round who has linked — which is everyone except `NEVER_LINKED`, deliberately, so
 *  every assertion made against this map still has one fighter that must come back with no face. */
const EVERYONE_LINKED = linksOf(
  { wallet: PLAYER, xId: "111000000000000001", handle: "player", avatarHash: HASH_A },
  { wallet: YOU, xId: "111000000000000002", handle: "you", avatarHash: HASH_B },
  { wallet: RIVAL, xId: "111000000000000003", handle: "rival", avatarHash: HASH_A },
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
    dead: false,
    isYou: w === YOU,
    avatarSrc: null,
    ...over,
  };
}

/** The roster exactly as the provider hands it over: decoded off the round account, no avatars on it
 *  yet. `withLinks` is the only thing that stamps anything onto a fighter after this point. */
const ROSTER: FighterView[] = [
  fighterAt(0, YOU),
  fighterAt(1, RIVAL),
  fighterAt(2, PLAYER),
  fighterAt(3, NEVER_LINKED),
];

const avatars = (fighters: readonly FighterView[]) => fighters.map((f) => f.avatarSrc);

describe("markLinkedFighters", () => {
  it("stamps the verified avatar onto the wallet it belongs to, and onto nobody else", () => {
    expect(avatars(markLinkedFighters(ROSTER, PLAYER_LINKED))).toEqual([
      null,
      null,
      AVATAR_PLAYER,
      null,
    ]);
  });

  it("hands back the very same array when the map is empty", () => {
    // The overwhelmingly common case: nobody in this round has linked. It must allocate nothing.
    expect(markLinkedFighters(ROSTER, NO_LINKS)).toBe(ROSTER);
  });

  it("hands back the very same array when the map holds nobody from this round", () => {
    expect(markLinkedFighters(ROSTER, STRANGER_LINKED)).toBe(ROSTER);
  });

  it("hands back the very same array on a second pass over unchanged input", () => {
    // The poll case. The first call lands the avatars; every one after it — four times a second, for
    // the rest of the round — must be a no-op, or the canvas, the extract terms and the combat feed
    // all rebuild for a fact that did not move.
    const first = markLinkedFighters(ROSTER, PLAYER_LINKED);
    expect(first).not.toBe(ROSTER);
    expect(markLinkedFighters(first, PLAYER_LINKED)).toBe(first);
  });

  it("hands back the very same array for a link with no picture yet", () => {
    // "Linked, avatar in flight" (`TWITTER-CONNECT.md` §7.3) is a real rung on the failure ladder and
    // renders as the ordinary flat disc. The subtle failure it guards against: reading
    // `links.get(w)?.avatarPath` WITHOUT the `?? null` yields `undefined` for a record whose
    // `avatarPath` is null, `undefined !== null` marks the array changed, and the round then churns
    // every 250ms for as long as that player stays unpictured. Nothing on screen would differ.
    const marked = markLinkedFighters(ROSTER, PLAYER_LINKED_NO_PICTURE);
    expect(marked).toBe(ROSTER);
    expect(avatars(marked)).toEqual([null, null, null, null]);
  });

  it("produces a new array when a link arrives mid-round", () => {
    // The inverse of the identity cases: when something DID change, the memos must be invalidated.
    const before = markLinkedFighters(ROSTER, NO_LINKS);
    const after = markLinkedFighters(before, PLAYER_LINKED);
    expect(after).not.toBe(before);
    expect(after[2].avatarSrc).toBe(AVATAR_PLAYER);
  });

  it("produces a new array when a link is revoked mid-round", () => {
    // `TWITTER-CONNECT.md` §6.2: unlinking takes a face off within one refresh. A revocation arrives
    // as the record simply being absent from the next poll, and the face has to come off — an array
    // reused here would leave somebody's photograph on the board after they asked for it to go.
    const linked = markLinkedFighters(ROSTER, PLAYER_LINKED);
    const revoked = markLinkedFighters(linked, NO_LINKS);
    expect(revoked).not.toBe(linked);
    expect(avatars(revoked)).toEqual([null, null, null, null]);
  });

  it("stamps every linked wallet in one pass, and leaves the unlinked one alone", () => {
    // Three faces landing together, which the single-record case above cannot show: a mapper that
    // returned after its first hit, or that keyed the map by index instead of by wallet, passes that
    // test and fails this one.
    expect(avatars(markLinkedFighters(ROSTER, EVERYONE_LINKED))).toEqual([
      AVATAR_YOU,
      AVATAR_RIVAL,
      AVATAR_PLAYER,
      null,
    ]);
  });

  it("leaves every field except `avatarSrc` untouched", () => {
    const marked = markLinkedFighters(ROSTER, EVERYONE_LINKED);
    // Positional ids especially: the hit stream names its parties by index into this array, so a
    // reorder here would silently repoint every hit in the fight.
    expect(marked.map((f) => f.id)).toEqual([0, 1, 2, 3]);
    expect(marked.map((f) => f.wallet)).toEqual(ROSTER.map((f) => f.wallet));
    expect(marked[2]).toEqual({ ...ROSTER[2], avatarSrc: AVATAR_PLAYER });
  });

  it("copes with an empty round without inventing a fighter", () => {
    const empty: FighterView[] = [];
    expect(markLinkedFighters(empty, EVERYONE_LINKED)).toBe(empty);
  });
});

describe("withLinks", () => {
  const live = { fighters: ROSTER, roundNo: 7n } as unknown as LiveRound;

  it("hands back the same round object when no avatar changed", () => {
    // Identity all the way up to the `LiveRound` itself — every memo keyed on `live` rather than on
    // `live.fighters` depends on it.
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

describe("linkFor", () => {
  it("returns nothing for a wallet that never linked", () => {
    // The ordinary state for most of the board, and never an error — `TWITTER-CONNECT.md` §8. Both
    // shapes of "no record" are covered: a populated map this wallet is simply absent from, and the
    // empty map the page holds whenever the feed is off.
    expect(linkFor(EVERYONE_LINKED, NEVER_LINKED)).toBeNull();
    expect(linkFor(NO_LINKS, PLAYER)).toBeNull();
  });

  it("returns the record itself for a linked player", () => {
    const record = linkFor(EVERYONE_LINKED, PLAYER);
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
    const marked = markLinkedFighters(ROSTER, EVERYONE_LINKED);
    for (const f of marked) {
      expect(f.avatarSrc, f.wallet).toBe(linkFor(EVERYONE_LINKED, f.wallet)?.avatarPath ?? null);
    }
  });
});
