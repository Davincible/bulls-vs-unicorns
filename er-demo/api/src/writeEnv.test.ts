// THE WRITE PATH'S CONFIGURATION. Two rules, and their failures point in opposite directions:
//
//   OFF MEANS NOTHING IS REQUIRED — a deployment that has deliberately not enabled the ceremony must
//   boot and answer 503, not fail its cold start over a Privy app id it has no use for.
//
//   ON MEANS EVERYTHING IS REQUIRED — and the important one is `KEEPER_HOUSE_TOKEN`, because without it
//   §6.3's house-wallet rule cannot be enforced at all. That is the "fails closed when the house token
//   is unset" case, and it fails at COLD START rather than per request, which is the only version of it
//   a human notices.

import { describe, expect, it } from "vitest";
import { DEFAULT_KEEPER_HOUSE_URL, HOUSE_TOKEN_ENV, SECRET_ENV } from "./env.ts";
import { TEST_SECRET } from "./testKit.ts";
import {
  LINK_WRITE_ENV,
  linkWriteEnabled,
  privyApiUrl,
  PRIVY_APP_ID_ENV,
  PRIVY_APP_ID_VITE_ENV,
  requirePrivyAppId,
  writeConfig,
} from "./writeEnv.ts";

const b64 = (b: Uint8Array): string => {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
};

const APP_ID = "cmsnbbun8007m0cjxbfx762sw";
const HOUSE_TOKEN = "h".repeat(32);
const ENABLED = {
  [LINK_WRITE_ENV]: "on",
  [PRIVY_APP_ID_ENV]: APP_ID,
  [HOUSE_TOKEN_ENV]: HOUSE_TOKEN,
};

describe("linkWriteEnabled", () => {
  it("is off unless the value is exactly `on`", () => {
    // The same rule `parseLinksFlag` applies to `?links=`: a mistyped flag must never silently select a
    // code path with different trust in it. On a WRITE path that sentence has money behind it.
    expect(linkWriteEnabled({})).toBe(false);
    for (const near of ["", " ", "1", "true", "yes", "ON", "On", "enabled", "on "]) {
      expect(linkWriteEnabled({ [LINK_WRITE_ENV]: near })).toBe(false);
    }
    expect(linkWriteEnabled({ [LINK_WRITE_ENV]: "on" })).toBe(true);
  });

  it("is not `VITE_`-prefixed — a caller must not be able to see or set it", () => {
    expect(LINK_WRITE_ENV.startsWith("VITE_")).toBe(false);
  });
});

describe("requirePrivyAppId", () => {
  it("accepts the client's own variable name, because the app id is public by construction", () => {
    // It is compiled into the browser bundle and appears in every request to privy.io, so reading the
    // `VITE_`-prefixed one costs nothing — and one value under two names beats two variables that can
    // disagree. The app SECRET may never be spelled that way, and never is.
    expect(requirePrivyAppId({ [PRIVY_APP_ID_ENV]: APP_ID })).toBe(APP_ID);
    expect(requirePrivyAppId({ [PRIVY_APP_ID_VITE_ENV]: APP_ID })).toBe(APP_ID);
    expect(requirePrivyAppId({ [PRIVY_APP_ID_ENV]: `  ${APP_ID}\n` })).toBe(APP_ID);
  });

  it("prefers the unprefixed name when both are set", () => {
    expect(requirePrivyAppId({ [PRIVY_APP_ID_ENV]: APP_ID, [PRIVY_APP_ID_VITE_ENV]: "other" })).toBe(APP_ID);
  });

  it("REFUSES TO START without one", () => {
    // No app id means no audience to compare and no JWKS URL to fetch, so every link is refused while
    // `/api/links` keeps answering 200 with an empty list — indistinguishable from "nobody has linked".
    expect(() => requirePrivyAppId({})).toThrow(PRIVY_APP_ID_ENV);
    expect(() => requirePrivyAppId({ [PRIVY_APP_ID_ENV]: "  " })).toThrow(PRIVY_APP_ID_ENV);
  });

  it("refuses a value that is not shaped like an app id", () => {
    // It goes into a URL and into an audience comparison, so it is checked rather than trusted.
    for (const bad of ["short", "UPPERCASE1234567890", "has spaces in it 12", `${APP_ID}\nX-Injected: 1`]) {
      expect(() => requirePrivyAppId({ [PRIVY_APP_ID_ENV]: bad })).toThrow();
    }
  });
});

