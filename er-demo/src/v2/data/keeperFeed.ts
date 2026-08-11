// ONE POLL OF `keeper-status.json` FOR THE WHOLE PAGE — held here, in the module, rather than in a
// component near the top of the tree.
//
// WHY IT IS A MODULE — AND THE FORCING REASON IS GONE, WHICH IS WORTH SAYING PLAINLY RATHER THAN
// LEAVING A LIVE-SOUNDING JUSTIFICATION IN PLACE. The no-duplicate-polls rule itself is not new:
// `ui/keeperCadence.ts` spells out why seven independent two-second polls of the same file would be
// seven staleness clocks that disagree by up to a second, and `ui/KeeperStatusProvider.tsx` is the
// component that enforced it by calling the hook exactly once. What broke THAT arrangement was a
// second caller standing somewhere the component could not reach: the data layer resolved each
// fighter against the keeper's published house-wallet list, so `ArenaProvider` needed this same file,
// and `ArenaProvider` sits ABOVE the keeper provider in `App.tsx` where that context does not exist.
// THAT CALLER NO LONGER EXISTS. The arena's own wallets are not published to a browser any more (see
// `keeperStatus.ts`, schema 5), nothing under `data/` reads this file, and `useKeeperStatus` ->
// `KeeperStatusProvider` is once again the only subscriber there is.
//
// IT STAYS A MODULE ANYWAY, as a decision and not as leftover scaffolding. Pushing the machine back
// into a component would re-tie a page-wide invariant — exactly one fetch loop, exactly one staleness
// clock — to where one component happens to sit in the tree, which is a fact any later refactor can
// change without anyone noticing that it was load-bearing. Held here the invariant is true no matter
// who calls or from where, it costs a module-level `let` and nothing else, and the next consumer that
// turns up outside the provider's subtree is free instead of forcing this same migration a second
// time. The context above still does its own separate and still-useful job — it keeps a heartbeat
// landing from re-rendering the four screens that show no countdown.
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

import {
  KEEPER_STATUS_URL,
  isKeeperStale,
  parseKeeperStatus,
  type KeeperStatus,
} from "./keeperStatus.ts";

/** How often the file is re-fetched. It matches the keeper's own heartbeat interval — the keeper
 *  rewrites `heartbeatAt` every 2s — because polling slower than the writer means the page's picture
 *  of liveness is systematically older than the file's, and polling faster only re-reads bytes that
 *  have not changed. It is NOT the staleness threshold: that comes off the file
 *  (`staleAfterSeconds`), so a keeper configured to beat at a different rate stays correctly judged
 *  without this constant moving. */
const POLL_MS = 2000;

/** How often "is it still fresh" is re-asked between fetches. One second is the resolution a human
 *  reads a status light at, and the check is a subtraction. */
const FRESHNESS_MS = 1000;

export interface KeeperFeedState {
  /** The last status successfully parsed, or null if the most recent attempt did not produce one. */
  status: KeeperStatus | null;
  /** True whenever the page must not draw a schedule: no status, or one whose heartbeat has aged
   *  past the threshold the keeper published in it. */
  stale: boolean;
}

// STALE UNTIL PROVEN OTHERWISE. Before the first fetch lands the page knows nothing about the keeper,
// and "nothing" must read as "down" — the opposite default would put a countdown on screen for one
// poll interval every time the page loaded against a keeper that is not running.
let state: KeeperFeedState = { status: null, stale: true };

const listeners = new Set<() => void>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let freshnessTimer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;

// Two polls can be in flight at once — nothing stops a slow request from still running when the next
// interval fires — and they can come back in either order. Applying them in arrival order would let
// an older file overwrite a newer one, which for a heartbeat means a keeper that is alive flickering
// to "down" and back. Requests are numbered, and a response older than the one already applied is
// dropped.
let issued = 0;
let applied = -1;

