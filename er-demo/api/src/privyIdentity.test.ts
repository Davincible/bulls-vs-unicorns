// FACT A, TESTED AGAINST REAL SIGNATURES.
//
// These tests generate a P-256 keypair, publish it through a fake `fetch` as a JWKS, and MINT GENUINE
// ES256 TOKENS with `webcrypto`. Nothing here is mocked at the verification boundary, which is the
// whole reason `privyIdentity.ts` was hand-rolled rather than vendored: every refusal below — a swapped
// key, a tampered payload, `alg: none`, a wrong audience, a stale token — is exercised against a real
// signature, and a vendored SDK behind a network call could only have been tested by trusting it.
//
// The claim shapes are the ones Privy actually emits, including the two undocumented behaviours this
// file reimplements from their shipping SDK: `linked_accounts` is a STRINGIFIED array, and `pfp` is a
// PATH FRAGMENT rather than a URL. If either ever changes, these tests are where it shows up.

import { beforeEach, describe, expect, it } from "vitest";
import {
  clampDisplayName,
  createPrivyVerifier,
  JWKS_COOLDOWN_SECONDS,
  JWKS_TTL_SECONDS,
  expandTwitterAvatarUrl,
  jwksFrom,
  MAX_IDENTITY_TOKEN_AGE_SECONDS,
  privyJwksUrl,
  PrivyJwksCache,
  PRIVY_ISSUER,
  xIdentityFromClaims,
} from "./privyIdentity.ts";
import { NOW } from "./testKit.ts";

// The global `crypto`, not `node:crypto`'s `webcrypto` export — which is `undefined` under vitest. The
// module under test explains why at length; this file has to use the same door to mint what it verifies.
const subtle = globalThis.crypto.subtle;

const APP_ID = "cmsnbbun8007m0cjxbfx762sw";
const KID = "test-key-1";

// base64url BY HAND, and not through `Buffer.toString("base64url")`, WHICH DOES NOT WORK HERE.
// `er-demo`'s vite config installs `vite-plugin-node-polyfills` for the browser bundle, and its
// `buffer@6.0.3` shim reaches the test environment too — where `base64url` is not one of the encodings
// it knows, so it throws `Unknown encoding: base64url`. `btoa` is a real global in this runtime and in
// the one the module under test uses, so this is also closer to what production does.
const b64uBytes = (bytes: ArrayBuffer | Uint8Array): string => {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64u = (s: string): string => b64uBytes(new TextEncoder().encode(s));

/**
 * The keypair type, DERIVED FROM THE PLATFORM'S OWN TYPINGS rather than named.
 *
 * `CryptoKeyPair` is not in scope here and must not be brought into scope: `tsconfig.api.json` sets
 * `lib: ["ES2023"]` with NO DOM, deliberately, because this tree runs on a server and "`document`
 * compiling here would be a bug that only shows up at 3am". Adding `"DOM"` to get one interface name
 * would put `window`, `localStorage` and `HTMLElement` in scope for every serverless module, and
 * `/api/tsconfig.json` records what the DOM lib already cost this repo once (a `BodyInit` mismatch
 * reported on every deploy). `Extract<…>` picks the pair out of `generateKey`'s
 * `CryptoKey | CryptoKeyPair` union with no new names and no new lib.
 */
type GeneratedKeyPair = Extract<Awaited<ReturnType<typeof subtle.generateKey>>, { privateKey: unknown }>;

interface Signer {
  readonly kid: string;
  readonly publicJwk: Record<string, unknown>;
  mint(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as GeneratedKeyPair;
  const jwk = (await subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return {
    kid,
    publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, use: "sig", alg: "ES256" },
    async mint(payload, header) {
      const h = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid, ...(header ?? {}) }));
      const p = b64u(JSON.stringify(payload));
      const sig = await subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
      );
      return `${h}.${p}.${b64uBytes(sig)}`;
    },
  };
}

/** The claim shape Privy emits for one linked X account. `linked_accounts` is a STRING containing JSON —
 *  not an array — and the fields are abbreviated: `subject`, `username`, `name`, `pfp`, `lv`. */
