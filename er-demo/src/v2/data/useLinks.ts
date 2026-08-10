// THE IDENTITY FEED — one fetch, one verification pass, one map, for the whole page.
//
// THE RULE THIS FILE IS BUILT AROUND, and it outranks everything else in it: the absence of this
// feature must be indistinguishable from a player who chose not to link. Not "degraded". Not "an
// error state". Indistinguishable. `TWITTER-CONNECT.md` §8:
//
//     Never block a game action on the identity service. If `/api/links` times out, the round renders
//     fully unlinked and nothing tells the player anything.
//
// So there is no `error` on the value this exposes, and that is deliberate rather than lazy. A
// timeout, a 500, a malformed body, a signature that does not verify, an expired attestation and a
// wallet that never linked all produce the same thing: no entry in the map, the flat side-coloured
// disc, and a `nameFor()` pseudonym — which is a complete, good rendering that most of the board is
// showing anyway. A field for an error is a field a view will eventually render, and there is
// nothing here a player could act on.
//
// The one concession is a single `console.warn` per failed poll, for whoever is holding the console.
//
// WHY THE WALLET SET IS A STRING KEY. `LiveRound` is rebuilt on every poll and every 250ms clock
// tick, so `live.fighters` is a fresh array four times a second even when nothing about it moved. An
// effect keyed on that array re-fetches four times a second forever. Keyed on the sorted join of the
// wallets, it fetches when the ROSTER changes, which is what it actually depends on.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { linkMapFrom, MAX_WALLETS_PER_QUERY, NO_LINKS, type LinkMap, type LinkRecord } from "./xLink.ts";
import { LINK_SOURCE, linksUrlFor, trustedKeysFor, type LinkSource } from "./linkSource.ts";

export interface LinksApi {
  /** Which source is in play. Rendered nowhere; used by the wallet panel to explain itself when the
   *  feature is off, and by tests. */
  readonly source: LinkSource;
  /** wallet -> verified identity. Absent means unlinked, which is the ordinary state. */
  readonly map: LinkMap;
  /** The connected player's own identity, if they have one. Pulled out because the wallet panel asks
   *  for exactly this and should not have to know its own wallet string to get it. */
  readonly you: LinkRecord | null;
  /** True while the first fetch for the current roster is outstanding.
   *
   *  IT MUST NEVER GATE ANYTHING. It exists so the wallet panel can avoid flashing "not connected"
   *  at somebody who is, for one frame. Nothing on the board may wait on it: a round renders
   *  completely and correctly while this is true. */
  readonly loading: boolean;
}

const IDLE: LinksApi = { source: "off", map: NO_LINKS, you: null, loading: false };

/** How often a roster's links are re-read.
 *
 *  THIS NUMBER IS THE REVOCATION DELAY, which is the only reason it is not much larger. An
 *  attestation is good for seven days, so nothing forces a refetch for correctness — but
 *  `TWITTER-CONNECT.md` §6.2 promises that unlinking takes a face off the leaderboard immediately,
 *  and a client that never re-asks would keep rendering it for a week. Sixty seconds, plus whatever
 *  the edge cache adds, is what "immediate" actually means here, and the UI should say so in those
 *  terms rather than claiming instant. */
const REFRESH_MS = 60_000;

/** How long one poll may hang before it is abandoned and retried. See the deadline in `fetchLinks`.
 *  Ten seconds is far longer than a CDN-cached JSON read should ever take and short enough that a
 *  stalled network costs one refresh interval rather than the rest of the session. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * THE ROSTER AS A VALUE RATHER THAN AN IDENTITY — sorted, capped, joined.
 *
 * Exported because it is a decision rather than plumbing, and this codebase's rule is that a hook
 * exports its non-React decisions so they can be tested without a browser (`useActions.ts` exports
 * `stopWaiting`, `useAutoDeploy.ts` exports `lostRound`). There is no React harness in this project —
 * vitest, oxlint and typescript are the entire devDependency list — so anything left inside a
 * `useMemo` is untestable by construction.
 *
 * DEDUPED, THEN CAPPED IN THE CALLER'S ORDER, THEN SORTED — and that order of operations is the
 * whole design, because each step answers a different question.
 *
 * The CAP comes before the sort so the CALLER decides who gets asked about. `/api/links` takes at
 * most `MAX_WALLETS_PER_QUERY` wallets, and the page can want more than that: a full 48-fighter round
 * plus the connected wallet plus a leaderboard's worth of past players is over the limit. Sorting
 * first and then truncating would hand the remaining slots to whoever happens to sort lowest, which
 * is a meaningless criterion — an accident of base58. Truncating first keeps the caller's priority
 * (the round on screen, then you, then the leaderboard) and makes the dropped tail predictable.
 *
 * The SORT comes last and exists only so the KEY is stable: the same set of players arriving in a
 * different order must not re-fetch, and `LiveRound` re-orders its roster on several surfaces.
 * `/api/links` itself does not care about order.
 *
 * Truncating at all is the right failure: an over-long query would be rejected wholesale and EVERY
 * player would render unlinked, which is far worse than a few missing faces at the bottom of a table.
 */
