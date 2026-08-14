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
// FOUR ENDPOINTS, AND THEY ANSWER DIFFERENT QUESTIONS.
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
//   GET /reclamation.json     is rent still coming back? PUBLIC, unauthenticated, `no-store`, with
//                             the ordinary CORS spread — the opposite of the roster below in every
//                             one of those respects, and see `RECLAMATION_PATH` for why that is the
//                             right call rather than an oversight. The short version: every number
//                             in it is derived from accounts anybody can already read, it is kept
//                             out of the status FILE by the payload rule rather than by
//                             confidentiality, and it is kept off `/health` because `/health` has a
//                             contract.
//
//   GET /house-wallets.json   the arena's OWN wallets, to a caller holding the bearer token and to
//                             nobody else. See `HOUSE_PATH` for why this exists and why it is a live
//                             endpoint rather than a copy of the list handed to the API at build
//                             time. It is the one route here that is not public telemetry, and it is
//                             deliberately the odd one out in every way that matters: never a CORS
//                             allow header, a constant-time credential comparison, and a 404 rather
//                             than a 401 when no token is configured — so a keeper without the
//                             feature is indistinguishable from one that never had the route.
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

/** IS RENT STILL COMING BACK? — the economics report, to anybody who asks.
 *
 *  WHY IT EXISTS. COST-MODEL.md §4: the arena costs ~0.030 SOL/day while `close_round_account` keeps
 *  reclaiming 0.023497 SOL per round, and ~9.96 SOL/day the moment it stops — 330x, arriving
 *  silently, emptying a 14.95 SOL balance in about thirty-six hours. That mechanism has never run at
 *  `MAX_FIGHTERS = 48`. This is the endpoint an operator watches for the first day of continuous
 *  running, and `reclamation.ts` decides everything in it.
 *
 *  PUBLIC AND UNAUTHENTICATED, WHICH IS THE DECISION ON THIS ROUTE WORTH ARGUING. Every number in
 *  this body is derived from accounts anybody can already read: `Arena.round_counter` and
 *  `Treasury.rounds_swept` are on a public devnet ledger, the operator's balance is one
 *  `getBalance` against a pubkey that signs every transaction this arena has ever sent, and the
 *  arena PDA that anchors all of it is published in `keeper-status.json` to every visitor of the
 *  site. There is nothing here a caller could not compute for themselves with an RPC endpoint and
 *  ten minutes. Putting a token in front of it would protect a fact that is not secret, at the cost
 *  of the thing this route is actually for — a human with `curl` and no shell access to the Fly
 *  machine, at the moment they most need it.
 *
 *  SO WHY IS IT NOT IN THE STATUS FILE? The payload rule, not confidentiality. `statusFile.ts`'s
 *  standing rule is that NOTHING interpolated from an exception, an account or a fighter count may
 *  enter `keeper-status.json` — a rule that exists because that payload is DRAWN by a browser and a
 *  half-understood field becomes a confidently-wrong number in front of a player. A stream of round
 *  numbers, cursors and lamport totals is exactly the kind of operational detail that rule keeps
 *  out, and no view would render a byte of it. This route is the channel that exists BECAUSE of that
 *  rule: the same reasoning that says "not in the browser's payload" says nothing at all about "not
 *  on the wire".
 *
 *  AND WHY NOT ON `/health`? Because `/health` has a contract and its whole value is that it means
 *  one thing: always 200 while the process answers, no chain calls, a liveness probe that `fly.toml`
 *  is pointed at. An economics report inside it would muddy a check whose entire purpose is to be
 *  unambiguous — and the first person to reason "the burn looks wrong, so the health check should
 *  fail" would have the platform restarting a healthy keeper mid-round over a condition a restart
 *  cannot fix. Two endpoints, two questions.
 *
 *  IT CARRIES NO SCHEMA FIELD, for the same reason `HOUSE_PATH` carries none. `keeper-status.json`
 *  is versioned because a browser DRAWS from it. This body has zero programmatic consumers and one
 *  human with `curl`; a version here would be ceremony, and pinning one would mean a keeper deploy
 *  silently breaking a report nobody was parsing. If that ever stops being true — if something
 *  starts alerting on this — the version goes in on the day the first consumer appears, which is the
 *  day anybody can say what it would mean. */
