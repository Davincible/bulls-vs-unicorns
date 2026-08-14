// WHEN A FIGHT IS ALLOWED TO START — the policy that stopped the arena fighting itself, pinned.
//
// Every test here is about one of two failures. The first is money: a keeper that cycles rounds at
// nobody parks 0.023497 SOL of rent per cycle and holds a house-versus-house fight each time. Since
// v7 that rent is FLOAT — `close_round_account` returns it once `ROUND_RETENTION` newer rounds exist —
// so the cost is ~0.00007 SOL of fees per round plus the standing float and the risk that a close
// fails (COST-MODEL §0, §4), not the ~0.32 SOL/hour of permanent loss this header used to claim. The
// second is a number on a screen: a lobby held open for an hour must never produce a countdown,
// because nothing happens at that deadline.
//
// The fixture is a HELD-OPEN lobby — an hour of backstop, ONE house fighter, nobody real — because
// that is the state the keeper now spends almost all of its life in.

import { describe, expect, it } from "vitest";
import { Phase } from "../../src/chain/constants.ts";
import {
  CLOCK_SKEW_MARGIN_SECONDS, DEFAULT_LOBBY_SECONDS, REAL_PLAYER_GRACE_SECONDS,
  SCHEDULE_CLOSE_RETRY_SECONDS,
} from "./config.ts";
import { lobbyIsHeldOpen, planLobby, type LobbyView } from "./lobbyPolicy.ts";

const NOW = 1_800_000_000;
const BACKSTOP = NOW + 3_600;
/** The deadline the deployed arena actually stalled on: `KEEPER_HOLD_OPEN_LOBBY_SECONDS=604800` as
 *  `fly.toml` sets it, stamped by `open_round` before `--house-only-rounds` was switched on. Kept as the
 *  real number rather than "something big" so the tests below are about the outage that happened. */
const STUCK = NOW + 604_800;

function view(over: Partial<LobbyView> = {}): LobbyView {
  return {
    nowSec: NOW,
    lobbyClosesAt: BACKSTOP,
    fighterCount: 1,
    realFighterCount: 0,
    firstRealEntryObservedAtSec: null,
    holdOpen: true,
    houseOnly: false,
    // NEVER SENT ONE FOR THIS ROUND, which is what every round starts at and what a restart resets to.
    // The off-schedule close's own describe block is the only one that overrides it.
    scheduleCloseRetryAfterSec: 0,
    ...over,
  };
}

describe("holding a lobby open", () => {
  it("does nothing at all while the room is house-only, however long that lasts", () => {
    // THE CHEAP STEADY STATE, AND THE WHOLE POINT. Nothing is sent and nothing is spent; the rent
    // was paid once when this round opened and is not paid again for as long as this lasts.
    const plan = planLobby(view());
    expect(plan.step).toEqual({ kind: "wait" });
    expect(plan.heldOpen).toBe(true);
    expect(plan.entriesCloseAt).toBeNull();

    // Fifty-nine minutes later it is still the same answer, from the same snapshot shape. There is no
    // "how long have I been holding" anywhere in this decision.
    expect(planLobby(view({ nowSec: BACKSTOP - 60 })).step).toEqual({ kind: "wait" });
    expect(planLobby(view({ nowSec: BACKSTOP - 60 })).heldOpen).toBe(true);
  });

  it("points the house's arrival window at the backstop while nobody real is in", () => {
    // `drawAt` is what `plannedHouseEntries` sizes and schedules against. With nobody in the room the
    // lobby really will run to its deadline, so that is the honest answer, and the arrival window
    // stays an hour away — which is why the hold-open target is a single fighter rather than a filled
    // room.
    expect(planLobby(view()).drawAt).toBe(BACKSTOP);
  });
});

