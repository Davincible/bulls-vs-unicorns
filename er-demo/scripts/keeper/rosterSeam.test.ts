// THE ROSTER SEAM — the keeper's writer against the identity API's reader, run through each other.
//
// WHY THIS FILE EXISTS AT ALL, given that both halves already have thorough tests of their own. They
// have tests of their own *against their own fixtures*, and that is precisely the gap. `statusServer`'s
// tests assert it emits `{"wallets":[…]}`; `houseWallets`' tests assert it parses `{"wallets":[…]}`.
// Both pass forever if the two literals ever stop being the same literal, because neither one has any
// way to notice — they are separate packages, separate tsconfig projects, separate deploy targets, and
// nothing in either build has an opinion about the other. A shape agreed by two fixtures is not a
// contract; it is two beliefs that currently coincide.
//
// This is the same argument `src/v2/data/keeperStatus.ts` makes for being ONE module imported by both
// ends, and the reason it has to be a test here rather than a shared module there: the two ends of
// THIS contract are a Bun process on Fly and a Node function on Vercel, which share no filesystem, no
// bundle and no deploy. They cannot import one shape. So the shape is pinned by running one through
// the other instead — which is the strongest available substitute and, unlike a shared type, also
// checks the bytes, the status code, the header name and the URL.
//
// THE FAILURE IT GUARDS IS A TOTAL, SILENT FEATURE OUTAGE. If the two disagree, `houseWalletsFrom`
// returns null, the API fails closed exactly as designed, and it serves NO avatars to ANYBODY — which
// looks identical to "nobody has linked an account", which is what the leaderboard looks like for most
// players anyway. No exception, no failed build, no error on any screen. The same class of failure the
// whole keeper-status contract module was written to prevent, one endpoint along.
//
// IT LIVES UNDER `scripts/keeper/` because that is the tsconfig project that can see both sides:
// `tsconfig.scripts.json` compiles this directory and pulls `api/src/` in transitively as an imported
// dependency, so `npm run typecheck` covers it. The reverse does not hold — `tsconfig.api.json` does
// not include `scripts/` — so this is the only end it can be written from.

import { describe, expect, it } from "vitest";
import {
  HOUSE_PATH, HOUSE_TOKEN_ENV, HOUSE_TOKEN_MIN_LENGTH, handleKeeperRequest, resolveAllowedOrigins,
} from "./statusServer.ts";
import { HouseListCache, houseWalletsFrom } from "../../api/src/houseWallets.ts";
import {
  DEFAULT_KEEPER_HOUSE_URL, HOUSE_TOKEN_ENV as API_HOUSE_TOKEN_ENV, keeperHouseUrl,
} from "../../api/src/env.ts";

const TOKEN = "t".repeat(HOUSE_TOKEN_MIN_LENGTH);

const WALLETS = [
  "H0use11111111111111111111111111111111111111",
  "H0use22222222222222222222222222222222222222",
];

/** The keeper's real handler, wired to a fixture bank. Everything except the bank is the production
 *  path: the same routing, the same credential comparison, the same headers. */
function keeper(houseToken: string | null = TOKEN) {
  return (request: Request): Response => handleKeeperRequest(request, {
    body: () => "",
    heartbeatAgeSeconds: () => 0,
    reclamation: () => "",
    policy: resolveAllowedOrigins(undefined),
    houseToken,
    houseWallets: () => WALLETS,
  });
}

describe("the bytes the keeper serves are the bytes the identity API can read", () => {
  it("round-trips the roster through both halves", async () => {
    const res = keeper()(new Request(`http://keeper.internal${HOUSE_PATH}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    expect(res.status).toBe(200);

    // Through the API's OWN parser, on the response's OWN bytes — not on an object either side built.
    // That is the whole point: `JSON.parse(await res.text())` is exactly what the API does to exactly
    // what the keeper sends, with no fixture standing between them.
    const parsed = houseWalletsFrom(JSON.parse(await res.text()));
    expect(parsed).not.toBeNull();
    expect([...parsed!].sort()).toEqual([...WALLETS].sort());
  });

  it("agrees on the path, so the default URL is not pointing at a 404", () => {
    // A one-character difference here — `/house-wallets.json` against `/house_wallets.json` — is a
    // permanent 404 that presents as "the keeper is unreachable", which the API handles gracefully and
    // therefore never complains about. The constant and the route are declared in different packages,
    // so nothing else compares them.
    expect(new URL(keeperHouseUrl({})).pathname).toBe(HOUSE_PATH);
    expect(DEFAULT_KEEPER_HOUSE_URL).toContain(HOUSE_PATH);
  });

  it("agrees on the NAME of the variable the operator has to set on both ends", () => {
    // Declared twice — once per package, because they deploy to different platforms and cannot share
    // a module. Two constants holding the same string is a duplication that nothing else compares, and
    // the day one is renamed the other keeps compiling: the keeper would read `KEEPER_HOUSE_TOKEN` and
    // the API would read something else, both would report themselves unconfigured, and the operator
    // would be looking at two correct-looking dashboards. It is one line to pin.
    expect(HOUSE_TOKEN_ENV).toBe(API_HOUSE_TOKEN_ENV);
  });

  it("sends a credential the keeper accepts, all the way through the cache", async () => {
    // The header NAME and the `Bearer ` prefix are written on one side and parsed on the other, and a
    // mismatch in either is a 401 that the API turns into "fail closed" — no avatars, no error. This
    // drives the real `HouseListCache`, so the assertion covers how it actually builds the request
    // rather than how this test imagines it does.
    const fetch = (async (_url: string, init?: RequestInit) => keeper()(
      new Request(`http://keeper.internal${HOUSE_PATH}`, { headers: init?.headers as HeadersInit }),
    )) as unknown as typeof globalThis.fetch;

    const list = await new HouseListCache({
      url: `http://keeper.internal${HOUSE_PATH}`, token: TOKEN, fetch, nowSec: () => 0,
    }).get();

    expect(list.unknown).toBe(false);
    expect([...list.wallets].sort()).toEqual([...WALLETS].sort());
  });

  it("fails CLOSED rather than open when the two ends disagree about the token", async () => {
    // The direction of the failure is the property, not the failure itself. A cold cache that cannot
    // read the roster must report `unknown` — which makes the caller withhold every link — and must
    // never report an EMPTY roster, which would read as "no wallet is the house's" and let every bot
    // wear a face. The two are one boolean apart and only one of them is safe.
    const fetch = (async (_url: string, init?: RequestInit) => keeper()(
      new Request(`http://keeper.internal${HOUSE_PATH}`, { headers: init?.headers as HeadersInit }),
    )) as unknown as typeof globalThis.fetch;

    const list = await new HouseListCache({
      url: `http://keeper.internal${HOUSE_PATH}`, token: "the-wrong-token-entirely-but-long-enough", fetch, nowSec: () => 0,
    }).get();

    expect(list.unknown).toBe(true);
    expect(list.wallets.size).toBe(0);
  });

  it("fails CLOSED against a keeper that has no roster route at all", async () => {
    // The not-yet-redeployed keeper, and the one running without the secret. It answers 404, which is
    // deliberately indistinguishable from any unknown path — so the API must treat it exactly as it
    // treats an unreachable keeper, rather than as an empty list.
    const fetch = (async () => keeper(null)(
      new Request(`http://keeper.internal${HOUSE_PATH}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
    )) as unknown as typeof globalThis.fetch;

    const list = await new HouseListCache({
      url: `http://keeper.internal${HOUSE_PATH}`, token: TOKEN, fetch, nowSec: () => 0,
    }).get();

    expect(list.unknown).toBe(true);
  });
});
