// Shell state, as a context rather than props.
//
// Every view in v2 takes NO props and reads `useArena()` itself (SPEC.md) — which leaves no channel
// for the two things the shell owns but a view has to be able to trigger: switching screens, and
// opening a fighter's profile from a roster row or a canvas click. This is that channel, and it is
// deliberately tiny: current screen, current rail tenant, and nothing else. It carries no data —
// the rail looks its fighter up in `useArena()` by wallet, so nothing here can go stale against
// the round.
//
// Fighters are addressed by WALLET, not by the array index the canvas emits: the index is only
// stable within one round's fighter array, and the profile outlives a click (it stays open across
// polls, and across the round settling underneath it).

import { createContext, useContext } from "react";
import type { ViewId } from "../contract.ts";

/** The right-hand rail has exactly one tenant at a time — see the note in shell.css. */
export type Rail = { kind: "wallet" } | { kind: "fighter"; wallet: string } | null;

export interface ShellApi {
  view: ViewId;
  setView(v: ViewId): void;
  rail: Rail;
  setRail(rail: Rail): void;
  /** `null` when the rail isn't showing a fighter. The canvas rings this one. */
  inspectedWallet: string | null;

  /** BRING THE FIRST-VISIT TAKEOVER BACK. It shows once per browser (`v2_intro_seen`) and until now
   *  there was no second route to it — which made the extract penalty, the "Mayhem/Extraction is UI
   *  intent, not something the program enforces" caveat and the meaning of the `sim` marker
   *  unreachable the moment anybody pressed "Let's go". Reopening does NOT clear the stored flag: a
   *  reader asking to re-read it is not asking to be shown it again on every future visit. */
  openIntro(): void;

  /** WHETHER THE PAGE NARRATES THE FIGHT AT YOU — the toggle behind `ui/useCombatVoice.ts`.
   *
   *  Shell state rather than a view's own, for two reasons. The commentary is produced by
   *  `ToastRail`, which is mounted by the shell and lives outside every screen, while the control
   *  that sets it is in 00-2 on the arena screen; and it is content that appears and disappears on
   *  its own, so WCAG 2.2.2 wants a way to stop it that is not "navigate away". Not persisted — its
   *  default is a live reading of `prefers-reduced-motion` (see `App.tsx`), and a stored `true` would
   *  quietly outrank a preference the reader has since turned on at the system level. */
  commentary: boolean;
  setCommentary(on: boolean): void;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell() must be called inside <App>");
  return ctx;
}
