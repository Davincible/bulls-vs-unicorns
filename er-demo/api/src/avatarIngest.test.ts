// The one place in this feature that handles bytes an attacker chose.
//
// Every test here names an attack. None of them needs the network: `fetchAndReencode` takes its
// `fetch`, so a hostile upstream is a three-line function rather than a container.

import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  fetchAndReencode,
  IngestRefused,
  MAX_UPSTREAM_BYTES,
  normaliseContentType,
  OUTPUT_SIZE,
  reencode,
  sniffContentType,
  upgradeAvatarUrl,
} from "./avatarIngest.ts";

const URL_NORMAL = "https://pbs.twimg.com/profile_images/1521/face_normal.jpg";

/** A real, decodable image of the given format — built by the same library that will re-encode it,
 *  so these tests exercise a genuine decode rather than a hand-rolled header. */
async function realImage(format: "jpeg" | "png" | "webp", size = 64): Promise<Uint8Array> {
  const base = sharp({ create: { width: size, height: size, channels: 3, background: { r: 12, g: 200, b: 90 } } });
  const buf = await (format === "jpeg" ? base.jpeg() : format === "png" ? base.png() : base.webp()).toBuffer();
  return new Uint8Array(buf);
}

function upstream(opts: {
  body?: Uint8Array | string;
  type?: string | null;
  status?: number;
  contentLength?: string;
  throws?: boolean;
}): typeof globalThis.fetch {
  return (async () => {
    if (opts.throws) throw new Error("network down");
    const headers = new Headers();
    if (opts.type !== null && opts.type !== undefined) headers.set("content-type", opts.type);
    if (opts.contentLength !== undefined) headers.set("content-length", opts.contentLength);
    const b = typeof opts.body === "string" ? new TextEncoder().encode(opts.body) : opts.body;
    return new Response(b ?? new Uint8Array(0), {
      status: opts.status ?? 200,
      headers,
    });
  }) as unknown as typeof globalThis.fetch;
}

async function refusal(fn: () => Promise<unknown>): Promise<IngestRefused> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof IngestRefused) return e;
    throw e;
  }
  throw new Error("expected an IngestRefused, got success");
}

describe("upgradeAvatarUrl", () => {
  it("rewrites the trailing _normal to _400x400", () => {
    // X's `profile_image_url` hands back the 48x48 thumbnail. Without this, a 128px disc is an
    // upscaled postage stamp — the whole re-encode would be sharpening mush.
    expect(upgradeAvatarUrl(URL_NORMAL)).toBe("https://pbs.twimg.com/profile_images/1521/face_400x400.jpg");
  });

  it("leaves a filename that merely contains _normal alone", () => {
    // Anchored to the end of the path, so `_normal_photo.jpg` is not mangled into a 404.
    const u = "https://pbs.twimg.com/profile_images/1/_normal_photo.jpg";
    expect(upgradeAvatarUrl(u)).toBe(u);
  });

  it("cannot rewrite anything outside the path", () => {
    // Applied to `URL.pathname`, so nothing in a host or a query can be touched by it.
    const u = "https://pbs.twimg.com/profile_images/1/a.jpg?x=b_normal";
    expect(upgradeAvatarUrl(u)).toBe(u);
  });
});

describe("normaliseContentType", () => {
  it("strips parameters and case", () => {
    // A parameter is not part of the type, and a server that sends one must not thereby escape the
    // allowlist. `IMAGE/PNG; charset=binary` is `image/png`.
    expect(normaliseContentType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(normaliseContentType(null)).toBe("");
  });
});

describe("sniffContentType", () => {
  it("recognises the three formats we accept", async () => {
    expect(sniffContentType(await realImage("jpeg"))).toBe("image/jpeg");
    expect(sniffContentType(await realImage("png"))).toBe("image/png");
    expect(sniffContentType(await realImage("webp"))).toBe("image/webp");
  });

  it("names SVG specifically rather than folding it into 'unrecognised'", () => {
    // SVG is the one non-image a browser executes. A rejection that says `svg` is a rejection
    // somebody can find in a log; `unrecognised` is not.
    expect(sniffContentType(new TextEncoder().encode("<svg xmlns='...'/>"))).toBe("image/svg+xml");
    expect(sniffContentType(new TextEncoder().encode("<?xml version='1.0'?><svg/>"))).toBe("image/svg+xml");
    // Leading whitespace and a BOM are the two standard ways to hide the opening bracket.
    expect(sniffContentType(new TextEncoder().encode("\n\t  <svg/>"))).toBe("image/svg+xml");
    expect(sniffContentType(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x73]))).toBe("image/svg+xml");
  });

  it("does not mistake a RIFF container that is not WebP for a WebP", () => {
    // `RIFF....WAVE` is a sound file. The four bytes at offset 8 are the discriminator.
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffContentType(wav)).toBeNull();
  });
});

