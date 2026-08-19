// THE ARENA'S VOICE — what the page says to YOU, unprompted, while the fight is running.
//
// Between pressing Deploy and the settled plate this page used to say nothing at all: every toast it
// had was about a transaction the reader had just sent. The original game (web/index.html) talked
// continuously — "You raided $4.10 from turboTina", "gigaGwei hit you for $2.80", "Your fighter
// died!" — and that running account is the largest thing missing from this one. This restores it,
// with the one thing the original did not have and this program needs: a rate limit derived from the
// program's own pacing rather than from a ring buffer's length.
//
// THE THREE RULES, in order of how much they matter:
//
//   1. ONLY YOUR OWN EXCHANGES INTERRUPT. `CombatEvent.mine` is documented as the toast filter, and
//      it is the whole filter — a raid between two strangers is in the log (00-4.1) and is never a
//      toast. Everything else on this page follows the same discipline: the reader is interrupted
//      only about their own money.
//   2. A WINDOW, NOT AN EVENT. Bursts are summed and said once — `combatFeed.ts`'s `COALESCE_MS`
//      carries the arithmetic, which is about the toast stack's own capacity and not about taste.
//   3. THE MOMENTS DO NOT WAIT. A fighter dying and a round being decided are single events, not
//      rates. They flush the pending window and are said immediately.
//
// WHAT A SCREEN READER HEARS IS NOT WHAT THE SCREEN SHOWS, and that is deliberate rather than a
// shortcut. `ToastRail`'s live region is polite, which QUEUES: twenty commentary lines a minute
// pushed through it would put a reader minutes behind the fight and bury the one announcement they
// need (a refused transaction, their fighter dying). So the lines below are rendered `aria-hidden`
// and the reader gets `announcement` instead — a position summary on a slow cadence, plus the
// moments verbatim. See `ANNOUNCE_MS`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usdCompact, worth, type CombatEvent, type FighterView } from "../contract.ts";
import { useArena } from "../data/useArena.ts";
import { useLinks } from "../data/useLinks.ts";
import { COALESCE_MS, commentary, deathLine, resultLine, type VoiceLine } from "./combatVoice.ts";

/** How long a commentary line stays on screen, in ms. Shorter than a transaction toast's 6,000:
 *  these are a running account of something the reader is watching happen, not a receipt they may
 *  want to go back and check. */
const LINE_LIFE_MS = 5_000;

/** How many commentary lines may be on screen at once. Two coalescing windows can be alive inside
 *  `LINE_LIFE_MS` and each can produce at most two lines, so four is the natural ceiling and three
 *  is the one chosen: at four the stack starts to read as a wall, and the fourth line is always the
 *  older half of a window whose newer half is directly above it. */
const MAX_LINES = 3;

/** HOW OFTEN THE LIVE REGION MAY SPEAK, in ms. Ten seconds is roughly the length of a spoken
 *  position summary at a default rate, so this is the fastest cadence at which a reader hears each
 *  one finish before the next arrives. Anything faster does not inform, it interrupts — and a polite
 *  region that is permanently behind is a region a reader turns off. */
const ANNOUNCE_MS = 10_000;

export interface VoiceItem extends VoiceLine {
  id: number;
}

export interface CombatVoice {
  /** What is on screen right now, newest first. Visual only — see the header on why. */
  lines: VoiceItem[];
  /** What a screen reader is told, on `ANNOUNCE_MS`'s cadence or immediately for a moment. Empty
   *  string when there is nothing to say, which renders an empty live region and announces nothing. */
  announcement: string;
}

const SILENT: CombatVoice = { lines: [], announcement: "" };

/** WHERE YOU STAND, in one sentence — the thing a reader who cannot watch the field actually needs.
 *
 *  Deliberately a POSITION and not a narration. "You raided $0.40, you took $0.30, you raided $0.20"
 *  is what the screen shows because the screen can show three of them at once and be scanned; spoken,
 *  it is a list of deltas from which the listener is expected to do arithmetic in their head while
 *  the next one arrives. The figure they are actually deciding on is what is left in the ring. */
