# TWITTER-CONNECT.md

Wallet ↔ X identity for Bulls vs Unicorns: architecture, cost reality, and a staged plan.

Status: **proposal**. Nothing here is built. Written 2026-08-10 against `magicblock-er-migration`.

---

## 0. The answer up front

**Money.** X's API has no free tier for new developers as of 6 Feb 2026. It is pay-per-use. But the
only call this feature needs is the user reading their *own* profile, which X prices at **$0.001 per
read** ("Owned Reads"). At 1,000 link events per month that is **about $1/month**, plus an optional
capped staleness refresh of ~$10/month. There is no monthly minimum — $0 if nobody links. **This
feature is cheap. It is not the reason to hesitate.**

The two things that *can* make it expensive, and which this plan explicitly forbids:
- A scheduled refresh of every linked profile. 1,000 users/day at the $0.010 general Users read rate
  is **$300/month** for almost no benefit.
- Privy (the old implementation's OAuth broker). Free under 500 MAU, then **$299/month** — a cliff
  that arrives at exactly the moment the game succeeds.

**Schedule.** The real risk is not cost, it is *access*: an X developer account with a payment card,
and however long approval takes. Stage 0 of the plan exists so that four other agents can build,
test and demo the entire feature with **zero** X dependency.

**Architecture.** Vercel serverless functions in `/api` in this same repo, Postgres for the mapping,
avatars re-encoded and served from our own origin, and every record delivered to the browser with a
detached ed25519 signature so the API is *available* rather than *trusted*. The Fly keeper is
rejected, emphatically. An on-chain PDA register is rejected, with regret.

**The single strongest recommendation:** ship Stage 0 (mock + seam + contract) this week, before
anyone asks X for anything.

---

## 1. What the old implementation actually did

The owner is right that `web/index.html` had X Connect, and it was **not decorative**. It was real
OAuth with real wallet auth. It also had a hole, and the hole is the most instructive thing in this
document.

### 1.1 The mechanism

**OAuth broker: Privy.** App id `cmsgbjr5q005l0cl4jeg4wizn`, hardcoded in the page (correct — it is
a public client id).

`web/index.html:2868-2907` — the start leg. It hand-rolls PKCE (`crypto.getRandomValues` → 48-byte
verifier + 32-byte state, `SHA-256` challenge, base64url), stashes `{verifier, state}` in
`localStorage["bvu_pkce"]`, and POSTs to `https://auth.privy.io/api/v1/oauth/init` with
`provider:"twitter"`, `redirect_to`, `state_code`, `code_challenge`. It tries the
`@privy-io/js-sdk-core` SDK first (loaded from `esm.sh` at runtime) and falls back to the raw API —
the comment calls the raw path *"proven working against auth.privy.io from this origin"*, which
reads like the SDK path was flaky.

`web/index.html:2909-2937` — the return leg. Reads `privy_oauth_code` / `privy_oauth_state` off the
query string, exchanges via `loginWithCode` or `POST /api/v1/oauth/authenticate`, finds the
`twitter*` entry in `linked_accounts`, and takes `username` + `profile_picture_url`.

**Storage: two places.**
1. `localStorage["bvu_x"] = {h, av, verified:true}` — the browser's own copy, used by `applyX()` to
   badge the button.
2. `send({t:"setName", wallet:PK, name:"@"+h, avatar:av})` over the WebSocket to the off-chain
   engine, which is the *shared* copy every other player sees.

**Backend: the off-chain Node engine** (`engine/src/server.ts:1942-1948`). `setName` writes `a.name`
and `a.avatar` onto the account record, after `cleanDisplayName` / `cleanAvatarUrl`
(`engine/src/ledger.ts:104-118`).

**Avatars: `unavatar.io`.** `web/index.html:2415-2440`. Every `pbs.twimg.com/profile_images/...` URL
was rewritten to `https://unavatar.io/x/<handle>`. The stated reason — *"Twitter's own CDN blocks
cross-origin image loads"* — is a **misdiagnosis** worth recording, because we will meet it again:
`pbs.twimg.com` serves images fine in an `<img>`; what it does not send is
`Access-Control-Allow-Origin`, so setting `img.crossOrigin` fails. The fix they eventually landed on
(`web/index.html:2431-2433`) says exactly the right thing — *"No crossOrigin: we only DRAW this
image, never read pixels back"* — but the `unavatar` rewrite was left in place on top of it.

### 1.2 Was the link proven?

**Both directions were proven, and that is better than expected.**

- **X side:** genuinely proven. Privy performed a real OAuth 2.0 authorization-code + PKCE exchange;
  the handle came back from the identity provider, not from the user.
- **Wallet side:** also genuinely proven. `setName` is in `GUARDED` (`engine/src/auth.ts:63-70`), and
  `server.ts:1593` refuses any guarded message whose `m.wallet` the socket has not proven by ed25519
  signature over a server nonce (`authVerify`).

The two proofs were bound by **session**, not by **cryptography** — the signed nonce says nothing
about the X account. For a server holding per-socket state that is sufficient. It is not sufficient
for a stateless serverless design, which is why §4 binds them explicitly.

### 1.3 The hole, and why it matters more than the rest

`web/index.html:2900-2906`:

```js
}catch(e){
  note("X connect unavailable (…) — using handle entry instead.");
  const h=(prompt("Your X handle (without @):")||"").trim().replace(/^@/,"");
  if(!h)return;
  localStorage.setItem("bvu_x",JSON.stringify({h,av:"https://unavatar.io/x/"+h}));
  applyX(); if(PK)send({t:"setName",wallet:PK,name:"@"+h,avatar:"https://unavatar.io/x/"+h});
}
```

On **any** OAuth failure, the page prompted for a handle and sent it through **the identical
`setName` message**. The `verified:true` flag lived only in that browser's `localStorage`; the engine
never received it, never stored it, and broadcast a typed handle and a proven one identically to
every other client.

And because `avatarSrc` resolves any handle through `unavatar.io/x/<handle>`, the attacker did not
even need to supply a picture. Type `blknoiz06`, get Ansem's actual name and actual profile
photograph on your fighter, in front of everyone. **That is precisely the impersonation attack the
social feature exists to make valuable, and it was the documented fallback path.**

Two smaller findings from the same code:
- `cleanAvatarUrl` (`engine/src/ledger.ts:115-118`) accepts **any** `http(s)` URL under 200 chars. An
  authed player could point every other player's browser at any host on the internet — an IP-logging
  beacon at minimum.
- The engine's `GUARDED` list groups `setName` with `withdraw` and `convert` under the comment
  *"Operations that move or reveal money."* Someone understood that a display name is a money-adjacent
  claim. Good instinct.

### 1.4 What we reuse and what we discard

| From the old design | Verdict |
|---|---|
| OAuth-authorization-code-with-PKCE shape | **Reuse.** Correct then, correct now. |
| Requiring a proven wallet before writing the link | **Reuse, and strengthen** — bind it cryptographically, not by session. |
| Privy as the broker | **Contingency only.** See §3.4. |
| Typed-handle fallback | **Delete, structurally.** There must be no code path that can write a link without OAuth. |
| `unavatar.io` | **Delete.** 50 requests/day per IP free, and a third party that receives every player's handle. |
| Arbitrary avatar URLs | **Delete.** Only `x_id`-keyed, re-encoded, same-origin images. |
| The engine as the store | **Gone anyway** — v2 has no WebSocket backend. |

**The design lesson, stated plainly:** the old system had the right guarantee and shipped an escape
hatch beside it that silently destroyed it. Defaults determine destiny. The new design's job is not
to add a proof — it is to make the *absence* of a proof unrepresentable.

---

## 2. The current X API reality (researched 2026-08-10)

Everything here is dated. Verify before spending.

### 2.1 Pricing

X moved to **pay-per-usage with no subscriptions** and **discontinued the free tier for new
developers on 6 Feb 2026**. Legacy Basic ($200/mo) and Pro ($5,000/mo) are closed to new signups; X
began auto-migrating remaining Basic subscribers to pay-per-use on **1 June 2026**. Enterprise starts
around $42,000/mo.

| Operation | Price |
|---|---|
| **Owned Reads** — *a user accessing their own data* | **$0.001 / resource** |
| Users read (general) | $0.010 / resource |
| Posts read | $0.005 / resource |
| Following / Followers | $0.010 / resource |
| Post creation | $0.015 (+ $0.200 if it contains a URL) |

Credits are purchased upfront and deducted as used. No free allocation. A new account reportedly gets
a **$1 trial credit** (~1,000 owned reads) with no card — enough to build and test the entire flow
before spending anything.

### 2.2 What we actually call

Exactly one billed call per link event:

```
GET /2/users/me?user.fields=profile_image_url,username,name,verified,verified_type
```

with an OAuth 2.0 user-context bearer token. `profile_image_url` **is** available on this endpoint.
The token exchange itself is not a billed read. Because the user is reading their own record, this is
an **Owned Read: $0.001**.

**Rate limits:** `GET /2/users/me` is **75 per 15 min, per user** — per-user, so it does not aggregate
across players. `GET /2/users/:id` (refresh path only) is 300/15min per app = 28,800/day, well above
any refresh budget we would set.

### 2.3 OAuth 2.0

Authorization Code with PKCE. **Confidential client** (Web App) — client id *and* secret, sent as
HTTP Basic on the token endpoint. Access tokens live **2 hours**. Without `offline.access` **no
refresh token is issued**, which is what we want (§6). Scopes: `users.read` and `tweet.read` (X
requires the latter alongside the former). Never `offline.access`, never `tweet.write`.

### 2.4 Display obligations

X's Developer Policy: when someone authenticates via Sign in with X, you **must** clearly display
their X identity — **current @handle, avatar, and the X logo**. Not optional. This also settles the
"should we show avatars at all" question: the avatar is a compliance requirement.

### 2.5 Realistic monthly cost

At 1,000 link events and 100k page views/month:

| Line | Cost |
|---|---|
| X: 1,000 owned reads @ $0.001 | **$1.00** |
| X: optional lazy 30-day refresh, capped ~35/day @ $0.010 | **$10.50** |
| Vercel functions | ~$0 at this volume |
| Neon Postgres (free tier) | $0 |
| Avatar bandwidth (1,000 × ~15 KB, CDN-cached) | ~$0 |
| **Total** | **≈ $12/month** |

For comparison: **Privy is $0 under 500 MAU and $299/month from 500 to 2,500 MAU**, counted on
everyone who uses the app, not just those who link.

**Honest answer to "is this expensive or not viable?": neither. It is roughly a coffee a month.**

---

## 3. Where it lives — the decision, and the alternatives that lost

### 3.1 Recommended: Vercel serverless functions in `/api`, same project

Five endpoints and a proxy, in this repo, deployed by the same `git push` that deploys the bundle.

The root `vercel.json` (`framework: vite`, `outputDirectory: er-demo/dist`) is compatible: Vercel
detects `/api` at **project root** independently of the framework build. No existing rewrite shadows
it; `cleanUrls: true` does not affect function routes. Needs a `functions` block and a runtime pin.

Why this wins:

**The read path adds no new failure mode.** Rendering the leaderboard means a CDN-cached `GET` from
the origin the bundle already came from. If that origin is down, the site is down anyway. Any *other*
choice creates a service whose outage is **independent** of the site's — strictly worse, because it
adds a way for the page to be up and broken.

**Coupling measured correctly.** The identity API and the frontend will change together, always. Two
things that change together belong inside one boundary.

**Secrets have a home.** Vercel env vars are the native counterpart of `fly secrets`.

### 3.2 Rejected: extend the Fly keeper

`er-demo/fly.toml` is a 250-line argument against this.

1. **One machine, by law.** Rule 1: `--ha=false` on every deploy. Auth on it is a single point of
   failure whose only remedy is forbidden for reasons unrelated to auth.
2. **Every keeper deploy is an outage.** `strategy = "rolling"` on a single-machine app means a window
   with zero keepers. Today that costs a countdown; with auth on it, every keeper deploy is an auth
   outage — driven by round-loop concerns, not identity concerns.
3. **No storage, by law.** Rule 2: NO VOLUME, because the loop re-derives every decision from the
   chain. The wallet↔handle map is the first thing that genuinely **cannot** be re-derived.
4. **Blast radius. Disqualifying on its own.** The keeper process holds the **arena authority key and
   the house wallet keys**. Putting a public, unauthenticated, internet-facing OAuth callback — with
   cookie parsing, redirect handling, a DB driver and an outbound HTTP client — into that address
   space is the largest avoidable increase in attack surface in the system. Right now the worst it can
   do is publish a wrong status file. After: sign arena instructions.
5. **It deletes a property that was expensive to get.** `statusServer.ts` is read-only, does no chain
   calls on the probe path, and serves one JSON body from memory. Adding writes, cookies, a database,
   a secret and an outbound fetch destroys that.

### 3.3 Rejected (runner-up): a separate small service

Architecturally clean, and what I would build if the frontend were not already on a platform that
hosts functions. Costs a second origin, its own CORS allowlist, TLS, uptime, deploy pipeline, secret
store and monitoring — for two endpoints and an image proxy.

**The trigger that would change this:** a second consumer — a mobile client, a Discord bot, a partner
integration. At that moment the boundary earns its keep, and the migration is a DNS change plus a
CORS list, because §5's attestation format is transport-independent by design.

### 3.4 Rejected as default, retained as contingency: Privy

Genuinely attractive: already integrated once and proven against this origin; holds the X app
credentials so **no X developer account is needed**; does Solana SIWS natively. Fastest path to a
working demo by a wide margin.

It loses on two counts: the **$299/month cliff at 500 MAU**, charged on *all* app users; and it
**becomes our identity database**, which we would then have to migrate off.

**Keep it warm.** If X refuses or delays a developer account, Privy is the Stage-3 substitute and
nothing else in the plan changes.

### 3.5 Rejected with regret: an on-chain PDA link register

The option that fits this codebase's instincts best, and it would work. The API signs an attestation;
an instruction verifies it via Solana's Ed25519 precompile; a `Link` PDA seeded by wallet stores
`x_id`, handle and an avatar hash. The read path then needs **no new infrastructure at all**.

It loses on **irreversibility**:

- **Permanent and public.** "Delete my link" becomes "close the account", which removes current state
  but not history. The creating transaction is in the ledger forever and every indexer has scraped it.
  A GDPR-shaped request has no honest answer.
- **Rent, ~0.002 SOL per link** — friction if the player pays, a griefing vector if we do.
- **A program deploy and an account layout that is forever**, for a feature that is decoration.
- **The bet is wrong.** It bets wallet↔handle is as durable as the money. Handles are renamed and
  recycled, accounts are deleted, and people change their minds about being publicly identified.
  Chain is for facts settled forever. This is a fact settled until Tuesday.

**The reversible version costs nothing and we take it:** publish the same signed attestation from the
API (§5). If the link ever needs to be trustless, the on-chain register becomes a *publication target*
change rather than a redesign.

### 3.6 On "a signed attestation that needs no server storage"

**The idea is right about signatures and wrong about storage.** Self-certifying data removes the need
to *trust* a server. It does not remove the need for a *directory*. Rendering the leaderboard means
resolving links for wallets that are **not you** — an attestation the client carries only helps the
client carrying it. The publication channel is a database by another name.

---

## 4. Proving the link, both ways

Two independent facts, **bound to each other in one ceremony**:

- **(A) This browser controls the X account.** Only OAuth proves this.
- **(B) This browser controls the wallet.** Only a wallet signature proves this.

Either alone is a forgery vector. **A alone**: I OAuth as *my own* handle and claim *your* wallet —
my handle now sits on a whale's P&L. **B alone**: the typed-handle box. Nothing at all.

### 4.1 The ceremony

```
1. START      POST /api/x/start          { wallet }
              state ← 32B random; verifier ← PKCE; challenge ← S256(verifier)
              KV[state] = { verifier, walletHint, createdAt }   TTL 10 min
              Set-Cookie: xc_state=<state>  HttpOnly Secure SameSite=Lax Path=/api/x
              → { authorizeUrl }
              (walletHint is a HINT. It proves nothing. Binding happens at step 5.)

2. AUTHORIZE  browser → https://x.com/i/oauth2/authorize?...  scope=users.read tweet.read

3. CALLBACK   GET /api/x/callback?code&state
              state must match BOTH cookie AND KV. Delete it. One shot.
              POST /2/oauth2/token   Basic <client_id:client_secret>  + code_verifier
              GET  /2/users/me?user.fields=profile_image_url,username,name,verified_type
              POST /2/oauth2/revoke  ← immediately. We keep no live credential. Ever.
              ticket ← 32B random; KV[ticket] = { xId, handle, name, avatarUrl } TTL 5 min
              → 302 /#/x/claim?ticket=…
              ► FACT A ESTABLISHED

4. CHALLENGE  GET /api/x/challenge?ticket=…&wallet=<currently connected wallet>
              builds the CANONICAL message, stores it verbatim against a fresh nonce
              → { message, nonce }

5. SIGN       wallet.signMessage(utf8(message))     ← one prompt, no transaction

6. LINK       POST /api/x/link  { ticket, nonce, signature, wallet }
              message ← KV[nonce].canonical      (NEVER the client's copy)
              ed25519.verify(signature, message, wallet)
              consume nonce AND ticket, one shot, atomically
              reject if wallet ∈ keeperStatus.house.wallets
              UPSERT with both unique indexes (§4.3)
              ► FACT B ESTABLISHED, BOUND TO A BY THE MESSAGE CONTENT
```

### 4.2 The canonical message

```
bullsvsunicorns.fun wants to link your X account.

Wallet:  7xKq…4ab  (full base58)
X:       @handle  (id 1234567890)
Nonce:   <32 bytes hex>
Issued:  2026-08-10T14:02:11Z
Expires: 2026-08-10T14:07:11Z

Signing this proves you control this wallet. It is not a
transaction, it moves no funds, and it costs nothing.
```

The binding is that **the X identity is inside the bytes the wallet signs**. A signature harvested
elsewhere cannot be replayed here, and a signature for this ceremony cannot be pointed at a different
X account.

Load-bearing rules:
- The server compares the submitted message against its stored copy **byte for byte**. Never re-parse
  a client-supplied string.
- Nonce and ticket are single-use, consumed in the same atomic operation as the write.
- The wallet named in the message is the one **connected in the browser at claim time**, not the
  `walletHint`. What the user sees is what they sign is what gets linked.
- The message says "not a transaction, moves no funds" because a wallet prompt with no explanation is
  how players get trained to sign anything.

### 4.3 Schema — make illegal states unrepresentable

```sql
CREATE TABLE x_link (
  x_id          TEXT PRIMARY KEY,      -- X's immutable numeric user id. NOT the handle.
  wallet        TEXT NOT NULL UNIQUE,  -- base58 ed25519 pubkey
  handle        TEXT NOT NULL,         -- snapshot, may drift
  display_name  TEXT NOT NULL,         -- snapshot, may drift
  avatar_url    TEXT NOT NULL,         -- pbs.twimg.com; never served to a browser
  avatar_hash   TEXT NOT NULL,         -- sha256 of re-encoded bytes; the CDN cache key
  linked_at     TIMESTAMPTZ NOT NULL,
  refreshed_at  TIMESTAMPTZ NOT NULL,
  suppressed    BOOLEAN NOT NULL DEFAULT FALSE   -- operator kill switch (§7.4)
);
```

**Keyed on `x_id`, never the handle.** Handles are recyclable: someone deletes `@foo`, an attacker
registers `@foo`, and a handle-keyed store silently hands over the identity.

**Both directions unique.** Relinking X account X from wallet W1 to W2 must remove W1's row **in the
same transaction** — otherwise one X account is on two fighters at once. That atomicity requirement is
why Postgres beats Redis here.

**Nothing else is stored.** No access token (revoked at step 3). No refresh token (never requested).
No email, no follower count, no post history.

### 4.4 What is still unproven, honestly

| Residual risk | What it permits | Mitigation |
|---|---|---|
| **Display-name impersonation** | Set your X display name to `Ansem`, copy his photo, link honestly. | **Always render `@handle`. Never the display name alone, anywhere.** X's display requirements demand the handle be shown — compliance and defence in one. |
| **Handle drift** | We snapshot at link time; `@a` renames to `@b`; someone else takes `@a`. | §7.5 refresh policy. The `x_id` key means the *identity* never transfers even when the *label* is stale. |
| **X account takeover** | Attacker with someone's X account links it to their wallet. | Nothing we can do. Downstream of X's authentication. |
| **Malicious-but-honest linking** | Real X account linked to a wallet funded with someone else's money. | Out of scope. We prove key control, not moral standing. |
| **Wallet key theft** | Whoever holds the key can link, unlink, relink. | Identical to the existing threat model — the same key moves the money. |
| **Two wallets, one person** | Link one wallet, play from another. | By design. The link is per-wallet. |

---

## 5. The attestation — why the API is available, not trusted

`GET /api/links?wallets=<comma-separated base58, max 64>` returns, per linked wallet:

```json
{
  "wallet": "7xKq…", "xId": "1234567890", "handle": "someone",
  "displayName": "Someone", "avatarPath": "/api/avatar/1234567890/<hash>.webp",
  "issuedAt": 1786, "expiresAt": 1786,
  "sig": "<ed25519 over the canonical serialisation of the fields above>"
}
```

Signed by a key whose public half is a **build-time constant in the bundle**. The client verifies
before rendering.

The property this buys: **a compromised or misbehaving API cannot invent a link.** It can withhold one
(denial). It can serve a stale one until `expiresAt`. It cannot make a wallet wear a handle that
wallet never proved. That reduces the API from *trusted for correctness* to *trusted for
availability* — the difference between "our backend got popped and Ansem's face is on a scam wallet"
and "our backend got popped and some avatars are missing".

- `expiresAt` at 7 days.
- **The client accepts a *set* of trusted public keys from day one**, or key rotation is a flag day.
- Signing key in a Vercel env var, generated offline, never in the repo.
- Verification failure is treated exactly like "not linked" — silent fallback to §8, one console
  warning. Never an error state a player sees.

---

## 6. Privacy and revocation

### 6.1 The fact that matters most

**Linking permanently deanonymises the wallet.** Not the leaderboard row — the *wallet*. Every token
it has held, every transfer it has made, every other protocol it has touched, past and future,
becomes public under a real name. Once a scraper has seen the pairing, deleting our row changes
nothing.

This must be said in one plain sentence **on the consent screen, before the OAuth redirect**:

> Anyone will be able to see that this wallet belongs to @handle. This wallet's entire on-chain
> history — everything it has ever held or sent — becomes public under your name. This cannot be
> undone by disconnecting.

This will reduce the link rate. **That is the correct outcome.**

### 6.2 Revocation

`DELETE /api/x/link`, authenticated by a **fresh wallet signature over a fresh nonce** — so a stolen
ticket or stale session cannot unlink someone.

- Deletes the row. Not a flag; a delete.
- Marks the avatar cache entry revoked so the proxy 404s.
- Leaderboard effect: **immediate**.
- Cached avatar bytes: **bounded by the CDN TTL**, which is why avatars get 24 hours rather than
  year-long immutable caching. A deliberate cost paid for revocability.

State the number in the UI: *"Removed from the leaderboard immediately. A cached copy of your picture
may persist for up to 24 hours."*

### 6.3 The house-wallet inference

**It is already public.** `keeperStatus.ts` publishes `house.wallets` to every browser and
`LeaderboardView.tsx` renders `FighterView.house` on the row — deliberately, as a disclosure
obligation. The link register cannot leak a secret already printed on the leaderboard.

The residual inference — *"unlinked implies house"* — is weak by construction, because most real
players will never link (§8), so unlinked is dominated by real humans.

**One hard rule regardless:** `/api/x/link` rejects any wallet in `keeperStatus.house.wallets`. A
house wallet wearing a person's face would be an actual misrepresentation.

### 6.4 Data handling

- No access tokens, no refresh tokens. `offline.access` never requested; the access token revoked
  seconds after issue. There is no credential to leak.
- Logs: never the signed message, never a token.
- `/api/links` takes an explicit wallet list and has **no enumeration route**. That does not make the
  register private — anyone can enumerate wallets from chain — but it removes the trivially
  scrapeable bulk export.

---

## 7. Avatars

### 7.1 Proxy, do not hotlink

1. **Third-party leak.** Hotlinking sends every player's IP and `Referer` to X's CDN for every
   fighter, every round — including players who never linked. `arena/faces.ts` already states the
   rule: *"SAME-ORIGIN ONLY… Nothing here may reach a third party."*
2. **Availability.** A deleted account 404s and a fighter loses its face mid-fight.
3. **CSP.** A proxy lets `img-src 'self' data:` stay closed.
4. **Canvas taint.** `pbs.twimg.com` sends no `Access-Control-Allow-Origin`. Verified this costs
   nothing today — no `getImageData`, no `toDataURL`/`toBlob` anywhere in `er-demo/src/v2`. But
   "share your round as an image" is an obvious feature for a social game, and hotlinking silently
   forecloses it.
5. **Moderation.** We cannot suppress an image we never fetch.

### 7.2 The proxy

```
GET /api/avatar/<x_id>/<avatar_hash>.webp
```

Keyed by `x_id` + content hash. **Never by URL and never by handle** — a proxy that takes a URL is an
open image proxy, an SSRF vector and a bandwidth donation.

- Not linked, `suppressed`, or hash mismatch → 404.
- Fetch with a 3s timeout, 512 KB ceiling, `Content-Type` allowlist.
- Rewrite `_normal` → `_400x400`. X's `profile_image_url` returns 48×48, unusable on a 100px disc.
- **Re-encode to a fixed 128×128 WebP.** Passthrough is not acceptable: decode-and-re-encode defuses
  a polyglot or malformed file and guarantees the bytes we serve are the type and size we claim.
- `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`.
- **Never 404 on a transient upstream failure — serve the last good bytes.**

### 7.3 Failure ladder

```
linked + avatar cached      → the avatar
linked + avatar in flight   → flat side-coloured disc (existing behaviour)
linked + upstream 404       → last good bytes, else flat disc
account deleted / renamed   → last good bytes until refresh, then flat disc
suppressed by operator      → flat disc, immediately
not linked                  → flat disc + nameFor() pseudonym   ← the majority case
```

Every rung is the flat disc. Nothing is an error state and nothing shows a hole.

### 7.4 Hostile and NSFW imagery — the honest answer

**There is no cheap technical solution.**

| | Cost | Latency | Verdict |
|---|---|---|---|
| **(a) Operator denylist** — `suppressed` flag, gone within one CDN TTL | ~$0 | none | **Ship this. Non-negotiable before launch.** |
| (b) Machine moderation at link time | ~$1 / 1,000 | +300-800ms | Add if volume outgrows (a) |
| (c) Manual review before an avatar goes live | staff time | hours | Kills the "connect and instantly see yourself" moment. No. |

**(a) now, (b) when busy.** X already moderates profile images, so the base rate of genuinely awful
content is low. The realistic attack is a targeted troll linking something offensive for one round;
against that, a kill switch plus the friction of burning an X account is proportionate.

**The kill switch must exist before the first real player links.** A moderation capability you have to
build during the incident is not a capability.

### 7.5 Refresh — where the money hides

**Never poll all profiles.** 1,000 users refreshed daily at $0.010 = **$300/month**.

| Policy | Cost | Staleness |
|---|---|---|
| Never refresh | $0 | Unbounded. A renamed handle is a slow-motion impersonation vector. |
| On user re-authorisation only | $0.001 each | Bounded only by the player's own visits. |
| **Lazy 30-day, budget-capped** | ~$10.50/month | ≤ 30 days + queue depth, *stated in the UI* |

**Recommended: the third, plus the second.** The cap is a hard budget enforced in code, not a
convention, and it is the single thing most worth an alert.

Show "checked 3 days ago" beside the handle. Staleness stated is staleness handled.

### 7.6 CSP — there isn't one

**`vercel.json` has no `Content-Security-Policy` today.** It sets `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`, and there is no `<meta http-equiv>`
anywhere in `er-demo`. So this feature is the occasion to add one **closed from day one**:

```
default-src 'self';
img-src 'self' data:;                      ← the proxy is why this can stay closed
connect-src 'self' https://api.devnet.solana.com https://devnet-router.magicblock.app
            https://bulls-arena-keeper-devnet.fly.dev;
script-src 'self';
style-src 'self' 'unsafe-inline';          ← Vite injects inline styles; nonce them later
frame-ancestors 'none';
base-uri 'none';
form-action 'self' https://x.com;          ← the OAuth redirect
object-src 'none';
```

Deploy `Content-Security-Policy-Report-Only` for one release, then enforce. A wrong CSP breaks the
game, not the avatars.

---

## 8. The unlinked path is the main path

Most players will never link. This is not degradation — it is the default rendering, and it already
exists and is good. `nameFor(wallet)` gives a stable deterministic pseudonym (`KESTREL_42`) with no
lookup and no network; `faceFor` already returns `null` cleanly and the painter already falls back.

1. **Unlinked never renders as an error.** No "?" placeholder, no silhouette, no empty ring, no grey
   person-icon — those read as *broken*. The flat side-coloured disc plus a pseudonym reads as *a
   player*.
2. **No per-row nag.** The connect affordance lives in one place, once.
3. **Three layouts must be tested:** zero links, all links, and a mix. The mix is where a row layout
   that silently assumed an avatar column falls apart.
4. **`faceFor`'s "null is a real state" contract survives becoming a network resource.** New test
   cases: link arrives mid-round, avatar 404s mid-round, link revoked mid-round, images disabled,
   proxy slow.
5. **Never block a game action on the identity service.** If `/api/links` times out, the round renders
   fully unlinked and nothing tells the player anything. The feature's absence must be
   indistinguishable from a player who chose not to link.
6. **Never gate play on linking.** Not now, not as a growth idea later.

---

## 9. The design tension (hand-off to `er-demo/src/v2/SOCIAL.md`)

**The conflict.** `base.css` rules 1–5: no border-radius anywhere, no shadows, no gradients, no filled
cards, and *"THE ONLY COLOUR ON THE PAGE IS THE GAME."* A round raster photograph violates rules 1 and
5 at once, and it is someone else's artwork so it cannot be retinted by `paper.ts`.

**On the canvas there is no tension at all.** `drawFace` (`arena/draw.ts:338`) already circle-clips
artwork into a disc with a side-coloured rim. An avatar there is a strictly *smaller* change than the
coin logo already is. **The board is the easy half.**

**On the DOM it is a real problem.** A 20px round colour photograph in a hairline table is instantly
the loudest object on a page whose entire argument is restraint.

Three candidate resolutions:
- **(a) Square, not round** — matching `.mk`, 1px `--rule` border, no radius.
- **(b) Desaturated by default, colour on hover/`:focus-visible`.** `faces.ts` **already builds a
  desaturated variant** for the spent state, so the machinery exists on both surfaces.
- **(c) Avatar on the canvas only**, handle-as-text in the table.

Weak preference: **(a) + (b)**. The design agent's call.

**Two constraints that are not negotiable:**
1. **The `@handle` is always rendered.** The only unforgeable part of an X identity (§4.4), and
   required by X's display policy.
2. **The X logo must appear** wherever a linked identity is shown.

---

## 10. Staged plan

### Stage 0 — the seam and the mock
**No X account, no secrets, no money, no backend. Unblocks four agents on day one.**

- Define the wire contract as types in `er-demo/src/v2/data/xLink.ts`: `LinkRecord`,
  `LinkAttestation`, endpoint shapes. **This interface will outlive every implementation behind it.**
- `useLinks()` hook + provider, backed by a `?links=mock` fixture. Verifies signatures against a
  **test** public key so the verification path is exercised from the first commit.
- `faceFor` gains its avatar branch; the null-is-real-state contract preserved and tests extended.
- Leaderboard row renders the linked identity behind the flag.
- Consent copy drafted (§6.1) and reviewed.

**Depends on: nothing.**

### Stage 1 — wallet `signMessage`
Add `signMessage` to `SigningWallet` and `ChainIdentity` in `er-demo/src/v2/data/identity.ts` and wire
Phantom's. **This does not exist today** — the app only ever calls `signTransaction`.
`disconnectedWallet()` must reject it with `NO_WALLET_MESSAGE` exactly as it rejects the others, and
the frozen shared instance stays frozen.

**Depends on: nothing. Parallel with Stage 0.**

### Stage 2 — the platform, still no X
- `/api` on Vercel; `functions` block and runtime pin in `vercel.json`.
- Neon Postgres, §4.3 schema, both unique indexes, migration checked in.
- Attestation signing key; `GET /api/links`; the client verifies against the real key set.
- The avatar proxy (§7.2), the `suppressed` kill switch (§7.4), and the operator command.
- CSP in report-only (§7.6).
- Seed two rows by hand; point the Stage-0 client at it with `?links=api`.

**Depends on: Stage 0's contract.**

### Stage 3 — the real ceremony
- X developer app, confidential client, secret in Vercel env.
- `/api/x/start`, `/callback`, `/challenge`, `/link`, `DELETE /link`. Token revocation. House-wallet
  rejection. Consent screen.
- Behind a flag, on a preview deployment, with a small tester allowlist.

**Depends on: Stages 1 and 2, and an X developer account. The only stage with an external dependency,
deliberately last. Contingency: substitute Privy; nothing else changes.**

### Stage 4 — hardening and launch
- Rate limits per IP and per wallet on `/start` and `/link`.
- The refresh job (§7.5) with its hard budget cap, and an alert on the cap.
- Structured logs and an ops panel: links created/revoked, X spend to date, proxy hit rate, denylist
  size, refresh budget consumed.
- CSP report-only → enforcing. Flag off.

### Explicitly out of scope
Posting to X on a player's behalf. Reading anyone's timeline. Follower-gated features. Follower counts
as a game input. An on-chain register.

---

## 11. Assumptions with expiry dates

| Assumption | Checked | Revisit when |
|---|---|---|
| X owned reads are $0.001 and `/2/users/me` qualifies | 2026-08-10, docs.x.com | Before Stage 3; quarterly |
| No X free tier; pay-per-use self-serve for new developers | 2026-08-10 | Before Stage 3 |
| `GET /2/users/me` is 75/15min per user | 2026-08-10 | If links exceed ~50/hour |
| Privy free under 500 MAU, $299 above | 2026-08-10, privy.io/pricing | Only if contingency invoked |
| `pbs.twimg.com` sends no `Access-Control-Allow-Origin` | Inferred from `web/index.html`'s scars | Irrelevant while we proxy |
| The v2 canvas never reads pixels back | 2026-08-10, verified by grep | If a share-image feature is proposed |
| House wallets already public via `keeperStatus.house.wallets` | 2026-08-10, read | If house disclosure policy changes |
| Vercel picks up `/api` at repo root alongside `outputDirectory: er-demo/dist` | Standard behaviour; **not verified against this project** | Stage 2, day one |
| Most players stay unlinked | Assumed | If link rate exceeds ~50%, revisit §6.3 |

---

## 12. Decisions needed from the owner

1. **Spend approval — the only true blocker.** An X developer account with a payment card, budgeted
   under $15/month, hard cap set in the developer console.
2. **Privy as contingency?** If X approval is refused or slow, accept the $299/month-at-500-MAU cliff
   to ship sooner? **Advice: no by default** — build Stages 0–2 and wait for X. Changes if there is a
   launch date.
3. **The deanonymisation warning.** Confirm the consent copy says plainly that linking makes the
   wallet's entire history public under the player's name (§6.1).
4. **Avatar moderation posture.** Denylist-only at launch (recommended, ~$0), or paid machine
   moderation from day one?
5. **Refresh budget.** Never-refresh ($0, stale handles) vs. lazy 30-day capped (~$10.50/month).
   **Recommend the capped refresh.**
6. **Mainnet posture.** The link is keyed by wallet and is chain-agnostic, so a devnet link carries to
   mainnet by default. Confirm that is intended.

---

## 13. Files this touches

Read for this plan: `web/index.html` (2415-2444, 2868-2938) · `engine/src/server.ts` (1586-1596,
1942-1966) · `engine/src/auth.ts` (63-75) · `engine/src/ledger.ts` (104-118) · `er-demo/fly.toml` ·
`er-demo/scripts/keeper/statusServer.ts` · `vercel.json` · `er-demo/src/v2/arena/faces.ts` ·
`er-demo/src/v2/arena/draw.ts` (338) · `er-demo/src/v2/data/identity.ts` ·
`er-demo/src/v2/contract.ts` (825-844) · `er-demo/src/v2/styles/base.css` ·
`er-demo/src/v2/views/LeaderboardView.tsx` · `er-demo/src/v2/GAPS.md`

Would be modified: `vercel.json` (`functions`, CSP) · new `/api/**` ·
`er-demo/src/v2/data/identity.ts` (`signMessage`) · `er-demo/src/v2/arena/faces.ts` (the avatar branch
the file already describes) · `er-demo/src/v2/views/LeaderboardView.tsx`, `ui/ConnectPanel.tsx` · new
`er-demo/src/v2/data/xLink.ts`, `useLinks.ts` · `er-demo/src/v2/GAPS.md` (X identity moves out of
"Deliberately not doing")

**Sources:** [X API pricing](https://docs.x.com/x-api/getting-started/pricing) ·
[X API introduction](https://docs.x.com/x-api/introduction) ·
[OAuth 2.0 authorization code with PKCE](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) ·
[X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits) ·
[GET /2/users/me](https://docs.x.com/x-api/users/user-lookup-me) ·
[X Developer Policy](https://developer.x.com/en/developer-terms/agreement-and-policy) ·
[Privy pricing](https://www.privy.io/pricing) ·
[unavatar](https://github.com/microlinkhq/unavatar)
