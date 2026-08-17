// THE CEREMONY, END TO END, WITH REAL SIGNATURES AND NO DATABASE.
//
// Every test in this file runs the whole thing: `POST /api/x/challenge` for a nonce and a message, a
// genuine detached ed25519 signature over those exact bytes, then `POST` or `DELETE /api/x/link`. The
// signatures are real (`testKit.ts#walletKeypair` derives a public key from a secret we hold), so
// "wrong wallet" means a signature that genuinely does not verify rather than a flag in a fake.
//
// The cases that matter most, in the order `TWITTER-CONNECT.md` cares about them:
//
//   * A REPLAYED NONCE IS REFUSED. One shot, and the shot is a `DELETE ... RETURNING`.
//   * AN EXPIRED NONCE IS REFUSED, by the same predicate, so neither can be forgotten separately.
//   * A WRONG-WALLET SIGNATURE IS REFUSED, verified against the STORED wallet and never the body's.
//   * A HOUSE WALLET IS REFUSED, and refused with the same 503 as an outage, so the response is not a
//     roster oracle.
//   * A WORKER THAT CANNOT READ THE HOUSE LIST WRITES NOTHING. Fail closed, §6.3.
//   * THE `avatar_url` CHECK IS RESPECTED, including the case that forced migration 0002.
//   * UNLINKING ACTUALLY UNLINKS — proved through the READ path, because "the row is gone" is a claim
//     about storage and "the face is gone" is the claim that matters.

import { describe, expect, it } from "vitest";
import { CHALLENGE_TTL_SECONDS } from "./challenge.ts";
import { handleChallenge, type ChallengeDeps } from "./challengeHandler.ts";
import { HOUSE_LIST_UNKNOWN, type HouseListSource } from "./houseWallets.ts";
import { handleLinks } from "./linksHandler.ts";
import { handleLinkWrite, type LinkWriteDeps } from "./linkWriteHandler.ts";
import { MemoryLinkStore } from "./memoryStore.ts";
import { BROKEN_RATE_COUNTER, MemoryChallengeStore, MemoryRateCounter } from "./memoryWriteStore.ts";
import type { PrivyVerifier } from "./privyIdentity.ts";
import { deriveBucketSecret, LIMIT_PER_WALLET } from "./rateLimit.ts";
import {
  countingRandom,
  houseSource,
  NOW,
  signMessageBase64,
  TEST_KEY,
  wallet,
  walletKeypair,
} from "./testKit.ts";
import type { XIdentity } from "./writeStore.ts";

const SECRET = deriveBucketSecret("t".repeat(32));
const PLAYER = walletKeypair(0x21);
const OTHER = walletKeypair(0x22);

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

function verifier(identity: XIdentity): PrivyVerifier {
  return { verify: async () => ({ kind: "ok", identity }) };
}

interface World {
  readonly links: MemoryLinkStore;
  readonly challenges: MemoryChallengeStore;
  readonly challengeDeps: ChallengeDeps;
  readonly linkDeps: LinkWriteDeps;
}

function world(options: {
  identity?: XIdentity;
  house?: HouseListSource;
  nowSec?: () => number;
  rateCounter?: LinkWriteDeps["rate"]["counter"];
} = {}): World {
  const links = new MemoryLinkStore();
  const challenges = new MemoryChallengeStore();
  const counter = options.rateCounter ?? new MemoryRateCounter();
  const rate = { counter, secret: SECRET };
  const nowSec = options.nowSec ?? (() => NOW);
  return {
    links,
    challenges,
    challengeDeps: {
      challenges,
      rate,
      privy: verifier(options.identity ?? IDENTITY),
      nowSec,
      randomBytes: countingRandom(0x31),
    },
    linkDeps: {
      challenges,
      links,
      rate,
      house: options.house ?? houseSource([]),
      nowSec,
    },
  };
}

const CHALLENGE_URL = "https://bullsvsunicorns.fun/api/x/challenge";
const LINK_URL = "https://bullsvsunicorns.fun/api/x/link";

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", host: "bullsvsunicorns.fun" },
    body: JSON.stringify(body),
  });
}

