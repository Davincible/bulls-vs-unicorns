// FETCHING A STRANGER'S PICTURE AND TURNING IT INTO SOMETHING SAFE TO SERVE.
//
// This is the only code in the feature that makes an outbound request, and the only code that
// handles bytes an attacker chose. Everything in it is a refusal.
//
// ------------------------------------------------------------------------------------------------
// WHY THIS IS NOT IN THE PROXY, WHICH IS A DEPARTURE FROM §7.2 AND THE MOST IMPORTANT NOTE HERE.
//
// `TWITTER-CONNECT.md` §7.2 describes the avatar proxy as fetching upstream on demand: timeout,
// ceiling, allowlist, re-encode, serve. It then adds one more rule — "never 404 on a transient
// upstream failure, serve the last good bytes" — and that rule is what makes the first design
// impossible to write. "Last good bytes" means the bytes are STORED. Once they are stored, the fetch
// has already happened before the request arrived, and a proxy that fetches on demand is a proxy
// fetching something it already has.
//
// So the fetch moved to where it always belonged: an INGEST, which runs at link time, at refresh
// time, and from the operator command, and which writes `(avatar_hash, avatar_bytes)` atomically.
// The proxy became a pure read. Three things fall out of that, all of them good:
//
//   * "LAST GOOD BYTES" BECOMES FREE AND UNCONDITIONAL. Ingest writes only on success, so a failed
//     fetch is a no-op. There is no cache to expire, no negative entry to reason about, and no way
//     to lose a picture to a timeout. The rule is enforced by there being no code that could break
//     it, which is the only kind of enforcement worth having.
//   * THE READ PATH HAS NO OUTBOUND HTTP AT ALL. A proxy that fetches is an SSRF surface that has to
//     be argued safe. A proxy that reads a row is not an SSRF surface, and nothing has to be argued.
//   * THE IMAGE DECODER LEAVES THE HOT PATH. `sharp` is libvips — a native decoder for six formats,
//     parsing hostile input. Keeping it out of the function a browser can reach is worth more than
//     any bound we could put around it, and it takes the whole undocumented sharp-on-Vercel question
//     out of Stage 2 (see `api/README.md`).
//
// The guards §7.2 asks for are all here, all enforced, and all tested. They just run at write time.
// ------------------------------------------------------------------------------------------------

import { createHash } from "node:crypto";
import sharp from "sharp";

/** X's own image CDN, and nothing else, ever.
 *
 *  THE ANTI-SSRF CONTROL, and it is an allowlist rather than a blocklist because a blocklist of
 *  internal ranges is a list somebody has to keep complete against IPv6, link-local, cloud metadata
 *  endpoints, DNS rebinding and whatever is invented next. An allowlist of one host is complete by
 *  construction. The same constraint is written into the table as a CHECK on `avatar_url`, so a
 *  compromised writer would have to pass a migration review to relax it. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(["pbs.twimg.com"]);

/** §7.2. Three seconds is chosen against X's CDN being either fast or gone; there is no useful
 *  middle. */
export const FETCH_TIMEOUT_MS = 3_000;

/** §7.2. 512 KiB. X's `_400x400` variants are 20-60 KiB, so this is an order of magnitude of slack
 *  and still a bound. Enforced while READING, not from `Content-Length` — a header is a claim. */
export const MAX_UPSTREAM_BYTES = 512 * 1024;

/** The only three types we will decode. Note what is missing: `image/svg+xml`, `image/gif`,
 *  `image/avif`, `image/heic`, and everything else. */
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The served size. Fixed, not derived from the input, because "the bytes we serve are the type and
 *  size we claim" is only true if we choose both. 128 covers a 100px disc at DPR 1.28 and the canvas
 *  never draws a face larger than that. */
export const OUTPUT_SIZE = 128;

/** Ceiling on DECODED pixels, which is a different attack from the byte ceiling above: a 60 KiB PNG
 *  can legally decompress to a gigapixel and take the process out on allocation. 16.7 Mpx (4096²) is
 *  far past any profile picture and far below anything that hurts. sharp's own default is 268 Mpx,
 *  which is not a bound for our purposes. */