export function rosterKey(wallets: readonly string[]): readonly string[] {
  return [...new Set(wallets)].slice(0, MAX_WALLETS_PER_QUERY).sort();
}

/**
 * Fetch one poll's worth of records, in whatever shape `linkMapFrom` expects.
 *
 * Exported for the same reason as `rosterKey`: the mock-signing branch below is the one place the
 * fixture and production diverge, and a divergence nothing can test is where the two quietly stop
 * agreeing.
 */
export async function fetchLinks(
  source: LinkSource,
  wallets: readonly string[],
  you: string | null,
  signal: AbortSignal,
): Promise<unknown> {
  const url = linksUrlFor(source, wallets);
  // An empty body rather than null: `linkMapFrom` reads null as a malformed response and logs a
  // warning about it, and "there was nobody to ask about" is not a malformed response. It is an
  // answer, and the answer is nobody.
  if (url === null) return { links: [] };
  // A DEADLINE, NOT JUST AN UNMOUNT SIGNAL — and this is the difference between a poll loop and a
  // poll loop that stops forever.
  //
  // `fetch` has no default timeout. A server that accepts the connection and then never answers — a
  // stalled edge node, a captive portal, a phone changing networks — leaves this `await` pending for
  // the lifetime of the tab. The retry below is scheduled AFTER the await, so nothing reschedules:
  // the sixty-second refresh silently stops, `loading` sticks true, and the console says nothing.
  //
  // That matters more than an ordinary hang because `REFRESH_MS` is the REVOCATION delay. A player
  // who unlinks because they no longer want their wallet publicly named would keep their face on
  // every stalled tab until the attestation expired — up to seven days instead of about a minute.
  //
  // `AbortSignal.timeout` throws `TimeoutError`, which lands in the caller's `catch` with
  // `signal.aborted` false, warns once, and reschedules — exactly what this file already believed
  // happened on a failure.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  const res = await fetch(url, { signal: deadline });
  if (!res.ok) throw new Error(`${res.status}`);
  const body: unknown = await res.json();
  if (source !== "mock") return body;
  // The mock's one divergence from production, and the whole of it: the fixture ships unsigned
  // payloads and is signed here, at load, because a committed signature would expire. Everything
  // after this line — `linkMapFrom`, the canonical bytes, the trusted key set, the branded mint — is
  // the same code the real source runs. See `mockLinks.ts`.
  //
  // IMPORTED DYNAMICALLY so that `xLinkSign.ts` — and with it ed25519 signing and sha256 — is absent
  // from the default bundle rather than merely unused in it. `xLinkSign.ts`'s header claims the
  // browser has no import path to a function that takes a secret key; a static import here made that
  // claim false for every visitor, `?links=off` or not.
  const { mockAttestations, parseMockFixture } = await import("./mockLinks.ts");
  return { links: mockAttestations(parseMockFixture(body), wallets, you, Math.floor(Date.now() / 1000)) };
}

/**
 * The feed. Called ONCE per page, by `ArenaProvider` — both branches of it.
 *
 * IT LIVES IN THE PROVIDER RATHER THAN IN A PROVIDER OF ITS OWN, and the reason is a cycle. The feed
 * needs the round's roster in order to know what to ask about, and the canvas needs the answer
 * stamped back onto the fighters it draws. A provider mounted below `ArenaProvider` could do the
 * first but could never feed the second back up. `useHouseRoster` sits in the same place for the same
 * reason.
 *
 * @param wallets every wallet on screen that might have an identity. The caller passes the round's
 *   roster plus itself; there is no enumeration route, so the query is always an explicit list.
 * @param houseWallets the keeper's published list. Client-side guard three — see `linkFighters.ts`.
 */
