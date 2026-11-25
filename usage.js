// Usage page: cost and tokens per day, project and model, and when you prompt. All text is inserted escaped.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);
const tok = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const saved = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

async function load() {
  const days = $("#days").value, project = $("#project").value;
  const r = await fetch(`/api/usage?days=${days}${project ? `&project=${encodeURIComponent(project)}` : ""}`);
  render(await r.json(), project);
}

function render(d, project) {
  const sel = $("#project"); if (sel.options.length <= 1) for (const p of d.projects.sort((a, b) => a.name.localeCompare(b.name))) sel.add(new Option(p.name, p.key)); sel.value = project;
  const t = d.total, all = t.tokens.i + t.tokens.o + t.tokens.cc + t.tokens.cr;
  $("#sub").textContent = `${d.from} to today · ${t.sessions} sessions`;
  $("#tiles").innerHTML = [[usd(t.usd), "Estimated cost"], [tok(t.tokens.o), "Output tokens"], [tok(t.tokens.i + t.tokens.cc), "Input tokens (new)"], [tok(t.tokens.cr), "Cache-read tokens"], [tok(all), "All tokens"]]
    .map(([b, l]) => `<div class="us-tile"><b>${esc(b)}</b><span>${esc(l)}</span></div>`).join("");
  chart(d.byDay);
  const max = Math.max(0.0001, ...d.byProject.map((p) => p.usd));
  $("#projects").innerHTML = d.byProject.length ? `<table class="us-table">${d.byProject.map((p) => `<tr><td>${esc(p.name)}<div class="us-bar"><i style="width:${(p.usd / max) * 100}%"></i></div></td><td>${usd(p.usd)}<br><span class="us-note">${p.sessions} sessions</span></td></tr>`).join("")}</table>` : `<p class="us-empty">No usage in this period.</p>`;
  $("#models").innerHTML = d.byModel.length ? `<table class="us-table">${d.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td>${tok(m.in)} in · ${tok(m.out)} out</td></tr>`).join("")}</table>` : `<p class="us-empty">No model data in this period.</p>`;
  heat(d.heat, d.heatMax);
  $("#note").textContent = d.note + (t.uncosted ? ` ${t.uncosted} sessions had no cost record and are counted in tokens only.` : "");
}

function chart(days) {
  const W = 600, H = 180, pad = { l: 34, b: 18, t: 6 }, max = Math.max(0.01, ...days.map((x) => x.usd)), bw = (W - pad.l) / days.length;
  const bars = days.map((x, i) => { const h = ((H - pad.b - pad.t) * x.usd) / max; return `<rect class="bar" x="${(pad.l + i * bw + 1).toFixed(1)}" y="${(H - pad.b - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${Math.max(h, x.usd ? 1 : 0).toFixed(1)}" rx="2"><title>${esc(x.day)}: ${usd(x.usd)} · ${tok(x.o)} output tokens</title></rect>`; }).join("");
  const step = Math.ceil(days.length / 6);
  const labels = days.map((x, i) => (i % step === 0 ? `<text x="${(pad.l + i * bw).toFixed(1)}" y="${H - 4}">${esc(x.day.slice(5))}</text>` : "")).join("");
  $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line x1="${pad.l}" x2="${W}" y1="${H - pad.b}" y2="${H - pad.b}"/><text x="0" y="${pad.t + 8}">${usd(max)}</text><text x="0" y="${H - pad.b}">$0</text>${bars}${labels}</svg>`;
  $("#chart-note").textContent = days.every((x) => !x.usd) ? "No cost recorded in this period." : "";
}

function heat(h, max) {
  if (!max) { $("#heat").innerHTML = `<p class="us-empty">No prompts in this period.</p>`; return; }
  let html = `<div class="us-heat" role="table"><span></span>${Array.from({ length: 24 }, (_, i) => `<span class="hr" style="text-align:center">${i}</span>`).join("")}`;
  for (let d = 0; d < 7; d++) { html += `<span class="lab">${DAYS[d]}</span>`; for (let hr = 0; hr < 24; hr++) { const n = h[d * 24 + hr]; html += `<span class="cell" style="--a:${n ? 0.15 + 0.85 * (n / max) : 0}" title="${DAYS[d]} ${hr}:00 · ${n} prompts"></span>`; } }
  $("#heat").innerHTML = html + "</div>";
}

$("#days").value = saved("usage.days", "30");
$("#days").addEventListener("change", () => { save("usage.days", $("#days").value); load(); });
$("#project").addEventListener("change", load);
load().catch((e) => { $("#sub").textContent = "Could not load usage: " + e.message; });
