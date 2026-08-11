// PUTTING A FACE ON A FIGHTER — the join between a verified link and the round on screen.
//
// Pure and React-free, so every rule below is a unit test rather than a browser session. The
// identity-preservation trick it is built around — hand back the very same array when nothing
// changed — is load-bearing rather than tidy, and `markLinkedFighters` below says why.
//
// ================================================================================================
// THE HOUSE HAS NO FACE — AND THIS FILE NO LONGER ENFORCES IT. THE GUARD MOVED TO THE SERVER; IT WAS
// NOT DROPPED, AND THE NEXT READER SHOULD NOT HAVE TO REDISCOVER THAT.
//
// The obligation itself has not changed, so it is restated here rather than left to be re-derived: a
// photograph of a person on one of the arena's own fighters is not a cosmetic slip. It is a
// misrepresentation, and the specific one that costs the most trust — a player believing they beat a
// human when they beat the house.
//
// THERE USED TO BE THREE GUARDS AND THE THIRD ONE LIVED RIGHT HERE. `linkFor` took a `house` flag and
// nulled the profile for any fighter carrying it, at one call site, keyed off the very same mark the
// roster rendered from — so a fighter labelled HOUSE could not simultaneously wear a face. THAT GUARD
// CANNOT EXIST ANY MORE. It was never stronger than the browser's copy of the house wallet list, and
// the arena's wallets are no longer published anywhere a browser can read them (`keeperStatus.ts`,
// schema 5, has the decision and its consequences). A check with nothing left to check against does
// not become a weak guard; it becomes a parameter that is always `false` and a branch that never
// fires. Keeping it would have left something shaped like protection, passing every wallet, with a
// test suite still green around it. So it is gone.
//
// THE TWO GUARDS THAT REMAIN ARE BOTH ON THE SERVER, AND BETWEEN THEM THEY COVER THE WRITE PATH AND
// THE READ PATH:
//
//   1. `/api/x/link` refuses to CREATE a link for one of the arena's own wallets.
//   2. `/api/links` refuses to SERVE one.
//
// That is the durable form of the rule, and the old note here already said as much in its last line:
// the wallets are ours, so the answer that actually holds is operational — we never link them. What
// is left for the client is to render what the server was willing to hand it, and nothing more.
// ================================================================================================

import type { FighterView, LiveRound } from "../contract.ts";
import { isVerifiedRecord, type LinkMap, type LinkRecord } from "./xLink.ts";

/**
 * Stamp `avatarSrc` onto every fighter from the verified link map.
 *
 * RETURNS THE INPUT ARRAY WHEN NOTHING CHANGED, and that is not a micro-optimisation — it is what
 * keeps this out of the memo graph. `LiveRound` is rebuilt on every poll and every 250ms clock tick,
 * and the canvas, the extract terms and the combat feed are all memoised against `live.fighters`. A
 * fresh array with identical contents four times a second invalidates all three for nothing. The
 * overwhelmingly common case — nobody in this round has linked — allocates nothing at all.
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
    const avatarSrc = avatarFor(links, f.wallet);
    if (avatarSrc === f.avatarSrc) return f;
    changed = true;
    return { ...f, avatarSrc };
  });
  return changed ? marked : fighters;
}

/** The one lookup, so the verification guard cannot be applied in one place and forgotten in
 *  another. */
function avatarFor(links: LinkMap, wallet: string): string | null {
  const record = linkFor(links, wallet);
  return record === null ? null : (record.avatarPath ?? null);
}

/**
 * The same, for a whole round — the form the provider calls.
 *
 * Identity is preserved all the way up to the `LiveRound` itself, for the reason spelled out on
 * `markLinkedFighters`: a fresh round object with identical contents would invalidate every memo
 * keyed on `live` four times a second. Null passes straight through — there is nothing to stamp on a
 * page with no round.
 */
export function withLinks(live: LiveRound | null, links: LinkMap): LiveRound | null {
  if (live === null) return null;
  const fighters = markLinkedFighters(live.fighters, links);
  return fighters === live.fighters ? live : { ...live, fighters };
}

/**
 * The identity to render beside a wallet, ANYWHERE ON THE DOM — one lookup, so the verification rule
 * and the "absent means unlinked" rule are answered the same way on every surface.
 *
 * IT TAKES A WALLET AND NOTHING ELSE, which is a narrowing worth noting because it used to take more.
 * A `house` flag rode alongside the wallet so each caller could assert that its row was not one of the
 * arena's own fighters; the browser can no longer know that about anybody, and the guard now sits on
 * the server at both ends of the link's life. See this file's header — that is where the argument
 * lives, and it is worth reading before anything like it is reintroduced here.
 *
 * Returns `null` for unlinked, which is the ordinary state and never an error.
 */
export function linkFor(links: LinkMap, wallet: string): LinkRecord | null {
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
