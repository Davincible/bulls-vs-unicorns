# `api/` — the wallet ↔ X register, server half

Stage 2 of `TWITTER-CONNECT.md`. **No X, no OAuth, no secrets in the repo.**

Two public routes and four operator commands. Everything here is written so that the expensive
mistakes — a suppressed picture that keeps being served, an automated wallet wearing a person's face,
a signature no browser accepts — are caught by `npm test` rather than by production.

---

## Where the code lives, and why it is split in two

| Path | What it is |
|---|---|
| `/api/links.ts`, `/api/avatar/[xId]/[hash].ts` | **Vercel entry points.** Repo root. Wiring only — env, driver, hand off. |
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
| `KEEPER_STATUS_URL` | Server, optional | Defaults to `https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json`. Deliberately **not** `VITE_`-prefixed — that prefix is what inlines a value into the public bundle. |

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

## Three places this build departs from `TWITTER-CONNECT.md` §§3–7

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