describe("reencode", () => {
  it("produces a fixed 128x128 WebP whatever went in", async () => {
    // The claim the response headers make must be a fact we created, not a header we believed.
    for (const format of ["jpeg", "png", "webp"] as const) {
      const out = await reencode(await realImage(format, 300));
      const meta = await sharp(out.bytes).metadata();
      expect(meta.format, format).toBe("webp");
      expect(meta.width, format).toBe(OUTPUT_SIZE);
      expect(meta.height, format).toBe(OUTPUT_SIZE);
    }
  });

  it("names the output by the sha256 of its own bytes", async () => {
    // The hash IS the cache key and the integrity claim. It must be of what we serve, not of what we
    // fetched, or the URL stops being a promise about the body.
    const out = await reencode(await realImage("png"));
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    const again = await reencode(await realImage("png"));
    expect(again.hash).toBe(out.hash); // deterministic for identical input
  });

  it("throws away everything that was not a pixel", async () => {
    // THE REASON PASSTHROUGH IS NOT ACCEPTABLE. A file can pass every header and magic-byte check
    // and still carry a payload in a trailer or an ancillary chunk. Decoding into a pixel buffer and
    // writing a brand new container means nothing survived except the picture.
    const png = await realImage("png");
    const polyglot = new Uint8Array(png.length + 64);
    polyglot.set(png, 0);
    polyglot.set(new TextEncoder().encode("<script>alert(1)</script>PAYLOAD"), png.length);

    const out = await reencode(polyglot);
    const text = new TextDecoder("latin1").decode(out.bytes);
    expect(text).not.toContain("script");
    expect(text).not.toContain("PAYLOAD");
    expect((await sharp(out.bytes).metadata()).format).toBe("webp");
  });

  it("refuses a file that does not decode", async () => {
    // "A file that does not decode is a 404." Not a placeholder, not a passthrough.
    const e = await refusal(() => reencode(new TextEncoder().encode("this is not an image at all")));
    expect(e.reason).toBe("decode-failed");
  });
});