/** Ask for a challenge and return what the client would have to sign. */
async function requestChallenge(
  w: World,
  purpose: "link" | "unlink",
  address: string,
): Promise<{ nonce: string; message: string }> {
  const res = await handleChallenge(
    jsonRequest(CHALLENGE_URL, "POST", {
      wallet: address,
      purpose,
      ...(purpose === "link" ? { proof: "a-privy-identity-token" } : {}),
    }),
    w.challengeDeps,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { nonce: string; message: string };
}

/** The whole ceremony, as a client would perform it. */
async function ceremony(
  w: World,
  purpose: "link" | "unlink",
  key: { secret: Uint8Array; address: string } = PLAYER,
  overrides: { signer?: Uint8Array; walletInBody?: string } = {},
): Promise<Response> {
  const { nonce, message } = await requestChallenge(w, purpose, key.address);
  const signature = signMessageBase64(overrides.signer ?? key.secret, message);
  return handleLinkWrite(
    jsonRequest(LINK_URL, purpose === "link" ? "POST" : "DELETE", {
      wallet: overrides.walletInBody ?? key.address,
      nonce,
      signature,
    }),
    w.linkDeps,
  );
}

/** What the READ path serves for these wallets — the only view that matters to a player. */
async function readLinks(w: World, wallets: readonly string[]): Promise<unknown[]> {
  const res = await handleLinks(
    new Request(`https://bullsvsunicorns.fun/api/links?wallets=${wallets.join(",")}`),
    { store: w.links, key: TEST_KEY, house: houseSource([]), nowSec: () => NOW },
  );
  const body = (await res.json()) as { links: unknown[] };
  return body.links;
}

describe("a link, all the way through", () => {
  it("writes the identity and the read path immediately serves it", async () => {
    const w = world();
    const res = await ceremony(w, "link");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ linked: true });

    const rows = await w.links.findByWallets([PLAYER.address]);
    expect(rows).toEqual([
      {
        xId: IDENTITY.xId,
        wallet: PLAYER.address,
        handle: IDENTITY.handle,
        displayName: IDENTITY.displayName,
        avatarHash: null, // §7.3's "linked + avatar in flight" — the ordinary state of a fresh link.
        linkedAt: NOW,
      },
    ]);

    const served = await readLinks(w, [PLAYER.address]);
    expect(served).toHaveLength(1);
  });

  it("returns nothing a client could render as an identity", async () => {
    // The client's rule is that only `verifyAttestation` may mint something a face is drawn from. A
    // `handle` in this body would be an unsigned identity arriving over the same connection as a signed
    // one — the exact shape of the defect this feature exists to delete.
    const w = world();
    const res = await ceremony(w, "link");
    const body = await res.json();
    expect(body).toEqual({ linked: true });
    expect(JSON.stringify(body)).not.toContain(IDENTITY.handle);
    expect(JSON.stringify(body)).not.toContain(IDENTITY.xId);
  });

  it("consumes the challenge, leaving nothing behind", async () => {
    const w = world();
    await ceremony(w, "link");
    expect(w.challenges.size).toBe(0);
  });

  it("405s a method that is not POST or DELETE, and names both", async () => {
    const w = world();
    for (const method of ["GET", "PUT", "PATCH"]) {
      const res = await handleLinkWrite(new Request(LINK_URL, { method }), w.linkDeps);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST, DELETE");
    }
  });
});