describe("privyApiUrl", () => {
  it("defaults to Privy's API origin — an address, not a credential", () => {
    expect(privyApiUrl({})).toBe("https://api.privy.io");
    expect(privyApiUrl({ PRIVY_API_URL: "https://staging.example" })).toBe("https://staging.example");
  });
});

describe("writeConfig", () => {
  it("returns NOTHING when the gate is off, and demands nothing else", () => {
    // The whole point of the gate. A disabled deployment reads no app id, no house token and no database
    // URL: it boots, and `/api/x/*` answers 503.
    expect(writeConfig({})).toBeNull();
    expect(writeConfig({ [LINK_WRITE_ENV]: "off" })).toBeNull();
    // Not even a deployment with nothing else configured at all throws while it is off.
    expect(() => writeConfig({ [LINK_WRITE_ENV]: "" })).not.toThrow();
  });

  it("FAILS CLOSED AT COLD START when the house token is unset and the gate is on", () => {
    // §6.3 cannot be enforced without the roster, and the failure is otherwise invisible: the route
    // would 503 every link forever while looking, from outside, exactly like a keeper hiccup.
    expect(() => writeConfig({ [LINK_WRITE_ENV]: "on", [PRIVY_APP_ID_ENV]: APP_ID })).toThrow(
      HOUSE_TOKEN_ENV,
    );
    expect(() =>
      writeConfig({ [LINK_WRITE_ENV]: "on", [PRIVY_APP_ID_ENV]: APP_ID, [HOUSE_TOKEN_ENV]: "" }),
    ).toThrow(HOUSE_TOKEN_ENV);
  });

  it("also refuses to start without a Privy app id", () => {
    expect(() => writeConfig({ [LINK_WRITE_ENV]: "on", [HOUSE_TOKEN_ENV]: HOUSE_TOKEN })).toThrow(
      PRIVY_APP_ID_ENV,
    );
  });

  it("resolves the JWKS URL and the roster URL when everything is present", () => {
    const config = writeConfig(ENABLED);
    expect(config?.privyAppId).toBe(APP_ID);
    expect(config?.privyJwksUrl).toBe(`https://api.privy.io/v1/apps/${APP_ID}/jwks.json`);
    expect(config?.houseUrl).toBe(DEFAULT_KEEPER_HOUSE_URL);
    expect(config?.houseToken).toBe(HOUSE_TOKEN);
  });

  it("derives a rate-limit key that is neither the token nor anything containing it", () => {
    // `rateLimit.ts` argues at length why the bucket secret comes from the house token by HMAC rather
    // than from a new variable or from the attestation signing key. This is the part worth asserting: the
    // derived value is 32 bytes and does not carry its input.
    const config = writeConfig(ENABLED);
    expect(config?.bucketSecret).toHaveLength(32);
    expect(new TextDecoder().decode(config?.bucketSecret)).not.toContain(HOUSE_TOKEN);
  });

  it("does NOT load the attestation signing key", () => {
    // The write path must not hold the key that signs attestations: it is the most attacker-exposed code
    // in this feature, and a compromise there should not escalate from "can write junk rows the read path
    // filters" to "can mint an identity for any wallet".
    const config = writeConfig({ ...ENABLED, [SECRET_ENV]: b64(TEST_SECRET) });
    expect(Object.keys(config ?? {})).not.toContain("key");
    expect(JSON.stringify(config)).not.toContain(b64(TEST_SECRET));
  });
});
