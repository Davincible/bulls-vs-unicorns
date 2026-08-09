// WHERE THE FRAME'S TEXT ALREADY IS.
//
// Three modules put words on this field and until now none of them knew the other two existed: the
// fighters' name/value labels (draw.ts), the damage figures (impact.ts), and the scoreboard
// watermark (scoreboard.ts). Each was individually careful — the labels case themselves in paper,
// the figures fan out so consecutive hits on one defender don't smear, the watermark sits at a
// fraction of an alpha — and the combination was still unreadable, because "careful about myself" is
// not the same claim as "legible together". Screenshotted on a real 9-fighter frame at 1440x950:
// `−$0.001` printed straight across `FABLE_61`, `−$0.003` and `−$0.001` across `ONYX_39 $65.21`, and
// the watermark's own `ROUNDS WON · 16 SETTLED` chewed into `NDS WON · 16 SETTLED`.
//
// So there is one map of the frame's text, filled in draw order, and everything that comes after
// asks it before it draws. The order is the priority, and it is deliberate:
//
//   1. THE WATERMARK claims first. It is the ground and it cannot move — it is positioned off the
//      field's geometry, not off anything that drifts.
//   2. LABELS claim next, in draw.ts's own stable order (you, then the living, then the largest,
//      `id` as the tiebreak). A name is the one thing on this field that has to be there.
//   3. FLOATERS only ASK. They never claim against a label and they are never allowed to displace
//      one: they last 900ms and a fighter's name lasts the round. A floater with nowhere to go is
//      dropped, which is a much smaller loss than an unreadable name.
//
// DISCS ARE NOT IN HERE, and that is the design, not an omission. A fighter crossing the watermark is
// the fight happening in front of its scoreboard; text crossing text is two things saying different
// words in the same pixels. Only the second one is a failure.
//
// Boxes are inclusive of a small pad — the labels' paper casing is 2px wide, so two boxes that merely
// abut still touch on the page.

/** The casing stroke draw.ts puts around every label, so boxes that merely abut still read as two
 *  separate marks rather than as one crowded one. */
const PAD = 2;

export interface InkMap {
  /** Start a new frame. */
  reset(): void;
  /** This rectangle now holds text; nothing else may be drawn into it. */
  claim(x0: number, y0: number, x1: number, y1: number): void;
  /** Is anything already claimed inside this rectangle? */
  hits(x0: number, y0: number, x1: number, y1: number): boolean;
}

/** One per arena loop, reset at the top of every paint.
 *
 *  Four parallel arrays and a used-prefix count rather than an array of box objects: this is rebuilt
 *  sixty times a second and the high-water mark is a couple of dozen boxes, so the pooled form
 *  allocates nothing at all after the first few frames. The whole structure is a linear scan on
 *  purpose — at ≤16 fighters there are fewer boxes here than a quadtree would have nodes. */
export function createInkMap(): InkMap {
  const x0: number[] = [];
  const y0: number[] = [];
  const x1: number[] = [];
  const y1: number[] = [];
  let n = 0;

  return {
    reset() {
      n = 0;
    },
    claim(a, b, c, d) {
      x0[n] = a - PAD;
      y0[n] = b - PAD;
      x1[n] = c + PAD;
      y1[n] = d + PAD;
      n++;
    },
    hits(a, b, c, d) {
      for (let i = 0; i < n; i++) {
        if (a < x1[i] && c > x0[i] && b < y1[i] && d > y0[i]) return true;
      }
      return false;
    },
  };
}
