// SEED A LINK BY HAND. Stage 2 only.
//
//     bun run scripts/xlink-seed.ts --list
//     bun run scripts/xlink-seed.ts <x_id> <wallet> <handle> [display name] [avatar_url]
//     bun run scripts/xlink-seed.ts --delete <x_id>
//
// Needs `DATABASE_URL`.
//
// ------------------------------------------------------------------------------------------------
// THIS DELIBERATELY BYPASSES `LinkStore`, AND THAT IS THE POINT.
//
// The store interface has no `createLink` and never will. In production the ONLY thing that may
// create a row is the ceremony in §4.1, where a wallet signature and an OAuth proof are bound
// together in one message — the whole feature exists to make a link without both of those
// unrepresentable. Giving the shared interface a create method would put that capability one
// autocomplete away from every handler.
//
// So this is a hand-run SQL statement, in a file marked Stage 2, which is exactly what it is: the
// equivalent of opening `psql` and typing an INSERT. It exists so §10's "seed two rows by hand and
// point the Stage-0 client at it with `?links=api`" can be done without anybody inventing a write
// endpoint that then has to be deleted.
//
// DELETE IT WHEN STAGE 3 LANDS. Once the ceremony exists, this file is a way to put an unproven
// identity in the register, which is the exact defect `web/index.html:2900` shipped.
// ------------------------------------------------------------------------------------------------

import { PublicKey } from "@solana/web3.js";
import { neonSql } from "../er-demo/api/src/neonStore.ts";
import { assertNotReserved } from "../er-demo/api/src/reserved.ts";

const argv = process.argv.slice(2);

const USAGE =
  "usage: bun run scripts/xlink-seed.ts <x_id> <wallet> <handle> [display name] [avatar_url]\n" +
  "       bun run scripts/xlink-seed.ts --list\n" +
  "       bun run scripts/xlink-seed.ts --delete <x_id>\n";

// Usage BEFORE the connection is opened. `neonSql` throws loudly when `DATABASE_URL` is missing —
// which is right for a server cold start and wrong for somebody at a terminal who just wants to see
// the arguments. A tool that answers "you forgot a variable" to "what are the arguments" trains
// people to stop reading its output.
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  process.stdout.write(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}

const sql = neonSql(process.env);

if (argv[0] === "--list") {
  const rows = await sql`
    SELECT x_id, wallet, handle, display_name, avatar_hash, suppressed,
           extract(epoch from linked_at)::bigint AS linked_at
      FROM x_link ORDER BY linked_at`;
  if (rows.length === 0) process.stdout.write("register is empty\n");
  for (const r of rows) {
    process.stdout.write(
      `${String(r.x_id).padEnd(20)} @${String(r.handle).padEnd(16)} ${String(r.wallet)}  ` +
        `avatar=${r.avatar_hash === null ? "none" : "yes"} suppressed=${r.suppressed}\n`,
    );
  }
  process.exit(0);
}

if (argv[0] === "--delete") {
  const xId = argv[1];
  if (xId === undefined) {
    process.stderr.write("usage: bun run scripts/xlink-seed.ts --delete <x_id>\n");
    process.exit(2);
  }
  const gone = await sql`DELETE FROM x_link WHERE x_id = ${xId} RETURNING x_id`;
  process.stdout.write(gone.length === 1 ? `deleted ${xId}\n` : `no row for ${xId}\n`);
  process.exit(gone.length === 1 ? 0 : 1);
}

const [xId, wallet, handle, displayName = "", avatarUrl] = argv;
if (xId === undefined || wallet === undefined || handle === undefined) {
  process.stderr.write(USAGE);
  process.exit(2);
}

// Validated HERE as well as by the table's CHECK constraints, because a constraint violation from a
// driver is a wall of SQL and this is a person at a terminal. Same rules, better sentence.
if (!/^[0-9]{1,20}$/.test(xId)) throw new Error(`x_id must be 1-20 digits, got "${xId}"`);
if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error(`handle must match X's rules, got "${handle}"`);
if (new PublicKey(wallet).toBytes().length !== 32) throw new Error("wallet must be a base58 ed25519 pubkey");
assertNotReserved(xId);

// NULL, NOT A PLACEHOLDER URL, when no picture is given.
//
// This used to default to `https://pbs.twimg.com/sticky/default_profile_images/default_profile_normal.png`
// with the note that it "is a real pbs.twimg.com URL and therefore satisfies the table's anti-SSRF
// CHECK". It satisfied the CHECK and it is not a real URL: X's default profile images live on
// `abs.twimg.com`, so that path 404s at ingest — permanently, on every run, for every row seeded
// without a picture. The column said "the picture is at this address" about an address with no picture
// at it, which is a lie in the data whose only cost is a failing fetch for ever.
//
// Migration 0002 makes the column nullable precisely so that "there is no picture" can be stated
// rather than faked; the write path needs it for X accounts with no avatar, and this command should
// not model the world differently from the ceremony. `xlink-ingest.ts` skips a NULL row, the read path
// emits `avatarPath: ""`, and the client draws the flat side-coloured disc — §7.3's ordinary rung.
const url = avatarUrl ?? null;

// UPSERT ON `x_id`, and the `wallet` unique index does the rest: moving an X account to a new wallet
// updates this row and, because no two rows may share a wallet, cannot leave the old pairing behind.
// One statement, one lock, no window in which one identity is on two fighters.
await sql`
  INSERT INTO x_link (x_id, wallet, handle, display_name, avatar_url, linked_at, refreshed_at)
  VALUES (${xId}, ${wallet}, ${handle}, ${displayName}, ${url}, now(), now())
  ON CONFLICT (x_id) DO UPDATE
    SET wallet       = EXCLUDED.wallet,
        handle       = EXCLUDED.handle,
        display_name = EXCLUDED.display_name,
        avatar_url   = EXCLUDED.avatar_url,
        refreshed_at = now()`;

process.stdout.write(
  `seeded ${xId} -> @${handle} on ${wallet}\n` +
    `next: bun run scripts/xlink-ingest.ts ${xId}   (fetch and re-encode the picture)\n`,
);
