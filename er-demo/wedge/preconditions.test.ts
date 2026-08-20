// THE STALENESS GATE, TESTED IN THE SUITE THAT RUNS ON EVERY COMMIT.
//
// `wedge/localhost.test.ts`'s header makes the general argument for why a guard belongs in `npm
// test` even when the thing it guards does not. This file is the sharper case. `assertProgramIsFresh`
// is the check that stands between `npm run test:wedge` and a run that deploys week-old bytecode,
// asserts what it does, and reports the result as today's measurement — and "a gate that silently
// switched itself off" is a failure this repo has already paid for once (`tsconfig.json`'s header:
// `npx tsc --noEmit` reported clean, three times, over a tree it had never read).
//
// A staleness gate that is itself only reachable by the slow suite is the same shape of mistake one
// level up. These four tests are the whole branch set, they need no toolchain, and they run in
// milliseconds.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProgramIsFresh, MissingPrecondition } from "./preconditions.ts";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "wedge-preconditions-"));
  dirs.push(dir);
  return dir;
}

/** An ELF-shaped file — the four magic bytes are all `assertProgramIsFresh` inspects, deliberately:
 *  it is checking that a build produced an object at all, not validating an ELF. */
function writeElf(path: string, mtimeSeconds: number): void {
  writeFileSync(path, Buffer.concat([Buffer.from("\x7fELF", "latin1"), Buffer.alloc(64)]));
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

function writeSource(path: string, mtimeSeconds: number): void {
  writeFileSync(path, "// pretend this is lib.rs\n");
  utimesSync(path, mtimeSeconds, mtimeSeconds);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("wedge/preconditions — assertProgramIsFresh", () => {
  it("accepts a program built AFTER its source", () => {
    const dir = scratch();
    const so = join(dir, "bulls_arena.so");
    const src = join(dir, "lib.rs");
    writeSource(src, 1_000_000);
    writeElf(so, 1_000_060); // one minute later
    expect(() => assertProgramIsFresh(so, src)).not.toThrow();
  });

  it("accepts a program built at the same instant as its source", () => {
    // Equal mtimes are the boundary, and they must pass: a build that finishes inside the
    // filesystem's timestamp granularity is a fresh build, not a stale one. Rejecting here would
    // make the gate fire at random on fast machines, and a gate that fires at random is a gate
    // someone turns off.
    const dir = scratch();
    const so = join(dir, "bulls_arena.so");
    const src = join(dir, "lib.rs");
    writeSource(src, 1_000_000);
    writeElf(so, 1_000_000);
    expect(() => assertProgramIsFresh(so, src)).not.toThrow();
  });

  it("REFUSES a program older than its source, and says how far behind", () => {
    const dir = scratch();
    const so = join(dir, "bulls_arena.so");
    const src = join(dir, "lib.rs");
    writeElf(so, 1_000_000);
    writeSource(src, 1_000_600); // source edited ten minutes after the build
    expect(() => assertProgramIsFresh(so, src)).toThrow(MissingPrecondition);
    expect(() => assertProgramIsFresh(so, src)).toThrow(/STALE — it is 10\.0 minutes older/);
    expect(() => assertProgramIsFresh(so, src)).toThrow(/anchor build/);
  });

  it("REFUSES a missing program", () => {
    const dir = scratch();
    const src = join(dir, "lib.rs");
    writeSource(src, 1_000_000);
    expect(() => assertProgramIsFresh(join(dir, "nope.so"), src)).toThrow(MissingPrecondition);
    expect(() => assertProgramIsFresh(join(dir, "nope.so"), src)).toThrow(/does not exist/);
  });

  it("REFUSES a truncated or non-ELF program even when its timestamp is fresh", () => {
    // The case a pure mtime check cannot see: a build that died part-way leaves a file that is newer
    // than the source and is not a program. Without this the failure surfaces sixty seconds later as
    // an opaque genesis error from solana-test-validator.
    const dir = scratch();
    const so = join(dir, "bulls_arena.so");
    const src = join(dir, "lib.rs");
    writeSource(src, 1_000_000);
    writeFileSync(so, Buffer.from([0x00, 0x01]));
    utimesSync(so, 1_000_060, 1_000_060);
    expect(() => assertProgramIsFresh(so, src)).toThrow(/not an ELF object/);
  });

  it("REFUSES an empty program file", () => {
    const dir = scratch();
    const so = join(dir, "bulls_arena.so");
    const src = join(dir, "lib.rs");
    writeSource(src, 1_000_000);
    writeFileSync(so, "");
    utimesSync(so, 1_000_060, 1_000_060);
    expect(() => assertProgramIsFresh(so, src)).toThrow(/not an ELF object/);
  });

  it("checks the program even when the source file is absent", () => {
    // The source is optional — someone may run this against a checkout without `programs/` — but a
    // missing source must not make the ELF check optional too. The freshness half is skipped; the
    // "is this even a program" half is not.
    const dir = scratch();
    const so = join(dir, "bulls_arena.so");
    writeFileSync(so, Buffer.from([0x00]));
    expect(() => assertProgramIsFresh(so, join(dir, "absent.rs"))).toThrow(/not an ELF object/);

    writeElf(so, 1_000_000);
    expect(() => assertProgramIsFresh(so, join(dir, "absent.rs"))).not.toThrow();
  });
});