export const RECLAMATION_PATH = "/reclamation.json";

/** THE ARENA'S OWN WALLETS, TO AN AUTHENTICATED CALLER ONLY — the third route, and the only one on
 *  this server that answers a question the public one deliberately stopped answering.
 *
 *  WHO ASKS. The Vercel identity API (`er-demo/api/src/houseWallets.ts`), and nothing else. It has one
 *  rule to enforce — `TWITTER-CONNECT.md` §6.3: a house wallet must never wear a person's face — and
 *  it cannot enforce it without knowing which wallets are the house's. It uses the answer ONLY to
 *  withhold.
 *
 *  WHY A LIVE ENDPOINT RATHER THAN A COPY OF THE LIST. Two cheaper designs were evaluated and both
 *  were rejected for the same reason. A build-time environment variable holding the pubkeys, and a
 *  static list committed to the repo, each put a SNAPSHOT of the bank somewhere the API can read it —
 *  and the bank GROWS. `extendHouseBank.ts` exists precisely to grow it, and production is already
 *  running forty-eight wallets against a code default of ten. So a baked-in copy goes stale at exactly
 *  the moment a wallet is added, and a house wallet the API has never heard of is precisely and only
 *  the case the §6.3 check exists for. The failure mode is the check silently not applying to the
 *  newest bots, discovered by seeing one of them wearing somebody's avatar.
 *
 *  This process is the only one that knows its own bank. One source of truth, read live, at the cost
 *  of one authenticated request a minute — the API caches for sixty seconds and coalesces concurrent
 *  refreshes, so a warm worker under load is still one request.
 *
 *  IT IS NOT PART OF THE STATUS CONTRACT AND CARRIES NO SCHEMA FIELD. `keeper-status.json` is versioned
 *  because a reader DRAWS from it and a half-understood status becomes a confidently-wrong number in
 *  front of a player. This body is a bare list of strings with exactly one shape, read by one caller
 *  that only ever refuses from it. A version would be ceremony, and worse than ceremony: pinning one
 *  would mean a keeper deploy silently removes every avatar on the site until the API is redeployed to
 *  agree with it. */
export const HOUSE_PATH = "/house-wallets.json";

/** The environment variable holding the bearer token. Set on the keeper with
 *  `fly secrets set KEEPER_HOUSE_TOKEN=…`, and to the SAME value in the Vercel project, where
 *  `requireHouseToken` refuses to cold-start without it. */
export const HOUSE_TOKEN_ENV = "KEEPER_HOUSE_TOKEN";

/** SHORTEST TOKEN THIS SERVER WILL ACCEPT AS CONFIGURED, in characters.
 *
 *  This is a public endpoint on a public hostname with no rate limit in front of it, so the only thing
 *  standing between the internet and the roster is the token's entropy. Thirty-two characters is the
 *  length of the `openssl rand -base64 24` most operators reach for and is far past anything guessable
 *  at any rate a single Fly machine could be made to answer.
 *
 *  A SHORT TOKEN DISABLES THE ROUTE RATHER THAN WEAKENING IT. Accepting `dev` "just for now" is how a
 *  guessable secret reaches production, because nothing after the day it is set will ever remind
 *  anybody. Refusing makes the mistake loud at boot, where it costs a log line, instead of silent
 *  forever. */
export const HOUSE_TOKEN_MIN_LENGTH = 32;

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
// The roster token — resolved once, at boot, so the request path has no env access
// ---------------------------------------------------------------------------------------------

/** What the operator gets told about the roster endpoint at boot, and what the handler is given. */
export interface HouseTokenPolicy {
  /** The token to compare against, or null when the route is not enabled. */
  token: string | null;
  /** Log lines for the boot banner — see `originPolicyWarnings`, which this deliberately mirrors.
   *  Returned rather than printed so the rules and their warnings can be checked in one test without
   *  capturing stdout. */
  warnings: string[];
  /** For the banner's one-line summary. Separate from `token !== null` only so a caller never has to
   *  hold a secret in order to say whether there is one. */
  enabled: boolean;
}

