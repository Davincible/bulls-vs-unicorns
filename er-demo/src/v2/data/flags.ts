// URL flags. Read once, at module load, because both of them decide the SHAPE of the provider tree
// (which hooks run at all), and a flag that could change mid-session would mean a component whose
// hook list changes — the one thing React genuinely cannot survive. They are deep-links, not
// settings: changing one is a reload.

import { clampLineup } from "./fixtureLineup.ts";

/** `?fixture=1` — serve `mockData.ts` and touch the network for nothing at all. `0`/`false` are
 *  treated as off so a bookmarked link can turn it back off explicitly. */
export function parseFixtureFlag(search: string): boolean {
  const raw = new URLSearchParams(search).get("fixture");
  if (raw === null) return false;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

/** `?ref=<code>` — this browser arrived on someone's referral link. The chain has no referral
 *  concept; this only feeds the simulated ledger (see `simLedger.ts#recordDeploy`). */
export function parseRefFlag(search: string): boolean {
  const raw = new URLSearchParams(search).get("ref");
  return raw !== null && raw.length > 0;
}

/** `?fighters=<n>` — how many fighters the FIXTURE fields, clamped to the range the program itself
 *  accepts (2..48, `MAX_FIGHTERS` in `programs/bulls-arena/src/lib.rs`). Ignored entirely off the
 *  fixture: a live round's lineup is whoever entered it, and no URL can add a tenth player to a
 *  round the chain says has nine.
 *
 *  It exists because the page had only ever been run at the fixture's hand-written 9 while the
 *  program's ceiling was higher — the canvas had been measured there, but the rosters, standings,
 *  leaderboard, history and the round poll had not. That gap has since WIDENED rather than closed:
 *  the ceiling moved 16 -> 48, so this flag is now the only way to see what the product does at three
 *  times the lineup anyone has looked at. Opt-in rather than a new default so that a screenshot taken
 *  today still compares against one taken yesterday; the clamp and the builder are in
 *  `fixtureLineup.ts`, with tests. */
export function parseFightersFlag(search: string): number {
  return clampLineup(new URLSearchParams(search).get("fighters"));
}

/** WHO SIGNS. `"wallet"` means the visitor's own Phantom; `"burner"` means the keypair this browser
 *  generates and keeps in localStorage (`chain/useSigner.ts`). */
export type SignerMode = "burner" | "wallet";

/**
 * `?signer=burner` — sign with the local burner keypair instead of a connected wallet.
 *
 * THE DEFAULT IS `wallet` EVERYWHERE, INCLUDING LOCALHOST, and that is deliberate rather than
 * incidental. Auto-selecting the burner on localhost would mean the path every real visitor takes is
 * the one path nobody ever runs while building it — the classic dev/prod divergence trap, and an
 * expensive one here, because the wallet path is where all of this workstream's failure states live
 * (no extension, wrong network, rejected connection, zero balance). A developer with no Phantom
 * installed opens `?signer=burner` and gets exactly the app that existed before this change; the
 * no-extension state offers that link, so nobody has to know it from memory.
 *
 * `?fixture=1` needs no signer at all — `FixtureArenaProvider` constructs neither, so this flag is
 * simply not consulted there.
 *
 * Anything other than the two spellings falls back to `wallet`: a typo must not silently hand a
 * stranger an unfunded burner, which is the failure this whole change exists to delete.
 */
export function parseSignerFlag(search: string): SignerMode {
  return new URLSearchParams(search).get("signer")?.toLowerCase() === "burner" ? "burner" : "wallet";
}

// Read through a guard rather than off `window` directly so this module is importable outside a
// browser — `flags.test.ts` runs in Node, and every function above is pure and worth testing there.
// In a browser this is exactly `window.location.search`; there is no second behaviour.
const SEARCH = typeof window === "undefined" ? "" : window.location.search;

/** Fixed for the page's lifetime — see this file's header. */
export const FIXTURE_FORCED = parseFixtureFlag(SEARCH);
export const ARRIVED_BY_REFERRAL = parseRefFlag(SEARCH);
export const FIXTURE_LINEUP = parseFightersFlag(SEARCH);
/** Which of the two chain providers `ArenaProvider` mounts. Same rule as `FIXTURE_FORCED`, and for
 *  the same mechanical reason: the two providers call different hooks, so this cannot be state. */
export const SIGNER_MODE = parseSignerFlag(SEARCH);
