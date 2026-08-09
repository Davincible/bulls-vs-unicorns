# Bulls ⚔ Unicorns ROUND KEEPER — the long-running process that makes rounds happen: opens them,
# delegates them to an ER validator, fields house fighters, draws, ticks, settles, brings them home.
# Host-agnostic image (Fly / Railway / a VPS); fly.toml beside this file is the Fly-shaped half.
#
# Build context = er-demo/, NOT the repo root — and that is the one real difference from
# engine/Dockerfile, which needs the root because it also ships web/. The keeper imports nothing
# outside this directory, so a root context would drag along programs/, engine/, web/ and design/
# for no reason, and would put the repo-root .devnet/ keypairs one careless COPY away from a layer.
#   cd er-demo && fly deploy
#
# Bun, not Node, because the keeper is TypeScript that is never compiled — see "no build step"
# below. Pinned to 1.3.13, the exact Bun this was developed and run against on devnet.
# REJECTED `oven/bun:1`: a floating major is a silent runtime upgrade that arrives on some unrelated
# redeploy, and the first symptom is a keeper behaving differently from the one that was tested.
# -slim because nothing at runtime needs a compiler, git, or a package manager.
FROM oven/bun:1.3.13-slim

WORKDIR /app

# ---------------------------------------------------------------------------------------------
# Dependencies first, so this layer survives every code change.
#
# bun.lock IS committed, deliberately breaking the repo-root convention — er-demo/.gitignore argues
# it at length: ~30 direct dependencies and a much larger transitive tree (web3.js, Anchor, the
# MagicBlock SDK, pixi), where one broken patch release produces a deploy that differs from the
# build that was tested with nothing in the diff to show it.
#
# --frozen-lockfile is what makes that argument *true here*: it FAILS the build if package.json and
# bun.lock have drifted, instead of quietly resolving a newer tree. A lockfile that the deploy is
# free to ignore is a lockfile that only documents good intentions.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# The honest number: node_modules is ~585MB installed, ~500MB with --production (which drops vite,
# vitest, typescript and oxlint — none of which the keeper runs). pixi.js is 79MB of it and the
# @solana/* + Anchor graph is 139MB, and both are genuine RUNTIME dependencies of the same
# package.json the browser app uses. This is a fat image and it is stated rather than apologised for.
#
# REJECTED: a second keeper-only package.json to trim it. Two manifests over one source tree is a
# drift you find out about in production, the day the keeper resolves a different @solana/web3.js
# than the app it is running rounds for. One manifest, one lockfile, one fat layer that caches.

# ---------------------------------------------------------------------------------------------
# Source. Whole subtrees, deliberately NOT a hand-picked file list.
#
# The keeper reaches well outside scripts/keeper/: src/chain/ for the client, IDL and constants,
# src/devnet-guard.ts for the mainnet assertion, src/v2/data/keeperStatus.ts for the status schema
# that both this process and the browser import. Together these are ~2.3MB of text — noise beside
# node_modules. A curated list would save nothing measurable and would rot into a "module not found"
# on a deploy six weeks from now, when somebody adds an import in a file they had no reason to think
# was packaged. The cheap thing here is also the correct thing.
#
# The *.test.ts files come along with it. Considered excluding them; rejected, because they are a
# few KB and dropping them would make the deployed source tree differ from the repo for no benefit —
# and "the image is the source" is worth more than a rounding error of disk.
COPY src/ ./src/
COPY scripts/ ./scripts/

# public/idl/bulls_arena.json is REQUIRED AT RUNTIME, and it is easy to miss because nothing imports
# it. src/chain/idl.ts has two load paths and picks by `typeof window`: the browser fetches
# /idl/bulls_arena.json, a Bun script reads <src/chain>/../../public/idl/bulls_arena.json off disk.
# Without this file the keeper does not degrade, it fails at boot — and under KEEPER_HOLD_OPEN=1 it
# fails EARLIER and on purpose, refusing to start unless the IDL can encode the authority account on
# close_lobby_and_draw.
#
# The REST of public/ is deliberately absent. It is browser assets (favicon.svg, icons.svg,
# tokens/), and public/keeper-status.json in particular is GENERATED — this process writes it, and
# its absence is meaningful: the front end reads a 404 as "no keeper is running here". Baking a copy
# into the image would ship a permanently stale heartbeat that reads as a live keeper.
COPY public/idl/ ./public/idl/

# ---------------------------------------------------------------------------------------------
# NO BUILD STEP, on purpose. Bun executes TypeScript directly, so there is no tsc/vite output in
# this image and therefore nothing that can drift from the source beside it. Type-checking is a
# local/CI gate, not a deploy-time one:  bunx tsc -p tsconfig.scripts.json --noEmit
# (er-demo/DEPLOY.md notes the browser build does gate on `tsc -b`; that is the Vercel path, and it
# is a different artifact with different failure consequences.)