function claims(overrides: Record<string, unknown> = {}, xAccount?: Record<string, unknown> | null) {
  const accounts =
    xAccount === null
      ? []
      : [
          {
            type: "twitter_oauth",
            subject: "1234567890123456789",
            username: "someone",
            name: "Some One",
            pfp: "1899876543210987654/AbCdEfGh_normal.jpg",
            lv: NOW - 10,
            ...(xAccount ?? {}),
          },
        ];
  return {
    iss: PRIVY_ISSUER,
    aud: APP_ID,
    sub: "did:privy:cm9abcdefghijklmnop",
    iat: NOW - 5,
    exp: NOW + 3600,
    linked_accounts: JSON.stringify(accounts),
    ...overrides,
  };
}

interface Harness {
  readonly signer: Signer;
  readonly fetches: () => number;
  verify(token: string, nowSec?: number): ReturnType<ReturnType<typeof createPrivyVerifier>["verify"]>;
}

async function harness(options: { keys?: Signer[]; fail?: boolean } = {}): Promise<Harness> {
  const signer = await makeSigner(KID);
  const keys = options.keys ?? [signer];
  let fetches = 0;
  const cache = new PrivyJwksCache({
    url: privyJwksUrl("https://api.privy.io", APP_ID),
    nowSec: () => NOW,
    fetch: (async () => {
      fetches += 1;
      if (options.fail === true) throw new Error("network down");
      return new Response(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch,
  });
  const verifier = createPrivyVerifier({ appId: APP_ID, jwks: cache });
  return {
    signer,
    fetches: () => fetches,
    verify: (token, nowSec = NOW) => verifier.verify(token, nowSec),
  };
}

describe("privyJwksUrl", () => {
  it("is the path Privy's SDK builds", () => {
    expect(privyJwksUrl("https://api.privy.io", APP_ID)).toBe(
      `https://api.privy.io/v1/apps/${APP_ID}/jwks.json`,
    );
  });

  it("tolerates a trailing slash on the configured origin", () => {
    expect(privyJwksUrl("https://api.privy.io/", APP_ID)).toBe(
      `https://api.privy.io/v1/apps/${APP_ID}/jwks.json`,
    );
  });
});

describe("a genuine identity token", () => {
  it("yields the X identity, with the avatar fragment expanded to X's CDN", async () => {
    const h = await harness();
    const result = await h.verify(await h.signer.mint(claims()));
    expect(result).toEqual({
      kind: "ok",
      identity: {
        xId: "1234567890123456789",
        handle: "someone",
        displayName: "Some One",
        avatarUrl: "https://pbs.twimg.com/profile_images/1899876543210987654/AbCdEfGh_normal.jpg",
      },
    });
  });

  it("does not need to fetch the keys again for a second token", async () => {
    // An hour of caching, matching what Privy's own SDK asks `jose` for. Without it, every link event
    // is an outbound request to Privy on the player's critical path.
    const h = await harness();
    await h.verify(await h.signer.mint(claims()));
    await h.verify(await h.signer.mint(claims()));
    expect(h.fetches()).toBe(1);
  });
});

describe("refusals that are about the token itself", () => {
  it("refuses `alg: none` — the oldest hole in JWT", async () => {
    const h = await harness();
    const header = b64u(JSON.stringify({ alg: "none", kid: KID }));
    const payload = b64u(JSON.stringify(claims()));
    expect(await h.verify(`${header}.${payload}.`)).toEqual({ kind: "rejected", reason: "malformed" });
  });

  it("refuses a symmetric algorithm, so a public key can never be used as an HMAC secret", async () => {
    const h = await harness();
    const header = b64u(JSON.stringify({ alg: "HS256", kid: KID }));
    const payload = b64u(JSON.stringify(claims()));
    expect(await h.verify(`${header}.${payload}.${"A".repeat(86)}`)).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });

  it("refuses a `crit` header, because we understand no extensions", async () => {
    const h = await harness();
    const token = await h.signer.mint(claims(), { crit: ["exp"] });
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "malformed" });
  });

  it("refuses a token with no `kid`", async () => {
    const h = await harness();
    const token = await h.signer.mint(claims(), { kid: undefined });
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "malformed" });
  });

  it("refuses junk, an empty string and something enormous", async () => {
    const h = await harness();
    for (const junk of ["", "a.b", "not.a.jwt", "x".repeat(9000)]) {
      expect((await h.verify(junk)).kind).toBe("rejected");
    }
    // And it did so without asking Privy for anything.
    expect(h.fetches()).toBe(0);
  });

  it("refuses a tampered payload", async () => {
    // The signature covers `header.payload`, so re-encoding the claims invalidates it. This is the check
    // everything else rests on.
    const h = await harness();
    const token = await h.signer.mint(claims());
    const [header, , sig] = token.split(".");
    const forged = b64u(JSON.stringify(claims({}, { username: "blknoiz06" })));
    expect(await h.verify(`${header}.${forged}.${sig}`)).toEqual({
      kind: "rejected",
      reason: "bad-signature",
    });
  });

  it("refuses a token signed by a different key that claims our kid", async () => {
    const impostor = await makeSigner(KID);
    const h = await harness();
    expect(await h.verify(await impostor.mint(claims()))).toEqual({
      kind: "rejected",
      reason: "bad-signature",
    });
  });

  it("refuses an unknown kid", async () => {
    const other = await makeSigner("some-other-key");
    const h = await harness();
    expect(await h.verify(await other.mint(claims()))).toEqual({
      kind: "rejected",
      reason: "unknown-key",
    });
  });
});

