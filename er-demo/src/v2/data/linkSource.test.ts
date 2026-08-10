// THE DEFECT THIS FILE EXISTS TO PREVENT IS THE PUBLISHED SEED SIGNING ITS WAY ONTO PRODUCTION.
//
// `xLink.test.ts` proves that a record has to be signed by a trusted key. This file is about WHICH
// keys those are, and there are two sets that must never touch:
//
//   * the MOCK key, whose seed phrase is printed in `linkSource.ts` four lines above it, so anybody
//     who has ever opened this repository can sign an attestation with it;
//   * the PRODUCTION key(s), from `VITE_LINK_ATTESTATION_KEYS`, generated offline.
//
// If those sets are ever unioned — by a default parameter, by a fallback, by an `??` written in a
// hurry to make development work — then that published seed becomes a way to put any handle on any
// wallet on the live site, and `xLink.ts`'s entire signature apparatus verifies the forgery
// correctly. There is no symptom. The face is simply wrong, and it verifies.
//
// So the assertions below are set-theoretic rather than by inspection: the intersection is computed,
// not eyeballed, and it is computed against a production set that is deliberately NON-EMPTY, because
// a disjointness proof against an empty set proves nothing. Two more failure modes get their own
// cases because both look like working software:
//
//   * `VITE_LINK_ATTESTATION_KEYS` unset in a production build — must yield NO keys and therefore no
//     faces, never a fallback to the mock key. Failing closed here is the whole safety argument.
//   * the committed `MOCK_ATTESTATION_PUBLIC_KEY` literal drifting from the seed it claims to be the
//     public half of — after which `?links=mock` renders everybody unlinked, which is also exactly
//     what a correctly-working unlinked board looks like, so nobody notices for a month.
//
// And `parseLinksFlag`, which is smaller than it looks: it is the function that DECIDES WHICH TRUST
// SET IS IN PLAY, so a typo it accepted charitably would be a typo that selected a different set of
// keys. Every unrecognised spelling is `off`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import {
  LINK_SOURCE,
  MOCK_ATTESTATION_PUBLIC_KEY,
  MOCK_ATTESTATION_SEED,
  linksUrlFor,
  parseLinksFlag,
  parseTrustedKeys,
  trustedKeysFor,
  type LinkSource,
} from "./linkSource.ts";

/** A real ed25519 public key, base58 — the shape a production trust anchor actually has, so the
 *  disjointness cases are not comparing the mock key against two made-up strings. */
function publicKeyFrom(seedPhrase: string): string {
  const secret = sha256(new TextEncoder().encode(seedPhrase));
  return new PublicKey(ed25519.getPublicKey(secret)).toBase58();
}

const PROD_A = publicKeyFrom("a production attestation key, offline");
const PROD_B = publicKeyFrom("the production key we are rotating to");

/**
 * Load `linkSource.ts` in a different environment.
 *
 * `PRODUCTION_KEYS_RAW` is read ONCE at module load — deliberately, see that file's header — so the
 * only honest way to ask what a differently-configured build would trust is to build one. `null`
 * means the variable is not set at all, which is the production misconfiguration case.
 */
async function loadWithProductionKeys(raw: string | null) {
  vi.stubEnv("VITE_LINK_ATTESTATION_KEYS", raw === null ? (undefined as unknown as string) : raw);
  vi.resetModules();
  return await import("./linkSource.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("parseLinksFlag", () => {
  // ANYTHING UNRECOGNISED IS `off`. Not "closest match", not "probably meant mock". The flag chooses
  // a trust set, so a charitable reading of a typo is a charitable reading of which keys to believe.
  const cases: ReadonlyArray<[string, LinkSource]> = [
    ["?links=mock", "mock"],
    ["?links=api", "api"],
    // `window.location.search` carries its `?`; a hand-built string or a copied fragment may not.
    ["links=mock", "mock"],
    ["links=api", "api"],
    // Case, because a URL a human typed or a chat client title-cased must still land somewhere sane.
    ["?links=MOCK", "mock"],
    ["?links=Api", "api"],
    ["?links=aPi", "api"],
    // The flag among others, which is how it will actually arrive.
    ["?theme=neon&links=mock", "mock"],
    ["?links=api&fixture=1", "api"],
    // Absent.
    ["", "off"],
    ["?", "off"],
    ["?fixture=1", "off"],
    // Present and empty.
    ["?links=", "off"],
    // Typos and near-misses. Each of these is a spelling somebody will produce, and each must fail
    // to a source that trusts NO keys rather than to the nearest one that trusts some.
    ["?links=moc", "off"],
    ["?links=mocks", "off"],
    ["?links=mok", "off"],
    ["?links=apis", "off"],
    ["?links=ap", "off"],
    ["?links=%20mock", "off"],
    ["?links=mock%20", "off"],
    ["?links=1", "off"],
    ["?links=on", "off"],
    ["?links=true", "off"],
    ["?links=yes", "off"],
    ["?links=production", "off"],
    ["?links=prod", "off"],
    ["?links=real", "off"],
    // A near-miss on the KEY rather than the value: `?linkss=mock` must not be read as `links`.
    ["?linkss=mock", "off"],
    ["?link=mock", "off"],
    ["?LINKS=mock", "off"],
    // And the explicit spelling of the default, which has to keep working because it is what a
    // shared link turning the feature off looks like.
    ["?links=off", "off"],
  ];

  for (const [search, expected] of cases) {
    it(`reads ${JSON.stringify(search)} as ${expected}`, () => {
      expect(parseLinksFlag(search)).toBe(expected);
    });
  }

  it("answers the first spelling when the parameter appears twice", () => {
    // Query strings get concatenated — by a share sheet, by a redirect, by hand. Whatever the rule
    // is it has to be deterministic and it has to be the one a reader of the URL would predict, so:
    // first wins, and a second `links=` appended to somebody's link cannot raise the trust set.
    expect(parseLinksFlag("?links=off&links=api")).toBe("off");
    expect(parseLinksFlag("?links=api&links=mock")).toBe("api");
  });

  it("is `off` under Node, where there is no window to read a flag from", () => {
    // `linkSource.ts` is imported by every mode and reads `window.location.search` through a guard.
    // If that guard regressed, importing this module from a test — or from any non-browser context —
    // would throw at load, and the failure would be an entire test file, not one assertion.
    expect(LINK_SOURCE).toBe("off");
  });
});

