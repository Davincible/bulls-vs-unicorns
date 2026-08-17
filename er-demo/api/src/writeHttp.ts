// THE HTTP MANNERS OF THE WRITE PATH. Bodies in, refusals out, and one vocabulary for both legs.
//
// `challengeHandler.ts` and `linkWriteHandler.ts` are two halves of one ceremony, and the thing they
// most need to agree about is how they say NO. A refusal is a wire contract: the client maps it onto a
// sentence in `xConsent.ts#FAILURE_COPY`, and two handlers inventing their own spellings of "that
// expired" is how a player ends up being told to try again in a minute about something that will never
// work. So the vocabulary lives here, once, and both legs import it.
//
// ================================================================================================
// WHAT A REFUSAL IS ALLOWED TO SAY.
//
// Two rules, and the second is the one that is easy to break by being helpful.
//
//   1. `Cache-Control: no-store` ON EVERY RESPONSE, including the failures. A cached 429 would keep
//      refusing somebody after the window rolled over; a cached 200 from a challenge would hand two
//      players one nonce. `/api/links` can afford 30 seconds of private cache (see `linksHandler.ts`)
//      because it is a read. Nothing here can afford any.
//
//   2. NO REFUSAL MAY BE AN ORACLE. The refusals below name only facts about the CALLER'S OWN request:
//      the body was not JSON, the signature did not verify, the nonce is gone. Not one of them
//      distinguishes a state of the register — "that wallet is one of the arena's own", "that X account
//      is linked to somebody", "that handle exists" — because a distinguishable refusal is a query, and
//      a query anybody can make one wallet at a time is an export. `FAILURE_COPY`'s own comment on the
//      house-wallet case is the rule stated from the client's side: the sentence for that case "MUST be
//      indistinguishable from the generic one", and the way to keep that true is for the server never
//      to have said anything more.
//
// Hence `unavailable()`: one 503 shared by a house-list outage, a house-wallet refusal, and an
// unexpected exception. Three quite different events, one response, on purpose.
// ================================================================================================

/**
 * 8 KiB.
 *
 * The largest legitimate body on this path is a challenge request carrying a Privy identity token,
 * which is around a kilobyte. 8 KiB is a comfortable multiple of that and small enough that refusing
 * costs nothing. `decodeJwt` applies the same bound to the token itself, deliberately twice: this one
 * is about the request, that one is about the credential, and either alone would leave a gap the other
 * covers.
 */
export const MAX_BODY_BYTES = 8192;

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

/** A refusal. `error` is the machine-readable key the client switches on; `detail` is for a human
 *  reading a log or a `curl`, and it never names anything but the request. */
export function refuse(
  status: number,
  error: string,
  detail?: string,
  extraHeaders?: Record<string, string>,
): Response {
  const body = detail === undefined ? { error } : { error, detail };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(extraHeaders ?? {}) },
  });
}

export function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

/**
 * THE GATE'S ANSWER. 503 rather than 404, and the choice was argued rather than defaulted.
 *
 * 404 is the tempting one — it reveals nothing, and "the route does not exist" is the most
 * uninformative sentence available. It is also a lie, and the lie has a cost that lands on us: the day
 * somebody turns the ceremony on and mistypes the variable, every request answers 404, which reads as
 * "the function was never deployed" and sends whoever is debugging it into `vercel.json` and the build
 * log instead of into the environment. There is no secret being kept by the alternative either — this
 * repository is public and the route is named in three markdown files.
 *
 * So: 503, which says "this deployment knows what you are asking for and is refusing", and no
 * `Retry-After`, because it is not coming back on a timer.
 */
export function disabled(): Response {
  return refuse(
    503,
    "disabled",
    "the X link ceremony is not enabled on this deployment",
  );
}

/** The one response for every reason of ours. See this file's second rule. */
export function unavailable(): Response {
  return refuse(503, "unavailable");
}

export function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { Allow: allow, "Cache-Control": "no-store" } });
}

