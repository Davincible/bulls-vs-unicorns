// `RoundState` (chain/useRound.ts, PublicKeys and u8s) -> `LiveRound` (v2/contract.ts, strings and
// display-ready fields). Pure: no React, no network, so the mapping is testable and the hook above it
// (`useLiveRound.ts`) is only about polling and memoisation.
//
// Views never see a `PublicKey` — that boundary is drawn here, once, deliberately: base58 conversion
// is not free, and doing it inside a render pass would run it for every fighter on every 250ms clock
// tick.

import type { FighterState, RoundState } from "../../chain/useRound.ts";
import type { HitEventEntry } from "../../sim/hitEvents.ts";
import { nameFor, shortKey, type FighterView, type LiveRound } from "../contract.ts";
import { extractTerms } from "./extractTerms.ts";
import { fightPace } from "./fightPace.ts";
import { toSide } from "./roundLog.ts";

/** The seed is a 32-byte array that is all zeroes until the VRF callback lands (Drawing -> Fight), so
 *  "has anything non-zero" is the reveal test — the same one `App.tsx` uses. */
export function isSeedRevealed(seed: number[]): boolean {
  return seed.some((b) => b !== 0);
}

export function toHex(bytes: number[]): string {
  return Buffer.from(bytes).toString("hex");
}

export function toFighterViews(fighters: FighterState[], youPubkey: string): FighterView[] {
  return fighters.map((f, id) => {
    const wallet = f.wallet.toBase58();
    return {
      // Positional, and it must stay positional: the hit-event stream names its attacker/defender by
      // index into this same array (`sim/hitEvents.ts`), and the canvas resolves those indices back
      // to sprites. Sorting or filtering this list anywhere upstream of the canvas would silently
      // repoint every hit in the fight.
      id,
      wallet,
      short: shortKey(wallet),
      name: nameFor(wallet),
      side: toSide(f.side),
      stake: f.stake,
      hp: f.hp,
      banked: f.banked,
      dead: f.dead,
      isYou: wallet === youPubkey,
      // NULL HERE, RESOLVED ONE LAYER UP. A round account carries a wallet, a side, a stake and its
      // hp; it has never heard of an X account, and the wallet -> avatar mapping is a
      // separately-fetched, separately-verified fact. Threading it through a pure decoder would put a
      // network read inside a mapper. `null` is also the honest answer for the overwhelming majority
      // of fighters — see `FighterView.avatarSrc`.
      avatarSrc: null,
    };
  });
}

/** The entries the fight replay is a pure function of. `stake` is net-of-fee, exactly as the chain
 *  stored it — see `HitEventEntry`'s own doc comment. */
export function toHitEventEntries(fighters: FighterState[]): HitEventEntry[] {
  return fighters.map((f) => ({ wallet: f.wallet.toBase58(), side: toSide(f.side), stake: f.stake }));
}

/** `fight_started_at` is on-chain UNIX SECONDS (i64), 0 before the fight begins. Everything in the
 *  browser works in epoch ms, so the conversion happens here rather than at each of the four places
 *  that would otherwise multiply by 1000 and eventually one of them wouldn't. */
export function fightStartedAtMsOf(round: RoundState): number | null {
  return round.fightStartedAt > 0n ? Number(round.fightStartedAt) * 1000 : null;
}

/** `lobby_closes_at`, same seconds-to-ms conversion — or NULL when the deployed program has no such
 *  field, which is a state this client genuinely has to survive.
 *
 *  The lobby deadline arrived in a later revision of the program than the one that may be running.
 *  Decoded against an older account the field is absent; opened by an older `open_round` it is zero.
 *  Both mean the same thing — this round has no deposit deadline, and `Lobby` is the whole truth
 *  about whether it is enterable (see `LiveRound.lobbyClosesAtMs`). Neither is worth a thrown error:
 *  a front end that refuses to render a round because the chain is one revision behind it is broken
 *  in a much more expensive way than one that reads what is there. */
export function lobbyClosesAtMsOf(round: RoundState): number | null {
  const raw = round.lobbyClosesAt;
  if (raw === undefined || raw === null || raw <= 0n) return null;
  return Number(raw) * 1000;
}

export function toLiveRound(round: RoundState, youPubkey: string, nowMs: number): LiveRound {
  const fighters = toFighterViews(round.fighters, youPubkey);
  const fightStartedAtMs = fightStartedAtMsOf(round);
  const pace = fightPace({
    phase: round.phaseName,
    fightStartedAtMs,
    fighters,
    tickCount: round.tickCount,
    nowMs,
  });

  return {
    roundNo: round.roundNo,
    phase: round.phaseName,
    winner: round.phaseName === "Settled" ? toSide(round.winner) : null,
    pot: round.pot,
    fighters,
    seedHex: isSeedRevealed(round.seed) ? toHex(round.seed) : null,
    seedCommitHex: toHex(round.seedCommit),
    fightStartedAtMs,
    lobbyClosesAtMs: lobbyClosesAtMsOf(round),
    tickCount: round.tickCount,
    elapsedSec: pace.elapsedSec,
    stepsNow: pace.stepsNow,
    resolvable: pace.resolvable,
    // Priced at `pace.stepsNow` — the canonical cursor, which is the one `extract()` itself catches
    // the round up to before charging. `round.tickCount` is the wrong number here and would quote
    // the opening 20% for a whole fight nobody happened to tick; see `extractTerms.ts`'s header.
    extractTerms: extractTerms({ phase: round.phaseName, fighters, stepsNow: pace.stepsNow }),
  };
}
