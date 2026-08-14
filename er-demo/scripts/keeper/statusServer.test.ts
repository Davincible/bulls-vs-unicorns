// THE RULES THE STATUS ENDPOINT EXISTS TO KEEP, pinned where they can be checked without a network.
//
// Every test here is about a failure that is SILENT in production. None of them throw, none of them
// fail a build, and each one presents as either a page that says "keeper down" while the keeper runs
// perfectly, or a page that says the opposite:
//
//   * a `*` honoured in `KEEPER_CORS_ORIGIN` — nothing breaks, the allowlist is simply no longer one;
//   * a trailing slash or a bare hostname in the config — the browser is blocked, in production only,
//     and neither end says why;
//   * a missing `Cache-Control: no-store` — a dead keeper keeps a countdown on screen for as long as
//     some cache lives, which is the exact failure the whole status contract exists to prevent;
//   * `/health` reading the status body — invisible until the day the body getter is the thing that
//     is broken, at which point the liveness probe fails and the platform restarts a keeper for the
//     one reason a restart cannot fix;
//   * `/reclamation.json` "tidied" into the roster's shape — a token, or a missing CORS header —
//     which locks the operator out of the report that says whether the arena is burning 9.96 SOL/day,
//     on the one day they need it and with nothing anywhere saying why.
//
// `Bun.serve` is deliberately not exercised: vitest runs on Node, there is no `Bun` global, and the
// transport is four lines wrapping a pure function. What is worth testing is the function.

import { describe, expect, it, vi } from "vitest";
import {
  HEALTH_PATH, HOUSE_PATH, HOUSE_TOKEN_MIN_LENGTH, LOCAL_DEV_ORIGINS, RECLAMATION_PATH, STATUS_PATH,
  bearerMatches, corsHeaders, handleKeeperRequest, originPolicyWarnings, resolveAllowedOrigins,
  resolveHouseTokenPolicy,
} from "./statusServer.ts";

const BODY = '{"schema":3}\n';

/** Stands in for the rendered reclamation report. Shaped like one — `reclamation.test.ts` owns what
 *  is IN it — because everything this file asserts is about the transport carrying bytes it was
 *  handed, verbatim. */
const RECLAMATION_BODY = '{"sweepGap":3,"runwayDays":501.2}\n';

/** Long enough to pass `HOUSE_TOKEN_MIN_LENGTH`, and DERIVED from that constant rather than a literal
 *  of the right length — a hand-counted fixture is one edit away from silently testing the refusal
 *  path instead of the success path, and the two look identical from the assertion's side. */
const TOKEN = "t".repeat(HOUSE_TOKEN_MIN_LENGTH);

/** Two of the arena's own wallets. Base58-shaped so an assertion that the 404/status bodies do not
 *  contain them is testing the thing it looks like it is testing. */
const HOUSE_WALLETS = [
  "H0use11111111111111111111111111111111111111",
  "H0use22222222222222222222222222222222222222",
];

/** THE ROSTER ROUTE IS OFF BY DEFAULT HERE, which mirrors the keeper an operator gets before they set
 *  the secret and keeps every pre-existing test in this file describing the same server it always
 *  did. Each roster test opts in explicitly, so "the route is enabled" is never something a reader has
 *  to infer from a helper. */
function deps(overrides: Partial<Parameters<typeof handleKeeperRequest>[1]> = {}) {
  return {
    body: () => BODY,
    heartbeatAgeSeconds: () => 1,
    reclamation: () => RECLAMATION_BODY,
    policy: resolveAllowedOrigins("https://arena.example"),
    houseToken: null as string | null,
    houseWallets: () => HOUSE_WALLETS as readonly string[],
    ...overrides,
  };
}

function bearer(path: string, token: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://keeper.internal${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://keeper.internal${path}`, { headers });
}

