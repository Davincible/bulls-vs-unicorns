// THE SQL BOUNDARY, tested without Postgres.
//
// Two things happen in `pgStore.ts` that cannot be checked anywhere else and are expensive to get
// wrong:
//
//   1. EVERY VALUE IS A PARAMETER, never syntax. The tagged template is the only way to call the
//      query function, so this is structurally true — and these tests assert it rather than assume
//      it, because "structurally true" is a claim about code somebody may edit.
//   2. EVERY VALUE COMING BACK IS COERCED. A driver that returns `int8` as a string (which the Neon
//      HTTP driver does) or `bytea` as a hex blob must produce a loud failure at the seam and not a
//      `NaN` three layers away in a signature.
//
// The fake below records the statement fragments and the bound values, which is exactly the pair a
// real driver would receive.

import { describe, expect, it } from "vitest";
import { createPgStore, type SqlRow } from "./pgStore.ts";

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function fakeSql(rowsFor: (call: Call) => SqlRow[]) {
  const calls: Call[] = [];
  const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const call: Call = { sql: strings.join("$?"), values };
    calls.push(call);
    return Promise.resolve(rowsFor(call));
  };
  return { sql, calls };
}

const b64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

describe("findByWallets", () => {
  it("binds the whole wallet list as ONE parameter, never as text in the statement", () => {
    // Prevents a wallet becoming syntax. It also means one round trip for 64 wallets instead of 64.
    const { sql, calls } = fakeSql(() => []);
    return createPgStore(sql).findByWallets(["W1", "W2"]).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0].values).toEqual([["W1", "W2"]]);
      expect(calls[0].sql).not.toContain("W1");
      expect(calls[0].sql).toContain("= ANY(");
    });
  });

  it("puts NOT suppressed in the WHERE clause, so no handler can forget it", async () => {
    // §7.4. The store filters, not the caller — see `store.ts`. A test on the SQL text is the only
    // way to assert this without a database, and the rule is worth the brittleness.
    const { sql, calls } = fakeSql(() => []);
    await createPgStore(sql).findByWallets(["W1"]);
    expect(calls[0].sql).toContain("NOT suppressed");
  });

  it("coerces an epoch that arrives as a string, and a null avatar_hash", async () => {
    // The Neon HTTP driver returns `bigint` as a string. Left uncoerced this becomes a string in
    // `linkedAt`, goes through `String()` in `canonicalBytes` unchanged, and silently produces a
    // signature the client cannot reproduce — the invisible failure again.
    const { sql } = fakeSql(() => [
      {
        x_id: "1",
        wallet: "W1",
        handle: "alice",
        display_name: "",
        avatar_hash: null,
        linked_at: "1700000000",
      },
    ]);
    const rows = await createPgStore(sql).findByWallets(["W1"]);
    expect(rows).toEqual([
      { xId: "1", wallet: "W1", handle: "alice", displayName: "", avatarHash: null, linkedAt: 1_700_000_000 },
    ]);
  });

  it("throws at the seam when a column is not the type it must be", async () => {
    // Loud here, or a `NaN` three layers away. `linked_at` goes into the signed payload.
    const { sql } = fakeSql(() => [{ x_id: "1", wallet: "W1", handle: "a", display_name: "", avatar_hash: null, linked_at: null }]);
    await expect(createPgStore(sql).findByWallets(["W1"])).rejects.toThrow(/linked_at/);
  });
});

describe("findAvatar", () => {
  it("puts the hash AND the suppression check in the WHERE clause", async () => {
    // So that "wrong hash" and "no such account" are one code path and cannot drift apart into two
    // answers a caller could distinguish.
    const { sql, calls } = fakeSql(() => []);
    const got = await createPgStore(sql).findAvatar("1", "abc");
    expect(got).toBeNull();
    expect(calls[0].values).toEqual(["1", "abc"]);
    expect(calls[0].sql).toContain("NOT suppressed");
    expect(calls[0].sql).toContain("avatar_hash =");
  });

  it("decodes bytea through base64 rather than trusting the driver's representation", async () => {
    // `encode(...,'base64')` in SQL is the same under every driver. Left to the client it is a hex
    // string on one and a Buffer on another, and the difference is a corrupt image.
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 8, 7, 6, 0x57, 0x45, 0x42, 0x50]);
    const { sql } = fakeSql(() => [{ avatar_b64: b64(bytes) }]);
    const got = await createPgStore(sql).findAvatar("1", "abc");
    expect(got?.bytes).toEqual(bytes);
  });
});

describe("putAvatar", () => {
  it("is an UPDATE, never an upsert", async () => {
    // An ingest that can create a row is an ingest that can create a LINK, and the only thing
    // allowed to do that is the ceremony where a wallet signature proves the other half.
    const { sql, calls } = fakeSql(() => [{ x_id: "1" }]);
    const ok = await createPgStore(sql).putAvatar("1", "hh", new Uint8Array([1, 2, 3]), 1234);
    expect(ok).toBe(true);
    expect(calls[0].sql).toContain("UPDATE x_link");
    expect(calls[0].sql).not.toContain("INSERT");
    expect(calls[0].sql).not.toContain("CONFLICT");
  });

  it("writes hash, bytes and timestamp in ONE statement", async () => {
    // A hash with no bytes is a URL `/api/links` advertises and the proxy 404s on — a hole on the
    // leaderboard produced by a half-written row. The table's own CHECK is the other half of this.
    const { sql, calls } = fakeSql(() => [{ x_id: "1" }]);
    await createPgStore(sql).putAvatar("1", "hh", new Uint8Array([1, 2, 3]), 1234);
    expect(calls).toHaveLength(1);
    // The bound values are, in order: the hash, the bytes as base64, the timestamp, and the x_id
    // from the WHERE clause. Four parameters, one statement, no string interpolation anywhere.
    expect(calls[0].values).toEqual(["hh", b64(new Uint8Array([1, 2, 3])), 1234, "1"]);
  });

  it("reports false for an x_id that does not exist", async () => {
    const { sql } = fakeSql(() => []);
    expect(await createPgStore(sql).putAvatar("nope", "hh", new Uint8Array([1]), 1)).toBe(false);
  });
});

describe("setSuppressed", () => {
  it("distinguishes 'no such x_id' from 'done'", async () => {
    // An operator typing an id wrong during an incident must not be told it worked.
    const missing = fakeSql(() => []);
    expect(await createPgStore(missing.sql).setSuppressed("nope", true)).toBe(false);

    const present = fakeSql(() => [{ x_id: "1" }]);
    expect(await createPgStore(present.sql).setSuppressed("1", true)).toBe(true);
    expect(present.calls[0].values).toEqual([true, "1"]);
  });
});
