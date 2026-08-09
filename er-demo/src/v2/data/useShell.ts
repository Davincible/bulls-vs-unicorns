// The parts of the context that are the same whether the page is on chain data or the fixture:
// toasts, the simulated ledger, the player's mode intent, and the selected arena. Shared by both
// providers so neither can drift from the other about what a toast lasts for or where the referral
// link points.

import { useCallback, useMemo, useState } from "react";
import type { ArenaMeta, BoardStyle, Mode } from "../contract.ts";
import { ARRIVED_BY_REFERRAL } from "./flags.ts";
import { useSimLedger, type SimLedgerHandle } from "./useSimLedger.ts";
import { useToasts } from "./useToasts.ts";
import type { ArenaContextValue } from "./types.ts";

export interface Shell {
  toasts: ArenaContextValue["toasts"];
  simLedger: SimLedgerHandle;
  mode: Mode;
  setMode(m: Mode): void;
  arenaId: ArenaMeta["id"];
  setArenaId(id: ArenaMeta["id"]): void;
  /** How the field is drawn — see `BoardStyle` in contract.ts. Persisted; see `BOARD_KEY`. */
  board: BoardStyle;
  setBoard(b: BoardStyle): void;
  /** The player's own referral link. Full pubkey, not a short form — a code that can collide is not
   *  a code. `SIM`: nothing on chain reads it. */
  refLink(pubkey: string): string;
}

/** Dotted and versioned, matching `simLedger.ts`'s `SIM_LEDGER_KEY`, and versioned for the same
 *  reason: the set of legal values is allowed to grow or be renamed, and a value stored under an older
 *  vocabulary must be ignored rather than half-read. Bump the suffix, don't migrate — this is a
 *  cosmetic preference, and losing it costs one click. */
const BOARD_KEY = "v2.board.style.1";

/** THE DEFAULT IS `blank` — the minimal board is what the toggle was built to look at, and `survey` is
 *  there to get back to the instrument look, not to be the thing every visit opens on. Changing which
 *  one the page lands in is this one word. */
const BOARD_DEFAULT: BoardStyle = "blank";

/** Never throws, and validates rather than casting: the value under this key is a string a user can
 *  edit, and `"suvrey"` must degrade to the default, not reach the canvas as a board style nothing
 *  draws. The `getItem` call is inside the `try` because in some engines merely TOUCHING
 *  `localStorage` throws when storage is disabled (private mode, a sandboxed frame) — reading it
 *  outside would white-screen the whole page over a preference about a grid. */
function loadBoard(): BoardStyle {
  try {
    const raw = localStorage.getItem(BOARD_KEY);
    return raw === "survey" || raw === "blank" ? raw : BOARD_DEFAULT;
  } catch {
    return BOARD_DEFAULT;
  }
}

/** Written from the setter rather than from an effect on the value — the opposite of `useSimLedger`'s
 *  "one writer" rule, and deliberately so. An effect would persist on mount too, which would record a
 *  preference for anybody who merely LOADED the page; then flipping `BOARD_DEFAULT` later would leave
 *  every previous visitor pinned to the old default forever. Only an actual press is a choice. */
function saveBoard(board: BoardStyle): void {
  try {
    localStorage.setItem(BOARD_KEY, board);
  } catch {
    // Quota, or storage disabled. The toggle still works for this session; only the memory of it is
    // lost, and that is not worth interrupting anyone over.
  }
}

export function useShell(): Shell {
  const toasts = useToasts();
  const simLedger = useSimLedger(ARRIVED_BY_REFERRAL);
  // "mayhem" is the original's default and the more legible one to arrive on: raids compound in the
  // ring and doing nothing is a real strategy. It is PLAYER-SIDE INTENT — the program has one mode
  // (see `Mode` in contract.ts) — and every surface that shows it has to say so.
  const [mode, setMode] = useState<Mode>("mayhem");
  // Only "au" is chain-backed (`ARENAS`); the picker exists because the original had five, and the
  // other four render as selectable-but-inert rather than being quietly hidden.
  const [arenaId, setArenaId] = useState<ArenaMeta["id"]>("au");
  // Read from storage lazily (the function form), not on every render: this is a synchronous
  // same-origin read, but it is also the kind of thing that ends up in a render loop the moment
  // someone adds a second `useState` beside it.
  const [board, setBoardState] = useState<BoardStyle>(loadBoard);
  const setBoard = useCallback((next: BoardStyle) => {
    setBoardState(next);
    saveBoard(next);
  }, []);

  const refLink = useMemo(
    () => (pubkey: string) => `${window.location.origin}${window.location.pathname}?ref=${pubkey}`,
    [],
  );

  return { toasts, simLedger, mode, setMode, arenaId, setArenaId, board, setBoard, refLink };
}