describe("who is allowed to read the status", () => {
  it("falls back to local development origins when nothing is configured", () => {
    const policy = resolveAllowedOrigins(undefined);
    expect(policy.origins).toEqual([...LOCAL_DEV_ORIGINS]);
    expect(policy.configured).toBe(false);
  });

  it("treats an empty value as unset rather than as an empty allowlist", () => {
    // `fly secrets set KEEPER_CORS_ORIGIN=` and forgetting it entirely are the same intent. An empty
    // allowlist that claimed to be configured would block everything including local development
    // while the boot log said nothing was wrong.
    expect(resolveAllowedOrigins("   ").origins).toEqual([...LOCAL_DEV_ORIGINS]);
  });

  it("REFUSES a wildcard, and refuses the whole value rather than narrowing it", () => {
    const policy = resolveAllowedOrigins("https://arena.example,*");
    expect(policy.origins).toEqual([...LOCAL_DEV_ORIGINS]);
    expect(policy.origins).not.toContain("*");
    expect(policy.wildcardRefused).toBe(true);
    // Not configured, so the boot warning fires: an operator who wrote `*` must not be left believing
    // their real origin is in force when it is not.
    expect(policy.configured).toBe(false);
    expect(originPolicyWarnings(policy).join(" ")).toContain("REFUSED");
  });

  it("takes a comma-separated list, trims it, and drops trailing slashes", () => {
    // The trailing slash is the one that costs an afternoon: a browser's `Origin` header never has
    // one, so `https://arena.example/` in the config matches nothing, forever, silently.
    const policy = resolveAllowedOrigins(" https://arena.example/ , https://staging.example ");
    expect(policy.origins).toEqual(["https://arena.example", "https://staging.example"]);
    expect(policy.configured).toBe(true);
  });

  it("keeps the well-formed entries and reports the ones that are not origins", () => {
    const policy = resolveAllowedOrigins("https://arena.example,arena.example,https://x.example/path");
    expect(policy.origins).toEqual(["https://arena.example"]);
    expect(policy.malformed).toEqual(["arena.example", "https://x.example/path"]);
    expect(originPolicyWarnings(policy).join(" ")).toContain("arena.example");
  });

  it("does not silently produce an empty allowlist when every entry is malformed", () => {
    const policy = resolveAllowedOrigins("arena.example");
    expect(policy.origins).toEqual([...LOCAL_DEV_ORIGINS]);
    expect(policy.configured).toBe(false);
  });
});

