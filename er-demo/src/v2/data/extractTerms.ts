// WHAT EXTRACTING COSTS, resolved for the round on screen — and whether the local player may do it.
//
// One module for both because they are one question. `actions.extractEligible` used to answer only
// "would the transaction land", which was the whole truth while `extract()` returned everything in
// the ring and is a half-truth now that the house takes a cut of it: a button that says "Extract
// $12.40" when $2.48 of that is about to be taken is stating a price the chain will not honour.
//
// NOTHING HERE RE-DERIVES THE CURVE. `sim/erSim.ts` is the maintained mirror of lib.rs's
// `extract_penalty_bps` / `split_extraction` — the Rust's own
// `parity_tests::the_typescript_mirrors_carry_the_same_penalty_curve` parses that file's table and
// fails if it drifts — so this module converts units and picks the cursor, and delegates every piece
// of arithmetic that decides money. A fourth hand-written copy of a 20%-decaying-to-zero line is
// exactly how a UI ends up quoting a rate the program does not charge.
//
// THE CURSOR IS THE CANONICAL ONE (`LiveRound.stepsNow`), NOT `Round.tick_count`, and that is the
// single most important line in this file. `extract()` runs `catch_up(r, now, u64::MAX)` BEFORE it
// reads `let cursor = r.tick_count`, so the rate a player is charged is the rate at the cursor the
// wall clock has reached — not at the stored one, which sits wherever the last person to send a
// `tick()` left it (0, for an entire fight nobody is ticking). Quoting the stored cursor would
// advertise the opening 20% for the length of a round in which the real rate had already decayed to
// nothing, i.e. it would be wrong in the direction that talks players out of a free exit.
//
// Pure and React-free: `extractTerms.test.ts` runs it directly, and both providers — the chain one
// and the fixture — call these same two functions, so the fixture cannot show a mechanic the chain
// does not enforce.

import { extractPenaltyBps, penaltyHorizonSteps, splitExtraction } from "../../sim/erSim.ts";
import {
  MAX_STEPS,
  stepsPerSecond,
  type ExtractEligibility,
  type ExtractTerms,
  type LiveRound,
  type PhaseName,
} from "../contract.ts";

/** How far ahead the panel previews the rate. Seconds rather than steps because the reader is
 *  holding a stopwatch, not a cursor — and short, because "wait 10 seconds" is a decision a player
 *  can actually make mid-fight, whereas "wait 90" is a different round. Points past the horizon
 *  correctly read 0%: for a two-fighter duel (horizon 71 steps at 4 steps/s ≈ 18s) that is the
 *  truth, not a rounding artifact. */
const DECAY_PREVIEW_SECONDS = [10, 20, 30] as const;

/** Just enough of a fighter to find the local player's and see whether they hold anything. */
export interface TermsFighter {
  isYou: boolean;
  dead: boolean;
  hp: bigint;
}

export interface ExtractTermsInput {
  phase: PhaseName;
  /** The full lineup: its LENGTH sets the horizon (`penalty_horizon_steps(n)`), because a fight's
   *  length in steps grows ~n^1.5 and a duel and a sixteen-way cannot share one decay curve. */
  fighters: readonly TermsFighter[];
  /** `LiveRound.stepsNow` — the canonical cursor. See the module header. */
  stepsNow: number;
}

/** `split_extraction(taken, n, cursor)`: what a fighter banks and what the house takes.
 *
 *  Delegated in full — the only thing added is the unit conversion, since `LiveRound` counts steps
 *  in `number` (a cursor is bounded by MAX_STEPS = 4,000) and the program's mirror counts them in
 *  `bigint`. */
export function extractSplit(
  hp: bigint,
  fighterCount: number,
  cursor: number,
): { keep: bigint; forfeit: bigint } {
  const { kept, penalty } = splitExtraction(hp, fighterCount, BigInt(Math.max(0, Math.floor(cursor))));
  return { keep: kept, forfeit: penalty };
}

