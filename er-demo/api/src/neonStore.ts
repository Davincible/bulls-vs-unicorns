// THE ONE FILE THAT NAMES NEON.
//
// `createPgStore` takes a tagged-template query function and knows nothing about a driver, which is
// what keeps `pgStore.ts` inside `npm test` and `npm run typecheck`. This is the two lines that were
// left over, kept together so that swapping to `pg`, to `postgres.js`, or to a different Postgres
// entirely is an edit to one file rather than a search.
//
// It is imported by the entry points in `/api` and by the operator commands in `scripts/`. No test
// imports it — there is nothing here to test that is not the driver's own job.

import { neon } from "@neondatabase/serverless";
import { createPgStore, type SqlQuery } from "./pgStore.js";
import { requireDatabaseUrl } from "./env.js";
import type { LinkStore } from "./store.js";

/** THE CAST, and it is the only one in this directory.
 *
 *  `neon()` returns a `NeonQueryFunction` — a callable with several overloads, of which the tagged
 *  template is one. `SqlQuery` is that one overload and nothing else, which is deliberate: the other
 *  forms take a query STRING, and a query string is the shape in which a value can become syntax.
 *  Narrowing here means `pgStore.ts` has no way to call them. */
export function neonSql(env: Record<string, string | undefined>): SqlQuery {
  return neon(requireDatabaseUrl(env)) as unknown as SqlQuery;
}

export function neonStore(env: Record<string, string | undefined>): LinkStore {
  return createPgStore(neonSql(env));
}
