// THE KEEPER'S HTTP FACE — the status, over the wire, because in production there is no other way.
//
// WHY THIS EXISTS. `statusFile.ts` writes `public/keeper-status.json`, and locally that is enough:
// Vite serves `public/` verbatim, so the page fetches the file same-origin and nothing has to be
// configured. In production it cannot work at all. The front end is a STATIC build, produced at
// deploy time and served from a CDN; the keeper is a long-running process on a different host. It
// cannot write into a bundle that was finished before it started. Wired as-is, a deployed page would
// poll its own origin, 404 forever, and permanently say "keeper is down" while the keeper ran
// perfectly — the false negative that would delete the countdown feature the moment it shipped.
//
// So the keeper serves the same bytes itself. `statusFile.ts` renders them once per publish and both
// channels emit that one payload; this file is a transport and holds no opinion about the content.
//
// TWO ENDPOINTS, AND THEY ANSWER DIFFERENT QUESTIONS.
//
//   GET /keeper-status.json   the schema-3 payload, `Cache-Control: no-store`. A CACHED LIVENESS
//                             REPORT IS A LIE ABOUT LIVENESS, and reporting liveness is the entire
//                             reason this endpoint exists: the one thing separating "this describes
//                             now" from "this describes the moment before the keeper died" is
//                             `heartbeatAt`, and any cache in the path — a CDN, a proxy, the
//                             browser's own — keeps a dead keeper looking alive for exactly as long
//                             as the cache lives. The page asks for `no-store` too; both ends say it,
//                             because either end alone is one misconfiguration from a stale
//                             countdown.
//
//   GET /health               the platform's liveness probe. NO CHAIN CALLS, and that is the design
//                             decision in this file most worth defending: if this endpoint depended
//                             on RPC, a devnet blip — a 429, a slow block — would fail the check and
//                             the platform would KILL A PERFECTLY HEALTHY KEEPER, mid-round,
//                             stranding a delegated round whose rent nothing reclaims. The blip is
//                             transient and the restart is not. So it answers from memory only.
//
// WHY `/health` IS ALWAYS 200 WHILE THE PROCESS ANSWERS. Answering an HTTP request at all already
// proves the thing a liveness probe is for: the process is up and its event loop is turning. The
// heartbeat age is reported in the body because a stopped heartbeat beside a responsive server is a
// real bug worth seeing — but it is not made a FAILURE, because the only condition it would add is
// one nobody has observed, and the cost of a false positive is a restart that lands in the middle of
// a round. Report it; do not act on it. (`engine/`'s Dockerfile points its check at `/live` and
// explicitly NOT at `/health`, for the mirror-image reason: engine's `/health` returns 503 on a
// solvency freeze, which a restart cannot fix, so using it there would restart-loop an incident.
// Here `/health` is the one that is safe to probe. The divergence is deliberate.)
//
// THE SERVER MUST NEVER TAKE THE KEEPER DOWN. `startStatusServer` returns null on a bind failure
// rather than throwing: rounds matter more than telemetry, and a port already in use is not a reason
// to stop keeping an arena. The keeper logs it loudly and keeps going — the file channel is still
// live, and a page pointed at a keeper with no server reads it as down, which is a wrong answer that
// costs a countdown, not a round.
//
// EVERYTHING BELOW THE TRANSPORT IS A PURE FUNCTION, deliberately. `Bun.serve` appears exactly once,
// at the bottom, wrapping `handleKeeperRequest`. Origin policy, routing, headers and status codes are
// all decided by functions that take values and return values, so the rules that matter — never `*`,
// no-store on the status, no body read on the health path — are testable under vitest, which runs on
// Node and has no `Bun` global at all.

import { KEEPER_STATUS_SCHEMA } from "../../src/v2/data/keeperStatus.ts";
import { c, error as logError, ok } from "./log.ts";

/** The port the status server binds, and the port `fly.toml` and the Dockerfile both name. 8080
 *  because it is the conventional container HTTP port and collides with nothing this repo runs
 *  locally (Vite is 5173, `vite preview` 4173, the off-chain engine 8090). */
export const DEFAULT_HTTP_PORT = 8080;

/** `0.0.0.0`, not `127.0.0.1`. A container's loopback is reachable only from inside the container, so
 *  binding it would make the health check fail and the endpoint unreachable while looking, from
 *  inside, entirely correct. */
export const BIND_HOSTNAME = "0.0.0.0";

/** The path the browser fetches. It matches the last segment of the relative default in
 *  `KEEPER_STATUS_URL`, so the same page works against a local Vite serving the file and against a
 *  deployed keeper serving this endpoint, with only the origin changing. */
export const STATUS_PATH = "/keeper-status.json";
export const HEALTH_PATH = "/health";

