// PUTTING A FACE ON A FIGHTER — the join between a verified link and the round on screen.
//
// Pure and React-free, so every rule below is a unit test rather than a browser session. It is a
// deliberate mirror of `houseFighters.ts`, down to the identity-preservation trick, because the two
// do the same shape of job on the same object four times a second and a second, subtly different
// implementation of "stamp a field onto every fighter" is how two of them end up disagreeing.
//
// ================================================================================================
// THE HOUSE HAS NO FACE, AND THIS IS THE ONE PLACE THE CLIENT ENFORCES IT.
//
// The keeper seats house wallets so a lobby is never empty, and a lobby holding a single house
// fighter is most of an idle arena's life. A photograph of a person on one of those would not be a
// cosmetic slip — it is a misrepresentation, and the specific one that costs the most trust: a
// player believing they beat a human when they beat the house.
//
// There are three guards, and they are independent on purpose:
//
//   1. `/api/x/link` refuses to CREATE a link for a wallet on the keeper's published house list.
//   2. `/api/links` refuses to SERVE one, and `xLink.ts#linkMapFrom` drops one that arrives anyway.
//   3. Here — the profile is nulled for any fighter already marked `house`, at ONE call site.
//
// Guard 3 exists because it is the only one that keys off the same `house` mark the rest of the page
// renders from, so a fighter that is labelled `house` in the roster cannot simultaneously wear a
// face. Guards 1 and 2 key off the wallet list; this one keys off the consequence. If they ever
// disagree, this is the one the player is looking at.
//
// It is only as good as `isHouseWallet`, which is disclosure on the keeper's own word —
// `keeperStatus.ts` says so and is right to. The durable version is operational: the house wallets
// are ours and we simply never link them.
// ================================================================================================

import type { FighterView, LiveRound } from "../contract.ts";
import { isVerifiedRecord, type LinkMap, type LinkRecord } from "./xLink.ts";

/**
 * Stamp `avatarSrc` onto every fighter from the verified link map.
 *
 * RETURNS THE INPUT ARRAY WHEN NOTHING CHANGED, exactly as `markHouseFighters` does and for exactly
 * its reason: `LiveRound` is rebuilt on every poll and every 250ms clock tick, and the canvas, the
 * extract terms and the combat feed are all memoised against `live.fighters`. A fresh array with
 * identical contents four times a second invalidates all three for nothing. The overwhelmingly
 * common case — nobody in this round has linked — allocates nothing at all.
 *
 * ONLY `avatarSrc` CROSSES INTO THE ROUND. The handle, the display name and the linked date stay in
 * the map and are looked up by wallet at the DOM surfaces that need them. That is `SPEC.md`'s rule
 * that the arena canvas never touches data, honoured by giving the canvas the narrowest thing that
 * does its job: one string, already validated to a same-origin path by `verifyAttestation`. Handing
 * it a whole identity object would be handing it a handle, and a handle on the canvas is a decision
 * about typography that belongs on the other side of the boundary.
 */
export function markLinkedFighters(fighters: FighterView[], links: LinkMap): FighterView[] {
  // THE ZERO-ALLOCATION CASE, AND IT REALLY IS ZERO NOW. This used to `map` first and discard the
  // result when nothing changed, while the doc comment above claimed it allocated nothing — four
  // throwaway 48-element arrays a second, and a false statement about it.
  //
  // BOTH HALVES OF THIS CONDITION ARE LOAD-BEARING. `links.size === 0` alone is WRONG and was
  // briefly written that way: an empty map is also what REVOCATION looks like, so returning the input
  // array there would leave every already-stamped `avatarSrc` in place and a face would survive being
  // unlinked for as long as the tab stayed open. The `every` is the scan that distinguishes "nobody
  // has linked" from "everybody just unlinked"; it allocates nothing and short-circuits on the first
  // fighter that still carries a face. `linkFighters.test.ts` caught the one-condition version on its
  // first run, which is exactly what that test is for.
  if (links.size === 0 && fighters.every((f) => f.avatarSrc === null)) return fighters;

  let changed = false;
  const marked = fighters.map((f) => {
    const avatarSrc = avatarFor(links, f.wallet, f.house);
    if (avatarSrc === f.avatarSrc) return f;
    changed = true;
    return { ...f, avatarSrc };
  });
  return changed ? marked : fighters;
}

/** The one lookup, so the house guard and the verification guard cannot be applied in one place and
 *  forgotten in another. */
function avatarFor(links: LinkMap, wallet: string, house: boolean): string | null {
  const record = linkFor(links, wallet, house);
  return record === null ? null : (record.avatarPath ?? null);
}

/**
 * The same, for a whole round — the form the provider calls.
 *
 * MUST RUN AFTER `withHouseMarks`. It reads `FighterView.house`, which that function is what stamps;
 * run in the other order every fighter is `house: false` and the house guard above silently passes
 * everybody. The provider composes them as `markLinkedFighters(markHouseFighters(...))` for that
 * reason, and `linkFighters.test.ts` pins the failure so the ordering is a red test rather than a
 * comment somebody trusted.
 *
 * Identity preserved all the way up to the `LiveRound` itself, as `withHouseMarks` does.
 */
export function withLinks(live: LiveRound | null, links: LinkMap): LiveRound | null {
  if (live === null) return null;
  const fighters = markLinkedFighters(live.fighters, links);
  return fighters === live.fighters ? live : { ...live, fighters };
}

/**
 * The identity to render beside a wallet, ANYWHERE ON THE DOM — one lookup, so the house rule and
 * the "absent means unlinked" rule are answered the same way on every surface.
 *
 * `house` is a parameter rather than something this function digs out, because the three DOM
 * surfaces that call it hold three different row types — `FighterView` on the round tab,
 * `StandingsRow` on standings, `RoundPlayer` in history — and only the first carries a house mark.
 * The other two are aggregates over rounds whose house membership was already excluded upstream.
 * Making the caller state it is what stops a row type quietly acquiring a face because nobody
 * noticed it had no `house` field to check.
 *
 * Returns `null` for unlinked, which is the ordinary state and never an error.
 */
export function linkFor(links: LinkMap, wallet: string, house: boolean): LinkRecord | null {
  if (house) return null;
  const record = links.get(wallet) ?? null;
  if (record === null) return null;
  // THE VERIFICATION GUARD. `LinkRecord`'s compile-time brand blocks the accidental construction but
  // not every one — `any` widening and object spread both produce a value TypeScript accepts, and
  // `{ ...someoneElsesRecord, handle: "blknoiz06" }` is precisely the defect this feature exists to
  // delete, in one line, with no cast to grep for. `isVerifiedRecord` asks the runtime register
  // instead, which a copy cannot get into. See `xLink.ts`'s header.
  //
  // Failing here means rendering the player as unlinked, which is the ordinary state and costs
  // nothing — never an error, never a throw. A face is the thing that must be earned.
  if (!isVerifiedRecord(record)) return null;
  return record;
}