/**
 * Decide whether the roster route exists on this keeper, from the raw `KEEPER_HOUSE_TOKEN`.
 *
 * THREE OUTCOMES, AND THE MIDDLE ONE IS THE INTERESTING ONE.
 *
 *   unset or empty   the feature is not configured. The route does not exist — a request for it gets
 *                    the ordinary 404, identical to any unknown path. This is a legitimate way to run
 *                    a keeper (a local one, a dry run, a second devnet instance nothing points at),
 *                    so it is not an error. It IS warned about, loudly, because of what it costs at
 *                    the other end: the identity API fails CLOSED, so a keeper with no token means a
 *                    site with no avatars at all. That consequence is invisible from here and
 *                    invisible from there, which is exactly the kind of thing a boot banner is for.
 *
 *   shorter than     REFUSED, and treated as unconfigured rather than accepted. This is a public
 *   the minimum      endpoint on a public hostname; a short token is a guessable one, and the whole
 *                    security of the route is the token's entropy. Accepting it "for now" is how a
 *                    three-character secret reaches production and stays there — nothing after the
 *                    day it is set will remind anybody. The warning names the ACTUAL LENGTH, because
 *                    "too short" without the number sends the operator to re-read the docs instead of
 *                    counting their paste, and because an accidental shell truncation is the
 *                    realistic cause and the number is what reveals it.
 *
 *   long enough      the route is live.
 *
 * TRIMMED, because the realistic way this arrives is `fly secrets set` from a shell, and a trailing
 * newline from a `$(…)` or a copied line would otherwise make every request 401 against a token that
 * looks identical to the one in the Vercel dashboard — a mismatch nobody can see by reading either
 * side. The length is measured AFTER trimming, so whitespace cannot pad a short token past the floor.
 */
export function resolveHouseTokenPolicy(raw: string | undefined): HouseTokenPolicy {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return { token: null, enabled: false, warnings: [houseRouteDisabledWarning(
      `${HOUSE_TOKEN_ENV} is not set, so ${HOUSE_PATH} is not served`,
    )] };
  }
  if (trimmed.length < HOUSE_TOKEN_MIN_LENGTH) {
    return { token: null, enabled: false, warnings: [houseRouteDisabledWarning(
      `${HOUSE_TOKEN_ENV} is only ${trimmed.length} characters and at least ${HOUSE_TOKEN_MIN_LENGTH} are ` +
      `required, so ${HOUSE_PATH} is NOT being served. ${HOUSE_PATH} is public on a public hostname and the ` +
      `token is the only thing protecting it. Generate one with \`openssl rand -base64 24\``,
    )] };
  }
  return { token: trimmed, enabled: true, warnings: [] };
}

/** The consequence half of every "the route is off" warning, written once because it is the part the
 *  operator actually needs and the part neither end can show them. The identity API fails CLOSED by
 *  design — see `api/src/houseWallets.ts` — so "cannot read the roster" and "serves no avatars at
 *  all" are the same sentence, and a warning that stopped at the first half would read as a detail. */
