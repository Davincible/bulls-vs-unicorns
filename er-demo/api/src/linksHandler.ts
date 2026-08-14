// `GET /api/links?wallets=<comma-separated base58, max 64>` — the read path, and the only route this
// feature has that a browser polls.
//
// A PURE FUNCTION OF ITS DEPENDENCIES, taking a web-standard `Request` and returning a web-standard
// `Response`. Not for elegance: it is what lets every rule below be tested with `npm test`, no
// database, no network, no container and no Vercel. The expensive defects here — a suppressed row
// that still renders, a house wallet wearing a face, a signature that the client's own verifier
// rejects — are all policy defects, and policy defects are exactly the class nobody writes a test for
// when the test needs Postgres first.
//
// ------------------------------------------------------------------------------------------------
// WHAT THIS ROUTE IS TRUSTED FOR, AND WHAT IT IS NOT.
//
// Every row leaves here with a detached ed25519 signature over `canonicalBytes()` and the client
// verifies it before rendering. So a compromised or misbehaving API can WITHHOLD a link (denial) and
// can serve a stale one until `expiresAt`. It cannot invent one. It cannot make a wallet wear a
// handle that wallet never proved.
//
// That reduces this endpoint from *trusted for correctness* to *trusted for availability* — the
// difference between "our backend got popped and Ansem's face is on a scam wallet" and "our backend
// got popped and some avatars are missing". Everything below is written on that footing: when in
// doubt, return fewer rows. The failure mode of returning nothing is the ordinary rendering of this
// page (§8), and it is indistinguishable from a player who chose not to link.

import { LINKS_ENDPOINT, type LinkAttestation, type LinksResponse } from "../../src/v2/data/xLink.js";
import type { AttestationKey } from "../../src/v2/data/xLinkSign.js";
import { attestRow } from "./attest.js";
import type { HouseListSource } from "./houseWallets.js";
import { isReservedXId, RESERVED_MOCK_X_IDS } from "./reserved.js";
import type { LinkStore } from "./store.js";
import { parseWalletList } from "./wallets.js";

export interface LinksDeps {
  readonly store: LinkStore;
  readonly key: AttestationKey;
  readonly house: HouseListSource;
  readonly nowSec: () => number;
  /** Overridable only so the reserved-id rule can be tested against a non-empty set; production
   *  passes the real one, which is empty pending publication. See `reserved.ts`. */
  readonly reservedXIds?: ReadonlySet<string>;
}

/**
 * THE CACHE HEADER, AND THE NUMBER IS 30 SECONDS, PRIVATE.
 *
 * Three separate constraints meet here and only one arrangement satisfies all three.
 *
 * 1. REVOCATION MUST BE IMMEDIATE AT THE LEADERBOARD (§6.2). Every second of cache TTL is a second
 *    in which somebody who asked to be unlinked is still being served under their own name. That is
 *    the constraint with a person on the other end of it, so it dominates.
 * 2. `s-maxage` IS DELIBERATELY ABSENT — no shared cache, ever. A CDN entry is worse than a browser
 *    entry twice over: it would serve a revoked identity to STRANGERS, and it would do so for
 *    callers who never made the original request. And it would buy nothing: the cache key is the
 *    wallet list, the client sends whichever forty-eight wallets happen to be in this round, and the
 *    hit rate on arbitrary permutations of a 48-element set is indistinguishable from zero.
 * 3. THE SEVEN-DAY `expiresAt` IS NOT A CACHE NUMBER. It is the ceiling on a stale unlink held by a
 *    client that has stopped polling (`ATTESTATION_TTL_SECONDS` says so in as many words). It does
 *    not license caching for seven days, seven minutes or seven seconds; it bounds the damage when
 *    caching is out of our hands entirely.
 *
 * So: `private`, and 30 seconds — long enough to collapse a burst of polls from one tab into one
 * origin hit (which is the only caching that was ever available here), short enough that "immediate"
 * survives contact with a stopwatch on a leaderboard nobody watches to the second. `no-store` was
 * the alternative and it was rejected for costing an origin round trip per poll for no correctness
 * gained: 30 seconds of a browser's own private cache cannot reach anyone the original response was
 * not already for.
 */
