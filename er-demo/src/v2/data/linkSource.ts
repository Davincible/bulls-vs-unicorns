// WHERE LINKS COME FROM, and — the part that actually matters — WHICH KEYS EACH SOURCE TRUSTS.
//
// `xLink.ts#verifyAttestation` takes its trusted key set as an argument rather than reading one from
// module scope, and this file is the reason. There are two key sets in this program and they must
// never mix:
//
//   * the MOCK key, which is derived from a seed phrase printed in this repo, so anybody at all can
//     sign an attestation with it;
//   * the PRODUCTION key(s), which are generated offline and live in a Vercel env var.
//
// If those two sets were ever unioned — by a default parameter, by a fallback, by an `??` written in
// a hurry — then the seed phrase four paragraphs below would become a way to put any handle on any
// wallet on the live site. So they are returned by one exhaustive `switch` over a three-member union,
// with no default branch and no shared list, and `linkSource.test.ts` asserts the disjointness
// directly rather than trusting that reading.
//
// Read once at module load, exactly like `flags.ts` and for the same mechanical reason: the source
// decides which hook does what, and a flag that could change mid-session would mean a component
// whose hook list changes. It is a deep-link, not a setting. Changing it is a reload.

/**
 * `?links=`.
 *
 *   `off`   — the default, and the correct one until Stage 2 is deployed. No fetch, no provider
 *             work, no keys trusted. Every player renders exactly as they do today.
 *   `mock`  — `TWITTER-CONNECT.md` §10 Stage 0. A committed fixture, signed in the browser with the
 *             mock key, verified through the real code path. No backend, no secrets, no spend.
 *   `api`   — the real thing: `GET /api/links`, verified against the production key set.
 *
 * OFF IS THE DEFAULT AND THAT IS DELIBERATE. The unlinked path is the main path (§8) — it is what
 * the overwhelming majority of players see and it is already good. A feature that is invisible until
 * asked for cannot regress anybody, which is the property worth having while the backend behind it
 * does not exist yet.
 */
export type LinkSource = "off" | "mock" | "api";

export function parseLinksFlag(search: string): LinkSource {
  const raw = new URLSearchParams(search).get("links")?.toLowerCase();
  if (raw === "mock") return "mock";
  if (raw === "api") return "api";
  // Anything else — absent, empty, a typo, `?links=1` — is off. Same rule as `parseSignerFlag`: a
  // mistyped flag must never silently select a code path with different trust in it.
  return "off";
}

/**
 * THE MOCK SIGNING KEY'S SEED PHRASE, IN PUBLIC, ON PURPOSE.
 *
 * A committed secret is normally a defect. This one is a design decision, and the reasoning is:
 *
 *   1. The fixture has to carry REAL signatures, or `?links=mock` would exercise a bypass instead of
 *      the verification path, and the first commit would ship an unverified route to a face — which
 *      is the exact defect this whole feature exists to delete (see `xLink.ts`'s header).
 *   2. A committed signature would EXPIRE. Attestations live seven days; a fixture signed in August
 *      renders as unlinked in September, silently, and the next person spends an afternoon on it. So
 *      the fixture is signed at load, which means the signer must be derivable at load.
 *   3. Publishing it costs nothing, because the mock key is only ever in the trusted set for a
 *      browser that asked for `?links=mock`. Forging a mock attestation gets an attacker a fake face
 *      in their own browser, which they could equally get by editing the JSON. There is no third
 *      party to convince.
 *
 * `sha256(utf8(MOCK_ATTESTATION_SEED))` is the 32-byte ed25519 secret. `scripts/make-mock-links.mjs`
 * derives it the same way, which is what keeps the committed fixture regenerable by anyone.
 */
export const MOCK_ATTESTATION_SEED = "bulls-vs-unicorns.mock-attestation-key.v1";

/** The public half of the above, base58. Committed as a literal rather than derived at module load
 *  so that `linkSource.ts` — which every mode imports — pulls in no hash and no curve. A test pins
 *  it against the seed, so the two cannot drift. */
export const MOCK_ATTESTATION_PUBLIC_KEY = "3DHEABNCEKUv2w7ji2tKgZKaH76rs7grBvAcdjK2yn7R";