/** The origins allowed when `KEEPER_CORS_ORIGIN` is not set: local development, and nothing else.
 *
 *  Vite dev (5173) and `vite preview` (4173), on both spellings of loopback, because a browser sends
 *  whichever one is in the address bar and `localhost` and `127.0.0.1` are DIFFERENT ORIGINS to the
 *  same-origin policy — allowing one and not the other is a five-minute confusion for every developer
 *  who happens to type the other.
 *
 *  Note that a page served by Vite from `public/` does not need these at all: it fetches the FILE,
 *  same-origin, and CORS never enters the picture. They are here for the case in between — a
 *  developer pointing a local page at a keeper's HTTP port to test the production wiring before
 *  deploying it, which is exactly the rehearsal that should not require configuring anything. */
export const LOCAL_DEV_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

// ---------------------------------------------------------------------------------------------
// Origin policy — pure, because "never `*`" has to be a fact somebody can check
// ---------------------------------------------------------------------------------------------

export interface OriginPolicy {
  /** Exact origins that may read the status. Compared literally against the request's `Origin`. */
  origins: string[];
  /** True when an explicit `KEEPER_CORS_ORIGIN` was accepted and is in force. False means the local
   *  development defaults are running, which for a deployment is a misconfiguration. */
  configured: boolean;
  /** `*` appeared in the value and the WHOLE value was refused. */
  wildcardRefused: boolean;
  /** Entries that are not origins (`https://x.example/path`, `x.example`, `HTTPS://X` …). Kept out of
   *  `origins` and reported, because their failure mode is silence: a browser is simply blocked, in
   *  production, and nothing on either side says why. */
  malformed: string[];
}

/**
 * Decide who may read the status, from the raw `KEEPER_CORS_ORIGIN`.
 *
 * NEVER `*`, AND A `*` IS REFUSED RATHER THAN NARROWED. `Access-Control-Allow-Origin: *` would let
 * any page on the internet read this endpoint; it is public devnet telemetry, so the damage is small,
 * but "small damage" is how an allowlist becomes a formality. A value CONTAINING `*` is rejected
 * whole rather than having the wildcard stripped from it, because an operator who wrote `*` believed
 * a wildcard was acceptable here — honouring the rest of their list silently would half-apply an
 * intent that was wrong, and leave them believing something is configured that is not.
 *
 * THE COMMA-SEPARATED LIST IS ECHOED BACK ONE AT A TIME, never emitted whole. `Access-Control-Allow-
 * Origin` takes a single origin or `*`; a header carrying `https://a.example, https://b.example`
 * matches no origin at all and fails every request, which is the standard way multi-origin CORS is
 * got wrong. `corsHeaders` below echoes the matching origin and sets `Vary: Origin`.
 *
 * Trailing slashes are trimmed: a browser's `Origin` header never has one, so `https://x.app/` in the
 * config would match nothing, forever, silently.
 */
export function resolveAllowedOrigins(raw: string | undefined): OriginPolicy {
  const entries = (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (entries.length === 0) {
    return { origins: [...LOCAL_DEV_ORIGINS], configured: false, wildcardRefused: false, malformed: [] };
  }
  if (entries.some((e) => e.includes("*"))) {
    return { origins: [...LOCAL_DEV_ORIGINS], configured: false, wildcardRefused: true, malformed: [] };
  }

  const origins: string[] = [];
  const malformed: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.replace(/\/+$/, "");
    // `URL.origin` is the browser's own definition of the value it will put in the `Origin` header,
    // so comparing the entry against it is the exact question that matters: "is this the string a
    // browser would send?". Anything else — a path, a bare host, an odd case — is not.
    let normalised: string | null = null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.origin === trimmed) normalised = parsed.origin;
    } catch {
      normalised = null;
    }
    if (normalised === null) malformed.push(entry);
    else if (!origins.includes(normalised)) origins.push(normalised);
  }

  // Every entry malformed is the same situation as an unset var, and must not silently produce an
  // empty allowlist that blocks everything including local development while claiming to be
  // configured.
  if (origins.length === 0) {
    return { origins: [...LOCAL_DEV_ORIGINS], configured: false, wildcardRefused: false, malformed };
  }
  return { origins, configured: true, wildcardRefused: false, malformed };
}

/** What the operator needs to be told about the policy at boot, as log lines. Returned rather than
 *  printed so the rules and their warnings can be checked in one test without capturing stdout. */
