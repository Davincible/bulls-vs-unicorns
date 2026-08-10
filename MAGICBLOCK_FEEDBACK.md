# Feedback for MagicBlock

A running log, kept as we build against MagicBlock's stack. Each entry says what we found, what
it cost us, and points at the exact code in this repo that reproduces it — not vibes, not "the
docs could be nicer somewhere." Intended to be handed to MagicBlock as-is or trimmed down for a
Discord post / GitHub issue when the list is worth sending.

Format: dated entries, newest first. Each entry tagged **[GAP]** (missing/inaccurate
documentation or capability), **[BUG]**, or **[FEATURE REQUEST]**.

---

## 2026-08-10 — A delegated account reads as VALID and WRONG from the base layer, with no error

**[GAP — and the responsibility is split, so read the mechanism before assigning it]** While an
account is delegated to an ER, the base-layer copy still decodes cleanly under the owning program's
own IDL and returns **stale field values**. Not an error, not a rejection, not a discriminator
mismatch — a successful `fetch()` returning numbers that are simply not true.

Full matrix, measured against our live devnet arena with one `anchor.Program` pointed at each
endpoint in turn:

```
                              base layer            router / ER           agree?
ARENA      (never delegated)  roundCounter 29       roundCounter 29        yes
ROUND #29  (delegated, open)  pot 0                 pot 28,710,000         NO
ROUND #28  (settled, undel.)  pot 57,420,000        pot 57,420,000         yes
```

So the divergence is exactly and only the delegation window, and the base layer **does** catch up
once state is committed back. That is coherent behaviour, not corruption. The problem is that
nothing tells you which of the three rows you are standing in.

**The mechanism, verified rather than assumed — and half of it is Anchor's, not MagicBlock's.**
Anchor 0.32.1's `AccountClient.fetch` validates the **discriminator only**. There is no owner check
anywhere in `program/namespace/account.js` (`grep -c owner` returns 0), and its own doc comments say
so: *"Accounts not found or with wrong discriminator are returned as null."* The delegated account
keeps its discriminator and its length (1,102 bytes either way), so it decodes. The one field that
would have given the game away — `owner`, which reads `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
on the base layer and the program id through the router — is fetched and then ignored by the client.
On-chain `Account<'info, T>` *does* enforce owner; the client-side helper does not, and that
asymmetry is where this lives.

So this is not "MagicBlock returns bad data." It is that delegation produces an account which is
**indistinguishable from a healthy one** through the most ordinary read path in the ecosystem, and
neither library closes the gap.

**What it costs someone who does not catch it.** Any dashboard, indexer, analytics job, Solscan
glance or settlement check reading through a normal RPC during a fight reports a pot of zero and no
fighters. `pot: 0` on an open lobby is a completely plausible number, so nothing looks wrong. We
found it only because we were auditing who was seated in a round and house wallets we *knew* were in
it did not appear in the base-layer bytes. Anyone reconciling balances off base-layer reads books
wrong figures for the whole delegation — which under our hold-open policy is essentially always.

**The workaround, for anyone who finds this before MagicBlock fixes it.** Two lines, and it is
reliable because it keys on the one field that is always truthful:

```ts
const info = await baseConn.getAccountInfo(pda);
const delegated = info?.owner.equals(DELEGATION_PROGRAM_ID);  // DELeGGvXpW…
// if delegated, read through the router instead — it is correct in ALL THREE rows above
```

Reading everything through `devnet-router.magicblock.app` is also safe blanket advice: it returned
correct values for the never-delegated, delegated and undelegated cases alike. We could find nothing
saying so, and it is the single most useful sentence that could be added to the delegation docs.

**Suggested fix, cheapest first.** (1) Document it — "while delegated, base-layer account reads are
frozen at delegation time; route reads through the router, which is correct in every case" belongs
in the delegation quickstart rather than in tribal knowledge. (2) Better: have the Delegation Program
poison the discriminator while it holds the account, so a naive decode *fails loudly* instead of
succeeding wrongly. A thrown error is a far better outcome than a plausible lie, and it costs one
byte. (3) Best: a documented `getAccountInfoAuthoritative(pubkey)` on `ConnectionMagicRouter` that
routes per account the way transactions already do, so the correct thing is also the easy thing.

