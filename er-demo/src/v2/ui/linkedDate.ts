// WHEN A WALLET PROVED ITS X ACCOUNT, as a reader would say it. Pure, so it is a unit test rather
// than a browser session — the same arrangement as `roundPhaseCopy.ts` and `keeperCadence.ts`.
//
// SECONDS IN, NOT MILLISECONDS. `LinkRecord.linkedAt` is unix SECONDS — `xLink.ts` says so on every
// timestamp field it defines, because the wire format is seconds and one file quietly switching units
// is how a date lands in 1970 or in the year 56000. The multiplication happens here, once, and the
// parameter name is the reminder.
//
// NO `Intl.DateTimeFormat`, AND THAT IS DELIBERATE. Two reasons, and the second is the load-bearing
// one. A formatter is constructed on every call unless it is cached, which `contract.ts#usdFormatter`
// documents at length and works around; and a locale-dependent format means this string is "8 Aug"
// on one machine and "Aug 8" on another, so a test can only assert it by rebuilding the same call —
// which proves nothing. The page already pins `en-US` for every number it prints, for the same
// reason. A three-letter month table is smaller than the workaround and has one reading everywhere.
//
// THE YEAR APPEARS ONLY WHEN IT IS NOT THIS ONE. "linked 8 Aug" is what somebody wants to read about
// something that happened this year; "linked 8 Aug" about something from two years ago is a wrong
// answer dressed as a short one.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/**
 * `8 Aug`, or `8 Aug 2025` when the year is not the current one.
 *
 * Returns `null` for anything unusable, and the caller then prints nothing at all rather than a
 * placeholder date. That is `SPEC.md`'s standing rule — a figure with nothing behind it is never
 * invented — applied to a timestamp: a record carrying a zero or a negative `linkedAt` is a server
 * bug, and "linked 1 Jan 1970" would be this page asserting it as a fact.
 *
 * @param linkedAtSec unix SECONDS, from `LinkRecord.linkedAt`.
 * @param nowMs unix milliseconds, from `Date.now()` — passed in rather than read, so "is it this
 *   year" is testable and so one render's worth of rows is judged against one instant.
 */
export function linkedDateText(linkedAtSec: number, nowMs: number): string | null {
  if (!Number.isFinite(linkedAtSec) || linkedAtSec <= 0) return null;
  const at = new Date(linkedAtSec * 1000);
  const month = MONTHS[at.getMonth()];
  // `getMonth()` on an out-of-range date returns NaN, which indexes to `undefined` rather than
  // throwing — so a timestamp far enough past the Date range degrades to "no date" like every other
  // unusable value, instead of printing the word "undefined" into the wallet panel.
  if (month === undefined) return null;
  const day = at.getDate();
  const year = at.getFullYear();
  return year === new Date(nowMs).getFullYear() ? `${day} ${month}` : `${day} ${month} ${year}`;
}