const MAX_INPUT_PIXELS = 4096 * 4096;

export type IngestRejection =
  | "bad-url"
  | "host-not-allowed"
  | "upstream-status"
  | "upstream-timeout"
  | "content-type"
  | "too-large"
  | "magic-bytes"
  | "svg"
  | "decode-failed";

export class IngestRefused extends Error {
  readonly reason: IngestRejection;

  constructor(reason: IngestRejection, detail: string) {
    super(`avatar ingest refused (${reason}): ${detail}`);
    this.name = "IngestRefused";
    this.reason = reason;
  }
}

/**
 * `_normal` -> `_400x400`.
 *
 * X's `profile_image_url` hands back the 48x48 thumbnail, which is unusable on a 100px disc — it is
 * the reason a re-encode at 128 would otherwise be upscaling a postage stamp. The rewrite is
 * anchored to the END of the path so a filename that merely contains `_normal` is untouched, and it
 * is applied to the PATHNAME through `URL` rather than to the string, so nothing in a query or a
 * host can be rewritten by it.
 *
 * Exported because it is a claim about X's URL shape that deserves its own test rather than being
 * proven incidentally three layers up.
 */
export function upgradeAvatarUrl(raw: string): string {
  const u = new URL(raw);
  u.pathname = u.pathname.replace(/_normal(\.[A-Za-z0-9]+)?$/, "_400x400$1");
  return u.toString();
}

/** `image/jpeg; charset=binary` -> `image/jpeg`. A parameter is not part of the type and a server
 *  that sends one must not thereby escape the allowlist. */
export function normaliseContentType(raw: string | null): string {
  return (raw ?? "").split(";", 1)[0].trim().toLowerCase();
}

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean =>
  b.length >= sig.length && sig.every((v, i) => b[i] === v);

/**
 * WHAT THE BYTES ACTUALLY ARE, regardless of what the server said they were.
 *
 * Returns the content type the file's own header implies, or `null` for anything unrecognised.
 * `"image/svg+xml"` is returned for SVG SPECIFICALLY rather than folded into `null`, so the caller
 * can refuse it by name — an SVG is a script container, it is the one non-image that browsers will
 * execute, and a rejection that says `svg` is a rejection somebody will find in a log.
 */
export function sniffContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // RIFF....WEBP — the four-byte length in between is content, not signature.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // SVG has no magic number, which is the point: it is text, and text is what a polyglot hides in.
  // Skip a BOM and leading whitespace, then look for the one character that can start markup.
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i += 1;
  if (i < bytes.length && bytes[i] === 0x3c) return "image/svg+xml"; // "<"
  return null;
}

/** Read a response body with a hard ceiling, enforced as it arrives.
 *
 *  `Content-Length` is checked first because it is free, and then IGNORED, because it is a claim by
 *  the same party that chose the body. A server that lies about it — or omits it, or uses chunked
 *  encoding — gets exactly the same bound. */