Reproduces in ~15 lines: point one `anchor.Program` at a normal RPC and one at the router, fetch the
same delegated PDA, compare.

---

## 2026-08-10 — How long may an account stay delegated? Nothing says, and we are now betting on it

**[GAP]** We could not find any statement of the maximum — or expected safe — duration for which an
account may remain continuously delegated to an ER, nor what happens if a validator restarts,
evicts, or is drained while holding one.

This is not academic for us. Our arena burns ~0.0098 SOL per idle round cycle, ~95% of it
unreclaimable round-PDA rent, so cycling an empty lobby on a timer is the dominant cost of running
the thing. The fix is to open ONE lobby and hold it — delegated — until a real player arrives. That
took idle burn from ~0.32 SOL/hour to ~0.0098 SOL/hour, a ~33x reduction, and it is only sound if a
long-lived delegation is safe.

Having no documented answer, we measured one: **3,600 seconds of continuous delegation, 24 clean
probes, no drift or eviction observed.** We then set the backstop to the chain maximum our own
program allows — **7 days** — which is now running in production, on the strength of an extrapolation
from a one-hour experiment. That is not a comfortable place to be, and it is entirely because the
question is unanswered rather than because the answer is bad.

**Why it matters beyond our cost model:** an account cannot be closed while the Delegation Program
owns it, so rent is unreclaimable for the whole delegation. If a validator dies mid-delegation, the
undelegation path is unavailable and that account's rent is stranded until something re-establishes
or force-undelegates it. A stated guarantee ("an account may remain delegated indefinitely; on
validator restart, delegations are recovered by X") or a stated limit ("delegations are evicted
after N") would let integrators size this deliberately. Right now the only honest way to choose is to
run the experiment yourself, and the experiment takes as long as the duration you want to trust.

**[FEATURE REQUEST]** Document the delegation lifetime guarantee and the validator-restart
behaviour, and expose a way to enumerate or query the delegations a validator currently holds so an
operator can detect a stranded one without inferring it from their own bookkeeping.

---

## 2026-08-10 — Making sessions the DEFAULT signing path: four things `useSessionKeyManager` will not tell you

Context for all four: we stopped treating a session key as a feature a player opts into and made it
how the app signs — the first deploy or extract opens one, everything for the next hour signs
silently, and an expired one is replaced without the player being told to go and do it. That is,
presumably, the use case the hook exists for. Every one of these cost us a design decision, and
three of them are only answerable by reading the compiled `lib/index.js`, since no source ships.

**[BUG] `createSession` never rejects.** Its whole body is wrapped in `try { … } catch (error) {
console.error(…); setError(error); return { …, sessionToken: null, error: error.message } }`. So
`await createSession(...)` resolves normally when the user cancelled the Phantom popup, when the
wallet is unfunded, when the RPC drops it. A caller cannot `try/catch` the one call in the SDK most
likely to fail, and cannot tell "opened" from "cancelled" without inspecting state that arrives on a
later render. We now infer failure from "no session appeared" and dig the reason back out of the
`error` channel — which is a lot of machinery to reconstruct a rejected promise.

**[GAP] `createSession` returns the new session object, and nothing says so.** The success path
returns `{ sessionToken, publicKey, signTransaction, … }` — exactly what a caller needs in order to
sign *the transaction they were in the middle of* — but the documented shape of the hook is its
state, so the obvious integration awaits the call and then reads `sessionToken` off the hook. That
value does not exist until React re-renders, and React 18 batches updates made inside a promise, so
the continuation after `await createSession()` runs **before** the render it caused. The result is
that "open a session and then use it in the same click" — the single most natural thing to build —
silently signs with the wallet instead, popping a second dialog. Documenting the return value would
remove the entire problem.

**[BUG] `createSession` cannot replace an existing session, and fails opaquely when asked to.** It
generates a keypair only when it has none (`if (!keypairRef.current) generateKeypair()`), and the
session token PDA is derived from that keypair — so a second call from a browser that already holds a
session targets an account that already exists and fails with a bare `custom program error: 0x0`.
Verified on devnet against our deployed program, not inferred:
`er-demo/scripts/verify-session-renewal.mjs` creates, re-creates (fails), revokes, and re-creates
(succeeds) with the same signer. This is the ordinary end of a session's life — an hour passes and
the next action must work — and the correct sequence, `revokeSession()` then `createSession()`, is
documented nowhere and costs the player **two** wallet approvals instead of one. A `renewSession`, or
simply resetting the keypair when the stored session has expired, would make renewal invisible.

**[GAP] `isLoading` conflates "asking the user to approve a session" with "silently signing one
transaction".** `withLoading` wraps `createSession`, `revokeSession`, `signTransaction`,
`sendTransaction` and `signAndSendTransaction` alike. A UI that says "approve the session in your
wallet" off `isLoading` says it during every session-signed transaction — dozens an hour, none of
which involve the user at all. We had to track the create/revoke phase ourselves to get a signal that
means what the UI needs it to mean.

---

## 2026-08-09 — Third consecutive session, third abandoned program id — and a first look at what a FRESH id does

Nothing new about the cause; this is a **frequency and cost** data point on the entry below, plus one
genuinely new observation.

Adding a mid-fight extract penalty to `programs/bulls-arena`, we upgraded v3 in place on the base
layer (`3u7AtnMkqEF6dEHQBtQpuQ3zHdpZxNhwmMtmpJxCoRtdTa68KBpfQFUBuFNg4cr2wYLnJmrmrxHmVTUbDz1Xo6cM`;
316,752 B -> 323,360 B, comfortably inside the account's existing `max_len` of 350,000). The byte
comparison the entry below recommends was run immediately afterward:

```
devnet-eu   STALE      devnet-tee  STALE
devnet-as   STALE      devnet-us   STALE
```

All four. **That is three consecutive sessions in which a correct, confirmed base-layer upgrade could
only be made executable by abandoning the program id** — v2, v3, and now v4
(`CchN3JPWta2uVxKhwScBQhtPG5gpsaRzf3RA4aPCDam2`). The direct cost each time is the ProgramData
rent on the new id (**2.437 SOL** at `--max-len 350000`) plus every PDA keyed by the old id: the
Arena and every round number restart from scratch, so no round history survives a bug fix.

**[NEW OBSERVATION] A fresh program id is served correctly by all four validators immediately — no
first-use delay.** Probing the four routes seconds after the v4 deploy, every one reported
byte-identical to the local artifact. So the clone path itself is fast and correct; the problem is
strictly **invalidation**, never population. That is consistent with the `Program`-vs-`ProgramData`
account diagnosis below and, we think, narrows it: whatever populates the cache is evidently able to
read current bytecode on demand, so a cache that simply re-checked `ProgramData` (or exposed a
"refresh this program" RPC) would close the gap without new machinery.

**[FEATURE REQUEST, restated with a price attached]** Either invalidate on `ProgramData` writes, or
expose an authenticated "drop your clone of program X" call to the program's own upgrade authority.
As it stands, the documented workaround for shipping a fix to an ER-delegated program is *deploy a
different program*, which costs 2.4 SOL and all of the program's state, every time.

The one thing that keeps getting cheaper is the diagnosis: the preflight now lives in
`er-demo/scripts/erValidator.ts` (`pickValidator`), shared by every verification script, and it named
the problem in about one second instead of costing a spent round and a confusing error.

---

## 2026-08-09 — Detecting a stale ER bytecode clone: the size check is unreliable, and comparing bytes works

Follow-up to the bytecode-cache entry below, from a third upgrade of the same program. Three things
are new: a **correction to our own recommended diagnostic**, a worse data point, and a router RPC we
didn't know existed.

**[CORRECTION — ours, not MagicBlock's] Comparing executable account SIZES does not reliably detect a
stale clone.** The entry below says we caught staleness "by comparing executable account *sizes*."
That worked by luck. A `LoaderV4`-owned clone is a **48-byte header plus the program data account's
entire allocation** — i.e. its length tracks the deploy's `--max-len`, **not** the ELF inside it. Two
completely different builds deployed under the same `max_len` measure byte-for-byte identical in
length. What our size check actually detected was a clone frozen at a `max_len` the base layer had
since grown past, which only happened because that particular upgrade extended the account.

Measured on v3, deployed with `--max-len 350000` against a 316,752-byte `.so`:

```
base ProgramData   len = 350,045   (max_len = len - 45 = 350,000)
ER LoaderV4 clone  len = 350,048   (         len - 48 = 350,000)
```

Both resolve to the same `max_len`, and neither is the 316,752 bytes of actual program.

**What does work, deterministically:** read the clone and compare its bytes against the local
artifact.

```ts
const acct = await new Connection(erFqdn).getAccountInfo(PROGRAM_ID);
const cloned = acct.data.subarray(48, 48 + localElf.length);   // 48 = LoaderV4 header
const current = Buffer.from(cloned).equals(Buffer.from(localElf));
```

That is one RPC call, costs nothing, and answers the question before a lamport is spent. It is
implemented as a preflight in `er-demo/scripts/verify-stepped-fight.ts` (`pickValidator`), which now
prints per-validator `CURRENT — byte-identical to the local build` / `STALE`. This is a workaround for
the missing RPC surface requested below, not a substitute for it — it only works if you happen to
have the exact `.so` that was deployed.

**Worse data point.** After upgrading v2 in place, **all four** validators the router advertises were
serving the previous build — including `devnet-tee`, which the entry below recorded as having the
current build. Re-probed ten minutes later: unchanged. Burning the program id was again the only
recovery, so we deployed **v3** (`8s3x42af7gcNXDCTNheDtteQxeBS2D1p9xuU8C5Jgfrt`). That is now **two
consecutive sessions** where a correct base-layer upgrade could only be made executable by abandoning
the program id — which also abandons its PDAs, so every account keyed by that id (for us: the Arena
and every round number) restarts from scratch. The cost of this compounds; it isn't a one-time tax.

**[GAP] The router exposes `getRoutes`, and we found it by guessing.** Not in the docs we could find,
and not surfaced by `ConnectionMagicRouter`'s API:

```
POST https://devnet-router.magicblock.app  {"method": "getRoutes", "params": []}
-> [{ identity, fqdn, baseFee, blockTimeMs, countryCode }, ...]
```

This is the only way we found to *enumerate* validators — which matters precisely for the problem
above, where you need to check every validator before concluding your program id is unusable. Our
scripts had been carrying a hardcoded list of three endpoints; `getRoutes` returned four. Worth
documenting, and worth having `ConnectionMagicRouter` expose as a typed method.

**Not a complaint, worth recording as measured fact:** `getRoutes` reports `blockTimeMs: 50` for all
four devnet validators, not the 10ms that headline material tends to cite. Separately, a confirmed
write through the Magic Router — our `tick()` instruction, 24 of them across four rounds — measured
**~780–880ms wall-clock, client-observed**. That figure is *not* block time and shouldn't be read as
one: it includes a `getBlockhashForAccounts` round trip to the router, the send, and
`confirmTransaction`'s own polling granularity. But it is the number a real-time client actually
designs against, and it is ~16x the advertised block time. We'd have saved a design iteration if the
docs stated the expected end-to-end confirmed-write latency alongside block time — we sized a
client-side fight ticker at "one second of game state per call", which fell permanently behind at that
round-trip and had to be re-sized to catch up (`er-demo/src/chain/useFightTicker.ts`).

---

## 2026-08-09 — `session-keys` macros break silently on anchor-lang 1.1.x (no compile error)

**[BUG]** `session-keys` 3.1.1's `Cargo.toml` declares `anchor-lang = { version = ">=0.28, <2.0" }`
— a deliberately wide range (documented in the entry below as good design, and it *is* good for
avoiding a forked dependency graph). But the combination of `#[derive(Accounts, Session)]` and
`#[session(signer = ..., authority = ...)]` **does not work under anchor-lang 1.1.x**, and fails in
the worst possible way: it compiles cleanly, `cargo expand` shows no obviously wrong output, and the
breakage only appears at runtime, on-chain, as:

```
AnchorError caused by account: player. Error Code: AccountNotSigner
```

...on a field declared `UncheckedAccount<'info>` — an account type that, by definition, is never
checked for a signature. Reading the expanded macro output line by line, we could not find a code
path that produces that error for that field.

Cause appears to be anchor's own 1.1.1 change, from its `CHANGELOG.md`: *"lang: Migrate anchor-syn
from syn 1.x to syn 2.0"* — i.e. the whole attribute/constraint parser was replaced, and
`session-keys`' macros evidently depend on 1.x parsing behavior.

**How this bit us:** our program declared `anchor-lang = "1.0.2"`, which is Cargo's *caret* range
(`^1.0.2`) and therefore silently resolved to 1.1.2. Everything else in our repo — every
`Anchor.toml`'s `anchor_version`, our installed `anchor-cli`, and our earlier working spike — was
1.0.2. So the drift was invisible until a session-signed instruction hit real devnet and was
rejected. Our fix: pin exactly, `anchor-lang = "=1.0.2"`.

**[FEATURE REQUEST]** Either narrow `session-keys`' own `anchor-lang` range to versions it actually
works with (`>=0.28, <1.1`), or fix the macros for syn 2.0 / anchor 1.1+. As it stands the declared
range advertises support for versions where the library's primary feature silently doesn't work,
and the resulting error message points at the wrong thing entirely. A `compile_error!` on an
unsupported anchor version would have saved the entire debugging cycle.

---

## 2026-08-09 — Ephemeral validators don't re-clone a program's bytecode after a base-layer upgrade

Context: fixing a compute-budget bug in our program (`programs/bulls-arena`), we upgraded the
deployed program (base-layer `anchor upgrade`, standard `BPFLoaderUpgradeable` flow) and confirmed
the new bytecode on the base layer before testing. `resolve()` on a *fresh* round, delegated and
run through the default router-selected ER validator (`devnet-as.magicblock.app`), still failed with
the exact pre-fix error — three-plus minutes after the base-layer upgrade had already confirmed.

**[BUG or GAP, unclear which without visibility into the validator's own code]** The ER validator
appears to clone a program's executable bytecode into its own local (`LoaderV4`-owned, from the
account it creates) copy on first use, and does not re-clone it when the base-layer program is
upgraded. A `BPFLoaderUpgradeable` program's own `Program` account never changes on upgrade — only
its separate `ProgramData` account does — so if the validator's cache invalidation subscribes to (or
diffs) the `Program` account rather than `ProgramData`, it would structurally never observe an
upgrade. We didn't have visibility into the validator's actual cache-invalidation logic to confirm
which; this is diagnosis from external behavior (`simulateTransaction` against the ER endpoint
directly, reading `unitsConsumed`/logs), not a source read.

**Cost to us:** a confusing ~15 minutes where a verified, redeployed fix appeared to still be broken
on-chain, before realizing the *base layer* had the fix and the *ER validator* didn't.

**Workaround found:** `delegate_round`'s `DelegateConfig.validator` (passed via
`remaining_accounts[0]`) can pin a specific ER validator instead of accepting the router's default.
Pinning a different validator (`devnet-us.magicblock.app`) on a fresh round got a clean clone of the
current bytecode immediately. Regression-verified for real this way — see `MEGA_QUEUE.md`'s task #15
entry for the full signature trail.

**[FEATURE REQUEST]** Either invalidate the ER-side bytecode cache on a `ProgramData` write (not just
the `Program` account), or document the actual cache lifetime/invalidation trigger explicitly so a
developer redeploying mid-session knows to expect (and how to force past) stale bytecode on
already-warm validators, rather than discovering it by accident.

**UPDATE, same day, and it's worse than the above.** After a second upgrade, **three of four** public
devnet ER validators (`devnet-eu`, `devnet-as`, `devnet-us`) were serving the pre-upgrade build; the
fourth (`devnet-tee`) had the current one but 401-gates writes. So the workaround above — "pin a
different validator" — had no unstale, writable validator left to pin. A 25-minute watcher never saw
a refresh. This currently blocks any on-ER verification of a freshly-upgraded program.

**The detail that makes this actively misleading, not merely inconvenient:** on a stale validator,
the `programdata` account reads as **current** while the executable (LoaderV4-owned) account is still
the **old build**. The obvious way to check "did my upgrade propagate?" — inspect programdata — says
yes while the validator continues executing the old bytecode. We only caught it by comparing executable
account *sizes* and by the old code's own error surfacing (`AccountNotSigner` from a `player: Signer`
field that no longer exists in the current source). Anyone trusting programdata would conclude their
upgrade landed and then debug a phantom bug in their new code.

