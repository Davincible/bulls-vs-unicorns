// FETCH, RE-ENCODE AND STORE ONE AVATAR.
//
//     bun run scripts/xlink-ingest.ts <x_id>
//     bun run scripts/xlink-ingest.ts --all        # every row that has no bytes yet
//
// Needs `DATABASE_URL`. Reaches exactly one host on the internet: `pbs.twimg.com`.
//
// ------------------------------------------------------------------------------------------------
// WHY THIS IS A COMMAND AND NOT PART OF THE PROXY.
//
// `TWITTER-CONNECT.md` §7.2 describes the proxy fetching on demand, and then adds "never 404 on a
// transient upstream failure — serve the last good bytes", which makes the first design impossible:
// "last good bytes" means the bytes are stored, and once they are stored the fetch has already
// happened. So the fetch lives here. `avatarIngest.ts`'s header has the full argument.
//
// The practical consequence for whoever runs this: A FAILED RUN IS A NO-OP. Every refusal throws
// before the write, so a timeout, a 404 at X, a malformed file or a decoder error all leave the
// previous picture exactly where it was. There is no partial state to clean up and no reason to
// hesitate about re-running it.
//
// In Stage 3 the link ceremony calls `fetchAndReencode` + `putAvatar` inline and this command
// becomes the repair tool rather than the only path.

import { fetchAndReencode, IngestRefused } from "../er-demo/api/src/avatarIngest.ts";
import { neonSql, neonStore } from "../er-demo/api/src/neonStore.ts";
import { assertNotReserved, ReservedXIdError } from "../er-demo/api/src/reserved.ts";

const arg = process.argv[2];
if (arg === undefined) {
  process.stderr.write("usage: bun run scripts/xlink-ingest.ts <x_id> | --all\n");
  process.exit(2);
}

const sql = neonSql(process.env);
const store = neonStore(process.env);

async function pending(): Promise<string[]> {
  // `avatar_url IS NOT NULL` is part of "pending", not a filter applied afterwards. A row with no
  // upstream picture is permanently in the `avatar_hash IS NULL` set — there is nothing that could ever
  // move it out — so including it would make every `--all` run report the same rows as skipped for
  // ever, and (because a run whose every row was skipped exits non-zero) would make a healthy database
  // look like a broken command. Selecting only rows there is something to do about keeps "nothing
  // pending" meaning what it says.
  const rows = await sql`
    SELECT x_id
      FROM x_link
     WHERE avatar_hash IS NULL
       AND avatar_url IS NOT NULL
       AND NOT suppressed
     ORDER BY linked_at
  `;
  return rows.map((r) => String(r.x_id));
}

async function ingestOne(xId: string): Promise<boolean> {
  const target = await store.findForIngest(xId);
  if (target === null) {
    process.stderr.write(`  ${xId}: no such row\n`);
    return false;
  }
  // A suppressed identity is one an operator has already taken down. Fetching its picture would be
  // the ingest quietly undoing a moderation decision, which is why `findForIngest` returns
  // suppressed rows rather than hiding them: it must be able to SEE the flag in order to refuse.
  if (target.suppressed) {
    process.stderr.write(`  ${xId}: suppressed — refusing to ingest\n`);
    return false;
  }
  // NOTHING TO FETCH IS NOT A FAILURE. Since migration 0002 `avatar_url` may be NULL, which means the
  // X account has no profile picture — X serves the default egg from a host this column may not name,
  // and the arena's flat side-coloured disc is the better rendering anyway (§7.3). The row stays with
  // `avatar_hash` NULL, which is the same state as "avatar in flight" and renders identically, so
  // `--all` must not report this as an error or every run would look broken.
  if (target.avatarUrl === null) {
    process.stdout.write(`  ${xId}: no upstream picture — nothing to ingest\n`);
    return false;
  }
  try {
    // Belt and braces against the `?links=mock` fixture ids. The register should never contain one;
    // if it somehow does, no bytes are ever minted for it.
    assertNotReserved(xId);
    const out = await fetchAndReencode(target.avatarUrl, { fetch: globalThis.fetch });
    const wrote = await store.putAvatar(xId, out.hash, out.bytes, Math.floor(Date.now() / 1000));
    process.stdout.write(
      wrote
        ? `  ${xId}: ok  ${out.bytes.byteLength} bytes  /api/avatar/${xId}/${out.hash}.webp\n`
        : `  ${xId}: row vanished mid-ingest — nothing written\n`,
    );
    return wrote;
  } catch (e) {
    if (e instanceof IngestRefused) {
      // The reason is the grep key. Every one of these leaves the previous picture in place.
      process.stderr.write(`  ${xId}: REFUSED (${e.reason}) ${e.message}\n`);
      return false;
    }
    if (e instanceof ReservedXIdError) {
      process.stderr.write(`  ${xId}: REFUSED (reserved fixture id)\n`);
      return false;
    }
    throw e;
  }
}

const ids = arg === "--all" ? await pending() : [arg];
if (ids.length === 0) {
  process.stdout.write("nothing pending\n");
  process.exit(0);
}

process.stdout.write(`ingesting ${ids.length} avatar(s)\n`);
let ok = 0;
for (const id of ids) if (await ingestOne(id)) ok += 1;
process.stdout.write(`\n${ok}/${ids.length} succeeded. Failures changed nothing.\n`);
// Non-zero only when everything failed — a partial run is a normal outcome for a batch that
// includes a deleted X account, and it must not read as a broken command.
process.exit(ok === 0 && ids.length > 0 ? 1 : 0);
