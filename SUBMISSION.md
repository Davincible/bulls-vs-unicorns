Bulls vs Unicorns is a memecoin PVP game to bring engagement back to the trenches. Memecoins battle
in 1 minute rounds.

The project's combat system is built on MagicBlock's Ephemeral Rollups and VRF. Each round is
delegated to a rollup for its whole lifespan, the fight runs there, then it's committed and
undelegated back to Solana at settlement. The seed comes from VRF and is drawn after the lobby
closes, so nobody including us knows it while anyone can still act on it. Accounts and deposits use
session keys, so a player approves once and then enters and cashes out without a wallet popup on
every action.

Before ER we had commit-reveal RNG settlement, which was provably fair but decided the whole round
the moment the lobby closed, so users couldn't cash out mid round. ER was crucial to the project
because we needed transactions open during the fight and players able to cash out in the middle of a
round. At 400ms slots that's a promise you can't keep, at 10ms it's just a button.

Our devnet showcases the full lifecycle on the rollup: open and delegate a round, deploy into a side,
VRF draw, live ticks landing in about 350ms so on-chain HP decays while you watch, a session signed
cash out mid fight, settlement, and then the browser re-deriving the entire fight from the seed to
check it against what the chain settled.

Our mainnet proof of concept is live at:
site:
solscan:

With our hackathon winnings we plan to deploy our current system onto MagicBlock mainnet and will
issue around 2400 txns a day.
site:
solscan:

After deployment we have an instant player base from Unicorn who are our co-builders, and Ansem's
community is the other half of the fight by design.

We are big supporters of Superteam Thailand and are starting a crypto hub in Samui, we hope to join
the main hacker house event in Bangkok.

I had also spoken with Solana Play (PSG) and they expressed some interest to build with MagicBlock,
particularly for the hacker house event, if we can discuss this.

tg: davincible

Built entirely on MagicBlock technology.