/** The whole price of leaving, at this instant, for this lineup. */
export function extractTerms(input: ExtractTermsInput): ExtractTerms {
  const n = input.fighters.length;
  const cursor = Math.max(0, Math.min(Math.floor(input.stepsNow), MAX_STEPS));
  const rate = stepsPerSecond(n);
  const freeAtStep = Number(penaltyHorizonSteps(n));
  const stepsToFree = Math.max(0, freeAtStep - cursor);

  // Only during Fight is there anything to split. Outside it `extract()` fails on its own
  // `require!(r.phase == Phase::Fight)` guard, and quoting a fighter's Lobby stake as "what you
  // would bank" would price a transaction that cannot be sent.
  const mine =
    input.phase === "Fight" ? input.fighters.find((f) => f.isYou && !f.dead && f.hp > 0n) : undefined;
  const split = mine ? extractSplit(mine.hp, n, cursor) : null;

  return {
    penaltyBps: Number(extractPenaltyBps(n, BigInt(cursor))),
    freeAtStep,
    stepsToFree,
    // `rate` is `n * 2` and n is clamped to at least 2 by the phases that can reach here, but a
    // Lobby with nobody in it is a real state on this page and dividing by its zero rate would put
    // an Infinity on screen.
    secondsToFree: rate > 0 ? stepsToFree / rate : 0,
    // ONLY WHILE THE FIGHT IS RUNNING. The preview says "wait n seconds and the rate is this", which
    // is true only where seconds move the cursor. In a lobby they do not — the cursor sits at 0
    // until the bell — so a ladder there would promise a discount for waiting out a phase in which
    // nothing decays. Empty is the honest answer; the panel says "at the opening bell" instead.
    decay:
      input.phase === "Fight"
        ? DECAY_PREVIEW_SECONDS.map((inSeconds) => ({
            inSeconds,
            penaltyBps: Number(
              extractPenaltyBps(n, BigInt(Math.min(cursor + inSeconds * rate, MAX_STEPS))),
            ),
          }))
        : [],
    youKeep: split?.keep ?? null,
    youForfeit: split?.forfeit ?? null,
  };
}

/**
 * WHETHER THE LOCAL PLAYER MAY EXTRACT, AND ON WHAT TERMS — the client-side restatement of
 * `extract()`'s own guards, so the button can be dark for a stated reason instead of sending a
 * transaction to find out.
 *
 * Reason-for-reason as `src/ui/ExtractButton.tsx` wrote them, including their register: a judge
 * watching a live demo has to be able to read why the button is off rather than wonder whether it
 * is broken.
 *
 * IT READS `LiveRound`, NOT THE RAW `RoundState`, which is what lets the fixture and the chain share
 * it. The fixture used to carry its own hand-copied ladder of the same four branches "in the same
 * register" — two copies of a rule, one of which was going to be updated alone. Nothing is lost:
 * `isYou` is set from the very keypair this check used to compare against, and the split has to come
 * from `LiveRound.stepsNow` anyway (the canonical cursor is not on `RoundState`).
 *
 * @param live      the round on screen, or null when the first poll hasn't landed.
 * @param notReady  a reason the client cannot send at all — no program, no round PDA. Chain path
 *                  only; the fixture passes nothing, because neither can be true there.
 */
export function extractEligibility(
  live: LiveRound | null,
  notReady: string | null = null,
): ExtractEligibility {
  const none = { hp: null, keep: null, forfeit: null };
  if (notReady) return { ok: false, reason: notReady, ...none };
  if (!live) return { ok: false, reason: "loading round…", ...none };
  if (live.phase !== "Fight") {
    return {
      ok: false,
      reason: `extract is only available during Fight (round is currently ${live.phase})`,
      ...none,
    };
  }
  const mine = live.fighters.find((f) => f.isYou);
  if (!mine) return { ok: false, reason: "you have no fighter in this round", ...none };
  if (mine.dead || mine.hp <= 0n) {
    return { ok: false, reason: "your fighter is already out", hp: mine.hp, keep: null, forfeit: null };
  }
  // The same call `extractTerms()` made against the same fighter at the same cursor, so the panel's
  // headline figure and the button's cannot disagree — computed rather than read off `live` so this
  // function carries no assumption about which fighter that one picked.
  const { keep, forfeit } = extractSplit(mine.hp, live.fighters.length, live.stepsNow);
  return { ok: true, reason: null, hp: mine.hp, keep, forfeit };
}