describe("fetchAndReencode", () => {
  it("accepts a well-formed JPEG from X's CDN", async () => {
    const jpg = await realImage("jpeg", 300);
    const out = await fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: jpg, type: "image/jpeg" }) });
    expect((await sharp(out.bytes).metadata()).width).toBe(OUTPUT_SIZE);
  });

  it("refuses any host but X's image CDN", async () => {
    // THE ANTI-SSRF CONTROL. An allowlist of one host is complete by construction; a blocklist of
    // internal ranges is a list somebody has to keep complete against IPv6, link-local, cloud
    // metadata endpoints and DNS rebinding.
    for (const u of [
      "https://evil.example/a.jpg",
      "https://169.254.169.254/latest/meta-data/",
      "https://pbs.twimg.com.evil.example/a.jpg",
      "https://localhost/a.jpg",
    ]) {
      const e = await refusal(() => fetchAndReencode(u, { fetch: upstream({}) }));
      expect(e.reason, u).toBe("host-not-allowed");
    }
  });

  it("refuses a non-https URL and an unparseable one", async () => {
    expect((await refusal(() => fetchAndReencode("http://pbs.twimg.com/a.jpg", { fetch: upstream({}) }))).reason)
      .toBe("bad-url");
    expect((await refusal(() => fetchAndReencode("not a url", { fetch: upstream({}) }))).reason).toBe("bad-url");
  });

  it("REFUSES SVG BY DECLARED CONTENT TYPE", async () => {
    const e = await refusal(() =>
      fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: "<svg/>", type: "image/svg+xml" }) }),
    );
    expect(e.reason).toBe("svg");
  });

  it("REFUSES SVG BY CONTENT even when the header claims PNG", async () => {
    // The second of the two checks, and the reason there are two. A server that declares `image/png`
    // and sends markup is caught here even though the header passed the allowlist.
    const e = await refusal(() =>
      fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: "<svg onload=alert(1)/>", type: "image/png" }) }),
    );
    expect(e.reason).toBe("svg");
  });

  it("refuses a content type outside the allowlist", async () => {
    for (const type of ["image/gif", "text/html", "application/octet-stream", "image/avif", ""]) {
      const e = await refusal(() => fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: "x", type }) }));
      expect(e.reason, type).toBe("content-type");
    }
  });

  it("refuses a missing content type", async () => {
    const e = await refusal(() => fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: "x", type: null }) }));
    expect(e.reason).toBe("content-type");
  });

  it("refuses when the magic bytes disagree with the declared type", async () => {
    // A mismatch is not a mislabelled file to be helpfully corrected. It is the signature of a
    // polyglot, and the correct response to being told two different things is to believe neither.
    const png = await realImage("png");
    const e = await refusal(() => fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: png, type: "image/jpeg" }) }));
    expect(e.reason).toBe("magic-bytes");
  });

  it("refuses bytes with no recognised signature at all", async () => {
    const e = await refusal(() =>
      fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: "MZ binary", type: "image/png" }) }),
    );
    expect(e.reason).toBe("magic-bytes");
  });

  it("refuses an oversize body even when Content-Length lies about it", async () => {
    // The ceiling is enforced WHILE READING. A header is a claim by the same party that chose the
    // body; a server that omits it, understates it, or uses chunked encoding gets the same bound.
    const huge = new Uint8Array(MAX_UPSTREAM_BYTES + 1024);
    huge.set([0xff, 0xd8, 0xff], 0);
    const e = await refusal(() =>
      fetchAndReencode(URL_NORMAL, { fetch: upstream({ body: huge, type: "image/jpeg", contentLength: "42" }) }),
    );
    expect(e.reason).toBe("too-large");
  });

  it("refuses an oversize body by its declared length before reading a byte", async () => {
    const e = await refusal(() =>
      fetchAndReencode(URL_NORMAL, {
        fetch: upstream({ body: new Uint8Array(4), type: "image/jpeg", contentLength: String(MAX_UPSTREAM_BYTES + 1) }),
      }),
    );
    expect(e.reason).toBe("too-large");
  });

  it("refuses a non-200 upstream", async () => {
    const e = await refusal(() => fetchAndReencode(URL_NORMAL, { fetch: upstream({ status: 404, type: "image/png" }) }));
    expect(e.reason).toBe("upstream-status");
  });

  it("refuses — rather than hangs or throws something unrecognisable — when the network fails", async () => {
    // THE "LAST GOOD BYTES" GUARANTEE, at its root. Every failure is an `IngestRefused`, the caller
    // writes nothing, and the previous picture is still in the row. A transient upstream failure
    // cannot lose an avatar because there is no code path in which it writes.
    const e = await refusal(() => fetchAndReencode(URL_NORMAL, { fetch: upstream({ throws: true }) }));
    expect(e.reason).toBe("upstream-timeout");
  });

  it("does not follow redirects", async () => {
    // A 302 to `http://169.254.169.254/` is the standard way past a host allowlist, because the
    // allowlist was checked against the URL we sent and not the one we followed. `redirect: "error"`
    // makes the fetch itself reject.
    const redirecting = (async () => {
      throw new TypeError("unexpected redirect");
    }) as unknown as typeof globalThis.fetch;
    const e = await refusal(() => fetchAndReencode(URL_NORMAL, { fetch: redirecting }));
    expect(e.reason).toBe("upstream-timeout");
  });
});
