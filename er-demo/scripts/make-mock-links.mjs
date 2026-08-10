// Regenerates the `?links=mock` fixture: `public/links.mock.json` and the avatar images beside it.
//
// Run from `er-demo/`:   node scripts/make-mock-links.mjs
//
// REQUIRES `ffmpeg` on PATH, for one job only: encoding WebP. Node has no WebP encoder and macOS's
// `sips` does not write the format. The PNGs this script draws are produced by the little encoder
// below rather than by a dependency, because a build-time image library for six 128px squares would
// be a supply-chain surface bought for nothing.
//
// WHY THE OUTPUT IS COMMITTED. The fixture is the artifact design review works from, and a reviewer
// should not need ffmpeg to open the page. Regenerating is deterministic — same seed, same colours,
// same bytes, same hashes — so re-running this on a clean tree produces no diff. If it does produce
// one, something changed that was meant to be frozen.
//
// WHAT IS *NOT* GENERATED HERE: signatures. Attestations expire after seven days, so a committed
// signature would rot and `?links=mock` would quietly start rendering everybody as unlinked. The
// fixture therefore holds unsigned payloads and `data/mockLinks.ts` signs them at load with the key
// derived from `MOCK_ATTESTATION_SEED`. See that file, and see `linkSource.ts` for why publishing
// the seed is safe.

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const AVATAR_ROOT = join(PUBLIC, "api", "avatar");

// ------------------------------------------------------------------------------------------------
// The cast
// ------------------------------------------------------------------------------------------------

// RESERVED X IDS. Real X account ids are 19-digit snowflakes; these are 16 digits in a 999… block
// that X has not reached and will not reach for the lifetime of this program. They are reserved so
// that the static files this script writes under `public/api/avatar/…` can never collide with a path
// the real proxy would serve, and the real proxy carries the same list as a deny-list so it can
// never mint one either. Two independent statements of one fact, which is what makes it a rule.
//
// EVERY HANDLE IS PREFIXED `mock_`, and that is not decoration. A screenshot of this fixture must be
// impossible to mistake for a real person's identity on the real leaderboard — the entire feature
// exists because the old build let a typed handle wear somebody else's name.
const CAST = [
  { xId: "9990000000000001", handle: "mock_kestrel", displayName: "Kestrel", bg: [0x27, 0x88, 0x34], fg: [0xf6, 0xf6, 0xf6], r: 0.42 },
  { xId: "9990000000000002", handle: "mock_otter", displayName: "Otter 🦦", bg: [0x8f, 0x09, 0xbf], fg: [0xf7, 0xce, 0x2b], r: 0.30 },
  { xId: "9990000000000003", handle: "mock_vole", displayName: "", bg: [0x0b, 0x0b, 0x0b], fg: [0xc4, 0x29, 0x1a], r: 0.48 },
  { xId: "9990000000000004", handle: "mock_shrike", displayName: "Shrike, of the , and : persuasion", bg: [0xc4, 0x29, 0x1a], fg: [0x0b, 0x0b, 0x0b], r: 0.22 },
  { xId: "9990000000000005", handle: "mock_marten", displayName: "Marten", bg: [0xf7, 0xce, 0x2b], fg: [0x27, 0x88, 0x34], fg2: true, r: 0.36 },
  { xId: "9990000000000006", handle: "mock_tern", displayName: "Tern", bg: [0x4d, 0x4d, 0x4d], fg: [0xf6, 0xf6, 0xf6], r: 0.5 },
];

// `mock_shrike`'s display name carries the netstring delimiters `,` and `:`, and `mock_otter`'s
// carries an astral-plane emoji. Both are in the fixture rather than only in the unit tests because
// the canonical encoding's whole reason for existing is that a display name is arbitrary
// user-controlled unicode — so the fixture that exercises the signing path should contain the two
// inputs that break a naive encoder, and it should do so on every page load.

// ------------------------------------------------------------------------------------------------
// A very small PNG encoder — truecolour, 8-bit, no interlacing
// ------------------------------------------------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xed_b8_83_20 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A 128×128 disc: `fg` circle of radius `r × size` on a `bg` field. Distinguishable by hue alone at
 *  16px, which is the size these are actually read at in a table. */
function drawAvatar({ bg, fg, r }, size = 128) {
  const rows = [];
  const cx = (size - 1) / 2;
  const rad = r * size;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const inside = (x - cx) ** 2 + (y - cx) ** 2 <= rad ** 2;
      const [r8, g8, b8] = inside ? fg : bg;
      row[1 + x * 3] = r8;
      row[2 + x * 3] = g8;
      row[3 + x * 3] = b8;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    // Level 9 and a fixed strategy so the bytes are reproducible across Node versions.
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function toWebp(png) {
  const scratch = join(tmpdir(), `bvu-mock-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const src = join(scratch, "in.png");
  const out = join(scratch, "out.webp");
  writeFileSync(src, png);
  // `-lossless 1` so the output is a deterministic function of the input; a lossy encoder's output
  // can vary with the build of libwebp, and the content hash is a filename here.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-lossless", "1", out]);
  const bytes = readFileSync(out);
  rmSync(scratch, { recursive: true, force: true });
  return bytes;
}

// ------------------------------------------------------------------------------------------------

function main() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    console.error("ffmpeg is required to regenerate the mock avatars (WebP encoding). Install it and re-run.");
    process.exit(1);
  }

  // Wipe the reserved tree rather than merging into it, so a cast member removed from the list above
  // does not leave an orphan image behind that nothing references and nobody deletes.
  rmSync(AVATAR_ROOT, { recursive: true, force: true });

  const identities = CAST.map((c) => {
    const webp = toWebp(drawAvatar(c));
    const hash = createHash("sha256").update(webp).digest("hex");
    const dir = join(AVATAR_ROOT, c.xId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${hash}.webp`), webp);
    return { xId: c.xId, handle: c.handle, displayName: c.displayName, avatarHash: hash };
  });

  // One identity deliberately carries NO avatar. "Linked, but the picture has not arrived" is a real
  // rung on `TWITTER-CONNECT.md` §7.3's failure ladder and it renders as the ordinary flat disc — the
  // fixture should contain it so that rung is on screen during design review rather than only in a
  // test. `mock_tern` keeps its image on disk; the fixture simply does not reference it.
  identities[identities.length - 1] = { ...identities[identities.length - 1], avatarHash: "" };

  const fixture = {
    note:
      "Fixture for ?links=mock. UNSIGNED payloads — data/mockLinks.ts signs these at load with the "
      + "key derived from MOCK_ATTESTATION_SEED, because a committed signature would expire after "
      + "seven days and silently render everybody unlinked. Regenerate with "
      + "`node scripts/make-mock-links.mjs`. Handles are prefixed mock_ so a screenshot of this can "
      + "never be mistaken for a real identity.",
    identities,
  };
  writeFileSync(join(PUBLIC, "links.mock.json"), `${JSON.stringify(fixture, null, 2)}\n`);

  const written = readdirSync(AVATAR_ROOT).length;
  console.log(`wrote public/links.mock.json (${identities.length} identities) and ${written} avatar directories`);
}

main();