**Suggested minimum:** expose the executing bytecode's hash/length over RPC so a client can detect
staleness deterministically, instead of inferring it from account sizes and error-message archaeology.

**What actually unblocked us: burning the program id.** The cache is keyed by program id, so a freshly
generated id has no poisoned clone on any validator and the first delegation pulls current bytecode.
We deployed v2 at `4uqVSyHtx7CBaXUL2qy7cN4eV3MzqmvucapGHN1imFYm` and the end-to-end flow that had been
blocked for hours — session-signed `enter`, VRF draw, session-signed `extract` in Fight phase — worked
on the first attempt. That this is the *only* self-service recovery available is itself the strongest
argument for the RPC surface suggested above: a developer whose upgrade lands correctly on the base
layer currently has no supported way to make an already-warm validator run it.

---

## 2026-08-09 — Two smaller `gum-react-sdk` / `session-keys` notes

**[BUG] `useSessionKeyManager`'s `.d.ts` mistypes its third parameter.** It's named `validUntil` and
typed as though it were an absolute timestamp. Reading the compiled hook, it is actually **minutes
from now**: `expiryTimestamp = Math.ceil((Date.now() + expiryInMinutes * 60 * 1000) / 1000)`, capped
at `24 * 60` (it throws "Expiry cannot be more than 24 hours" above that). Passing a real Unix
timestamp — the obvious reading of the name and type — throws. Since no source ships (see the entry
below), the `.d.ts` is the only spec a consumer has, and it's wrong.