describe("the mock and production key sets are disjoint", () => {
  it("shares no key with a production set configured", async () => {
    const m = await loadWithProductionKeys(`${PROD_A},${PROD_B}`);
    const mock = new Set(m.trustedKeysFor("mock"));
    const api = new Set(m.trustedKeysFor("api"));
    // Both sets non-empty first, or the intersection below is vacuously empty and proves nothing.
    expect(mock.size).toBe(1);
    expect(api.size).toBe(2);
    expect([...api].filter((k) => mock.has(k))).toEqual([]);
    expect([...mock].filter((k) => api.has(k))).toEqual([]);
  });

  it("stays disjoint through a rotation set of several keys", async () => {
    const m = await loadWithProductionKeys(
      [PROD_A, PROD_B, publicKeyFrom("a third"), publicKeyFrom("a fourth")].join(","),
    );
    const api = new Set(m.trustedKeysFor("api"));
    expect(api.size).toBe(4);
    expect(api.has(m.MOCK_ATTESTATION_PUBLIC_KEY)).toBe(false);
  });

  it("is disjoint under the configuration this repository is checked out with", async () => {
    // The other half, and the one that catches a person rather than a compiler: somebody pasting the
    // published mock key into `.env`, `.env.local` or the Vercel project "so the fixture works in
    // staging". That is not a code change and no type would stop it; it is exactly the union this
    // file exists to forbid, arriving through configuration.
    expect(trustedKeysFor("api")).not.toContain(MOCK_ATTESTATION_PUBLIC_KEY);
  });
});

describe("`api` fails closed", () => {
  it("trusts nothing when the environment variable is unset, and does NOT fall back to the mock key", async () => {
    // THE PRODUCTION MISCONFIGURATION. A build that forgot the env var must render every player
    // unlinked — which is `TWITTER-CONNECT.md` §8's main path and is indistinguishable from a board
    // where nobody linked — rather than quietly trusting a key whose secret is in this repository.
    const m = await loadWithProductionKeys(null);
    expect(m.trustedKeysFor("api")).toEqual([]);
    expect(m.trustedKeysFor("api")).not.toContain(m.MOCK_ATTESTATION_PUBLIC_KEY);
  });

  const emptyish: ReadonlyArray<[string, string]> = [
    ["an empty value", ""],
    ["whitespace", "   "],
    ["a lone comma, left by deleting the only key", ","],
    ["commas and spaces", " , , "],
    ["a newline, which is what a textarea in a hosting dashboard yields", "\n"],
  ];

  for (const [what, raw] of emptyish) {
    it(`trusts nothing when the environment variable holds ${what}`, async () => {
      const m = await loadWithProductionKeys(raw);
      expect(m.trustedKeysFor("api")).toEqual([]);
    });
  }
});

describe("`off` trusts nothing", () => {
  it("returns an empty set", () => {
    expect(trustedKeysFor("off")).toEqual([]);
  });

  it("stays empty even when a production set IS configured", async () => {
    // `off` is the default for every visitor. If it ever became "api by another name" the feature
    // would ship to everybody the moment the env var was set, without a deploy that said so.
    const m = await loadWithProductionKeys(`${PROD_A},${PROD_B}`);
    expect(m.trustedKeysFor("off")).toEqual([]);
  });
});

