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
// disc, and no username at all — the truncated address identifies the row, exactly as it does
// everywhere else on this page. That is a complete, good rendering, and it is the one most of the
// board is showing anyway. There is deliberately no placeholder in it, no "Anonymous" and no dash
// standing where an identity would go, so there is nothing in the unlinked row for a reader to read
// as a fault. A field for an error is a field a view will eventually render, and there is nothing
// here a player could act on.
//
// The one concession is a single `console.warn` per failed poll, for whoever is holding the console.
//
// WHY THE WALLET SET IS A STRING KEY. `LiveRound` is rebuilt on every poll and every 250ms clock
// tick, so `live.fighters` is a fresh array four times a second even when nothing about it moved. An
// effect keyed on that array re-fetches four times a second forever. Keyed on the sorted join of the
// wallets, it fetches when the ROSTER changes, which is what it actually depends on.
//
// AND WHY THE SAME WALLETS TRAVEL THROUGH HERE TWICE, IN TWO ORDERS. That sorted form is the right
// answer to "is this the same query" and the wrong answer to "who matters most", and the `?links=mock`
// fixture has to ask the second one — it has six identities and up to fifty-two wallets to spend them
// on. So `rosterCast` (the caller's priority order) and `rosterKey` (that, sorted) are both computed,
// carried side by side to `fetchLinks`, and read by different halves of it. See `rosterCast`.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  /**
   * Re-read the feed NOW, rather than at the end of the current `REFRESH_MS`.
   *
   * THERE IS EXACTLY ONE CALLER AND IT IS THE CEREMONY. `REFRESH_MS` is sixty seconds because that is
   * the revocation delay this product is willing to promise strangers — but the player who just
   * pressed `Connect X` is not a stranger to their own action, and a face that takes up to a minute to
   * appear after a successful link reads as a link that did not work. They press it again. That is the
   * whole reason this exists.
   *
   * IT IS A NUDGE, NOT A FETCH: it cannot be awaited and it returns nothing. A caller who could await a
   * fetch would soon be gating a button on it, and `loading`'s own contract two lines up is that
   * nothing in this program waits on this feed. The panel re-renders when the map changes, like every
   * other consumer.
   */
  readonly refresh: () => void;
}

/** `refresh` is a no-op here rather than absent: a component rendered outside the provider must be
 *  able to call it without a guard, for the same reason `IDLE` exists at all. */
const IDLE: LinksApi = { source: "off", map: NO_LINKS, you: null, loading: false, refresh: () => {} };

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
 * WHO WE MAY ASK ABOUT, IN THE ORDER THEY MATTER — deduped, capped, and otherwise exactly the list
 * the caller composed.
 *
 * Exported because it is a decision rather than plumbing, and this codebase's rule is that a hook
 * exports its non-React decisions so they can be tested without a browser (`useActions.ts` exports
 * `stopWaiting`, `useAutoDeploy.ts` exports `lostRound`). There is no React harness in this project —
 * vitest, oxlint and typescript are the entire devDependency list — so anything left inside a
 * `useMemo` is untestable by construction.
 *
 * THE CAP IS APPLIED IN THE CALLER'S ORDER, so the CALLER decides who gets asked about. `/api/links`
 * takes at most `MAX_WALLETS_PER_QUERY` wallets, and the page can want more than that: a full
 * 48-fighter round plus the connected wallet plus a leaderboard's worth of past players is over the
 * limit. Sorting first and then truncating would hand the remaining slots to whoever happens to sort
 * lowest, which is a meaningless criterion — an accident of base58. Truncating in the caller's order
 * keeps its priority (the round on screen, then you, then the leaderboard) and makes the dropped tail
 * predictable.
 *
 * Truncating at all is the right failure: an over-long query would be rejected wholesale and EVERY
 * player would render unlinked, which is far worse than a few missing faces at the bottom of a table.
 *
 * WHY THIS IS A VALUE OF ITS OWN RATHER THAN A STEP INSIDE `rosterKey`. Two things ask about these
 * wallets and only one of them wants a canonical order. The QUERY wants the sorted form, because a
 * key that changed when a view re-sorted the roster would re-fetch the whole board mid-fight — that
 * is `rosterKey` below. The `?links=mock` FIXTURE wants this one, because with six identities and
 * fifty-two wallets the question "who wears a face" is answered by whoever is at the front of the
 * list, and base58 order is not an answer to it. Same members, two orders, one of them meaningful.
 */
export function rosterCast(wallets: readonly string[]): readonly string[] {
  return [...new Set(wallets)].slice(0, MAX_WALLETS_PER_QUERY);
}

/**
 * THE ROSTER AS A VALUE RATHER THAN AN IDENTITY — the cast above, sorted, ready to be joined.
 *
 * The SORT is the whole of the difference and it exists only so the KEY is stable: the same set of
 * players arriving in a different order must not re-fetch, and `LiveRound` re-orders its roster on
 * several surfaces. `/api/links` itself does not care about order.
 *
 * IT IS DEFINED IN TERMS OF `rosterCast` so that the two can never describe different SETS. They are
 * threaded separately from here to `fetchLinks` — one becomes the URL and the effect key, the other
 * decides who the fixture casts — and a pair of independently-built lists is a pair that can silently
 * disagree about membership after somebody edits one of them.
 */
export function rosterKey(wallets: readonly string[]): readonly string[] {
  return [...rosterCast(wallets)].sort();
}

/** One poll's question. An object rather than five positional arguments for one specific reason:
 *  `asked` and `cast` are the same wallets in two different orders and have the same type, so
 *  positionally they are one transposition away from a defect that nothing would report — the URL
 *  would carry an uncanonical order (a fresh edge-cache key on every re-sort) and the fixture would
 *  cast by base58, which is the exact failure `mockLinks.ts#assignMockIdentities` documents. Named
 *  fields make that swap unwritable. */