// WHICH RUN OF THE POLL LOOP A RESPONSE BELONGS TO — bumped every time the loop stops, so nothing
// from a previous run can land in a new one.
//
// The case is not hypothetical and not rare: React mounts, unmounts and remounts a tree on every
// StrictMode pass and every hot reload, which stops and restarts this feed within the same tick.
// `stop()` aborts the in-flight request, and an abort rejects — so its `catch` runs as a microtask
// AFTER the restart has already republished the last good status, and would apply a `null` over it.
// The result is a page that blinks "keeper down" for one poll interval every time a developer saves
// a file, which is exactly the false negative this module exists to prevent, arriving through its
// own back door.
let generation = 0;

/** Replace the published state and wake every subscriber — but only when something actually moved.
 *
 *  The equality check is what keeps a two-second poll from costing a re-render two seconds apart
 *  forever: a keeper that is up and progressing rewrites `heartbeatAt` every beat, so every fetch
 *  lands a NEW object carrying the same answers to every question this page asks. `getSnapshot`
 *  hands back this exact object, and `useSyncExternalStore` compares by identity, so publishing a
 *  fresh one on every beat would re-render every subscriber for a fact that did not change. */
function publish(status: KeeperStatus | null, stale: boolean): void {
  if (state.status === status && state.stale === stale) return;
  state = { status, stale };
  for (const listener of listeners) listener();
}

function apply(gen: number, seq: number, next: KeeperStatus | null): void {
  if (gen !== generation || seq < applied) return;
  applied = seq;
  publish(next, next === null || isKeeperStale(next, Date.now() / 1000));
}

async function poll(): Promise<void> {
  const gen = generation;
  const seq = issued++;
  const signal = controller?.signal;
  try {
    // `no-store`, always: a cached status file is a lie about liveness, and reporting liveness is
    // the only reason this file exists. A 304 or a memory-cache hit would keep a dead keeper looking
    // alive for exactly as long as the cache lived.
    const res = await fetch(KEEPER_STATUS_URL, { cache: "no-store", signal });
    if (res.ok) {
      // `res.json()` throws on a body that is not JSON — an HTML fallback page served with a 200, or
      // a file caught mid-write. Same failure, same handler; see this file's header.
      apply(gen, seq, parseKeeperStatus(await res.json()));
    } else {
      apply(gen, seq, null);
    }
  } catch {
    // Includes the AbortError raised by `stop()` — which is precisely what `gen` is guarding, since
    // that rejection lands after the feed may already have been restarted.
    apply(gen, seq, null);
  }
}

function start(): void {
  // Re-ask staleness against the CURRENT clock before anything else. The feed keeps its last status
  // across a stretch with no subscribers (React unmounts and remounts a tree on every StrictMode
  // pass, and on every hot reload), and a status that was fresh when the last subscriber left may be
  // minutes old by the time the next one arrives. Publishing it unexamined would show a live keeper
  // for one poll interval on the strength of a heartbeat that has long since expired.
  publish(state.status, state.status === null || isKeeperStale(state.status, Date.now() / 1000));

  controller = new AbortController();
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
  // The second clock — see this file's header. Independent of the fetch loop, so a keeper that dies
  // goes stale on screen with no request involved.
  freshnessTimer = setInterval(() => {
    const current = state.status;
    publish(current, current === null || isKeeperStale(current, Date.now() / 1000));
  }, FRESHNESS_MS);
}

function stop(): void {
  // First, before anything can reject: everything in flight now belongs to a run that is over.
  generation += 1;
  if (pollTimer !== null) clearInterval(pollTimer);
  if (freshnessTimer !== null) clearInterval(freshnessTimer);
  pollTimer = null;
  freshnessTimer = null;
  controller?.abort();
  controller = null;
}

/** Subscribe to the feed, starting the poll if nobody was listening yet and stopping it when the last
 *  subscriber leaves. Refcounted rather than started at module load: a module that opened a network
 *  connection on import would poll in every unit test that transitively imported it. */
export function subscribeKeeperFeed(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function keeperFeedSnapshot(): KeeperFeedState {
  return state;
}