# ---------------------------------------------------------------------------------------------
# Runtime user. The keeper writes public/keeper-status.json atomically — temp file in the same
# directory, then rename — so /app/public must be writable by whoever the process runs as. The
# chown below is therefore load-bearing, not hygiene theatre: drop it and the keeper boots, runs a
# round, and fails only when it tries to publish its first heartbeat.
# Non-root matters more than usual here because this process holds the arena authority key in its
# environment. The `bun` user ships with the base image.
RUN mkdir -p /app/public && chown -R bun:bun /app/public
USER bun

# ---------------------------------------------------------------------------------------------
# Defaults only. fly.toml's [env] repeats these with the argument for each value; this block exists
# so `docker run` behaves identically without one. Key material is NOT here — see below.
ENV KEEPER_HTTP_PORT=8080
ENV KEEPER_BASE_RPC=https://api.devnet.solana.com
ENV KEEPER_ROUTER_URL=https://devnet-router.magicblock.app

# Off in the image, ON in fly.toml. Not a contradiction: --hold-open needs the authority-signed
# early close in close_lobby_and_draw to be DEPLOYED, and no process can determine that (the IDL is
# generated from source, so a capability probe would only prove somebody edited Rust). The operator
# turns it on for an environment they know; the image ships the assumption-free default.
ENV KEEPER_HOLD_OPEN=0

# Both URL vars above are run through assertDevnetUrl at boot, on every endpoint including the ER
# validator's fqdn. A mainnet URL arriving via `fly secrets` fails the process loudly instead of
# connecting — env indirection is not allowed to become the hole in the mainnet guard.
# They are overridable because api.devnet.solana.com rate-limits: 429s were observed with one
# browser plus one sampler, so a paid Helius/QuickNode/Triton *devnet* endpoint drops in with no
# code change. An endpoint that carries an API key belongs in `fly secrets`, not in [env] or here.

# ---------------------------------------------------------------------------------------------
# SECRETS ARE NEVER IN THIS IMAGE. Both are read from the environment at boot, and both fall back to
# a gitignored local path when unset so a laptop run still works unchanged:
#
#   KEEPER_OPERATOR_KEY    the arena authority secret key — a JSON array of 64 numbers, the same
#                          content as .devnet/fork-payer.json. open_round and delegate_round are
#                          both has_one = authority; the keeper refuses to start if this key is not
#                          the arena's authority.
#   KEEPER_HOUSE_WALLETS   the six house-fighter keys — the verbatim contents of
#                          .devnet/keeper-house-wallets.json, shape
#                          {"note": "...", "secretKeys": [[...], ...]}
#
# Env beats file, and which source won is logged at boot; the key material never is.
#
#   fly secrets set KEEPER_OPERATOR_KEY="$(cat ../.devnet/fork-payer.json)"
#   fly secrets set KEEPER_HOUSE_WALLETS="$(cat ../.devnet/keeper-house-wallets.json)"
#
# .devnet/ is gitignored, AND outside this build context, AND listed in .dockerignore — three
# independent reasons a key cannot end up in a layer. Any one of them alone is a reason someone
# later removes it.

EXPOSE 8080

# /health — and note this is the OPPOSITE endpoint from engine/Dockerfile, which checks /live and
# deliberately NOT /health. There, /health returns 503 during a solvency freeze, so a platform check
# pointed at it would restart-loop the engine through a money incident. Here /health is the safe one
# BY CONSTRUCTION: it makes no chain calls and returns 200 with a tiny JSON body for as long as the
# process is answering, precisely so a devnet RPC blip cannot get a healthy keeper killed.
#
# Which means this check answers "is the process alive", and nothing more. The real "is it working"
# signal is keeper.heartbeatAt / keeper.stalledSince in the status file, which the front end already
# reads — and a stalled keeper is one that is catching, backing off and retrying, which a restart
# does not fix because it is devnet that is unwell, not the process.
#
# start-period covers boot, and is deliberately generous for the same reason as fly.toml's
# grace_period: the server comes up before the slow half of boot, but picking an ER validator
# (a ~360KB account per route, plus a write probe each) and funding the house bank (a confirmed
# base-layer transaction) still precede the loop's first pass. This check cannot fail for anything a
# restart would fix, so waiting longer costs nothing and cutting it short kills a healthy keeper.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.KEEPER_HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No --hold-open flag on the command line: the policy is KEEPER_HOLD_OPEN, which argv and env say
# equally well to the keeper, but only one of which a deployment can change with a restart instead
# of a rebuild.
CMD ["bun", "run", "scripts/keeper/keeper.ts"]
