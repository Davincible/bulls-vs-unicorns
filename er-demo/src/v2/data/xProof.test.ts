// THE PURE HALF OF THE PROOF SOURCE.
//
// `identityProof()` itself reads `document` and `window.localStorage`, and this repository has no
// component-test harness on purpose — every test here is a pure `.ts` module test, with the assembled
// page covered by Playwright in `e2e/`. So this file tests the two pure functions and the one string
// that another file depends on, and does not stand up a DOM to reach the rest.
//
// The cookie parser is worth this much attention for one reason: everything it gets wrong is silent. A
// name that matches too loosely sends the wrong value to the server and the player is told their proof
// was bad; a value that fails the shape check is reported as "Privy is not configured" when the truth
// is that it was configured perfectly and this function could not read it.

import { describe, expect, it } from "vitest";
import {
  identityTokenKeys,
  IDENTITY_TOKEN_COOKIE,
  proofFromCookie,
  ProofUnavailableError,
} from "./xProof.ts";

/** Shaped like the real thing — three base64url segments — without being one. */
const TOKEN = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJpc3MiOiJwcml2eS5pbyJ9.c2lnbmF0dXJl-_x";

describe("proofFromCookie", () => {
  it("finds the token when it is the only cookie", () => {
    expect(proofFromCookie(`${IDENTITY_TOKEN_COOKIE}=${TOKEN}`)).toBe(TOKEN);
  });

  it("finds it among others, wherever it sits and however it is spaced", () => {
    // A cookie header is `name=value` pairs separated by `;` with OPTIONAL whitespace. Splitting on
    // `"; "` — the obvious implementation — misses the un-spaced form entirely.
    expect(proofFromCookie(`a=1; ${IDENTITY_TOKEN_COOKIE}=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(proofFromCookie(`a=1;${IDENTITY_TOKEN_COOKIE}=${TOKEN};b=2`)).toBe(TOKEN);
    expect(proofFromCookie(`  ${IDENTITY_TOKEN_COOKIE}  =  ${TOKEN}  `)).toBe(TOKEN);
    expect(proofFromCookie(`privy-token=other; ${IDENTITY_TOKEN_COOKIE}=${TOKEN}`)).toBe(TOKEN);
  });

  it("does not match a name that merely ENDS with ours", () => {
    // `not-privy-id-token=…` contains the name as a substring. A `includes`-based parser hands the
    // server somebody else's value and the player is told their proof was bad.
    expect(proofFromCookie(`not-${IDENTITY_TOKEN_COOKIE}=${TOKEN}`)).toBeNull();
    expect(proofFromCookie(`x${IDENTITY_TOKEN_COOKIE}=${TOKEN}`)).toBeNull();
  });

  it("does not match a name that merely STARTS with ours", () => {
    expect(proofFromCookie(`${IDENTITY_TOKEN_COOKIE}-old=${TOKEN}`)).toBeNull();
  });

  it("percent-decodes, because a spec-following writer encodes", () => {
    expect(proofFromCookie(`${IDENTITY_TOKEN_COOKIE}=${encodeURIComponent(TOKEN)}`)).toBe(TOKEN);
  });

  it("survives a malformed percent-escape rather than throwing", () => {
    // `decodeURIComponent("%")` throws a URIError. Inside a dynamically imported module that would
    // surface as a chunk failure, which reads as an outage rather than as a bad cookie.
    expect(() => proofFromCookie(`${IDENTITY_TOKEN_COOKIE}=%`)).not.toThrow();
    expect(proofFromCookie(`${IDENTITY_TOKEN_COOKIE}=%`)).toBeNull();
  });

  it("refuses a value that is not shaped like a compact JWS", () => {
    // Not a validation — the server verifies the signature and every claim. This only catches a cookie
    // holding something else entirely, which is worth refusing here because sending it would spend one
    // of the player's rate-limited attempts to be told `bad-proof`.
    for (const junk of ["", "not-a-token", "one.two", "a.b.c.d", '{"jwt":"x"}', "eyJ...", "a b.c.d"]) {
      expect(proofFromCookie(`${IDENTITY_TOKEN_COOKIE}=${junk}`)).toBeNull();
    }
  });

  it("returns null for an absent cookie, an empty header and a non-string", () => {
    expect(proofFromCookie("")).toBeNull();
    expect(proofFromCookie("a=1; b=2")).toBeNull();
    expect(proofFromCookie("no-equals-sign")).toBeNull();
    expect(proofFromCookie(undefined as unknown as string)).toBeNull();
  });

  it("never returns a value from a pair with no separator", () => {
    expect(proofFromCookie(`${IDENTITY_TOKEN_COOKIE}`)).toBeNull();
  });
});

describe("identityTokenKeys", () => {
  it("prefers the app-scoped key and always offers the SDK's unscoped fallback", () => {
    expect(identityTokenKeys("cmsnbbun8007m0cjxbfx762sw")).toEqual([
      "privy:cmsnbbun8007m0cjxbfx762sw:id-token",
      "privy:id-token",
    ]);
  });

  it("falls back to the unscoped key alone when the app id is not built in", () => {
    // `VITE_PRIVY_APP_ID` is inlined at build time and is absent in some environments. A key of
    // `privy:undefined:id-token` would match nothing and hide the fallback that does.
    for (const missing of [undefined, "", "   "]) {
      expect(identityTokenKeys(missing)).toEqual(["privy:id-token"]);
    }
  });

  it("trims, because a pasted env var carries what the clipboard carried", () => {
    expect(identityTokenKeys("  appid  ")[0]).toBe("privy:appid:id-token");
  });

  it("scopes by app id, so two Privy apps on one origin cannot read each other's token", () => {
    // Privy's own advice for `*.vercel.app` previews — which cannot be allowlisted — is a SEPARATE dev
    // app. That puts two apps' tokens in one origin's storage.
    expect(identityTokenKeys("production-app")[0]).not.toBe(identityTokenKeys("preview-app")[0]);
  });
});

describe("ProofUnavailableError", () => {
  it("carries the name another file matches on", () => {
    // `xLinkCeremony.ts` cannot import this class as a value without pulling this chunk into the main
    // bundle, so it recognises the failure by `error.name`. Renaming the class therefore changes
    // behaviour in a file that does not mention it; this is what stops that happening quietly.
    const error = new ProofUnavailableError("nope");
    expect(error.name).toBe("ProofUnavailableError");
    expect(error).toBeInstanceOf(Error);
  });

  it("says nothing about a token, only about configuration", () => {
    // The token is a bearer proof of somebody's X identity. It exists in this program as a return value
    // and nowhere else — not in an error, not in a log line.
    const error = new ProofUnavailableError("no token");
    expect(error.message.toLowerCase()).not.toContain("eyj");
  });
});