describe("a real player arriving", () => {
  const arrived = { realFighterCount: 1, fighterCount: 2, firstRealEntryObservedAtSec: NOW };

  it("stops the lobby being held open and puts a real close time on it", () => {
    const plan = planLobby(view({ ...arrived }));
    expect(plan.heldOpen).toBe(false);
    expect(plan.entriesCloseAt).toBe(NOW + REAL_PLAYER_GRACE_SECONDS);
    expect(plan.step).toEqual({ kind: "wait" });
  });

  it("moves the house's arrival window onto that close time rather than the backstop", () => {
    // THE BUG THIS PREVENTS IS SILENT. Anchored to the backstop, the whole arrival window would sit an
    // hour after the fight had already been fought — so the house would field its fightability floor
    // and nothing else, and "seed early liquidity, throttle down as real players join" would be dead
    // code on precisely the rounds a real player played.
    const plan = planLobby(view({ ...arrived }));
    expect(plan.drawAt).toBe(plan.entriesCloseAt);
    expect(plan.drawAt).toBeLessThan(BACKSTOP);
  });

  it("waits the grace out and then closes early — not a second before, not a second after", () => {
    const at = (nowSec: number) => planLobby(view({ ...arrived, nowSec })).step;
    expect(at(NOW + REAL_PLAYER_GRACE_SECONDS - 1)).toEqual({ kind: "wait" });
    expect(at(NOW + REAL_PLAYER_GRACE_SECONDS)).toEqual({ kind: "closeEarly" });
    expect(at(NOW + REAL_PLAYER_GRACE_SECONDS + 30)).toEqual({ kind: "closeEarly" });
  });

  it("does not re-open the window for the second player, or for the tenth", () => {
    // The grace is measured from the FIRST arrival and latched by the caller. A second entrant a beat
    // later joins the fight that is already scheduled; they do not push it back, or two people
    // arriving alternately could hold the round open forever.
    const plan = planLobby(view({
      realFighterCount: 3,
      fighterCount: 5,
      firstRealEntryObservedAtSec: NOW,
      nowSec: NOW + 15,
    }));
    expect(plan.entriesCloseAt).toBe(NOW + REAL_PLAYER_GRACE_SECONDS);
  });

  it("never promises entries past the deadline, because the chain stops taking them there", () => {
    // Somebody arrives ten seconds before the backstop. The grace would run past it; `enter` refuses
    // at the deadline regardless, so the honest close time is the deadline itself.
    const late = planLobby(view({
      ...arrived,
      nowSec: BACKSTOP - 10,
      firstRealEntryObservedAtSec: BACKSTOP - 10,
    }));
    expect(late.entriesCloseAt).toBe(BACKSTOP);
  });

  it("refuses to send a close that can only fail, when the lobby cannot hold a fight", () => {
    // `enough_to_fight` binds on the authority path exactly as on the permissionless one. One real
    // player and no house (the hold-open fighter's entry failed, or a wallet ran dry) is not a round,
    // and asking the program to draw it is a transaction that exists only to be rejected.
    const alone = planLobby(view({
      realFighterCount: 1,
      fighterCount: 1,
      firstRealEntryObservedAtSec: NOW,
      nowSec: NOW + REAL_PLAYER_GRACE_SECONDS,
    }));
    expect(alone.step).toEqual({ kind: "waitForFighters" });
  });
});

describe("the deadline, which is now a backstop", () => {
  it("waits the clock-skew margin out before acting on it", () => {
    // `lobby_closes_at` is stamped from the base layer's clock and compared against the ER's, and
    // both `close_lobby_and_draw` and `abandon_round` refuse if the ER disagrees.
    expect(planLobby(view({ nowSec: BACKSTOP })).step).toEqual({ kind: "wait" });
    expect(planLobby(view({ nowSec: BACKSTOP + CLOCK_SKEW_MARGIN_SECONDS - 1 })).step)
      .toEqual({ kind: "wait" });
  });

  it("abandons the held-open lobby nobody ever joined, rather than fighting it", () => {
    // THE PROPERTY THE SINGLE HOLD-OPEN FIGHTER BUYS, checked as behaviour rather than trusted. An
    // hour of holding ends with one house fighter in the room. `lobby_is_dead` is true (1 < 2), so
    // `abandon_round` is legal and the round reaches a terminal state; and `close_lobby_and_draw` is
    // ILLEGAL for everyone, so there is no house-versus-house fight available to us or to a
    // permissionless caller racing us at the deadline. Seeding four fighters here would have made
    // both of those the other way round — see this policy's header.
    const expired = planLobby(view({ nowSec: BACKSTOP + CLOCK_SKEW_MARGIN_SECONDS }));
    expect(expired.step).toEqual({ kind: "abandon" });
    expect(expired.heldOpen).toBe(false); // the lobby is over; there is nobody left to wait for
  });

  it("still draws a lobby that reached the deadline with a real player and a fight in it", () => {
    // The keeper was down through the grace window, or the early close failed. The round is a genuine
    // round — somebody real is in it and there are two fighters — so the permissionless path takes it
    // from here, exactly as it always did.
    const missed = planLobby(view({
      nowSec: BACKSTOP + CLOCK_SKEW_MARGIN_SECONDS,
      fighterCount: 2,
      realFighterCount: 1,
      firstRealEntryObservedAtSec: BACKSTOP - 5,
    }));
    expect(missed.step).toEqual({ kind: "close" });
  });
});

