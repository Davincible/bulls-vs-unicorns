// THE WRITE PATH'S HTTP MANNERS.
//
// Small rules, and every one of them is a rule whose absence is invisible until it is expensive:
//
//   * `no-store` ON EVERY RESPONSE. A cached 429 keeps refusing somebody after their window rolled
//     over; a cached challenge hands two players one nonce.
//   * A BOUNDED, TYPED BODY. Requiring `application/json` is also the CSRF defence — it forces a
//     preflight this API does not answer, so a cross-origin form post never arrives.
//   * `guarded` LOGS A NAME AND NOTHING ELSE. §6.4: "Logs: never the signed message, never a token."

import { describe, expect, it, vi } from "vitest";
import {
  disabled,
  guarded,
  MAX_BODY_BYTES,
  methodNotAllowed,
  okJson,
  readJsonBody,
  refuse,
  signatureBytes,
  unavailable,
} from "./writeHttp.ts";

const jsonRequest = (body: string, contentType = "application/json"): Request =>
  new Request("https://bullsvsunicorns.fun/api/x/link", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });

describe("every response", () => {
  it("forbids storage, success and failure alike", () => {
    for (const res of [okJson({ ok: true }), refuse(400, "malformed"), disabled(), unavailable()]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(methodNotAllowed("POST").headers.get("Cache-Control")).toBe("no-store");
  });

  it("is JSON, so a client has one shape to parse", async () => {
    const res = refuse(429, "rate-limited", undefined, { "Retry-After": "42" });
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toEqual({ error: "rate-limited" });
  });

  it("omits `detail` rather than sending an empty one", async () => {
    expect(await refuse(400, "malformed").json()).toEqual({ error: "malformed" });
    expect(await refuse(400, "malformed", "why").json()).toEqual({ error: "malformed", detail: "why" });
  });
});

describe("the gate's answer", () => {
  it("is 503 and says the ceremony is not enabled", async () => {
    // Not 404. A 404 reveals nothing and is a lie whose cost lands on us: the day somebody enables the
    // ceremony and mistypes the variable, every request answers "no such route" and sends whoever is
    // debugging it into `vercel.json` instead of into the environment. The route is named in three
    // markdown files in a public repository; there is no secret being kept.
    const res = disabled();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "disabled",
      detail: "the X link ceremony is not enabled on this deployment",
    });
  });

  it("carries no Retry-After, because it is not coming back on a timer", () => {
    expect(disabled().headers.get("Retry-After")).toBeNull();
  });
});

describe("unavailable", () => {
  it("is one word, shared by every reason of ours", async () => {
    // A house-wallet refusal, an unreadable roster and an internal fault must be indistinguishable, or
    // the endpoint becomes a membership oracle. `xConsent.ts#FAILURE_COPY` carries the same rule from the
    // client's side.
    const res = unavailable();
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ error: "unavailable" }));
  });
});

describe("readJsonBody", () => {
  it("reads a JSON object", async () => {
    const body = await readJsonBody(jsonRequest(JSON.stringify({ wallet: "W" })));
    expect(body.kind === "ok" ? body.value : null).toEqual({ wallet: "W" });
  });

  it("tolerates a charset on the content type", async () => {
    const body = await readJsonBody(jsonRequest("{}", "application/json; charset=utf-8"));
    expect(body.kind).toBe("ok");
  });

  it("refuses any other content type with a 415", async () => {
    // The CSRF defence: `application/x-www-form-urlencoded`, `multipart/form-data` and `text/plain` are
    // the three an HTML form can produce, and none of them is accepted — so a cross-origin form post
    // needs a preflight, and this API answers none.
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain", ""]) {
      const body = await readJsonBody(jsonRequest("{}", type));
      expect(body.kind === "rejected" ? body.response.status : 0).toBe(415);
    }
  });

  it("refuses an oversized body by its declared length, before buffering it", async () => {
    const req = new Request("https://bullsvsunicorns.fun/api/x/link", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(MAX_BODY_BYTES + 1) },
      body: JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) }),
    });
    const body = await readJsonBody(req);
    expect(body.kind === "rejected" ? body.response.status : 0).toBe(413);
  });

  it("refuses an oversized body that lied about its length", async () => {
    // The header is a claim; the bytes are the fact. Both are checked.
    const body = await readJsonBody(jsonRequest(JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) })));
    expect(body.kind === "rejected" ? body.response.status : 0).toBe(413);
  });

  it("refuses valid JSON that is not an object", async () => {
    // `null`, an array and a bare number are all valid JSON and none of them is a request. Accepting them
    // would mean every field reader downstream having an opinion about `undefined`.
    for (const raw of ["null", "[]", "42", '"a string"', "true"]) {
      const body = await readJsonBody(jsonRequest(raw));
      expect(body.kind === "rejected" ? body.response.status : 0).toBe(400);
    }
  });

  it("refuses a body that is not JSON at all", async () => {
    const body = await readJsonBody(jsonRequest("{not json"));
    expect(body.kind === "rejected" ? body.response.status : 0).toBe(400);
  });
});

describe("signatureBytes", () => {
  it("decodes base64 of exactly 64 bytes", () => {
    const bytes = new Uint8Array(64).fill(7);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(signatureBytes(btoa(bin))).toEqual(bytes);
  });

  it("refuses anything that is not that", () => {
    // Base64 and nothing else: the client already has an encoder for this exact shape
    // (`LinkAttestation.sig`), so there is one spelling of a signature in the whole feature and no
    // guessing between encodings — `env.ts#decodeSecret` records why this codebase does not guess.
    for (const bad of [
      undefined,
      null,
      42,
      "",
      "not base64",
      "AAAA",
      `${"A".repeat(85)}==`,
      `${"A".repeat(87)}==`,
      `${"A".repeat(86)}=`,
      `${"-".repeat(86)}==`, // base64url, deliberately not accepted
    ]) {
      expect(signatureBytes(bad)).toBeNull();
    }
  });
});

describe("guarded", () => {
  it("passes a response through untouched", async () => {
    const res = await guarded("x/test", async () => okJson({ linked: true }));
    expect(await res.json()).toEqual({ linked: true });
  });

  it("turns a thrown store call into the generic 503", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await guarded("x/test", async () => {
        throw new TypeError("x_link.wallet: expected string, got number");
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("logs the error's NAME and nothing from the error or the request", async () => {
    // §6.4's rule, enforced. A Postgres driver's `message` can carry the offending row ("Key
    // (wallet)=(…) already exists") and this handler's frames have a challenge message and a Privy
    // identity token in scope. `e.name` is the diagnostic part and the part that cannot contain a
    // payload: `TypeError` means the coercion seam caught a changed column, `AbortError` means a timeout.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await guarded("x/link", async () => {
        throw new TypeError("secret-token-abc123 and wallet 7xKq");
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toContain("x/link");
      expect(line).toContain("TypeError");
      expect(line).not.toContain("secret-token-abc123");
      expect(line).not.toContain("7xKq");
    } finally {
      spy.mockRestore();
    }
  });

  it("survives a throw that is not an Error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await guarded("x/test", async () => {
        throw "a string, because somebody can always throw one";
      });
      expect(res.status).toBe(503);
      expect(String(spy.mock.calls[0][0])).toContain("throw");
    } finally {
      spy.mockRestore();
    }
  });
});