describe("refusals that are about the claims", () => {
  it("refuses a wrong issuer", async () => {
    const h = await harness();
    const token = await h.signer.mint(claims({ iss: "evil.example" }));
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "wrong-issuer" });
  });

  it("refuses a token minted for another Privy app", async () => {
    // Without this, any Privy app in the world could mint identities for ours.
    const h = await harness();
    const token = await h.signer.mint(claims({ aud: "someotherappid12345678" }));
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "wrong-audience" });
  });

  it("accepts an audience array containing the app id", async () => {
    // The JWT spec allows an array; Privy sends a string. Accepting both costs one line and removes an
    // outage the day they change it.
    const h = await harness();
    const token = await h.signer.mint(claims({ aud: ["something-else", APP_ID] }));
    expect((await h.verify(token)).kind).toBe("ok");
  });

  it("refuses an expired token, and one with no exp at all", async () => {
    const h = await harness();
    expect(await h.verify(await h.signer.mint(claims({ exp: NOW - 120 })))).toEqual({
      kind: "rejected",
      reason: "expired",
    });
    expect(await h.verify(await h.signer.mint(claims({ exp: undefined })))).toEqual({
      kind: "rejected",
      reason: "expired",
    });
  });

  it("refuses a token older than the age cap even when it has not expired", async () => {
    // OUR policy, not Privy's. The identity token is a bearer proof of somebody's X identity — whoever
    // holds it can present it with their OWN wallet — and Privy's default lifetime is measured in
    // hours. A fresh token costs a legitimate client nothing, because linking X mints one.
    const h = await harness();
    const tooOld = claims({ iat: NOW - MAX_IDENTITY_TOKEN_AGE_SECONDS - 60, exp: NOW + 3600 });
    expect(await h.verify(await h.signer.mint(tooOld))).toEqual({ kind: "rejected", reason: "stale" });
  });

  it("refuses a token issued in the future beyond the clock skew", async () => {
    const h = await harness();
    const token = await h.signer.mint(claims({ iat: NOW + 3600 }));
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "stale" });
  });

  it("tolerates a minute of clock skew in both directions", async () => {
    const h = await harness();
    expect((await h.verify(await h.signer.mint(claims({ iat: NOW + 30 })))).kind).toBe("ok");
    expect((await h.verify(await h.signer.mint(claims({ exp: NOW - 30 })))).kind).toBe("ok");
  });

  it("requires a subject, and never returns it", async () => {
    // `sub` is Privy's DID. It must be present for the token to be well-formed and it is deliberately
    // not stored: keeping it would put a broker-specific identifier in the register and give us
    // something to migrate if we ever leave Privy.
    const h = await harness();
    expect(await h.verify(await h.signer.mint(claims({ sub: undefined })))).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
    const ok = await h.verify(await h.signer.mint(claims()));
    expect(JSON.stringify(ok)).not.toContain("did:privy");
  });
});

