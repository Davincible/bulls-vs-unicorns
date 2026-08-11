// THE ARENA'S OWN WALLETS, FOR THE OPERATOR SCRIPTS THAT HAVE TO COUNT THEM.
//
// WHY A SCRIPT IN THIS DIRECTORY SUDDENLY NEEDS A CREDENTIAL. It did not used to. The keeper
// published `house.wallets` inside `/keeper-status.json`, every browser on the internet held the
// list, and any script that wanted it wrote a bare `fetch` and got an array. That is over by an
// owner's decision: the arena's wallets are not deleted and not denied, they are INTERNAL. We have
// them; we do not talk about them. `KEEPER_STATUS_SCHEMA` 5 is the schema that stopped saying so —
// no `house.wallets`, no `houseFighterCount`, no `realFighterCount`, and no house concept in the
// browser at all.
//
// The list still exists, because the keeper still needs it: `houseBank.classify` decides how many of
// its own fighters a lobby may hold, and the treasury rule that keeps a house-only room below the
// program's `enough_to_fight` is computed from it. What changed is who may read it. It now lives
// behind `GET /house-wallets.json` on the keeper host, requiring `Authorization: Bearer
// $KEEPER_HOUSE_TOKEN`, answering `{"wallets":[...]}`.
//
// ONE MECHANISM, TWO CONSUMERS — and that is the entire argument for this file. The Vercel identity
// API reads that endpoint, with that token, so that a person's face can never land on one of these
// wallets (`api/src/houseWallets.ts` carries the long version of why it fails closed). These scripts
// read the same endpoint, with the same token, so that an operator can tell a real player from the
// arena's own. Two consumers of one private channel.
//
// WHAT WAS REJECTED, because the alternatives all look cheaper at the moment you reach for them:
//
//   - A roster file committed beside these scripts, or passed as `--house-wallets`. A second copy of
//     a list that grows whenever the bank is extended (`extendHouseBank.ts` has already taken it from
//     six wallets to forty-eight). The copy nobody exercises daily is the copy that goes stale, and
//     staleness here is silent and pointed in the worst direction: a wallet added last week, missing
//     from the operator's file, is counted as A REAL PLAYER by the script whose only job is counting
//     real players.
//   - Reading `.devnet/keeper-house-wallets.json` off the laptop. That is the SECRET KEY file, and
//     it is the wrong shape besides — it holds the keys, not the derived pubkeys, and in production
//     the keys arrive as a fly secret and were never on that disk at all.
//   - Teaching the keeper to publish the list to a second, quieter place. Two private paths to keep
//     in sync is the same drift as the committed file, with an extra deploy target.
//
// IT NEVER THROWS, AND THAT IS DELIBERATE. The two callers want different things from the same
// failure: `dump-round.mjs` degrades to printing the pubkeys it found and saying plainly that it
// could not split them, while `admin-set-fee.mjs` ESCALATES — it warns on any occupied lobby rather
// than going quiet, because a slightly over-eager warning is safe and silence is not. A helper that
// threw would flatten both of those into the same outcome, which is the script dying at the exact
// moment an operator needed it to say something.

const DEFAULT_HOUSE_URL = "https://bulls-arena-keeper-devnet.fly.dev/house-wallets.json";

/** Overridable so this points at a locally-run keeper without editing a script. Deliberately the
 *  same variable name the Vercel identity API reads (`api/src/env.ts`), because one fact should have
 *  one name across the two things that consume it. */
export const HOUSE_URL_ENV = "KEEPER_HOUSE_URL";

/** Same name again, and it must hold the same VALUE as the keeper's fly secret and the identity
 *  API's Vercel variable. A token that differs by a trailing newline is a 401, which this module
 *  reports as a 401 rather than as "the keeper is down" — see `fetchHouseWallets`. */
export const HOUSE_TOKEN_ENV = "KEEPER_HOUSE_TOKEN";

/** The one line to put in front of an operator who is missing the credential. Exported rather than
 *  inlined at each call site so the two scripts cannot drift into telling somebody two different
 *  things about the same environment variable. Fly cannot read a secret back out, on purpose, so
 *  there is no `fly secrets get` to suggest: the value is wherever it was generated, and the Vercel
 *  project holds the other copy under this same name. */
export const HOUSE_TOKEN_FIX =
  `export ${HOUSE_TOKEN_ENV}=<the same value as the keeper's fly secret of that name>`;

/** Five seconds, not the identity API's two. That module answers inside a browser request and a slow
 *  keeper there costs a visitor their avatars; this runs at a terminal with a person waiting, where
 *  the expensive outcome is giving up on a keeper that would have answered. */
const TIMEOUT_MS = 5_000;

/** @returns {string} the roster endpoint this process will ask. */
export function houseListUrl(env = process.env) {
  const raw = env[HOUSE_URL_ENV];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_HOUSE_URL;
}

function unavailable(url, reason, message, fix) {
  return { available: false, wallets: null, count: 0, url, reason, message, fix };
}

