// THE CEREMONY, FROM THE PLAYER'S SIDE, WITH NO NETWORK AND NO WALLET.
//
// The valuable tests here are not "it works". They are:
//
//   * WHAT IS SIGNED IS EXACTLY WHAT THE SERVER SENT. Not re-encoded, not trimmed, not rebuilt.
//   * NO FAILURE PRODUCES AN IDENTITY. Every refusal returns a reason and nothing else — there is no
//     partial success to render, which is the property `web/index.html:2900` did not have.
//   * EVERY REASON HAS A SENTENCE, and every sentence has a reason. A mapping hole is a blank panel.
//   * A CLOSED POPUP IS NOT AN OUTAGE. "You cancelled" and "unavailable" are different events and a
//     player can tell, so we have to.

import { describe, expect, it, vi } from "vitest";
import { FAILURE_COPY } from "./xConsent.ts";
import {
  runLink,
  runUnlink,
  type CeremonyDeps,
  type CeremonyFailure,
  type LinkDeps,
} from "./xLinkCeremony.ts";

const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const MESSAGE = "bullsvsunicorns.fun wants to link your X account.\n\nWallet:  7xKX…\nNonce:   abc";
const NONCE = "a".repeat(64);
/** The byte the fake signer fills its signature with. Written as an escape rather than as the literal
 *  character: a raw 0x03 in a source file is invisible in every editor and survives a copy-paste as
 *  something else. */
const SIGNATURE_BYTE = "\u0003";