describe("the X account inside the token", () => {
  it("refuses a verified user who has not linked X", async () => {
    // The ordinary "they closed the popup" outcome. Actionable, so the handler says so.
    const h = await harness();
    expect(await h.verify(await h.signer.mint(claims({}, null)))).toEqual({
      kind: "rejected",
      reason: "no-x-account",
    });
  });

  it("refuses an X account with no usable handle", async () => {
    // `username` really is nullable in Privy's own types, and §4.4's answer to display-name
    // impersonation is "always render the @handle" — so an identity with no handle is one this product
    // cannot render honestly and will not store.
    const h = await harness();
    for (const username of [null, "", "a".repeat(16), "bad handle", "bad-handle"]) {
      const token = await h.signer.mint(claims({}, { username }));
      expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "unusable-x-account" });
    }
  });

  it("refuses a non-numeric or absent X id", async () => {
    const h = await harness();
    for (const subject of [null, "", "not-a-number", "12345678901234567890123"]) {
      const token = await h.signer.mint(claims({}, { subject }));
      expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "unusable-x-account" });
    }
  });

  it("refuses rather than choosing when two X accounts are present", async () => {
    // Should be unreachable — Privy allows one account per type — and picking the first would mean the
    // register silently records whichever identity serialised earliest, with no way for the player to
    // see or correct it.
    const h = await harness();
    const two = JSON.stringify([
      { type: "twitter_oauth", subject: "1", username: "one", name: "One", lv: 1 },
      { type: "twitter_oauth", subject: "2", username: "two", name: "Two", lv: 2 },
    ]);
    const token = await h.signer.mint(claims({ linked_accounts: two }));
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "unusable-x-account" });
  });

  it("ignores other linked account types", async () => {
    const h = await harness();
    const mixed = JSON.stringify([
      { type: "email", address: "a@b.example", lv: 1 },
      { type: "wallet", address: "0xabc", chain_type: "ethereum", lv: 2 },
      { type: "twitter_oauth", subject: "77", username: "seventyseven", name: "77", pfp: "1/a.jpg", lv: 3 },
    ]);
    const result = await h.verify(await h.signer.mint(claims({ linked_accounts: mixed })));
    expect(result).toEqual({
      kind: "ok",
      identity: {
        xId: "77",
        handle: "seventyseven",
        displayName: "77",
        avatarUrl: "https://pbs.twimg.com/profile_images/1/a.jpg",
      },
    });
  });

  it("calls a `linked_accounts` that is not a string MALFORMED, not `no-x-account`", async () => {
    // The day Privy stops stringifying the array, this must look like a bug in the logs rather than
    // like ordinary traffic — otherwise every player is sent to an X popup that cannot fix it.
    const h = await harness();
    const token = await h.signer.mint(claims({ linked_accounts: [{ type: "twitter_oauth" }] }));
    expect(await h.verify(token)).toEqual({ kind: "rejected", reason: "malformed" });
  });
});

describe("when Privy's keys cannot be read", () => {
  it("fails CLOSED with `keys-unavailable`", async () => {
    // No keys, no links. The alternative — accepting an unverified token because we could not check it —
    // is the one failure mode that would put a stranger's handle on a wallet.
    const h = await harness({ fail: true });
    const signer = await makeSigner(KID);
    expect(await h.verify(await signer.mint(claims()))).toEqual({
      kind: "rejected",
      reason: "keys-unavailable",
    });
  });
});

