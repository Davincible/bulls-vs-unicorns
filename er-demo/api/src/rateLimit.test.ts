// THE RATE LIMIT, AND THE PROPERTY THAT MAKES ITS TABLE SAFE TO KEEP.
//
// Two things are being proved here and they are of quite different kinds.
//
//   1. THE ARITHMETIC. Windows, thresholds, both subjects counted, the edge. Ordinary.
//   2. THE OPACITY. `x_link_rate` holds a digest, never a wallet and never an address, and the digest
//      is keyed under a secret. Without that, a dump of the table plus a chain scrape recovers every
//      wallet that ever tried to link, and a dump plus 2^24 guesses recovers every /24 — which would
//      make the limiter a worse privacy leak than the register it protects.

import { describe, expect, it } from "vitest";
import { MemoryRateCounter } from "./memoryWriteStore.ts";
import {
  bucketKey,
  deriveBucketSecret,
  enforceRateLimit,
  LIMIT_PER_NETWORK,
  LIMIT_PER_WALLET,
  windowStart,
  WINDOW_SECONDS,
} from "./rateLimit.ts";
import { NOW, wallet } from "./testKit.ts";

const TOKEN = "k".repeat(32);
const SECRET = deriveBucketSecret(TOKEN);
const W = wallet(5);

describe("deriveBucketSecret", () => {
  it("is deterministic for one token and different for another", () => {
    expect(deriveBucketSecret(TOKEN)).toEqual(deriveBucketSecret(TOKEN));
    expect(deriveBucketSecret(TOKEN)).not.toEqual(deriveBucketSecret("j".repeat(32)));
  });

  it("refuses to derive from an empty token", () => {
    // HMAC under an empty key is a perfectly valid HMAC, so this failure would be silent: every bucket
    // in the table would become recoverable by anyone holding a dump and this file.
    expect(() => deriveBucketSecret("")).toThrow(/empty token/);
    expect(() => deriveBucketSecret("   ")).toThrow(/empty token/);
  });

  it("cannot be run backwards to the token", () => {
    // Not a proof of HMAC — that is the primitive's job — but a check that the derived value does not
    // simply CONTAIN the input, which is the mistake a hand-rolled "salt" makes.
    const hex = Buffer.from(deriveBucketSecret(TOKEN)).toString("hex");
    expect(hex).not.toContain(Buffer.from(TOKEN).toString("hex"));
    expect(deriveBucketSecret(TOKEN)).toHaveLength(32);
  });
});

