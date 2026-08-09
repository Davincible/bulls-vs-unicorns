// The zustand store — per snug-floating-mitten.md, "the ONLY coupling point between chain/ and
// render/". Phase 3 has no render/ yet, so this file only holds what Phase 3 itself needs: who's
// signing, what the polled round looks like, and UI-level toasts. Playhead/hitEvents state
// (Phase 4's actual reason for existing) is deliberately NOT here yet — adding it now, before
// anything consumes it, would be building ahead of the plan for no observable benefit.
//
// `chain/useRound.ts` already owns polling and produces a clean `RoundState`; this store doesn't
// duplicate that logic, it just mirrors the hook's latest value so components that aren't already
// holding a `useRound()` result (e.g. a future render/ component with no reason to poll itself) can
// read the same state. `App.tsx` is the one place that writes `round`/`signerPubkey` into the store.

import { create } from "zustand";
import type { PublicKey } from "@solana/web3.js";
import type { RoundState } from "../chain/useRound.ts";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

let nextToastId = 1;

interface DemoStore {
  /** The active signer's pubkey, or null before `useSigner()` has run once. In practice this is set
   *  almost immediately (the burner keypair is synchronous, see chain/useSigner.ts), but stays
   *  nullable so nothing assumes a signer exists before App.tsx has mounted. */
  signerPubkey: PublicKey | null;
  setSigner(pubkey: PublicKey | null): void;

  /** Mirrors the latest `useRound()` result. Null before the first successful poll, or once a round
   *  ceases to be tracked (e.g. `roundPda` cleared). */
  round: RoundState | null;
  setRound(round: RoundState | null): void;

  /** Ephemeral, dismissible messages — one toast per failed/succeeded chain action, per the plan's
   *  80/20 cut: "one toast with the raw error message is enough," no per-error-type recovery flows. */
  toasts: Toast[];
  pushToast(message: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
}

export const useDemoStore = create<DemoStore>((set) => ({
  signerPubkey: null,
  setSigner: (pubkey) => set({ signerPubkey: pubkey }),

  round: null,
  setRound: (round) => set({ round }),

  toasts: [],
  pushToast: (message, kind = "info") =>
    set((s) => ({ toasts: [...s.toasts, { id: nextToastId++, message, kind }] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