describe("hold-open switched off — the policy that is running today", () => {
  const off = { holdOpen: false, lobbyClosesAt: NOW + 60, fighterCount: 4 };

  it("never holds a lobby open, because it would have no way to stop holding it", () => {
    // Without the authority early close DEPLOYED, a keeper that held a lobby open would watch a real
    // player stand in a room for the whole backstop with no instruction available to start the fight.
    expect(planLobby(view({ ...off })).heldOpen).toBe(false);
    expect(planLobby(view({ ...off })).entriesCloseAt).toBeNull();
  });

  it("never plans an early close, however many real players are in", () => {
    const full = view({
      ...off,
      realFighterCount: 2,
      fighterCount: 6,
      firstRealEntryObservedAtSec: NOW - 30,
    });
    expect(planLobby(full).step).toEqual({ kind: "wait" });
    expect(planLobby(full).entriesCloseAt).toBeNull();
    expect(planLobby(full).drawAt).toBe(NOW + 60); // the deadline, as it always was
  });

  it("still ends the round exactly the way it always did", () => {
    const past = { ...off, nowSec: NOW + 60 + CLOCK_SKEW_MARGIN_SECONDS };
    expect(planLobby(view({ ...past, fighterCount: 4 })).step).toEqual({ kind: "close" });
    expect(planLobby(view({ ...past, fighterCount: 1 })).step).toEqual({ kind: "abandon" });
  });
});

describe("lobbyIsHeldOpen", () => {
  it("is false in every phase but Lobby, whatever the deadline says", () => {
    // The publisher asks this of whatever round the chain reported, which during a result hold is a
    // Settled one whose `lobbyClosesAt` may still be in the future.
    for (const phaseCode of [Phase.Drawing, Phase.Fight, Phase.Settled, Phase.Abandoned]) {
      expect(lobbyIsHeldOpen({
        phaseCode,
        lobbyClosesAt: BACKSTOP,
        nowSec: NOW,
        realFighterCount: 0,
        holdOpen: true,
        houseOnly: false,
      }), String(phaseCode)).toBe(false);
    }
  });

  it("is false once the deadline has passed, because nothing is being held any more", () => {
    expect(lobbyIsHeldOpen({
      phaseCode: Phase.Lobby,
      lobbyClosesAt: NOW,
      nowSec: NOW,
      realFighterCount: 0,
      holdOpen: true,
      houseOnly: false,
    })).toBe(false);
  });

  it("is false under house-only rounds, because the deadline is a schedule and not a backstop", () => {
    // The predicate's own question is "is this keeper going to reach that deadline without closing the
    // lobby first" — and under house-only it is not waiting for anybody, it is going to draw the round
    // when the clock runs out. Reporting `heldOpen` would put `waiting-for-players` on the page in
    // front of a lobby that fights in forty seconds.
    expect(lobbyIsHeldOpen({
      phaseCode: Phase.Lobby,
      lobbyClosesAt: BACKSTOP,
      nowSec: NOW,
      realFighterCount: 0,
      holdOpen: true,
      houseOnly: true,
    })).toBe(false);
  });
});

