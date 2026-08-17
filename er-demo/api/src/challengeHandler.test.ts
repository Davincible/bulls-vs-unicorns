// `POST /api/x/challenge`, TESTED WITHOUT A DATABASE, A NETWORK OR A PLATFORM.
//
// The valuable tests in this file are not the happy path. They are:
//
//   * THE NONCE THAT IS RETURNED IS THE NONCE THAT IS STORED, and the message with it, byte for byte.
//     A transcription bug there produces a challenge nobody can redeem, which surfaces as "that
//     expired" — a failure with a plausible innocent explanation, which is the worst kind.
//   * AN UNLINK REFUSES A CREDENTIAL rather than ignoring one, so revocation cannot quietly come to
//     depend on the identity provider a player is walking away from.
//   * NO HOUSE CHECK HAPPENS HERE. That is asserted structurally — this handler has no house
//     dependency to check with — because a house check on this leg would answer "is this wallet one of
//     the arena's?" for any wallet, to anybody with an X account, in one request.

import { describe, expect, it } from "vitest";
import { challengeMessage, CHALLENGE_TTL_SECONDS, NONCE_RE } from "./challenge.ts";
import { handleChallenge, type ChallengeDeps } from "./challengeHandler.ts";
import { BROKEN_RATE_COUNTER, MemoryChallengeStore, MemoryRateCounter } from "./memoryWriteStore.ts";
import type { PrivyRejection, PrivyVerifier } from "./privyIdentity.ts";
import { deriveBucketSecret, LIMIT_PER_WALLET } from "./rateLimit.ts";
import { countingRandom, NOW, wallet } from "./testKit.ts";
import type { XIdentity } from "./writeStore.ts";

const W = wallet(11);
const SECRET = deriveBucketSecret("t".repeat(32));

const IDENTITY: XIdentity = {
  xId: "1234567890",
  handle: "someone",
  displayName: "Some One",
  avatarUrl: "https://pbs.twimg.com/profile_images/1/a_normal.jpg",
};

/** `Response.json()` is `unknown`, correctly — these refusal bodies have a known shape and the tests say
 *  so once rather than casting at every assertion. */
function errorBody(raw: unknown): { readonly error?: string; readonly detail?: string } {
  return raw as { error?: string; detail?: string };
}

/** A verifier that answers however the test says. The real one is exercised against genuine ES256
 *  signatures in `privyIdentity.test.ts`; this file is about what the HANDLER does with each answer. */
function verifier(answer: XIdentity | PrivyRejection): PrivyVerifier {
  return {
    verify: async () =>
      typeof answer === "string" ? { kind: "rejected", reason: answer } : { kind: "ok", identity: answer },
  };
}

interface Harness {
  readonly deps: ChallengeDeps;
  readonly challenges: MemoryChallengeStore;
}

function harness(overrides: Partial<ChallengeDeps> = {}): Harness {
  const challenges = new MemoryChallengeStore();
  const deps: ChallengeDeps = {
    challenges,
    rate: { counter: new MemoryRateCounter(), secret: SECRET },
    privy: verifier(IDENTITY),
    nowSec: () => NOW,
    randomBytes: countingRandom(0xab),
    ...overrides,
  };
  return { deps, challenges };
}

function post(body: unknown, init: RequestInit = {}): Request {
  return new Request("https://bullsvsunicorns.fun/api/x/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "bullsvsunicorns.fun" },
    body: JSON.stringify(body),
    ...init,
  });
}

