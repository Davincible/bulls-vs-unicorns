// THE KILL SWITCH (TWITTER-CONNECT.md §7.4). Run this during an incident, not after.
//
//     bun run scripts/xlink-suppress.ts <x_id> on      # take the identity down
//     bun run scripts/xlink-suppress.ts <x_id> off     # put it back
//     bun run scripts/xlink-suppress.ts <x_id>         # show the current state, change nothing
//
// Needs `DATABASE_URL`. Nothing else.
//
// ------------------------------------------------------------------------------------------------
// WHAT IT ACTUALLY DOES, so that whoever runs it at 3am knows what they have promised.
//
//   * `/api/links` stops emitting the row IMMEDIATELY. The store filters `NOT suppressed` in the
//     WHERE clause, so there is no cache to clear and no handler that could forget. A browser may
//     hold its previous response for up to 30 seconds (`private, max-age=30`) and any attestation
//     already in a tab stays valid until it expires, which is at most seven days for a tab nobody
//     reloads. In practice the leaderboard drops the identity on its next poll.
//   * The avatar proxy 404s IMMEDIATELY, for the same reason.
//   * Bytes already in a CDN or a browser cache persist for up to 24 HOURS. Nothing points at them —
//     no attestation carries the path any more — so they are unreferenced rather than served. This
//     is the number §6.2 promises the player, and it is the price of a revocable cache.
//
// IT IS A FLAG, NOT A DELETE, and the two must stay different operations. This one is an operator's
// judgement about a picture and it is reversible. A delete is the player's own revocation (§6.2),
// and it must remain available to them afterwards.
//
// TAKES AN `x_id`, NOT A HANDLE. Handles are recyclable and drift; the numeric id is the identity.
// Find it in the register with `xlink-seed.ts --list`, or in the `handle` column of the row.

import { neonStore } from "../er-demo/api/src/neonStore.ts";
import { neonSql } from "../er-demo/api/src/neonStore.ts";

const [xId, verb] = process.argv.slice(2);

if (xId === undefined || !/^[0-9]{1,20}$/.test(xId)) {
  process.stderr.write("usage: bun run scripts/xlink-suppress.ts <x_id> [on|off]\n");
  process.exit(2);
}
if (verb !== undefined && verb !== "on" && verb !== "off") {
  process.stderr.write(`unknown verb "${verb}" — expected "on" or "off"\n`);
  process.exit(2);
}

const sql = neonSql(process.env);

async function show(label: string): Promise<void> {
  const rows = await sql`SELECT handle, suppressed, avatar_hash FROM x_link WHERE x_id = ${xId}`;
  if (rows.length === 0) {
    process.stderr.write(`no row for x_id ${xId}\n`);
    process.exit(1);
  }
  const r = rows[0] as { handle: string; suppressed: boolean; avatar_hash: string | null };
  process.stdout.write(
    `${label}  x_id=${xId}  @${r.handle}  suppressed=${r.suppressed}  avatar=${r.avatar_hash === null ? "none" : "present"}\n`,
  );
}

await show("before:");

if (verb !== undefined) {
  const ok = await neonStore(process.env).setSuppressed(xId, verb === "on");
  if (!ok) {
    // `false` here means the id vanished between the two statements, which is worth saying out loud
    // rather than reporting success. An operator typing an id wrong during an incident must not be
    // told it worked.
    process.stderr.write(`x_id ${xId} not found — NOTHING WAS CHANGED\n`);
    process.exit(1);
  }
  await show("after: ");
  process.stdout.write(
    verb === "on"
      ? "\nThe leaderboard drops this identity on its next poll. Cached image bytes may persist for\n" +
          "up to 24 hours but nothing links to them any more.\n"
      : "\nRestored. The identity reappears on the next poll.\n",
  );
}
