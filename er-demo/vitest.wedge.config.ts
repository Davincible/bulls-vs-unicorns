// THE WEDGE SUITE'S OWN CONFIG — separate from `npm test`, for the same reason `vitest.e2e.config.ts`
// is separate, and one more.
//
// `npm test` (`vitest run`) stays browserless, hermetic and fast: it picks up `**/*.test.ts` and
// nothing else, and it must keep passing on a laptop with no Solana toolchain installed. This suite
// boots two validators, deploys a program into a genesis block and takes about ninety seconds; it
// can only run where `solana-test-validator` and `ephemeral-validator` exist. Folding it into the
// default suite would make every developer's `npm test` depend on a Solana install, and the pressure
// that creates is toward making the wedge suite SKIP when the toolchain is missing — which is
// precisely the thing `wedge/preconditions.ts` exists to refuse.
//
// So the split is not merely about speed. It is what lets the wedge suite be uncompromising: it runs
// only where it was asked to run, and where it runs it either produces a wedge or goes red.
//
// The file it runs is `g1.wedge.ts`, named so that the default suite's `**/*.test.ts` glob CANNOT
// pick it up — the same trick, and the same reasoning, as `e2e/*.e2e.ts`. Its guard,
// `wedge/localhost.test.ts`, IS `.test.ts` and DOES run in the default suite, deliberately: see that
// file's header.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["wedge/**/*.wedge.ts"],

    // ONE PROCESS, ONE FILE, NO OVERLAP. The suite binds fixed ports (`WEDGE_PORTS`) and refuses to
    // adopt a validator it did not start, so two files running concurrently would collide on the
    // ports and the second would fail its own precondition check. That failure would be correct and
    // useless. There is one file today; these settings are what make adding a second one safe rather
    // than a surprise.
    fileParallelism: false,
    maxWorkers: 1,

    // The choreography lives in `beforeAll` — two validator boots, nine transactions across two
    // layers, a SIGKILL and eight probes — so the hook budget is the one that matters and the
    // per-test budget can be small. Seven minutes is generous for a ~90-second run on a machine that
    // is also compiling something else; the hook has its own tighter internal deadlines (120s per
    // validator readiness gate, 30s for the kill to be verified) which fail with a log tail long
    // before this one fires with nothing useful to say.
    hookTimeout: 420_000,
    testTimeout: 30_000,

    reporters: ["default"],
  },
});