async function readBounded(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    throw new IngestRefused("too-large", `content-length ${declared} > ${limit}`);
  }
  const body = res.body;
  if (body === null) throw new IngestRefused("upstream-status", "empty body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new IngestRefused("too-large", `body exceeded ${limit} bytes`);
      chunks.push(value);
    }
  } finally {
    // Releases the socket on the refusal path too. Without this a rejected oversize download keeps
    // streaming into a reader nobody is reading.
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The re-encoded result: the bytes we will serve and the name they will be served under. */
export interface IngestedAvatar {
  readonly bytes: Uint8Array;
  /** sha256 of `bytes`, lowercase hex. The CDN cache key and the last path segment. */
  readonly hash: string;
}

/**
 * DECODE AND RE-ENCODE. Passthrough is not acceptable and this is the paragraph that says why.
 *
 * A file can satisfy every check above and still be hostile: a valid JPEG header followed by HTML a
 * sniffing browser will render, a PNG with a payload in an ancillary chunk, a WebP crafted against a
 * decoder bug. What defuses all of them at once is not another check — it is refusing to forward the
 * attacker's bytes at all. We decode the file into a pixel buffer, throw the container away, and
 * write a brand new one. Whatever was in the original that was not a picture did not survive the
 * trip, because nothing survived the trip except pixels.
 *
 * It also makes the response honest: the bytes we serve are a 128x128 WebP because we just made one,
 * not because a header said so.
 *
 * A FILE THAT DOES NOT DECODE IS A REFUSAL, not a passthrough and not a placeholder. sharp throws on
 * malformed input by default and that throw is the answer.
 *
 * No metadata is carried over — sharp copies none unless asked, so EXIF (including GPS) is dropped
 * as a side effect of the re-encode rather than as a step somebody has to remember.
 */
export async function reencode(input: Uint8Array): Promise<IngestedAvatar> {
  let out: Buffer;
  try {
    out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  } catch (e) {
    throw new IngestRefused("decode-failed", e instanceof Error ? e.message : String(e));
  }
  const bytes = new Uint8Array(out);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

export interface FetchAvatarDeps {
  readonly fetch: typeof globalThis.fetch;
}

/**
 * The whole ingest, minus storage: fetch, refuse, re-encode.
 *
 * @throws IngestRefused for every rejection, with a reason a log line can be grepped for. There is
 *   no partial success and no "best effort" return: the caller's only correct behaviour on any
 *   refusal is to write nothing, which leaves the previous picture in place.
 */
export async function fetchAndReencode(avatarUrl: string, deps: FetchAvatarDeps): Promise<IngestedAvatar> {
  let url: URL;
  try {
    url = new URL(upgradeAvatarUrl(avatarUrl));
  } catch {
    throw new IngestRefused("bad-url", avatarUrl);
  }
  if (url.protocol !== "https:") throw new IngestRefused("bad-url", `protocol ${url.protocol}`);
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new IngestRefused("host-not-allowed", url.hostname);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await deps.fetch(url.toString(), {
      signal: ctl.signal,
      // NO REDIRECTS. A 302 to `http://169.254.169.254/` is the standard way past a host allowlist,
      // because the allowlist was checked against the URL we sent and not the one we followed.
      // Refusing to follow is simpler than re-checking each hop and cannot be got wrong.
      redirect: "error",
      headers: { Accept: "image/jpeg,image/png,image/webp" },
    });
  } catch (e) {
    clearTimeout(timer);
    throw new IngestRefused("upstream-timeout", e instanceof Error ? e.message : String(e));
  }

  try {
    if (!res.ok) throw new IngestRefused("upstream-status", `HTTP ${res.status}`);

    const declaredType = normaliseContentType(res.headers.get("content-type"));
    // FIRST OF THE TWO SVG REFUSALS, by declared type.
    if (declaredType === "image/svg+xml") throw new IngestRefused("svg", "declared image/svg+xml");
    if (!ALLOWED_CONTENT_TYPES.has(declaredType)) {
      throw new IngestRefused("content-type", declaredType || "(absent)");
    }

    const raw = await readBounded(res, MAX_UPSTREAM_BYTES);

    const sniffed = sniffContentType(raw);
    // SECOND SVG REFUSAL, by content. A server that declares `image/png` and sends `<svg …>` is
    // caught here even though the header passed — which is the entire reason there are two checks
    // and not one.
    if (sniffed === "image/svg+xml") throw new IngestRefused("svg", "body is markup");
    if (sniffed === null) throw new IngestRefused("magic-bytes", "unrecognised signature");
    // The declared type and the actual bytes must AGREE. A mismatch is not a mislabelled file to be
    // helpfully corrected — it is the signature of a polyglot, and the correct response to being
    // told two different things is to believe neither.
    if (sniffed !== declaredType) {
      throw new IngestRefused("magic-bytes", `declared ${declaredType}, bytes are ${sniffed}`);
    }

    return await reencode(raw);
  } finally {
    clearTimeout(timer);
  }
}
