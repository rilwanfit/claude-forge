import test from "node:test";
import assert from "node:assert/strict";
import { occurrences, nextRun, planDue, resolvePeriod, resolveInputs, renderTemplate } from "../lib/schedule.mjs";

const at = (s) => new Date(s).getTime(); // local time strings
const weekly = { enabled: true, days: [1], time: "08:00" };

test("next run is the coming Monday 08:00, and a past slot today is skipped", () => {
  assert.equal(nextRun(weekly, at("2026-11-24T09:00:00")), at("2026-11-30T08:00:00")); // Tuesday
  assert.equal(nextRun(weekly, at("2026-11-30T07:59:00")), at("2026-11-30T08:00:00"));
  assert.equal(nextRun(weekly, at("2026-11-30T08:00:00")), at("2026-12-07T08:00:00")); // exclusive
  assert.equal(nextRun({ ...weekly, enabled: false }, 0), null);
});

test("a run on time just runs", () => {
  const due = occurrences({ enabled: true, days: [], time: "08:00" }, at("2026-11-24T07:59:50"), at("2026-11-24T08:00:10"));
  const plan = planDue(due, at("2026-11-24T08:00:10"));
  assert.equal(plan.start.late, false); assert.deepEqual(plan.missed, []);
});

test("a week asleep gives ONE catch-up run, not seven", () => {
  const daily = { enabled: true, days: [], time: "08:00" };
  const now = at("2026-11-24T09:00:00");
  const due = occurrences(daily, at("2026-11-17T09:00:00"), now);
  assert.equal(due.length, 7);
  const plan = planDue(due, now);
  assert.equal(plan.start.late, true);
  assert.equal(plan.start.at, at("2026-11-24T08:00:00"));
  assert.equal(plan.missed.length, 6);
});

test("too old or policy skip: nothing starts, all missed", () => {
  const due = [at("2026-11-20T08:00:00")];
  const now = at("2026-11-24T09:00:00");
  assert.equal(planDue(due, now).start, null);
  assert.equal(planDue(due, now).missed.length, 1);
  assert.equal(planDue([at("2026-11-24T05:00:00")], now, { policy: "skip" }).start, null);
});

test("relative period resolves from the run date and records previous period", () => {
  const p = resolvePeriod({ mode: "relative", days: 7 }, new Date("2026-11-24T10:00:00"));
  assert.deepEqual([p.from, p.to, p.previous.from, p.previous.to], ["2026-11-17", "2026-11-23", "2026-11-10", "2026-11-16"]);
  // the same saved workflow, a week later, resolves to new dates
  assert.equal(resolvePeriod({ days: 7 }, new Date("2026-12-01T10:00:00")).to, "2026-11-30");
  assert.throws(() => resolvePeriod({ mode: "fixed", from: "2026-11-05", to: "2026-11-01" }));
});

test("templates fill inputs and fail loudly on unknown placeholders", () => {
  const { values, flat } = resolveInputs([{ name: "period", type: "period", days: 7 }, { name: "topic", type: "text", default: "seo" }], {}, new Date("2026-11-24T10:00:00"));
  assert.equal(renderTemplate("Compare {{period}} with {{period.previous}} on {{topic}}", flat), "Compare 2026-11-17 to 2026-11-23 with 2026-11-10 to 2026-11-16 on seo");
  assert.equal(values.period.resolvedAt.slice(0, 4), "2026");
  assert.throws(() => renderTemplate("{{nope}}", flat), /Unknown placeholder/);
});
