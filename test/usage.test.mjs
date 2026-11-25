import test from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../lib/usage.mjs";

const now = new Date(2026, 10, 25, 12).getTime();
const day = (n) => { const d = new Date(now - n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const proj = { key: "/p/a", name: "a" };

test("cost is spread across days by token weight and sums back to the session total", () => {
  const s = { key: "k1", lastTs: now, cost: { usd: 3, models: { "claude-sonnet-5-5": { in: 10, out: 40 } } }, use: { [day(1)]: { i: 100, o: 0, cc: 0, cr: 0, n: 1 }, [day(0)]: { i: 300, o: 0, cc: 0, cr: 0, n: 2 } }, hrs: Array.from({ length: 168 }, (_, i) => (i === 25 ? 4 : 0)) };
  const r = summarize([s], { days: 7, now, projectOf: () => proj });
  assert.equal(r.total.usd, 3);
  assert.deepEqual(r.byDay.slice(-2).map((d) => d.usd), [0.75, 2.25]);
  assert.equal(r.byProject[0].name, "a"); assert.equal(r.byProject[0].sessions, 1);
  assert.equal(r.heat[25], 4); assert.equal(r.heatMax, 4);
  assert.equal(r.byDay.length, 7);
});

test("old days fall outside the window; sessions without per-message usage still count their cost", () => {
  const old = { key: "o", lastTs: now - 40 * 86_400_000, cost: { usd: 9 }, use: { [day(40)]: { i: 1, o: 1, cc: 0, cr: 0 } } };
  const bare = { key: "b", lastTs: now, cost: { usd: 1.5, models: {} } };
  const r = summarize([old, bare], { days: 30, now });
  assert.equal(r.total.usd, 1.5); assert.equal(r.total.sessions, 1);
});

test("a session with usage but no cost record is counted as uncosted, not as zero dollars of value", () => {
  const r = summarize([{ key: "n", lastTs: now, cost: null, use: { [day(0)]: { i: 5, o: 5, cc: 0, cr: 0 } } }], { days: 7, now });
  assert.equal(r.total.uncosted, 1); assert.equal(r.total.tokens.o, 5);
});