/**
 * The production trust anchors: base58 ed25519 public keys, comma-separated, inlined by Vite at
 * BUILD time.
 *
 * A SET FROM DAY ONE, because key rotation with a single key is a flag day. With one key there is no
 * instant at which both the retiring and the arriving signature verify, so every cached bundle in
 * every open tab breaks at once and the only remedy is a deploy that has already happened. With two,
 * rotation is: publish the new key alongside the old, switch the signer, drop the old key next
 * deploy. Three ordinary releases instead of an incident.
 *
 * UNSET MEANS UNSET — see `trustedKeysFor`. There is no default value here and there must not be.
 */
const PRODUCTION_KEYS_RAW: string = import.meta.env?.VITE_LINK_ATTESTATION_KEYS || "";

/** Split, trimmed, empties dropped. Exported for the test; there is nothing clever in it and that is
 *  the point — an env var that arrives with a trailing comma must not produce an empty-string "key"
 *  that some future `includes` check matches against. */
export function parseTrustedKeys(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * WHICH KEYS THIS SOURCE WILL BELIEVE. The one function that answers it, and the whole safety
 * argument of this file.
 *
 * Note what `api` does when the env var is missing: it returns NOTHING, and every attestation is
 * then rejected as `untrusted-key`, and every player renders unlinked. That is the correct failure.
 * The tempting alternative — falling back to the mock key so "it works in development" — would mean
 * a production build with a misconfigured env var trusting a key whose secret is printed above.
 * There is no fallback. There is deliberately not even a place to put one.
 */
export function trustedKeysFor(source: LinkSource): readonly string[] {
  switch (source) {
    case "mock":
      return [MOCK_ATTESTATION_PUBLIC_KEY];
    case "api":
      // THE MOCK KEY IS FILTERED OUT OF PRODUCTION, UNCONDITIONALLY, and this line is not paranoia
      // about the code above it — it is about the one path no test can reach. The seed phrase is
      // published in this file, so anybody can sign with the mock key; the only thing standing
      // between that and the live site is that nobody ever pastes its public half into
      // `VITE_LINK_ATTESTATION_KEYS`. That value lives in a hosting dashboard, and the plausible way
      // it gets there is somebody making staging work in a hurry. A test cannot see a dashboard.
      // One `.filter` makes the published seed structurally incapable of being a production anchor
      // no matter what anyone types.
      return parseTrustedKeys(PRODUCTION_KEYS_RAW).filter((k) => k !== MOCK_ATTESTATION_PUBLIC_KEY);
    case "off":
      return [];
    default: {
      // EXHAUSTIVENESS, ENFORCED BY THE COMPILER RATHER THAN BY THIS FILE'S HEADER CLAIMING IT.
      // Without this branch, adding a fourth `LinkSource` and forgetting a case is not an error under
      // this project's settings (`strictNullChecks: false`, no `noImplicitReturns`) — the function
      // just returns `undefined`, which is assignable to `readonly string[]`, and the first thing to
      // touch it throws inside a poll. `never` is the one assignment that cannot be made silently.
      const unreachable: never = source;
      void unreachable;
      return [];
    }
  }
}

/** Where the records are fetched from. The mock is a static file in `public/`, so it is served by
 *  Vite dev, `vite preview` and a production build alike with no configuration and no server — which
 *  is what makes Stage 0 genuinely backend-free. */
export function linksUrlFor(source: LinkSource, wallets: readonly string[]): string | null {
  switch (source) {
    case "mock":
      return "/links.mock.json";
    case "api":
      // The wallet list is the whole query — there is no enumeration route (`TWITTER-CONNECT.md`
      // §6.4). Encoded rather than joined raw so a malformed wallet cannot inject a second parameter.
      return wallets.length === 0 ? null : `/api/links?wallets=${encodeURIComponent(wallets.join(","))}`;
    case "off":
      return null;
  }
}

// Read through a guard rather than off `window`, so this module is importable under Node and every
// function above stays a pure, testable function of its input — same arrangement as `flags.ts`.
const SEARCH = typeof window === "undefined" ? "" : window.location.search;

/** Fixed for the page's lifetime. See this file's header. */
export const LINK_SOURCE: LinkSource = parseLinksFlag(SEARCH);
