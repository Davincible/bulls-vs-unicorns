# Deploying to Vercel

The app is a static Vite build with three HTML entries and no server. Nothing in it needs a runtime,
an env var, or a secret.

## Project settings (once, in the Vercel dashboard)

| Setting | Value | Why |
|---|---|---|
| **Root Directory** | `er-demo` | This is a monorepo — `programs/`, `engine/` and `web/` are siblings and none of them build here. |
| Framework preset | Vite | Detected; `vercel.json` states it anyway. |
| Build command | *(from `vercel.json`)* | `bun run build` = `tsc -b && vite build`. |
| Output directory | *(from `vercel.json`)* | `dist`. |

Everything else lives in `vercel.json`, so it is reviewable in a diff instead of in a web form.

## What ships

| URL | Page |
|---|---|
| `/` | the v2 arena — the front door |
| `/arena` | the same page, kept as an alias for links shared while it was being built |
| `/legacy` | the original React app, still building from `src/main.tsx` |

`cleanUrls` drops the `.html`, and Vercel 308-redirects the old paths to the new ones with the query
string intact — so a shared `/arena.html?theme=cyan&tint=70` still lands on the right page in the
right colour.

**No SPA rewrite, deliberately.** v2 has no client-side router: screens are `useState`, and every
deep link (`?theme=`, `?tint=`, `?fixture=`, `?round=`) is a query parameter. A catch-all rewrite to
`/index.html` would be the usual reflex here and it would break `/legacy` by serving v2 in its place.

## One thing to know about the build

**1. `tsc -b` is part of the build, so a type error fails the deploy.**
That is the right default — it stops a broken build reaching a URL. But this repo currently has
several sessions editing at once, and the tree is red for minutes at a time while a field is
propagated through the type chain. If a deploy is ever needed *right now* and the tree is mid-change,
the honest options are to wait, or to deploy a known-good commit — not to weaken the check.

## What is deliberately NOT deployed

- `scripts/` — operator tooling that opens rounds, funds burners and drives devnet verification. It
  talks to the chain and has no business on a build machine. Excluded in `.vercelignore`.
- `design/` — screenshot galleries.
- The repo-root `.devnet/` keypairs are gitignored **and** outside this project's root, so they are
  doubly out of reach. The two tracked config files (`engine/devnet*.json`) hold public addresses
  only; the one API key in them is a literal `REPLACE` placeholder.

## The pitch deck

`pitch/index.html` is at the repo ROOT, so with Root Directory set to `er-demo` it does not deploy.
If it should be reachable at `/pitch`, copy it into `er-demo/public/pitch/` — it is self-contained
(inline CSS/JS, local images, zero network requests) so it works unchanged from any path. Left out by
default rather than duplicated silently: two copies of a deck is two decks that disagree.

## This is a devnet build, and says so

`src/devnet-guard.ts` asserts every endpoint is devnet at module load, so the bundle cannot be
pointed at mainnet by configuration. Deploying it publicly is safe in that sense — the wallet is a
burner minted in the visitor's own browser, and no real funds are reachable. The intro takeover says
"Solana devnet" in as many words.