describe("MOCK_ATTESTATION_PUBLIC_KEY", () => {
  it("is the public half of the seed committed beside it", () => {
    // The literal is committed rather than derived so that `linkSource.ts` — which every mode
    // imports — pulls in no hash and no curve. That trade is only safe if the two cannot drift, and
    // this is the assertion that makes it so. Drift has NO symptom: `?links=mock` would verify
    // nothing, every fixture face would vanish, and an unlinked board is what a correct unlinked
    // board looks like. `mockLinks.ts` and `scripts/make-mock-links.mjs` both derive the signer from
    // the seed, so the seed is the source of truth and the literal is the copy.
    const derived = new PublicKey(
      ed25519.getPublicKey(sha256(new TextEncoder().encode(MOCK_ATTESTATION_SEED))),
    ).toBase58();
    expect(MOCK_ATTESTATION_PUBLIC_KEY).toBe(derived);
  });

  it("is the only key `mock` trusts", () => {
    expect(trustedKeysFor("mock")).toEqual([MOCK_ATTESTATION_PUBLIC_KEY]);
  });
});

describe("parseTrustedKeys", () => {
  it("splits a rotation set", () => {
    expect(parseTrustedKeys(`${PROD_A},${PROD_B}`)).toEqual([PROD_A, PROD_B]);
  });

  it("survives the shapes an environment variable actually arrives in", () => {
    expect(parseTrustedKeys(`${PROD_A},`)).toEqual([PROD_A]);
    expect(parseTrustedKeys(`,${PROD_A}`)).toEqual([PROD_A]);
    expect(parseTrustedKeys(` ${PROD_A} , ${PROD_B} `)).toEqual([PROD_A, PROD_B]);
    expect(parseTrustedKeys(`${PROD_A},,${PROD_B}`)).toEqual([PROD_A, PROD_B]);
    expect(parseTrustedKeys(`${PROD_A}\n`)).toEqual([PROD_A]);
    expect(parseTrustedKeys(`\t${PROD_A}\t,\n${PROD_B}\n`)).toEqual([PROD_A, PROD_B]);
  });

  it("never yields an empty-string key", () => {
    // THE REASON THE FILTER IS THERE. `verifyAttestation` asks `trustedKeys.includes(a.keyId)`, so an
    // empty string in the set is a trusted key that matches an attestation carrying `keyId: ""` —
    // i.e. one an attacker never had to name. It would then fail on the curve, but only because
    // `attestationKeyBytes("")` happens to return null; a set that cannot contain `""` does not rely
    // on that second line holding.
    const hostile = ["", " ", ",", ",,", " , ", "\n", `,,${PROD_A},,`, `${PROD_A}, ,${PROD_B}`];
    for (const raw of hostile) {
      const keys = parseTrustedKeys(raw);
      expect(keys, raw).not.toContain("");
      expect(keys.every((k) => k.trim().length > 0), raw).toBe(true);
    }
  });
});

describe("linksUrlFor", () => {
  const WALLETS = [
    "F49CkYiWVNFpPxWe9fptXVNcbwnVs1hxBjFtFL2w5nZf",
    "7wkgd4GDGXBYu9GLHPbuJwrdfLU2ByUHSJrHzWTpsCZL",
  ];

  it("fetches nothing at all when the feature is off", () => {
    // Not "fetches and discards". `useLinks.ts` treats null as "no request", so this is the
    // assertion that an off page makes no identity request and therefore tells no server which
    // wallets are on somebody's screen.
    expect(linksUrlFor("off", WALLETS)).toBeNull();
    expect(linksUrlFor("off", [])).toBeNull();
  });

  it("fetches nothing when there is nobody to ask about", () => {
    // There is no enumeration route (`TWITTER-CONNECT.md` §6.4): the wallet list IS the query, so an
    // empty list is not "ask about everyone", it is "do not ask".
    expect(linksUrlFor("api", [])).toBeNull();
  });

  it("reads the mock from a static file in `public/`, with no query", () => {
    // Which is what makes Stage 0 backend-free — and, incidentally, means the mock source sends no
    // wallet list anywhere at all.
    expect(linksUrlFor("mock", WALLETS)).toBe("/links.mock.json");
    expect(linksUrlFor("mock", [])).toBe("/links.mock.json");
  });

  it("encodes the wallet list so it stays one parameter", () => {
    const url = linksUrlFor("api", WALLETS);
    expect(url).toBe(`/api/links?wallets=${encodeURIComponent(WALLETS.join(","))}`);
    const parsed = new URL(url as string, "https://arena.example");
    expect(parsed.pathname).toBe("/api/links");
    expect(parsed.searchParams.get("wallets")).toBe(WALLETS.join(","));
  });

  it("cannot be made to grow a second query parameter by a malformed wallet", () => {
    // The wallet strings come off the round's roster, which comes off chain, and a fighter's wallet
    // is not validated as base58 before it reaches here. Joined raw, a wallet containing `&` or `#`
    // would append a parameter of the attacker's choosing to a request the server trusts the shape
    // of — and `#` would truncate the query outright, turning a 48-wallet ask into a 3-wallet one.
    const hostile = [WALLETS[0], "evil&admin=1", "also#fragment", "q?uestion", "sp ace", "sla/sh"];
    const url = linksUrlFor("api", hostile) as string;
    const parsed = new URL(url, "https://arena.example");
    expect([...parsed.searchParams.keys()]).toEqual(["wallets"]);
    expect(parsed.searchParams.get("wallets")).toBe(hostile.join(","));
    expect(parsed.hash).toBe("");
  });
});