/**
 * THE ERROR BOUNDARY, and the one place on this path that writes to a log.
 *
 * Without it, a thrown store call becomes Vercel's `FUNCTION_INVOCATION_FAILED` — a 500 with no body,
 * which a client cannot distinguish from the platform being down and which arrives with a full stack
 * trace in the function log. With it, the caller gets the same `unavailable()` as every other reason of
 * ours, and the log gets one line.
 *
 * IT LOGS THE ERROR'S NAME AND NOTHING ELSE, WHICH IS A RULE RATHER THAN AN OVERSIGHT. §6.4: "Logs:
 * never the signed message, never a token." A Postgres driver's `message` can carry the offending row
 * ("Key (wallet)=(…) already exists"), and this handler's stack frames have a challenge message and a
 * Privy identity token in scope. `e.name` is the part that is genuinely diagnostic — `TypeError` means
 * the coercion seam in `pgWriteStore.ts` caught a column that changed shape, `NeonDbError` means the
 * database refused a statement, `AbortError` means something timed out — and it is the part that cannot
 * contain a payload.
 *
 * A DELIBERATE CONSEQUENCE: to see WHICH statement failed, somebody has to reproduce it against a
 * database rather than read it out of production logs. That is the trade this project has already made
 * everywhere else, and the reason `pgWriteStore.ts` is unit-testable without Postgres is so that the
 * reproduction is cheap.
 */
export async function guarded(route: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    console.error(`[${route}] refused after an unexpected ${e instanceof Error ? e.name : "throw"}`);
    return unavailable();
  }
}

export type JsonBody =
  | { readonly kind: "ok"; readonly value: Record<string, unknown> }
  | { readonly kind: "rejected"; readonly response: Response };

/**
 * Read a bounded JSON object body.
 *
 * THE CONTENT TYPE IS REQUIRED AND CHECKED, and that is not pedantry: requiring
 * `application/json` means a browser cannot reach these endpoints with a simple cross-origin form
 * post. A `Content-Type` outside the three the HTML form element can produce forces a CORS preflight,
 * which this API does not answer, so the request never happens. That is the whole CSRF story for this
 * path and it is worth one `if`.
 *
 * THE BOUND IS CHECKED TWICE — once against the header, which is a claim, and once against what
 * actually arrived, which is the fact. The header check is only there to refuse a large upload before
 * buffering it.
 *
 * A NON-OBJECT BODY IS A REFUSAL. `null`, an array and a bare number are all valid JSON and none of
 * them is a request; accepting them would mean every field reader downstream having an opinion about
 * `undefined`.
 */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  const contentType = request.headers.get("content-type") ?? "";
  // `startsWith` on the essential part, because a legitimate client may append `; charset=utf-8`.
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      kind: "rejected",
      response: refuse(415, "content-type", "expected application/json"),
    };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > MAX_BODY_BYTES) {
      return { kind: "rejected", response: refuse(413, "too-large", `body must be under ${MAX_BODY_BYTES} bytes`) };
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    // A truncated or aborted body. Nothing to say about it beyond that it was not readable.
    return { kind: "rejected", response: refuse(400, "malformed", "body could not be read") };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { kind: "rejected", response: refuse(413, "too-large", `body must be under ${MAX_BODY_BYTES} bytes`) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "rejected", response: refuse(400, "malformed", "body must be JSON") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "rejected", response: refuse(400, "malformed", "body must be a JSON object") };
  }
  return { kind: "ok", value: parsed as Record<string, unknown> };
}

/** base64 of exactly 64 bytes: 86 payload characters and `==`. The same expression as `SIG_RE` in
 *  `xLink.ts`, checked before decoding so a megabyte of "signature" is refused by length rather than by
 *  allocation. */
const SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

/**
 * A 64-byte detached ed25519 signature from a base64 field, or `null`.
 *
 * BASE64 AND NOTHING ELSE. `LinkAttestation.sig` is base64, so the client already has an encoder for
 * this exact shape and there is one spelling of a signature in the whole feature. Accepting base58 as
 * well "to be helpful" would mean guessing which encoding a caller meant, and `env.ts#decodeSecret`
 * records at length why this codebase does not guess between encodings unless the two are provably
 * distinguishable.
 */
export function signatureBytes(raw: unknown): Uint8Array | null {
  if (typeof raw !== "string" || !SIG_RE.test(raw)) return null;
  try {
    const bin = atob(raw);
    if (bin.length !== 64) return null;
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
