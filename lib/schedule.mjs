// Pure schedule and input helpers: no clock, no disk, so they are easy to test.
// Times are the machine's local time zone (set TZ or "timezone" in config.json to change it).
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Run times of a schedule in (from, to], oldest first. Empty `days` means every day. */
export function occurrences(s, from, to) {
  if (!s || !s.enabled || !/^\d\d:\d\d$/.test(s.time || "")) return [];
  const [h, m] = s.time.split(":").map(Number);
  const out = [];
  const first = new Date(from); first.setHours(0, 0, 0, 0);
  for (let d = first; d.getTime() <= to + DAY && out.length < 400; d = addDays(d, 1)) {
    if (s.days?.length && !s.days.includes(d.getDay())) continue;
    const at = new Date(d); at.setHours(h, m, 0, 0);
    if (at.getTime() > from && at.getTime() <= to) out.push(at.getTime());
  }
  return out;
}

/** The next run time after `after`, or null when the schedule is off. Paused schedules still show it, marked by the caller. */
export function nextRun(s, after) {
  const [at] = occurrences(s, after, after + 15 * DAY);
  return at ?? null;
}

/**
 * Decide what a tick does with the runs that came due while nothing was watching.
 * `due` = occurrences in (lastTick, now]. A run on time (within `graceMs`) just runs.
 * After a gap, at most ONE catch-up run happens (policy "latest", inside `windowMs`);
 * every other due time is recorded as missed, never started: no burst on wake.
 */
export function planDue(due, now, { policy = "latest", graceMs = 5 * 60_000, windowMs = 12 * 3600_000 } = {}) {
  if (!due.length) return { start: null, missed: [] };
  const last = due[due.length - 1];
  if (due.length === 1 && now - last <= graceMs) return { start: { at: last, late: false }, missed: [] };
  const catchUp = policy === "latest" && now - last <= windowMs;
  return {
    start: catchUp ? { at: last, late: true } : null,
    missed: due.filter((t) => !(catchUp && t === last)).map((at) => ({ at, reason: policy === "skip" ? "policy skip" : now - at > windowMs ? "older than catch-up window" : "superseded by a later run" })),
  };
}

/** "Last 7 days" = the 7 complete days before today; `previous` is the 7 before those. */
export function resolvePeriod(value, now = new Date()) {
  let from, to;
  if (value?.mode === "fixed" && value.from && value.to) { from = new Date(value.from + "T00:00:00"); to = new Date(value.to + "T00:00:00"); }
  else { const days = Math.max(1, Math.min(366, Math.round(Number(value?.days) || 7))); to = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -1); from = addDays(to, -(days - 1)); }
  if (!(from <= to)) throw new Error("period: start is after end");
  const days = Math.round((to - from) / DAY) + 1;
  const pto = addDays(from, -1), pfrom = addDays(pto, -(days - 1));
  return { from: ymd(from), to: ymd(to), days, previous: { from: ymd(pfrom), to: ymd(pto) } };
}

/**
 * Resolve a workflow's inputs against what the user supplied (or the saved defaults).
 * Returns { values, flat }: `values` is what is recorded on the run, `flat` feeds the template.
 */
export function resolveInputs(specs, supplied = {}, now = new Date()) {
  const values = {}, flat = { today: ymd(now) };
  for (const sp of specs || []) {
    const raw = supplied[sp.name] ?? sp.default ?? (sp.type === "period" ? { mode: "relative", days: sp.days || 7 } : "");
    if (sp.type === "period") {
      const r = resolvePeriod(typeof raw === "object" ? raw : { mode: "relative", days: Number(raw) || sp.days || 7 }, now);
      values[sp.name] = { ...r, mode: raw?.mode === "fixed" ? "fixed" : "relative", resolvedAt: now.toISOString() };
      flat[sp.name] = `${r.from} to ${r.to}`; flat[`${sp.name}.from`] = r.from; flat[`${sp.name}.to`] = r.to; flat[`${sp.name}.days`] = String(r.days);
      flat[`${sp.name}.previous`] = `${r.previous.from} to ${r.previous.to}`; flat[`${sp.name}.previous.from`] = r.previous.from; flat[`${sp.name}.previous.to`] = r.previous.to;
    } else {
      const v = String(raw ?? "").trim();
      if (sp.required && !v) throw new Error(`Input "${sp.label || sp.name}" is required`);
      values[sp.name] = v; flat[sp.name] = v;
    }
  }
  return { values, flat };
}

/** Fill {{ placeholders }}; an unknown one is an error, never a silent blank. */
export function renderTemplate(text, flat) {
  const missing = [];
  const out = String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (k in flat ? flat[k] : (missing.push(k), m)));
  if (missing.length) throw new Error(`Unknown placeholder${missing.length > 1 ? "s" : ""}: ${[...new Set(missing)].map((k) => `{{${k}}}`).join(", ")}`);
  return out;
}

export const describeSchedule = (s) => {
  if (!s?.enabled) return "";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = !s.days?.length || s.days.length === 7 ? "Daily" : s.days.length === 1 ? `${names[s.days[0]]}` : s.days.map((x) => names[x]).join(", ");
  return `${d} ${s.time}`;
};