export function originPolicyWarnings(policy: OriginPolicy): string[] {
  const lines: string[] = [];
  if (policy.wildcardRefused) {
    lines.push(
      "KEEPER_CORS_ORIGIN contains `*` and the whole value was REFUSED — a wildcard would let any page " +
      "on the internet read this keeper's status. Falling back to local development origins only, which " +
      "means a deployed browser WILL be blocked. Set it to the exact origin(s), e.g. " +
      "KEEPER_CORS_ORIGIN=https://your-app.vercel.app",
    );
  }
  if (policy.malformed.length > 0) {
    lines.push(
      `KEEPER_CORS_ORIGIN has ${policy.malformed.length} entr${policy.malformed.length === 1 ? "y" : "ies"} ` +
      `that ${policy.malformed.length === 1 ? "is" : "are"} not an origin and will match nothing: ` +
      `${policy.malformed.join(", ")}. An origin is scheme://host[:port] with no path and no trailing slash.`,
    );
  }
  if (!policy.configured) {
    lines.push(
      "no production browser origin is configured (KEEPER_CORS_ORIGIN is unset or was refused). Only " +
      `${LOCAL_DEV_ORIGINS.join(", ")} may read the status endpoint, so a deployed page will be blocked ` +
      "by CORS and will report the keeper as down.",
    );
  }
  return lines;
}

/**
 * The CORS headers for one request, given the policy.
 *
 * ONLY THE ALLOW HEADER DEPENDS ON THE REQUEST. `Access-Control-Allow-Origin` is emitted solely for
 * an origin that is on the list, echoed back literally — a `curl`, a health prober and a
 * server-to-server fetch send no `Origin` at all, and the same-origin policy is a browser mechanism,
 * so an allow header for a client that never asked would imply a decision nobody made.
 *
 * `Vary: Origin` IS ALWAYS SET, INCLUDING WHEN THERE IS NO `Origin` HEADER, and that last case is the
 * one that is easy to get wrong — it was wrong here first. The response genuinely differs by origin,
 * so any cache in the path must key on it; without `Vary`, a cache that stored one response can serve
 * it to a different origin and the allowlist quietly stops being one. Omitting it for origin-less
 * requests is exactly backwards, because THAT is the response most likely to be cached: it is what a
 * prober or a warm-up fetch gets, it carries no allow header, and handing it to an allowed browser
 * origin would block a page that should have worked. (`Cache-Control: no-store` on every response
 * already makes this unlikely; `Vary` is what makes it wrong rather than merely improbable, and the
 * two together are cheap.)
 *
 * `Access-Control-Allow-Credentials` is deliberately NOT set: this endpoint reads no cookies and no
 * authorization header, and setting it would enlarge what a compromised allowed origin could do for
 * exactly no benefit.
 */
export function corsHeaders(requestOrigin: string | null, policy: OriginPolicy): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (requestOrigin !== null && policy.origins.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  return headers;
}

// ---------------------------------------------------------------------------------------------
// Routing — a request in, a response out, no I/O
// ---------------------------------------------------------------------------------------------

export interface StatusServerDeps {
  /** The current payload, exactly as the file holds it. `statusFile.ts`'s `publisher.body`. */
  body: () => string;
  /** Age of the published heartbeat in seconds, from memory. `statusFile.ts`'s
   *  `publisher.heartbeatAgeSeconds`. */
  heartbeatAgeSeconds: () => number;
  policy: OriginPolicy;
}

/** How long a browser may cache the preflight answer. Ten minutes: the policy only changes on a
 *  deploy, and a preflight per poll would triple the request count on an endpoint polled every two
 *  seconds. (In practice the page's own fetch is a SIMPLE request — a GET with no custom headers, and
 *  `cache: "no-store"` is a fetch option rather than a header — so no preflight is sent at all. The
 *  OPTIONS handler is here for every other client, and because an endpoint that 405s a preflight is
 *  an endpoint that fails mysteriously the first time somebody adds a header to the fetch.) */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/** `no-store` on BOTH endpoints. The status because a cached liveness report is a lie about liveness;
 *  the health check because a cached 200 would answer for a process that has since stopped, which is
 *  the one thing a health check must never do. */
const NO_STORE = "no-store";

