# `api/` — the wallet ↔ X register, server half

Stages 2 and 3 of `TWITTER-CONNECT.md`. **No X developer app, no OAuth of our own, no secrets in the
repo.**

Four public routes and four operator commands. Everything here is written so that the expensive
mistakes — a suppressed picture that keeps being served, an automated wallet wearing a person's face,
a signature no browser accepts, a nonce that can be replayed — are caught by `npx vitest run` rather
than by production.

| Route | Method | What it is |
|---|---|---|
| `/api/links?wallets=…` | `GET` | The read path. Signed attestations, one per linked wallet. **Stage 2.** |
| `/api/avatar/<x_id>/<hash>.webp` | `GET` | The avatar proxy. Reads a row; never fetches. **Stage 2.** |
| `/api/x/challenge` | `POST` | Verify a Privy identity token, mint a single-use wallet challenge. **Stage 3.** |
| `/api/x/link` | `POST` / `DELETE` | Redeem the challenge: create or remove the link. **Stage 3.** |

The two Stage 3 routes are **behind `XLINK_WRITE_ENABLED=on` and off by default** — see
[The link ceremony](#the-link-ceremony--stage-3) below.

---

## Where the code lives, and why it is split in two

| Path | What it is |
|---|---|
| `/api/links.ts`, `/api/avatar/[xId]/[hash].ts`, `/api/x/challenge.ts`, `/api/x/link.ts` | **Vercel entry points.** Repo root. Wiring only — env, driver, hand off. |
| `er-demo/api/src/**` | **The implementation and its tests.** Reachable by `npm test` and `npm run typecheck`. |
| `er-demo/api/migrations/` | The checked-in SQL. Nothing runs it automatically. |
| `/scripts/xlink-*.ts` | The operator commands. Repo root, `.vercelignore`d, never deployed. |
| `/package.json` | Dependencies and Node pin **for the functions only**. Not the front end. |

The split is forced, not stylistic:

* **Vercel only turns files under `/api` at the project root into Functions.** The `functions` key in
  `vercel.json` *configures* functions that were already detected — it cannot create one from a file
  elsewhere, and a glob matching nothing fails the build with `unused_function`. So the entry points
  have to be at the repo root.
* **This project's Root Directory has to stay the repo root.** That is where the `vercel.json` Vercel
  reads lives, and `.vercelignore` records a second reason: `er-demo`'s own type-check reaches out to
  `engine/src` (`src/sim/mirrorParity.test.ts` imports the engine's simulation to prove the browser's
  replay still matches it). A narrower Root Directory puts that out of scope and breaks the build.
* **But `npm test` and `npm run typecheck` both run from `er-demo/`.** Vitest's default `include`
  sweeps everything under that directory, so implementation and tests placed there are picked up with
  no configuration at all. A directory of untested serverless code is exactly what this arrangement
  exists to prevent.

Third-party dependencies resolve **upward** from either location into the repo-root `node_modules`
that `/package.json` declares, which is the piece that lets both halves work at once.

### Relative imports in this graph end in `.js`, and everywhere else they end in `.ts`

The repo's house style is `.ts` extensions in relative imports, enabled by `allowImportingTsExtensions`
in `tsconfig.api.json` and `tsconfig.app.json`. **The files Vercel deploys are the exception.** Both
routes returned `500 FUNCTION_INVOCATION_FAILED` on every request until they stopped doing it:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/er-demo/api/src/linksHandler.ts'
imported from /var/task/api/links.js
```

Vercel does not bundle these functions. It transpiles each `.ts` it reaches into a `.js` beside it —
the dependencies really are deployed — but it does not rewrite the specifiers that name them, so a
`.ts` import is a path with no file at it. `moduleResolution: "bundler"` resolves `./x.js` back to
`./x.ts` at type-check time, so this costs nothing and `npm run typecheck` still covers both trees.
`api/links.ts`'s header carries the full argument and the alternatives that were rejected.

The graph is **twenty files**, and it is exactly the set reachable from the four entry points:

| | |
|---|---|
| entry points | `/api/links.ts` `/api/avatar/[xId]/[hash].ts` `/api/x/challenge.ts` `/api/x/link.ts` |
| read path | `linksHandler` `avatarHandler` `attest` `env` `neonStore` `pgStore` `wallets` `houseWallets` `reserved` `store` |
| write path | `challengeHandler` `linkWriteHandler` `challenge` `writeHttp` `writeWiring` `writeEnv` `writeStore` `pgWriteStore` `privyIdentity` `rateLimit` `clientNetwork` |
| `er-demo/src/v2/data/` | `xLink` `xLinkSign` — server-reachable by design, see `xLinkSign`'s header |

`memoryStore.ts`, `memoryWriteStore.ts` and `avatarIngest.ts` are **not** deployed — tests and
operator commands reach them, Vercel never does — which is why they still read `.ts`.

**The two halves do not mix, and that is checked rather than asserted.** No read function carries a
write module. It was briefly untrue: `writeConfig` started life in `env.ts`, which every route imports,
so `privyIdentity.js` and `rateLimit.js` were traced into `api/links.func` and
`api/avatar/[xId]/[hash].func` — two modules that parse tokens and derive secrets, shipped into two
routes that only ever read a row. Nothing broke and no test failed; `npx vercel build` showed it. The
write path's own configuration now lives in `writeEnv.ts`, which nothing but `/api/x/*` imports.
To re-check:

```bash
npx vercel build
find .vercel/output/functions/api/links.func -name 'privyIdentity.js' -o -name 'rateLimit.js'   # must be empty
```

**To check whether the set has grown**, do not read this table: run `npx vercel build` and look at
what landed in `.vercel/output/functions/api/links.func/`. That directory is the deployed bundle, and
comparing a specifier against the file beside it is the check that caught this in the first place.

#### The convention has three edges, and all three are silent

Vercel's tracer resolves `./foo.js` to `foo.ts` through a **fallback**, not through normal resolution:
it tries the literal path, and only on failure retries with `.ts` substituted. That has consequences.

* **The fallback is `.js` → `.ts` only.** A `.jsx`, `.mjs` or `.cjs` specifier pointing at a `.tsx`,
  `.mts` or `.cts` source is **not traced at all** — the dependency never ships. Today the graph is
  ten plain `.ts` files, so this cannot bite; the day someone puts a `.tsx` or a `.mts` in it, the
  rule stops working and says nothing. Keep the deployed graph plain `.ts`.
* **A literal `.ts` specifier still traces.** It is found, transpiled and shipped — under its new
  `.js` name — so the bundle looks complete and the import inside it names a file that is not there.
  That is why the original failure was a hard 500 rather than a missing file at build time.
* **A stale real `foo.js` beside `foo.ts` wins silently**, because the fallback only fires when the
  literal path is *missing*. Never commit build output next to these sources.

#### `/api/tsconfig.json` is the gate that makes all of this fail loudly

`@vercel/node` runs its own `tsc` over the functions, finding its config by walking up from the entry
point for a file named exactly `tsconfig.json` — so `er-demo/tsconfig.api.json` was **never** in
scope, and Vercel type-checked with its own defaults. Worse, it reports errors with `console.error`
and builds anyway: the original bug printed **eighteen `TS5097`** lines into a deploy that reported
success. `/api/tsconfig.json` now sets `noEmitOnError: true`, so a future `.ts` specifier fails the
build instead. Its header carries the rest, including why `allowImportingTsExtensions` cannot go there
and why `/package.json` now pins `@types/node` beside `typescript`.

### `functions` in `vercel.json` is a tripwire, not decoration

```json
"functions": { "api/**/*.ts": { "maxDuration": 10 } }
```

`TWITTER-CONNECT.md` §11 lists "Vercel picks up `/api` at repo root" as standard behaviour but **not
verified against this project**. This block converts that assumption into a build failure: if the two
files ever stop being detected as functions, the glob matches nothing and the deploy fails loudly
instead of serving a 404 nobody notices.

### `installCommand` runs `npm ci` at the repo root first

```
npm ci --no-audit --no-fund && cd er-demo && bun install --frozen-lockfile
```

The functions need `@neondatabase/serverless` (and the shared modules need `@solana/web3.js` and
`@noble/curves`) resolvable at `/node_modules`. Vercel does run its own install for `/api` from the
nearest `package.json`, but relying on that is relying on exactly the kind of undocumented step this
directory is supposed to stop depending on. `npm ci` is deterministic, matches the posture of the
existing `bun install --frozen-lockfile`, and requires `/package-lock.json` to be committed.

**A failure here cannot break the live site.** It fails the *build*, and Vercel never promotes a
failed build — the existing deployment keeps serving. The same is true of the alternative: without
this line, a missing dependency fails the function build with `Cannot find module`. Both directions
have the same blast radius; this one is deterministic. To revert, delete `npm ci --no-audit
--no-fund && ` and rely on Vercel's own function-level install.

---

## Environment variables

The owner sets these in the Vercel project. **All of them; the feature is silent when one is wrong.**

| Name | Where | What |
|---|---|---|
| `XLINK_ATTESTATION_SECRET` | Server, all environments, mark Sensitive | 32-byte ed25519 secret, base64 or base58. Generated offline. **Never in the repo.** |
| `VITE_XLINK_TRUSTED_KEYS` | Client (build-time), all environments | Comma-separated base58 **public** keys the browser will believe. |
| `DATABASE_URL` | Server | Neon Postgres connection string. Neon's Vercel integration sets this for you. |
| `KEEPER_HOUSE_TOKEN` | Server, **required**, mark Sensitive | Bearer token for the keeper's roster endpoint. Must be **byte-identical** to the `KEEPER_HOUSE_TOKEN` fly secret on `bulls-arena-keeper-devnet`. Missing → the API **throws at cold start**, deliberately: see below. |
| `KEEPER_HOUSE_URL` | Server, optional | Defaults to `https://bulls-arena-keeper-devnet.fly.dev/house-wallets.json`. Deliberately **not** `VITE_`-prefixed — that prefix is what inlines a value into the public bundle, and this is one half of a private channel. |
| `XLINK_WRITE_ENABLED` | Server, **Stage 3 gate** | Must be exactly `on`. Anything else — absent, `1`, `true`, `ON` — is **off**, and off means `/api/x/*` answers `503 {"error":"disabled"}` and requires none of the variables below. Set it in **Preview only** until the ceremony has been exercised. |
| `PRIVY_APP_ID` | Server, required **when the gate is on** | The Privy app id (`cmsnbbun8007m0cjxbfx762sw`). **`VITE_PRIVY_APP_ID` is accepted instead** — the app id is a public client id that already ships in the bundle, so one value under two names beats two that can disagree. |
| `PRIVY_API_URL` | Server, optional | Defaults to `https://api.privy.io`. Only for pointing a test at something else. |

> **`PRIVY_APP_SECRET` is deliberately unused.** It is set in this project and the write path never
> reads it: the identity token is verified against Privy's **public** JWKS, so there is no Privy
> credential in the function and nothing there to leak. See `api/src/privyIdentity.ts`'s header for the
> three verification routes that were weighed and why this one won.

> **Preview environments are missing two of these today.** `vercel env ls` shows `KEEPER_HOUSE_TOKEN`
> and `VITE_PRIVY_APP_ID` set for **Production only**. Until they are added to Preview, `/api/links`
> 500s on any preview deployment (it needs the house token) and the ceremony cannot start there.

> **Changed.** `KEEPER_STATUS_URL` is **gone**. The API used to read the house wallet list out of the
> keeper's public `keeper-status.json`; that file no longer contains it, because the arena's own
> wallets are not published anywhere a browser can read. The list now comes from the keeper's
> authenticated `GET /house-wallets.json`, which is why there is a token above. A deploy that still
> sets `KEEPER_STATUS_URL` is not broken by it — nothing reads it — but it should be removed, and
> `KEEPER_HOUSE_TOKEN` **must** be added or the first request after deploy is a 500.

### Why a missing `KEEPER_HOUSE_TOKEN` is a 500 rather than a warning

Same argument as `XLINK_ATTESTATION_SECRET` below, arriving from the other direction. Without the
token the API cannot ask which wallets are the arena's own; it **fails closed**, so it withholds every
avatar — and "no avatars" is indistinguishable from "nobody has linked", which is what the leaderboard
looks like for most players anyway. There is no screen that shows the difference. So the difference has
to be a 500 at the origin, on the first request after the deploy, where somebody is looking.

### The invariant no error will warn you about

> The public half of `XLINK_ATTESTATION_SECRET` **must** be a member of `VITE_XLINK_TRUSTED_KEYS`.

If it is not, every attestation is rejected client-side as `untrusted-key`, `linkMapFrom` drops all
of them, and the leaderboard renders exactly as it does when nobody has linked — which is what it
renders for most players anyway. There is no screen that shows the difference and no error a player
generates. `xlink-keygen.ts` prints both halves together for this reason.

### Rotation is a deploy, not a flag day

The client takes a **set**. Add the new public key to `VITE_XLINK_TRUSTED_KEYS` alongside the old and
deploy; *then* switch `XLINK_ATTESTATION_SECRET` and deploy again; *then* drop the old public key on
a third deploy. No window exists in which a live attestation fails to verify. With a single key there
is no such ordering and every cached bundle in every open tab breaks at once.

---

## Setting it up

```bash
# 1. The signing key — offline, on a machine you trust. Writes nothing to disk.
bun run scripts/xlink-keygen.ts
#    Paste both printed variables into Vercel, then redeploy so the client half is rebuilt.

# 2. The schema. Not run by any deploy: a migration that runs itself on cold start is a migration
#    that runs a thousand times concurrently the first minute after a deploy.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f er-demo/api/migrations/0001_x_link.sql

# 3. Seed two rows by hand (§10, Stage 2) and fetch their pictures.
bun run scripts/xlink-seed.ts 1234567890 <wallet-base58> somehandle "Some One"
bun run scripts/xlink-ingest.ts --all
bun run scripts/xlink-seed.ts --list

# 4. Point the Stage-0 client at it:  ?links=api
```

## The kill switch — §7.4, non-negotiable before launch

```bash
bun run scripts/xlink-suppress.ts <x_id>          # show state, change nothing
bun run scripts/xlink-suppress.ts <x_id> on       # take the identity down
bun run scripts/xlink-suppress.ts <x_id> off      # put it back
```

`/api/links` stops emitting the row and the avatar proxy 404s, both immediately — the filter is in
the SQL `WHERE` clause, so there is no cache to clear and no handler that could forget. A browser may
hold its previous `/api/links` response for up to **30 seconds**; cached image bytes persist for up
to **24 hours** but nothing links to them any more.

It is a flag, not a delete. A delete is the *player's* revocation (§6.2) and must remain available to
them afterwards.

---

## The link ceremony — Stage 3

`TWITTER-CONNECT.md` §3.4 held Privy as the sanctioned contingency for Stage 3 — *"if X refuses or
delays a developer account, Privy is the Stage-3 substitute and nothing else in the plan changes"*.
**That contingency was taken.** Almost nothing else did change; what did is recorded at the bottom of
this section and in `src/v2/data/xLink.ts`'s Stage-3 block.

### The ceremony

```
1. AUTHORISE   browser <-> privy.io <-> x.com          (the Privy React SDK; no route of ours)
               -> an IDENTITY TOKEN: an ES256 JWT whose claims already carry the verified X account

2. CHALLENGE   POST /api/x/challenge
               { wallet, purpose: "link", proof: "<privy identity token>" }
               -> 200 { message, nonce, expiresAt }        five minutes, single use
               ► FACT A ESTABLISHED (the token's signature checked against Privy's JWKS)

3. SIGN        wallet.signMessage(utf8(message))            one prompt, no transaction

4. LINK        POST /api/x/link   { wallet, nonce, signature }
               -> 200 { linked: true }
               ► FACT B ESTABLISHED, BOUND TO A BY THE MESSAGE CONTENT

   UNLINK      POST /api/x/challenge { wallet, purpose: "unlink" }   ← no proof; none is wanted
               DELETE /api/x/link   { wallet, nonce, signature }
               -> 200 { unlinked: true | false }
```

Three things about that shape are load-bearing:

* **The message is composed by the server, stored verbatim, and never sent back.** `LinkRequest` has no
  `message` field, so §4.2's "compare the submitted message byte for byte" is stronger here than it was
  written: there is no submitted copy to compare.
* **The nonce is consumed before the signature is checked.** A wrong signature burns the challenge —
  §4.1's "one shot". The alternative is unlimited attempts against one nonce plus a read-check-write
  race.
* **`POST /api/x/link` returns nothing renderable.** No handle, no avatar, no attestation. The client's
  next move is to re-read `GET /api/links` and verify the signature, because `verifyAttestation` is the
  only thing allowed to mint a record a face can be drawn from.

### What a client has to do

Not built here — this is the server half. **The client half now exists**: `src/v2/data/xPrivy.ts` is
the login trigger and `src/v2/data/xProof.ts` is the artefact contract. What follows is what it has to
satisfy, and each item names where it is satisfied.

1. **`?links=api`.** Identity rendering is already gated on `src/v2/data/linkSource.ts`'s `?links=`
   flag, and that is the only client-side switch; the write path's gate is a server variable because a
   query parameter cannot gate a write.
2. **A fresh identity token, obtained immediately before the ceremony.** The server refuses a token
   whose `iat` is more than **one hour** old with `401 {"error":"stale-proof"}` — a bearer proof of
   somebody's X identity is an impersonation vector for as long as it lives, and Privy mints a new one
   on link/refresh anyway, so the natural flow costs nothing. On `stale-proof`, refresh and retry once.

   The SDK is **`@privy-io/js-sdk-core`, not `@privy-io/react-auth`** — the vanilla client rather than
   the React one, pinned to `0.69.0`, and the argument (size, hard dependencies, and the fact that
   `<PrivyProvider>` would put an identity SDK in the main bundle for every visitor) is written out in
   `src/v2/data/xPrivy.ts`. The accessors are the same shape without the hooks: `privy.getIdentityToken()`
   for the token and `privy.user.get()` for the refresh, which re-mints it as a side effect — which is
   how the client satisfies the one-hour rule **without parsing the token**, since a second opinion
   about the artefact in the browser is a second place for the two halves to disagree. The retry is
   already implemented, once and only once, in `src/v2/data/xLinkCeremony.ts#runLink`.
3. **The consent screen first.** `src/v2/data/xConsent.ts` already holds the copy, including the
   deanonymisation sentence §6.1 requires **before** the redirect.
4. **`signMessage`.** Already on `ChainIdentity` (Stage 1, done). Sign the `message` string's UTF-8
   bytes and send base64 — the same encoding as `LinkAttestation.sig`.

### Refusals, and what they mean

| Status | `error` | Meaning |
|---|---|---|
| 503 | `disabled` | `XLINK_WRITE_ENABLED` is not `on` on this deployment. |
| 415 / 413 / 400 | `content-type` `too-large` `malformed` | The request. `detail` says which part. |
| 429 | `rate-limited` | With `Retry-After`. 20 per (IP /24, wallet) and 60 per IP /24, per ten minutes. |
| 401 | `no-x-account` | Verified Privy user with no X account linked — they closed the popup. |
| 401 | `stale-proof` | Refresh the identity token and retry once. |
| 401 | `bad-proof` | Everything else about the token, collapsed into one answer on purpose. |
| 400 | `expired` | The nonce is unknown, already redeemed, or past its five minutes. One answer for all three. |
| 401 | `bad-signature` | The wallet signature does not verify against the stored message. |
| 403 | `refused` | A reserved fixture id or a reserved handle (`api/src/reserved.ts`). |
| 409 | `wallet-taken` | This wallet already wears a different X account. Unlink first. |
| 503 | `unavailable` | **Ours.** A house wallet, an unreadable roster, or an unexpected fault — deliberately indistinguishable, because a refusal that named the house case would be a roster oracle. |

### What the operator has to do by hand

**In the Privy dashboard** (`dashboard.privy.io`, app `cmsnbbun8007m0cjxbfx762sw`) — none of this can be
done from this repo, and the ceremony cannot work until all four are true:

1. **User management → Authentication → Advanced → "Return user data in an identity token": ON.**
   The identity token is **opt-in**. Until this is enabled Privy issues no `privy-id-token`,
   `getIdentityToken()` returns `null`, and there is nothing for `/api/x/challenge` to verify. This is
   the single most likely reason for a ceremony that "does nothing".
2. **Enable Twitter/X as a login method.** Privy will use its own shared OAuth credentials unless you
   supply your own X app's client id and secret; their own guidance is that supplying your own is best
   practice, and it is the only way to control scopes and rate limits. Shared credentials are enough to
   test with.
3. **Configuration → App settings → Domains: add the origins the browser will use.** Privy checks the
   requesting origin against this list. **`https://*.vercel.app` cannot be allowlisted** — Privy
   explicitly refuses generic preview-host wildcards — so a preview deployment needs a stable custom
   subdomain attached to it, or the client half must be exercised on `localhost:<port>` (allowed, port
   mandatory) or on the production domain.
4. **Optionally shorten the token lifetime** in the same Advanced panel. Privy's docs give 1 hour in one
   place and 10 hours in another for the identity token; the server caps acceptance at one hour
   regardless (`MAX_IDENTITY_TOKEN_AGE_SECONDS`), so this is defence in depth rather than a requirement.

**In the Vercel dashboard:**

5. **Add `KEEPER_HOUSE_TOKEN` and `VITE_PRIVY_APP_ID` to the Preview environment.** Both are Production
   only today. Without the first, *every* route here fails its cold start on a preview; without the
   second, the ceremony does.
6. **`XLINK_WRITE_ENABLED=on`, Preview only**, until the flow has been exercised end to end.

**Against the database:**

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f er-demo/api/migrations/0002_x_link_write.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f er-demo/api/migrations/0003_x_link_suppressed.sql
```

Additive and idempotent: three new tables, one `DROP NOT NULL`, and a backfill. Safe to apply before the
code ships — the gate keeps the new routes inert — and both **must** be applied before the gate is turned
on. **0003 is not optional**: without it every `link` refers to a table that does not exist, and with the
old schema alone the kill switch can be cleared by a player (see the note below).

### The CSP will need three additions before the client half works

`vercel.json`'s policy is `Content-Security-Policy-Report-Only`, so nothing is blocked today and
nothing here is urgent. But when the Privy SDK lands in the bundle it will want, at least:

* `connect-src https://auth.privy.io https://api.privy.io` — the SDK's own API calls;
* `frame-src https://auth.privy.io` — Privy renders parts of its flow in an iframe;
* `form-action` already allows `https://x.com`; the redirect now goes via `auth.privy.io`, so that host
  belongs there too.

Enumerate what the client actually reaches from the report-only console rather than copying this list —
that is how the existing `connect-src` was built (see the table further down).

### Three defects review found in this build, and what each cost

Recorded because each was invisible to the tests as written, and the shape of the mistake is more useful
than the fix.

**1. The per-wallet rate bucket was keyed on the wallet alone** — an unauthenticated body field, on a leg
that takes no credential at all. Twenty-one `POST /api/x/challenge {"wallet":"<victim>","purpose":"unlink"}`
from any stranger exhausted that wallet's budget and locked its owner out of **their own revocation** for
the window. §6.2 promises revocation is immediate. The subject is now `(network, wallet)`, so an attacker
outside the victim's /24 cannot spend their budget. `clientNetwork.ts`'s header had claimed the per-wallet
limit was "unaffected" by a spoofed header — true of headers, and beside the point.

**2. The kill switch could be cleared by the player it was aimed at.** `suppressed` was a column on
`x_link`; a player may delete that row while suppressed (§6.2, and they must be able to); the next link
was a fresh `INSERT` that took `DEFAULT FALSE`. Three self-service, correctly-signed steps put a
suppressed identity back on the leaderboard. Migration **0003** moves the durable record to
`x_link_suppressed`, keyed on the `x_id`, which `unlink` does not touch and `link` reads on insert. The
comments asserting a relink could not clear the flag were true of the `DO UPDATE` branch and false of the
insert branch nobody looked at.

**3. The JWKS cache served a retired key indefinitely during a Privy outage** — and refetched on every
request while doing it. Past its TTL it fell through to the last-good-set fallback, which is right for a
transient blip inside the TTL and wrong after it: a key Privy has retired kept verifying tokens, which is
the one event a rotation exists to end. It now refuses (`keys-unavailable` → 503) when the set is still
stale after an attempted refresh, and the attempt is behind the ten-minute cooldown. The class header had
promised exactly this behaviour in writing; no test moved the clock, so nothing checked it.

Two smaller ones: a relink after the player deleted their X picture used to leave `avatar_hash` and the
bytes in place with no `avatar_url` to refresh from — the old face served for ever, so the three avatar
columns now clear together; and the expired-challenge sweep sat on the challenge *insert*, the one
operation an abuser never reaches, so it moved onto the rate-counter statement that every write request
runs.

### Two things Stage 3 deliberately did NOT build

**1. There is no token to revoke, so nothing revokes one.** §4.1 step 3 has the raw-X flow calling
`POST /2/oauth2/revoke` immediately after reading the profile. With Privy the X access token is never
issued to us — it exists inside Privy — and the identity token we do see is verified, read and dropped
without being stored. §6.4's "there is no credential to leak" is now true by construction rather than by
discipline.

**2. The ceremony does not ingest the avatar.** It stores `avatar_url` and leaves `avatar_hash` NULL,
which is §7.3's ordinary "linked + avatar in flight" rung and renders as the flat side-coloured disc.
The picture arrives when somebody runs `scripts/xlink-ingest.ts`. That is a deliberate boundary, not a
gap: `avatarIngest.ts`'s header argues that a native image decoder parsing hostile input should stay out
of any function a browser can reach, and the write path is now the *most* browser-reachable function in
the feature. Options for closing it, in order of preference: a Vercel Cron calling an authenticated
ingest route; or `sharp` in the write function, validated on a preview, accepting ~30 MB of bundle and a
cold start on the link path.

---

## Where this build departs from `TWITTER-CONNECT.md` §§3–7

**0. `avatar_url` is nullable too, as of migration 0002.** An X account with no profile picture is served
X's default egg from `abs.twimg.com` — a different host from the `pbs.twimg.com` the column's anti-SSRF
CHECK admits, and a picture we would decline anyway, because §7.3's flat side-coloured disc is both
better looking and more honest than a grey silhouette. Under `NOT NULL` such an account could not be
stored at all, so the ceremony would have had to refuse a link that was otherwise perfectly proven, with
an error the player can neither understand nor fix. NULL now means "there is no upstream picture", which
composes with `avatar_hash` NULL and renders identically. **The CHECK is untouched**: SQL checks are
satisfied by NULL, so the anti-SSRF guarantee is unchanged — and `scripts/xlink-seed.ts` stopped
defaulting to a `pbs.twimg.com/sticky/default_profile_images/…` path that satisfied the pattern and 404s
at ingest for ever.

**1. `avatar_hash` is nullable (§4.3 writes `NOT NULL`).** Unsatisfiable alongside two other things
the same document says: §7.3's failure ladder lists "linked + avatar in flight" as an ordinary rung,
and `LinkAttestation.avatarPath` documents `""` as "no avatar yet". `NOT NULL` forces the upstream
fetch to succeed *inside* the link ceremony, so a hiccup at X's CDN fails a link that was otherwise
perfectly proven. `NULL` is a state the rest of the system already models.

**2. The proxy does not fetch (§7.2 says it does).** §7.2 also says "never 404 on a transient
upstream failure — serve the last good bytes", and that rule makes the first design impossible: last
good bytes means the bytes are stored, and once stored the fetch has already happened. So the fetch
moved to an **ingest** that writes `(avatar_hash, avatar_bytes)` atomically, and the proxy became a
pure read. Three things fall out, all good:

* *Last good bytes becomes unconditional.* Ingest writes only on success, so a failed fetch is a
  no-op. The rule is enforced by there being no code that could break it.
* *The read path has no outbound HTTP at all.* A proxy that fetches is an SSRF surface that has to be
  argued safe. A proxy that reads a row is not one.
* *`sharp` leaves the hot path* — and with it, the entirely undocumented question of sharp on
  Vercel's Node runtime leaves Stage 2. Every §7.2 guard is still built and still tested; they run at
  write time. Stage 3 gets them back in a function by adding `sharp` to the deployed dependency set
  and calling the same module, on a preview deployment where that can be validated.

**3. The keeper's schema version is not asserted.** `keeperStatus.ts` demands an exact match because
it draws a *countdown* from that file. This code asks one question and uses the answer only to
withhold, so pinning the version would mean a keeper deploy silently removes every avatar on the site
until the function is redeployed to agree with it.

---

## Cost

At §2.5's volumes — 1,000 link events and 100k page views per month.

| Line | Figure | The cliff |
|---|---|---|
| Vercel Functions | **~$0** | ~400k invocations/mo at a 30s client cache. Hobby's 1M-invocation and 100 GB-hr allowances are ~2.5× clear. **A client polling faster than every 30s is the only way to reach it** — the poll interval is the cost lever, not the code. |
| Neon storage | **$0** | 1,000 avatars × ~6 KB = **6 MB** of `bytea`, plus a few hundred KB of rows. Free tier is 0.5 GB — 80× clear. |
| Neon compute | **$0** | Free tier gives ~191 compute-hours/mo on a 0.25 CU endpoint. Every query is a single-statement unique-key lookup over the HTTP driver. **The cliff is Neon's autosuspend**: if the endpoint sleeps, the first query after idle pays a cold start. Not a cost risk; a latency one. |
| Neon egress | **$0** | 5 GB/mo free. Avatar bytes leave the database only on a CDN miss. |
| Avatar bandwidth | **~$0** | 1,000 × ~6 KB = 6 MB of distinct bytes. With `max-age=86400` the CDN absorbs essentially all of it; even 100k uncached fetches is 600 MB against Vercel's 100 GB allowance. |
| `sharp` cold start | **$0 and not applicable** | Not deployed in Stage 2 — see departure 2. When Stage 3 adds it, budget ~30 MB of bundle and a few hundred ms on a cold start, on the *write* path only. |
| X API | **$0** | No X calls exist in Stage 2. |
| **Total** | **$0/month** | |

The only genuine cliff in the whole design is the client's `/api/links` poll interval. Everything
else has an order of magnitude or more of headroom.

---

## CSP — report-only, and it must stay that way until someone reads the production env

`vercel.json` now sets `Content-Security-Policy-Report-Only`. Nothing is blocked; violations appear
**in the browser console only** — no `report-uri` is configured, so there is no dashboard to check.
Open DevTools on a deployed page and look for `[Report Only]` lines.

`connect-src` was built by enumerating what the client actually reaches, not by copying §7.6:

| Host | Evidence | §7.6 had it? |
|---|---|---|
| `https://api.devnet.solana.com` | `BASE_RPC` default, `src/chain/constants.ts:43` | yes |
| `https://devnet.helius-rpc.com` | what `VITE_BASE_RPC` is actually set to in production, per `scripts/keeper/README.md` | **no** |
| `https://*.magicblock.app` | the router (`ROUTER_URL`) *and* the ER validators `sendTx.ts` posts to directly by `fqdn` — the router picks which, so they cannot be enumerated | partially |
| `wss://` for all of the above | `Connection` derives a WebSocket endpoint from its HTTP one (`makeWebsocketUrl`) and `confirmTransaction` uses it | **no — and CSP schemes must match, so `https://x` does not permit `wss://x`** |
| `https://bulls-arena-keeper-devnet.fly.dev` | `VITE_KEEPER_STATUS_URL` in production | yes |

`worker-src 'self' blob:` is also added: pixi.js v8 builds its `loadImageBitmap` / `checkImageBitmap`
workers from `URL.createObjectURL(new Blob([...]))`. v2 does not use pixi, but `/legacy.html` does and
is still somebody's live workstream. This is narrower than putting `blob:` in `script-src`.

**Before flipping to enforcing, an operator must confirm in the Vercel dashboard:**

1. **`VITE_BASE_RPC`'s actual value in every environment.** It is overridable at build time and the
   repo's own comments name quiknode, rpcpool and alchemy as alternatives. If production points at a
   host not listed above, an enforced CSP blocks every RPC call and **takes the whole game down** —
   this is far worse than a broken avatar.
2. **`VITE_KEEPER_STATUS_URL`'s actual value.**
3. That one release has run report-only with a clean console on `/`, `/arena.html` and
   `/legacy.html`, including a full connect → enter → fight cycle.

Expected report-only output when everything is right: **nothing**. Anything that appears is either a
host missing from the list above or `/legacy.html`'s pixi workers, and both are additions to the
policy rather than reasons to loosen it.
