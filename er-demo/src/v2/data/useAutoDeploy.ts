// React's half of "repeat every round": hold the policy, evaluate it on a clock, and send the one
// transaction it asks for. Every rule lives next door in `autoDeploy.ts`; this file owns timing,
// the write, and telling the player what happened.
//
// IT IS MOUNTED IN THE PROVIDER, NOT IN THE PANEL. `App.tsx` swaps whole screens with a `switch`, so
// anything held inside the Deploy panel dies the moment someone opens the Leaderboard. That is how a
// money rule ends up "firing some rounds, not others" without a single line of it being wrong: it was
// simply not running. The checkbox in 00-3 is now a view of this state, not the home of it.
//
// WHY A CLOCK AND NOT A DEPENDENCY LIST. The old effect re-ran when its inputs changed, which sounds
// equivalent and is not: the inputs it needed (a lobby's on-chain deadline passing, a retry's backoff
// elapsing, a poll landing during a window the effect happened not to be subscribed to) include
// several that change with TIME rather than with React state, and an effect cannot depend on time. So
// the decision is simply re-asked once a second while armed. It is a pure function over a handful of
// primitives; asking it 60 times a minute costs nothing, and it removes the entire class of bug where
// the right moment came and went while nothing was listening.
//
// WHY A REF HOLDS THE STATE. Two attempts must never start for one round, and React 18's StrictMode
// double-invokes effects specifically to catch code that assumes otherwise. State set with
// `useState` is not visible to a second synchronous call in the same tick, so the guard would not
// hold; a ref is. The ref IS the state — `force` only asks React to repaint what the ref now says —
// so there is still exactly one source of truth, and the double-invoke is a genuine no-op rather
// than one that merely looks like one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { entriesOpen, usd, usdToUnits, type LiveRound, type Side } from "../contract.ts";
import {
  INITIAL_AUTO_DEPLOY,
  abandonText,
  abandonAttempt,
  arm as armState,
  attemptFailed,
  attemptLanded,
  beginAttempt,
  decideAutoDeploy,
  disarm as disarmState,
  expireStaleAttempt,
  holdText,
  noteDeploy as noteDeployState,
  noteRoundEntered,
  resolveAmountUsd,
  setRule as setRuleState,
  type AmountRule,
  type AutoDeployHandle,
  type AutoDeployState,
} from "./autoDeploy.ts";
import type { ToastKind } from "./types.ts";

/** How often the rule is re-asked while armed. See this file's header for why it is a clock at all.
 *  One second is well under the shortest lobby the program allows (`MIN_LOBBY_SECONDS`, 30s) and well
 *  over the cost of a pure function over eight primitives. */
const EVALUATE_MS = 1000;

export interface AutoDeployParams {
  live: LiveRound | null;
  /** The round `enter()` would actually write to — the PDA the chain layer has resolved, which lags
   *  or leads `live.roundNo` by up to one poll when a new round opens. The rule refuses to act while
   *  the two disagree; see `decideAutoDeploy`'s `round-changing`. */
  targetRoundNo: bigint | null;
  /** A deposit is in flight from any surface on the page. */
  entering: boolean;
  enter(side: Side, stakeUnits: bigint): Promise<string>;
  /** The simulated bankroll a percentage rule is a percentage OF. Simulated, and labelled as such
   *  everywhere it is shown — see `AmountRule`. */
  simWalletUsd: number;
  push(text: string, kind?: ToastKind): void;
}

