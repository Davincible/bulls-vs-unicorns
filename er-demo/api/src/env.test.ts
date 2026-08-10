import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  CLIENT_TRUSTED_KEYS_ENV,
  DEFAULT_KEEPER_STATUS_URL,
  decodeSecret,
  keeperStatusUrl,
  loadAttestationKey,
  requireDatabaseUrl,
  SECRET_ENV,
} from "./env.ts";
import { TEST_SECRET } from "./testKit.ts";

const b64 = (b: Uint8Array): string => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
};
const b58 = (b: Uint8Array): string => new PublicKey(b).toBase58();

describe("loadAttestationKey", () => {
  it("REFUSES TO START when the secret is missing", () => {
    // "A server that silently signs with a zero key is worse than one that 500s." A missing secret
    // produces signatures that verify against nothing; `linkMapFrom` drops every one of them as
    // `bad-signature`; and the leaderboard renders exactly as it does when nobody has linked. There
    // is no screen anywhere that would show the difference — so the difference has to be a cold-start
    // throw, at the origin, on the first request after the deploy.
    expect(() => loadAttestationKey({})).toThrow(SECRET_ENV);
    expect(() => loadAttestationKey({ [SECRET_ENV]: "   " })).toThrow(SECRET_ENV);
  });

  it("refuses a secret of the wrong length, and says what length it got", () => {
    // "Wrong length" without the number sends the next person to re-read the generator instead of
    // counting their paste.
    expect(() => loadAttestationKey({ [SECRET_ENV]: b64(new Uint8Array(31)) })).toThrow();
    expect(() => loadAttestationKey({ [SECRET_ENV]: b58(new Uint8Array(32)).slice(0, 10) })).toThrow();
    expect(() => decodeSecret(b64(new Uint8Array(16)), "X")).toThrow(/32 bytes/);
  });

  it("refuses a secret that is neither base64 nor base58", () => {
    expect(() => loadAttestationKey({ [SECRET_ENV]: "!!! not a key !!!" })).toThrow();
  });

  it("accepts base64 and base58 and derives the SAME public key from both", () => {
    // The two encodings of 32 bytes are distinguishable without ambiguity — base64 always ends in
    // `=` at this length and base58 can never contain one — so accepting both is deterministic
    // rather than a guess.
    const fromB64 = loadAttestationKey({ [SECRET_ENV]: b64(TEST_SECRET) });
    const fromB58 = loadAttestationKey({ [SECRET_ENV]: b58(TEST_SECRET) });
    expect(fromB64.publicKey).toBe(fromB58.publicKey);
    expect(fromB64.secret).toEqual(TEST_SECRET);
  });

  it("accepts base64url, because that is what most command-line tools emit", () => {
    // Otherwise a correct paste fails with a message about base58 and the operator goes hunting.
    const url = b64(TEST_SECRET).replace(/\+/g, "-").replace(/\//g, "_");
    expect(loadAttestationKey({ [SECRET_ENV]: url }).publicKey).toBe(loadAttestationKey({ [SECRET_ENV]: b64(TEST_SECRET) }).publicKey);
  });

  it("tolerates surrounding whitespace from a copy-paste", () => {
    expect(loadAttestationKey({ [SECRET_ENV]: `\n  ${b58(TEST_SECRET)}  \n` }).secret).toEqual(TEST_SECRET);
  });

  it("takes its environment as a parameter rather than reading process.env", () => {
    // A test that sets and unsets `process.env` leaks into whatever runs next in the same worker.
    expect(() => loadAttestationKey({})).toThrow();
    expect(process.env[SECRET_ENV]).toBeUndefined();
  });
});

describe("requireDatabaseUrl", () => {
  it("refuses to start without one", () => {
    // Same argument as the signing key: a store that cannot connect degrades to "nobody has linked",
    // which no screen can show as broken.
    expect(() => requireDatabaseUrl({})).toThrow("DATABASE_URL");
    expect(requireDatabaseUrl({ DATABASE_URL: " postgres://x " })).toBe("postgres://x");
  });
});

describe("keeperStatusUrl", () => {
  it("defaults to the keeper's LIVE endpoint, never the committed snapshot", () => {
    // `er-demo/public/keeper-status.json` is a build artefact and goes stale; a stale house list is
    // precisely a house wallet that can wear a face.
    expect(keeperStatusUrl({})).toBe(DEFAULT_KEEPER_STATUS_URL);
    expect(DEFAULT_KEEPER_STATUS_URL).toMatch(/^https:\/\/bulls-arena-keeper-devnet\.fly\.dev\//);
    expect(keeperStatusUrl({ KEEPER_STATUS_URL: "https://other/x.json" })).toBe("https://other/x.json");
  });

  it("is NOT a VITE_ variable, so it can never be inlined into the public bundle", () => {
    // `VITE_` is the entire mechanism by which a value ships to every browser. The client's own
    // trusted-key list is the only half of this feature that belongs there.
    expect(keeperStatusUrl.toString()).not.toContain("VITE_");
    expect(CLIENT_TRUSTED_KEYS_ENV.startsWith("VITE_")).toBe(true);
    expect(SECRET_ENV.startsWith("VITE_")).toBe(false);
  });
});
