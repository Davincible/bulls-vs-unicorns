// Loads the bulls-arena IDL (public/idl/bulls_arena.json, a byte-identical copy of
// programs/bulls-arena/idl/bulls_arena.json — the proven, security-reviewed program's own IDL,
// source of truth for every camelCased account/method name Anchor exposes at runtime).
//
// Two load paths, because this module has two real callers:
//   - The browser app (anything under src/, bundled by Vite): `public/` is copied verbatim to the
//     served/built root and is intentionally OUTSIDE Vite's module graph
//     (https://vite.dev/guide/assets.html#the-public-directory) — the correct way to reach it from
//     app code is a runtime fetch of the absolute path, which behaves identically under `vite dev`,
//     `vite preview`, and the production build.
//   - Node/Bun scripts under scripts/ (e.g. the Phase 1 verification script) import this same
//     module directly, with no Vite dev server to fetch from — they read the file straight off
//     disk instead. Both paths return the exact same parsed JSON; this file just picks whichever
//     retrieval mechanism its current environment actually has.
//
// Anchor camel-cases the raw (snake_case, Rust-shaped) IDL at `new Program(idl, provider)` time —
// every instruction name, every account key, every decoded account field comes back camelCased
// (`open_round` -> `openRound`, `fight_started_at` -> `fightStartedAt`). This is not documented
// anywhere in the IDL JSON itself; verified by constructing a throwaway Program against this exact
// file and printing `Object.keys(program.methods)` / `Object.keys(program.account)`.

import type { Idl } from "@coral-xyz/anchor";
import { PROGRAM_ID } from "./constants.ts";

let cached: Idl | null = null;

export async function loadIdl(): Promise<Idl> {
  if (cached) return cached;

  const idl: Idl = typeof window !== "undefined"
    ? await loadFromServer()
    : await loadFromDisk();

  if (idl.address !== PROGRAM_ID.toBase58()) {
    throw new Error(
      `IDL address mismatch: public/idl/bulls_arena.json declares ${idl.address}, ` +
      `but chain/constants.ts's PROGRAM_ID is ${PROGRAM_ID.toBase58()}. The copied IDL has drifted ` +
      `from the deployed program — re-copy from programs/bulls-arena/idl/bulls_arena.json.`,
    );
  }
  cached = idl;
  return idl;
}

async function loadFromServer(): Promise<Idl> {
  const res = await fetch("/idl/bulls_arena.json");
  if (!res.ok) throw new Error(`failed to load /idl/bulls_arena.json: ${res.status} ${res.statusText}`);
  return (await res.json()) as Idl;
}

async function loadFromDisk(): Promise<Idl> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "..", "public", "idl", "bulls_arena.json");
  return JSON.parse(readFileSync(path, "utf8")) as Idl;
}
