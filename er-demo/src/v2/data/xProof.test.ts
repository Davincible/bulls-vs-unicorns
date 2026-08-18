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

import { describe, expect, it, vi } from "vitest";
import {
  identityTokenKeys,
  IDENTITY_TOKEN_COOKIE,
  proofFromCookie,
  proofFromOutcome,
  ProofUnavailableError,
  tokenFromStoredValue,
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

  it("scopes the first key by app id — a probe that is kept only because it is free", () => {
    // THIS ASSERTION IS ABOUT THE FUNCTION, NOT ABOUT PRIVY, and the difference was the bug. The
    // sentence that used to be here claimed this key isolates two Privy apps sharing an origin. It
    // does not: the shipped SDK scopes by the Privy USER DID (`privy:<did:privy:…>:id-token`) and
    // writes the unscoped `privy:id-token` beside it unconditionally, so this key has never matched
    // anything and two apps on one origin DO share the unscoped one. See `xProof.ts`'s header.
    expect(identityTokenKeys("production-app")[0]).not.toBe(identityTokenKeys("preview-app")[0]);
  });

  it("always ends with the key the SDK actually writes", () => {
    // The one that matters. If a future change reorders or drops it, the raw fallback read stops
    // finding anything and nobody notices until the SDK path is also broken — which is the only
    // moment the fallback is ever reached.
    expect(identityTokenKeys("anything").at(-1)).toBe("privy:id-token");
    expect(identityTokenKeys(undefined).at(-1)).toBe("privy:id-token");
  });
});

describe("tokenFromStoredValue", () => {
  it("unwraps the JSON quoting the SDK's own LocalStorage adds", () => {
    // `LocalStorage.put` is `localStorage.setItem(k, JSON.stringify(v))`, so a stored token reads
    // back as `"eyJ…"` — five extra bytes that fail the compact-JWS shape check. This is the exact
    // reason the raw localStorage read never worked and the cookie fallback was silently carrying
    // this whole module.
    expect(tokenFromStoredValue(JSON.stringify(TOKEN))).toBe(TOKEN);
  });

  it("accepts a bare token too, because that is what the cookie and older writers hold", () => {
    expect(tokenFromStoredValue(TOKEN)).toBe(TOKEN);
  });

  it("refuses anything that is not a token, quoted or not", () => {
    for (const junk of ["", "not-a-token", "one.two", "a.b.c.d", "eyJ...", "a b.c.d"]) {
      expect(tokenFromStoredValue(junk)).toBeNull();
      expect(tokenFromStoredValue(JSON.stringify(junk))).toBeNull();
    }
  });

  it("refuses a stored value that parses to something other than a string", () => {
    // A key that holds an object or a number is a key that means something else. Passing it through
    // would spend one of the player's rate-limited attempts to be told `bad-proof`.
    expect(tokenFromStoredValue('{"token":"x"}')).toBeNull();
    expect(tokenFromStoredValue("12345")).toBeNull();
    expect(tokenFromStoredValue("null")).toBeNull();
  });

  it("survives a truncated JSON string rather than throwing", () => {
    // A half-written localStorage value — a tab killed mid-write — must not surface as a chunk-load
    // failure, which the ceremony reports as a generic outage.
    expect(() => tokenFromStoredValue('"eyJ')).not.toThrow();
    expect(tokenFromStoredValue('"eyJ')).toBeNull();
  });

  it("returns null for an absent value and a non-string", () => {
    expect(tokenFromStoredValue(null)).toBeNull();
    expect(tokenFromStoredValue(undefined as unknown as string)).toBeNull();
  });
});

describe("proofFromOutcome", () => {
  it("hands a proof through verbatim", () => {
    // VERBATIM IS THE CONTRACT. Not a fragment, not a rewrapped version — the server verifies the
    // signature over these exact bytes.
    expect(proofFromOutcome({ kind: "proof", token: TOKEN })).toBe(TOKEN);
  });

  it("turns a closed window into null, which the ceremony reads as `cancelled`", () => {
    expect(proofFromOutcome({ kind: "cancelled" })).toBeNull();
  });

  it("turns a fault into ProofUnavailableError, which the ceremony reads as `unavailable`", () => {
    // THE DISTINCTION THIS WHOLE SPLIT EXISTS FOR. A configuration fault reported as `cancelled`
    // tells a player they closed a window they never saw, and sends them to try again for ever
    // against something that cannot succeed.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => proofFromOutcome({ kind: "unavailable", why: "the toggle is off." })).toThrow(
        ProofUnavailableError,
      );
      expect(logged).toHaveBeenCalledOnce();
    } finally {
      logged.mockRestore();
    }
  });

  it("never puts a token in the log line or the error", () => {
    // `why` is built by `xPrivy.ts` from causes only, and every call it wraps runs before a token
    // exists. This pins the property rather than trusting that it stays true.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        proofFromOutcome({ kind: "unavailable", why: "Privy issued no identity token." }),
      ).toThrow(/no identity token/);
      const said = logged.mock.calls.flat().join(" ").toLowerCase();
      expect(said).not.toContain("eyj");
    } finally {
      logged.mockRestore();
    }
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
