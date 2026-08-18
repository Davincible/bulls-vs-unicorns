// THE PURE HALF OF THE LOGIN TRIGGER.
//
// `identityTokenViaPrivy()` opens windows, polls them and talks to `auth.privy.io`; none of that is
// reachable from `npx vitest run` and this repository has no component-test harness on purpose
// (`xProof.test.ts` says so at the top). So what is tested here is what the OAuth leg DECIDES, pulled
// out into pure functions for exactly that reason — and every one of these decisions has a failure
// mode that is silent if it is wrong.
//
// The three worth stating:
//
//   * `callbackParams` runs on EVERY POLL of a window that is mostly cross-origin, so a false positive
//     ends the flow early with a half-formed exchange, and a false negative leaves the player looking
//     at a finished X page while the ceremony waits five minutes for a timeout.
//   * `hasXAccount` decides whether a window opens at all. Wrong in one direction it opens a window
//     somebody did not need; wrong in the other it sends a token with no X in it to the server, which
//     answers `no-x-account`, which `xLinkCeremony.ts` maps to `cancelled` — telling a player they
//     closed a window that was never opened.
//   * `appIdOf` decides whether there is a Privy app at all. Its whole job is to turn "the build has
//     no `VITE_PRIVY_APP_ID`" into a named cause instead of a stack trace from inside the SDK.

import { describe, expect, it } from "vitest";
import {
  appIdOf,
  callbackParams,
  hasXAccount,
  paramNames,
  refreshRejectedTheSession,
  X_CALLBACK_PATH,
} from "./xPrivy.ts";