function houseRouteDisabledWarning(cause: string): string {
  return (
    `${cause}. The identity API cannot check which wallets are the arena's own, and it fails CLOSED — ` +
    `so it will serve NO avatars at all, for everybody, not just for house wallets. Set the same value ` +
    `on both ends: fly secrets set ${HOUSE_TOKEN_ENV}=… here, and ${HOUSE_TOKEN_ENV} in the Vercel project.`
  );
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
  /** The reclamation report, ALREADY RENDERED — `serializeReclamationReport(summariseReclamation(…))`,
   *  built where the keeper already holds the state it summarises.
   *
   *  A FUNCTION RETURNING A STRING, MIRRORING `body` EXACTLY AND FOR THE SAME REASON. The handler
   *  stays a pure function of values: no chain call on the request path, no serialisation on the
   *  request path, and nothing for a poller to make the keeper do. `summariseReclamation` is cheap,
   *  so the temptation to build the report here is real — and it is the same temptation `body`
   *  refused, where rendering per request would have let an HTTP GET drive the publisher's own
   *  latch. A route that computes is a route that can throw, can be slow, and can be made to run by
   *  anybody on the internet; a route that returns a string it was handed cannot.
   *
   *  REQUIRED, NOT OPTIONAL. An optional dependency would let a keeper that forgot to wire it serve a
   *  404 on the one endpoint the owner is watching to find out whether the arena is burning 9.96
   *  SOL/day — which is precisely the silent failure this whole route exists to catch, arriving
   *  through the door left open to make the type convenient. */
  reclamation: () => string;
  policy: OriginPolicy;
  /** The roster token, ALREADY RESOLVED — `resolveHouseTokenPolicy(process.env.KEEPER_HOUSE_TOKEN)`,
   *  called once where the server is started. Null means the route does not exist on this keeper.
   *
   *  PASSED IN RATHER THAN READ FROM `process.env` IN THE HANDLER, and that is the whole reason the
   *  routing in this file is testable. `handleKeeperRequest` is a pure function — values in, a value
   *  out, no I/O and no globals — which is what lets the rules that matter (never `*`, no-store on the
   *  status, never an allow header on this route) be checked under vitest, which runs on Node and has
   *  no `Bun` global at all. One `process.env` read inside it would make every one of those tests
   *  depend on ambient process state, and the first symptom would be a test that passes alone and
   *  fails in a suite. */
  houseToken: string | null;
  /** The arena's own wallets, base58 — `bank.bankPubkeys`. A function rather than an array so the
   *  handler holds no copy that could go stale against a bank the keeper extended, and so nothing
   *  captures the list at wiring time. */
  houseWallets: () => readonly string[];
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

/**
 * Are these two strings equal — decided in time that does not depend on HOW MUCH of the first one is
 * right.
 *
 * `a === b` ON A SECRET IS A TIMING ORACLE. String comparison returns at the first differing byte, so
 * the time it takes leaks the length of the correct prefix — and an attacker who can measure that
 * recovers a token one character at a time, in a number of requests LINEAR in its length instead of
 * exponential. Over a network the margin is small; it is not zero, and there is no reason to be
 * standing on the interesting side of that argument for a comparison that costs nothing to do right.
 *
 * WHY THIS IS HAND-WRITTEN INSTEAD OF `timingSafeEqual` FROM `node:crypto`, WHICH IS WHAT IT SHOULD
 * OBVIOUSLY BE. This module is imported by `statusServer.test.ts`, which runs under vitest, which
 * loads the repo's `vite.config.ts` — and that config applies `nodePolyfills({ include: [… "crypto" …
 * ] })`, which ALIASES `node:crypto` TO `crypto-browserify` FOR EVERYTHING IN THE UNIT TEST RUN.
 * `crypto-browserify` does not implement `timingSafeEqual`; it is `undefined` there. That polyfill
 * exists for the browser bundle's sake — `sim/erSim.ts` calls `createHash("sha256")`, and the config's
 * own comment explains it at length — and it was never meant to reach a Node-run keeper test, but it
 * does, because the unit tests have no vitest config of their own.
 *
 * The failure shape is the reason this is worth ten lines of comment rather than a one-line import.
 * Under Bun, which is what actually runs the keeper, `node:crypto` is real and `timingSafeEqual`
 * works perfectly. So the version of this file that imported it was CORRECT IN PRODUCTION AND BROKEN
 * ONLY UNDER TEST — and had the test not happened to exercise the success path, it would have been
 * the other trap instead: a green suite standing behind a call that throws `is not a function` on the
 * first authenticated request after a deploy, turning every roster fetch into a 500 and every avatar
 * on the site into nothing. A primitive whose availability depends on which bundler resolved the
 * import is not a primitive this file can depend on.
 *
 * Retiring the polyfill for the unit tests would be the better fix and it is not this file's to make:
 * it is a shared build config, the browser app needs the shim, and the blast radius is every test in
 * the repo. So the dependency is removed instead of worked around, which leaves this module resolving
 * identically under Bun, Node, vitest and any future bundler.
 *
 * WHAT THE LOOP GUARANTEES AND WHAT IT HONESTLY CANNOT. It is the same accumulate-the-difference
 * construction `timingSafeEqual` uses: every byte is read and XORed into `diff` on every call, and
 * there is no early exit, so the work done is a function of the LENGTH and not of the contents. What
 * a JavaScript implementation cannot promise, and a native one can, is that the engine will not
 * outsmart it — a JIT is entitled to optimise, and nothing in the language pins this. That residual
 * risk is accepted here with its eyes open: the alternative available in this environment is `===`,
 * which leaks the prefix length by construction rather than by the compiler's permission, and this is
 * strictly better than that. It guards a devnet bot roster, not a signing key.
 *
 * LENGTH IS CHECKED FIRST AND RETURNS EARLY, which does leak the length — deliberately, and it costs
 * nothing: `HOUSE_TOKEN_MIN_LENGTH` already makes the lower bound public, and a token's length is not
 * what protects it. (It is also why this returns false rather than throwing, unlike `timingSafeEqual`,
 * which raises on unequal lengths — a throw here would become a 500 where a 401 belongs, and a
 * DIFFERENT STATUS CODE is a far louder oracle than any timing difference.)
 *
 * UTF-8 BYTES, from the header exactly as it arrived. No case folding, no unicode normalisation: the
 * token is an opaque string chosen by the operator and set identically at both ends, and every
 * transformation applied here would be one more way for two byte sequences a human reads as identical
 * to compare equal — which is the property this function must not have. `TextEncoder` rather than
 * `Buffer` because it is a genuine global in every runtime involved and is therefore not something a
 * bundler can substitute underneath this file, which is the whole lesson above.
 */
function constantTimeEquals(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  // `|=` over the whole array with no `break`: every byte is read whatever the first one said.
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Does the request carry this exact bearer token?
 *
 * Exported for its own tests: the credential check is the entire security of `HOUSE_PATH`, and a rule
 * that is only reachable through a `Request` is a rule whose edge cases nobody writes cases for.
 */
export function bearerMatches(authorization: string | null, token: string): boolean {
  if (authorization === null) return false;
  // The SCHEME is matched case-insensitively because RFC 7235 says it is case-insensitive and clients
  // genuinely differ; the CREDENTIAL after it is not touched at all. Split on the FIRST space only, so
  // a token that happens to contain one is compared whole rather than silently truncated to its first
  // word — which would be a token that authenticates on a prefix.
  const space = authorization.indexOf(" ");
  if (space === -1) return false;
  if (authorization.slice(0, space).toLowerCase() !== "bearer") return false;
  return constantTimeEquals(authorization.slice(space + 1), token);
}

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

  if (path === RECLAMATION_PATH) {
    // THE ORDINARY PUBLIC SHAPE — `cors` spread, `no-store`, no token — and every one of those is a
    // decision rather than a copy of the line above it. See `RECLAMATION_PATH`: the body is derived
    // from accounts anybody can already read, so there is nothing here for a credential to protect,
    // and `no-store` because a cached burn rate is the same lie about the present that a cached
    // heartbeat is.
    return new Response(deps.reclamation(), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": NO_STORE },
    });
  }

  // THE ROSTER, AND IT IS THE ODD ONE OUT ON PURPOSE — see `HOUSE_PATH` for why it exists.
  //
  // THE UNCONFIGURED CASE FALLS THROUGH TO THE 404 BELOW RATHER THAN ANSWERING 401, and the
  // difference matters. A 401 is a claim: "this route is here, you just cannot have it" — which tells
  // an anonymous caller that this keeper holds a roster worth protecting, and invites them to come
  // back with guesses. When no token is configured the route GENUINELY DOES NOT EXIST on this process,
  // and the honest answer is the same 404 any unknown path gets, indistinguishable from a keeper built
  // before the feature. That is also why the 404 body below still names only the two public routes:
  // an endpoint that advertises itself to callers who cannot use it is advertising to exactly the
  // people it is hiding from.
  if (path === HOUSE_PATH && deps.houseToken !== null) {
    if (!bearerMatches(request.headers.get("authorization"), deps.houseToken)) {
      // NO DETAIL, and no distinction between "you sent nothing" and "you sent the wrong thing". Both
      // are the same 401 with the same body, because the only audience for a more specific message is
      // somebody who does not have the token — the operator debugging a real mismatch reads the
      // Vercel side's own log line, which says which end it was talking to.
      return new Response("unauthorized\n", {
        status: 401,
        headers: {
          Vary: "Origin",
          // The challenge, because a 401 without one is not a well-formed 401 and a client library
          // is entitled to be confused by it. No `realm`: it would name this arena to an anonymous
          // caller for no benefit, since nothing here is going to prompt a human for credentials.
          "WWW-Authenticate": "Bearer",
          "Content-Type": "text/plain",
          "Cache-Control": NO_STORE,
        },
      });
    }
    return new Response(`${JSON.stringify({ wallets: deps.houseWallets() })}\n`, {
      status: 200,
      // BUILT WITHOUT THE `cors` SPREAD, WHICH IS THE ONE LINE IN THIS FILE MOST WORTH DEFENDING.
      //
      // Every other response here echoes `Access-Control-Allow-Origin` back to an allowed origin. This
      // one must NEVER carry it — not for an unknown origin, not for a misconfigured one, and not for
      // the arena's own production origin, which is the case that makes it feel wrong. The reasoning
      // is that the allowlist and this token protect different things: the allowlist decides which
      // PAGES may read public telemetry, and the token decides which SERVICES may read the roster. A
      // browser is never in the second category. If a page on the allowed origin somehow came to hold
      // this token — inlined by a build misconfiguration, pasted into a console, leaked by a
      // dependency — the missing allow header is the last thing standing between that and the same-
      // origin policy handing it forty-eight pubkeys. It costs nothing, because the one legitimate
      // caller is a Vercel function, and a server-to-server fetch has no `Origin` and no interest in
      // CORS at all.
      //
      // `Vary: Origin` IS STILL SET, and it is not a leftover. The other routes on this server DO vary
      // by origin, so a cache keyed without it could store one of their responses and serve it here or
      // the reverse. It is also the honest header: this response would be identical for every origin,
      // and saying so is what stops a shared cache from ever needing to guess.
      //
      // AN OPTIONS PREFLIGHT FOR THIS PATH IS ANSWERED BY THE GENERIC HANDLER ABOVE, and that is
      // harmless rather than an oversight worth special-casing. A preflight that succeeds only earns
      // the browser the right to SEND the request; the response it then gets carries no allow header,
      // so the browser refuses to hand the body to script. Refusing at the response is the check that
      // actually holds, and putting a second one in the preflight would be a rule enforced in two
      // places that can disagree.
      headers: { Vary: "Origin", "Content-Type": "application/json", "Cache-Control": NO_STORE },
    });
  }

  // Names every PUBLIC route — see the roster branch above for why that one is deliberately not
  // listed here even on a keeper that serves it. This response is what somebody gets when they curl
  // the bare hostname to check the deploy worked, and "404" alone at that moment is a dead end.
  return new Response(
    `no such path: ${path}\nThis is the arena round keeper. It serves ${STATUS_PATH}, ${HEALTH_PATH} ` +
    `and ${RECLAMATION_PATH}.\n`,
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
    ok(`status server on http://${BIND_HOSTNAME}:${server.port}${STATUS_PATH}  ${c.d}(health: ${HEALTH_PATH}, reclamation: ${RECLAMATION_PATH})${c.x}`);
    // THE ROSTER ROUTE'S STATE, ON ITS OWN LINE AND ALWAYS — including, and especially, when it is
    // off. "Enabled" is the boring half; the off case is a silent, total feature outage at a
    // completely different host, and this is the only place either process says so out loud. The
    // token itself never reaches a log line, only whether there is one.
    ok(options.houseToken === null
      ? `${c.y}${HOUSE_PATH} NOT served${c.x} — no ${HOUSE_TOKEN_ENV}; the identity API will serve no avatars (see the warning above)`
      : `${HOUSE_PATH} served to authenticated callers  ${c.d}(${HOUSE_TOKEN_ENV} is set)${c.x}`);
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
