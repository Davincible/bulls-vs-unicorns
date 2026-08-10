// SENDING THE HOUSE'S ENTRIES — the half of the house's arrival that touches the network, and the
// half where a board can come up short without anybody being told.
//
// `houseBank.test.ts` decides WHICH entries to send and `houseInvariants.test.ts` proves the policy
// holds at every lobby shape. Neither of them sends anything. This file is about `enterHouseFighters`:
// how the batch is dispatched, and what the caller learns when part of it does not land.
//
// IT EXISTS BECAUSE OF A BUG THAT COST NOTHING AND HID EVERYTHING. An entry abandoned for lack of
// lobby time used to increment no counter at all — it warned, and the caller raises `lastError` on
// `failed`, so a fill that ran out of clock produced a healthy-looking keeper next to a board that had
// drawn at six instead of ten. That is indistinguishable, from the outside, from the empty-arena
// complaint the whole board policy exists to answer. It also got much more likely in the same change:
// the batch went from four entries to as many as eight, in the same twelve-second window.
//
// `src/chain/round.ts` is mocked because building a real Anchor instruction needs a real `Program`,
// and nothing here is testing instruction construction — the shape of `enter`'s accounts is proven by
// `verify-session-real.mjs` against the deployed program, which is a much stronger check than a unit
// test could make.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

vi.mock("../../src/chain/round.ts", () => ({
  enter: (_program: unknown, params: { side: 0 | 1 }) => ({ builder: params.side }),
}));

import type { BullsArenaProgram } from "../../src/chain/program.ts";
import type { ChainClient } from "./chainClient.ts";
import { CLOCK_SKEW_MARGIN_SECONDS } from "./config.ts";
import { enterHouseFighters, houseBankFrom, type HouseEntry } from "./houseBank.ts";

const bank = houseBankFrom(Array.from({ length: 4 }, () => Keypair.generate()));
const DRAW_AT = 1_800_000_000;

function entries(n: number): HouseEntry[] {
  return bank.active.slice(0, n).map((wallet, i) => ({ wallet, side: (i % 2) as 0 | 1, stake: 5_000_000n }));
}

interface Recorder {
  client: ChainClient;
  /** When each send STARTED, in call order — the evidence for concurrency. */
  started: number[];
  inFlightPeak: number;
}

/** A client whose `send` takes `latencyMs` and whose clock the test drives by hand. */
function recorder(nowSec: number, behaviour: (index: number) => "ok" | "throw", latencyMs = 5): Recorder {
  let calls = 0;
  let inFlight = 0;
  const rec: Recorder = {
    started: [], inFlightPeak: 0,
    client: {
      nowSec: () => nowSec,
      async send() {
        const index = calls++;
        rec.started.push(Date.now());
        inFlight += 1;
        rec.inFlightPeak = Math.max(rec.inFlightPeak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
        inFlight -= 1;
        if (behaviour(index) === "throw") throw new Error(`rejected ${index}`);
        return { signature: "sig", sent: true };
      },
    } as unknown as ChainClient,
  };
  return rec;
}

const round = { arenaPda: Keypair.generate().publicKey, roundPda: Keypair.generate().publicKey, drawAt: DRAW_AT };
const program = {} as BullsArenaProgram;
/** Comfortably inside the lobby. */
const IN_TIME = DRAW_AT - 60;

beforeEach(() => vi.clearAllMocks());

describe("enterHouseFighters", () => {
  it("sends the whole batch at once rather than one after another", () => {
    // THE REASON THE BOARD TARGET OF TEN IS AFFORDABLE AT ALL. Serially, eight confirmed router
    // round-trips did not fit in the twelve-second fill lead the house used to top up inside.
    //
    // The house now arrives on a schedule spread across the whole entry window, so the TYPICAL batch
    // is one or two — and that does not retire this test, it moves which case it defends. The batch
    // that has to fit is now the catch-up: a keeper that was backed off, restarting or riding out a
    // slow devnet arrives at a pass owing every fighter that has come due since, and at the end of the
    // window that is the entire board at once. Concurrency is what keeps that a single round-trip
    // rather than forty.
    //
    // Asserted as "all eight were in flight together" rather than by timing the whole call, which
    // would be a stopwatch test that fails on a loaded machine.
    const rec = recorder(IN_TIME, () => "ok");
    const done = enterHouseFighters(rec.client, program, round, entries(4));
    return done.then((result) => {
      expect(rec.inFlightPeak).toBe(4);
      expect(result).toEqual({ landed: 4, failed: 0, dropped: 0 });
    });
  });

  it("counts an entry it never sent, so a short board is never silent", () => {
    // THE BUG THIS FILE EXISTS FOR. Past the skew margin nothing can land, so nothing is sent and
    // nothing is spent — but the round still gets a thinner board than the policy asked for, and the
    // operator has to be told. `dropped` is separate from `failed` because the causes are different
    // (a lobby that ran out of clock, versus a wallet that has run dry) and the caller backs off only
    // on the second.
    const rec = recorder(DRAW_AT - CLOCK_SKEW_MARGIN_SECONDS, () => "ok");
    return enterHouseFighters(rec.client, program, round, entries(3)).then((result) => {
      expect(result).toEqual({ landed: 0, failed: 0, dropped: 3 });
      expect(rec.started).toHaveLength(0); // and it really did not spend a fee to find out
    });
  });

  it("lets the rest of the batch land when one entry is rejected", () => {
    // A single drained house wallet costs the round one fighter, not the other seven. The keeper must
    // also stay up: this is the failure `enterHouseFighters` swallows on purpose.
    const rec = recorder(IN_TIME, (i) => (i === 1 ? "throw" : "ok"));
    return enterHouseFighters(rec.client, program, round, entries(4)).then((result) => {
      expect(result).toEqual({ landed: 3, failed: 1, dropped: 0 });
    });
  });

  it("never rejects, whatever every entry does", () => {
    // `Promise.allSettled`, not `all`. The keeper is mid-round when this runs; a rejection here would
    // take down a process that is otherwise driving a fight correctly, which is the one thing this
    // function is written not to do.
    const rec = recorder(IN_TIME, () => "throw");
    return enterHouseFighters(rec.client, program, round, entries(4)).then((result) => {
      expect(result).toEqual({ landed: 0, failed: 4, dropped: 0 });
    });
  });

  it("does nothing, loudly or otherwise, when there is nothing to send", () => {
    const rec = recorder(IN_TIME, () => "ok");
    return enterHouseFighters(rec.client, program, round, []).then((result) => {
      expect(result).toEqual({ landed: 0, failed: 0, dropped: 0 });
      expect(rec.started).toHaveLength(0);
    });
  });
});
