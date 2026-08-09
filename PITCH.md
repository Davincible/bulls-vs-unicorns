# Bulls ⚔ Unicorns — the fight where you decide when to lock it in

A real-money PvP memecoin arena on Solana, with the round itself living inside a MagicBlock
Ephemeral Rollup.

**How we use MagicBlock.** A round is one Solana account that we `delegate_round` into an ER for its
entire life, so `enter` and `extract` are real-time, player-signed writes at ~10ms instead of 400ms;
when the fight ends, `resolve()` commits and undelegates back to the base layer, which stays the
system of record for settlement. Clients reach both layers through a single endpoint via the **Magic
Router**. The seed comes from **MagicBlock VRF**, drawn on the ephemeral queue *after* the lobby
closes (`close_lobby_and_draw` → `callback_seed`), so the operator never chooses the randomness —
there is no seed to grind. **Session Keys** let a player press EXTRACT mid-fight without a wallet
popup; we proved that works against an ER-delegated account, which nothing in MagicBlock's docs or
examples had done before.

**What it bought us.** We benchmarked the fight on devnet before designing around it: 187 CU/step,
~7,300 steps in one transaction — meaning a whole 40-second fight fits in a single tx and the rollup
was *optional*. So we changed the game instead of the integration. Once you've deployed into a round
you're committed — no refund, no cancelling, the round resolves regardless. `extract()` is a
mid-fight risk decision inside that commitment: bank whatever value your fighter is currently
holding, and in exchange stop being a target for the rest of the fight. You don't leave the round —
your locked-in value still counts toward your side when it settles — you just stop pressing your
luck against more hash-paired exchanges. That only matters as a REAL decision if it happens live: at
400ms slots, "extract now" is a promise the chain can't keep. At 10ms it's real. Remove the ER and
the mechanic doesn't exist.

**What was achieved.** The full lifecycle runs on real devnet, proven twice with signatures: open →
delegate → enter ×2 (two signing wallets) → VRF draw → mid-fight extract → resolve → close_round →
verified back on the base layer, with value conserved exactly. The compiled Rust and its TypeScript
mirror produce byte-identical outcomes for the same seed, verified by execution rather than by
reading. An independent security review found and closed four blocking bugs first — including a
step-count grinding attack and a VRF callback that could never reach the round. Devnet-only by
construction; the live mainnet product is untouched. Along the way we kept a feedback log of real
integration findings for MagicBlock, each pinned to the code that reproduces it.