export function useAutoDeploy(params: AutoDeployParams): AutoDeployHandle {
  // The ref is the state; see the header. `version` exists only to repaint.
  const stateRef = useRef<AutoDeployState>(INITIAL_AUTO_DEPLOY);
  const [version, force] = useState(0);

  const commit = useCallback((next: AutoDeployState) => {
    if (next === stateRef.current) return;
    stateRef.current = next;
    force((n) => n + 1);
  }, []);

  // Everything the rule reads, kept current without making it an effect dependency — the effect
  // restarts on arm/disarm and nothing else, so a poll landing mid-second cannot tear the interval
  // down and rebuild it.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const state = stateRef.current;

  const arm = useCallback(
    (rule: AmountRule) => {
      commit(armState(stateRef.current, { rule, visibleRoundNo: paramsRef.current.live?.roundNo ?? null }));
    },
    [commit],
  );
  const disarm = useCallback(() => commit(disarmState(stateRef.current)), [commit]);
  const setRule = useCallback((rule: AmountRule) => commit(setRuleState(stateRef.current, rule)), [commit]);
  // Called from the confirmed-enter path for EVERY deposit on the page. It records two things, and
  // the second one is not decoration: which side to follow next time, and that THIS round has now had
  // a deposit. Without the second, a player who deploys by hand at the top of a lobby gets a second,
  // automatic deposit landing on top of theirs in the second before the roster poll catches up.
  const noteDeploy = useCallback(
    (side: Side) => {
      const roundNo = paramsRef.current.live?.roundNo ?? null;
      const withSide = noteDeployState(stateRef.current, side);
      commit(roundNo === null ? withSide : noteRoundEntered(withSide, roundNo));
    },
    [commit],
  );

  useEffect(() => {
    if (!state.armed) return;

    const evaluate = () => {
      const p = paramsRef.current;
      const nowMs = Date.now();
      const roundNo = p.live?.roundNo ?? null;

      // Close the books on anything the chain has already moved past, so no round is ever silently
      // dropped between one round number and the next.
      commit(expireStaleAttempt(stateRef.current, roundNo));

      const decision = decideAutoDeploy({
        state: stateRef.current,
        roundNo,
        targetRoundNo: p.targetRoundNo,
        phase: p.live?.phase ?? null,
        entriesOpen: entriesOpen(p.live, nowMs),
        alreadyIn: (p.live?.fighters ?? []).some((f) => f.isYou),
        entering: p.entering,
        amountUsd: resolveAmountUsd(stateRef.current.rule, p.simWalletUsd),
        nowMs,
      });

      if (decision.kind === "hold") return;

      if (decision.kind === "abandon") {
        commit(abandonAttempt(stateRef.current, decision.roundNo, decision.reason));
        // ONE ERROR PER LOST ROUND, always. This toast is the entire difference between the old
        // behaviour and this one: a round that was armed for and not entered now says so, instead of
        // being indistinguishable from a round the rule was never running for.
        const prior = stateRef.current.attempt;
        p.push(
          `Repeat missed round ${decision.roundNo} — ${abandonText(decision.reason, prior?.error ?? null)}`,
          "error",
        );
        return;
      }

      // Marked as sending BEFORE the await, synchronously, on the ref — a second evaluation in the
      // same tick (StrictMode's double invoke, or a 1s timer landing on top of one) sees it and
      // holds. Unlike the version this replaces, this is a claim about a transaction that IS in
      // flight, not a claim that the round is finished with.
      const { roundNo: target, side, amountUsd } = decision;
      commit(beginAttempt(stateRef.current, target));

      void p.enter(side, usdToUnits(amountUsd)).then(
        (signature) => {
          commit(attemptLanded(stateRef.current, target, signature));
          p.push(`Repeat deployed ${usd(usdToUnits(amountUsd))} into round ${target}`, side === 0 ? "a" : "b");
        },
        (e: unknown) => {
          // Failure is a retry, not an ending. The next evaluation decides whether the lobby is still
          // open enough to be worth another try, and `decideAutoDeploy` is the only thing that gets
          // to call a round lost.
          commit(attemptFailed(stateRef.current, target, e instanceof Error ? e.message : String(e), Date.now()));
        },
      );
    };

    evaluate();
    const id = setInterval(evaluate, EVALUATE_MS);
    return () => clearInterval(id);
  }, [state.armed, commit]);

  const nextAmountUsd = resolveAmountUsd(state.rule, params.simWalletUsd);

  // Recomputed rather than remembered from the last evaluation: the panel must describe the state of
  // the world at THIS render, not at the last tick of a one-second timer.
  const roundNo = params.live?.roundNo ?? null;
  const renderNowMs = Date.now();
  const decision = decideAutoDeploy({
    state,
    roundNo,
    targetRoundNo: params.targetRoundNo,
    phase: params.live?.phase ?? null,
    entriesOpen: entriesOpen(params.live, renderNowMs),
    alreadyIn: (params.live?.fighters ?? []).some((f) => f.isYou),
    entering: params.entering,
    amountUsd: nextAmountUsd,
    nowMs: renderNowMs,
  });
  const hold = decision.kind === "hold" ? decision.reason : null;

  // EVERY VERDICT GETS ITS OWN TRUE SENTENCE, including the two that only exist for an instant. A
  // render can land between the timer's tick and the state it produces, and defaulting those two to
  // "Depositing…" would put a sentence about spending money on screen at the exact moment the rule
  // had decided NOT to spend any.
  const status =
    decision.kind === "hold"
      ? holdText(decision.reason, state, roundNo)
      : decision.kind === "fire"
        ? `Depositing into round ${decision.roundNo}…`
        : `Round ${decision.roundNo} was not entered — ${abandonText(decision.reason, state.attempt?.error ?? null)}`;

  return useMemo<AutoDeployHandle>(
    () => ({
      armed: state.armed,
      side: state.side,
      rule: state.rule,
      nextAmountUsd,
      firesFromRound: state.floorRound === null ? null : state.floorRound + 1n,
      status,
      hold,
      attempt: state.attempt,
      arm,
      disarm,
      setRule,
      noteDeploy,
    }),
    // `version` is the ref's change signal — see the header. It is a real dependency of everything
    // read off `state` below it, and the linter cannot see that through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, state, nextAmountUsd, status, hold, arm, disarm, setRule, noteDeploy],
  );
}
