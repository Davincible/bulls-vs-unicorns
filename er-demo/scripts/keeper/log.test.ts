// THE PREDICATE THE `resolve` RETRY HANGS ON, DRIVEN WITH BOTH LAYERS' REAL WIRE SHAPES.
//
// `failedWith` has one call site — `resolveRound` in keeper.ts — and when it answers `false` for a
// genuine `FightNotOverYet`, `RESOLVE_RETRY_ATTEMPTS` collapses to a single attempt and a delegated
// round is left stranded in `Fight`, holding ~0.0235 SOL of rent that `close_round_account` can only
// reclaim from a terminal phase. That has now happened TWICE — once with `instanceof AnchorError`
// (verify-session-real.mjs step 12) and once with the `Error Code: <name>` regex over `e.logs` that
// replaced it. Neither was caught, and the reason both went unnoticed is the same reason this file
// exists: the code was exercised only against errors somebody imagined, and the imagined error always
// had the field the classifier happened to read.
//
// SO THE FIXTURES ARE EVIDENCE, NOT INVENTION. `routerError` and `baseLayerError` come from
// `src/v2/data/chainErrorShapes.ts` — one transcription of a real devnet run, shared with the three
// browser-side classifiers that depend on the same bytes. Writing the strings out again here would
// make this the fourth copy and would let this file go on passing while the capture it was built from
// turned out to be wrong somewhere else. A correction to the capture must land on every consumer at
// once or it has not landed.
//
// THE ROLLUP CASE IS THE ONE THAT MATTERS. Every real `resolve` is sent through the Magic Router
// against a round that is delegated by construction, so `routerError` is not an edge case being
// covered for completeness — it is the only shape this predicate sees in production. The base-layer
// case is here because an undelegated round and the `scripts/verify-*` harnesses still produce it,
// and because "matches the rollup" must not be allowed to quietly mean "matches only the rollup".

import { describe, expect, it } from "vitest";

import { failedWith } from "./log.ts";
import { errorCodeOf } from "../../src/v2/data/programError.ts";
import { loadIdl } from "../../src/chain/idl.ts";
import { baseLayerError, routerError } from "../../src/v2/data/chainErrorShapes.ts";

/** The two numbers this file reasons with, as the checked-in IDL defines them TODAY. Named rather
 *  than inlined so the assertions below read as "this error" and "some other error" — the property
 *  being tested is never about a particular integer. */
const FIGHT_NOT_OVER_YET = 6013; // 0x177d
const FIGHT_BEHIND = 6022; // 0x1786 — a different arena error, used as the negative control

const hex = (code: number) => `0x${code.toString(16)}`;

describe("failedWith — the Ephemeral Rollup path, where the outage was", () => {
  it("recognises the error from the hex code alone, with no logs and no name anywhere", () => {
    // THE REGRESSION TEST. This exact shape — `transactionLogs: undefined`, the name absent from
    // every field — is what the router throws, and it is what the previous log-keyed implementation
    // answered `false` to on every attempt. If this ever goes red, the three-attempt retry is a
    // one-attempt retry again and rounds start stranding in `Fight`.
    expect(failedWith(routerError(hex(FIGHT_NOT_OVER_YET)), "FightNotOverYet", FIGHT_NOT_OVER_YET))
      .toBe(true);
  });

  it("does not claim a DIFFERENT error's hex code", () => {
    // The other half of the retry's contract, and the more dangerous direction. `resolveRound` treats
    // a match as "too early, wait three seconds and try again" and everything else as `throw e`. A
    // predicate that matched loosely would swallow a real fault — `NotFighting`, `MathOverflow`,
    // anything — into a silent retry ladder that then gives up with a warning saying the ER's clock
    // was a beat behind. The failure would never reach the status file.
    expect(failedWith(routerError(hex(FIGHT_BEHIND)), "FightNotOverYet", FIGHT_NOT_OVER_YET))
      .toBe(false);
  });

  it("refuses to guess when the IDL could not be read, rather than trusting a number nobody sourced", () => {
    // `undefined` is what `fightNotOverYetCode()` returns if `loadIdl()` fails, and this is exactly
    // the behaviour the keeper had BEFORE this fix: correct on the base layer, blind on the rollup.
    // Degrading to it is a loss of retries, not a wrong answer — which is the right way round.
    expect(failedWith(routerError(hex(FIGHT_NOT_OVER_YET)), "FightNotOverYet", undefined)).toBe(false);
  });
});

