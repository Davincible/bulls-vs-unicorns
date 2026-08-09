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
//     one reason a restart cannot fix.
//
// `Bun.serve` is deliberately not exercised: vitest runs on Node, there is no `Bun` global, and the
// transport is four lines wrapping a pure function. What is worth testing is the function.

import { describe, expect, it, vi } from "vitest";
import {
  HEALTH_PATH, LOCAL_DEV_ORIGINS, STATUS_PATH, corsHeaders, handleKeeperRequest,
  originPolicyWarnings, resolveAllowedOrigins,
} from "./statusServer.ts";

const BODY = '{"schema":3}\n';

function deps(overrides: Partial<Parameters<typeof handleKeeperRequest>[1]> = {}) {
  return {
    body: () => BODY,
    heartbeatAgeSeconds: () => 1,
    policy: resolveAllowedOrigins("https://arena.example"),
    ...overrides,
  };
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

  it("404s an unknown path while naming both real ones", async () => {
    // This is what somebody gets when they curl the bare hostname to check a deploy worked, and a
    // bare "404" at that moment is a dead end.
    const res = handleKeeperRequest(get("/"), deps());
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain(STATUS_PATH);
    expect(text).toContain(HEALTH_PATH);
  });
});