describe("house-only rounds, with hold-open still switched on", () => {
  // THE COMBINATION WORTH PINNING, because it is the one an operator actually types: hold-open is set
  // on the deployment and `--house-only-rounds` is added to make the arena run at nobody. The claim is
  // that house-only does not DISABLE hold-open — it collapses the backstop into a schedule, and the
  // authority early close a real arrival depends on is fully retained. See `lobbyPolicy.ts`'s header.
  const houseOnly = { houseOnly: true };

  it("stops calling an empty lobby held open, so the page can draw an honest countdown", () => {
    const plan = planLobby(view({ ...houseOnly }));
    expect(plan.heldOpen).toBe(false);
    // Still `wait` — there is nothing to send yet — but it is the ordinary wait of a lobby counting
    // down, not an indefinite hold. The difference is entirely in what gets published.
    expect(plan.step).toEqual({ kind: "wait" });
  });

  it("points the house's arrival window at the deadline, which is now when the round is really drawn", () => {
    // `drawAt` is what `plannedHouseEntries` sizes and schedules against, so this is the line that
    // makes a house-only board fill across the window rather than appear in one frame at the bell.
    expect(planLobby(view({ ...houseOnly })).drawAt).toBe(BACKSTOP);
    expect(planLobby(view({ ...houseOnly })).entriesCloseAt).toBeNull();
  });

  it("STILL handles a real player arriving, which is the half of hold-open that is retained", () => {
    // THE PROOF THAT THE SECOND HALF SURVIVED, and the reason `heldOpen` could be turned off without
    // taking the early close with it: `entriesCloseAt` is gated on `holdOpen` and the first real entry,
    // never on `heldOpen`. So somebody who walks into a house-only round gets the identical treatment
    // they would have got in a held-open one — a grace window, then their fight — rather than being
    // made to wait out a deadline that was set for bots.
    const arrived = view({ ...houseOnly, realFighterCount: 1, fighterCount: 11, firstRealEntryObservedAtSec: NOW });
    expect(arrived.holdOpen).toBe(true); // the fixture's own premise, stated so the test cannot drift
    const plan = planLobby(arrived);
    expect(plan.entriesCloseAt).toBe(NOW + REAL_PLAYER_GRACE_SECONDS);
    expect(plan.drawAt).toBe(NOW + REAL_PLAYER_GRACE_SECONDS);
    expect(plan.step).toEqual({ kind: "wait" });

    // And the grace really does end in the fight, rather than in a lobby that runs to its deadline.
    const closed = planLobby(view({
      ...houseOnly,
      realFighterCount: 1,
      fighterCount: 11,
      firstRealEntryObservedAtSec: NOW,
      nowSec: NOW + REAL_PLAYER_GRACE_SECONDS,
    }));
    expect(closed.step).toEqual({ kind: "closeEarly" });
  });

  it("does none of what follows with the mode OFF — a backstop is not a fault, it is a setting", () => {
    // THE GATE, CHECKED FROM THE OTHER SIDE AND FIRST. Everything below draws a lobby the operator's
    // own `KEEPER_HOLD_OPEN_LOBBY_SECONDS` opened, which is only ever the right thing to do because
    // the mode has replaced the backstop with a schedule. With `--house-only-rounds` off, the same
    // seven-day lobby holding the same two fighters is `--hold-open` doing exactly what it was
    // configured to do, and drawing it early would be the keeper overruling the operator.
    const held = planLobby(view({ lobbyClosesAt: STUCK, fighterCount: 2 }));
    expect(held.step).toEqual({ kind: "wait" });
    expect(held.heldOpen).toBe(true);
    expect(held.drawAt).toBe(STUCK);
    // Not even mid-week, and not with a full room.
    expect(planLobby(view({
      lobbyClosesAt: STUCK, fighterCount: 10, nowSec: NOW + 300_000,
    })).step).toEqual({ kind: "wait" });
  });

  it("draws a lobby whose deadline predates the mode, instead of standing still until it expires", () => {
    // THE OUTAGE, AS A TEST. Round #4 was opened under `KEEPER_HOLD_OPEN_LOBBY_SECONDS=604800` and the
    // mode was switched on underneath it. `lobby_closes_at` is stamped once and no instruction moves
    // it, so nothing about turning the flag on reached the deadline: `heldOpen` went false, nothing was
    // waiting for a player, nothing was going to draw the round, and the arena stopped for seven days
    // with two house fighters in the room. See `lobbyPolicy.ts`'s header for the whole state it was
    // found in.
    const stuck = planLobby(view({ ...houseOnly, lobbyClosesAt: STUCK, fighterCount: 2 }));
    expect(stuck.step).toEqual({ kind: "closeToSchedule" });
  });

  it("leaves the plan's published fields alone while doing it", () => {
    // DELIBERATE, AND ARGUED IN `planLobby`. A synthesised `entriesCloseAt` of "now" would read as the
    // honest answer and is a trap: `entriesCloseAt !== null` is what puts a round on the REAL-ARRIVAL
    // ladder, so the next pass would answer `closeEarly` — losing the keeper's backoff and logging a
    // player who is not there — and `drawAt` would land on `nowSec`, where `plannedHouseEntries` drops
    // every entry inside the skew margin and publishes a `lastError` for the short board.
    const stuck = planLobby(view({ ...houseOnly, lobbyClosesAt: STUCK, fighterCount: 2 }));
    expect(stuck.entriesCloseAt).toBeNull();
    expect(stuck.drawAt).toBe(STUCK);
    expect(stuck.heldOpen).toBe(false);
  });

  it("cannot fire on a lobby the mode itself opened, at any point in that lobby's life", () => {
    // THE FALSE POSITIVE THAT WOULD COST MORE THAN THE BUG. The mode opens `DEFAULT_LOBBY_SECONDS`
    // lobbies; a fresh one read a second later has slightly less than that remaining, and `nowSec` is
    // the ER's clock against a deadline the BASE layer stamped, so the two disagree by up to the skew
    // margin. Without that margin in the comparison, a couple of seconds of skew would draw every
    // freshly opened house-only lobby on its first pass — a fight every few seconds, each parking a
    // round's rent. Checked at the worst instant (the whole window remaining, plus the whole margin)
    // and then across the countdown.
    const opened = { ...houseOnly, fighterCount: 10 };
    const remaining = (secs: number) => planLobby(view({ ...opened, lobbyClosesAt: NOW + secs })).step;
    expect(remaining(DEFAULT_LOBBY_SECONDS + CLOCK_SKEW_MARGIN_SECONDS)).toEqual({ kind: "wait" });
    expect(remaining(DEFAULT_LOBBY_SECONDS)).toEqual({ kind: "wait" });
    expect(remaining(DEFAULT_LOBBY_SECONDS / 2)).toEqual({ kind: "wait" });
    expect(remaining(1)).toEqual({ kind: "wait" });
    // One second past the margin is the first deadline no lobby this mode opened can have.
    expect(remaining(DEFAULT_LOBBY_SECONDS + CLOCK_SKEW_MARGIN_SECONDS + 1))
      .toEqual({ kind: "closeToSchedule" });
  });

  it("refuses the close below `enough_to_fight`, and keeps fielding the house instead", () => {
    // `enough_to_fight` BINDS ON THE AUTHORITY PATH EXACTLY AS ON THE PERMISSIONLESS ONE, so a stuck
    // lobby holding one fighter cannot be drawn by anybody — and it cannot be abandoned either, because
    // `lobby_is_dead` needs the deadline to have PASSED. There is no instruction that ends such a round
    // early, so `wait` is not a concession: it is the only answer, and it is the one that keeps
    // `fieldHouseFighters` running. `plannedHouseEntries` floors its target at `HOUSE_FLOOR` from the
    // first pass under this mode, so the room is being topped up to exactly the count this close needs.
    const alone = { ...houseOnly, lobbyClosesAt: STUCK, fighterCount: 1 };
    expect(planLobby(view(alone)).step).toEqual({ kind: "wait" });
    expect(planLobby(view({ ...alone, fighterCount: 0 })).step).toEqual({ kind: "wait" });
    // And the moment the second fighter lands, the close is due — no further condition, no next pass.
    expect(planLobby(view({ ...alone, fighterCount: 2 })).step).toEqual({ kind: "closeToSchedule" });
  });

  it("asks once per round rather than once per pass, because the keeper loops at 1Hz", () => {
    // THE THROTTLE IS PART OF THE DECISION, so it is pinned here rather than trusted to the caller.
    // The condition it is derived from — a deadline a week out — survives its own failed transaction,
    // so an unthrottled close would be re-sent 604,800 times. The keeper stamps
    // `scheduleCloseRetryAfterSec` before it sends; this is what the passes after that see.
    const stuck = { ...houseOnly, lobbyClosesAt: STUCK, fighterCount: 2 };
    expect(planLobby(view(stuck)).step).toEqual({ kind: "closeToSchedule" });

    const sentAt = NOW;
    const backoff = { ...stuck, scheduleCloseRetryAfterSec: sentAt + SCHEDULE_CLOSE_RETRY_SECONDS };
    const after = (secs: number) => planLobby(view({ ...backoff, nowSec: sentAt + secs })).step;
    expect(after(1)).toEqual({ kind: "wait" });
    expect(after(SCHEDULE_CLOSE_RETRY_SECONDS - 1)).toEqual({ kind: "wait" });
    // AND IT COMES BACK, rather than being counted out. There is no backlog behind this round for an
    // attempt cap to protect — the round IS the arena — so giving up would only restore the stall.
    expect(after(SCHEDULE_CLOSE_RETRY_SECONDS)).toEqual({ kind: "closeToSchedule" });
    expect(after(SCHEDULE_CLOSE_RETRY_SECONDS * 100)).toEqual({ kind: "closeToSchedule" });
  });

  it("gives a real player who walks into the stuck round their grace, not an instant draw", () => {
    // THE REAL-ARRIVAL EARLY CLOSE IS UNTOUCHED BY ALL OF THIS, which is the property the new branch
    // was placed under `entriesCloseAt === null` to get. Somebody entering the stuck lobby is on the
    // grace ladder from that instant: the transition close cannot pre-empt their window, and their
    // close is still the unthrottled one.
    const arrived = {
      ...houseOnly, lobbyClosesAt: STUCK, fighterCount: 3,
      realFighterCount: 1, firstRealEntryObservedAtSec: NOW,
    };
    expect(planLobby(view(arrived)).step).toEqual({ kind: "wait" });
    expect(planLobby(view(arrived)).entriesCloseAt).toBe(NOW + REAL_PLAYER_GRACE_SECONDS);
    const closed = planLobby(view({ ...arrived, nowSec: NOW + REAL_PLAYER_GRACE_SECONDS }));
    expect(closed.step).toEqual({ kind: "closeEarly" });
    // Even mid-backoff, which is the case that would prove the two throttles had been tangled together.
    expect(planLobby(view({
      ...arrived,
      nowSec: NOW + REAL_PLAYER_GRACE_SECONDS,
      scheduleCloseRetryAfterSec: NOW + SCHEDULE_CLOSE_RETRY_SECONDS,
    })).step).toEqual({ kind: "closeEarly" });
  });

  it("needs hold-open as well, because that is the keeper's only assertion the close can land", () => {
    // `HOLD_OPEN_ENABLED_DEFAULT` is the operator saying the authority early close is DEPLOYED — a
    // claim no local file can make — and keeper.ts refuses to boot with `--hold-open` against an IDL
    // whose `close_lobby_and_draw` has no `authority` account. Anchor drops an account it cannot find
    // SILENTLY, so a transition close sent without that assertion would come back as `LobbyStillOpen`,
    // an error about the clock, every backoff for a week. The deployed configuration sets both flags.
    expect(planLobby(view({
      houseOnly: true, holdOpen: false, lobbyClosesAt: STUCK, fighterCount: 2,
    })).step).toEqual({ kind: "wait" });
  });

  it("closes the round at its deadline rather than abandoning it, because it can now hold a fight", () => {
    // THE CONSEQUENCE THE MODE IS BOUGHT WITH, as behaviour. Under the treasury rule an empty lobby
    // reaches its deadline with one fighter, `lobby_is_dead` is true, and `abandon_round` ends it
    // cleanly. Fill that room and the same instant produces `close` instead — which is the round the
    // operator asked for, and which is also why `abandon_round` is no longer available as a way out if
    // the draw cannot land. `HOUSE_ONLY_ROUNDS_ENABLED` prices that.
    const expired = { ...houseOnly, nowSec: BACKSTOP + CLOCK_SKEW_MARGIN_SECONDS };
    expect(planLobby(view({ ...expired, fighterCount: 10 })).step).toEqual({ kind: "close" });
    // And the empty-room escape hatch is gone with it: only a lobby that genuinely holds fewer than
    // two fighters can still be abandoned, which under this mode means one whose house entries all
    // failed.
    expect(planLobby(view({ ...expired, fighterCount: 1 })).step).toEqual({ kind: "abandon" });
  });
});
