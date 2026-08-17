// THE WRITE PATH'S SQL BOUNDARY, tested without Postgres.
//
// `pgStore.test.ts`'s header applies unchanged, and there is a third claim on this side that only a
// test on the statement text can make:
//
//   1. EVERY VALUE IS A PARAMETER, never syntax.
//   2. EVERY VALUE COMING BACK IS COERCED, with a throw at the seam on anything unexpected.
//   3. EVERY OPERATION IS EXACTLY ONE STATEMENT. Single-use, expiry, both uniqueness directions and the
//      housekeeping sweep are all properties of individual statements — the Neon HTTP driver has no
//      session, so two calls are two transactions with a gap in the middle, and a rule enforced across
//      that gap is not enforced. Asserting `calls.length === 1` is how that stays true.
//
// These tests read SQL text, which is brittle. It is worth it: the alternative is finding out that
// `expires_at` moved out of the WHERE clause when somebody redeems a week-old challenge.

import { describe, expect, it } from "vitest";
import type { SqlRow } from "./pgStore.ts";
import {
  createPgChallengeStore,
  createPgLinkWriter,
  createPgRateCounter,
  createPgWriteStore,
} from "./pgWriteStore.ts";
import { NOW, wallet } from "./testKit.ts";
import type { LinkChallenge, XIdentity } from "./writeStore.ts";

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function fakeSql(rowsFor: (call: Call) => SqlRow[] = () => []) {
  const calls: Call[] = [];
  const sql = (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
    const call: Call = { sql: strings.join("$?"), values };
    calls.push(call);
    return Promise.resolve(rowsFor(call));
  };
  return { sql, calls };
}

const W = wallet(31);
const IDENTITY: XIdentity = {
  xId: "1234567890",
  handle: "someone",
  displayName: "Some One",
  avatarUrl: "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
};

const CHALLENGE: LinkChallenge = {
  purpose: "link",
  nonce: "a".repeat(64),
  wallet: W,
  message: "sign me",
  issuedAtSec: NOW,
  expiresAtSec: NOW + 300,
  identity: IDENTITY,
};

describe("put", () => {
  it("binds every value as a parameter, never as text in the statement", async () => {
    const { sql, calls } = fakeSql();
    await createPgChallengeStore(sql).put(CHALLENGE);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain(W);
    expect(calls[0].sql).not.toContain("sign me");
    expect(calls[0].values).toContain(W);
    expect(calls[0].values).toContain("sign me");
  });

  it("writes NULL identity columns for an unlink challenge", async () => {
    // `x_link_challenge_identity_matches_purpose` refuses anything else, and an unlink that carried an
    // identity would be a link that skipped the identity proof.
    const { sql, calls } = fakeSql();
    await createPgChallengeStore(sql).put({
      purpose: "unlink",
      nonce: "b".repeat(64),
      wallet: W,
      message: "unsign me",
      issuedAtSec: NOW,
      expiresAtSec: NOW + 300,
    });
    // x_id, handle, display_name, avatar_url — four nulls in the bound values.
    expect(calls[0].values.filter((v) => v === null)).toHaveLength(4);
  });

  it("sweeps stale RATE rows — the other table — in the same statement", async () => {
    // A sweep that has to be invoked is a sweep that stops being invoked. Folded into a CTE, it needs no
    // cron. It sweeps the other table for two reasons: a data-modifying CTE must not delete from the
    // table the main statement writes, and each sweep belongs behind the more frequent event (`hit`
    // sweeps challenges, because that runs on every request including refused ones).
    const { sql, calls } = fakeSql();
    await createPgChallengeStore(sql).put(CHALLENGE);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("DELETE FROM x_link_rate");
    expect(calls[0].sql).toContain("INSERT INTO x_link_challenge");
    // NOT the challenge table: that would be a CTE deleting from the statement's own target.
    expect(calls[0].sql).not.toContain("DELETE FROM x_link_challenge");
  });

  it("passes an injected clock, never the database's `now()`", async () => {
    // One instant governs a whole request, and a test can move it.
    const { sql, calls } = fakeSql();
    await createPgChallengeStore(sql).put(CHALLENGE);
    expect(calls[0].sql).toContain("to_timestamp(");
    expect(calls[0].values).toContain(NOW);
    expect(calls[0].values).toContain(NOW + 300);
  });
});

