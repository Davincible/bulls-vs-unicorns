// SEC-M3. The limiter is a token bucket so a normal page load (which hits several endpoints at
// once) is not punished, while a sustained flood is. These pin the three properties that matter:
// a burst is allowed, sustained excess is refused, and the table cannot grow without bound.
import { test } from "node:test";
import assert from "node:assert/strict";

const BURST = 30, PER_SEC = 8, MAX_KEYS = 5000;

function makeLimiter(now = () => Date.now()) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    buckets,
    hit(ip: string): boolean {
      const t = now();
      let b = buckets.get(ip);
      if (!b) {
        if (buckets.size >= MAX_KEYS)
          for (const [k] of [...buckets].sort((x, y) => x[1].at - y[1].at).slice(0, MAX_KEYS / 2)) buckets.delete(k);
        b = { tokens: BURST, at: t }; buckets.set(ip, b);
      }
      b.tokens = Math.min(BURST, b.tokens + ((t - b.at) / 1000) * PER_SEC);
      b.at = t;
      if (b.tokens < 1) return true;
      b.tokens -= 1; return false;
    },
  };
}

test("a normal burst is allowed through", () => {
  let t = 1000; const rl = makeLimiter(() => t);
  for (let i = 0; i < BURST; i++) assert.equal(rl.hit("1.1.1.1"), false, `request ${i} should pass`);
});

test("sustained excess beyond the burst is refused", () => {
  let t = 1000; const rl = makeLimiter(() => t);
  for (let i = 0; i < BURST; i++) rl.hit("1.1.1.1");
  assert.equal(rl.hit("1.1.1.1"), true, "the request past the burst is limited");
});

test("tokens refill over time, so a throttled caller recovers", () => {
  let t = 1000; const rl = makeLimiter(() => t);
  for (let i = 0; i < BURST; i++) rl.hit("1.1.1.1");
  assert.equal(rl.hit("1.1.1.1"), true);
  t += 1000;                                   // one second later => PER_SEC tokens back
  for (let i = 0; i < PER_SEC; i++) assert.equal(rl.hit("1.1.1.1"), false, `refilled ${i}`);
  assert.equal(rl.hit("1.1.1.1"), true, "and no more than it refilled");
});

test("one noisy IP cannot throttle another", () => {
  let t = 1000; const rl = makeLimiter(() => t);
  for (let i = 0; i < BURST + 5; i++) rl.hit("1.1.1.1");
  assert.equal(rl.hit("2.2.2.2"), false, "a different caller is unaffected");
});

test("the bucket table is bounded — the limiter cannot itself become a memory DoS", () => {
  let t = 1000; const rl = makeLimiter(() => { t += 1; return t; });
  for (let i = 0; i < MAX_KEYS + 100; i++) rl.hit("ip-" + i);
  assert.ok(rl.buckets.size <= MAX_KEYS, `table grew to ${rl.buckets.size}`);
});
