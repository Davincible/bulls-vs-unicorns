// X IDS THE REAL REGISTER MAY NEVER TOUCH.
//
// The `?links=mock` fixture serves static files under the SAME path shape as the live avatar proxy
// (`/api/avatar/<x_id>/<hash>.webp`), for a small set of reserved X account ids. That overlap is
// deliberate — it is what lets the fixture exercise the real rendering path — and it is also the one
// way a demo identity could become a real one: an id that exists in both worlds is an id where "this
// is a fixture" and "this is a person" are the same string.
//
// So the register refuses them outright, at both ends:
//
//   * `assertNotReserved()` on the INGEST path, so bytes can never be minted for one;
//   * the same check on the SERVE path, so bytes that somehow exist can never be handed out.
//
// Two checks rather than one, because they fail differently: the first is a write nobody made, the
// second is a read of a row somebody put there by hand. Neither is expected. Both are cheap.
//
// ------------------------------------------------------------------------------------------------
// WHERE THIS LIST COMES FROM, AND WHAT KEEPS IT HONEST.
//
// The ids below are the `identities[].xId` values in `er-demo/public/links.mock.json`, which is the
// fixture's own source of truth and ships the matching static images at
// `er-demo/public/api/avatar/<x_id>/<hash>.webp` — the exact path shape this proxy serves.
//
// They are HARDCODED here rather than read from that file, because a serverless function has no
// `public/` to read and a deny list that depends on a file being present is a deny list that fails
// open when the file is not. The copy is kept honest by `reserved.test.ts`, which reads the fixture
// and asserts every id in it appears below. If somebody adds a seventh mock identity, that test goes
// red on their commit rather than on the day a real account happens to collide with it.
// ------------------------------------------------------------------------------------------------

/** The reserved fixture ids — see this file's header. */
export const RESERVED_MOCK_X_IDS: ReadonlySet<string> = new Set<string>([
  "9990000000000001",
  "9990000000000002",
  "9990000000000003",
  "9990000000000004",
  "9990000000000005",
  "9990000000000006",
]);

export class ReservedXIdError extends Error {
  readonly xId: string;

  constructor(xId: string) {
    super(`x_id ${xId} is reserved for the ?links=mock fixture and may never appear in the register`);
    this.name = "ReservedXIdError";
    this.xId = xId;
  }
}

/** Throws rather than returning a boolean: every caller's only correct response is to stop, and a
 *  boolean is a thing a caller can forget to look at. */
export function assertNotReserved(xId: string, reserved: ReadonlySet<string> = RESERVED_MOCK_X_IDS): void {
  if (reserved.has(xId)) throw new ReservedXIdError(xId);
}

/** The predicate, for the serve path — which must answer with a 404 rather than an exception, because
 *  a 404 is what every other "we will not serve this" answer looks like and a reserved id must not be
 *  distinguishable from an unknown one. */
export function isReservedXId(xId: string, reserved: ReadonlySet<string> = RESERVED_MOCK_X_IDS): boolean {
  return reserved.has(xId);
}

// ================================================================================================
// HANDLES THE REGISTER WILL NOT PUT A FACE BESIDE, EVEN THOUGH X SAYS THEY ARE REAL.
//
// Every handle that reaches the write path is GENUINE — it came out of a verified identity token, so
// whoever presented it really does control that X account. This list is not about forgery. It is about
// one specific confusion the arena's own page would create: a fighter labelled `@support` or
// `@bullsvsunicorns`, with a real avatar, on our own leaderboard, reads as US. That is a
// misrepresentation of the same shape as §6.3's house-wallet rule — an account wearing the operator's
// authority — and it is the one the operator cannot answer afterwards, because the impersonation
// happens on the page the player is already trusting.
//
// ------------------------------------------------------------------------------------------------
// EXACT MATCHES ONLY, AND THE ALTERNATIVE WAS SERIOUSLY CONSIDERED AND REJECTED.
//
// The tempting rule is a SHAPE — "any handle containing `bullsvsunicorns`", or "anything ending in
// `_support`". It catches far more, and it refuses `@bullsvsunicornsfan`, `@ilovebullsvsunicorns` and
// every other account belonging to exactly the people this feature exists for. That failure is
// unexplainable to the player (the copy they would see is `FAILURE_COPY.unavailable`, which says "try
// again in a minute" about something that will never work) and invisible to us. Refusing a fan to catch
// a troll is the wrong direction on a feature whose whole point is fans.
//
// So this list is a FLOOR, not a solution, and the real answer to a creative impersonator is the one
// §7.4 already built: `scripts/xlink-suppress.ts`, which takes an identity down inside one CDN TTL.
// "A moderation capability you have to build during the incident is not a capability" — it exists, it
// is tested, and it covers everything a static list cannot.
//
// CASE IS FOLDED, because X handles are case-insensitive for the purposes of who you appear to be:
// `@Support` and `@support` are different strings and the same impersonation.
// ================================================================================================

/**
 * The arena's own names and the generic operator words. Lowercase; compare through
 * `isReservedHandle`.
 *
 * Kept deliberately short. Every entry has to answer "would a face beside this handle, on our
 * leaderboard, read as the site speaking?" — which is why `admin` and `support` are here and, say,
 * `bulls` and `unicorns` are not: those are ordinary words that thousands of real accounts own, and a
 * fighter called `@bulls` reads as a person with a good handle rather than as us.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set<string>([
  // The site itself, and the two spellings of it somebody would actually register.
  "bullsvsunicorns",
  "bullsvunicorns",
  // Words that carry the operator's authority. A player who is being scammed by `@support` will not
  // remember that the handle was not ours.
  "admin",
  "administrator",
  "help",
  "helpdesk",
  "moderator",
  "official",
  "security",
  "staff",
  "support",
  "team",
]);

/** Case-folded exact membership. Not a substring test — see this file's second header. */
export function isReservedHandle(
  handle: string,
  reserved: ReadonlySet<string> = RESERVED_HANDLES,
): boolean {
  return reserved.has(handle.trim().toLowerCase());
}