describe("the CORS headers on one response", () => {
  const policy = resolveAllowedOrigins("https://arena.example,https://staging.example");

  it("echoes the MATCHING origin, never the configured list", () => {
    // `Access-Control-Allow-Origin` takes one origin. A header carrying the whole list matches no
    // origin at all and fails every request — the standard way multi-origin CORS is got wrong.
    expect(corsHeaders("https://staging.example", policy)["Access-Control-Allow-Origin"])
      .toBe("https://staging.example");
  });

  it("sends no allow header for an origin that is not on the list", () => {
    expect(corsHeaders("https://evil.example", policy)["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("sets Vary: Origin whether or not the origin is allowed", () => {
    // Without it, a cache that saw an allowed origin's response can hand it to a disallowed one and
    // the allowlist quietly stops being one.
    expect(corsHeaders("https://arena.example", policy).Vary).toBe("Origin");
    expect(corsHeaders("https://evil.example", policy).Vary).toBe("Origin");
  });

  it("sends no allow header when there is no Origin — but still sends Vary", () => {
    // curl, a health prober, a server-to-server fetch. CORS is a browser mechanism, so an allow
    // header for a client that never asked implies a decision was made — but `Vary` must survive,
    // and this is the case that got it wrong first. This origin-less response is the one most likely
    // to be cached, and it is the one carrying no allow header: served to an allowed browser origin
    // by a cache that did not key on Origin, it blocks a page that should have worked.
    expect(corsHeaders(null, policy)).toEqual({ Vary: "Origin" });
  });

  it("never sets Allow-Credentials", () => {
    expect(corsHeaders("https://arena.example", policy)["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

describe("the status endpoint", () => {
  it("serves the published body verbatim as JSON", async () => {
    const res = handleKeeperRequest(get(STATUS_PATH), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(BODY);
  });

  it("is no-store — a cached liveness report is a lie about liveness", () => {
    expect(handleKeeperRequest(get(STATUS_PATH), deps()).headers.get("cache-control")).toBe("no-store");
  });

  it("carries the CORS decision for the requesting origin", () => {
    const res = handleKeeperRequest(get(STATUS_PATH, { origin: "https://arena.example" }), deps());
    expect(res.headers.get("access-control-allow-origin")).toBe("https://arena.example");
  });
});

describe("the health endpoint", () => {
  it("answers 200 without reading the status body", () => {
    // THE POINT OF THIS TEST. A health check that touched the status — or the chain, or the disk —
    // would fail for reasons a restart cannot fix, and the platform would kill a healthy keeper
    // mid-round over a devnet blip. The body getter must not be called at all.
    const body = vi.fn(() => BODY);
    const res = handleKeeperRequest(get(HEALTH_PATH), deps({ body }));
    expect(res.status).toBe(200);
    expect(body).not.toHaveBeenCalled();
  });

  it("reports the heartbeat age rather than failing on it", () => {
    // A stale heartbeat beside a responsive server is a real bug and it is REPORTED, not acted on:
    // the condition has never been observed, and the cost of a false positive is a restart landing
    // in the middle of a round.
    const res = handleKeeperRequest(get(HEALTH_PATH), deps({ heartbeatAgeSeconds: () => 9_999 }));
    expect(res.status).toBe(200);
    return expect(res.json()).resolves.toMatchObject({ ok: true, heartbeatAgeSeconds: 9_999 });
  });

  it("is no-store — a cached 200 would answer for a process that has since stopped", () => {
    expect(handleKeeperRequest(get(HEALTH_PATH), deps()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the reclamation endpoint", () => {
  it("serves the rendered report verbatim as JSON, and no-store", () => {
    // Verbatim: the handler is handed a string and returns it. Building the report here would put a
    // computation on a route anybody on the internet can make the keeper run — and `no-store` for the
    // same reason the status has it, since a cached burn rate is a lie about the present in exactly
    // the way a cached heartbeat is.
    const res = handleKeeperRequest(get(RECLAMATION_PATH), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    return expect(res.text()).resolves.toBe(RECLAMATION_BODY);
  });

  it("does not render the report for a request that did not ask for it", () => {
    // The mirror of the `/health` test above. The report getter is cheap today; a route that calls it
    // anyway is a route that starts paying for it the day it stops being cheap.
    const reclamation = vi.fn(() => RECLAMATION_BODY);
    for (const path of [STATUS_PATH, HEALTH_PATH, "/"]) {
      handleKeeperRequest(get(path), deps({ reclamation }));
    }
    expect(reclamation).not.toHaveBeenCalled();
  });

  it("NEEDS NO TOKEN — a request with no Authorization gets 200", async () => {
    // ASSERTED SO THAT NOBODY LATER "HARDENS" THIS INTO THE ROSTER'S SHAPE WITHOUT ARGUING FOR IT.
    // Every number in this body is derived from accounts anybody can already read: `round_counter`
    // and `rounds_swept` are on a public devnet ledger, and the operator's balance is one
    // `getBalance` against a pubkey that signs every transaction this arena has ever sent. A token
    // here would protect nothing and would cost the one thing the route is for — a human with `curl`
    // and no shell access to the Fly machine, at the moment they most need it.
    const res = handleKeeperRequest(get(RECLAMATION_PATH), deps({ houseToken: TOKEN }));
    expect(res.status).toBe(200);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.text()).toBe(RECLAMATION_BODY);
  });

  it("DOES carry the allow header for an allowed origin — the opposite of the roster, deliberately", () => {
    // THE ASSERTION THAT STOPS SOMEBODY TIDYING THE TWO ROUTES TO MATCH. `HOUSE_PATH` must never
    // carry `Access-Control-Allow-Origin`, and the test above says so in as many words; this one must,
    // because it is public telemetry and the allowlist is what decides which PAGES may read public
    // telemetry. The two rules look inconsistent side by side and are not: one route is protected by
    // a token from services, the other is not protected at all because there is nothing to protect.
    const res = handleKeeperRequest(get(RECLAMATION_PATH, { origin: "https://arena.example" }), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://arena.example");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("sends no allow header to an unknown origin, and still serves the body", () => {
    // CORS is a browser mechanism and the allowlist is about browsers. A `curl` or a server-to-server
    // fetch sends no `Origin` at all and gets the body regardless — which is why the missing header
    // here is not a refusal, and why the roster needs a token rather than an allowlist.
    const res = handleKeeperRequest(get(RECLAMATION_PATH, { origin: "https://evil.example" }), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("treats HEAD as GET and refuses a POST with 405", () => {
    expect(handleKeeperRequest(
      new Request(`http://keeper.internal${RECLAMATION_PATH}`, { method: "HEAD" }), deps(),
    ).status).toBe(200);
    const res = handleKeeperRequest(
      new Request(`http://keeper.internal${RECLAMATION_PATH}`, { method: "POST" }), deps(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("carries no schema field — see RECLAMATION_PATH for why a version here would be ceremony", () => {
    // The transport's half of that rule: it must not add one either. `keeper-status.json` is
    // versioned because a browser DRAWS from it; this body has one human with `curl` and no
    // programmatic consumer, and pinning a version would mean a keeper deploy silently breaking a
    // report nobody was parsing.
    return expect(handleKeeperRequest(get(RECLAMATION_PATH), deps()).json())
      .resolves.not.toHaveProperty("schema");
  });
});

describe("everything else", () => {
  it("answers the preflight with 204 and the methods it actually supports", () => {
    const req = new Request(`http://keeper.internal${STATUS_PATH}`, {
      method: "OPTIONS",
      headers: { origin: "https://arena.example", "access-control-request-headers": "x-trace-id" },
    });
    const res = handleKeeperRequest(req, deps());
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://arena.example");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("x-trace-id");
  });

  it("omits Allow-Headers rather than answering `*` when none were requested", () => {
    // This file emits no wildcards. Allow-Headers `*` would be harmless — the origin decision has
    // already been made by then — but a single exception is how "never `*`" becomes "`*` where it
    // seemed fine", and that is the reasoning that produces the one that is not fine.
    const req = new Request(`http://keeper.internal${STATUS_PATH}`, {
      method: "OPTIONS",
      headers: { origin: "https://arena.example" },
    });
    expect(handleKeeperRequest(req, deps()).headers.get("access-control-allow-headers")).toBeNull();
  });

  it("treats HEAD as GET, because every uptime monitor reaches for it first", () => {
    const req = new Request(`http://keeper.internal${STATUS_PATH}`, { method: "HEAD" });
    expect(handleKeeperRequest(req, deps()).status).toBe(200);
  });

  it("refuses a write with 405 and an Allow header — this endpoint is read-only", () => {
    const req = new Request(`http://keeper.internal${STATUS_PATH}`, { method: "POST" });
    const res = handleKeeperRequest(req, deps());
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("404s an unknown path while naming every PUBLIC one", async () => {
    // This is what somebody gets when they curl the bare hostname to check a deploy worked, and a
    // bare "404" at that moment is a dead end. It names the three public routes and deliberately not
    // the roster — see the roster describe block below.
    const res = handleKeeperRequest(get("/"), deps());
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain(STATUS_PATH);
    expect(text).toContain(HEALTH_PATH);
    expect(text).toContain(RECLAMATION_PATH);
  });
});

// ---------------------------------------------------------------------------------------------
// The roster endpoint
// ---------------------------------------------------------------------------------------------

describe("whether the roster route exists at all", () => {
  it("is off when nothing is configured, and says what that costs at the other end", () => {
    // NOT AN ERROR — a local keeper, a dry run and a second devnet instance are all legitimately
    // tokenless. It is warned about because the CONSEQUENCE lands on a different host and is invisible
    // from both: the identity API fails closed, so no token means no avatars for anybody.
    const policy = resolveHouseTokenPolicy(undefined);
    expect(policy.token).toBeNull();
    expect(policy.enabled).toBe(false);
    expect(policy.warnings).toHaveLength(1);
    expect(policy.warnings[0]).toContain("NO avatars");
  });

  it("REFUSES a token shorter than the minimum rather than accepting a guessable one", () => {
    // The route is public on a public hostname with no rate limit in front of it, so the token's
    // entropy is the whole of its security. Accepting a short one "for now" is how a three-character
    // secret reaches production — nothing after the day it is set will remind anybody. Refusing makes
    // it loud at boot, where it costs a log line.
    const policy = resolveHouseTokenPolicy("short");
    expect(policy.token).toBeNull();
    expect(policy.enabled).toBe(false);
    // The ACTUAL LENGTH, because "too short" without the number sends the operator to re-read the
    // docs instead of counting their paste — and an accidental shell truncation is the realistic
    // cause, which only the number reveals.
    expect(policy.warnings[0]).toContain("only 5 characters");
  });

  it("trims, because the realistic way this arrives is a shell", () => {
    // `fly secrets set X="$(cat …)"` carries the trailing newline. Untrimmed, every request would 401
    // against a token that looks character-for-character identical to the one in the Vercel dashboard
    // — a mismatch nobody can see by reading either side.
    expect(resolveHouseTokenPolicy(`  ${TOKEN}\n`).token).toBe(TOKEN);
  });

  it("does not let whitespace pad a short token past the floor", () => {
    // The length is measured after trimming. Measuring before it would make the minimum a formality
    // that any accidental leading space defeats.
    expect(resolveHouseTokenPolicy(`${" ".repeat(40)}abc`).token).toBeNull();
  });

  it("enables the route and warns about nothing when the token is long enough", () => {
    const policy = resolveHouseTokenPolicy(TOKEN);
    expect(policy).toEqual({ token: TOKEN, enabled: true, warnings: [] });
  });
});

describe("comparing the credential", () => {
  it("accepts the exact token and rejects a wrong one of the same length", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${"x".repeat(HOUSE_TOKEN_MIN_LENGTH)}`, TOKEN)).toBe(false);
  });

  it("rejects a wrong-length credential rather than throwing", () => {
    // THE POINT OF THIS TEST. `timingSafeEqual` THROWS on unequal lengths, so a missing length check
    // would turn a wrong password into a 500 — a different response, which is a far louder oracle
    // than the timing difference the constant-time comparison exists to remove.
    expect(() => bearerMatches("Bearer short", TOKEN)).not.toThrow();
    expect(bearerMatches("Bearer short", TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
  });

  it("accepts any casing of the scheme but no variation at all in the token", () => {
    // RFC 7235 makes the scheme case-insensitive and clients genuinely differ. The credential is
    // opaque bytes: every transformation applied to it is a way for two byte sequences a human reads
    // as identical to compare equal, which is the property this must not have.
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false);
  });

  it("rejects a missing header, a bare token and the wrong scheme", () => {
    expect(bearerMatches(null, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });
});

describe("the roster endpoint", () => {
  it("serves the wallets to a caller holding the token", async () => {
    const res = handleKeeperRequest(bearer(HOUSE_PATH, TOKEN), deps({ houseToken: TOKEN }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ wallets: HOUSE_WALLETS });
  });

  it("401s a wrong or missing credential, with a challenge and no detail", async () => {
    // No distinction between "you sent nothing" and "you sent the wrong thing": the only audience for
    // a more specific message is somebody who does not have the token. The operator debugging a real
    // mismatch reads the API's own log line, which says which end it was talking to.
    for (const req of [get(HOUSE_PATH), bearer(HOUSE_PATH, "wrong"), bearer(HOUSE_PATH, `${TOKEN}x`)]) {
      const res = handleKeeperRequest(req, deps({ houseToken: TOKEN }));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      const text = await res.text();
      expect(text).toBe("unauthorized\n");
      // The refusal must not leak the thing it is refusing.
      for (const wallet of HOUSE_WALLETS) expect(text).not.toContain(wallet);
    }
  });

  it("404s — not 401s — when no token is configured, and never reads the wallets", async () => {
    // THE TWO NEGATIVES ARE DIFFERENT ANSWERS AND THIS IS THE ONE THAT IS EASY TO GET WRONG. A 401 is
    // a claim: "this route is here, you just cannot have it" — which tells an anonymous caller that
    // this keeper holds a roster worth protecting, and invites them back with guesses. With no token
    // the route GENUINELY DOES NOT EXIST on this process, so it must be indistinguishable from any
    // unknown path on a keeper built before the feature.
    const houseWallets = vi.fn(() => HOUSE_WALLETS as readonly string[]);
    const res = handleKeeperRequest(bearer(HOUSE_PATH, TOKEN), deps({ houseToken: null, houseWallets }));
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(houseWallets).not.toHaveBeenCalled();
    // Byte-for-byte the same body an unknown path gets — the check that makes "indistinguishable"
    // a fact rather than an intention.
    expect(await res.text())
      .toBe(await handleKeeperRequest(get(HOUSE_PATH), deps({ houseToken: null })).text());
  });

  it("keeps the roster out of the 404 body even on a keeper that serves it", async () => {
    // An endpoint that advertises itself to callers who cannot use it is advertising to exactly the
    // people it is hiding from.
    const text = await handleKeeperRequest(get("/"), deps({ houseToken: TOKEN })).text();
    expect(text).not.toContain(HOUSE_PATH);
    expect(text).toContain(STATUS_PATH);
    expect(text).toContain(HEALTH_PATH);
  });

  it("NEVER sends an allow header — not even to an allowed origin — but does send Vary", () => {
    // THE MOST IMPORTANT ASSERTION ON THIS ROUTE, and the one whose absence would look completely
    // reasonable: `https://arena.example` is on the allowlist and every other endpoint here echoes it
    // back. The allowlist and the token protect different things. The allowlist decides which PAGES
    // may read public telemetry; the token decides which SERVICES may read the roster, and a browser
    // is never in the second category. If a page on the allowed origin ever came to hold this token —
    // inlined by a build misconfiguration, pasted into a console, leaked by a dependency — the missing
    // allow header is the last thing between that and the same-origin policy handing it the bank.
    const res = handleKeeperRequest(
      bearer(HOUSE_PATH, TOKEN, { origin: "https://arena.example" }),
      deps({ houseToken: TOKEN }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    // Still Vary: the other routes on this server DO differ by origin, so a cache keyed without it
    // could store one of their responses and serve it here, or the reverse.
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("401s an allowed origin holding no token, still with no allow header", () => {
    // The refusal path must not be the hole in the rule above.
    const res = handleKeeperRequest(
      get(HOUSE_PATH, { origin: "https://arena.example" }),
      deps({ houseToken: TOKEN }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("keeps the roster out of the public status and health responses", async () => {
    // The whole point of the change, asserted at the transport rather than at the serializer: whatever
    // the publisher does, these two routes must not carry a wallet. `statusFile.test.ts` makes the
    // same assertion over the bytes the publisher renders; this one covers the case where a future
    // edit to THIS file starts merging something into a public response.
    const d = deps({ houseToken: TOKEN });
    for (const path of [STATUS_PATH, HEALTH_PATH, RECLAMATION_PATH]) {
      const text = await handleKeeperRequest(get(path), d).text();
      for (const wallet of HOUSE_WALLETS) expect(text).not.toContain(wallet);
    }
  });
});