describe("when the key set has passed its TTL", () => {
  // THE DEFECT THIS COVERS, FOUND IN REVIEW: `keyFor` fell through to `refresh`'s last-good-set
  // fallback once the TTL had passed, so a Privy outage extended the life of a RETIRED key
  // indefinitely — the one event a rotation exists to end, and the opposite of what the class's own
  // header promised. It also refetched on every request while Privy was down, paying the fetch timeout
  // in front of a player's wallet prompt.
  //
  // These tests move the clock, which the rest of this file deliberately does not: everything else pins
  // `nowSec` so signatures are reproducible, and that is exactly why the TTL path had no coverage.
  async function agingHarness(options: { failAfterFirst: boolean }) {
    const signer = await makeSigner(KID);
    let clock = NOW;
    let fetches = 0;
    const cache = new PrivyJwksCache({
      url: privyJwksUrl("https://api.privy.io", APP_ID),
      nowSec: () => clock,
      fetch: (async () => {
        fetches += 1;
        if (options.failAfterFirst && fetches > 1) throw new Error("privy is down");
        return new Response(JSON.stringify({ keys: [signer.publicJwk] }), { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });
    return {
      signer,
      cache,
      fetches: () => fetches,
      advance: (seconds: number) => {
        clock += seconds;
      },
      at: () => clock,
    };
  }

  it("FAILS CLOSED rather than serving a set of unbounded age", async () => {
    const h = await agingHarness({ failAfterFirst: true });
    expect((await h.cache.keyFor(KID)).kind).toBe("ok");

    h.advance(JWKS_TTL_SECONDS + 1);
    expect(await h.cache.keyFor(KID)).toEqual({ kind: "keys-unavailable" });
  });

  it("does not refetch on every request while Privy is unreachable", async () => {
    // One attempt per cooldown, not one per request: otherwise an outage costs every player the fetch
    // timeout and sends Privy a request per link attempt.
    const h = await agingHarness({ failAfterFirst: true });
    await h.cache.keyFor(KID);
    h.advance(JWKS_TTL_SECONDS + 1);
    for (let i = 0; i < 5; i += 1) await h.cache.keyFor(KID);
    expect(h.fetches()).toBe(2);

    h.advance(JWKS_COOLDOWN_SECONDS + 1);
    await h.cache.keyFor(KID);
    expect(h.fetches()).toBe(3);
  });

  it("recovers as soon as a refresh succeeds again", async () => {
    const h = await agingHarness({ failAfterFirst: false });
    await h.cache.keyFor(KID);
    h.advance(JWKS_TTL_SECONDS + 1);
    expect((await h.cache.keyFor(KID)).kind).toBe("ok");
    expect(h.fetches()).toBe(2);
  });

  it("verification reports `keys-unavailable`, so the handler answers 503 and writes nothing", async () => {
    const h = await agingHarness({ failAfterFirst: true });
    const verifier = createPrivyVerifier({ appId: APP_ID, jwks: h.cache });
    const token = await h.signer.mint(claims());
    expect((await verifier.verify(token, h.at())).kind).toBe("ok");

    h.advance(JWKS_TTL_SECONDS + 1);
    const fresh = await h.signer.mint(claims({ iat: h.at() - 5, exp: h.at() + 600 }));
    expect(await verifier.verify(fresh, h.at())).toEqual({ kind: "rejected", reason: "keys-unavailable" });
  });
});

describe("jwksFrom", () => {
  it("reads a P-256 signing key set", () => {
    const set = jwksFrom({
      keys: [{ kty: "EC", crv: "P-256", x: "xx", y: "yy", kid: "k1", use: "sig", alg: "ES256" }],
    });
    expect(set?.get("k1")).toEqual({ kty: "EC", crv: "P-256", x: "xx", y: "yy" });
  });

  it("drops the `kid`, `use` and `alg` fields before import", () => {
    // A JWK carrying a field WebCrypto disagrees with is an import error rather than a verification, and
    // none of the three affects the maths.
    const set = jwksFrom({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "k", alg: "ES256" }] });
    expect(Object.keys(set?.get("k") ?? {}).sort()).toEqual(["crv", "kty", "x", "y"]);
  });

  it("skips keys of other kinds without discarding the ones it can read", () => {
    const set = jwksFrom({
      keys: [
        { kty: "RSA", n: "…", e: "AQAB", kid: "rsa" },
        { kty: "EC", crv: "P-384", x: "x", y: "y", kid: "p384" },
        { kty: "EC", crv: "P-256", x: "x", y: "y", kid: "good" },
      ],
    });
    expect([...(set?.keys() ?? [])]).toEqual(["good"]);
  });

  it("refuses the whole document when a usable key is malformed", () => {
    // A partially-parsed key set is a key set with a hole in it, and the hole is invisible until a
    // rotation lands on it. Same rule as `houseWalletsFrom`.
    expect(jwksFrom({ keys: [{ kty: "EC", crv: "P-256", x: "x", kid: "k" }] })).toBeNull();
    expect(jwksFrom({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] })).toBeNull();
    expect(jwksFrom({ keys: [] })).toBeNull();
    expect(jwksFrom({})).toBeNull();
    expect(jwksFrom(null)).toBeNull();
  });
});

describe("expandTwitterAvatarUrl — Privy's undocumented compression", () => {
  it("expands a path fragment onto X's image CDN", () => {
    expect(expandTwitterAvatarUrl("1899/AbCd_normal.jpg")).toBe(
      "https://pbs.twimg.com/profile_images/1899/AbCd_normal.jpg",
    );
  });

  it("maps X's default egg to NO AVATAR rather than to its URL", () => {
    // It lives on `abs.twimg.com`, a host `avatar_url`'s CHECK does not admit, and the arena's flat
    // side-coloured disc is both better looking and more honest than a grey silhouette.
    expect(expandTwitterAvatarUrl("default_profile_normal.png")).toBeNull();
    expect(expandTwitterAvatarUrl("default_profile_images/default_profile_normal.png")).toBeNull();
  });

  it("passes an already-absolute pbs URL through", () => {
    expect(expandTwitterAvatarUrl("https://pbs.twimg.com/profile_images/1/a.png")).toBe(
      "https://pbs.twimg.com/profile_images/1/a.png",
    );
  });

  it("refuses any host but X's image CDN", () => {
    // The re-check at the end of the function is what makes reimplementing somebody's undocumented
    // encoding safe: whatever it is handed, the only thing it can return is a pbs.twimg.com URL or
    // nothing. Migration 0001's CHECK is the second half of the same guarantee.
    for (const hostile of [
      "https://evil.example/x.png",
      "https://pbs.twimg.com.evil.example/x.png",
      "http://pbs.twimg.com/x.png",
      "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png",
      "//evil.example/x.png",
      "x@evil.example/a.png",
      "a b.png",
      "a\npbs.twimg.com/b.png",
      "%2e%2e/secret",
      "a?b=https://evil.example",
    ]) {
      expect(expandTwitterAvatarUrl(hostile)).toBeNull();
    }
  });

  it("returns null for anything that is not a usable string", () => {
    for (const nothing of [undefined, null, "", "   ", 42, {}, "x".repeat(400)]) {
      expect(expandTwitterAvatarUrl(nothing)).toBeNull();
    }
  });
});

describe("clampDisplayName", () => {
  it("bounds the value at 100 CODE POINTS, matching char_length", () => {
    // Postgres counts characters, so counting UTF-16 units would let a 100-emoji name through as 200
    // and fail the CHECK at the seam.
    expect(clampDisplayName("a".repeat(200))).toHaveLength(100);
    const emoji = clampDisplayName("🦄".repeat(200));
    expect(Array.from(emoji)).toHaveLength(100);
  });

  it("never splits a surrogate pair", () => {
    // A lone surrogate is a string that cannot be encoded as UTF-8 and would fail somewhere further
    // down with a message about bytes.
    const clamped = clampDisplayName(`${"a".repeat(99)}🦄🦄`);
    expect(clamped.endsWith("🦄")).toBe(true);
    // A UTF-8 ROUND TRIP rather than `String.isWellFormed`, which is ES2024 and this project's
    // serverless `lib` is ES2023 (see the note on `GeneratedKeyPair` for why that is not being widened
    // for one method). The round trip asks the same question more directly anyway: a lone surrogate is
    // not encodable, so `TextEncoder` replaces it with U+FFFD and the strings stop matching.
    expect(new TextDecoder().decode(new TextEncoder().encode(clamped))).toBe(clamped);
  });

  it("treats a missing display name as the empty string, which is the wire's absence", () => {
    expect(clampDisplayName(undefined)).toBe("");
    expect(clampDisplayName(null)).toBe("");
    expect(clampDisplayName(123)).toBe("");
    expect(clampDisplayName("  spaced  ")).toBe("spaced");
  });
});

describe("xIdentityFromClaims", () => {
  let payload: Record<string, unknown>;
  beforeEach(() => {
    payload = claims();
  });

  it("is pure — it does not verify anything, and is only ever called AFTER the signature", () => {
    // Documented here because the ordering is the security property: `createPrivyVerifier` calls this
    // last, so no field of an unverified token is ever used for anything but deciding to refuse it.
    expect(xIdentityFromClaims(payload).kind).toBe("ok");
  });

  it("refuses a claim that is not JSON at all", () => {
    expect(xIdentityFromClaims({ ...payload, linked_accounts: "{not json" })).toEqual({
      kind: "rejected",
      reason: "malformed",
    });
  });
});