export function handleKeeperRequest(request: Request, deps: StatusServerDeps): Response {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, deps.policy);

  if (request.method === "OPTIONS") {
    // Echoed rather than enumerated: the request states exactly which headers it intends to send, and
    // a fixed list here would be a guess that silently blocks the first client to send one this
    // file's author did not think of.
    //
    // OMITTED ENTIRELY when the request asked for none, rather than answered with `*`. A wildcard
    // would be harmless — it only applies once the ORIGIN has already been allowed, which is where
    // the real decision is made — but this file's rule is that it does not emit wildcards, and a
    // single exception is how a rule becomes a habit of judging each case. A preflight should answer
    // what it was asked and nothing else.
    const requested = request.headers.get("access-control-request-headers");
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        ...(requested === null ? {} : { "Access-Control-Allow-Headers": requested }),
        "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
      },
    });
  }

  // HEAD is handled exactly like GET and the runtime drops the body. Treating it as unsupported
  // would break every uptime monitor, all of which reach for HEAD first.
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(`${request.method} is not supported. This endpoint is read-only.\n`, {
      status: 405,
      headers: { ...cors, Allow: "GET, HEAD, OPTIONS", "Content-Type": "text/plain", "Cache-Control": NO_STORE },
    });
  }

  const path = new URL(request.url).pathname;

  if (path === STATUS_PATH) {
    return new Response(deps.body(), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": NO_STORE },
    });
  }

  if (path === HEALTH_PATH) {
    // Built here rather than fetched from anywhere: no chain call, no filesystem, no status body.
    // `heartbeatAgeSeconds` is one subtraction of two numbers already in memory. See this file's
    // header for why a stale heartbeat is REPORTED here and not turned into a failure.
    const age = deps.heartbeatAgeSeconds();
    return new Response(`${JSON.stringify({ ok: true, schema: KEEPER_STATUS_SCHEMA, heartbeatAgeSeconds: age })}\n`, {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": NO_STORE },
    });
  }

  // Names both real routes. This response is what somebody gets when they curl the bare hostname to
  // check the deploy worked, and "404" alone at that moment is a dead end.
  return new Response(
    `no such path: ${path}\nThis is the arena round keeper. It serves ${STATUS_PATH} and ${HEALTH_PATH}.\n`,
    { status: 404, headers: { ...cors, "Content-Type": "text/plain", "Cache-Control": NO_STORE } },
  );
}

// ---------------------------------------------------------------------------------------------
// The transport — the only part that touches a runtime
// ---------------------------------------------------------------------------------------------

/** The slice of `Bun.serve` this file uses, declared rather than depended on.
 *
 *  There is no `@types/bun` in this project, and adding one is not the small change it looks like:
 *  `bun-types` redeclares a large set of globals, and `tsconfig.app.json` — which the scripts project
 *  extends — already loads `DOM` and `@types/node` for the browser app's sake, so a third set of
 *  global declarations is a conflict to be managed on every upgrade, in the app's config, for one
 *  function call in one script. Declaring the four members actually used keeps the cost proportional
 *  and makes the dependency legible: this is exactly what the file assumes about its runtime, and
 *  nothing more. `Request` and `Response` are the Web-standard types Bun really passes and returns,
 *  and they are already in scope from `DOM`. */
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch: (request: Request) => Response;
  }): { port: number; stop: (closeActiveConnections?: boolean) => void };
} | undefined;

export interface StatusServer {
  port: number;
  stop(): void;
}

export interface StatusServerOptions extends StatusServerDeps {
  port: number;
}

/**
 * Start serving. Returns null — never throws — if the port cannot be bound.
 *
 * A KEEPER THAT DIED BECAUSE ITS TELEMETRY PORT WAS TAKEN WOULD BE TRADING THE PRODUCT FOR ITS OWN
 * REPORTING, which is the same rule `statusFile.ts` applies to a failed disk write and it is the same
 * answer: log it loudly, keep the rounds running. The realistic cause is a second process on the same
 * host (a stray keeper, `vite preview`, anything on 8080), and the operator needs to see it rather
 * than to lose the arena over it.
 *
 * Every request is wrapped so a handler throw becomes a 500 rather than whatever the runtime would
 * otherwise do with an exception on the request path. `handleKeeperRequest` is pure and does not
 * throw today; this is here so that stays true of the PROCESS even when it stops being true of the
 * function.
 */
export function startStatusServer(options: StatusServerOptions): StatusServer | null {
  if (typeof Bun === "undefined") {
    logError(
      "the status HTTP server needs Bun's built-in server and this process is not running under Bun — " +
      "no status will be served over HTTP. Run the keeper with `bun run scripts/keeper/keeper.ts`.",
    );
    return null;
  }
  try {
    const server = Bun.serve({
      port: options.port,
      hostname: BIND_HOSTNAME,
      fetch: (request) => {
        try {
          return handleKeeperRequest(request, options);
        } catch (e) {
          logError(`status server: ${e instanceof Error ? e.message : String(e)}`);
          return new Response("the keeper failed to render its status\n", {
            status: 500,
            headers: { "Content-Type": "text/plain", "Cache-Control": NO_STORE },
          });
        }
      },
    });
    ok(`status server on http://${BIND_HOSTNAME}:${server.port}${STATUS_PATH}  ${c.d}(health: ${HEALTH_PATH})${c.x}`);
    return { port: server.port, stop: () => server.stop(true) };
  } catch (e) {
    logError(
      `could not bind the status server to ${BIND_HOSTNAME}:${options.port} — the keeper keeps running ` +
      `and keeps writing the status FILE, but nothing can read it over HTTP, so a deployed page will ` +
      `report this keeper as down. Free the port or set KEEPER_HTTP_PORT: ` +
      `${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