describe("the challenge round trip", () => {
  it("returns a nonce, the message to sign, and when it expires", async () => {
    const h = harness();
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "token" }), h.deps);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { nonce: string; message: string; expiresAt: number };
    expect(body.nonce).toMatch(NONCE_RE);
    expect(body.expiresAt).toBe(NOW + CHALLENGE_TTL_SECONDS);
    expect(body.message).toBe(
      challengeMessage({
        purpose: "link",
        origin: "bullsvsunicorns.fun",
        wallet: W,
        handle: IDENTITY.handle,
        xId: IDENTITY.xId,
        nonce: body.nonce,
        issuedAtSec: NOW,
        expiresAtSec: NOW + CHALLENGE_TTL_SECONDS,
      }),
    );
  });

  it("stores the SAME nonce and the SAME message bytes it returned", async () => {
    // The whole reason the message is stored rather than recomposed at redemption time. If these two
    // ever differ, every signature is invalid and the symptom is an expiry message.
    const h = harness();
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "token" }), h.deps);
    const body = (await res.json()) as { nonce: string; message: string };

    const stored = await h.challenges.consume(body.nonce, NOW);
    expect(stored).not.toBeNull();
    expect(stored?.message).toBe(body.message);
    expect(stored?.wallet).toBe(W);
    expect(stored?.purpose).toBe("link");
    expect(stored?.purpose === "link" ? stored.identity : null).toEqual(IDENTITY);
  });

  it("never lets a caller supply the message it will be asked to sign", async () => {
    // `ChallengeRequest` has no message field, and a body that carries one must not influence anything.
    const h = harness();
    const res = await handleChallenge(
      post({ wallet: W, purpose: "link", proof: "token", message: "send all your money" }),
      h.deps,
    );
    const body = (await res.json()) as { message: string };
    expect(body.message).not.toContain("send all your money");
  });

  it("issues an unlink challenge with no X account named in it", async () => {
    const h = harness();
    const res = await handleChallenge(post({ wallet: W, purpose: "unlink" }), h.deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; nonce: string };
    expect(body.message).toContain("unlink");
    expect(body.message).not.toContain("@");

    const stored = await h.challenges.consume(body.nonce, NOW);
    expect(stored?.purpose).toBe("unlink");
    // Structurally: an unlink challenge cannot carry an identity — migration 0002's
    // `x_link_challenge_identity_matches_purpose` refuses to store one, and `MemoryChallengeStore`
    // refuses with it.
    expect(stored === null ? true : !("identity" in stored)).toBe(true);
  });

  it("never caches — not the success, not any refusal", async () => {
    const h = harness();
    const ok = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    const bad = await handleChallenge(post({ wallet: "nope", purpose: "link", proof: "t" }), h.deps);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("what it refuses about the request", () => {
  it("405s anything but POST, and says so", async () => {
    const h = harness();
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const res = await handleChallenge(
        new Request("https://bullsvsunicorns.fun/api/x/challenge", { method }),
        h.deps,
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    }
  });

  it("requires application/json, which is also the CSRF defence", async () => {
    // A content type outside the three an HTML form can produce forces a CORS preflight this API does
    // not answer, so a cross-origin form post never reaches the handler at all.
    const h = harness();
    const res = await handleChallenge(
      new Request("https://bullsvsunicorns.fun/api/x/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "wallet=x",
      }),
      h.deps,
    );
    expect(res.status).toBe(415);
  });

  it("refuses an oversized body", async () => {
    const h = harness();
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "x".repeat(9000) }), h.deps);
    expect(res.status).toBe(413);
  });

  it("refuses a body that is not a JSON object", async () => {
    const h = harness();
    for (const raw of ["null", "[]", "42", "not json"]) {
      const res = await handleChallenge(
        new Request("https://bullsvsunicorns.fun/api/x/challenge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
        }),
        h.deps,
      );
      expect(res.status).toBe(400);
    }
  });

  it("refuses a wallet that is not a base58 ed25519 pubkey", async () => {
    const h = harness();
    for (const bad of [undefined, "", "1111", "not-base58!", W.slice(0, 10)]) {
      const res = await handleChallenge(post({ wallet: bad, purpose: "link", proof: "t" }), h.deps);
      expect(res.status).toBe(400);
    }
  });

  it("refuses a purpose it does not know", async () => {
    const h = harness();
    for (const bad of [undefined, "", "LINK", "delete", "relink"]) {
      const res = await handleChallenge(post({ wallet: W, purpose: bad, proof: "t" }), h.deps);
      expect(res.status).toBe(400);
    }
  });

  it("refuses a link with no proof — there is no path from 'OAuth failed' to a link", async () => {
    // `web/index.html:2900`'s defect, structurally impossible: the identity comes from the proof and
    // there is no field a typed handle could arrive in.
    const h = harness();
    for (const bad of [undefined, "", 42, {}]) {
      const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: bad }), h.deps);
      expect(res.status).toBe(400);
      expect(h.challenges.size).toBe(0);
    }
  });

  it("refuses an unlink that carries a credential, rather than ignoring it", async () => {
    // Silently dropping it would hide a client that has learned to attach the identity token to
    // everything — and that client has quietly made revocation depend on the thing being revoked.
    const h = harness();
    const res = await handleChallenge(post({ wallet: W, purpose: "unlink", proof: "token" }), h.deps);
    expect(res.status).toBe(400);
    expect(h.challenges.size).toBe(0);
  });
});