describe("callbackParams", () => {
  it("reads the pair Privy appends to the redirect", () => {
    // These parameter names are not a guess: they are what the previous build already read
    // successfully from this same Privy app (`web/index.html:2911`).
    expect(callbackParams("?privy_oauth_code=abc&privy_oauth_state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("does not care about order, extra parameters, or a missing leading question mark", () => {
    expect(callbackParams("privy_oauth_state=s&privy_oauth_code=c")).toEqual({
      code: "c",
      state: "s",
    });
    expect(callbackParams("?theme=dark&privy_oauth_code=c&privy_oauth_state=s&links=1")).toEqual({
      code: "c",
      state: "s",
    });
  });

  it("percent-decodes, because a code is put into a URL by somebody else's server", () => {
    expect(callbackParams("?privy_oauth_code=a%2Bb%2Fc&privy_oauth_state=s")).toEqual({
      code: "a+b/c",
      state: "s",
    });
  });

  it("REFUSES A CODE WITHOUT A STATE, and that refusal is the anti-phishing check's precondition", () => {
    // `loginWithCode` compares the returned state against the one it stored before the redirect and
    // throws `pkce_state_code_mismatch` when they differ. Handing it an empty state would turn that
    // check into a comparison nobody can fail meaningfully, so the pair is required whole.
    expect(callbackParams("?privy_oauth_code=abc")).toBeNull();
    expect(callbackParams("?privy_oauth_state=xyz")).toBeNull();
    expect(callbackParams("?privy_oauth_code=abc&privy_oauth_state=")).toBeNull();
    expect(callbackParams("?privy_oauth_code=&privy_oauth_state=xyz")).toBeNull();
  });

  it("returns null for everything the poll sees while the player is still on X", () => {
    // THE COMMON CASE BY A DISTANCE. The popup starts on our own callback page with no query at all,
    // and this function is asked about it several times a second until the round trip finishes.
    expect(callbackParams("")).toBeNull();
    expect(callbackParams("?")).toBeNull();
    expect(callbackParams("?something=else")).toBeNull();
    expect(callbackParams(undefined as unknown as string)).toBeNull();
    expect(callbackParams(null as unknown as string)).toBeNull();
  });

  it("does not match a parameter whose name merely contains ours", () => {
    // The same class of defect `proofFromCookie` guards against, in the other half of this feature.
    expect(callbackParams("?not_privy_oauth_code=c&not_privy_oauth_state=s")).toBeNull();
    expect(callbackParams("?privy_oauth_code_old=c&privy_oauth_state_old=s")).toBeNull();
  });
});

describe("hasXAccount", () => {
  /** The shape Privy returns. Only `type` is read here; the server reads `subject` and `username` out
   *  of the SIGNED token, which is a different object entirely (`api/src/privyIdentity.ts`). */
  const x = { type: "twitter_oauth", subject: "1234567890", username: "someone" };
  const wallet = { type: "wallet", address: "0x0" };

  it("finds the X account wherever it sits in the list", () => {
    expect(hasXAccount({ linked_accounts: [x] })).toBe(true);
    expect(hasXAccount({ linked_accounts: [wallet, x] })).toBe(true);
    expect(hasXAccount({ linked_accounts: [x, wallet] })).toBe(true);
  });

  it("says no for a session with no X in it, which is what sends the player to the login", () => {
    expect(hasXAccount({ linked_accounts: [] })).toBe(false);
    expect(hasXAccount({ linked_accounts: [wallet] })).toBe(false);
  });

  it("matches `twitter_oauth` exactly — the string the server matches on", () => {
    // `api/src/privyIdentity.ts:384` compares `type === "twitter_oauth"`. Privy has never renamed it
    // to anything X-shaped, and neither half of this feature may start guessing that it might.
    for (const type of ["twitter", "x_oauth", "twitter_oauth_v2", "TWITTER_OAUTH", "oauth"]) {
      expect(hasXAccount({ linked_accounts: [{ type }] })).toBe(false);
    }
  });

  it("survives a user object that is missing, empty or malformed rather than throwing", () => {
    // This runs on whatever `user.get()` returned. A throw here would escape as "not
    // ProofUnavailableError", which `xLinkCeremony.ts` reads as the player cancelling.
    expect(hasXAccount(null)).toBe(false);
    expect(hasXAccount(undefined)).toBe(false);
    expect(hasXAccount({})).toBe(false);
    expect(hasXAccount({ linked_accounts: undefined })).toBe(false);
    expect(hasXAccount({ linked_accounts: "twitter_oauth" as unknown as [] })).toBe(false);
    expect(hasXAccount({ linked_accounts: [null as unknown as { type: string }] })).toBe(false);
  });
});

describe("appIdOf", () => {
  it("takes the app id this build was compiled against", () => {
    expect(appIdOf("cmsnbbun8007m0cjxbfx762sw")).toBe("cmsnbbun8007m0cjxbfx762sw");
  });

  it("trims, because a pasted env var carries what the clipboard carried", () => {
    expect(appIdOf("  cmsnbbun8007m0cjxbfx762sw\n")).toBe("cmsnbbun8007m0cjxbfx762sw");
  });

  it("reports absence as null, so it can be named rather than thrown from inside the SDK", () => {
    // `VITE_PRIVY_APP_ID` is inlined at build time and is genuinely absent in some environments — a
    // local `npm run dev` with no `.env`, a branch deploy that predates the variable.
    for (const missing of [undefined, "", "   ", "\t\n"]) {
      expect(appIdOf(missing)).toBeNull();
    }
    expect(appIdOf(null as unknown as string)).toBeNull();
    expect(appIdOf(123 as unknown as string)).toBeNull();
  });
});

describe("refreshRejectedTheSession", () => {
  // WHAT THIS DECIDES IS WHETHER A WHOLE PAGE IS DEGRADED. `sessionRefreshFailed` is only cleared by
  // a successful login or a successful refresh, so answering `true` for a one-second network blip
  // means every later press on that page opens an X window for a player who is already signed in.

  it("says yes only to a 401 — the SDK's own 'these credentials do not work'", () => {
    // `_refreshSession` throws `new PrivyApiError({code: MISSING_OR_INVALID_TOKEN, error: "No tokens
    // found in storage", status: 401})` when the stored credentials are incomplete, and Privy answers
    // 401 when it rejects the refresh token it was given.
    expect(refreshRejectedTheSession({ status: 401, code: "missing_or_invalid_token" })).toBe(true);
  });

  it("says no to everything transient, because none of it is about the session", () => {
    expect(refreshRejectedTheSession({ status: 500 })).toBe(false);
    expect(refreshRejectedTheSession({ status: 503 })).toBe(false);
    expect(refreshRejectedTheSession({ status: 429 })).toBe(false);
    expect(refreshRejectedTheSession(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("says no when there is no status at all, which is the safe direction", () => {
    // The cost of not latching is one bounded wait; the cost of latching wrongly is the whole page.
    // An error shape this does not recognise must therefore fall on the not-latching side.
    expect(refreshRejectedTheSession(new Error("something"))).toBe(false);
    expect(refreshRejectedTheSession({ code: "storage_error" })).toBe(false);
    expect(refreshRejectedTheSession(null)).toBe(false);
    expect(refreshRejectedTheSession(undefined)).toBe(false);
    expect(refreshRejectedTheSession("401")).toBe(false);
    expect(refreshRejectedTheSession({ status: "401" })).toBe(false);
  });
});

describe("paramNames", () => {
  it("reports names and NEVER values", () => {
    // This string goes to a console. By construction the branch that calls it has no authorisation
    // code in the query — `callbackParams` would have matched — but a diagnostic that prints whatever
    // a redirect happened to carry is one that will eventually print something it should not.
    expect(paramNames("?privy_oauth_error=access_denied")).toBe("privy_oauth_error");
    expect(paramNames("?privy_oauth_error=access_denied")).not.toContain("access_denied");
    expect(paramNames("?a=1&b=2")).toBe("a, b");
  });

  it("is empty for an empty query, which the caller renders as 'none'", () => {
    expect(paramNames("")).toBe("");
    expect(paramNames("?")).toBe("");
  });
});

describe("X_CALLBACK_PATH", () => {
  it("is the static file in public/, addressed absolutely", () => {
    // It has to be a root-absolute path because it is joined to `location.origin` to build the
    // `redirect_to` Privy is given, and Privy checks that against the app's `allowed_domains`.
    expect(X_CALLBACK_PATH).toBe("/x-callback.html");
    expect(X_CALLBACK_PATH.startsWith("/")).toBe(true);
  });
});