/**
 * Every entry, or none of it.
 *
 * One malformed member invalidates the whole list rather than being skipped, which is the same rule
 * `api/src/houseWallets.ts` applies and for the same reason: a partially-parsed roster is a roster
 * with a hole in it, and the hole is invisible. Downstream that hole is not a missing row — it is a
 * house fighter promoted to "real player" in a count somebody is about to make a decision from.
 *
 * @returns {Set<string>|null} null when the body is not a roster this code understands.
 */
function walletsFrom(body) {
  if (typeof body !== "object" || body === null) return null;
  const wallets = body.wallets;
  if (!Array.isArray(wallets)) return null;
  const out = new Set();
  for (const w of wallets) {
    if (typeof w !== "string" || w === "") return null;
    out.add(w);
  }
  return out;
}

/**
 * The arena's own wallets, or a clearly-marked reason there are none to be had.
 *
 * @param {Record<string, string|undefined>} [env] normally `process.env`. Injected so a caller can
 *   exercise the unavailable paths without mutating the process it is running in.
 * @returns {Promise<
 *   { available: true, wallets: Set<string>, count: number, url: string } |
 *   { available: false, wallets: null, count: 0, url: string, reason: string, message: string, fix: string }
 * >} `available` is the discriminant, and it is a positive word on purpose: `!result.error` would
 *   let a caller fall through to `result.wallets` and get `null`, which is exactly the shape that
 *   turns into `new Set(undefined)` and a crash. There is no wallet set to read unless it is `true`.
 */
export async function fetchHouseWallets(env = process.env) {
  const url = houseListUrl(env);
  const token = (env[HOUSE_TOKEN_ENV] ?? "").trim();

  if (token === "") {
    return unavailable(
      url,
      "no-token",
      `${HOUSE_TOKEN_ENV} is not set, and the roster is no longer public — there is nothing to read without it.`,
      HOUSE_TOKEN_FIX,
    );
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // `redirect: "error"` rather than the default `follow`, and it is not paranoia about a keeper we
    // run ourselves: a redirect is the one way this request lands somewhere the code above did not
    // name, and it would arrive there carrying a bearer token in a header. Refusing to follow costs
    // nothing — this endpoint has never redirected and has no reason to — and it removes the whole
    // class. The identity API made the same call for the same reason.
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: ctl.signal,
    });

    // 401 AND 404 ARE DIFFERENT PEOPLE'S PROBLEMS, so they are never collapsed into "the keeper did
    // not answer". A 401 is YOUR credential: the keeper is healthy, it read the header, it disagreed.
    // A 404 is the KEEPER's: the route only exists when the keeper itself has `KEEPER_HOUSE_TOKEN`
    // set, and an unconfigured keeper answers as if the path were unknown rather than as if it were
    // guarded — an endpoint that returns 401 has already told an anonymous caller that there is a
    // list here. So a 404 means nobody set the token on the machine, and re-pasting yours will not
    // help.
    if (res.status === 401 || res.status === 403) {
      return unavailable(
        url,
        "unauthorized",
        `the keeper answered ${res.status} — it is up and it rejected this credential, so ${HOUSE_TOKEN_ENV} is wrong (a stray newline from a copy-paste is the usual cause).`,
        HOUSE_TOKEN_FIX,
      );
    }
    if (res.status === 404) {
      return unavailable(
        url,
        "no-route",
        `the keeper answered 404 — this route exists only when the KEEPER has ${HOUSE_TOKEN_ENV} set, so the machine is unconfigured rather than your token being wrong.`,
        `fly secrets set ${HOUSE_TOKEN_ENV}="…" --app bulls-arena-keeper-devnet   (32 characters minimum, enforced at the keeper's boot)`,
      );
    }
    if (!res.ok) {
      return unavailable(
        url,
        "http-error",
        `the keeper answered ${res.status} ${res.statusText || ""}`.trim(),
        `check the keeper is healthy: curl -sS ${new URL("/health", url).toString()}`,
      );
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      return unavailable(url, "malformed", `the keeper answered 200 with a body that is not JSON (${e.message})`,
        "check that KEEPER_HOUSE_URL points at the keeper and not at a proxy or a login page.");
    }

    const wallets = walletsFrom(body);
    if (wallets === null) {
      return unavailable(url, "malformed",
        `the keeper answered 200 with JSON that is not {"wallets": [ … ]} — refusing to use a partial roster.`,
        "check that KEEPER_HOUSE_URL points at the keeper's /house-wallets.json.");
    }
    return { available: true, wallets, count: wallets.size, url };
  } catch (e) {
    // Timeout, DNS, TLS, a refused redirect: one outcome, because there is nothing a caller could do
    // differently for any of them and the message carries the distinction for the human reading it.
    const why = e.name === "AbortError" ? `no answer within ${TIMEOUT_MS / 1000}s` : e.message;
    return unavailable(url, "unreachable", `could not reach ${url} (${why})`,
      `check the keeper is up: curl -sS ${new URL("/health", url).toString()}`);
  } finally {
    clearTimeout(timer);
  }
}
