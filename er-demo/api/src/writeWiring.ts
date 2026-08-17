// ASSEMBLING THE WRITE PATH'S DEPENDENCIES. The part `/api/x/challenge.ts` and `/api/x/link.ts` would
// otherwise each carry a copy of.
//
// `api/links.ts`'s header makes the case for keeping entry points to wiring only, and this file is the
// consequence of there being TWO of them for one feature. Twenty lines of identical construction in two
// entry points is not a duplication problem so much as an ORDERING problem: both must build the
// verifier, the caches and the stores in a way that shares one JWKS cache per worker and one house cache
// per worker, and two copies of that would drift the day one of them gained a parameter.
//
// It deliberately does NOT name Neon. `sql` arrives as the narrow tagged-template `SqlQuery` that
// `pgStore.ts` defines, so `neonStore.ts` remains the one file in the feature with an opinion about
// which Postgres this is.

import type { ChallengeDeps } from "./challengeHandler.js";
import type { WriteConfig } from "./writeEnv.js";
import { HouseListCache } from "./houseWallets.js";
import type { LinkWriteDeps } from "./linkWriteHandler.js";
import type { SqlQuery } from "./pgStore.js";
import { createPgWriteStore } from "./pgWriteStore.js";
import { createPrivyVerifier, PrivyJwksCache } from "./privyIdentity.js";

export interface WriteDeps {
  readonly challenge: ChallengeDeps;
  readonly link: LinkWriteDeps;
}

export interface WiringDeps {
  readonly config: WriteConfig;
  readonly sql: SqlQuery;
  readonly fetch: typeof globalThis.fetch;
  readonly nowSec: () => number;
}

/**
 * One set of dependencies for both legs, sharing the caches.
 *
 * CALLED ONCE PER WORKER, AT MODULE SCOPE, in each entry point — which is what makes the two caches
 * worth having at all. `PrivyJwksCache` holds Privy's public keys for an hour and `HouseListCache` holds
 * the keeper's wallet list for a minute; both are useless if they are rebuilt per request, and both are
 * a self-inflicted load test on somebody else's service if they are rebuilt per request under load.
 *
 * The two entry points are separate Vercel Functions and therefore separate processes, so each gets its
 * own pair. That is fine and unavoidable: the caches exist to collapse a burst within one worker, not to
 * be a shared cache.
 */
export function createWriteDeps(deps: WiringDeps): WriteDeps {
  const { config } = deps;

  const store = createPgWriteStore(deps.sql);

  const jwks = new PrivyJwksCache({
    url: config.privyJwksUrl,
    fetch: deps.fetch,
    nowSec: deps.nowSec,
  });

  const house = new HouseListCache({
    url: config.houseUrl,
    token: config.houseToken,
    fetch: deps.fetch,
    nowSec: deps.nowSec,
  });

  const rate = { counter: store.rate, secret: config.bucketSecret };

  return {
    challenge: {
      challenges: store.challenges,
      rate,
      privy: createPrivyVerifier({ appId: config.privyAppId, jwks }),
      nowSec: deps.nowSec,
      // THE GLOBAL `crypto`, for the reason `privyIdentity.ts` records at length: the named
      // `webcrypto` export of `node:crypto` is a lazy getter that vite's builtin interop does not carry
      // across, so it is `undefined` under vitest while type-checking perfectly. The global is the same
      // object and the same spelling every runtime uses.
      //
      // CALLED THROUGH AN ARROW, not passed as `crypto.getRandomValues`, because it is a METHOD and an
      // unbound reference to it throws `Illegal invocation` — the same trap `identity.ts` records for
      // `wallet.signMessage`.
      randomBytes: (out: Uint8Array) => {
        globalThis.crypto.getRandomValues(out);
      },
    },
    link: {
      challenges: store.challenges,
      links: store.links,
      rate,
      house,
      nowSec: deps.nowSec,
    },
  };
}

/** The wall-clock, in the unit the whole feature uses. One definition, so the two entry points cannot
 *  disagree about whether a timestamp is seconds or milliseconds. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
