# `e2e/` — the assembled page, in a real browser

```
npm run test:e2e      # builds dist/, serves it, drives Chrome. ~30s.
```

`npm test` is unchanged and stays browserless: these files are `*.e2e.ts`, which vitest's default
`include` does not match, and they have their own config (`vitest.e2e.config.ts`).

## What it is

1431 unit tests cover the **decisions** — `roundPhaseCopy.ts` decides what a clock slot holds,
`coverage.ts` decides how a window is worded, `feeCopy.ts` decides how a rate is stated,
`contract.ts#counted` decides a plural. Every defect this suite is written against was a decision
that was *already right in a module* and *wrong on the assembled page*: a surface that never called
the module, or called it and printed something else beside it. That gap is invisible to a unit test
by construction, and it is the only thing in here.

| file | what it holds |
|---|---|
| `clock.e2e.ts` | a phase shows a clock only where one is genuinely running; `0:00` never appears |
| `copy.e2e.ts` | the entry rate, the coverage captions, and count/noun agreement |
| `render.e2e.ts` | five screens × four phases × both lineups × two viewports, no errors, no blank page |
| `keyboard.e2e.ts` | digits bind to the printed index, and stand down while you type |
| `overlay.e2e.ts` | the takeover traps Tab and hands focus back |
| `stake.e2e.ts` | the amount field accepts `0.5` typed left to right |

## How it stays deterministic

- **`?fixture=1`** — no chain, no wallet, no RPC. A suite that needs devnet is a suite nobody runs.
- **`page.clock`** — Playwright's fake timers replace `Date`, `setTimeout`, `setInterval` and
  `requestAnimationFrame` inside the page, so the fixture's 104-second round is stepped in
  milliseconds. There is no `waitForTimeout` anywhere in here; every wait is `until()`, polling an
  observable condition from Node. A frozen page clock is also why `page.waitForFunction` cannot be
  used — its polling is itself a page timer.
- **The keeper's status file is always intercepted**, never left to `public/keeper-status.json` (a
  checked-in artifact that goes stale) and never to the deployed keeper. `keeperStates` names the
  three cadences the clock rules branch on.
- **One browser context per page**, so `localStorage` starts empty and a first visit is a first
  visit.
- **`assertHermetic`** fails any test whose page leaves its own origin.

## Adding to it

Two rules, both from this repo's own history:

1. **A test must fail when its defect is reintroduced.** Every test here was verified that way —
   patch the fix out, rebuild, watch it go red, revert. A green test nobody has seen fail is a
   green test that proves nothing, which is exactly what a parity fixture and a `tsc --noEmit` have
   each already cost this repo once.
2. **A scan must assert it found something.** Several tests here sweep rendered text. Each one
   asserts a floor on the number of things it matched, because a refactor that emptied the screens
   would otherwise turn a sweep green by giving it nothing to disagree with.

If a test cannot genuinely verify what its name claims, rename it or delete it. Where this suite
stops is written down in the file headers — `copy.e2e.ts` in particular records two branches it
cannot reach and names the unit tests that own them.

## What it does not cover

- **The chain path.** Nothing here connects a wallet, signs, or reads devnet. `scripts/prod-smoke.mjs`
  drives the real write path against production, by hand.
- **The `Abandoned` phase.** The fixture round runs Lobby → Drawing → Fight → Settled and stops.
- **The windowed-coverage branch.** The fixture's log is complete by construction, so "all time" is
  true on it; `coverage.test.ts` owns the incomplete wording.
- **`counted(1, …)`.** No surface on the fixture page renders a count of one at any lineup the app
  accepts — measured. `contract.test.ts` owns it.
- **Layout.** Nothing here asserts that anything looks right, only that it is there and says the
  right words.