export interface LinkQuery {
  readonly source: LinkSource;
  /** `rosterKey` — sorted. THE QUERY: the URL's wallet list and, joined, the effect's key. */
  readonly asked: readonly string[];
  /** `rosterCast` — the caller's priority order, same members. Read by the `mock` branch and by
   *  nothing else; on the `api` path the server decides nothing by order and this is unused. */
  readonly cast: readonly string[];
  /** The connected wallet, or null. `mock` always links it (see `assignMockIdentities`). */
  readonly you: string | null;
  readonly signal: AbortSignal;
}

/**
 * Fetch one poll's worth of records, in whatever shape `linkMapFrom` expects.
 *
 * Exported for the same reason as `rosterKey`: the mock-signing branch below is the one place the
 * fixture and production diverge, and a divergence nothing can test is where the two quietly stop
 * agreeing.
 */
export async function fetchLinks({ source, asked, cast, you, signal }: LinkQuery): Promise<unknown> {
  const url = linksUrlFor(source, asked);
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
  //
  // `cast`, NOT `asked`, AND THAT IS THE ONE INTERESTING LINE IN THIS FUNCTION. Both name the same
  // wallets; only the cast names them in the order the page cares about. Handing the sorted form here
  // spends the fixture's six identities on whatever sorts first — overwhelmingly leaderboard rows —
  // and leaves the arena screen, which is the only screen `?links=mock` exists to make reviewable,
  // with no linked faces on it. `assignMockIdentities` carries the whole of that argument.
  const { mockAttestations, parseMockFixture } = await import("./mockLinks.ts");
  return { links: mockAttestations(parseMockFixture(body), cast, you, Math.floor(Date.now() / 1000)) };
}

/**
 * The feed. Called ONCE per page, by `ArenaProvider` — both branches of it.
 *
 * IT LIVES IN THE PROVIDER RATHER THAN IN A PROVIDER OF ITS OWN, and the reason is a cycle. The feed
 * needs the round's roster in order to know what to ask about, and the canvas needs the answer
 * stamped back onto the fighters it draws. A provider mounted below `ArenaProvider` could do the
 * first but could never feed the second back up.
 *
 * @param wallets every wallet on screen that might have an identity, IN PRIORITY ORDER — the round on
 *   screen, then you, then the leaderboard's rows. The caller passes the round's roster plus itself;
 *   there is no enumeration route, so the query is always an explicit list. The order is not
 *   decoration: it decides which wallets survive the cap, and under `?links=mock` it decides who
 *   wears a face.
 */
export function useLinkFeed(wallets: readonly string[], you: string | null): LinksApi {
  const [map, setMap] = useState<LinkMap>(NO_LINKS);
  const [loading, setLoading] = useState(false);
  /**
   * Bumped by `refresh()`. A COUNTER IN THE EFFECT'S DEPENDENCY LIST, which is the whole mechanism:
   * incrementing it tears the effect down — aborting whatever is in flight and clearing the pending
   * timer — and starts it again, which polls immediately and re-arms the interval from now.
   *
   * The alternative was to hoist `poll` out of the effect and call it directly. That means the fetch,
   * its abort controller and its timer all have to live outside the effect too, and the cancellation
   * discipline this file spends twenty lines getting right (`cancelled`, `abort`, the `finally`) stops
   * being expressible in one place. One integer is cheaper than that, and it reuses the teardown that
   * is already correct.
   */
  const [nudge, setNudge] = useState(0);

  const asked = useMemo(() => rosterKey(wallets), [wallets]);
  // The same members as `asked`, in the caller's order — see `rosterCast`. Computed on every path
  // rather than only under `?links=mock`, because a value that is the priority order on one flag and
  // the base58 order on another is a value nobody can reason about; it is a dedupe and a slice over
  // at most `MAX_WALLETS_PER_QUERY` strings, and only when the roster itself changes.
  const cast = useMemo(() => rosterCast(wallets), [wallets]);
  const key = useMemo(() => asked.join(","), [asked]);

  // Read inside the effect rather than listed as a dependency: these are the CURRENT values at fetch
  // time, and adding them to the dependency list would re-fetch the entire roster every time the
  // connected wallet's own object identity changed.
  const latest = useRef({ asked, cast, you });
  latest.current = { asked, cast, you };

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
        const body = await fetchLinks({
          source: LINK_SOURCE,
          asked: latest.current.asked,
          cast: latest.current.cast,
          you: latest.current.you,
          signal: abort.signal,
        });
        if (cancelled) return;
        const { links, rejected } = linkMapFrom(
          body,
          trustedKeysFor(LINK_SOURCE),
          Math.floor(Date.now() / 1000),
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
  }, [key, nudge]);

  // Stable across renders, so a consumer can put it in its own dependency lists without re-running
  // them every poll.
  const refresh = useCallback(() => setNudge((n) => n + 1), []);

  return useMemo<LinksApi>(
    () => ({
      source: LINK_SOURCE,
      map,
      you: you === null ? null : (map.get(you) ?? null),
      loading,
      refresh,
    }),
    [map, you, loading, refresh],
  );
}

/** Default `IDLE` rather than `null`, so a component rendered outside the provider — a test, a
 *  storybook, a future screen someone forgets to wrap — renders everybody unlinked instead of
 *  throwing. The absence of the feature is the main path; it should not be able to crash a page. */
export const LinksContext = createContext<LinksApi>(IDLE);

export function useLinks(): LinksApi {
  return useContext(LinksContext);
}