**[BUG] `useSessionKeyManager`'s `error` is typed `string | null` but returns an OBJECT.** On a failed
`create_session` it surfaces the raw `SendTransactionError` (`{signature, transactionMessage,
transactionLogs, programErrorStack}`). Any consumer that trusts the type and renders it — which in
React is the obvious thing to do, `<p>{error}</p>` — throws *"Objects are not valid as a React child"*
and **white-screens the entire app**. A hook whose whole purpose is smoothing UX shouldn't be able to
take the page down through its documented error channel. Found by clicking the button in a browser;
the `.d.ts` says the opposite and TypeScript therefore can't catch it. We now normalise it at the
boundary before it reaches any component.

**[GAP] `SessionError::InvalidToken` is error code 6001** — which, for any Anchor program whose own
second error variant is also 6001, collides on the wire. Ours is `ArenaError::RoundOutOfOrder`; both
render as `0x1771`. A decoder using *our* IDL confidently reports a session-auth rejection as
"rounds must open in sequence." Not MagicBlock's bug exactly — it's inherent to Anchor's per-program
error numbering — but it's a sharp edge specific to a library whose errors surface inside *someone
else's* program, and worth a line in the docs. We now assert on the `Error Code: <name>` log line
rather than the numeric code.

---

## 2026-08-09 — Phase 0 spike: Session Keys + Ephemeral Rollup delegation

