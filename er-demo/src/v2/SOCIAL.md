# SOCIAL — faces, rivalry, and capital that plays while you sleep

The design for the social layer of v2, written to be implemented by several people at once. It is
decisive on purpose: where there was a choice, it is made here and the reasoning is written down so it
can be argued with rather than rediscovered.

Read `styles/base.css`'s header and `SPEC.md` before this. Where this document and those disagree,
they win, except in the three places named below where this one deliberately overrides them and says
so.

**This document supersedes `GAPS.md`'s "Deliberately not doing → X/Twitter identity as the fighter's
face".** That decision was correct given no identity system and a same-origin rule; the owner has
asked for identity, and §2 builds the identity system that was missing and keeps the same-origin rule
intact rather than trading it away. Whoever owns `GAPS.md` should strike those three lines and point
at this file.

---

## 0. The one-paragraph version

Auto-deploy makes your capital fight every round while you are asleep. Faces make it obvious *who*
you were fighting. The two are one feature: auto-deploy manufactures a story you were not present
for, identity puts names in that story, and the story is the reason to open the app tomorrow. The
robot enters; it never extracts. Extraction stays the human's decision, which is what keeps a
returning player worth more than an absent one — and we prove that with a number rather than assert
it.

The hard limits, up front, because three things in the brief cannot be built as described:

| The brief says | The truth | Where |
|---|---|---|
| "keeps going for days and days" | **24 hours, by choice.** The SDK caps a session key at 24h; the protocol does not, so "days" is reachable — by minting the token ourselves and holding an unbounded, un-revocable-by-the-player delegation for a week. We should not, and §5.2 says why. | §5.2 |
| "you put $1,000 on the platform" | **Nothing is custodied.** `enter` records a claim; no token moves. The v2 cashier is localStorage. There is no platform to put $1,000 on. | §5.5 |
| Twitter Connect "existed in the old game" | It did, and **its fallback path was `prompt("Your X handle")`** — an unverified vanity claim written into the same record as the verified one. That half does not carry over. | §2.1 |

None of the above needs a program change. §5.5 and §5.6 name the two things that *would*, loudly and
separately.

---

## 1. The engagement loop

### 1.1 The tension, stated properly