function positionText(roundNo: bigint, you: FighterView): string {
  const pnl = worth(you) - you.stake;
  const movement =
    pnl === 0n ? "level on the round" : `${pnl > 0n ? "up" : "down"} ${usdCompact(pnl < 0n ? -pnl : pnl)}`;
  const banked = you.banked > 0n ? `${usdCompact(you.banked)} banked` : "nothing banked";
  return `Round ${roundNo}: ${usdCompact(you.hp)} in the ring, ${banked}, ${movement}.`;
}

/**
 * @param enabled the commentary toggle (`ShellApi.commentary`). False silences the lines AND the
 *   announcements: it is the reader saying they do not want the page talking to them, and honouring
 *   half of that would be worse than honouring none.
 */
export function useCombatVoice(enabled: boolean): CombatVoice {
  const { live, combat: feed } = useArena();
  // READ, NEVER WAITED ON — `useLinks.ts`'s standing rule. The fight narrates itself in full while
  // the identity feed is outstanding; an opponent is simply named by their address until it lands.
  const { map: links } = useLinks();

  const [lines, setLines] = useState<VoiceItem[]>([]);
  const [announcement, setAnnouncement] = useState("");

  const seqRef = useRef(0);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** Exchanges waiting for the window to close. */
  const pendingRef = useRef<CombatEvent[]>([]);
  /** The identity map as of the last render — see the interval below for why it is a ref. */
  const linksRef = useRef(links);
  linksRef.current = links;
  /** The last step already collected. `HitEvent.step` is unique within a stream — `tick()` emits at
   *  most one exchange per step — which is what makes a single high-water mark sufficient, and what
   *  stops a stream recomputed after an `extract()` from re-narrating the first half of the fight. */
  const lastStepRef = useRef(-1);
  /** The moments already said, keyed by round, so two polls of the same state cannot say them twice. */
  const saidRef = useRef<{ round: bigint | null; death: boolean; result: boolean }>({
    round: null,
    death: false,
    result: false,
  });

  const push = useCallback((line: VoiceLine) => {
    const id = ++seqRef.current;
    setLines((current) => [{ id, ...line }, ...current].slice(0, MAX_LINES));
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setLines((current) => current.filter((l) => l.id !== id));
    }, LINE_LIFE_MS);
    timersRef.current.add(timer);
  }, []);

  // Every pending timer is tracked so unmounting cannot leave a `setState` scheduled against a dead
  // component — the same discipline `data/useToasts.ts` keeps, for the same reason.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // A round change wipes everything: the window, the high-water mark, and the moments said. Anything
  // held across the boundary would be narrated under the wrong round's number.
  //
  // THE MARK IS RESET TO THE CURSOR, NOT TO ZERO, and `CombatFeed`'s own note says why: a page opened
  // mid-fight — or one whose playhead has just jumped from a lobby into a fight already in progress —
  // has a full window of hits it has never seen and no business announcing any of them. Starting at
  // `at` says "everything before I arrived has already happened", which is the truth and is also the
  // difference between arriving to a quiet page and arriving to the exact flood this throttle exists
  // to prevent. `-1` is only ever correct for a fight that has not started.
  const roundNo = live?.roundNo ?? null;
  const cursor = feed.at;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  useEffect(() => {
    pendingRef.current.length = 0;
    lastStepRef.current = cursorRef.current;
    saidRef.current = { round: roundNo, death: false, result: false };
    setLines([]);
    setAnnouncement("");
  }, [roundNo]);

  // COLLECT. Runs on the fight's own cadence, says nothing, and only ever grows the pending window.
  //
  // `combat.mine` rather than a filter of `combat.recent`: the data layer cuts both from one window
  // in one pass, so they cannot disagree about what happened, and re-filtering here four times a
  // second would be the same work done again for the same answer. Ascending by step, which is what
  // makes a single high-water mark sufficient — and what stops a stream recomputed after an
  // `extract()` from re-narrating the first half of the fight.
  const mine = feed.mine;
  useEffect(() => {
    if (!enabled) return;
    for (const e of mine) {
      if (e.step <= lastStepRef.current) continue;
      lastStepRef.current = e.step;
      pendingRef.current.push(e);
    }
  }, [enabled, mine]);

  // SPEAK. One interval, running only while there is a fight to narrate — a timer that survived into
  // the lobby would be a wake-up every three seconds for the rest of the session.
  const fighting = live?.phase === "Fight";
  useEffect(() => {
    if (!enabled || !fighting) return;
    const timer = setInterval(() => {
      const pending = pendingRef.current;
      if (pending.length === 0) return;
      const window = pending.splice(0, pending.length);
      // THROUGH A REF, NOT A DEPENDENCY, and for the same reason `pendingRef` is one. The identity
      // map is replaced on every poll of the link feed; naming it in the dependency array would tear
      // this interval down and stand a fresh one up each time, which restarts the coalescing window
      // — so a link refresh landing mid-window would silently reset the three seconds this throttle
      // is built on. The ref gives the line the map as it is at the moment it is spoken, which is
      // the only reading that could matter, and costs the timer nothing.
      for (const line of commentary(window, linksRef.current)) push(line);
    }, COALESCE_MS);
    return () => clearInterval(timer);
  }, [enabled, fighting, push]);

  // THE MOMENTS. Read off the round rather than off the event stream: a fighter's death is a state
  // the chain reports, and a round's winner is not an exchange at all.
  const you = useMemo(() => live?.fighters.find((f) => f.isYou) ?? null, [live]);
  useEffect(() => {
    if (!enabled || live === null) return;
    const said = saidRef.current;
    // The reset effect above has not run for this round yet; saying anything now would book it
    // against the previous round and then be wiped.
    if (said.round !== live.roundNo) return;

    if (you !== null && you.dead && !said.death) {
      said.death = true;
      // Flushed, not queued behind the window: a player whose fighter has just died must not be told
      // about three raids first.
      pendingRef.current.length = 0;
      const line = deathLine(you);
      push(line);
      setAnnouncement(line.text);
    }

    if (live.phase === "Settled" && live.winner !== null && !said.result) {
      said.result = true;
      pendingRef.current.length = 0;
      const line = resultLine(live.winner, you, you === null ? null : worth(you) - you.stake);
      push(line);
      setAnnouncement(line.text);
    }
  }, [enabled, live, you, push]);

  // THE SLOW CHANNEL. Position, on `ANNOUNCE_MS`, and only while a fight this reader is in is
  // running — a spectator has no position to summarise and would be read an empty sentence.
  //
  // `live`/`you` are read through the closure, which is rebuilt whenever they change, so the
  // sentence is always current and the INTERVAL restarts with it. That is a real cost — the cadence
  // resets on every 250ms poll, so in the worst case it never fires — and it is why the timeout is
  // scheduled against a REF of the current position instead. One interval, one closure, current data.
  const positionRef = useRef<string>("");
  positionRef.current = inFightPosition(live?.roundNo ?? null, you, fighting);
  useEffect(() => {
    if (!enabled || !fighting) return;
    const timer = setInterval(() => {
      const text = positionRef.current;
      if (text !== "") setAnnouncement(text);
    }, ANNOUNCE_MS);
    return () => clearInterval(timer);
  }, [enabled, fighting]);

  // Disabled means silent, with nothing left on screen from before it was switched off.
  useEffect(() => {
    if (enabled) return;
    pendingRef.current.length = 0;
    setLines([]);
    setAnnouncement("");
  }, [enabled]);

  return useMemo(() => (enabled ? { lines, announcement } : SILENT), [enabled, lines, announcement]);
}

/** The position sentence, or `""` when there is no position to state — a dead fighter, a spectator,
 *  or no fight running. Written during render into a ref rather than captured in the interval's
 *  closure; see the note at the call site. */
function inFightPosition(roundNo: bigint | null, you: FighterView | null, fighting: boolean): string {
  if (!fighting || roundNo === null || you === null || you.dead) return "";
  return positionText(roundNo, you);
}