Context: we spent a session verifying whether MagicBlock's Session Keys mechanism
(`github.com/magicblock-labs/session-keys`) works when the account it's authorizing action on is
already delegated to an Ephemeral Rollup. It does — we proved it end-to-end on devnet, twice, plus
a negative control confirming the auth check is real. Full details:
`programs/bulls-arena-session-spike/`, `er-demo/scripts/spike-session-er.mjs`.

Along the way:

**[GAP] No example anywhere combines Session Keys with ER delegation.** We searched
`docs.magicblock.gg`, the `session-keys` repo's own examples, and `magicblock-engine-examples`
(the canonical Anchor Counter / Bolt Counter delegate/undelegate examples). None of them touch a
delegated account with a session-signed instruction. This is a natural, high-value combination —
Session Keys exists specifically to remove wallet-popup friction from frequent actions, and
frequent actions are exactly what people put on an ER in the first place (that's the whole reason
to pay for 10ms blocks). We had to build a throwaway program and run it against real devnet to find
out this works at all. A documented example (even a minimal Anchor counter, delegated, incremented
by a session key) would save every future integrator this exact spike.

**[GAP] `@magicblock-labs/gum-sdk`'s `SDK` class does not expose session creation, despite being
the package name implies is "the SDK."** `gum-sdk`'s `SDK` class
(`node_modules/@magicblock-labs/gum-sdk/src/index.ts`) is a thin AnchorProvider wrapper with no
`createSession`/`revokeSession` methods at all. The actual instruction-building logic
(`create_session` / `create_session_v2` CPI calls against the deployed `gpl_session` program) lives
entirely inside `gum-react-sdk`'s compiled `useSessionKeyManager` **React hook** — which also
bundles browser-only persistence (IndexedDB, `crypto-js` AES encryption of the session keypair in
`localStorage`-adjacent storage) directly into the same function that builds the transaction. There
is no way to create a session server-side, in a bot, in a CLI, or in a test harness through the
published API surface — we had to decompile `gum-react-sdk`'s bundled `lib/index.js` to find the
real logic and reimplement it directly against `@coral-xyz/anchor` and the `gpl_session` IDL
(`node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json`, program id
`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`, same address on every cluster).