export function useLinkFeed(
  wallets: readonly string[],
  you: string | null,
  houseWallets: readonly string[],
): LinksApi {
  const [map, setMap] = useState<LinkMap>(NO_LINKS);
  const [loading, setLoading] = useState(false);

  // HOUSE WALLETS ARE NEVER ASKED ABOUT — they cannot have a face, so a slot spent on one is a slot
  // taken from a player who can.
  //
  // This started as an optimisation and turned out to be a correctness fix. The three house guards
  // all run at RENDER time (`linkFighters.ts`), so asking about a house wallet and then discarding
  // the answer is correct but wasteful — and in the `?links=mock` fixture it was worse than wasteful:
  // the fixture marks two thirds of its lineup as house, the mock cast landed mostly on those, and
  // every one of them was correctly stripped on the way out. The guard was working perfectly and the
  // feature was invisible, which is the most expensive kind of "working".
  //
  // Filtering here means the cast lands on wallets that can actually wear it, and production stops
  // spending query slots on the keeper's own wallets. The render-time guards stay exactly where they
  // are: this is an optimisation of what we ask, never a substitute for checking what we are told.
  const asked = useMemo(
    () => rosterKey(houseWallets.length === 0 ? wallets : wallets.filter((w) => !houseWallets.includes(w))),
    [wallets, houseWallets],
  );
  const key = useMemo(() => asked.join(","), [asked]);
  const houseKey = useMemo(() => [...houseWallets].sort().join(","), [houseWallets]);

  // Read inside the effect rather than listed as a dependency: these are the CURRENT values at fetch
  // time, and adding them to the dependency list would re-fetch the entire roster every time the
  // connected wallet's own object identity changed.
  const latest = useRef({ wallets: asked, you, houseWallets });
  latest.current = { wallets: asked, you, houseWallets };

  useEffect(() => {
    if (LINK_SOURCE === "off" || key === "") {
      setMap(NO_LINKS);
      // Cleared here too, or it sticks. A first poll in flight when the roster empties — the round
      // settles, or the wallet disconnects — is cancelled by the cleanup below, which skips its own
      // `setLoading(false)` because `cancelled` is true. Without this line `loading` stays true until
      // a non-empty roster happens to arrive, and this field is documented as one that must never
      // gate anything.
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (first: boolean): Promise<void> => {
      if (first) setLoading(true);
      try {
        const body = await fetchLinks(LINK_SOURCE, latest.current.wallets, latest.current.you, abort.signal);
        if (cancelled) return;
        const { links, rejected } = linkMapFrom(
          body,
          trustedKeysFor(LINK_SOURCE),
          Math.floor(Date.now() / 1000),
          latest.current.houseWallets,
        );
        if (rejected.length > 0) {
          // One line, for whoever is holding the console. Never a screen — see the header.
          console.warn(`[links] ${rejected.length} record(s) not shown: ${[...new Set(rejected)].join(", ")}`);
        }
        setMap(links);
      } catch (e) {
        if (cancelled || abort.signal.aborted) return;
        console.warn("[links] feed unavailable, rendering everybody unlinked:", e);
        // NOT cleared. A transient failure must not strip faces that were already verified and are
        // still inside their seven days — the records we hold are self-certifying and did not become
        // less true because a fetch failed. Withholding is the API's only power (§5) and there is no
        // reason to help it.
      } finally {
        if (!cancelled && first) setLoading(false);
      }
      if (!cancelled) timer = setTimeout(() => void poll(false), REFRESH_MS);
    };

    void poll(true);
    return () => {
      cancelled = true;
      abort.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [key, houseKey]);

  return useMemo<LinksApi>(
    () => ({
      source: LINK_SOURCE,
      map,
      you: you === null ? null : (map.get(you) ?? null),
      loading,
    }),
    [map, you, loading],
  );
}

/** Default `IDLE` rather than `null`, so a component rendered outside the provider — a test, a
 *  storybook, a future screen someone forgets to wrap — renders everybody unlinked instead of
 *  throwing. The absence of the feature is the main path; it should not be able to crash a page. */
export const LinksContext = createContext<LinksApi>(IDLE);

export function useLinks(): LinksApi {
  return useContext(LinksContext);
}
