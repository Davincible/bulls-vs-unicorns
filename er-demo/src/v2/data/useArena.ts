// THE ONE WAY TO READ THE DATA LAYER — and, deliberately, a file with no component in it.
//
// WHY THIS IS NOT IN `ArenaProvider.tsx`, where it obviously belongs. React Fast Refresh can only
// hot-swap a module whose exports are ALL components. `ArenaProvider.tsx` exported a component and
// this hook, so Vite could not refresh it: every edit anywhere in its import graph invalidated the
// module instead, which tears down the context and leaves every consumer calling `useArena()` against
// a null — the whole page blanks with "useArena() must be called inside <ArenaProvider>".
//
// That is a dev-only failure, which is exactly why it was worth fixing: it does not show up in a
// build, it shows up while someone is working, and it looks like a bug in whatever they were editing
// rather than in the module graph. Two separate agents lost a verification run to it — one of them a
// live devnet run that had to be repeated — before anyone recognised the pattern.
//
// The context object lives here too, because it has to: the provider needs it to write and the hook
// needs it to read, so it belongs to whichever module both can import without a cycle. This one
// imports nothing but React and a type.

import { createContext, useContext } from "react";
import type { ArenaContextValue } from "./types.ts";

/** Written by `ArenaProvider`, read by `useArena`, and by nothing else — it is not exported beyond
 *  this pair on purpose. A component reaching for the raw context could read a null without the
 *  error message below, which is the one thing that makes a missing provider diagnosable. */
export const ArenaContext = createContext<ArenaContextValue | null>(null);

export function useArena(): ArenaContextValue {
  const ctx = useContext(ArenaContext);
  if (!ctx) throw new Error("useArena() must be called inside <ArenaProvider>");
  return ctx;
}
