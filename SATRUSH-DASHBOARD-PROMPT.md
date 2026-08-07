# Reverse-engineered prompt — satrush-style stats card

Paste this to generate a dashboard in that style. Swap the bracketed parts for your own brand/data.

---

## The prompt

> Design a single dark stats card for **[PRODUCT NAME]**, a **[what it is — e.g. Bitcoin-denominated
> on-chain game]**. It's a shareable end-of-period summary (a "daily wrap"), not an interactive app —
> one static image/page, ~2000×1300, landscape.
>
> **Mood:** near-black, cinematic, expensive. Bloomberg-terminal restraint, not crypto-casino neon.
> Confident and quiet — the numbers do the talking.
>
> **Palette:** background near-black (`#08070a`–`#0d0b0e`), NOT pure black. Cards a touch lighter
> (`#131114`) with 1px borders barely above the background (`rgba(255,255,255,.06)`). Text is white
> at three strengths: headline 100%, labels ~45%, sub-captions ~35%. **Exactly one accent colour**
> — [ACCENT, e.g. burnt orange `#e8622a`] — used only for: the logo mark, the single most important
> number, and one hairline border. Nothing else is coloured. No gradients on text, no glows.
>
> **Layout, top to bottom:**
> 1. **Header row** — logo + wordmark far left; a small outlined pill far right reading the period
>    (`DAILY`), letterspaced uppercase, muted.
> 2. **Hero stat** — a tiny uppercase letterspaced label (`DEPLOYED ON THE BOARD · DAILY`), then one
>    enormous number (~110px, light weight, tight tracking) with a smaller muted phrase on the same
>    baseline (`across 1,260 rounds`). This is 80% of the card's impact — give it room.
> 3. **Two rows of four stat cards** (8 total). Each card: muted uppercase micro-label, then a large
>    value (~40px), then one dim sub-caption giving context (`unique, avg 44 per round`). The
>    sub-caption is what makes it feel considered rather than a number dump — always say something
>    the headline number doesn't.
> 4. **One full-width accent band** for the single all-time/cumulative figure — label left, big value
>    right, accent-tinted border and a barely-there accent wash. This is the only accent-bordered
>    element.
> 5. **A second full-width band**, un-accented, for a "building / in progress" figure.
> 6. **Footer** — domain in accent on the left; live status in muted mono on the right
>    (`LIVE BOARD #4,746 · BTC $64,689`).
>
> **Typography:** one clean geometric sans throughout (Inter / Aeonik / Söhne). Numbers in a lighter
> weight than you'd expect — 300–400, never bold. Labels uppercase, ~11px, letterspacing ~0.12em.
> Tabular figures so columns align.
>
> **Background texture:** very large, very faint geometric line-art (hexagons / concentric polygons)
> in the accent colour at 3–6% opacity, bleeding off the right and bottom edges. It should be almost
> subliminal — if it reads as a "pattern", halve the opacity.
>
> **Rules:** generous padding (48px+ card interiors), no drop shadows, no rounded corners above 14px,
> no emoji, no icons in the stat cards. Mix units deliberately — show a native-token figure with its
> fiat equivalent underneath. Every number needs a unit or a qualifier.

---

## Why it works (the transferable bits)

| Move | Effect |
|---|---|
| **One accent colour, 3 uses** | Restraint reads as expensive. The eye knows exactly where to go. |
| **Light font weights on huge numbers** | Bold + big = shouty. Light + big = confident. |
| **Sub-caption on every stat** | Turns a number dump into a briefing. `$7,142` means nothing; `$7,142 / 2 fired on the board` means something. |
| **Near-black, not black** | Pure `#000` kills depth; cards can't sit above it. |
| **Label hierarchy by opacity, not colour** | Keeps the palette to one accent. |
| **Accent band for the cumulative number** | One "hero of the heroes" — the all-time figure, visually outranking the 8 cards. |
| **Faint oversized background geometry** | Fills dead space without competing. Bleeding off-edge implies scale. |

## Adapting it to Bulls ⚔ Unicorns

- **Hero:** total deployed across both armies today, `across N rounds`
- **8 cards:** unique players · rounds settled · biggest single raid · house take · avg per round ·
  biggest round · UWU stolen · SOL stolen
- **Accent band:** all-time deployed, or all-time house take
- **Second band:** current round building — `$X pot · N fighters`
- **Accent colour:** pick ONE of your green `#18e08a` or purple `#c46bff` — not both, or you lose the
  whole effect. Green reads as "money", purple as "brand".
- **Footer:** `bulls-arena.fly.dev` left; `LIVE ROUND #43 · SOL $72.60` right