Auto-deploy runs the game without the player. That is either the product ("my money fights while I
sleep") or the end of the product ("nothing for me to do"). Every other decision in this document
depends on which. The resolution is not a compromise between them; it is a division of labour.

**Auto-deploy owns the entry. It never owns the exit.**

`enter` is a rule: side, amount, every round. It has no information a human has and loses nothing by
being automatic. `extract` is a judgement made against a live fight, under time pressure, racing
whoever settles the round — and it is where the money is. A robot that also extracted would be
playing the whole game, and there would genuinely be no reason to come back.

So the absent player gets the **default outcome**: fight to the bell, take what the seed gives.
The present player gets the **decision**. The gap between those two numbers is the entire reason to
open the app, and we put that gap on screen:

> Auto-play entered 31 rounds and returned **−$12.40**. You extracted 4 of them by hand: **+$40.10**.

That number is honest — extraction has real, structural value here (the decaying extract premium is
in the program) — so this is not a rigged incentive. It is a true fact about the game, surfaced.

**Corollary, and it is a hard rule for the "strategy config" work later: never ship auto-extract.**
The moment the robot can extract well, the loop dies and the product is a yield farm with a cartoon.
If strategy config wants an exit rule, the honest version is a *stop-loss* — "pull me out if I drop
below X" — framed as damage control, deliberately worse than being awake, and priced as such.

### 1.2 The loop

1. **ARM.** You commit a budget and a rule. The app tells you the exact wall-clock time it stops,
   because it knows: session expiry. "Plays every round until 14:20 tomorrow, up to $200."
2. **AWAY.** Rounds run. Your face is on a disc on a board other people are watching. You are
   present as a *character* while absent as a *user* — this is the part that has no analogue in the
   current product and is most of the reason to build it.
3. **RETURN.** The first thing you see is **the card** (§4.5): not a balance, a story. Rounds
   entered, rounds missed and why, best and worst, and the name of the person who took the most off
   you.
4. **SETTLE A SCORE.** The card names a human. The only available response to "@cobie took $84 off
   you across nine rounds" is to play a round against @cobie, by hand, and get the extract right.
   This is the retention mechanic. It is rivalry, not yield.
5. **RE-ARM.** The run is over because the session expired. Re-arming is one wallet signature.

Two independent return triggers land at the same moment: a mechanical one (the key expired, your
money has stopped working) and an emotional one (there is a name on the card). Neither alone is
reliable. Together they are a daily ritual with a wallet signature at the centre of it, which is
also — not coincidentally — a daily consent checkpoint on a robot that spends money. See §5.2: the
constraint and the loop are the same mechanism, and we should stop treating the 24-hour cap as
damage.

### 1.3 What we are betting on

That people return for **rivalry**, not for returns. The returns are small, noisy, and available
elsewhere. A named person taking your money in public is not. Every ranking in §3 follows from this
bet; if the bet is wrong, §3's order is wrong and the leaderboard-and-badges version of this document
is the alternative.

---

## 2. The identity model

### 2.1 What the old one did, and what carries over

`web/index.html` had two generations of this, and both are still in the file.

**Generation 1 — unverified.** `web/index.html:2901`:

```js
const h=(prompt("Your X handle (without @):")||"").trim().replace(/^@/,"");
localStorage.setItem("bvu_x",JSON.stringify({h,av:"https://unavatar.io/x/"+h}));
```

You type a handle and it becomes your face. The section header still reads
`// ---- X identity: handle -> name + avatar (unavatar, no OAuth needed) ----`.

**Generation 2 — real OAuth, via Privy**, app id `cmsgbjr5q005l0cl4jeg4wizn`, browser-only PKCE
against `auth.privy.io`, redirecting back to the page itself. No server of ours was ever involved.
It works.

**And the gap that makes both equivalent downstream.** Even the verified path only ever told the
backend this, over a websocket (`web/index.html:2933`):

```js
send({t:"setName", wallet:PK, name:"@"+h, avatar:av});
```

The engine's handler (`engine/src/server.ts:1942`) checks that the *wallet* is authenticated and then
takes the *handle* on trust. Any client could send `{t:"setName", name:"@elonmusk"}` from its own
wallet. The `verified:true` flag existed only in that browser's own localStorage and only controlled
a checkmark on a button. **So the effective model was: wallet proven, handle claimed.**

| Carries over | Does not |
|---|---|
| Privy OAuth as the handle proof — proven working from this origin, no X app credentials in our repo, no secret to hold | The `prompt()` fallback. Deleted. If OAuth fails there is no identity and the button says so. |
| `https://unavatar.io/x/<handle>` as the *upstream* image source, because `pbs.twimg.com` blocks cross-origin loads and unavatar does not | Reaching unavatar **from the browser**. §2.4. |
| Avatar as the fighter's face, circle-clipped — `save → arc → clip → drawImage → restore` | Sending a wallet address to a third-party host, which is `faces.ts`'s standing objection and is answered rather than overruled |
| `publicName()`'s instinct: an X identity is what earns you a real name on the board | Storing the X *display name*. §2.6. |
| X intent links for sharing (no posting on anyone's behalf, ever) | The websocket `setName` trust model. Replaced by §2.2. |

### 2.2 What proves the link

A link is a claim about two things and needs two proofs. Neither is optional.

1. **The handle.** Privy OAuth, exactly the Generation-2 flow, unchanged. Returns a verified X
   account: numeric id and current handle.
2. **The wallet.** A `signMessage` from the connected wallet over a fixed, human-readable message.
   This is the half the old product never did.

```
bullsvsunicorns.fun

Link this wallet to an X account.

  wallet: 7xKX...9fA2
  x:      @handle  (id 1234567890)
  nonce:  <32 bytes base64url, issued by the server, single use>
  issued: 2026-08-10T14:03:11Z

Signing this proves you control this wallet. It authorises nothing else:
no transaction, no transfer, no spending.
```

The server accepts the link only if **all** of: the Privy access token resolves to that X id; the
ed25519 signature verifies against the wallet named *inside* the message; the message's X id equals
the token's X id; the nonce was issued by us, is unused, and is under 5 minutes old.

The last clause is what stops the obvious attack — signing a message for wallet A and submitting it
as a link for wallet B, or replaying an old signature.

### 2.3 Where the mapping lives

**On a server we own. There is no way around this, and it is a new dependency for this project.**

The reason is not storage, it is *audience*. A client-only link (localStorage, as the old app did)
lets a browser know its own handle and nobody else's. The board would show your face and fifteen
strangers. The entire feature is that you can see *other people*. That requires a shared, readable
mapping, which requires a server.

What exists today: nothing. `er-demo` is a static Vercel build (`vercel.json`: `framework: "vite"`,
no `functions`, no `/api`). Nor is `public/keeper-status.json` the counter-example it was once
described as here: it is **not a committed file at all**. It is gitignored
(`.gitignore` → `er-demo/public/keeper-status.json`) and untracked, and the copy on any given laptop
is a build artefact rather than a source file. `Dockerfile` carries the reason it must stay that way:
a snapshot baked into the image would ship a permanently stale heartbeat that reads as a LIVE keeper,
when the whole design has the front end read a 404 as "no keeper is running here". It used to carry
the arena's own wallet list as well; `KEEPER_STATUS_SCHEMA` 5 took that out, along with the per-round
house and real fighter counts, and §2.7 is where that decision lands on this document. There are two
Fly machines (the legacy engine, and the keeper), and neither is right:

- **The keeper** (`bulls-arena-keeper-devnet`) holds the arena authority key and signs rounds. Adding
  a public write endpoint to the process that has round-write authority is not a trade worth making
  for a profile picture.
- **The legacy engine** (`bulls-arena-er-devnet`) is the custodial product v2 replaced, on a
  different host from the v2 frontend, and is a workstream being wound down.

**Decision: Vercel serverless functions in `er-demo/api/`, plus Vercel KV (or Postgres).** It is
already the production host of the frontend, it is same-origin by construction — which is what keeps
`faces.ts`'s rule intact — and it adds no new deployment target. `vercel.json` gains a `functions`
entry; nothing else about the build changes.

Four endpoints, and no more:

| | |
|---|---|
| `POST /api/x/nonce` | `{ wallet }` → `{ nonce, message, expiresAt }`. The server composes the message so the client cannot. |
| `POST /api/x/link` | `{ privyToken, message, signature }` → `{ profile }`. §2.2's checks. |
| `POST /api/x/unlink` | `{ message, signature }`, wallet-signed, message names the intent. |
| `GET /api/profiles?w=a,b,c` | up to 64 wallets → `{ [wallet]: Profile }`. Cache 60s at the edge. |

Plus `GET /api/avatar/{xId}` — §2.4.

**The built routes are named differently, and this table is the older sketch.** What exists is
`POST /api/x/challenge` (which does the nonce leg *and* verifies the Privy identity token, because the
message it composes has to name the X account it binds), `POST /api/x/link`, `DELETE /api/x/link` — one
route, two methods, since Vercel routes by path — and `GET /api/links?wallets=…` rather than
`/api/profiles?w=…`. `er-demo/api/README.md` has the wire shapes; `src/v2/data/xLink.ts` has them as
types, which is the copy to build against.

**Record shape.** Keyed on wallet; the durable X key is the **numeric account id**, never the handle:

```
wallet(PK) → { xId, handle, handleCheckedAt, avatarUpstream, linkedAt, revokedAt|null }
```

Handles are renameable and, once released, reusable by someone else. Keying on the handle means an
X rename silently reassigns a face and a reputation. Store the id; refresh the handle on a TTL
(24h); display whatever is current.

**One wallet ↔ one X account, enforced both directions.** Linking an X account already bound to
another wallet unbinds the other one, and the confirm step says so by name. Without this, one person
holds ten wallets, ten faces, and the board's whole claim — that these are people — is false.

### 2.4 Avatars: caching, proxying, and the hostile-image question

Avatars are the first raster images from a third party to enter this system, and `arena/faces.ts`
carries a standing refusal:

> a third-party avatar service (gravatar/unavatar and friends) would send this player's WALLET
> ADDRESS to a host they never agreed to talk to, on every fighter, every round. The field must make
> no off-origin request. It makes none.

That rule survives intact. **Every avatar byte is served from our own origin.**

```
GET /api/avatar/{xId}?s=48        →  48×48   (tables, rails, the ticker-adjacent rows)
GET /api/avatar/{xId}?s=192       →  192×192 (the field, the fighter inspector)
```

- **The route takes our own numeric id, never a URL.** This is the whole SSRF defence. There is no
  parameter a caller can point at `169.254.169.254` or at an internal host, because the upstream URL
  is looked up from our own table, not supplied.
- Upstream is `https://unavatar.io/x/{handle}`, resolved server-side, with a 3s timeout, redirects
  followed only within an allowlist (`unavatar.io`, `pbs.twimg.com`), max 3 hops.
- **Validate then re-encode.** Content-type in `{image/jpeg, image/png, image/webp}`; magic bytes must
  agree with the header; body ≤ 512 KB; then decode and re-encode to a fixed square WebP at the
  requested size. Re-encoding is the actual defence: it destroys polyglot files, EXIF payloads and
  anything that depends on a decoder quirk downstream. A file that does not decode is a 404.
- **SVG is refused outright**, at the content-type check and again at the magic-byte check. It is a
  script container and there is no size or sanitiser that makes it worth accepting.
- Response: fixed `Content-Type`, `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`,
  `Content-Disposition: inline`. `X-Content-Type-Options: nosniff` is already global in `vercel.json`.
- Negative cache 10 minutes on a 404, so a deleted X account does not become a per-frame retry.
- Rate limit per IP on the *link* endpoints; the avatar route is CDN-cached and effectively static.
- **Add a CSP** to `vercel.json`: `img-src 'self' data:`. This is now literally true, and it is worth
  having as an enforced statement rather than a convention.

**When one 404s, nothing new happens.** Both render paths already handle a failed image correctly and
neither needs a new state:

- Canvas: `faces.ts` settles on `img.naturalWidth > 0` — false for a 404, a corrupt file, and images
  disabled — leaving `face: null`, and `draw.ts:341` draws the flat side-coloured disc. "A fighter
  that never loads its face is simply a fighter drawn in its colour."
- DOM: `<img onerror>` swaps to the lettered mark (§2.5), which is the same fallback `TokenIcon`
  already uses for a token with no artwork.

**One load-bearing consequence of the proxy.** Same-origin images leave the canvas untainted, so
`toDataURL()` works. The old app explicitly accepted a tainted canvas — "we only DRAW this image,
never read pixels back" — and could therefore never have shipped a screenshot feature. We can. §3
depends on it.

### 2.5 The unlinked player — and why the board does not become grey circles

This was the stated worry and it does not apply, because **an avatar replaces something rather than
filling a hole**. Every unlinked state already exists, is already designed, and does not change:

| Surface | Unlinked (today, unchanged) | Linked (new) |
|---|---|---|
| Board disc | The side's coin logo, circle-clipped, side-coloured rim | The avatar, circle-clipped, side-coloured rim |
| Name anywhere | `nameFor(wallet)` → `OTTER_42` | `@handle` |
| Table name column | 16px square `TokenIcon` for the side | 16px square avatar |
| No side in context (all-time standings) | lettered mark in `--ink-3`, `TokenIcon`'s own `tico--letter` pattern | 16px square avatar |

> **2026-08-19 — the "Name anywhere" row is superseded.** `nameFor(wallet)` is deleted and there is
> no pseudonym on this page. Unlinked, the name slot holds **nothing at all** — no placeholder, no
> "Anonymous", no dash — and the truncated address already on the row is what identifies it. Linked
> is unchanged: the `@handle`. The rule deciding it is linked versus unlinked and nothing else,
> applied identically to every wallet on the page (`data/namePlate.ts`). The section's argument is
> untouched and reads more strongly for it: a handle, like an avatar, replaces something rather than
> filling a hole.

A board of fourteen coins and two faces does not read as broken. It reads as *two people I recognise
in a crowd*, which is the exact emotion this feature is for. The coin faces are not a placeholder for
avatars; they are the house style, and an avatar is a person stepping out of it.

The table columns are fixed-width tracks, so a column of mostly-lettered-marks stays flush and never
goes ragged.

### 2.6 Disconnect, revocation, and impersonation

- **Unlink is explicit and wallet-signed.** Disconnecting Phantom does *not* unlink — say that
  plainly in the wallet panel, because it is the natural wrong assumption and the consequence
  (your face keeps appearing) is exactly the kind of surprise this page does not do.
- On unlink the row is marked `revokedAt`; `GET /api/profiles` stops returning it; the avatar route
  starts 404ing. The edge cache means a face can survive up to **5 minutes** after unlinking. State
  that number in the unlink confirmation rather than implying it is instant.
- **Display `@handle`. Never the X display name.** Display names are unconstrained and are the actual
  impersonation vector — `Cobie` is free to type, `@cobie` is not. The old engine's instinct was the
  same (`a.name = "@" + h`). This costs nothing and removes the whole class.
- Verification of the *handle*, not of the *person*: `@cobie_` is a real account someone really owns,
  and our proof is genuine even when the account is a copy. That is X's problem and we should not
  pretend to solve it. What we do is show the full handle everywhere a face appears at readable size,
  and put `wallet · @handle · linked <date> · open on X ↗` in the fighter inspector.
- **No badge on a face.** `SPEC.md`'s `SIM` marker exists for money-shaped figures with nothing
  behind them, and `GAPS.md` was right that a marker cannot go on a face. But an identity is not a
  figure — the honest question about an attribution is not "is it chain-derived" but "who verified
  it". So the disclosure is a sentence, in the intro takeover and in the fighter inspector, and it is
  this one:

  > A face means this wallet proved it controls that X account, by signing for it. The proof is held
  > by this site, not by the chain — the chain knows only wallets.

### 2.7 The house must never have a face

The keeper seats the arena's own fighters so a lobby is never empty; a lobby holding a single one of
them is most of an idle arena's life. Faces would turn those into fake friends. That is not a
cosmetic slip — it is the one misrepresentation on this page that costs the most trust: a player
believing they beat a human when they beat the arena.

**Invariant: a face means a person, and the arena's own wallets may not wear one.**

Two guards, both on the server, and between them they cover the whole life of a link — the moment it
is created and every moment it is served:

1. **The write path.** `POST /api/x/link` refuses to create a link for one of the arena's own
   wallets. Nothing is written, so there is nothing to serve.
2. **The read path.** `/api/links` refuses to serve one, filtering every response rather than
   trusting that guard 1 held. It has to be both: a row inserted by hand, a wallet promoted to the
   house *after* it linked, and a bug in the write path all end at the same place, and only a filter
   at the point of reading catches all three.

**Status: both guards are now built.** Guard 2 is `api/src/linksHandler.ts` (answers `GET`/`HEAD`, 405s
everything else). Guard 1 is `api/src/linkWriteHandler.ts`, and one detail of it is worth carrying up
here because it is a rule about this document's subject rather than an implementation note: **the house
check runs AFTER the wallet signature has verified.** Reaching it requires an ed25519 signature from the
wallet in question, so the only party who can learn "this wallet is one of the arena's" is a party
holding that wallet's private key — who already knows. Checked any earlier, the endpoint would be a way
to read the roster off the error text one candidate wallet at a time, which is exactly what declining to
publish the list was for. The refusal itself is the generic `503 {"error":"unavailable"}`, byte-identical
to a keeper outage and to an unexpected fault.

It fails closed in both directions: a worker that has never once read the roster writes nothing at all
(`HouseListCache` reports `unknown`), and a deployment with no `KEEPER_HOUSE_TOKEN` throws at cold start
rather than starting up unable to enforce this rule.

Both read the list from the keeper's live endpoint over an authenticated channel:
`GET /house-wallets.json`, carrying `Authorization: Bearer $KEEPER_HOUSE_TOKEN`. **Not** from
`public/keeper-status.json` — which is not a committed file at all (§2.3: gitignored, untracked, a
runtime artefact of whichever keeper last wrote it) and which, since `KEEPER_STATUS_SCHEMA` 5, does
not carry the list at any age. `api/src/houseWallets.ts` holds the
argument for reading it live rather than baking in a copy (the bank grows, and a wallet added after
the copy was taken is exactly and only the case this rule exists for) and the fail direction: a
worker that has never once read the list serves *no* links at all, because the cost of failing closed
is the ordinary rendering of this page — a flat side-coloured disc and a `nameFor()` pseudonym, which
is what the great majority of players see anyway.

**There used to be a third guard, in the client, and it is gone. Why, not merely that.** The provider
nulled the profile for any fighter carrying `house === true`, at one call site, keyed off the very
mark the roster drew its `HOUSE` tag from — so a fighter labelled as the arena's could not
simultaneously wear a face. That guard was never stronger than the browser's copy of the wallet list,
and the arena's wallets are no longer published, named or counted anywhere a browser can read
(`keeperStatus.ts`, schema 5, has the decision and its consequences, including the hard reject that
stops a not-yet-redeployed keeper's older file being cached by a new page). A check with nothing left
to check against does not degrade into a weak guard; it becomes a parameter that is always `false`
and a branch that never fires, with a green test suite around it and the shape of protection standing
where the protection used to be. `data/linkFighters.ts`'s header now carries this argument at the
site the code left behind, so the next reader learns the guard **moved** rather than that it was
forgotten.

**The disclosure went with it, necessarily and completely.** The `HOUSE` tag, `houseNote()`'s
sentence, `FighterView.house`, the per-round house and real fighter counts and `isHouseWallet()` no
longer exist. This is not a softening of the invariant above; it is the withdrawal of a claim we no
longer have the evidence to make. A `house: false` left behind on a fighter would read as *checked,
and this one is a person* — a stronger claim than the disclosure ever made, made with no evidence, on
every row. "0 house" in a caption reads the same way. A concept this shape cannot be half-removed: it
goes completely or it lies. So the arena's own fighters now render as every unlinked fighter renders
— the side's coin, circle-clipped, and a `nameFor()` pseudonym — which asserts nothing about anybody,
and is the honest state rather than a degraded one.

> **2026-08-19 — what "the unlinked rendering" now is, twice in this section.** Both the fail-closed
> paragraph above and the paragraph directly over this note describe it as including a `nameFor()`
> pseudonym. `nameFor()` is deleted: the unlinked rendering is the flat side-coloured disc and the
> truncated address, with no username in it at all. Nothing in either argument moves. A worker that
> has never read the roster, a link withheld by either guard, and a player who simply never linked
> still all land on the same rendering, it is still what the great majority of the board shows, and it
> still asserts nothing about anybody. **The rule producing it is linked versus unlinked**, read off
> the link map alone and applied identically to every wallet (`data/namePlate.ts`, and
> `data/linkFighters.ts` for why the module takes a wallet and nothing else). It is not a rule about
> which wallets are the arena's own and must never be written down as one — the browser has no such
> list to apply, which is the whole of this section.

**Be honest about what is left.** Both guards run on the keeper's own account of which wallets are
its own. That was always the ceiling — `keeperStatus.ts` used to call it "disclosure on the keeper's
word" — and what changed is only that the word is now handed to our API over a channel the browser
cannot use, instead of published to everyone. So the answer that actually holds is the operational
one, and it is the one the old note here already ended on: the wallets are ours, and we never link
them. The two server guards exist to make that a property of the system rather than a promise about
our own discipline.

**No social surface makes this check.** Lobby presence, the rivalry ledger and leaderboard faces
render what `/api/links` was willing to hand them and nothing more — there is no per-surface list to
consult and no call for a new view to forget. Do not reintroduce one. A client-side membership test
needs a client-side copy of the list, and shipping that list to every browser in order to re-check a
rule the server has already enforced would spend the anonymity to buy nothing.

---

## 3. Viral mechanics, ranked

Ranked by expected effect over build cost. The line after #4 is real: everything below it is
decoration and should not be built before everything above it works.

Two facts govern the whole list. First, **the shareable unit is a URL, not a screenshot** — see 3.1.
Second, **every mechanic here is worthless at a low link rate**, which is why #4 is not optional
polish but the multiplier on 1–3.

### 3.1 — The round permalink with an unfurled card. *Highest leverage. Medium cost.*

`?round=N` already exists as a route. Give it server-rendered Open Graph tags and a generated image,
so pasting the link into X produces a card without the poster doing anything.

Why this and not a screenshot button: X intents cannot attach an image, so a PNG flow is
*download → open intent → find the file → attach*, which nobody completes. An unfurl is one paste.
And the link is a **referral link** (`?ref=` already exists and already pays 10% of the fee), so the
viral unit and the conversion unit are the same object. A screenshot converts nobody.

- **v1 card: typographic, in the paper-terminal style.** Big number, `@handles`, side marks, hairlines,
  white. On a timeline of neon casino screenshots this is conspicuous *because* it is restrained,
  and it is cheap: it is the design system we already have, rendered at 1200×630.
- **v2 card: the final field**, recomputed server-side from the VRF seed — the fight is deterministic,
  so this is chain-derived rather than a picture we invented. Do not build v2 until v1 is measured.

Share triggers, at the two emotional peaks only: the settled result plate, and a completed auto-play
run. Nowhere else.

### 3.2 — Faces on the board. *Highest emotional leverage. Low cost — the seam is already cut.*

This is the owner's headline ask and it is nearly free. `faces.ts:107-131` documents the exact branch
to add and why it was left empty; `draw.ts`'s `drawRim` was written *in anticipation of a photograph
that is not the coin*:

> SIDE SURVIVES THE PICTURE. The two logos are easy to tell apart at size and to anyone who knows
> them — but at r=8 they are both a dark smudge […] Membership has to be carried by something the eye
> can resolve at every radius the field produces.

So the rim already does the work an avatar would otherwise break. **No change to the rim, the wedge,
the labels or the palette.** One branch in `faceFor()` and the field is done.

What "visible" means here: during the fight you can follow one specific person's disc, watch their
health wedge close, and see the exact moment they extract or die.

### 3.3 — "Who is in this lobby", before entries close. *High leverage. Low cost once identity exists.*

The owner's "see which of your friends or influencers are active" is mostly this. It goes in **00-4
The field**, which is already the cast list, rather than a new section — during Lobby, 00-4 *is* the
presence surface and only needs the face column and a lede that says who is here.

"Visible" means: before you commit, you can see who you would be fighting, by name and face, with
their side and stake. And the lobby's share link (3.1) is a summons: "6 in, 4 slots, closes in 0:41".
Scarcity is real here — `MAX_FIGHTERS = 48` is a chain constant, not a marketing number — and
scarcity with named people in it is the most postable state this product has.

> The cap was 16 when this was written and is now 48, so the scarcity is a third as tight. The claim
> above still holds — the number is still the chain's and not ours — but "4 slots left" is a weaker
> summons out of 48 than out of 16, and a lobby that never fills is not a scarce one. Whether the
> share line should lead with slots remaining or with who is already in is now an open question
> rather than a settled one.

### 3.4 — A face and a handle are what earn you a name on the board. *Enabler. Nearly free.*

Carried over from the old engine's `publicName()`: unlinked players are `KESTREL_42`, linked players
are `@handle`. Do not gate *play* on linking, ever. Gate *identity*: your name, your face, your
appearance in someone else's rivalry ledger, your handle in the wins ticker.

There is a second, unglamorous reason this matters: `nameFor()` has 40 heads × 97 suffixes = **3,880
possible names**, so two fighters in the same round can already share a pseudonym, and at any scale
they will. The wallet is always printed alongside, so nothing is *wrong* — but a handle is the only
name on this page that is actually unique, and that is worth saying to the player as the reason to
connect.

This is the link-rate lever, and link rate is the multiplier on everything above. Ship it in the same
release as identity, not after.

> **2026-08-19 — the collision argument's premise is gone; the section's conclusion is not.**
> `nameFor()` is deleted, so "unlinked players are `KESTREL_42`" no longer describes anything, and the
> arithmetic this section leans on — 40 heads × 97 suffixes = 3,880 possible names, therefore
> collisions — has nothing left to count. **That premise is invalid, not merely stale.** There is no
> pseudonym to collide with: an unlinked row shows no username at all, and the truncated address on it
> is what identifies it.
>
> The conclusion survives, on plainer grounds and rather more forcefully. It was "a handle is the only
> name on this page that is actually unique"; it is now that **a handle is the only name on this page
> at all** — the heading above turns out to be literally true rather than comparatively so. What an
> unlinked player has is an address: unique in full, checkable, and not a name. So the thing worth
> saying to a player is no longer "your pseudonym may be somebody else's too" but "you have no name
> here until you link one", which needs no arithmetic to defend.
>
> One correction to carry with it: the truncated form is a display of the wallet, not a proof of
> distinctness — the full key underneath it is the unique thing, and it is what every surface holds.
> The rule deciding all of this is linked versus unlinked, applied identically to every wallet on the
> page (`data/namePlate.ts`).

--- **build the four above before anything below** ---

### 3.5 — The rivalry receipt. *High retention, low virality, medium cost.*

"@cobie has taken $412 off you across 9 rounds." Computable from data that already exists — `hitEvents`
resolves every hit to both fighters and `CombatEvent` already carries `mine`. Needs pairwise
aggregation over the round log, and inherits that log's retention window, so it must carry the same
coverage caption `SideRecord` does and must never say "all time" (`GAPS.md` §3).

This is the payload of the return card (§4.5) and the thing that makes step 4 of the loop work. It is
below the line only because it retains rather than acquires.

### 3.6 — Leaderboard faces. *Table stakes. Nearly free. Low leverage.*

Worth doing because it costs one component and looks broken without it once faces exist elsewhere.
But be honest: nobody has ever posted a leaderboard. It is not a growth mechanic.

### 3.7 — Watchlist / "notify me when @x is in a lobby". *Defer.*

Real, but it needs push infrastructure and a follow graph, and it is worth nothing until there are
enough linked players to follow.

### 3.8 — Do not build

Badges, XP, levels, streaks, seasons, in-app chat, emotes, reactions, an "invite 3 friends" tree.
Each is a week that does not produce a single post, and several of them make the page look like every
other product this one is deliberately not.

**Explicitly refused: reading the user's X follow graph** to compute "your friends". It needs an
elevated API scope, costs money, is a privacy liability, and answers the wrong question. "Friends"
here should mean *people you have actually fought*, which we can compute from our own data, is more
relevant, and needs no permission from anyone.

---

## 4. Where each element goes

Nothing below adds a screen. Section indices follow the existing survey numbering.

### 4.0 The wallet panel (`ui/ConnectPanel.tsx` / `ui/SideRail.tsx`) — identity lives here

`Connect X` sits directly under the wallet address, because that is where a user's identity lives and
because the link is *about* the wallet. Three states:

- **Unlinked:** `Connect X` + one line: "Your X name and picture become your fighter's face. Two
  steps: authorise X, then sign a message proving this wallet is yours. The signature authorises
  nothing else."
- **Linked:** 24px square avatar, `@handle`, `linked 8 Aug`, and `Unlink`. Plus the sentence that
  disconnecting the wallet does not unlink.
- **Failed:** the reason, and `Try again`. **No handle-entry fallback.**

### 4.1 — 00 ARENA

| Where | What |
|---|---|
| `00-2 The arena` (canvas) | Faces on discs. No other canvas change. The existing click-to-select fighter inspector gains `@handle · open on X ↗ · linked <date>` and the §2.6 disclosure sentence. |
| `00-2` result plate (settled) | **`Share this round`** — the one share control in 00. At the emotional peak, nowhere else. Copies the `?round=N&ref=<you>` permalink and opens the X intent with prefilled text. |
| `00-3 Deploy` | The `Repeat every round` control is promoted and rewritten as **auto-play** (§5.4): budget, stop conditions, and the wall-clock end time. |
| `00-4 The field` | Face column in both rosters. During Lobby the lede becomes the presence line — who is here, how many slots are left, when it closes. The roster says nothing about whether a fighter is a person: a face is the whole of that claim, it appears only where the server served one, and §2.7 is what keeps that true. |
| `00-4.1 Exchanges` | `@handle` in place of `OTTER_42` for linked wallets. No faces — this is a dense log and 24 rows of avatars is soup. |
| `00-5 Standings` | Face column. |
| Chrome (black bars) | **Handles as text in the wins ticker. No avatars.** A 20px black instrument bar is not somewhere a raster face belongs, and at that size it would not be recognisable anyway. |

### 4.2 — 01 LEADERBOARD

Face column in the name column of all three tabs, replacing nothing (the `Mark` and the side name
stay put). The all-time tab's retention-window caption is unaffected and stays.

### 4.3 — 02 DASHBOARD

- `02-2 Your position` gains the **live auto-play run status**: armed or not, budget remaining, rounds
  entered this run, wall-clock end time.
- **New `02-4 Your rivals`** — the pairwise ledger (§3.5), best and worst counterparties, with the
  coverage caption. It aggregates every counterparty the round log reports, and it neither excludes
  any of them nor says anything about which are people. The browser has no list to exclude by
  (§2.7), and a *stated* exclusion would be worse than none: "the arena's own fighters are not shown
  here" is a count of them by subtraction, which is the disclosure we removed arriving through a
  caption. A rival with no link is a `nameFor()` pseudonym, exactly as everywhere else on the page.

> **2026-08-19.** The last sentence is superseded in its detail and strengthened in its point.
> Pseudonyms are deleted: a rival with no link shows no username at all, and the truncated address in
> the row is what identifies them. "Exactly as everywhere else on the page" is the load-bearing half
> and it holds more strictly than before — the slot is decided from the link map alone, identically
> for every wallet (`data/namePlate.ts`), so this ledger still says nothing about which counterparties
> are people and still has nothing to say it with.

### 4.4 — 03 REFERRALS

No new section. `03-1 Your link` gains one line: shares carry your handle and your face once X is
connected, with a link to the wallet panel. The existing `Share on X` text gains `@handle` when there
is one. Referral remains wallet-based; X is the channel, not the identity.

### 4.5 — 04 HISTORY, and the return card

- `04-1 My previous rounds` gains a face row per round — who else was in it — and expands to the hit
  log that already exists.
- **New `04-3 Auto-play runs`** — one row per run: armed at, ended at, why it ended, rounds entered,
  rounds missed *and the reason for each* (`abandonText()` already writes these), net, and the
  signature of every automatic deploy. This is the audit trail for a feature that spends money
  unattended, and it is not optional.
- **The return card is a takeover**, the same class of object as the existing intro takeover, shown
  once per completed run on the next visit. It is the loop's step 3 and it must not be a toast.

  ```
  WHILE YOU WERE AWAY                            00:12 — 09:41

  31 rounds entered · 4 missed · net −$12.40

  best      #418   +$31.10
  worst     #402   −$18.20
  took most off you    @cobie   −$84.00 over 9 rounds

  You extracted 4 rounds by hand this week: +$40.10.
  Auto-play never extracts — that part is still yours.

  [ See the runs ]   [ Arm again — until 14:20 tomorrow ]
  ```

  Every figure is chain-derived or marked. The four missed rounds each carry their stated reason.

### 4.6 — The design language

The rules bend in exactly one place, and it is smaller than it looks.

**On the field: no bend at all.** The canvas already carries "ONE photographic element", already
circle-clips it, and `drawRim` was already written for a photograph that is not the coin. Avatars are
round there because a fighter is a disc — a physical object in a simulation — not because they are
avatars.

**On paper: square, 16px, 1px hairline, no radius.** `TokenIcon.tsx` states the rule and the reason:

> No rounding: a circle-cropped avatar would be the single most obviously "web app" thing on a page
> built to avoid exactly that.

That holds. **The rule is: round on the field, square on paper.** The field is a simulation of discs;
the page is a printed table, and a printed table sets a picture in a box.

**Colour.** Avatars are full-colour raster, and rule 5 reserves colour for the two sides. This is the
bend, and it is a bend that already happened: `TokenIcon` has been putting full-colour coin logos in
these same tables since before this document. An avatar is the same class of object — a photographic
marker at text scale, in a hairline box, sized to the type. The discipline that keeps it honest is
**size, not saturation**: 16px in tables, 24px in the wallet panel and the return card, 192px in the
fighter inspector, and nowhere else, ever.

Rejected: desaturating DOM avatars to preserve the monochrome. It would keep the rule perfectly and
destroy the feature — a grey 16px face is not recognisable, and recognition is the entire point.

**Where avatars may not go:** the black chrome bars, any surface where they would exceed 24px outside
the inspector, and inside `00-4.1 Exchanges`.

---

## 5. Auto-deploy as a product

Today's `data/autoDeploy.ts` is a good rule with a small promise: it repeats a deploy while the tab is
open, using a session key that lasts an hour. The brief asks for capital that plays for days. This
section is the distance between those, walked rather than assumed.

### 5.1 What the chain already permits — and it is more than expected

`enter` does **not** require the player to sign. From `programs/bulls-arena/src/lib.rs`:

```rust
#[session_auth_or(
    ctx.accounts.player.key() == ctx.accounts.signer.key(),
    SessionError::InvalidToken
)]
pub fn enter(ctx: Context<Enter>, side: u8, stake: u64) -> Result<()>
```

with `player: UncheckedAccount` and `session_token: Option<Account<SessionToken>>` bound by
`#[session(signer = signer, authority = player.key())]`. The struct's own doc comment explains why it
is safe unsigned: the token PDA is derived from `[b"session_token", target_program, session_signer,
authority]`, so only a token that wallet's own signature created will resolve.

**Consequence: whoever holds a valid, unexpired session key for a player may enter rounds on that
player's behalf, with no wallet present and no program change.** That is the mechanism for
unattended play, and it already exists on devnet.

### 5.2 The session-key ceiling — the hard constraint

From `src/chain/session/useSessionKeyManager.ts`:

```ts
// … the third argument is MINUTES FROM NOW, capped at `24 * 60` (the hook
// throws "Expiry cannot be more than 24 hours" above that) …
const SESSION_VALID_MINUTES = 60;
```

Four facts follow, and the third is the one that changes the answer:

1. **60 minutes is a chosen constant, not a limit.** Raising it to 1440 is a one-line change. But that
   file is `src/chain/**`, which the v2 workstream may not edit — so it needs the owner of that
   layer. **Not a program change. Flag it separately and get it done; nothing else in §5 works
   without it.**
2. **24 hours is gum's ceiling**, thrown by the hook on creation.
3. **It is not the protocol's ceiling.** `gpl_session`'s `create_session` bounds `valid_until` only
   from below — `verify-session-base.mjs:288` says so in as many words, and this repo's own scripts
   already call `gplSession.methods.createSession(...)` directly against the IDL rather than through
   gum. **A seven-day session token is mintable today.** So "days and days" is not blocked by the
   chain. It is blocked by what a seven-day token *is*.
4. **Renewal requires the wallet.** `autoSession.ts`'s `afterRefusal` renews a lapsed session on the
   next move — two Phantom approvals — and an absent player approves nothing.

**So this is a choice, not a limit, and it must be put to the owner as a choice.** Here is the case.

A `SessionToken` has exactly four fields — `authority`, `target_program`, `session_signer`,
`valid_until`. **There is no spend cap and no instruction allowlist.** Its whole security model is
"scoped to one program, until one timestamp". A seven-day token is therefore a seven-day unbounded
delegation over everything that program will ever accept from a session key, and the player's only
way out is `revoke_session` from the wallet they are away from.

Today that delegation is nearly harmless, because the program custodies nothing (§5.3). **After
custody it is the player's balance.** A one-day key is a one-day exposure and a daily consent
checkpoint; a seven-day key is a seven-day exposure and a checkpoint nobody attends. And a longer
token also means leaving `gum-react-sdk` for creation, which means owning `create_session`, renewal
and revocation ourselves — new code on the exact path where a mistake is a stolen key.

**Decision: 24 hours, and show the clock.** Revisit only when per-session spend allowances exist
(§5.6), at which point a 7-day key with a $200 cap is a genuinely different object from a 7-day key
without one.

> A robot that spends money with no scheduled human checkpoint is a liability we would have had to
> invent a checkpoint for. Taking the SDK's ceiling gives us a daily consent ritual, chain-enforced,
> that cannot be bypassed by a bug in our code. That is the safety property, and it is also §1.2's
> return trigger. Ship it as a feature, because it is one.

### 5.3 Three possible implementations. Ship A, design for B.

| | Runs when | Needs | Ceiling |
|---|---|---|---|
| **A — tab open** | The tab is open and the machine is awake | Nothing new but the 1440 change | 24h, one device, dies on a closed lid |
| **B — server-side agent** | Always | A server holding the session key + §5.5 custody | 24h, any device, tab closed |
| **C — program-level delegate** | Always | **A program change** | Whatever the program says |

**A ships now.** It is `autoDeploy.ts` with a longer session, a budget, and honest copy. It is worth
shipping on its own: "armed while this tab is open" is a real product for someone watching a fight.

**B is the product the owner described**, and it requires the session key to leave the browser. gum
holds that key in localStorage/IndexedDB, so "leaving" means one of two things, and the second is
better: either the browser exports the secret key to our server, or — preferably — **the server
generates the session keypair, and the wallet signs a `create_session` naming that server-held key as
`session_signer`.** The second never transmits a secret and gives the same result. Either way it is a
custody decision and must be named as one. The mitigating fact today is precise and worth stating
exactly:

> A session key for this program is scoped to `target_program` and can only call `enter` and
> `extract` as that player. Because the program custodies no tokens, **the worst a stolen session key
> can do today is enter rounds and extract them — it cannot move a single token.**

**And that is exactly what inverts the day custody ships.** See §5.5.

**C is the endgame and needs a program change.** Do not start it.

### 5.4 The safety model — what stops it silently draining someone

Five limits, and the run stops at whichever binds first. Each has a sentence on screen.

1. **A budget.** Committed at arm time, decremented per round, hard stop at zero. **It never tops
   itself up.** The budget is the budget.
2. **A per-round cap.** `STAKE_CAP_USD` already exists and already applies.
3. **A drawdown stop.** Stop the run at −X% of the committed budget (default 50%, settable). This is
   the only one that is new mechanism rather than new copy.
4. **Time.** The session expires and the chain refuses the next transaction. This is the kill switch
   that does not depend on our code being correct.
5. **A round ceiling**, optional, for people who think in rounds rather than hours.

Plus two kill switches, and the difference between them matters:

- **Pause** — local, instant, takes effect before the next round. `disarm()` already exists.
- **Revoke** — `revokeSession()`, on chain, closes the token. **This is the one that works even if our
  server is compromised, our client is wrong, or we are unreachable.** It must be one click from the
  wallet panel and it must be described honestly as the real one.

**Every automatic deploy leaves a receipt.** `AutoDeployAttempt.signature` already records the
confirmed signature; `04-3` renders them. A feature this quiet earns trust only through what it says
afterwards — which is `autoDeploy.ts`'s own framing and is already why `abandonText()` exists.

### 5.5 Custody — the dependency, stated as one

**The program custodies no tokens.** `enter` takes a `stake: u64` and believes it; no token moves.
The v2 cashier is localStorage and every figure it produces is `SIM`-marked. `ARCHITECTURE-N-TEAM.md`
§4 is the design and **it is not built**: there is no `programs/arena-vault`, and `programs/vault` is
undeployed with a placeholder id and a design that document explicitly rejects. Custody is sequenced
to its Phase 3, behind a gate that reads "all nine arenas running rounds on devnet, custodying
nothing, before a token moves".

So "put $1,000 on the platform and it keeps battling" is not partly true — there is no platform to
put it on, and an auto-play run deploys a paper position into a real on-chain record. That is fine
for model A (it is what the whole page already is, honestly marked) and it is *not* fine as a pitch.
**The pitch is blocked on custody, not on session keys.**

**What auto-deploy needs from custody, specifically — four things, and only the last is a surprise:**

1. **A balance the program can read and debit inside `enter`.** §4's lifecycle already does this and
   it has a consequence worth knowing now: **`enter` moves from the ER back to the base layer**, doing
   two SPL transfers (player → round escrow, player → treasury). The doc notes it stays "session-key
   signable, exactly as today", so model B survives the move — but auto-play's per-round transaction
   becomes a base-layer transfer rather than a rollup write, with base-layer fees and latency.
2. **A unilateral exit.** §4 is stronger than a withdrawal function: settlement is `claim(fighter_index)`,
   **permissionless**, paying only that fighter's own ATAs, with no operator signature anywhere. A
   player can always get their own money out without us. Preserve that; if auto-play ever depends on
   an operator-signed path, the budget in §5.4 becomes decoration.
3. **Someone to claim for the absent player.** *This one is created by auto-play and is not in §4.*
   `extract` makes value **safe, not liquid** — tokens arrive only when the round settles, undelegates
   and someone claims. A 24-hour run is ~50 settled rounds and therefore ~50 unclaimed escrows sitting
   behind a sleeping wallet. The fix is free and already in the design: **`claim` is permissionless
   and pays only the fighter's own ATAs, so the keeper can sweep claims on players' behalf with no
   authority, no key, and no ability to redirect a cent.** Say so in the run report — "47 rounds
   claimed for you, 3 pending" — and make it a keeper task alongside `close_round`.
4. **A per-session spend allowance.** *This is the one that matters and it is easy to miss.*

> Today a session key is harmless because there is nothing to spend. The moment custody ships, that
> same key — four fields, no spend cap, no instruction allowlist, valid for a whole day, and in model
> B sitting on our server — becomes a key that can drain the player's entire custodied balance
> through repeated `enter` calls. **Custody and a session-scoped spend allowance must ship in the
> same change, or the safety story inverts overnight.** Anything else means the safest version of
> this product is the one that exists before custody, which is an absurd place to end up.

Sequence, therefore: **1440-minute sessions → model A with budgets → custody *with* allowances →
model B.** Model B before custody is unpitchable; model B after custody without allowances is
dangerous.

**Two more things from §4 that the social layer must not contradict.** Both are about what our share
cards and our copy are allowed to say:

- *"Do not claim 'non-custodial' while an operator-selected validator can rewrite settlement."* The
  ER validator can rewrite a round's final state, and that state decides who gets paid. Nothing in
  §3's share cards or §4's copy may say "non-custodial" or imply the house cannot influence a result.
  "Provably fair" remains true and is narrower than people will read it as: the *seed* is verifiable,
  and 00-7 already says exactly that. Keep the share card's claim inside 00-7's claim.
- The open question §4 calls "the single largest unknown in the custody design": there is no known
  base-layer forced-undelegation path for a round whose ER validator is permanently down, which would
  freeze that round's escrow indefinitely. An unattended 24-hour run multiplies exposure to that by
  ~50. It is not ours to solve, but it is ours not to compound: **model B does not ship until that is
  answered.**

### 5.6 The two things that would need a program change

Named loudly and separately, as required. And with a cost attached that makes both worth batching
with anything else: per §4.3, a redeploy of an ER-delegated program means a **new program id** — ER
validators cache bytecode by id and do not invalidate on upgrade — which destroys every PDA keyed by
the old one. Four ids so far. There is no such thing as a small program change here.

1. **A spend allowance on the session token** (§5.5.4), or an equivalent per-delegate cap on the
   Arena. Required before model B is safe with custody, and required before any session longer than
   a day is defensible.
2. **A first-class delegate on `enter`** — an account a player authorises once, with its own budget
   and its own expiry, that a keeper could act under. This is model C. The program has no player-level
   delegate concept at all today: the only `authority` in it is the arena admin, which cannot enter
   on anyone's behalf.

Neither is needed for anything in §§1–4 or for model A.

### 5.7 What it does when it cannot pay

- **Fees (today).** The session key funds itself with 0.02 SOL and pays its own transaction fees.
  Over 24 hours that is comfortable, but it can run out. **The failure needs a name.** Right now it
  arrives as three failed attempts and `retries-exhausted` with a raw chain error, and the sentence a
  player reads must not be generic. *Request to the data layer owner:* either a distinct
  `AbandonReason` for an unfunded signer, or a check in the copy path — but the run must be able to
  say "the key that signs for you ran out of SOL", not "3 attempts failed".
- **Stake (with custody).** Balance below the round's stake → **stop the run.** Do not shrink the
  stake to fit. `resolveAmountUsd` already refuses to round its way down to a sendable figure and
  says why; the same principle, one level up. A rule that quietly deploys less than you told it to is
  the same lie as the $0.01 bug that function exists to prevent.
- **Round full.** `MAX_FIGHTERS = 48`, chain-enforced, and `enter` returns `RoundFull` rather than
  "too slow" precisely so the two can be told apart. A missed round for this reason is not a failure
  and should not read as one — it is a full lobby, and the honest line is "round 418 was full".

---

## 6. The interface contract

Four workstreams are building against this. These are the seams; agree them before writing code.

### 6.1 `contract.ts` — the shared vocabulary

```ts
/** A verified X identity, as every surface sees it. */
export interface Profile {
  /** X's numeric account id. THE durable key — handles are renameable and reusable. */
  xId: string;
  /** Current handle, no leading @. Display only; refreshed on a TTL. */
  handle: string;
  /** Same-origin, always: `/api/avatar/{xId}?s=48`. Never a third-party URL — see faces.ts. */
  avatar48: string;
  avatar192: string;
  linkedAtMs: number;
}

/** wallet(base58) → profile. Absent = unlinked, which is the ordinary state. */
export type ProfileMap = ReadonlyMap<string, Profile>;
```

`FighterView`, `RoundPlayer` and `StandingsRow` each gain `profile: Profile | null`.

### 6.2 The data layer

New: `data/profiles.ts` (pure, React-free, testable) and `data/useProfiles.ts` (the hook), plus
`data/xLink.ts` for the link/unlink flow.

**Do not name any of these `identity.ts`** — that name is taken by `ChainIdentity`, which is about
signing, and a second meaning on the same word in the same folder is how two workstreams end up
editing each other's file.

`data/profiles.ts` exports `withProfiles(live, map)`, and it must **mirror `data/linkFighters.ts`
exactly** — the surviving implementation of this exact pattern, `markLinkedFighters` for the array
and `withLinks` for the round — including the part that looks like a micro-optimisation and is not:

- Return the input array — and the input `LiveRound` — when nothing changed. `LiveRound` is rebuilt on
  every poll and every 250ms clock tick, and the canvas, the extract terms and the combat feed are all
  memoised against `live.fighters`. A fresh array with identical contents four times a second
  invalidates all three for nothing.
- **Do not add a client-side house check here.** This bullet used to say the opposite — "null the
  profile for any fighter with `house === true`, here, in this one function" — and it is called out
  rather than quietly deleted, because it is the instruction a future implementer is most likely to
  follow out of habit. `FighterView.house` no longer exists and neither does the list it was resolved
  from: the arena's own wallets are not published anywhere a browser can read (`KEEPER_STATUS_SCHEMA`
  5, which rejects an older file outright rather than ignoring the extra fields). A guard written
  against a flag that is always absent is not a weak guard — it is a branch that never fires, wearing
  the appearance of protection and carrying a green test beside it.

  **The invariant is unchanged: a face means a person, and the arena's own wallets may not wear one.**
  It is enforced on the server at both ends of a link's life — `/api/x/link` refuses to create such a
  link, `/api/links` refuses to serve one — which is where §2.7 always said the durable version lived.
  Both halves are now built and tested; §2.7's status paragraph has the detail that matters, which is
  that the write-path check runs *after* the wallet signature so that it cannot be used as a roster
  oracle.
  If a refusal ever needs a user-facing message, it must be **indistinguishable from the generic one**
  (`FAILURE_COPY.unavailable`); a message that names its reason is a membership oracle, and anyone
  could read the roster off it one wallet at a time. `data/linkFighters.ts`'s header carries the full
  argument at the place the guard used to be.

`ArenaContextValue` gains:

```ts
profiles: {
  map: ProfileMap;
  you: Profile | null;
  link(): Promise<void>;      // Privy OAuth, then signMessage, then POST /api/x/link
  unlink(): Promise<void>;
  busy: boolean;
  error: string | null;
};
```

### 6.3 The canvas boundary — do not break it

`SPEC.md`: the arena canvas **never touches data**. So `faces.ts` must not fetch, look up, or import a
profile. The avatar URL arrives **on the body**:

- `FighterView.profile` → threaded into `ArenaBody` by `field.ts` as `avatarSrc: string | null`.
- `faceFor(b)` becomes: `b.avatarSrc ?? SIDE_TOKEN[b.side].icon`, through the existing `lookup()`
  cache, with every one of that file's loading rules unchanged — one `Image` per src at module scope,
  `decode()` not `load`, the desaturated variant built once, `naturalWidth > 0` as the settle test.
- `primeFaces()` keeps priming the two coins only. Avatars prime on first paint; the coin is the
  fallback until they do, which is the correct rendering rather than a placeholder.
- `crossOrigin` stays unset, because these are now genuinely same-origin. Setting it would break the
  proxy for no gain and taint nothing either way.

### 6.4 Server (`er-demo/api/`)

New surface, new deployment concern, `vercel.json` gains a `functions` block and a CSP header. This is
the only part of this document that is not a change to an existing file, and it is the part that
gates everything else — **start it first.**

---

## 7. What we are NOT doing, and why

| Not doing | Why |
|---|---|
| Handle entry without OAuth (`prompt()`) | The old app's fallback wrote an unverified claim into the same record as a verified one. If OAuth fails there is no identity. |
| Storing or displaying the X **display name** | Unconstrained text is the impersonation vector; `@handle` is unique and free to enforce. |
| Posting on anyone's behalf | Intent links only. No write scope, no stored tokens, nothing to leak. |
| Reading the X follow graph to build "friends" | Elevated scope, real money, privacy liability, and it answers the wrong question. Friends = people you have fought. |
| Reaching unavatar/twimg from the browser | `faces.ts`'s same-origin rule stands. Everything goes through our proxy — which is also what keeps the canvas untainted for §3.1. |
| Accepting SVG avatars, or proxying an arbitrary URL | Script container; SSRF. The route takes our own id and re-encodes. |
| Putting handles or faces on chain | There is not a spare byte. `Round::SIZE` is asserted exactly and a native test fails on any added field; `Fighter` is 58 bytes of load-bearing state; the only two byte arrays are `seed_commit` and `seed`, both written by the program. Adding a field means a redeploy, and per §5.6 a redeploy means a new program id and the loss of every existing PDA — for a cosmetic. The mapping is off-chain and §2.6 says so out loud. |
| A `SIM` badge on a face | A marker cannot go on a face — `GAPS.md` was right. The disclosure is a sentence, in two places. |
| Avatars in the black chrome bars, or larger than 24px outside the inspector | The bars are the instrument frame. Size is the discipline that keeps colour honest. |
| Circular avatars in tables | `TokenIcon`'s rule. Round on the field, square on paper. |
| Auto-**extract** | It is the decision worth a human, and automating it ends the loop. A stop-loss is the honest version and is deliberately worse than being awake. |
| Badges, XP, levels, streaks, seasons, chat, emotes, reactions | Weeks that produce no posts, and they make this page look like every other product it is trying not to be. |
| A "biggest depositors" board | Advertises the number we cannot back. |
| Promising "days and days" | 24 hours, chain-enforced, with the clock on screen. §5.2. |
| Model B (server-held keys) before custody with allowances | Before custody it deploys paper; after custody without allowances it is a drainable key. §5.5. |
| Model C (program delegate) | A program change, for a ceiling nobody has hit yet. |

---

## 8. Build order

1. **`er-demo/api/`**: nonce, link, unlink, profiles, avatar proxy. CSP in `vercel.json`. Nothing else
   can start without it.
2. **`SESSION_VALID_MINUTES` 60 → 1440** in `src/chain/session/useSessionKeyManager.ts`. One line,
   different owner, gates all of §5.
3. **Identity end to end**: `Profile` in `contract.ts`, `data/profiles.ts` + `data/xLink.ts`, the
   wallet-panel control, `ui/Avatar.tsx`.
4. **Faces on the field** — one branch in `faceFor()`, plus `avatarSrc` through `field.ts`.
5. **Faces on paper**: 00-4, 00-5, 01, 04-1. Handles in 00-4.1 and the ticker.
6. **The round permalink + OG card** (v1, typographic) and the share control on the result plate.
7. **Auto-play model A**: budget, drawdown stop, wall-clock end time, `04-3`, the return card.
8. **The rivalry ledger**, `02-4`, and the card's "took most off you" line.

1–5 are one release and are the owner's headline ask. 6–8 are the loop, and the loop is what makes
5 worth having.
