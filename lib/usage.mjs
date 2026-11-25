// Usage rollups from the transcript index: tokens per day, estimated cost per day/project/model, and when you work.
// Cost is Claude Code's own per-session total (`cost-state`), spread over the days the session used tokens, weighted by relative token price.
const W = { i: 1, o: 5, cc: 1.25, cr: 0.1 };
const weight = (b) => b.i * W.i + b.o * W.o + b.cc * W.cc + b.cr * W.cr;
const dkey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const add = (a, b) => { for (const k of ["i", "o", "cc", "cr"]) a[k] += b[k] || 0; return a; };
const zero = () => ({ i: 0, o: 0, cc: 0, cr: 0 });

/**
 * @param sessions index sessions (need use, hrs, cost, lastTs)
 * @param opts { days, now, projectOf(session) -> {key,name} | null }
 */
export function summarize(sessions, { days = 30, now = Date.now(), projectOf = () => null } = {}) {
  const from = dkey(now - (days - 1) * 86_400_000);
  const byDay = new Map(), byProject = new Map(), byModel = new Map();
  const heat = new Array(168).fill(0);
  const total = { usd: 0, tokens: zero(), sessions: 0, uncosted: 0 };
  for (const s of sessions) {
    const buckets = Object.entries(s.use || {});
    const usd = s.cost?.usd ?? null;
    const wTotal = buckets.reduce((n, [, b]) => n + weight(b), 0);
    let touched = false;
    for (const [day, b] of buckets) {
      if (day < from) continue;
      touched = true;
      const share = usd != null && wTotal > 0 ? (usd * weight(b)) / wTotal : 0;
      const d = byDay.get(day) || { day, usd: 0, ...zero() }; d.usd += share; add(d, b); byDay.set(day, d);
      const pr = projectOf(s); const pk = pr?.key || "unknown";
      const p = byProject.get(pk) || { key: pk, name: pr?.name || "unknown", usd: 0, sessions: new Set(), ...zero() }; p.usd += share; add(p, b); p.sessions.add(s.key); byProject.set(pk, p);
      total.usd += share; add(total.tokens, b);
    }
    if (!buckets.length && usd && s.lastTs && dkey(s.lastTs) >= from) { // no per-message usage recorded: put the whole cost on the last day
      touched = true; const day = dkey(s.lastTs); const d = byDay.get(day) || { day, usd: 0, ...zero() }; d.usd += usd; byDay.set(day, d); total.usd += usd;
    }
    if (touched) {
      total.sessions++; if (usd == null) total.uncosted++;
      for (const [m, u] of Object.entries(s.cost?.models || {})) { const e = byModel.get(m) || { model: m, in: 0, out: 0 }; e.in += u.in || 0; e.out += u.out || 0; byModel.set(m, e); }
      if (s.hrs && s.lastTs && dkey(s.lastTs) >= from) s.hrs.forEach((n, i) => { heat[i] += n; });
    }
  }
  const series = []; for (let i = days - 1; i >= 0; i--) { const k = dkey(now - i * 86_400_000); series.push(byDay.get(k) || { day: k, usd: 0, ...zero() }); }
  return {
    days, from, total: { ...total, usd: round(total.usd) },
    byDay: series.map((d) => ({ ...d, usd: round(d.usd) })),
    byProject: [...byProject.values()].map((p) => ({ ...p, sessions: p.sessions.size, usd: round(p.usd) })).sort((a, b) => b.usd - a.usd || weight(b) - weight(a)).slice(0, 15),
    byModel: [...byModel.values()].sort((a, b) => b.in + b.out - (a.in + a.out)),
    heat, heatMax: Math.max(0, ...heat),
    note: "Cost is Claude Code's own session total, spread across days by token use: an estimate, not an invoice. Sessions on a subscription show the API-equivalent value.",
  };
}
const round = (n) => Math.round(n * 100) / 100;
