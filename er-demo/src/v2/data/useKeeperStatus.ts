// React's half of the keeper status file. The polling, the two clocks and the reasoning behind both
// now live in `keeperFeed.ts`; this is the subscription.
//
// IT USED TO BE THE WHOLE MACHINE, and the move is worth a sentence because the constraint that
// forced it is not obvious. This hook opened its own fetch loop and its own freshness interval per
// call, so "exactly one poll" was true only because exactly one component called it — a rule enforced
// by where `ui/KeeperStatusProvider.tsx` happens to sit in the tree. A second caller then turned up
// in the DATA layer, in a provider ABOVE that component where the context is not reachable, and the
// machine moved into a module so the rule became structural rather than positional. THAT CALLER HAS
// SINCE GONE — it resolved fighters against the keeper's published house-wallet list, and the arena's
// wallets are no longer published to a browser at all; `keeperFeed.ts`'s header carries the full
// account, including why the module shape was kept once the thing forcing it went away. What survives
// is the part this file cares about: every caller, from either layer, shares one fetch loop and one
// staleness clock, and no future caller can multiply them by being added in the wrong place.
//
// THE PARAMETER IS GONE. It used to take a poll interval and nothing ever passed one; a shared feed
// cannot honour a per-caller interval, so keeping the argument would have been a knob that silently
// did nothing to callers two and up. The interval is `keeperFeed.ts`'s `POLL_MS`, matched to the
// keeper's own heartbeat.

import { useSyncExternalStore } from "react";
import { keeperFeedSnapshot, subscribeKeeperFeed, type KeeperFeedState } from "./keeperFeed.ts";

/** Unchanged, and still the shape `ui/keeperCadence.ts` consumes — both halves load-bearing. */
export type KeeperStatusResult = KeeperFeedState;

export function useKeeperStatus(): KeeperStatusResult {
  // The third argument is the server snapshot. There is no server rendering here, but the same
  // function is the honest answer for one: nothing has been fetched, so the feed reads "no keeper",
  // which draws no countdown.
  return useSyncExternalStore(subscribeKeeperFeed, keeperFeedSnapshot, keeperFeedSnapshot);
}
