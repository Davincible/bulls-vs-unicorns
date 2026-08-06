// arena registry — the pure definition of every arena: which tokens play, which economy, and how
// an arena id maps to those. No mutable state and no side effects, so it's safe to share across
// the engine and unit-test directly. Two families:
//   2-team: pairing × economy (au/as/us × normal|extraction), slots A/B map to the sim's bull/uwu.
//   N-team: 3-WAY (ansem/uwu/sol) and FFA (teams=0, each fighter solo — see gameN.ts).
import type { Mode } from "./game.ts";

// Token names: ansem (ledger field `bull`), uwu, sol. SOL arenas play from the `sol` balance.
export type Tok = "ansem" | "uwu" | "sol";
export const FIELD: Record<Tok, "bull" | "uwu" | "sol"> = { ansem: "bull", uwu: "uwu", sol: "sol" };

export const PAIRINGS: Record<string, [Tok, Tok]> = { au: ["ansem", "uwu"], as: ["ansem", "sol"], us: ["uwu", "sol"] };

// Which arenas actually run. The bot float is finite, so spreading it over all ten makes every
// lobby sparse and every fighter tiny (a ring of ~1 renders at the minimum radius and reads as
// invisible). Concentrating the same money into fewer arenas gives full lobbies and real stakes.
// ENABLED_ARENAS is a comma-separated list of ids; unset = everything.
const ENABLED = (process.env.ENABLED_ARENAS || "").split(",").map(s => s.trim()).filter(Boolean);
const enabled = (id: string) => ENABLED.length === 0 || ENABLED.includes(id);

const ALL_2TEAM = Object.keys(PAIRINGS).flatMap(p => ["normal", "extraction"].map(e => `${p}-${e}`));
export const ARENA_IDS = ALL_2TEAM.filter(enabled);
export const arenaTokens = (aid: string): [Tok, Tok] => PAIRINGS[aid.split("-")[0]];
export const arenaEco = (aid: string): Mode => aid.split("-")[1] as Mode;

export const NARENAS: Record<string, { teams: number; toks: Tok[]; eco: Mode }> = {
  "3w-normal":      { teams: 3, toks: ["ansem", "uwu", "sol"], eco: "normal" },
  "3w-extraction":  { teams: 3, toks: ["ansem", "uwu", "sol"], eco: "extraction" },
  "ffa-extraction": { teams: 0, toks: ["ansem"],               eco: "extraction" },
  // FFA Mayhem is measurably harsher on small stakes (see ARENAS.md) but Max wants it playable.
  "ffa-normal":     { teams: 0, toks: ["ansem"],               eco: "normal" },
};
export const NARENA_IDS = Object.keys(NARENAS).filter(enabled);

/** Every arena id that exists, whether or not it's currently switched on (for docs/tools). */
export const ALL_ARENA_IDS = [...ALL_2TEAM, ...Object.keys(NARENAS)];

// Economy constants (locked by Max): 0.2% deploy fee, $100 per-stake cap, 0.30% convert fee
// (PumpSwap pool fee, swapped on-chain at mainnet), $0.01 minimum entry.
export const FEE = 0.002, CAP = 100, CONVERT_FEE = 0.003, MIN_ENTRY = 0.01;