const CACHE_CONTROL = "private, max-age=30";

/** Refusals carry a machine-readable reason and never anything about the register. A 400 must not
 *  become an oracle for "is this wallet linked" — it answers only "is this request well-formed". */
function refuse(reason: string, detail: string): Response {
  return new Response(JSON.stringify({ error: reason, detail }), {
    status: 400,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // A malformed request's answer is the same forever. Cache it privately so a client stuck in a
      // loop with a bad list at least stops asking.
      "Cache-Control": "private, max-age=60",
    },
  });
}

function ok(links: readonly LinkAttestation[], houseListKnown: boolean): Response {
  const body: LinksResponse = { links };
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": CACHE_CONTROL,
    // The body varies with the request's `wallets`, which is in the URL and therefore already part
    // of any cache key. `Vary` is here for the encoding only.
    Vary: "Accept-Encoding",
  };
  if (!houseListKnown) {
    // OPERABLE, NOT VISIBLE, AND IT NO LONGER NAMES WHAT IT IS ABOUT. The player sees the ordinary
    // unlinked page and nothing tells them anything (§8.5). Whoever is reading response headers
    // during an incident sees that rows are being suppressed and why the avatars vanished, which is
    // the audience that can act on it.
    //
    // Renamed from `X-XLink-House-List`. That spelling announced to anyone who ever looked at a
    // response — no incident required, no privilege required — that this site keeps a list of house
    // wallets, which is precisely the fact that is now internal (see `houseWallets.ts`). A debugging
    // aid must not leak the thing it is helping you debug. `Suppression` says the same operational
    // sentence to the same operator without naming the mechanism.
    headers["X-XLink-Suppression"] = "unavailable";
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export async function handleLinks(request: Request, deps: LinksDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const url = new URL(request.url);
  // `getAll` rather than `get`: a repeated `?wallets=a&wallets=b` is a client bug, and `get` would
  // silently pick the first and answer about half the board. `parseWalletList` refuses an array.
  const all = url.searchParams.getAll("wallets");
  const parsed = parseWalletList(all.length === 1 ? all[0] : all.length === 0 ? undefined : all);
  if (parsed.kind !== "ok") return refuse(parsed.reason, parsed.detail);

  // THE HOUSE LIST IS FETCHED BEFORE THE DATABASE IS READ, so the fail-closed path costs no query.
  const house = await deps.house.get();
  if (house.unknown) {
    // We cannot tell a house wallet from a player's. Serving nothing renders the page exactly as it
    // renders for the majority who never link; serving everything could put a person's face on an
    // automated process. See `houseWallets.ts` for the full argument.
    return ok([], false);
  }

  const rows = await deps.store.findByWallets(parsed.wallets);
  const nowSec = deps.nowSec();
  const reserved = deps.reservedXIds ?? RESERVED_MOCK_X_IDS;

  const links: LinkAttestation[] = [];
  for (const row of rows) {
    // §6.3's hard rule — a house wallet must never wear a person's face — enforced on the read path
    // as well as the write path. The write path is the durable guard; this is the one that still
    // holds after a row is inserted by hand, after a wallet is promoted to house AFTER it linked,
    // and after a restore from a backup taken before either. Three chances to get it right, and this
    // is the cheapest of them.
    //
    // `house.wallets` is an internal list read from the keeper over an authenticated channel; it is
    // never published to a browser and nothing in this response discloses membership. A suppressed
    // row is indistinguishable, from the outside, from a wallet that never linked.
    if (house.wallets.has(row.wallet)) continue;
    // A fixture id can never be minted here — see `reserved.ts`.
    if (isReservedXId(row.xId, reserved)) continue;
    links.push(attestRow(row, deps.key, nowSec));
  }

  return ok(links, true);
}

/** The route this handler serves, re-exported from the contract so the entry point, the client and
 *  this file cannot drift into three spellings of one path. */
export const LINKS_ROUTE = LINKS_ENDPOINT;