describe("consume", () => {
  it("is a DELETE ... RETURNING with the expiry in the same WHERE clause", async () => {
    // The single most important statement on the write path. Single-use comes from the DELETE; expiry
    // comes from the predicate beside it; neither can be checked without the other and neither can be
    // won twice.
    const { sql, calls } = fakeSql();
    await createPgChallengeStore(sql).consume("a".repeat(64), NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("DELETE FROM x_link_challenge");
    expect(calls[0].sql).toContain("WHERE nonce =");
    expect(calls[0].sql).toContain("expires_at > to_timestamp(");
    expect(calls[0].sql).toContain("RETURNING");
    expect(calls[0].values).toEqual(["a".repeat(64), NOW]);
  });

  it("returns null when nothing came back", async () => {
    const { sql } = fakeSql(() => []);
    expect(await createPgChallengeStore(sql).consume("a".repeat(64), NOW)).toBeNull();
  });

  it("rebuilds a link challenge, coercing an epoch that arrives as a string", async () => {
    // `extract(epoch …)::bigint` is a string over the HTTP driver and a number over the WebSocket one.
    const { sql } = fakeSql(() => [
      {
        nonce: "a".repeat(64),
        purpose: "link",
        wallet: W,
        x_id: "1234567890",
        handle: "someone",
        display_name: "Some One",
        avatar_url: "https://pbs.twimg.com/profile_images/1/a.jpg",
        message: "sign me",
        issued_at: String(NOW),
        expires_at: String(NOW + 300),
      },
    ]);
    const challenge = await createPgChallengeStore(sql).consume("a".repeat(64), NOW);
    expect(challenge).toEqual({
      purpose: "link",
      nonce: "a".repeat(64),
      wallet: W,
      message: "sign me",
      issuedAtSec: NOW,
      expiresAtSec: NOW + 300,
      identity: {
        xId: "1234567890",
        handle: "someone",
        displayName: "Some One",
        avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
      },
    });
  });

  it("rebuilds an unlink challenge with no identity attached", async () => {
    const { sql } = fakeSql(() => [
      {
        nonce: "b".repeat(64),
        purpose: "unlink",
        wallet: W,
        x_id: null,
        handle: null,
        display_name: null,
        avatar_url: null,
        message: "unsign me",
        issued_at: NOW,
        expires_at: NOW + 300,
      },
    ]);
    const challenge = await createPgChallengeStore(sql).consume("b".repeat(64), NOW);
    expect(challenge?.purpose).toBe("unlink");
    expect(challenge === null ? true : !("identity" in challenge)).toBe(true);
  });

  it("accepts a null avatar_url, which is what an account with no picture looks like", async () => {
    const { sql } = fakeSql(() => [
      {
        nonce: "c".repeat(64),
        purpose: "link",
        wallet: W,
        x_id: "1",
        handle: "h",
        display_name: "",
        avatar_url: null,
        message: "m",
        issued_at: NOW,
        expires_at: NOW + 1,
      },
    ]);
    const challenge = await createPgChallengeStore(sql).consume("c".repeat(64), NOW);
    expect(challenge?.purpose === "link" ? challenge.identity.avatarUrl : "wrong").toBeNull();
  });

  it("throws at the seam on a purpose the constraint should have prevented", async () => {
    // Unreachable through the database. A silent `null` would present a new ceremony's rows to every
    // player as "your challenge expired".
    const { sql } = fakeSql(() => [
      { nonce: "d".repeat(64), purpose: "relink", wallet: W, message: "m", issued_at: NOW, expires_at: NOW + 1 },
    ]);
    await expect(createPgChallengeStore(sql).consume("d".repeat(64), NOW)).rejects.toThrow(/unknown purpose/);
  });

  it("throws at the seam when a column is not the type it must be", async () => {
    const { sql } = fakeSql(() => [
      { nonce: 12345, purpose: "unlink", wallet: W, message: "m", issued_at: NOW, expires_at: NOW + 1 },
    ]);
    await expect(createPgChallengeStore(sql).consume("x", NOW)).rejects.toThrow(/expected string/);
  });
});

describe("link", () => {
  it("enforces both uniqueness directions in ONE statement", async () => {
    const { sql, calls } = fakeSql(() => [{ x_id: IDENTITY.xId }]);
    await createPgLinkWriter(sql).link(W, IDENTITY, NOW);
    expect(calls).toHaveLength(1);
    // The wallet direction: a guard that yields no row to insert.
    expect(calls[0].sql).toContain("WHERE NOT EXISTS");
    expect(calls[0].sql).toContain("x_id <>");
    // The x_id direction: an update in place, so W1's row becomes W2's row with no window between.
    expect(calls[0].sql).toContain("ON CONFLICT (x_id) DO UPDATE");
  });

  it("never touches `suppressed` on the update path", async () => {
    // The kill switch must survive a relink of an existing row. (The INSERT path inherits it from
    // migration 0003's table instead of defaulting it — see the test below.)
    const { sql, calls } = fakeSql(() => [{ x_id: IDENTITY.xId }]);
    await createPgLinkWriter(sql).link(W, IDENTITY, NOW);
    const update = calls[0].sql.slice(calls[0].sql.indexOf("DO UPDATE"));
    expect(update).not.toContain("suppressed");
  });

  it("moves `linked_at` only when the wallet changes", async () => {
    const { sql, calls } = fakeSql(() => [{ x_id: IDENTITY.xId }]);
    await createPgLinkWriter(sql).link(W, IDENTITY, NOW);
    expect(calls[0].sql).toContain("CASE WHEN x_link.wallet = EXCLUDED.wallet");
  });

  it("INHERITS the kill switch on insert rather than defaulting it to false", async () => {
    // The fix for the suppress -> unlink -> relink bypass: a fresh INSERT would otherwise take the
    // column's `DEFAULT FALSE`. Migration 0003's table is keyed on the x_id and outlives the row.
    const { sql, calls } = fakeSql(() => [{ x_id: IDENTITY.xId }]);
    await createPgLinkWriter(sql).link(W, IDENTITY, NOW);
    expect(calls[0].sql).toContain("suppressed");
    expect(calls[0].sql).toContain("EXISTS (SELECT 1 FROM x_link_suppressed");
  });

  it("clears the avatar columns TOGETHER when the upstream picture is gone", async () => {
    // A row advertising `avatar_hash` with no `avatar_url` can never be re-ingested, so the old face
    // would be served for ever. All three move together, as `x_link_avatar_all_or_nothing` requires.
    const { sql, calls } = fakeSql(() => [{ x_id: IDENTITY.xId }]);
    await createPgLinkWriter(sql).link(W, { ...IDENTITY, avatarUrl: null }, NOW);
    // Whitespace-insensitive: the statement is laid out for a reader, and a test that pins its
    // indentation fails on a reformat rather than on a behaviour change.
    const update = calls[0].sql.slice(calls[0].sql.indexOf("DO UPDATE")).replace(/\s+/g, " ");
    for (const col of ["avatar_hash", "avatar_bytes", "avatar_at"]) {
      expect(update).toContain(`${col} = CASE WHEN EXCLUDED.avatar_url IS NULL THEN NULL`);
    }
  });

  it("reports `wallet-taken` when the guard produced no row", async () => {
    const { sql } = fakeSql(() => []);
    expect(await createPgLinkWriter(sql).link(W, IDENTITY, NOW)).toEqual({ kind: "wallet-taken" });
  });

  it("binds a null avatar_url rather than omitting the column", async () => {
    const { sql, calls } = fakeSql(() => [{ x_id: "1" }]);
    await createPgLinkWriter(sql).link(W, { ...IDENTITY, avatarUrl: null }, NOW);
    expect(calls[0].values).toContain(null);
    expect(calls[0].sql).toContain("avatar_url");
  });

  it("passes every value as a parameter", async () => {
    const { sql, calls } = fakeSql(() => [{ x_id: IDENTITY.xId }]);
    await createPgLinkWriter(sql).link(W, IDENTITY, NOW);
    expect(calls[0].sql).not.toContain(W);
    expect(calls[0].sql).not.toContain(IDENTITY.handle);
    expect(calls[0].values).toContain(IDENTITY.handle);
  });
});

describe("unlink", () => {
  it("is a DELETE keyed on the wallet, returning what went", async () => {
    const { sql, calls } = fakeSql(() => [{ x_id: "1234567890" }]);
    expect(await createPgLinkWriter(sql).unlink(W)).toBe("1234567890");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("DELETE FROM x_link");
    expect(calls[0].sql).toContain("WHERE wallet =");
    expect(calls[0].values).toEqual([W]);
  });

  it("does NOT exclude suppressed rows", async () => {
    // A player's revocation must work on a row an operator has already taken down: the two operations
    // answer to different people and neither may block the other.
    const { sql, calls } = fakeSql(() => [{ x_id: "1" }]);
    await createPgLinkWriter(sql).unlink(W);
    expect(calls[0].sql).not.toContain("suppressed");
  });

  it("reports null when the wallet had no link", async () => {
    const { sql } = fakeSql(() => []);
    expect(await createPgLinkWriter(sql).unlink(W)).toBeNull();
  });
});

describe("hit", () => {
  it("counts every bucket in ONE round trip", async () => {
    // Latency here is paid by a player standing in front of a wallet prompt, and a limiter that costs a
    // round trip per subject is a limiter somebody will be tempted to skip.
    // The bucket list is ONE bound value among several — the window instant is bound three times too —
    // so the fake finds the array rather than assuming a position.
    const { sql, calls } = fakeSql((call) => {
      const buckets = call.values.find((v) => Array.isArray(v)) as string[];
      return buckets.map((b, i) => ({ bucket: b, hits: i + 1 }));
    });
    const counts = await createPgRateCounter(sql).hit(["aa", "bb"], NOW);
    expect(calls).toHaveLength(1);
    expect(counts).toEqual([1, 2]);
    expect(calls[0].sql).toContain("unnest(");
  });

  it("sweeps expired CHALLENGES, on the one statement every write request runs", async () => {
    const { sql, calls } = fakeSql((call) =>
      (call.values.find((v) => Array.isArray(v)) as string[]).map((b) => ({ bucket: b, hits: 1 })),
    );
    await createPgRateCounter(sql).hit(["aa"], NOW);
    expect(calls[0].sql).toContain("DELETE FROM x_link_challenge WHERE expires_at <");
    expect(calls[0].sql).toContain("INSERT INTO x_link_rate");
    expect(calls[0].sql).not.toContain("DELETE FROM x_link_rate");
  });

  it("binds the whole bucket list as one parameter", async () => {
    const { sql, calls } = fakeSql((call) =>
      (call.values.find((v) => Array.isArray(v)) as string[]).map((b) => ({ bucket: b, hits: 1 })),
    );
    await createPgRateCounter(sql).hit(["aa", "bb"], NOW);
    expect(calls[0].values.filter((v) => Array.isArray(v))).toEqual([["aa", "bb"]]);
    expect(calls[0].sql).not.toContain("aa");
  });

  it("restores the caller's order, because RETURNING has none", async () => {
    // Getting this wrong compares a wallet's count against a network's limit — a bug that only shows up
    // as "the limit is three times too loose" and never as an error.
    const { sql } = fakeSql(() => [
      { bucket: "bb", hits: 9 },
      { bucket: "aa", hits: 2 },
    ]);
    expect(await createPgRateCounter(sql).hit(["aa", "bb"], NOW)).toEqual([2, 9]);
  });

  it("resets a stale window rather than incrementing it", async () => {
    const { sql, calls } = fakeSql(() => [{ bucket: "aa", hits: 1 }]);
    await createPgRateCounter(sql).hit(["aa"], NOW);
    expect(calls[0].sql).toContain("CASE WHEN x_link_rate.window_start = to_timestamp(");
    expect(calls[0].sql).toContain("ELSE 1 END");
  });

  it("throws rather than inventing a count for a bucket that did not come back", async () => {
    // A made-up number in a rate limiter is a rate limiter that is off.
    const { sql } = fakeSql(() => []);
    await expect(createPgRateCounter(sql).hit(["aa"], NOW)).rejects.toThrow(/no count returned/);
  });

  it("does no work at all for an empty list", async () => {
    const { sql, calls } = fakeSql();
    expect(await createPgRateCounter(sql).hit([], NOW)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("createPgWriteStore", () => {
  it("hands back all three seams from one sql function", async () => {
    const { sql } = fakeSql(() => []);
    const store = createPgWriteStore(sql);
    expect(typeof store.challenges.consume).toBe("function");
    expect(typeof store.links.unlink).toBe("function");
    expect(typeof store.rate.hit).toBe("function");
  });
});
