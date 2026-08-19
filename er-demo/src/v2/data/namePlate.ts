// WHAT GOES IN A ROW'S NAME SLOT — one answer, for every surface on the page.
//
// Pure and React-free, so the rule below is a unit test rather than a browser session. There are
// exactly three answers and no fourth, which is the whole design.
//
// ================================================================================================
// THE RULE: A FIGHTER WITH NO LINKED X IDENTITY SHOWS NO USERNAME AT ALL.
//
// Not a placeholder, not "Anonymous", not a dash, and above all not an invented one. The truncated
// address already on the row is what identifies it — a real, checkable fact, and the thing this page
// already uses everywhere else a wallet has to be named.
//
// THIS REPLACES `contract.ts#nameFor`, which hashed a wallet into `KESTREL_42` / `ONYX_07` off a
// forty-word table and gave one to EVERY fighter, linked or not. Two things were wrong with it and
// only the first was visible:
//
//   1. It was an identicon made of letters. `arena/faces.ts` had already refused the picture version
//      of exactly this — an unlinked player gets the honest side-coloured disc rather than a
//      generated avatar — and the name slot was quietly doing the thing the face slot had rejected,
//      on the same row, at the same time. The two agree now.
//   2. A board full of invented usernames reads as a board full of people. It is a claim about who is
//      on the page, made by a hash function, about wallets it knows nothing about.
//
// THE RULE IS ABOUT LINKED VERSUS UNLINKED AND NOTHING ELSE, and that is load-bearing rather than a
// turn of phrase. It is applied identically to every wallet on the page: this module takes a wallet
// and a link map and has nowhere to put anything else. It does not accept, derive, or have a field
// for any other property of a wallet — see `linkFighters.ts`'s header, which records a `house`
// parameter being DELETED for the same reason and is the argument in full. `namePlate.test.ts`
// asserts the consequence directly: two different unlinked wallets produce byte-identical plates, so
// nothing wallet-derived can survive into the name slot by any route.
// ================================================================================================

import { linkFor } from "./linkFighters.ts";
import { identityText, type LinkMap, type LinkRecord } from "./xLink.ts";

/**
 * The three things a name slot can contain. Rendered by each surface in its own idiom — `XIdentity`
 * on the boards, plain type in the overlays and the log — but DECIDED here, once.
 */
export type NamePlate =
  /** The reader's own row, on a surface where the name slot is what marks it. */
  | { kind: "you" }
  /** This wallet proved control of an X account. The `@handle` is the identity; see `identityText`. */
  | { kind: "handle"; link: LinkRecord }
  /** No username. The address alone identifies this row, and every surface renders one. */
  | { kind: "none" };

/**
 * WHERE THIS SURFACE SAYS "THIS ROW IS YOURS" — the caller's convention, passed in rather than
 * guessed at.
 *
 * The page has two layouts for the reader's own row and both predate this module, so neither is
 * being invented here and neither may be regressed:
 *
 *   · The arena rosters, the field-leaders overlay and the combat log print `YOU` IN PLACE OF the
 *     name. The slot is the only thing on those rows that could say it.
 *   · The three leaderboards, the history table and the fighter inspector print the identity AND a
 *     separate `you` marker beside it. Orientation is already paid for.
 *
 * A three-state union rather than an `isYou` boolean plus a convention, because the pair admits a
 * combination that means nothing — "not the reader's row, and the name slot is where we would have
 * said so" — and a parameter shape that can be filled in nonsensically eventually is.
 */
export type YouCue =
  /** Not the reader's row — or a surface that does not distinguish the reader's rows at all, which
   *  the wins ticker genuinely does not. Either way, nothing about "you" belongs in this slot. */
  | "unmarked"
  /** The reader's row, on a surface whose ONLY orientation cue is this slot. */
  | "name-slot"
  /** The reader's row, on a surface that prints its own marker beside this slot. */
  | "beside";

/**
 * What to put in this row's name slot.
 *
 * `"name-slot"` OUTRANKS A HANDLE, AND `"beside"` DOES NOT. One rule read against two layouts rather
 * than two rules: THE SLOT DOES THE JOB NOTHING ELSE ON THE ROW IS DOING.
 *
 * Where the slot is the only orientation cue, its job is orientation — and a reader's own `@handle`
 * is the single identity on the page that tells them nothing they did not already know, so spending
 * the slot on it costs a scan of the roster for the row that matters most. Where a marker has
 * already been spent beside the slot, its job is identity, and printing `YOU` there would cost a
 * linked reader their handle in order to repeat something the row has just said. `"unmarked"` falls
 * through for the same reason: nothing is asking this slot to orient anybody.
 *
 * The verification guard is NOT re-implemented here. `linkFor` is the one lookup that applies
 * `isVerifiedRecord`, and a record that fails it renders as `none` — never as a handle, and never as
 * an error. See `linkFighters.ts`.
 */
export function namePlate(links: LinkMap, wallet: string, you: YouCue): NamePlate {
  if (you === "name-slot") return { kind: "you" };
  const link = linkFor(links, wallet);
  return link === null ? { kind: "none" } : { kind: "handle", link };
}

/**
 * The plate as PLAIN TEXT, for the surfaces that cannot render an element — a `title` attribute, an
 * `aria-label`, a toast line, a marquee.
 *
 * `short` IS PASSED IN RATHER THAN DERIVED FROM A WALLET, because every display type in
 * `contract.ts` already carries one (`FighterView`, `RoundPlayer`, `StandingsRow`, `BigWin`, and the
 * provider's `you`) computed once in the data layer. A second `shortKey()` call at a render site is
 * a second place that formats an address, and the page has exactly one.
 *
 * NO CASE RETURNS AN EMPTY STRING. A text surface that got one would print a gap where an identity
 * goes, which is the placeholder this module exists to refuse — so `none` resolves to the address
 * itself, which is what the DOM surfaces show in that slot too.
 */
export function plateText(plate: NamePlate, short: string): string {
  switch (plate.kind) {
    case "you":
      return "YOU";
    case "handle":
      // `identityText`, never `record.handle`: it is the only sanctioned way to print a linked
      // identity and it is what puts the `@` on. See `xLink.ts`'s `DisplayName`.
      return identityText(plate.link).handle;
    case "none":
      return short;
  }
}
