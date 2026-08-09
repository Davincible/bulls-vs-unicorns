// THE CAPABILITY PROBE, against hand-built IDLs rather than against whatever happens to be deployed.
//
// `programFeaturesOf` has always said it was "pure, so the whole probe is exercisable from a test
// against a hand-built IDL" — and until the auto-close policy arrived, nothing exercised it. That
// changed the stakes: `roundAccountClose` is the first capability that defaults ON, so its `false`
// direction is the only thing standing between an un-deployed instruction and a keeper sending it
// once a second forever. A capability that defaults to on has to be able to prove it is unavailable.
//
// The failure this file is really about is the QUIET one, documented at length in the module header:
// Anchor builds account lists by walking the IDL and silently DROPS names it cannot find, so an
// instruction present without its `authority` account builds a transaction that is refused for a
// reason that says nothing about the real problem. A missing method throws loudly on its own; a
// missing account does not. Hence the account-level assertions below.

import { describe, expect, it } from "vitest";
import type { Idl } from "@coral-xyz/anchor";
import { programFeaturesOf } from "./programFeatures.ts";

/** Enough of an IDL for the probe, in the RAW snake_case shape the file on disk actually has —
 *  Anchor camel-cases only at `new Program(...)` time, so a fixture written in camelCase would match
 *  nothing and every assertion below would pass for the wrong reason. */
function idlOf(
  instructions: { name: string; accounts?: string[] }[],
  roundFields: string[] = ["round_no", "phase", "house_swept"],
): Idl {
  return {
    address: "Prog1111111111111111111111111111111111111111",
    metadata: { name: "bulls_arena", version: "0.1.0", spec: "0.1.0" },
    instructions: instructions.map((ix) => ({
      name: ix.name,
      discriminator: [],
      accounts: (ix.accounts ?? []).map((name) => ({ name })),
      args: [],
    })),
    types: [{ name: "Round", type: { kind: "struct", fields: roundFields.map((name) => ({ name, type: "u64" })) } }],
  } as unknown as Idl;
}

/** Everything v7 has. The baseline the negative cases are each one deletion away from. */
const V7 = [
  { name: "close_lobby_and_draw", accounts: ["round", "arena", "authority"] },
  { name: "sweep_house_take", accounts: ["arena", "round", "treasury"] },
  { name: "init_treasury", accounts: ["arena", "treasury", "authority"] },
  { name: "close_round_account", accounts: ["arena", "round", "authority"] },
];

describe("a full v7 IDL", () => {
  it("reports every capability available", () => {
    expect(programFeaturesOf(idlOf(V7))).toEqual({
      authorityEarlyClose: true,
      houseTakeSweep: true,
      roundAccountClose: true,
    });
  });
});

describe("the deployment this keeper will actually meet first", () => {
  it("reports roundAccountClose FALSE when the instruction is simply absent", () => {
    // Every pre-v7 deployment. `program.methods.closeRoundAccount` is `undefined` at runtime and
    // calling it throws — once per pass, at 1Hz, on a policy that is ON by default. This `false` is
    // what makes that default safe.
    const withoutClose = V7.filter((ix) => ix.name !== "close_round_account");
    expect(programFeaturesOf(idlOf(withoutClose)).roundAccountClose).toBe(false);
  });

  it("reports roundAccountClose FALSE when the instruction exists without its authority account", () => {
    // THE QUIET FAILURE. Anchor drops an account name the IDL does not carry, with no error and no
    // warning, and builds a close that cannot satisfy `has_one = authority`. The keeper would send a
    // transaction refused by a constraint check, which says nothing about the actual problem.
    const noAuthority = V7.map((ix) =>
      ix.name === "close_round_account" ? { name: ix.name, accounts: ["arena", "round"] } : ix);
    expect(programFeaturesOf(idlOf(noAuthority)).roundAccountClose).toBe(false);
  });
});

describe("closing depends on sweeping, because the chain says so", () => {
  // `check_close_permitted` refuses with `RoundNotSwept` unless `Round.house_swept` is set, so a
  // keeper that can close but cannot sweep would close NOTHING — every attempt refused. Reporting
  // the capability as available would turn a clear "unavailable" at boot into a stream of failures.

  it("is false without sweep_house_take", () => {
    const noSweep = V7.filter((ix) => ix.name !== "sweep_house_take");
    const features = programFeaturesOf(idlOf(noSweep));
    expect(features.houseTakeSweep).toBe(false);
    expect(features.roundAccountClose).toBe(false);
  });

  it("is false without init_treasury, because the sweep has nowhere to sweep to", () => {
    const noTreasury = V7.filter((ix) => ix.name !== "init_treasury");
    expect(programFeaturesOf(idlOf(noTreasury)).roundAccountClose).toBe(false);
  });

  it("is false without Round.house_swept, because nothing could tell a swept round from an unswept one", () => {
    const features = programFeaturesOf(idlOf(V7, ["round_no", "phase"]));
    expect(features.houseTakeSweep).toBe(false);
    expect(features.roundAccountClose).toBe(false);
  });
});

describe("the hold-open veto, which this probe was originally written for", () => {
  it("is false when close_lobby_and_draw lacks the authority account", () => {
    const noAuthority = V7.map((ix) =>
      ix.name === "close_lobby_and_draw" ? { name: ix.name, accounts: ["round"] } : ix);
    expect(programFeaturesOf(idlOf(noAuthority)).authorityEarlyClose).toBe(false);
  });

  it("is false when it lacks the arena account", () => {
    // Both accounts are required, and the measured evidence is in the module header: built both ways
    // against the served IDL, the account lists were byte-identical, so the extra accounts were being
    // dropped in silence and every early close came back as `LobbyStillOpen` — an error about the
    // clock — with a real player waiting in the lobby.
    const noArena = V7.map((ix) =>
      ix.name === "close_lobby_and_draw" ? { name: ix.name, accounts: ["round", "authority"] } : ix);
    expect(programFeaturesOf(idlOf(noArena)).authorityEarlyClose).toBe(false);
  });
});

describe("an empty IDL", () => {
  it("reports nothing available rather than throwing", () => {
    // The probe runs at boot against whatever is on disk. A malformed or truncated IDL must produce
    // "no capabilities" — which vetoes both optional policies — rather than an exception the keeper
    // has no handler for yet.
    expect(programFeaturesOf({ instructions: [], types: [] } as unknown as Idl)).toEqual({
      authorityEarlyClose: false,
      houseTakeSweep: false,
      roundAccountClose: false,
    });
  });
});
