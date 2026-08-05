# Deploy the devnet test online — the do-almost-nothing guide

You need 3 free accounts (all "Sign in with GitHub"). ~10 minutes of clicking.
I've made every config; you just connect + click Deploy.

## 0. One-time: put the code on GitHub
- Make a free **GitHub** account if you don't have one.
- Create a new **empty repo** (e.g. `bulls-arena`), private is fine.
- Upload this `bulls-arena/` folder to it (GitHub web: "uploading an existing file" → drag the folder),
  **or** tell me and I'll give you the two `git` commands to paste.

## 1. Engine → Railway (the live game server)
1. Go to **railway.app** → "Sign in with GitHub".
2. **New Project → Deploy from GitHub repo →** pick `bulls-arena`.
3. Settings → **Root Directory** = `engine`.  (Start command auto-detects `npm start`.)
4. It builds & gives you a public URL like `bulls-arena-production.up.railway.app`.
   Your WebSocket URL is that with `wss://` in front:
   **`wss://bulls-arena-production.up.railway.app`** ← copy this.

## 2. Frontend → Netlify (or Vercel)
**Netlify (you've used it):** drag the `web/` folder onto **app.netlify.com/drop**. Done — you get a URL.
**Vercel:** New Project → import the repo → Root Directory = `web` → Deploy.

## 3. Point the frontend at the engine (one line)
Open your live frontend URL and add the engine URL as a query param, e.g.:
`https://your-site.netlify.app/?engine=wss://bulls-arena-production.up.railway.app`
(That's the shareable link. Or tell me the Railway URL and I'll bake it into the file so no param is needed.)

## 4. Play on devnet
- Open the link, click **Connect Phantom** (set Phantom to **Devnet** in its settings).
- You'll see both modes running live with bots. Deploy to a side.
- (Real BULL/UWU deposits activate once the vault program is deployed to devnet — that's the
  next step I do; it needs the Anchor toolchain, which is what WSL is for.)

## What I still do (no action from you)
- Finish the Anchor toolchain (WSL) → compile & **deploy the vault to devnet** (free).
- Mint devnet test BULL/UWU, wire real deposit/withdraw into the client.
- Port the full canvas battle animation into the client (server-authoritative replay).

## Costs
- Railway free tier, Netlify/Vercel free tier, Solana **devnet = free**. $0 to test.
- Mainnet later: ~2–5 SOL one-time for the program + a house-liquidity float.
