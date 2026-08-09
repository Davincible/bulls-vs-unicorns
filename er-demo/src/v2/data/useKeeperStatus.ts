// React's half of the keeper status file: poll it, and — separately — keep answering "is it still
// fresh" on a clock of our own.
//
// THE TWO CLOCKS ARE THE WHOLE DESIGN, and the second one is the part that is easy to leave out. A
// naive version recomputes staleness whenever a fetch lands, which is correct for exactly as long as
// fetches keep landing. But `keeper-status.json` is a FILE: when the keeper process dies, the web
// server goes on serving the last one it wrote, with a 200 and a perfectly well-formed body,
// indefinitely. Every poll succeeds. Nothing errors. The page would sit there counting down to a
// lobby nobody is going to open, and the only thing wrong with the status is that it is old — which
// is a fact about the passage of time, not about any event that could trigger a re-render.
//
// So staleness is re-asked on its own interval, against `Date.now()`, whether or not a fetch has
// landed since. A keeper that dies goes stale on screen with no successful fetch involved.
//
// EVERY WAY OF FAILING IS THE SAME FAILURE. A network error, a 404 (the normal "no keeper has ever
// run here" — and the response Vite gives for a file that was never written), a 200 carrying the SPA
// fallback HTML, a truncated JSON body, a status from a schema this build does not know: all of them
// mean "there is no keeper status", and all of them produce `{ status: null, stale: true }`. Telling
// them apart would only be useful if the page did something different for each, and it must not —
// showing a countdown for any of them would be inventing the number.

import { useEffect, useRef, useState } from "react";
import { KEEPER_STATUS_URL, isKeeperStale, parseKeeperStatus, type KeeperStatus } from "./keeperStatus.ts";

/** How often the file is re-fetched. It matches the keeper's own heartbeat interval — the keeper
 *  rewrites `heartbeatAt` every 2s — because polling slower than the writer means the page's picture
 *  of liveness is systematically older than the file's, and polling faster only re-reads bytes that
 *  have not changed. This is a DEFAULT, and it is not the staleness threshold: that comes off the
 *  file (`staleAfterSeconds`), so a keeper configured to beat at a different rate stays correctly
 *  judged without this constant moving. */
const POLL_MS = 2000;

/** How often "is it still fresh" is re-asked between fetches. One second is the resolution a human
 *  reads a status light at, and the check is a subtraction. */
const FRESHNESS_MS = 1000;

export interface KeeperStatusResult {
  /** The last status successfully parsed, or null if the most recent attempt did not produce one. */
  status: KeeperStatus | null;
  /** True whenever the page must not draw a schedule: no status, or one whose heartbeat has aged
   *  past the threshold the keeper published in it. */
  stale: boolean;
}

export function useKeeperStatus(pollMs: number = POLL_MS): KeeperStatusResult {
  const [status, setStatus] = useState<KeeperStatus | null>(null);
  // STALE UNTIL PROVEN OTHERWISE. Before the first fetch lands the page knows nothing about the
  // keeper, and "nothing" must read as "down" — the opposite default would put a countdown on screen
  // for one poll interval every time the page loaded against a keeper that is not running.
  const [stale, setStale] = useState(true);

  // Read by the freshness clock, which must see the newest status without being torn down and
  // rebuilt every time one lands.
  const statusRef = useRef<KeeperStatus | null>(null);

  useEffect(() => {
    // `alive` guards every setState in the async path. The abort below usually gets there first, but
    // a fetch that has already resolved and is awaiting `res.json()` when the component unmounts is
    // past the point where aborting helps.
    let alive = true;
    const controller = new AbortController();

    // Two polls can be in flight at once — nothing stops a slow request from still running when the
    // next interval fires — and they can come back in either order. Applying them in arrival order
    // would let an older file overwrite a newer one, which for a heartbeat means a keeper that is
    // alive flickering to "down" and back. Requests are numbered, and a response older than the one
    // already applied is dropped.
    let issued = 0;
    let applied = -1;

    const apply = (seq: number, next: KeeperStatus | null) => {
      if (!alive || seq < applied) return;
      applied = seq;
      statusRef.current = next;
      setStatus(next);
      setStale(next === null || isKeeperStale(next, Date.now() / 1000));
    };

    const poll = async () => {
      const seq = issued++;
      try {
        // `no-store`, always: a cached status file is a lie about liveness, and reporting liveness is
        // the only reason this file exists. A 304 or a memory-cache hit would keep a dead keeper
        // looking alive for exactly as long as the cache lived.
        const res = await fetch(KEEPER_STATUS_URL, { cache: "no-store", signal: controller.signal });
        if (!res.ok) return apply(seq, null);
        // `res.json()` throws on a body that is not JSON — an HTML fallback page served with a 200,
        // or a file caught mid-write. Same failure, same handler; see this file's header.
        apply(seq, parseKeeperStatus(await res.json()));
      } catch {
        // Includes the AbortError raised by the cleanup below, which is why `apply` re-checks
        // `alive` rather than trusting that reaching here means something went wrong.
        apply(seq, null);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
      controller.abort();
    };
  }, [pollMs]);

  // The second clock — see this file's header. It depends on nothing, so it is never torn down by a
  // poll landing, and it reads the status through a ref for the same reason.
  useEffect(() => {
    const id = setInterval(() => {
      const current = statusRef.current;
      const next = current === null || isKeeperStale(current, Date.now() / 1000);
      // Functional form so React bails out when the answer has not changed, which it has not for
      // every tick but one: this interval must cost a re-render at the moment a keeper dies, not once
      // a second forever.
      setStale((previous) => (previous === next ? previous : next));
    }, FRESHNESS_MS);
    return () => clearInterval(id);
  }, []);

  return { status, stale };
}
