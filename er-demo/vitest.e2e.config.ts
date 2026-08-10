// THE E2E SUITE'S OWN CONFIG — separate from `npm test` on purpose.
//
// `npm test` (`vitest run`) stays browserless, hermetic and fast: 1431 unit tests, no build, no
// Chrome, no server. It picks up `**/*.test.ts` and nothing else, and these files are named
// `*.e2e.ts` precisely so that it cannot pick them up. Nothing here changes what `npm test` runs.
//
// SEQUENTIAL, DELIBERATELY. Each file drives a real Chrome against one shared preview server. Run in
// parallel, four Chromes contend for the same CPU and the `until()` waits — which are wall-clock
// bounded — start failing for reasons that have nothing to do with the page. The whole suite is
// small enough that sequential is fast (see the header of `e2e/harness.ts`), and a suite that is
// occasionally red for load reasons is a suite people learn to re-run instead of read.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    globalSetup: ["./e2e/globalSetup.ts"],
    // One worker, one file at a time — see the header. `maxWorkers` as well as `fileParallelism`
    // because the two answer different questions (how many processes, and whether files may overlap)
    // and only both together guarantee one Chrome is alive at a time.
    fileParallelism: false,
    maxWorkers: 1,
    // A browser step that hangs should say which one; 60s is generous for anything in here (the
    // slowest single test drives 104 seconds of PAGE time in a few hundred milliseconds of real
    // time) and short enough that a wedged run does not sit for ten minutes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ["default"],
  },
});
