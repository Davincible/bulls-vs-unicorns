// `GET /api/avatar/<x_id>/<avatar_hash>.webp` — §7.2.
//
// KEYED BY `x_id` + CONTENT HASH. NEVER BY URL AND NEVER BY HANDLE.
//
// There is no parameter here a caller can point at anything. Not at another host, not at an internal
// address, not at a different account's picture. The route has exactly two variable parts — a
// numeric id we issued and a hash of bytes we produced — and neither of them is a destination. A
// proxy that accepts a URL is an open image proxy, an SSRF vector and a bandwidth donation; this one
// cannot become that by accident, because there is no field to put a URL in.
//
// It makes NO outbound request at all. The upstream fetch lives in `avatarIngest.ts` and runs at
// write time — see that file's header for the full argument, which is really an argument about where
// "the last good bytes" have to live.
//
// EVERY REFUSAL IS THE SAME 404. Not linked, suppressed, wrong hash, reserved fixture id, no bytes
// yet: one answer, so the route cannot be used to distinguish "this account is suppressed" from
// "this account does not exist" from "this hash is stale". The client already treats all of them
// identically — §7.3's failure ladder is the flat side-coloured disc on every rung — so there is
// nothing to gain from being more specific and an information leak to lose.

import type { LinkStore } from "./store.ts";
import { isReservedXId, RESERVED_MOCK_X_IDS } from "./reserved.ts";

export interface AvatarDeps {
  readonly store: LinkStore;
  /** See `reserved.ts`; production passes the real (currently empty) set. */
  readonly reservedXIds?: ReadonlySet<string>;
}

/**
 * The route shape, anchored, and it is the SAME shape `AVATAR_PATH_RE` in `xLink.ts` validates on
 * the way back in. Written here as its own literal rather than imported because that constant is a
 * `const` private to the verifier; `avatarPathFor()` is the shared builder and
 * `avatar_path_shape_matches_the_client_verifier` in the tests is what keeps the two honest.
 */
const ROUTE_RE = /^\/api\/avatar\/([0-9]{1,20})\/([0-9a-f]{64})\.webp$/;

/**
 * 24 HOURS, NOT `immutable`, AND THE DIFFERENCE IS DELIBERATE.
 *
 * By content hash this URL is immutable in the strict sense — the bytes at it can never change,
 * because changing them changes the hash and therefore the URL. Everything about it argues for
 * `max-age=31536000, immutable`, which is what `/assets/(.*)` already gets in `vercel.json`.
 *
 * It does not get that, because the bytes are a person's face and the person can ask for it back.
 * §6.2 promises revocation is immediate at the leaderboard and bounded by the CDN TTL for the cached
 * image, and the UI is supposed to state the number: *"Removed from the leaderboard immediately. A
 * cached copy of your picture may persist for up to 24 hours."* A year-long cache would make that
 * sentence a lie and there would be no mechanism to make it true again. So 24 hours, and the cost is
 * one revalidation per client per day for an image that will answer 304.
 *
 * `stale-while-revalidate=604800` is the concession that makes 24 hours affordable. It lets a shared
 * cache serve the existing copy WHILE it revalidates in the background instead of making a user wait
 * on an origin round trip at the moment of expiry. The staleness window it opens is not seven days
 * of stale content: it is however long one revalidation takes, after which the cache has the fresh
 * answer — and for a suppressed avatar that answer is a 404 and the entry is dropped. The seven-day
 * figure only bounds how long the cache may go on doing that before it must block.
 *
 * The suppression story does not actually depend on any of this. A suppressed row stops appearing in
 * `/api/links`, so no attestation carries the path, so no `<img>` requests it. The cached bytes
 * persist unreferenced until they expire. That is what "bounded by the CDN TTL" means in practice.
 */
const CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";

/** Negative answers are NOT cached. A 404 today is an avatar that has simply not been ingested yet
 *  in the common case, and a cached 404 would outlive the ingest and hold the flat disc in place for
 *  a day after the picture was ready. */
function notFound(): Response {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export async function handleAvatar(request: Request, deps: AvatarDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  // PARSED FROM THE PATHNAME, NOT FROM VERCEL'S INJECTED QUERY PARAMETERS.
  //
  // The platform routes `/api/avatar/[xId]/[hash]` by appending `?xId=…&hash=…` to the destination,
  // and reading them from there would work. It would also make this handler's correctness depend on
  // an undocumented detail of one host's router, and make it untestable with a plain `new Request()`.
  // The pathname is the same information, is defined by HTTP rather than by a vendor, and is what
  // the client's own `AVATAR_PATH_RE` validates against — so parsing it here means both ends read
  // the same string the same way.
  const m = ROUTE_RE.exec(new URL(request.url).pathname);
  if (m === null) return notFound();
  const [, xId, avatarHash] = m;

  if (isReservedXId(xId, deps.reservedXIds ?? RESERVED_MOCK_X_IDS)) return notFound();

  // The store applies the `suppressed` filter and the exact-hash requirement; see `store.ts`. A
  // mismatch is a 404 rather than "here is the current picture", because this URL is cached by
  // content hash and serving different bytes under one hash is how a CDN poisons itself.
  const found = await deps.store.findAvatar(xId, avatarHash);
  if (found === null) return notFound();

  return new Response(found.bytes, {
    status: 200,
    headers: {
      // Not sniffed, not inherited, not echoed from upstream: asserted, because `reencode()` just
      // produced a WebP and this is the only thing it could be. `X-Content-Type-Options: nosniff`
      // is already applied to every path by `vercel.json`.
      "Content-Type": "image/webp",
      "Content-Length": String(found.bytes.byteLength),
      "Cache-Control": CACHE_CONTROL,
      // The bytes ARE their own name, so the strong validator is free and a revalidation costs a
      // 304 instead of a re-download.
      ETag: `"${avatarHash}"`,
    },
  });
}
