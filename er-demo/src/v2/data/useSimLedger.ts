// React's half of the simulated ledger: hold it, persist it, and expose the `SimLedgerActions` the
// contract declares. All arithmetic lives in `simLedger.ts` — this file only wires it to a component
// tree and to localStorage.

import { useCallback, useEffect, useMemo, useState } from "react";
import { SIDE_TOKEN, unitsToUsd, type Side, type SimLedger, type SimLedgerActions, type TokenKey } from "../contract.ts";
import * as sim from "./simLedger.ts";

export interface SimLedgerHandle {
  ledger: SimLedger;
  actions: SimLedgerActions;
  /** Books a CONFIRMED deploy — see `simLedger.ts#recordDeploy`. Not part of `SimLedgerActions`
   *  because no view calls it: the provider calls it off a real, successful `enter()`, which is the
   *  only thing that should ever move this balance. */
  recordDeploy(side: Side, stakeUnits: bigint): void;
}

/** `referred` is "this browser arrived on a `?ref=` link" — read once by the caller from the URL. */
export function useSimLedger(referred: boolean): SimLedgerHandle {
  const [ledger, setLedger] = useState<SimLedger>(() => sim.registerReferral(sim.load(), referred));

  // Persist on every change rather than on each action, so there is exactly one writer and no path
  // can update state without updating storage.
  useEffect(() => { sim.save(ledger); }, [ledger]);

  const actions = useMemo<SimLedgerActions>(
    () => ({
      deposit: (token, amountUsd) => setLedger((l) => sim.deposit(l, token, amountUsd)),
      withdraw: (token, amountUsd) => setLedger((l) => sim.withdraw(l, token, amountUsd)),
      convert: (from, to, amountUsd) => setLedger((l) => sim.convert(l, from, to, amountUsd)),
      topUp: () => setLedger((l) => sim.topUp(l)),
      reset: () => setLedger(sim.reset()),
    }),
    [],
  );

  const recordDeploy = useCallback((side: Side, stakeUnits: bigint) => {
    // Which token a side plays comes from `SIDE_TOKEN`, never a hardcoded name — the arena picker
    // exists and the mapping is its business, not this file's.
    const token: TokenKey = SIDE_TOKEN[side].key;
    setLedger((l) => sim.recordDeploy(l, token, unitsToUsd(stakeUnits)));
  }, []);

  return { ledger, actions, recordDeploy };
}