describe("failedWith — the base layer, which must not regress while the rollup is being fixed", () => {
  it("still reads Anchor's own log line, the form that worked before any of this", () => {
    const e = baseLayerError("FightNotOverYet", FIGHT_NOT_OVER_YET, "the bell has not rung");
    expect(failedWith(e, "FightNotOverYet", FIGHT_NOT_OVER_YET)).toBe(true);
    // And with no number at all, because the name is genuinely sufficient here — this is the one
    // layer where the pre-fix implementation was right.
    expect(failedWith(e, "FightNotOverYet", undefined)).toBe(true);
  });

  it("says no to another error even though its hex is sitting in the very same text", () => {
    // `baseLayerError` populates the name, the number AND the hex, because the real base-layer throw
    // does. So this is not the trivial negative it looks like: it is the assertion that the three
    // forms are not OR'd together blindly.
    const e = baseLayerError("FightBehind", FIGHT_BEHIND, "the fight is behind the clock");
    expect(failedWith(e, "FightNotOverYet", FIGHT_NOT_OVER_YET)).toBe(false);
  });

  it("lets a name that IS present overrule a colliding number", () => {
    // THE 6001 COLLISION, pinned from the keeper's side rather than only from the browser's.
    // `#[error_code]` numbers are assigned per-crate with no coordination, so session-keys'
    // `SessionError::InvalidToken` and bulls-arena's `ArenaError::RoundOutOfOrder` are BOTH 6001 and
    // both arrive as `0x1771`. Where a name is present it is the only unambiguous evidence of which
    // one fired, so it decides — otherwise adding the number to this predicate would have made the
    // collision worse on the one layer that can actually resolve it.
    //
    // On the ROLLUP nothing can separate them: the wire carries one hex code and nothing else. What
    // keeps that harmless in this process is structural and is argued on `failedWith` in log.ts — the
    // keeper signs with a raw `Keypair` and passes `sessionToken: null`, so a `SessionError` cannot
    // arise from any transaction it sends. `FightNotOverYet` is unaffected either way.
    const e = baseLayerError("RoundOutOfOrder", 6001, "rounds must open in sequence");
    expect(failedWith(e, "InvalidToken", 6001)).toBe(false);
    expect(failedWith(e, "RoundOutOfOrder", 6001)).toBe(true);
  });
});

describe("failedWith — the wiring to the deployed program, which no fixture can prove", () => {
  it("finds FightNotOverYet in the real IDL, and matches the hex that number implies", async () => {
    // EVERY TEST ABOVE ASSUMES THE NAME STILL EXISTS. They pass a string literal to `errorCodeOf`'s
    // caller and a hand-built fixture to the matcher, so all of them would go on passing if
    // `ArenaError::FightNotOverYet` were renamed in lib.rs — and the keeper would be back to the
    // original outage, because on the rollup the lookup would return `undefined`, `failedWith` would
    // degrade to a name the wire never sends, and the retry would silently be one attempt again.
    // This is the assertion that fails instead.
    //
    // It reads `public/idl/bulls_arena.json` off disk (`loadIdl` takes its Node path — there is no
    // `window` under vitest), so it is a check against the artefact the running keeper actually loads.
    //
    // IT ASSERTS THE NAME RESOLVES, NOT THAT IT RESOLVES TO 6013. A variant inserted above it is a
    // legitimate change that moves the number in lib.rs, in the IDL and in the keeper together — the
    // whole reason the number is looked up rather than written down — and a test pinned to 6013 would
    // turn that correct change into a red build. What must never happen is the lookup coming back
    // empty. The `FIGHT_NOT_OVER_YET` constant at the top of this file is fixture input, not a claim
    // about the deploy; the line below is where the deploy gets to speak.
    const code = errorCodeOf((await loadIdl()).errors, "FightNotOverYet");
    expect(code).toBeDefined();
    expect(failedWith(routerError(hex(code!)), "FightNotOverYet", code)).toBe(true);
  });
});