describe("the nonce is single-use and short-lived", () => {
  it("REFUSES A REPLAY — the second redemption of one nonce", async () => {
    const w = world();
    const { nonce, message } = await requestChallenge(w, "link", PLAYER.address);
    const signature = signMessageBase64(PLAYER.secret, message);
    const body = { wallet: PLAYER.address, nonce, signature };

    const first = await handleLinkWrite(jsonRequest(LINK_URL, "POST", body), w.linkDeps);
    expect(first.status).toBe(200);

    // Byte-identical request, replayed. This is the attack the nonce exists for.
    const second = await handleLinkWrite(jsonRequest(LINK_URL, "POST", body), w.linkDeps);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: "expired" });
  });

  it("REFUSES AN EXPIRED NONCE, with the signature still perfectly valid", async () => {
    // The signature is fine; the challenge is not. Expiry and single-use are one predicate in one
    // statement, so neither can be checked without the other.
    let now = NOW;
    const w = world({ nowSec: () => now });
    const { nonce, message } = await requestChallenge(w, "link", PLAYER.address);
    const signature = signMessageBase64(PLAYER.secret, message);

    now = NOW + CHALLENGE_TTL_SECONDS + 1;
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", { wallet: PLAYER.address, nonce, signature }),
      w.linkDeps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expired" });
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("refuses a nonce that was never issued, indistinguishably", async () => {
    const w = world();
    const { message } = await requestChallenge(w, "link", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", {
        wallet: PLAYER.address,
        nonce: "f".repeat(64),
        signature: signMessageBase64(PLAYER.secret, message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "expired" });
  });

  it("refuses a malformed nonce before it reaches the store", async () => {
    const w = world();
    for (const nonce of [undefined, "", "ZZZ", "F".repeat(64), "a".repeat(63)]) {
      const res = await handleLinkWrite(
        jsonRequest(LINK_URL, "POST", { wallet: PLAYER.address, nonce, signature: "A".repeat(86) + "==" }),
        w.linkDeps,
      );
      expect(res.status).toBe(400);
    }
  });

  it("will not let an unlink challenge be redeemed as a link", async () => {
    // The player consented to one act — the intent is in the bytes they signed — and it may not be
    // turned into the other one. The nonce is spent either way.
    const w = world();
    const { nonce, message } = await requestChallenge(w, "unlink", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", {
        wallet: PLAYER.address,
        nonce,
        signature: signMessageBase64(PLAYER.secret, message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(400);
    expect(errorBody(await res.json()).detail).toContain("different operation");
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("will not let a link challenge be redeemed as an unlink", async () => {
    const w = world();
    await ceremony(w, "link");
    const { nonce, message } = await requestChallenge(w, "link", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "DELETE", {
        wallet: PLAYER.address,
        nonce,
        signature: signMessageBase64(PLAYER.secret, message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(400);
    // And the link is still there — a refused redemption changes nothing.
    expect(await w.links.findByWallets([PLAYER.address])).toHaveLength(1);
  });
});

describe("the wallet signature", () => {
  it("REFUSES A SIGNATURE FROM THE WRONG WALLET", async () => {
    // The forgery this half of the ceremony exists to stop: I authorise as my own handle and claim
    // somebody else's wallet.
    const w = world();
    const res = await ceremony(w, "link", PLAYER, { signer: OTHER.secret });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad-signature" });
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("refuses a signature over a DIFFERENT message, even from the right wallet", async () => {
    // The nonce and the expiry are inside the bytes, so a signature harvested from any other prompt —
    // including an earlier ceremony of this player's own — cannot be replayed here.
    const w = world();
    const { nonce } = await requestChallenge(w, "link", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", {
        wallet: PLAYER.address,
        nonce,
        signature: signMessageBase64(PLAYER.secret, "bullsvsunicorns.fun wants to link your X account."),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(401);
  });

  it("verifies against the STORED wallet, so naming another wallet in the body cannot help", async () => {
    const w = world();
    const { nonce, message } = await requestChallenge(w, "link", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", {
        wallet: OTHER.address,
        nonce,
        signature: signMessageBase64(OTHER.secret, message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(400);
    expect(errorBody(await res.json()).detail).toContain("another wallet");
    expect(await w.links.findByWallets([OTHER.address])).toEqual([]);
  });

  it("refuses a signature that is not 64 bytes of base64", async () => {
    const w = world();
    const { nonce } = await requestChallenge(w, "link", PLAYER.address);
    for (const signature of [undefined, "", "not base64", "AAAA", `${"A".repeat(86)}=`]) {
      const res = await handleLinkWrite(
        jsonRequest(LINK_URL, "POST", { wallet: PLAYER.address, nonce, signature }),
        w.linkDeps,
      );
      expect(res.status).toBe(400);
    }
  });

  it("treats a signature it cannot evaluate as one that did not verify", async () => {
    // Noble throws on a malformed point rather than returning false, and a throw here would read as our
    // outage rather than as their bad signature.
    const w = world();
    const { nonce } = await requestChallenge(w, "link", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", { wallet: PLAYER.address, nonce, signature: `${"/".repeat(86)}==` }),
      w.linkDeps,
    );
    expect(res.status).toBe(401);
  });
});

describe("§6.3 — the arena's own wallets may never wear a face", () => {
  it("REFUSES A HOUSE WALLET, with the same answer as an outage", async () => {
    // A refusal that named its reason would be a membership oracle. It says `unavailable`, exactly as a
    // keeper outage and an unexpected exception do.
    const w = world({ house: houseSource([PLAYER.address]) });
    const res = await ceremony(w, "link");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("is checked only AFTER the signature verifies, so probing needs the private key", async () => {
    // The ordering is the anti-oracle design. A caller who cannot sign for the wallet gets
    // `bad-signature` whether or not it is a house wallet, so the endpoint answers nothing about a
    // wallet the caller does not control.
    const house = houseSource([PLAYER.address]);
    const w = world({ house });
    const res = await ceremony(w, "link", PLAYER, { signer: OTHER.secret });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "bad-signature" });
  });

  it("FAILS CLOSED when the house list has never been read", async () => {
    // A worker that cannot tell an arena wallet from a player's writes nothing at all. The cost is a
    // retry; the cost of failing open is an automated process wearing a person's face.
    const w = world({ house: { get: async () => HOUSE_LIST_UNKNOWN } });
    const res = await ceremony(w, "link");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("fails closed on an UNLINK too, rather than writing from a misconfigured worker", async () => {
    const w = world({ house: { get: async () => HOUSE_LIST_UNKNOWN } });
    await w.links.seed({ xId: IDENTITY.xId, wallet: PLAYER.address, handle: IDENTITY.handle });
    const res = await ceremony(w, "unlink");
    expect(res.status).toBe(503);
    expect(await w.links.findByWallets([PLAYER.address])).toHaveLength(1);
  });

  it("does not consult the roster to REMOVE a link", async () => {
    // Removing a link is safe for any wallet, and refusing would answer a membership question for a
    // caller who has just proved they hold the key.
    const w = world({ house: houseSource([PLAYER.address]) });
    await w.links.seed({ xId: IDENTITY.xId, wallet: PLAYER.address, handle: IDENTITY.handle });
    const res = await ceremony(w, "unlink");
    expect(res.status).toBe(200);
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });
});

describe("the avatar_url CHECK is respected rather than worked around", () => {
  it("stores NULL for an X account with no picture — the case that forced migration 0002", async () => {
    // Privy hands back X's default egg on `abs.twimg.com`, which `expandTwitterAvatarUrl` maps to null.
    // Under 0001's `NOT NULL` this link could not have been stored at all, and a perfectly proven
    // ceremony would have failed with an error no player could understand or fix.
    const w = world({ identity: { ...IDENTITY, avatarUrl: null } });
    const res = await ceremony(w, "link");
    expect(res.status).toBe(200);

    const target = await w.links.findForIngest(IDENTITY.xId);
    expect(target?.avatarUrl).toBeNull();
    // And it renders as the ordinary flat disc: no hash, so `avatarPath` is the wire's `""`.
    expect((await w.links.findByWallets([PLAYER.address]))[0].avatarHash).toBeNull();
  });

  it("stores an X CDN url unchanged, `_normal` and all", async () => {
    // The `_normal` → `_400x400` upgrade belongs to `avatarIngest.ts#upgradeAvatarUrl`; doing it twice is
    // how two files come to disagree about one URL.
    const w = world();
    await ceremony(w, "link");
    expect((await w.links.findForIngest(IDENTITY.xId))?.avatarUrl).toBe(IDENTITY.avatarUrl);
  });

  it("cannot store a URL on any other host — the store refuses it as Postgres would", async () => {
    // The anti-SSRF constraint, from the write path's side. `expandTwitterAvatarUrl` should make this
    // unreachable; if it ever stops doing so, this is the wall the value hits.
    const w = world({ identity: { ...IDENTITY, avatarUrl: "https://evil.example/x.png" } });
    await expect(ceremony(w, "link")).rejects.toThrow(/avatar_url_check/);
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });
});

describe("unlinking actually unlinks", () => {
  it("removes the row, the served attestation AND the avatar bytes", async () => {
    const w = world();
    const hash = "a".repeat(64);
    await ceremony(w, "link");
    // Give it a picture, so the test can prove the bytes leave with the row rather than lingering
    // somewhere the proxy could still serve them.
    await w.links.putAvatar(IDENTITY.xId, hash, new Uint8Array([1, 2, 3]), NOW);
    expect(await w.links.findAvatar(IDENTITY.xId, hash)).not.toBeNull();
    expect(await readLinks(w, [PLAYER.address])).toHaveLength(1);

    const res = await ceremony(w, "unlink");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: true });

    // All three views agree that the identity is gone.
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
    expect(await readLinks(w, [PLAYER.address])).toEqual([]);
    expect(await w.links.findAvatar(IDENTITY.xId, hash)).toBeNull();
    expect(await w.links.findForIngest(IDENTITY.xId)).toBeNull();
  });

  it("is a DELETE, not a flag — the x_id becomes linkable again", async () => {
    // §6.2 is explicit ("Deletes the row. Not a flag; a delete"), and this is the observable difference:
    // a suppressed row would still occupy the primary key.
    const w = world();
    await ceremony(w, "link");
    await ceremony(w, "unlink");
    const again = await ceremony(w, "link", OTHER);
    expect(again.status).toBe(200);
    expect(await w.links.findByWallets([OTHER.address])).toHaveLength(1);
  });

  it("succeeds and says nothing happened when the wallet had no link", async () => {
    const w = world();
    const res = await ceremony(w, "unlink");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unlinked: false });
  });

  it("needs a fresh signature over a fresh nonce — a link's nonce will not do", async () => {
    // §6.2: "so a stolen ticket or a stale session cannot unlink someone". Covered by the purpose
    // mismatch above; asserted here from the revocation side, which is where the requirement is written.
    const w = world();
    await ceremony(w, "link");
    const stale = await requestChallenge(w, "link", PLAYER.address);
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "DELETE", {
        wallet: PLAYER.address,
        nonce: stale.nonce,
        signature: signMessageBase64(PLAYER.secret, stale.message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(400);
    expect(await w.links.findByWallets([PLAYER.address])).toHaveLength(1);
  });
});

describe("both directions of uniqueness", () => {
  it("moves an X account to a new wallet in place, leaving no second row", async () => {
    // §4.3: relinking X account X from W1 to W2 must remove W1's row in the same transaction. One row
    // that changed its wallet is how that is satisfied.
    const w = world();
    await ceremony(w, "link", PLAYER);
    const moved = await ceremony(w, "link", OTHER);
    expect(moved.status).toBe(200);

    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
    const rows = await w.links.findByWallets([OTHER.address]);
    expect(rows).toHaveLength(1);
    expect(rows[0].xId).toBe(IDENTITY.xId);
  });

  it("refuses to give one wallet a second X account, and says how to fix it", async () => {
    // The strict direction. Nobody is stranded: whoever can sign this link can sign the unlink.
    const w = world();
    await ceremony(w, "link", PLAYER);

    const second = world({ identity: { ...IDENTITY, xId: "999", handle: "another" } });
    // Same underlying store, so the conflict is real.
    const shared: World = { ...second, links: w.links, linkDeps: { ...second.linkDeps, links: w.links } };
    const res = await ceremony(shared, "link", PLAYER);
    expect(res.status).toBe(409);
    expect(errorBody(await res.json()).error).toBe("wallet-taken");

    // Nothing was disturbed: a link write never deletes a row.
    const rows = await w.links.findByWallets([PLAYER.address]);
    expect(rows[0].xId).toBe(IDENTITY.xId);
  });

  it("keeps `linked_at` when the pair has not changed, and moves it when the wallet does", async () => {
    let now = NOW;
    const w = world({ nowSec: () => now });
    await ceremony(w, "link", PLAYER);

    now = NOW + 10_000;
    await ceremony(w, "link", PLAYER);
    expect((await w.links.findByWallets([PLAYER.address]))[0].linkedAt).toBe(NOW);

    now = NOW + 20_000;
    await ceremony(w, "link", OTHER);
    expect((await w.links.findByWallets([OTHER.address]))[0].linkedAt).toBe(NOW + 20_000);
  });

  it("does not resurrect a suppressed identity", async () => {
    // §7.4's kill switch must survive a relink, or the ceremony is a moderation bypass: link, get taken
    // down, link again, reappear. The write succeeds and the row stays invisible — refusing instead would
    // tell the caller they are suppressed, and the kill switch is not a conversation.
    const w = world();
    await ceremony(w, "link", PLAYER);
    await w.links.setSuppressed(IDENTITY.xId, true);
    expect(await readLinks(w, [PLAYER.address])).toEqual([]);

    const again = await ceremony(w, "link", PLAYER);
    expect(again.status).toBe(200);
    expect(await readLinks(w, [PLAYER.address])).toEqual([]);
  });

  it("does NOT let unlink-then-relink clear the kill switch — the review finding", async () => {
    // THE BYPASS, three self-service correctly-signed steps long: an operator suppresses; the player
    // deletes their own row (allowed by §6.2, and it must stay allowed); the player links again. The flag
    // lived on the row the player had just deleted, so the fresh INSERT took `DEFAULT FALSE` and the
    // identity came back. Migration 0003 moves the durable record onto the x_id, where a player cannot
    // reach it.
    const w = world();
    await ceremony(w, "link", PLAYER);
    await w.links.setSuppressed(IDENTITY.xId, true);
    expect(await readLinks(w, [PLAYER.address])).toEqual([]);

    const gone = await ceremony(w, "unlink", PLAYER);
    expect(gone.status).toBe(200);
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);

    // Relinking succeeds — the write is not refused, because "the kill switch is not a conversation" —
    // and the identity stays down on both read paths.
    const again = await ceremony(w, "link", PLAYER);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ linked: true });
    expect(await readLinks(w, [PLAYER.address])).toEqual([]);
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("keeps the switch across a relink onto a DIFFERENT wallet too", async () => {
    const w = world();
    await ceremony(w, "link", PLAYER);
    await w.links.setSuppressed(IDENTITY.xId, true);
    await ceremony(w, "unlink", PLAYER);
    await ceremony(w, "link", OTHER);
    expect(await readLinks(w, [OTHER.address])).toEqual([]);
  });

  it("lets an operator lift the switch after the row has been deleted", async () => {
    // The other direction has to work or a suppression becomes permanent for reasons nobody can see:
    // un-suppressing removes the durable record even when there is no row left to update.
    const w = world();
    await ceremony(w, "link", PLAYER);
    await w.links.setSuppressed(IDENTITY.xId, true);
    await ceremony(w, "unlink", PLAYER);
    await w.links.setSuppressed(IDENTITY.xId, false);
    await ceremony(w, "link", PLAYER);
    expect(await readLinks(w, [PLAYER.address])).toHaveLength(1);
  });

  it("clears the cached face when the player removes their X picture", async () => {
    // Otherwise the row advertises an `avatar_hash` with no URL left to refresh from: `/api/links` keeps
    // serving the old face and the ingest can never replace it. "Last good bytes while a re-ingest
    // catches up" would become "for ever", against the wishes of the person in the picture.
    const w = world();
    const hash = "b".repeat(64);
    await ceremony(w, "link", PLAYER);
    await w.links.putAvatar(IDENTITY.xId, hash, new Uint8Array([9, 9]), NOW);
    expect(await w.links.findAvatar(IDENTITY.xId, hash)).not.toBeNull();

    const noPicture = world({ identity: { ...IDENTITY, avatarUrl: null } });
    const shared: World = { ...noPicture, links: w.links, linkDeps: { ...noPicture.linkDeps, links: w.links } };
    await ceremony(shared, "link", PLAYER);

    expect(await w.links.findAvatar(IDENTITY.xId, hash)).toBeNull();
    expect((await w.links.findByWallets([PLAYER.address]))[0].avatarHash).toBeNull();
    expect((await w.links.findForIngest(IDENTITY.xId))?.avatarUrl).toBeNull();
  });

  it("keeps the cached face when the picture merely changed", async () => {
    const w = world();
    const hash = "c".repeat(64);
    await ceremony(w, "link", PLAYER);
    await w.links.putAvatar(IDENTITY.xId, hash, new Uint8Array([1]), NOW);

    const newPicture = world({
      identity: { ...IDENTITY, avatarUrl: "https://pbs.twimg.com/profile_images/2/z_normal.jpg" },
    });
    const shared: World = { ...newPicture, links: w.links, linkDeps: { ...newPicture.linkDeps, links: w.links } };
    await ceremony(shared, "link", PLAYER);

    // §7.2's last good bytes: one ingest behind is better than a flat disc.
    expect(await w.links.findAvatar(IDENTITY.xId, hash)).not.toBeNull();
  });

  it("refreshes a drifted handle and picture on a re-link", async () => {
    const w = world();
    await ceremony(w, "link", PLAYER);

    const renamed = world({ identity: { ...IDENTITY, handle: "renamed", displayName: "Re Named" } });
    const shared: World = { ...renamed, links: w.links, linkDeps: { ...renamed.linkDeps, links: w.links } };
    await ceremony(shared, "link", PLAYER);

    const rows = await w.links.findByWallets([PLAYER.address]);
    expect(rows[0].handle).toBe("renamed");
    expect(rows[0].displayName).toBe("Re Named");
  });
});

describe("the rate limit and the reserved rules on this leg", () => {
  it("refuses once a wallet has spent its window", async () => {
    const w = world();
    // `LIMIT_PER_WALLET` requests are ALLOWED, so the refusal is the one after them — hence `<=`. The
    // bodies are deliberately junk: the limiter runs before the nonce is looked at, which is what makes
    // it a bound on cost rather than a bound on successful ceremonies.
    let limited = false;
    for (let i = 0; i <= LIMIT_PER_WALLET; i += 1) {
      const res = await handleLinkWrite(
        jsonRequest(LINK_URL, "POST", {
          wallet: PLAYER.address,
          nonce: "b".repeat(64),
          signature: `${"A".repeat(86)}==`,
        }),
        w.linkDeps,
      );
      if (res.status === 429) {
        limited = true;
        expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("FAILS CLOSED when the counter cannot count", async () => {
    const w = world({ rateCounter: BROKEN_RATE_COUNTER });
    await expect(
      handleLinkWrite(
        jsonRequest(LINK_URL, "POST", {
          wallet: PLAYER.address,
          nonce: "c".repeat(64),
          signature: `${"A".repeat(86)}==`,
        }),
        w.linkDeps,
      ),
    ).rejects.toThrow();
  });

  it("refuses a reserved fixture id even if a challenge for one somehow exists", async () => {
    // The second of the two chances: `challengeHandler.ts` refuses it when the nonce is minted, and this
    // still holds if a challenge row ever reaches the table by another route.
    const w = world();
    const reserved: XIdentity = { ...IDENTITY, xId: "9990000000000001" };
    const { nonce, message } = await (async () => {
      // Bypass the challenge handler deliberately — this is the "row arrived by another route" case.
      const message = "bullsvsunicorns.fun wants to link your X account.\n\nplaced by hand";
      const nonce = "d".repeat(64);
      await w.challenges.put({
        purpose: "link",
        nonce,
        wallet: PLAYER.address,
        message,
        issuedAtSec: NOW,
        expiresAtSec: NOW + CHALLENGE_TTL_SECONDS,
        identity: reserved,
      });
      return { nonce, message };
    })();

    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", {
        wallet: PLAYER.address,
        nonce,
        signature: signMessageBase64(PLAYER.secret, message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(403);
    expect(await w.links.findByWallets([PLAYER.address])).toEqual([]);
  });

  it("refuses a reserved handle on this leg as well", async () => {
    const w = world();
    const message = "bullsvsunicorns.fun wants to link your X account.\n\nplaced by hand";
    const nonce = "e".repeat(64);
    await w.challenges.put({
      purpose: "link",
      nonce,
      wallet: PLAYER.address,
      message,
      issuedAtSec: NOW,
      expiresAtSec: NOW + CHALLENGE_TTL_SECONDS,
      identity: { ...IDENTITY, handle: "support" },
    });
    const res = await handleLinkWrite(
      jsonRequest(LINK_URL, "POST", {
        wallet: PLAYER.address,
        nonce,
        signature: signMessageBase64(PLAYER.secret, message),
      }),
      w.linkDeps,
    );
    expect(res.status).toBe(403);
  });
});

describe("nothing in a response or a refusal names the arena's wallets", () => {
  it("answers the house cases with a body that is one word", async () => {
    // The anonymity rule, asserted on the wire: no header, no detail, no hint. `unavailable` and nothing
    // else, for a house wallet, an unreadable roster and an internal fault alike.
    const houseWallet = wallet(77);
    const w = world({ house: houseSource([PLAYER.address, houseWallet]) });
    const res = await ceremony(w, "link");
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "unavailable" }));
    expect(text).not.toContain(houseWallet);
    expect(text).not.toContain(PLAYER.address);
    expect([...res.headers.keys()].join(",")).not.toContain("house");
  });
});