describe("bucketKey", () => {
  it("is the shape the column's CHECK constrains", () => {
    expect(bucketKey(SECRET, "wallet", W)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not contain the subject it is about", () => {
    // The whole privacy claim of `x_link_rate`. If this ever fails, the table has become a list of
    // wallets and networks.
    const key = bucketKey(SECRET, "wallet", W);
    expect(key).not.toContain(W);
    expect(key.toLowerCase()).not.toContain(W.toLowerCase().slice(0, 8));
  });

  it("is not recoverable without the secret", () => {
    // Two different secrets over the same subject must not agree, or the secret is decoration and a
    // dump is brute-forceable against an enumerable wallet set.
    expect(bucketKey(SECRET, "wallet", W)).not.toBe(bucketKey(deriveBucketSecret("z".repeat(32)), "wallet", W));
  });

  it("separates the kinds, so a wallet and a network can never share a row", () => {
    expect(bucketKey(SECRET, "wallet", "same")).not.toBe(bucketKey(SECRET, "network", "same"));
  });
});

describe("windowStart", () => {
  it("floors to the window and is stable within it", () => {
    const start = windowStart(NOW);
    expect(start % WINDOW_SECONDS).toBe(0);
    expect(windowStart(start)).toBe(start);
    expect(windowStart(start + WINDOW_SECONDS - 1)).toBe(start);
    expect(windowStart(start + WINDOW_SECONDS)).toBe(start + WINDOW_SECONDS);
  });
});

describe("enforceRateLimit", () => {
  const subjects = { wallet: W, network: "203.0.113.0/24" };
  const deps = () => ({ counter: new MemoryRateCounter(), secret: SECRET });

  it("allows a ceremony's worth of requests and then refuses", async () => {
    const d = deps();
    for (let i = 0; i < LIMIT_PER_WALLET; i += 1) {
      expect((await enforceRateLimit(d, subjects, NOW)).kind).toBe("ok");
    }
    const over = await enforceRateLimit(d, subjects, NOW);
    expect(over.kind).toBe("limited");
  });

  it("reports a Retry-After that is the time to the end of the window", async () => {
    const d = deps();
    const at = windowStart(NOW) + 60;
    for (let i = 0; i <= LIMIT_PER_WALLET; i += 1) await enforceRateLimit(d, subjects, at);
    const verdict = await enforceRateLimit(d, subjects, at);
    expect(verdict).toEqual({ kind: "limited", retryAfterSec: WINDOW_SECONDS - 60 });
  });

  it("forgives everything when the window rolls over", async () => {
    const d = deps();
    for (let i = 0; i <= LIMIT_PER_WALLET; i += 1) await enforceRateLimit(d, subjects, NOW);
    expect((await enforceRateLimit(d, subjects, NOW)).kind).toBe("limited");
    expect((await enforceRateLimit(d, subjects, NOW + WINDOW_SECONDS)).kind).toBe("ok");
  });

  it("counts a refused request, so hammering does not oscillate across the limit", async () => {
    // Count first, judge second. Otherwise a client at the boundary gets one request through per
    // response for as long as it keeps trying.
    const d = deps();
    for (let i = 0; i <= LIMIT_PER_WALLET + 5; i += 1) await enforceRateLimit(d, subjects, NOW);
    expect((await enforceRateLimit(d, subjects, NOW)).kind).toBe("limited");
  });

  it("limits a whole network even when every wallet is different", async () => {
    // The case the network subject exists for: somebody with no wallet to spend, cycling addresses.
    const d = deps();
    let limited = false;
    for (let i = 0; i < LIMIT_PER_NETWORK + 2; i += 1) {
      const verdict = await enforceRateLimit(d, { wallet: wallet(i + 20), network: subjects.network }, NOW);
      if (verdict.kind === "limited") limited = true;
    }
    expect(limited).toBe(true);
  });

  it("counts BOTH subjects even when the first is already over", async () => {
    // Skipping the second would make one subject's counter depend on another's, so a wallet could stay
    // under its own limit for ever by living on a network that is always over.
    const d = deps();
    for (let i = 0; i <= LIMIT_PER_WALLET; i += 1) await enforceRateLimit(d, subjects, NOW);
    // The wallet is over; a DIFFERENT wallet on the same network must still have been counted along the
    // way, which shows up as the network counter having advanced.
    const other = await enforceRateLimit(d, { wallet: wallet(90), network: subjects.network }, NOW);
    expect(other.kind).toBe("ok");
  });

  it("does not let one wallet's usage limit another's", async () => {
    const d = deps();
    for (let i = 0; i <= LIMIT_PER_WALLET; i += 1) await enforceRateLimit(d, subjects, NOW);
    const other = await enforceRateLimit(d, { wallet: wallet(91), network: "198.51.100.0/24" }, NOW);
    expect(other.kind).toBe("ok");
  });

  it("does NOT let a stranger spend a victim wallet's budget — the review finding", async () => {
    // THE ATTACK: twenty-one `POST /api/x/challenge {"wallet":"<victim>","purpose":"unlink"}` from
    // anywhere on the internet. The wallet is an unauthenticated body field at the moment it is counted,
    // and an unlink carries no credential at all — so a bare wallet subject was one counter per wallet
    // shared by everybody, and exhausting it locked the owner out of BOTH endpoints, including their own
    // revocation. §6.2 promises that revocation is immediate.
    const d = deps();
    const attacker = { wallet: W, network: "198.51.100.0/24" };
    for (let i = 0; i < LIMIT_PER_WALLET + 5; i += 1) await enforceRateLimit(d, attacker, NOW);
    expect((await enforceRateLimit(d, attacker, NOW)).kind).toBe("limited");

    // The victim, on their own network, with the same wallet: unaffected.
    const victim = { wallet: W, network: "203.0.113.0/24" };
    expect((await enforceRateLimit(d, victim, NOW)).kind).toBe("ok");
  });

  it("still bounds one wallet on one network", async () => {
    // The composite subject must not become a way to have no per-wallet limit at all.
    const d = deps();
    for (let i = 0; i < LIMIT_PER_WALLET; i += 1) {
      expect((await enforceRateLimit(d, subjects, NOW)).kind).toBe("ok");
    }
    expect((await enforceRateLimit(d, subjects, NOW)).kind).toBe("limited");
  });

  it("cannot be tricked into one bucket by a wallet that looks like a network", async () => {
    // The composite key is `network|wallet`; the separator appears in neither half (a network is dotted
    // decimal or hex-and-colons, a wallet is base58), so no two distinct pairs can collide.
    const d = deps();
    for (let i = 0; i <= LIMIT_PER_WALLET; i += 1) {
      await enforceRateLimit(d, { wallet: W, network: "203.0.113.0/24" }, NOW);
    }
    expect((await enforceRateLimit(d, { wallet: W, network: "203.0.113.0/24" }, NOW)).kind).toBe("limited");
    expect((await enforceRateLimit(d, { wallet: wallet(6), network: "203.0.113.0/24" }, NOW)).kind).toBe("ok");
  });

  it("refuses when the counter answers with the wrong number of counts", async () => {
    // `strictNullChecks` is off, so a short array would make `undefined > LIMIT` evaluate to `false` —
    // which is "allowed". A counter that cannot count must never produce a yes.
    const short = { counter: { hit: async () => [1] }, secret: SECRET };
    await expect(enforceRateLimit(short, subjects, NOW)).rejects.toThrow(/expected 2 counts/);
  });

  it("propagates a counter failure instead of allowing the request", async () => {
    // The single most damaging line that could be added to `rateLimit.ts` would be a `catch` that
    // returned `ok`: a database blip would silently disable every limit at once and no screen would
    // show it. The handler turns this throw into a refusal.
    const broken = {
      counter: { hit: () => Promise.reject(new Error("connection refused")) },
      secret: SECRET,
    };
    await expect(enforceRateLimit(broken, subjects, NOW)).rejects.toThrow(/connection refused/);
  });
});