**[FEATURE REQUEST] Move session create/revoke instruction-building into `gum-sdk` (framework-
agnostic), and have `gum-react-sdk`'s hook call *that* for the transaction-building part, keeping
only the React-specific bits (state, IndexedDB persistence) in the hook.** This is a small refactor
on MagicBlock's side with a large payoff: anyone doing headless testing, server-authoritative flows,
bots, or non-React frontends currently has to reverse-engineer a minified bundle to use Session Keys
at all.

**[GAP] `gum-react-sdk` ships only compiled output, no source.** The npm package contains
`lib/index.js` + `lib/index.d.ts` and nothing else — no `src/`, no sourcemap. Verifying actual
behavior (which is what led to the finding above) required reading de-minified bundled JS instead
of readable TypeScript. Shipping `src/` (even without publishing it to the package, just in the
GitHub repo in a state that matches the published version) would have saved real time.

**Not a complaint, worth recording as confirmed fact:** `session-keys` crate's own
`Cargo.toml` pins `anchor-lang = { version = ">=0.28, <2.0" }` deliberately wide, specifically so it
resolves to whatever the consumer's workspace already pinned rather than forking the dependency
graph. This worked exactly as documented — our workspace (anchor-lang 1.0.2) and `session-keys`
3.1.1 resolved to a single shared `anchor-lang` entry in `Cargo.lock`, no duplicate. Good design,
noting it so we don't re-litigate it later.

**Not a complaint, minor DX note:** without `features = ["no-entrypoint"]` on the `session-keys`
dependency, the build fails with `the #[global_allocator] in this crate conflicts with global
allocator in: session_keys` — an accurate but slightly confusing error for what's actually a missing
Cargo feature flag. The docs' own installation snippet *does* include the flag; the error message
just doesn't point back at it, so anyone who skims past the Cargo.toml snippet (as we initially did,
working from a plan doc that had dropped the feature flag when transcribing the version string) gets
a generic Rust linker-shaped error instead of "you're missing `no-entrypoint`."