/** A signer that records what it was asked to sign, so a test can compare bytes rather than trust. */
function recordingSigner() {
  const signed: string[] = [];
  return {
    signed,
    signMessage: async (message: Uint8Array): Promise<Uint8Array> => {
      signed.push(new TextDecoder().decode(message));
      return new Uint8Array(64).fill(SIGNATURE_BYTE.charCodeAt(0));
    },
  };
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** A fetch that answers the two endpoints from a script and records every request. */
function fakeFetch(answers: {
  challenge?: () => Response;
  redeem?: () => Response;
}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    if (url.includes("challenge")) {
      return answers.challenge === undefined
        ? new Response(JSON.stringify({ message: MESSAGE, nonce: NONCE, expiresAt: 1 }), { status: 200 })
        : answers.challenge();
    }
    return answers.redeem === undefined ? new Response(JSON.stringify({ linked: true }), { status: 200 }) : answers.redeem();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const refusal = (status: number, error: string, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify({ error }), { status, headers });

function linkDeps(over: Partial<LinkDeps> = {}): LinkDeps {
  const signer = recordingSigner();
  return {
    fetch: fakeFetch({}).fetch,
    wallet: WALLET,
    signMessage: signer.signMessage,
    getProof: async () => "a-privy-identity-token",
    ...over,
  };
}

describe("runLink", () => {
  it("authorises, signs the server's exact message, and redeems", async () => {
    const { fetch, calls } = fakeFetch({});
    const signer = recordingSigner();
    const result = await runLink(linkDeps({ fetch, signMessage: signer.signMessage }));

    expect(result).toEqual({ kind: "ok" });
    expect(calls).toHaveLength(2);

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("/api/x/challenge");
    expect(calls[0].body).toEqual({ wallet: WALLET, purpose: "link", proof: "a-privy-identity-token" });

    // BYTE FOR BYTE. The wallet renders these same bytes to the player, so what they read is what
    // they sign is what the server verifies against its stored copy.
    expect(signer.signed).toEqual([MESSAGE]);

    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("/api/x/link");
    expect(calls[1].body).toEqual({ wallet: WALLET, nonce: NONCE, signature: btoa(SIGNATURE_BYTE.repeat(64)) });
  });

  it("sends no message field — the server never re-reads its own words from us", async () => {
    const { fetch, calls } = fakeFetch({});
    await runLink(linkDeps({ fetch }));
    expect(calls[1].body).not.toHaveProperty("message");
  });

  it("gets the proof BEFORE prompting the wallet", async () => {
    // A wallet prompt that appears before the player has done the thing they think they are doing is
    // how people are trained to click through them.
    const order: string[] = [];
    const { fetch } = fakeFetch({});
    await runLink(
      linkDeps({
        fetch,
        getProof: async () => {
          order.push("proof");
          return "t";
        },
        signMessage: async () => {
          order.push("sign");
          return new Uint8Array(64);
        },
      }),
    );
    expect(order).toEqual(["proof", "sign"]);
  });

  it("reports a closed X window as cancelled, and sends nothing", async () => {
    const { fetch, calls } = fakeFetch({});
    expect(await runLink(linkDeps({ fetch, getProof: async () => null }))).toEqual({
      kind: "failed",
      reason: "cancelled",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports a broker that throws as cancelled too — same event from where the player stands", async () => {
    const { fetch, calls } = fakeFetch({});
    const result = await runLink(
      linkDeps({
        fetch,
        getProof: async () => {
          throw new Error("popup blocked");
        },
      }),
    );
    expect(result).toEqual({ kind: "failed", reason: "cancelled" });
    expect(calls).toHaveLength(0);
  });

  it("reports a declined wallet as walletRefused, and never redeems", async () => {
    const { fetch, calls } = fakeFetch({});
    const result = await runLink(
      linkDeps({
        fetch,
        signMessage: async () => {
          throw new Error("User rejected the request");
        },
      }),
    );
    expect(result).toEqual({ kind: "failed", reason: "walletRefused" });
    // The challenge was requested; the link was not.
    expect(calls.map((c) => c.url)).toEqual(["/api/x/challenge"]);
  });

  it("maps the server's refusals onto sentences a player can act on", async () => {
    const cases: ReadonlyArray<readonly [number, string, CeremonyFailure]> = [
      [401, "no-x-account", "cancelled"],
      [400, "expired", "expired"],
      [409, "wallet-taken", "walletTaken"],
      [401, "bad-proof", "unavailable"],
      [401, "bad-signature", "unavailable"],
      [403, "refused", "unavailable"],
      [503, "disabled", "unavailable"],
      [503, "unavailable", "unavailable"],
      [400, "malformed", "unavailable"],
    ];
    for (const [status, error, reason] of cases) {
      const { fetch } = fakeFetch({ redeem: () => refusal(status, error) });
      // `getProof` returns the same token twice, so the one retry cannot mask the mapping.
      const result = await runLink(linkDeps({ fetch }));
      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" ? result.reason : null).toBe(reason);
    }
  });

  it("passes the server's Retry-After through rather than inventing a wait", async () => {
    const { fetch } = fakeFetch({ redeem: () => refusal(429, "rate-limited", { "Retry-After": "240" }) });
    expect(await runLink(linkDeps({ fetch }))).toEqual({
      kind: "failed",
      reason: "tooMany",
      retryAfterSec: 240,
    });
  });

  it("survives a refusal that is not JSON at all", async () => {
    // A platform 502 is an HTML page. It must not throw inside the ceremony.
    const { fetch } = fakeFetch({ redeem: () => new Response("<html>bad gateway</html>", { status: 502 }) });
    expect(await runLink(linkDeps({ fetch }))).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("refuses to sign a 200 that carries no message", async () => {
    // Signing `undefined` would put nonsense in front of a player in a wallet prompt.
    const signer = recordingSigner();
    const { fetch } = fakeFetch({ challenge: () => new Response(JSON.stringify({ nonce: NONCE }), { status: 200 }) });
    const result = await runLink(linkDeps({ fetch, signMessage: signer.signMessage }));
    expect(result).toEqual({ kind: "failed", reason: "unavailable" });
    expect(signer.signed).toEqual([]);
  });

  it("retries ONCE with a fresh proof, and only once", async () => {
    // The server refuses an identity token older than an hour; a player who authorised earlier in the
    // session would otherwise be stuck on a failure they cannot understand or fix.
    const proofs = ["stale-token", "fresh-token"];
    let issued = 0;
    const { fetch, calls } = fakeFetch({ redeem: () => refusal(401, "bad-proof") });
    const result = await runLink(
      linkDeps({
        fetch,
        getProof: async () => proofs[issued++] ?? "another",
      }),
    );
    expect(result).toEqual({ kind: "failed", reason: "unavailable" });
    expect(issued).toBe(2);
    // Two full attempts — challenge + link, twice — and no third.
    expect(calls).toHaveLength(4);
    expect(calls[2].body.proof).toBe("fresh-token");
  });

  it("does not retry when the broker hands back the same token", async () => {
    // Nothing would change, and the second attempt would spend the player's rate limit for them.
    let issued = 0;
    const { fetch, calls } = fakeFetch({ redeem: () => refusal(401, "bad-proof") });
    await runLink(
      linkDeps({
        fetch,
        getProof: async () => {
          issued += 1;
          return "same-token";
        },
      }),
    );
    expect(issued).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("does not retry an actionable refusal", async () => {
    // A fresh proof cannot fix `wallet-taken` or an expired nonce; retrying would double the wallet
    // prompts for a failure the player has to resolve themselves.
    let issued = 0;
    const { fetch, calls } = fakeFetch({ redeem: () => refusal(409, "wallet-taken") });
    await runLink(
      linkDeps({
        fetch,
        getProof: async () => {
          issued += 1;
          return "t";
        },
      }),
    );
    expect(issued).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("treats an unreachable origin as unavailable rather than throwing", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    expect(await runLink(linkDeps({ fetch }))).toEqual({ kind: "failed", reason: "unavailable" });
  });

  it("NEVER returns anything renderable — no handle, no identity, on any path", async () => {
    // The rule the whole feature exists for. A success carries `{kind:"ok"}` and nothing else, so
    // there is no field a hurried component could draw a face from; the identity comes from re-reading
    // `/api/links` and verifying its signature.
    const { fetch } = fakeFetch({ redeem: () => new Response(JSON.stringify({ linked: true, handle: "blknoiz06" }), { status: 200 }) });
    const result = await runLink(linkDeps({ fetch }));
    expect(result).toEqual({ kind: "ok" });
    expect(JSON.stringify(result)).not.toContain("blknoiz06");
  });
});

describe("runUnlink", () => {
  const deps = (over: Partial<CeremonyDeps> = {}): CeremonyDeps => ({
    fetch: fakeFetch({}).fetch,
    wallet: WALLET,
    signMessage: recordingSigner().signMessage,
    ...over,
  });

  it("carries NO proof — revocation must not depend on the provider being walked away from", async () => {
    // The load-bearing asymmetry: somebody who deleted their X account, or lost access to it, can
    // still take their face off this site with nothing but the wallet that put it there.
    const { fetch, calls } = fakeFetch({ redeem: () => new Response(JSON.stringify({ unlinked: true }), { status: 200 }) });
    expect(await runUnlink(deps({ fetch }))).toEqual({ kind: "ok" });
    expect(calls[0].body).toEqual({ wallet: WALLET, purpose: "unlink" });
    expect(calls[0].body).not.toHaveProperty("proof");
  });

  it("uses DELETE, which is what tells the server which ceremony this is", async () => {
    const { fetch, calls } = fakeFetch({ redeem: () => new Response(JSON.stringify({ unlinked: true }), { status: 200 }) });
    await runUnlink(deps({ fetch }));
    expect(calls[1].method).toBe("DELETE");
  });

  it("succeeds when there was nothing to unlink", async () => {
    // `{"unlinked":false}` is a 200: the caller asked for this wallet to have no link and it has none.
    const { fetch } = fakeFetch({ redeem: () => new Response(JSON.stringify({ unlinked: false }), { status: 200 }) });
    expect(await runUnlink(deps({ fetch }))).toEqual({ kind: "ok" });
  });

  it("reports a declined wallet as walletRefused", async () => {
    const { fetch } = fakeFetch({});
    const result = await runUnlink(
      deps({
        fetch,
        signMessage: async () => {
          throw new Error("User rejected");
        },
      }),
    );
    expect(result).toEqual({ kind: "failed", reason: "walletRefused" });
  });
});

describe("the failure vocabulary and the copy", () => {
  it("has a sentence for every reason", async () => {
    // A reason with no sentence renders a blank panel at the moment somebody most needs to be told
    // something.
    const reasons: readonly CeremonyFailure[] = [
      "cancelled",
      "walletRefused",
      "expired",
      "walletTaken",
      "tooMany",
      "unavailable",
    ];
    for (const reason of reasons) {
      expect(typeof FAILURE_COPY[reason]).toBe("string");
      expect(FAILURE_COPY[reason].length).toBeGreaterThan(10);
    }
  });

  it("has no sentence that no reason can reach", async () => {
    // The other direction. `notBuilt` used to be here and became false the day the ceremony shipped;
    // this is what stops the next dead string surviving as long.
    const reachable = new Set<string>([
      "cancelled",
      "walletRefused",
      "expired",
      "walletTaken",
      "tooMany",
      "unavailable",
      // Not a failure — the label on the button that tries again.
      "retry",
    ]);
    for (const key of Object.keys(FAILURE_COPY)) {
      expect(reachable.has(key)).toBe(true);
    }
  });

  it("offers no way to type a handle, anywhere in the copy", async () => {
    // `web/index.html:2900`, in one assertion.
    const everything = Object.values(FAILURE_COPY).join(" ").toLowerCase();
    expect(everything).not.toContain("enter your handle");
    expect(everything).not.toContain("type your handle");
  });

  it("never uses the vi mock timers — every test here is real async", async () => {
    // A guard against somebody making these deterministic with fake timers later: the ceremony awaits
    // real promises, and a frozen clock would hide an ordering bug rather than expose one.
    expect(vi.isFakeTimers()).toBe(false);
  });
});