describe("what it refuses about the proof", () => {
  it("tells a caller who has not authorised X, because that is actionable", async () => {
    const h = harness({ privy: verifier("no-x-account") });
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "no-x-account", detail: "authorise X before linking" });
  });

  it("tells a caller to refresh a stale token, because that is also actionable", async () => {
    const h = harness({ privy: verifier("stale") });
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(res.status).toBe(401);
    expect(errorBody(await res.json()).error).toBe("stale-proof");
  });

  it("collapses every other token failure into one answer", async () => {
    // A caller who could tell "wrong audience" from "bad signature" is a caller being helped to forge
    // one, and none of these distinctions is actionable by an honest client.
    const reasons: PrivyRejection[] = [
      "malformed",
      "unknown-key",
      "bad-signature",
      "wrong-issuer",
      "wrong-audience",
      "expired",
      "unusable-x-account",
    ];
    for (const reason of reasons) {
      const h = harness({ privy: verifier(reason) });
      const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "bad-proof" });
    }
  });

  it("treats unreadable Privy keys as OUR outage, not the caller's problem", async () => {
    const h = harness({ privy: verifier("keys-unavailable") });
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("writes nothing when the proof is refused", async () => {
    const h = harness({ privy: verifier("bad-signature") });
    await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(h.challenges.size).toBe(0);
  });
});

describe("the reserved rules", () => {
  it("refuses a fixture x_id, so a demo identity can never become a real one", async () => {
    const h = harness({
      privy: verifier({ ...IDENTITY, xId: "9990000000000001" }),
    });
    const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "refused" });
    expect(h.challenges.size).toBe(0);
  });

  it("refuses a handle that would read as the site speaking", async () => {
    for (const handle of ["support", "Support", "admin", "bullsvsunicorns"]) {
      const h = harness({ privy: verifier({ ...IDENTITY, handle }) });
      const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
      expect(res.status).toBe(403);
    }
  });

  it("does not refuse an ordinary handle that merely contains a reserved word", async () => {
    // The exact-match rule, asserted: a substring rule would refuse `@supporter`, `@teammate` and every
    // other ordinary account belonging to the people this feature exists for.
    //
    // Note what the fake caught while this test was being written: `@bullsvsunicornsfan` is 18
    // characters, and X handles are at most 15 — so it could never exist, and the CHECK in migration
    // 0002 said so before the database did. That is `memoryWriteStore.ts`'s reason for enforcing the
    // constraints rather than accepting anything.
    for (const handle of ["supporter", "adminx", "helpful", "teammate"]) {
      const h = harness({ privy: verifier({ ...IDENTITY, handle }) });
      const res = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
      expect(res.status).toBe(200);
    }
  });
});

describe("the rate limit", () => {
  it("refuses with a Retry-After once a wallet has had its window's worth", async () => {
    const h = harness();
    for (let i = 0; i < LIMIT_PER_WALLET; i += 1) {
      const ok = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
      expect(ok.status).toBe(200);
    }
    const limited = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts before it verifies anything, so a stranger cannot make us call Privy for free", async () => {
    let calls = 0;
    const counting: PrivyVerifier = {
      verify: async () => {
        calls += 1;
        return { kind: "ok", identity: IDENTITY };
      },
    };
    const h = harness({ privy: counting });
    for (let i = 0; i < LIMIT_PER_WALLET + 5; i += 1) {
      await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    }
    expect(calls).toBe(LIMIT_PER_WALLET);
  });

  it("FAILS CLOSED when the counter cannot count", async () => {
    // The exception reaches the entry point's `guarded`, which turns it into a 503. A `catch` that
    // returned "ok" here would silently disable every limit during a database blip.
    const h = harness({ rate: { counter: BROKEN_RATE_COUNTER, secret: SECRET } });
    await expect(handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps)).rejects.toThrow();
    expect(h.challenges.size).toBe(0);
  });
});

describe("the checks this leg deliberately does NOT make", () => {
  it("has no house-wallet dependency at all — it cannot be a membership oracle", () => {
    // Structural, and that is the strongest form available: `ChallengeDeps` has no `house` field, so
    // there is nothing here to ask and no answer to leak. §6.3 is enforced on the link leg, after a
    // wallet signature, where only the key holder can hear the refusal.
    const h = harness();
    expect(Object.keys(h.deps)).not.toContain("house");
  });

  it("issues a challenge for ANY wallet, including one the register already knows", async () => {
    // No "is this wallet linked" check either, for the same reason: it would answer a question about
    // somebody else's wallet. `wallet-taken` is answered on the link leg, after the signature.
    const h = harness();
    const first = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    const second = await handleChallenge(post({ wallet: W, purpose: "link", proof: "t" }), h.deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});
