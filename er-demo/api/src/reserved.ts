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
