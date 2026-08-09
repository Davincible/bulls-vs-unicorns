// The one poll of `/keeper-status.json` the page makes — see `KeeperStatusContext` in
// `keeperCadence.ts` for why there must be exactly one.
//
// A component of its own rather than a `useKeeperStatus()` call inside `Shell`, and that is a
// rendering decision, not a filing one. `children` arrives as a prop, so the element tree below is
// the SAME object across this component's own re-renders and React skips it wholesale: a poll landing
// re-renders only the components that actually read the context — the phase note, the dock, the arena
// section. Calling the hook in `Shell` instead would re-render the entire page twice a second, on
// every screen, including the four that show no countdown at all.
//
// Components only, so this module stays hot-refreshable (`data/ArenaProvider.tsx` explains the rule).

import type { ReactNode } from "react";
import { useKeeperStatus } from "../data/useKeeperStatus.ts";
import { KeeperStatusContext } from "./keeperCadence.ts";

export function KeeperStatusProvider({ children }: { children: ReactNode }) {
  const status = useKeeperStatus();
  // Not memoised, deliberately: `useKeeperStatus` hands back a fresh object whenever the file or the
  // staleness answer changes, and the file's whole purpose is a heartbeat that changes every two
  // seconds. There is no stable value to preserve here — the identity change IS the news.
  return <KeeperStatusContext.Provider value={status}>{children}</KeeperStatusContext.Provider>;
}
