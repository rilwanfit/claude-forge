// Dashboard UI: sidebar, overview, schedule strip, workflow library and a detail panel. No build step.
import { renderMarkdown } from "/mdview.mjs";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const DAY = 86_400_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ICONS = ["chart", "search", "write", "scan", "globe", "play"];
const ICON_NAMES = { chart: "Report", search: "Search", write: "Content", scan: "Review", globe: "Research", play: "Task" };

let D = null, sig = "", sel = localStorage.getItem("project") || "all", panel = null, opener = null, runData = null, pollTimer = null, logAfter = 0;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600); }
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

// ---------------------------------------------------------------- formatting
const two = (n) => String(n).padStart(2, "0");
const hm = (ts) => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
function ago(ts) {
  if (!ts) return "";
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function until(ts) {
  const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((new Date(d).setHours(0, 0, 0, 0) - today) / DAY);
  return diff === 0 ? `today ${hm(ts)}` : diff === 1 ? `tomorrow ${hm(ts)}` : `${WD[d.getDay()]} ${hm(ts)}`;
}
const full = (ts) => (ts ? new Date(ts).toLocaleString("en-GB") : "");

// ---------------------------------------------------------------- pieces
const proj = (key) => D.projects.find((p) => p.key === key) || { key, name: key ? key.split("/").pop() : "?" };
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (n) => { const w = n.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" "); return (w.length > 1 ? w[0][0] + w[1][0] : n.slice(0, 2)).toUpperCase(); };
const prof = (name) => (name ? `<span class="prof" style="--h:${hue("p" + name)}" title="Claude profile">${esc(name)}</span>` : "");
const mark = (key, cls = "") => { const n = proj(key).name; return `<span class="mark ${cls}" style="--h:${hue(n)}" aria-hidden="true">${esc(initials(n))}</span>`; };
const sym = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
const ticon = (name) => `<span class="ticon" aria-hidden="true"><svg><use href="#t-${ICONS.includes(name) ? name : "play"}"/></svg></span>`;
const CHIPS = {
  needs_review: ["needs", "i-alert"], needs_input: ["needs", "i-chat"], blocked: ["needs", "i-plug"], running: ["run spin", "i-run"], queued: ["run", "i-clock"],
  done: ["ok", "i-check"], failed: ["bad", "i-x"], rejected: ["mute", "i-pause"], stopped: ["mute", "i-pause"], session: ["mute", "i-clock"],
};
function chip(it) {
  const st = it.kind === "run" ? it.status : it.label === "Running" ? "running" : it.kind === "session" && (it.label === "Asked you" || it.label === "Needs approval") ? "needs_input" : it.kind === "session" ? "session" : "needs_review";
  const [cls, icon] = CHIPS[st] || ["mute", "i-clock"];
  return `<span class="chip ${cls}">${sym(icon)}${esc(it.label)}</span>`;
}

// ---------------------------------------------------------------- render
const inProj = (i) => sel === "all" || i.projectKey === sel;
const wfOf = (id) => D.workflows.find((w) => w.id === id);

function renderSide() {
  const totalNeeds = D.needs.length;
  const rows = [`<button class="pbtn" data-act="project" data-id="all" aria-current="${sel === "all"}"><span class="mark all" aria-hidden="true">All</span><span class="pname">All projects</span>${totalNeeds ? `<span class="badge" aria-label="${totalNeeds} need you">${totalNeeds > 9 ? "9+" : totalNeeds}</span>` : ""}</button>`];
  D.projects.forEach((p, i) => {
    const sr = p.needs ? `${p.needs} need you` : p.running ? "running" : "";
    rows.push(`<button class="pbtn" data-act="project" data-id="${esc(p.key)}" aria-current="${sel === p.key}" title="${esc(p.key)}">${mark(p.key)}<span class="pname">${esc(p.name)}</span>${p.needs ? `<span class="badge" aria-label="${sr}">${p.needs > 9 ? "9+" : p.needs}</span>` : p.running ? `<span class="dot-run" role="img" aria-label="running"></span>` : "<span></span>"}</button>`);
  });
  $("#side").innerHTML = rows.join("");
}

function renderTop() {
  const p = sel === "all" ? null : proj(sel);
  $("#title").textContent = p ? p.name : "All projects";
  const needs = D.needs.filter(inProj).length, run = D.running.filter(inProj).length;
  const next = D.upcoming.filter(inProj)[0];
  $("#sub").textContent = [needs ? (needs === 1 ? "1 item needs you" : `${needs} need you`) : "Nothing needs you", run ? `${run} running` : "", next ? `next: ${next.name}, ${until(next.at)}` : ""].filter(Boolean).join(" · ");
}

function renderStrip() {
  const s = D.scheduler, start0 = new Date(); start0.setHours(0, 0, 0, 0);
  const ups = D.upcoming.filter(inProj).filter((u) => u.at < start0.getTime() + 7 * DAY);
  const nextAny = D.workflows.filter(inProj).filter((w) => w.next).sort((a, b) => a.next - b.next)[0];
  const missed = s.missed.filter((m) => sel === "all" || wfOf(m.workflowId)?.projectKey === sel);
  const health = `<span><span class="led ${s.ok ? "" : "off"}"></span>${s.ok ? "Scheduler running" : "Scheduler not running"} · ${esc(s.timezone)}</span>` +
    (s.ok ? "" : `<span class="err">Start it with node server.mjs</span>`) +
    (missed.length || s.offlineGapMs ? `<button data-act="scheduler">${missed.length ? `${missed.length} missed while offline` : "was offline"}</button>` : `<button data-act="scheduler">Details</button>`);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const cols = [];
  for (let i = 0; i < 7; i++) {
    const d0 = start.getTime() + i * DAY; const d = new Date(d0);
    const items = ups.filter((u) => { const x = new Date(u.at); x.setHours(0, 0, 0, 0); return x.getTime() === new Date(d0).setHours(0, 0, 0, 0); });
    cols.push(`<div class="day${i === 0 ? " today" : ""}${items.length ? "" : " empty"}"><h3>${i === 0 ? "Today" : i === 1 ? "Tomorrow" : WD[d.getDay()]} <span class="nothing">${d.getDate()}</span></h3>${items.slice(0, 2).map((u) => `<button class="slot" data-act="wf" data-id="${u.workflowId}" data-focus="schedule" title="${esc(u.name)} · ${esc(proj(u.projectKey).name)}">${mark(u.projectKey, "sm")}<b>${hm(u.at)}</b><span>${esc(u.name)}</span></button>`).join("")}${items.length > 2 ? `<button class="slot slot-more" data-act="scheduler" title="${esc(items.slice(2).map((u) => `${hm(u.at)} ${u.name}`).join(", "))}">+${items.length - 2} more</button>` : ""}</div>`);
  }
  $("#strip").innerHTML = `<div class="strip-head"><h2>Up next</h2><div class="health">${health}</div></div>` + (ups.length ? `<div class="days">${cols.join("")}</div>` : `<p class="nothing">${nextAny ? `Nothing in the next 7 days. Next: ${esc(nextAny.name)}, ${new Date(nextAny.next).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${hm(nextAny.next)}` : "No scheduled runs. Open a workflow to add a schedule."}</p>`);
}

function actsFor(it, inNeeds) {
  const out = [];
  const pr = it.primary;
  const cls = inNeeds ? "btn primary" : "btn";
  if (pr) {
    if (pr.act === "href") out.push(`<a class="${cls}" href="${esc(pr.href)}" target="_blank" rel="noopener noreferrer">${esc(pr.label)}</a>`);
    else if (pr.act === "terminal") out.push(`<button class="${cls}" data-act="terminal" data-session="${esc(pr.sessionId)}">${esc(pr.label)}</button>`);
    else if (pr.act === "copy") out.push(`<button class="${cls}" data-act="copy" data-value="${esc(pr.value)}">${esc(pr.label)}</button>`);
    else if (pr.act === "rerun") out.push(`<button class="${cls}" data-act="rerun" data-id="${esc(it.workflowId)}">${esc(pr.label)}</button>`);
    else if (pr.act === "dismiss") out.push(`<button class="${cls}" data-act="dismiss" data-key="${esc(it.key)}">${esc(pr.label)}</button>`);
    else out.push(`<button class="${cls}" data-act="open" data-id="${esc(it.id)}">${esc(pr.label)}</button>`);
  }
  if (inNeeds && it.kind === "session" && it.label !== "Needs approval") { out.unshift(`<button class="btn primary" data-act="open" data-id="${esc(it.id)}">Answer here</button>`); out[1] = out[1]?.replace('btn primary', 'btn'); }
  if (it.kind === "run" && ["done", "failed", "stopped", "rejected"].includes(it.status) && pr?.act !== "rerun" && wfOf(it.workflowId)) out.push(`<button class="btn" data-act="rerun" data-id="${esc(it.workflowId)}">Run again</button>`);
  if (it.kind === "session" && !inNeeds) out.push(`<button class="btn" data-act="save-session" data-id="${esc(it.id)}">Save as workflow</button>`);
  if (inNeeds && (it.kind === "pr" || it.kind === "issue" || it.kind === "external")) out.push(`<button class="btn ghost" data-act="dismiss" data-key="${esc(it.key)}">Handled</button>`);
  return out.join("");
}

function row(it, inNeeds) {
  const isReport = it.kind === "run" && it.primary?.act === "href";
  const title = isReport ? `<a class="tl" href="${esc(it.primary.href)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : `<button class="tl" data-act="open" data-id="${esc(it.id)}">${esc(it.title)}</button>`;
  const when = it.status === "running" || it.status === "queued" ? `since ${ago(it.ts)}`.replace("since just now", "just started") : ago(it.ts);
  return `<article class="row ${inNeeds ? "big" : ""}">${mark(it.projectKey)}<div style="min-width:0"><div class="rtitle">${title}</div>
    <div class="rmeta">${chip(it)}${sel === "all" ? `<span class="pname-s">${esc(proj(it.projectKey).name)}</span>` : ""}${prof(it.profile)}${it.ts ? `<time title="${esc(full(it.ts))}">${when}</time>` : ""}${it.late ? `<span>caught up late</span>` : ""}</div>
    ${it.line ? `<p class="rline">${esc(clip(it.line, 240))}</p>` : ""}${inNeeds && it.kind === "session" && it.options?.length ? `<div class="opts" role="group" aria-label="Suggested answers">${it.options.slice(0, 4).map((o, i) => `<button type="button" class="opt" data-act="pick-open" data-id="${esc(it.id)}" data-i="${i}">${esc(o.label)}</button>`).join("")}</div>` : ""}</div><div class="acts">${actsFor(it, inNeeds)}</div></article>`;
}

// ---------------------------------------------------------------- board (Recap style: one card per project, compact rows)
const stateOf = (it) => (it.kind === "run" ? it.status : it.label === "Running" || it.status === "running" ? "live" : it.kind === "session" && (it.label === "Asked you" || it.label === "Needs approval") ? "needs_input" : it.kind === "session" ? "answered" : "needs_review");
function srow(it, inNeeds) {
  const isReport = it.kind === "run" && it.primary?.act === "href";
  const title = isReport ? `<a class="tt" href="${esc(it.primary.href)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : `<button class="tt" data-act="open" data-id="${esc(it.id)}">${esc(it.title)}</button>`;
  const when = it.status === "running" || it.status === "queued" ? `since ${ago(it.ts)}`.replace("since just now", "just started") : ago(it.ts);
  const all = actsFor(it, inNeeds).match(/<(?:button|a)\b[^>]*>.*?<\/(?:button|a)>/g) || []; // compact rows: a finished item keeps only its main action; the rest is in its panel
  const acts = (inNeeds ? all.slice(0, 2) : all.slice(0, 1)).join("").replace(/class="btn( primary| ghost)?"/g, (m, k) => `class="btn sm${k || ""}"`);
  const opts = inNeeds && it.kind === "session" && it.options?.length ? `<div class="opts" role="group" aria-label="Suggested answers">${it.options.slice(0, 4).map((o, i) => `<button type="button" class="opt" data-act="pick-open" data-id="${esc(it.id)}" data-i="${i}">${esc(o.label)}</button>`).join("")}</div>` : "";
  return `<article class="srow s-${stateOf(it)}"><span class="dot" aria-hidden="true"></span><div class="t">${title}${chip(it)}${prof(it.profile)}</div><div class="go">${it.ts ? `<time class="when" title="${esc(full(it.ts))}">${when}</time>` : ""}${acts}</div>${it.line ? `<p class="lo">${esc(clip(it.line, 240))}</p>` : ""}${opts}</article>`;
}

function pcard(key, p, { needs, running, results }, limit) {
  const next = D.workflows.filter((w) => w.projectKey === key && w.next && w.schedule.enabled && !w.paused).sort((a, b) => a.next - b.next)[0];
  const rows = (list, inNeeds, n) => list.slice(0, n).map((i) => srow(i, inNeeds)).join("");
  let left = limit;
  const nRows = Math.min(needs.length, left); left -= nRows;
  const rRows = Math.min(running.length, Math.max(left, 0)); left -= rRows;
  const dRows = Math.min(results.length, Math.max(left, 0));
  const hidden = needs.length + running.length + results.length - nRows - rRows - dRows;
  return `<section class="pc${sel === key ? " sel" : ""}" aria-label="${esc(p.name)}"><header class="pc-head">${mark(key, "sm")}<button class="pc-name" data-act="project" data-id="${esc(key)}" title="${esc(p.name)}">${esc(p.name)}</button>
    <span class="pc-meta">${needs.length ? `<span class="u">${needs.length === 1 ? "1 needs you" : `${needs.length} need you`}</span>` : ""}${running.length ? `<span class="l">${running.length} running</span>` : ""}${!needs.length && !running.length ? `<span>${results.length} recent</span>` : ""}</span></header>
    ${next ? `<div class="pc-up">${sym("i-clock")}<span>Scheduled: <b>${esc(next.name)}</b> ${esc(until(next.next))}</span></div>` : ""}
    ${nRows ? `<div class="per">Needs you</div>${rows(needs, true, nRows)}` : ""}${rRows ? `<div class="per">Running</div>${rows(running, false, rRows)}` : ""}${dRows ? `<div class="per">Recent</div>${rows(results, false, dRows)}` : ""}
    ${hidden > 0 && sel === "all" ? `<button class="more" data-act="project" data-id="${esc(key)}">Show ${hidden} more</button>` : ""}</section>`;
}

function renderRuns() {
  const bucket = (list) => { const m = {}; for (const i of list.filter(inProj)) (m[i.projectKey] ||= []).push(i); return m; };
  const N = bucket(D.needs), R = bucket(D.running), H = bucket(D.results);
  const g = proj(sel).git;
  const git = sel !== "all" && g && (g.loose.length || g.recent.length) ? `<details class="git"><summary>Git activity</summary><ul>${g.loose.map((l) => `<li>${esc(l)}</li>`).join("")}${g.recent.map((c) => `<li>${esc(c.title)} <span class="nothing">${ago(c.ts)}</span></li>`).join("")}</ul></details>` : "";
  const older = D.older.filter(inProj);
  const olderHtml = older.length ? `<details class="git"><summary>Older questions from sessions (${older.length})</summary><div class="rows" style="margin-top:8px">${older.slice(0, 20).map((i) => row(i, false)).join("")}</div></details>` : "";
  const keys = D.projects.map((p) => p.key).filter((k) => (sel === "all" || k === sel) && (N[k]?.length || R[k]?.length || H[k]?.length));
  const cards = keys.map((k) => pcard(k, proj(k), { needs: N[k] || [], running: R[k] || [], results: H[k] || [] }, sel === "all" ? 4 : 40));
  $("#runs").innerHTML = (cards.length ? `<div class="rc-grid${sel === "all" ? "" : " single"}">${cards.join("")}</div>` : `<p class="empty">Nothing yet. Run a workflow or start a Claude session and it appears here.</p>`) + git + olderHtml;
}

function renderLib() {
  const list = D.workflows.filter(inProj).sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || a.name.localeCompare(b.name));
  const cards = list.map((w) => {
    const sched = w.schedule.enabled ? (w.paused ? `${w.scheduleText} · paused` : `${w.scheduleText}${w.next ? ` · next ${until(w.next)}` : ""}`) : "No schedule";
    const main = w.open ? `<button class="btn sm" data-act="open" data-id="${esc(w.open)}">View run</button>` : `<button class="btn sm run" data-act="run" data-id="${w.id}" ${w.missing.length ? "" : ""}>Run</button>${w.inputs.length ? `<button class="btn sm" data-act="inputs" data-id="${w.id}">Edit inputs and run</button>` : ""}`;
    const pause = w.schedule.enabled ? `<button class="btn sm ghost" data-act="${w.paused ? "resume-sched" : "pause-sched"}" data-id="${w.id}">${w.paused ? "Resume schedule" : "Pause schedule"}</button>` : "";
    return `<div class="card"><div class="card-top">${ticon(w.icon)}<div style="min-width:0"><button class="cname" data-act="wf" data-id="${w.id}" title="Edit workflow">${esc(w.name)}</button><div class="cmeta">${sel === "all" ? `${mark(w.projectKey, "sm")}<span>${esc(proj(w.projectKey).name)}</span> · ` : ""}<span>${esc(sched)}</span></div></div></div>
      ${w.missing.length ? `<p class="warnline">${sym("i-plug")}<span>${esc(w.missing.map((m) => m.label).join(", "))} not connected</span></p>` : ""}
      ${w.review.enabled ? `<p class="cmeta" style="margin-top:4px">Asks you before it publishes</p>` : ""}
      <div class="cacts">${main}${pause}</div></div>`;
  });
  $("#lib").innerHTML = `<h2>Workflows <span class="n nothing">${list.length || ""}</span></h2><div class="cards">${cards.join("") || `<p class="empty">No saved workflows${sel === "all" ? "" : " for this project"}. Use "Save as workflow" on a past session.</p>`}</div><p style="margin-top:10px"><button class="btn sm" data-act="new">New workflow</button></p>`;
}

function render() {
  if (!D) return;
  if (sel !== "all" && !D.projects.some((p) => p.key === sel)) sel = "all";
  renderSide(); renderTop(); renderStrip(); renderRuns(); renderLib();
}

// ---------------------------------------------------------------- data
async function load(force = false) {
  const d = await api(`/api/overview${force ? "?refresh=1" : ""}`);
  const s = JSON.stringify({ ...d, now: 0, scheduler: { ...d.scheduler, lastTick: 0 } });
  const changed = s !== sig; sig = s; D = d;
  if (changed || force) { render(); if (panel?.type === "run" && !editingInPanel()) refreshRunPanel(); }
  schedulePoll();
}
function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(() => load().catch(() => {}), D && (D.running.length || panel?.type === "run") ? 4000 : 20000); }
const editingInPanel = () => $("#panel").contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

// ---------------------------------------------------------------- panel
function openPanel(p) {
  opener = document.activeElement; panel = p; logAfter = 0; runData = null;
  $("#panel").hidden = false; $("#scrim").hidden = false;
  history.replaceState(null, "", p.type === "run" ? `#run=${p.id}` : p.type === "wf" && p.id ? `#wf=${p.id}` : "#");
  renderPanel(); $("#panel").focus({ preventScroll: true }); requestAnimationFrame(() => { $("#panel").scrollTop = 0; if (p.focus) $("#panel").querySelector(`[data-section="${p.focus}"]`)?.scrollIntoView({ block: "start" }); });
}
function closePanel() {
  if (!panel) return; panel = null; runData = null;
  $("#panel").hidden = true; $("#scrim").hidden = true; history.replaceState(null, "", location.pathname + location.search);
  (opener && document.contains(opener) ? opener : $("#main")).focus?.({ preventScroll: true }); // scroll position stays where it was
  schedulePoll();
}
const head = (title, sub, close = true) => `<div class="phead"><div><h2 id="panel-title">${esc(title)}</h2><div class="rmeta">${sub}</div></div>${close ? `<button class="btn ghost" data-act="close" aria-label="Close">Close <span class="nothing">Esc</span></button>` : ""}</div>`;

function renderPanel() {
  const el = $("#panel");
  if (panel.type === "run") { el.innerHTML = head("Loading…", "") + `<div class="pbody"><p class="empty">Loading…</p></div>`; return refreshRunPanel(); }
  if (panel.type === "wf") return (el.innerHTML = workflowPanel(panel.id ? wfOf(panel.id) : panel.prefill || {}, panel.id));
  if (panel.type === "ask") { el.innerHTML = askPanel(); $("#ask-q")?.focus(); return; }
  if (panel.type === "notify") { el.innerHTML = head("Notifications", "") + `<div class="pbody"><p class="empty">Loading…</p></div>`; return loadNotify(); }
  if (panel.type === "scheduler") return (el.innerHTML = schedulerPanel());
  if (panel.type === "session") return (el.innerHTML = sessionPanel(panel.item));
}

// ---- notifications
async function loadNotify(fresh) {
  try {
    const n = fresh || await api("/api/notify"); if (panel?.type !== "notify") return;
    const url = n.phone.on ? `${n.phone.server}/${n.phone.topic}` : "";
    const kinds = { approval: "a permission waiting for your approval", question: "a question a session asked you", review: "a run waiting for your review", failed: "a failed run" };
    $("#panel").innerHTML = head("Notifications", n.disabled ? `<span class="chip mute">Off in config.json</span>` : `<span class="chip ok">${sym("i-check")}On</span>`) + `<div class="pbody">
      <div class="sec"><h3>You are told about</h3><ul style="margin:0;padding-left:18px">${n.events.map((e) => `<li>${esc(kinds[e] || e)}</li>`).join("")}</ul></div>
      <div class="sec"><h3>This computer</h3><p>${n.desktop ? `A desktop popup appears (${n.platform === "darwin" ? "macOS notification" : "notify-send"}). It shows the project and the question, and stays on this machine.` : "Desktop popups are off."}</p></div>
      <div class="sec"><h3>Your phone</h3>${n.phone.on ? `
        <p>Phone alerts are <b>on</b>. To receive them:</p>
        <ol style="margin:0 0 8px;padding-left:18px"><li>Install the free <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer">ntfy</a> app (iPhone or Android).</li><li>Subscribe to this topic: <code>${esc(n.phone.topic)}</code></li><li>Press <b>Send test</b>.</li></ol>
        <p><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a></p>
        <p class="hint">Alerts say only “Claude needs you”: no project names or text leave this computer. They pass through ${esc(n.phone.server)}, and anyone who knows the topic can read them, so keep it private.</p>
        <div class="inline"><button class="btn primary" data-act="notify-test">Send test</button>${n.phone.fromConfig ? "" : `<button class="btn" data-act="notify-off">Turn off phone alerts</button>`}</div>` : `
        <p>Get an alert on your phone when something needs you, even when you are away from this computer. One click creates a private topic; you subscribe to it in the free ntfy app.</p>
        <p class="hint">Nothing is sent until you set this up. Alerts carry only “Claude needs you”, never project names or text, and they pass through ntfy.sh (or your own server).</p>
        <div class="inline"><button class="btn primary" data-act="notify-on" ${n.disabled ? "disabled" : ""}>Set up phone alerts</button></div>`}</div>
      <p class="hint">Change what is sent or turn everything off with <code>notify</code> in config.json.</p></div>`;
  } catch (e) { $("#panel").innerHTML = head("Notifications", "") + `<div class="pbody"><p class="err">${esc(e.message)}</p></div>`; }
}

// ---- run detail
async function refreshRunPanel() {
  const id = panel.id;
  try {
    const j = await api(`/api/runs/${id}`);
    if (panel?.id !== id) return;
    const old = $("#panel");
    const keep = { scroll: old.scrollTop, open: [...old.querySelectorAll("details[open]")].map((d) => d.dataset.k) };
    runData = j; old.innerHTML = runPanel(j);
    keep.open.forEach((k) => { const d = old.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; });
    old.scrollTop = keep.scroll;
    const hist = await api(`/api/workflows/${j.run.workflowId}/runs`).catch(() => []);
    const h = $("#hist"); if (h) h.innerHTML = hist.map((r) => `<button data-act="open" data-id="${r.id}" aria-current="${r.id === id}"><span>${ago(r.ts)}</span><span>${esc(clip(r.line || r.label, 70))}</span>${chip(r)}</button>`).join("");
  } catch (e) { $("#panel").innerHTML = head("Run", "") + `<div class="pbody"><p class="err">${esc(e.message)}</p></div>`; }
}

function inputsUsed(run) {
  const rows = Object.entries(run.inputs || {}).map(([k, v]) => typeof v === "object" ? `<dt>${esc(k)}</dt><dd>${esc(v.from)} to ${esc(v.to)} (${v.days} days)<br><span class="nothing">previous: ${esc(v.previous.from)} to ${esc(v.previous.to)} · resolved ${esc(full(Date.parse(v.resolvedAt)))}</span></dd>` : `<dt>${esc(k)}</dt><dd>${esc(v) || "—"}</dd>`);
  return rows.length ? `<dl class="kv">${rows.join("")}</dl>` : `<p class="nothing">No inputs.</p>`;
}

function runPanel({ run, log }) {
  const w = wfOf(run.workflowId), active = run.status === "running" || run.status === "queued";
  const [cls, icon] = CHIPS[run.status] || ["mute", "i-clock"];
  const label = { needs_review: "Review needed", needs_input: "Question", blocked: "Not connected", running: "Running", queued: "Queued", done: "Done", failed: "Failed", rejected: "Rejected", stopped: "Stopped" }[run.status];
  let decide = "";
  if (run.status === "needs_review") decide = `<div class="box decide" data-section="decision"><p class="q">${esc(run.decision.text)}</p><p class="hint">After you approve, it will: ${esc(run.decision.action)}</p>
    ${run.result?.primary ? `<p style="margin:8px 0"><a href="/runs/${run.id}/report" target="_blank" rel="noopener">Read the draft</a></p>` : ""}
    <div class="field"><label for="note">Note (optional)</label><input type="text" id="note"></div><div class="inline"><button class="btn primary" data-act="approve" data-id="${run.id}">Approve and continue</button><button class="btn" data-act="reject" data-id="${run.id}">Reject</button></div></div>`;
  if (run.status === "needs_input") decide = `<div class="box decide" data-section="decision"><p class="q">${esc(run.decision.text)}</p><div class="field"><label for="answer">Your answer</label><textarea id="answer" style="min-height:70px"></textarea></div><button class="btn primary" data-act="answer" data-id="${run.id}">Send answer and continue</button></div>`;
  if (run.status === "blocked") decide = `<div class="box decide" data-section="decision"><p class="q">Not started: something is not connected</p><dl class="kv">${run.blocker.missing.map((m) => `<dt>${esc(m.label)}</dt><dd>${esc(m.detail)}${m.fix ? `<br><span class="hint">${esc(m.fix)}</span>` : ""}</dd>`).join("")}</dl><p style="margin-top:10px"><button class="btn primary" data-act="rerun" data-id="${run.workflowId}">Check again</button></p></div>`;
  if (run.status === "failed") decide = `<div class="box decide"><p class="q">It stopped with an error</p><pre class="txt">${esc(run.error || "")}</pre></div>`;

  const controls = [];
  if (w && !active) controls.push(`<button class="btn" data-act="rerun" data-id="${run.workflowId}">Run again</button>`, w.inputs.length ? `<button class="btn" data-act="inputs" data-id="${run.workflowId}">Edit inputs and run</button>` : "");
  if (["failed", "stopped"].includes(run.status) && run.segments.length) controls.push(`<button class="btn" data-act="resume" data-id="${run.id}" title="Continue the same Claude session">Resume</button>`);
  if (active) controls.push(`<button class="btn" data-act="restart" data-id="${run.id}">Restart</button>`, `<button class="btn danger" data-act="stop" data-id="${run.id}">Stop</button>`);
  if (!active && run.status === "stopped" && !run.replacedBy) controls.push(`<button class="btn" data-act="restart" data-id="${run.id}">Restart</button>`);

  const files = run.result?.files?.length ? run.result.files.map((f) => `<li><a href="/runs/${run.id}/${/\.md$/.test(f) ? `report?file=${encodeURIComponent(f)}` : `files/${f.split("/").map(encodeURIComponent).join("/")}`}" target="_blank" rel="noopener">${esc(f)}</a></li>`).join("") : "";
  const result = run.result ? `<div class="sec" data-section="result"><h3>Result</h3><div class="box"><p style="font-weight:600">${esc(run.result.finding)}</p>${run.result.primary ? `<p style="margin-top:8px"><a class="btn primary" href="/runs/${run.id}/report" target="_blank" rel="noopener">Open report</a></p>` : ""}${files ? `<ul style="margin:8px 0 0;padding-left:18px">${files}</ul>` : ""}<p class="hint" style="margin-top:6px">Kept in ${esc(run.outputDir)}</p></div></div>` : "";
  const chain = [run.replaces ? `<button class="btn sm" data-act="open" data-id="${run.replaces}">Replaces earlier attempt</button>` : "", run.replacedBy ? `<button class="btn sm" data-act="open" data-id="${run.replacedBy}">Replaced by a restart</button>` : ""].join(" ");
  const logHtml = log.map((l) => `<span class="logl ${l.kind}">${esc(l.kind === "tool" ? "▸ " + l.text : l.text)}</span>`).join("");
  return head(run.workflowName, `${mark(run.projectKey, "sm")}<span>${esc(proj(run.projectKey).name)}</span>${prof(run.profile)}<span class="chip ${cls}">${sym(icon)}${label}</span><time title="${esc(full(run.endedAt || run.createdAt))}">${ago(run.endedAt || run.startedAt || run.createdAt)}</time>`) +
    `<div class="pbody">${decide}${controls.filter(Boolean).length ? `<div class="inline" id="ctl">${controls.join("")}</div><div id="inputs-form"></div>` : ""}${chain ? `<div class="inline">${chain}</div>` : ""}${result}
    <div class="sec"><h3>Inputs used</h3><div class="box">${inputsUsed(run)}</div></div>
    <details class="sec" data-k="log" ${active ? "open" : ""}><summary>Progress${active ? ` · ${run.activity.steps} steps${run.activity.last ? ` · ${esc(clip(run.activity.last, 60))}` : ""}` : ""}</summary><pre class="log">${logHtml || '<span class="nothing">No output yet.</span>'}</pre></details>
    <details class="sec" data-k="instr"><summary>Instructions sent</summary><pre class="txt">${esc(run.instructions)}</pre><p class="hint" style="margin-top:6px">Tools: ${esc(["Read", "Glob", "Grep", "Write (output folder)", ...run.tools].join(", "))} · ${esc(run.trigger)}${run.scheduledFor ? ` · scheduled for ${esc(full(run.scheduledFor))}` : ""}</p></details>
    <details class="sec" data-k="hist" open><summary>History of this workflow</summary><div class="hist" id="hist"></div></details></div>`;
}

// ---- workflow form
function workflowPanel(w, id) {
  const sc = w.schedule || { enabled: false, days: [], time: "08:00", missed: "latest" };
  const tools = w.allowedTools || [];
  const presetTools = new Set((D.tools || []).flatMap((p) => p.tools));
  const other = tools.filter((t) => !presetTools.has(t));
  const projects = D.projects.map((p) => `<option value="${esc(p.key)}" ${p.key === (w.projectKey || (sel !== "all" ? sel : "")) ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const rv = w.review || { enabled: false };
  const inRow = (i = { name: "", label: "", type: "text" }) => `<div class="irow"><input type="text" placeholder="name (period)" value="${esc(i.name)}" data-f="in-name" aria-label="Input name"><input type="text" placeholder="label" value="${esc(i.label)}" data-f="in-label" aria-label="Input label"><select data-f="in-type" aria-label="Type"><option value="text" ${i.type !== "period" ? "selected" : ""}>Text</option><option value="period" ${i.type === "period" ? "selected" : ""}>Period</option></select><input type="text" placeholder="${i.type === "period" ? "days" : "default"}" value="${esc(i.type === "period" ? i.days : i.default ?? "")}" data-f="in-val" aria-label="Default"></div>`;
  return head(id ? w.name : w.fromSession ? "Save as workflow" : "New workflow", id ? `${mark(w.projectKey, "sm")}<span>${esc(proj(w.projectKey).name)}</span>` : w.fromSession ? `<span>Review the instructions, project and inputs before saving</span>` : "") +
    `<form class="pbody" id="wf-form" data-id="${esc(id || "")}" data-from="${esc(w.fromSession || "")}" novalidate>
    <div class="field"><label for="f-name">Name</label><input type="text" id="f-name" value="${esc(w.name || "")}" maxlength="60" placeholder="Weekly search performance"></div>
    <div class="field"><span class="lab">Icon</span><div class="icons">${ICONS.map((n) => `<label title="${ICON_NAMES[n]}"><input type="radio" name="icon" value="${n}" ${(w.icon || "chart") === n ? "checked" : ""}>${ticon(n)}<span class="sr">${ICON_NAMES[n]}</span></label>`).join("")}</div></div>
    <div class="field"><label for="f-proj">Project</label><select id="f-proj">${projects}</select></div>
    <div class="field"><label for="f-folder">Project folder</label><input type="text" id="f-folder" value="${esc(w.folder || "")}" placeholder="same as the project"><span class="hint">Claude runs here and can read it.</span></div>
    <div class="field"><label for="f-instr">Instructions</label><textarea id="f-instr" style="min-height:170px">${esc(w.instructions || "")}</textarea><span class="hint">Use {{period}}, {{period.previous}}, {{today}} or your own inputs.</span></div>
    <div class="sec"><h3>Inputs</h3><div id="inputs-rows">${(w.inputs || []).map(inRow).join("")}</div><button type="button" class="btn sm" data-act="add-input">Add input</button><template id="in-tpl">${inRow()}</template></div>
    <div class="sec" data-section="tools"><h3>Allowed tools</h3><div class="inline" style="margin-bottom:6px">${(D.tools || []).map((p, i) => `<label class="opt"><input type="checkbox" data-preset="${i}" ${p.tools.every((t) => tools.includes(t)) ? "checked" : ""}>${esc(p.label)}</label>`).join("")}</div>
      <input type="text" id="f-tools" value="${esc(other.join(", "))}" placeholder="other tools, comma separated" style="width:100%;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:7px 9px"><span class="hint">Read, Glob, Grep and writing in the output folder are always on. Nothing else runs without being listed.</span></div>
    <div class="sec"><h3>Connections needed</h3><div class="inline">${(D.connections || []).map((c) => `<label class="opt"><input type="checkbox" data-req="${esc(c.id)}" ${(w.requires || []).includes(c.id) ? "checked" : ""}>${esc(c.label)}</label>`).join("") || '<span class="nothing">None defined in config.json</span>'}</div><span class="hint">Existing sign-ins are reused. Credentials are never put in the instructions.</span></div>
    <div class="field"><label for="f-out">Output folder (optional)</label><input type="text" id="f-out" value="${esc(w.outputDir || "")}" placeholder="kept in the dashboard's data folder"><span class="hint">Each run gets its own subfolder, so reruns never overwrite results.</span></div>
    <div class="sec"><h3>Review before it acts</h3><label class="opt"><input type="checkbox" id="f-rv" ${rv.enabled ? "checked" : ""}>Prepare a draft first, then ask me</label>
      <div id="rv-fields" ${rv.enabled ? "" : "hidden"} style="margin-top:8px"><div class="field"><label for="f-rvq">What you decide</label><input type="text" id="f-rvq" value="${esc(rv.question || "")}" placeholder="Publish these 3 posts to Telegram?"></div><div class="field"><label for="f-rva">After you approve, it will</label><textarea id="f-rva" style="min-height:70px">${esc(rv.action || "")}</textarea></div><div class="field"><label for="f-rvt">Extra tools only for that step</label><input type="text" id="f-rvt" value="${esc((rv.tools || []).join(", "))}" placeholder="mcp__telegram"></div></div></div>
    <div class="sec" data-section="schedule"><h3>Schedule</h3><label class="opt"><input type="checkbox" id="f-sc" ${sc.enabled ? "checked" : ""}>Run on a schedule</label>
      <div id="sc-fields" ${sc.enabled ? "" : "hidden"} style="margin-top:8px"><div class="weekdays" role="group" aria-label="Days">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" data-day="${d}" ${(sc.days || []).includes(d) ? "checked" : ""}>${WD[d]}</label>`).join("")}</div><span class="hint">No day ticked = every day.</span>
      <div class="inline" style="margin-top:8px"><label class="field" style="margin:0"><span class="lab">Time</span><input type="time" id="f-time" value="${esc(sc.time || "08:00")}"></label><label class="field" style="margin:0"><span class="lab">If the machine was off</span><select id="f-miss"><option value="latest" ${sc.missed !== "skip" ? "selected" : ""}>Run once when it wakes</option><option value="skip" ${sc.missed === "skip" ? "selected" : ""}>Skip, wait for the next slot</option></select></label></div>
      <label class="opt" style="margin-top:8px"><input type="checkbox" id="f-pause" ${sc.paused ? "checked" : ""}>Paused</label><p class="hint" style="margin-top:6px">Times are ${esc(D.scheduler.timezone)}.${w.next ? ` Next run: ${esc(until(w.next))}.` : ""}</p></div></div>
    <p class="err" id="wf-err" role="alert"></p>
    <div class="inline"><button type="submit" class="btn primary">${id ? "Save changes" : "Save workflow"}</button>${id ? `<button type="button" class="btn danger" data-act="delete-wf" data-id="${id}">Delete</button>` : ""}<button type="button" class="btn ghost" data-act="close">Cancel</button></div>
    ${id ? `<details class="sec" data-k="hist" open><summary>Runs</summary><div class="hist" id="wf-hist"></div></details>` : ""}</form>`;
}
async function fillWfHist(id) { const h = $("#wf-hist"); if (!h) return; const hist = await api(`/api/workflows/${id}/runs`).catch(() => []); h.innerHTML = hist.map((r) => `<button type="button" data-act="open" data-id="${r.id}"><span>${ago(r.ts)}</span><span>${esc(clip(r.line || r.label, 70))}</span>${chip(r)}</button>`).join("") || `<p class="nothing">No runs yet.</p>`; }

function readWorkflowForm(f) {
  const tools = [...f.querySelectorAll("[data-preset]:checked")].flatMap((c) => D.tools[c.dataset.preset].tools).concat($("#f-tools").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
  const inputs = [...f.querySelectorAll(".irow")].map((r) => ({ name: $('[data-f="in-name"]', r).value.trim(), label: $('[data-f="in-label"]', r).value.trim(), type: $('[data-f="in-type"]', r).value, days: $('[data-f="in-val"]', r).value, default: $('[data-f="in-val"]', r).value })).filter((i) => i.name);
  const proj = $("#f-proj").value;
  return {
    id: f.dataset.id || undefined, fromSession: f.dataset.from || undefined, name: $("#f-name").value, icon: f.querySelector("[name=icon]:checked")?.value, projectKey: proj, folder: $("#f-folder").value.trim() || proj,
    instructions: $("#f-instr").value, inputs, allowedTools: [...new Set(tools)], requires: [...f.querySelectorAll("[data-req]:checked")].map((c) => c.dataset.req), outputDir: $("#f-out").value.trim(),
    review: { enabled: $("#f-rv").checked, question: $("#f-rvq").value, action: $("#f-rva").value, tools: $("#f-rvt").value.split(",").map((s) => s.trim()).filter(Boolean) },
    schedule: { enabled: $("#f-sc").checked, paused: $("#f-pause").checked, days: [...f.querySelectorAll("[data-day]:checked")].map((c) => Number(c.dataset.day)), time: $("#f-time").value, missed: $("#f-miss").value },
  };
}

// ---- inputs form (run with changed inputs)
function inputsForm(w, last) {
  const l = last || w.lastInputs || {};
  return `<div class="box" id="inputs-box" data-id="${w.id}"><h3 class="lab" style="margin-bottom:8px">Inputs for this run</h3>${w.inputs.map((i) => {
    const v = l[i.name];
    if (i.type === "period") { const fixed = v?.mode === "fixed"; return `<div class="field" data-in="${esc(i.name)}" data-type="period"><label>${esc(i.label)}</label><div class="inline"><select data-f="mode"><option value="relative" ${fixed ? "" : "selected"}>Last N days (resolved when the run starts)</option><option value="fixed" ${fixed ? "selected" : ""}>Fixed dates</option></select><input type="number" min="1" max="366" data-f="days" value="${esc(v?.days ?? i.days ?? 7)}" style="width:80px" ${fixed ? "hidden" : ""} aria-label="Days"><input type="date" data-f="from" value="${esc(v?.from ?? "")}" ${fixed ? "" : "hidden"} aria-label="From"><input type="date" data-f="to" value="${esc(v?.to ?? "")}" ${fixed ? "" : "hidden"} aria-label="To"></div></div>`; }
    return `<div class="field" data-in="${esc(i.name)}" data-type="text"><label>${esc(i.label)}</label><input type="text" data-f="text" value="${esc(v ?? i.default ?? "")}"></div>`;
  }).join("")}<p class="err" id="in-err" role="alert"></p><div class="inline"><button class="btn primary" data-act="run-inputs" data-id="${w.id}">Run with these inputs</button><button class="btn ghost" data-act="cancel-inputs">Cancel</button></div></div>`;
}
function readInputs(box) {
  const out = {};
  box.querySelectorAll("[data-in]").forEach((el) => {
    if (el.dataset.type === "period") out[el.dataset.in] = $('[data-f="mode"]', el).value === "fixed" ? { mode: "fixed", from: $('[data-f="from"]', el).value, to: $('[data-f="to"]', el).value } : { mode: "relative", days: Number($('[data-f="days"]', el).value) || 7 };
    else out[el.dataset.in] = $('[data-f="text"]', el).value;
  });
  return out;
}

// ---- ask panel: questions about sessions, answered by a read-only agent
let askLast = null; // { html, runId } kept so closing the panel does not lose the answer
const QUICK = ["Summarize what needs me, most urgent first", "Find duplicate or overlapping sessions", "Suggest sessions I can mark as handled", "List actionable items per project"];
function askPanel() {
  const scope = sel === "all" ? "All projects" : proj(sel).name;
  return head("Ask the dashboard", `<span>Scope: ${esc(scope)} · read-only, nothing is deleted</span>`) + `<div class="pbody">
    <div class="inline">${QUICK.map((q) => `<button class="btn sm" data-act="ask-quick" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <div class="field"><label for="ask-q">Your question</label><textarea id="ask-q" style="min-height:80px" placeholder="Which sessions are about the same thing?"></textarea></div>
    <div class="inline"><button class="btn primary" id="ask-go" data-act="ask-go">Ask</button><span class="hint">Uses Claude (${esc(D.askModel || "sonnet")}) and counts toward your usage.</span></div>
    <div id="ask-out" aria-live="polite">${askLast?.html || ""}</div></div>`;
}
const askBusy = (on) => { const b = $("#ask-go"); if (b) b.disabled = on; };
async function askPoll(runId) {
  for (;;) {
    if (panel?.type !== "ask") return;
    let a; try { a = await api(`/api/runs/${runId}/answer`); } catch (e) { $("#ask-out").innerHTML = `<p class="err">${esc(e.message)}</p>`; return askBusy(false); }
    const out = $("#ask-out"); if (!out) return;
    if (a.status === "queued" || a.status === "running") { out.innerHTML = `<p class="chip run spin">${sym("i-run")}Working… ${esc(clip(a.activity?.last || "", 70))}</p>`; await new Promise((r) => setTimeout(r, 1500)); continue; }
    askBusy(false);
    if (a.status !== "done") { out.innerHTML = `<p class="err">${esc(a.error || "The assistant stopped before answering.")}</p>`; return; }
    const acts = a.actions.length ? `<div class="box" style="margin-top:12px"><h3 class="lab" style="margin-bottom:6px">Suggested cleanup: mark as handled</h3>${a.actions.map((x, i) => `<label class="opt" style="display:flex;margin-bottom:4px;border-radius:8px"><input type="checkbox" data-akey="${esc(x.key)}" checked><span><b>${esc(x.title)}</b> ${prof(x.profile)} <span class="nothing">${esc(x.project)}</span><br><span class="hint">${esc(x.reason)}</span></span></label>`).join("")}<p style="margin-top:8px"><button class="btn primary" data-act="ask-apply">Mark ticked as handled</button> <span class="hint">Hides them here. Undo is offered afterwards.</span></p></div>` : "";
    askLast = { html: `<div class="box ask-answer">${a.html}</div>${acts}`, runId }; out.innerHTML = askLast.html; return;
  }
}

// ---- scheduler + session panels
function schedulerPanel() {
  const s = D.scheduler;
  const list = (items, empty) => items.length ? `<ul style="margin:0;padding-left:18px">${items.map((m) => `<li><b>${esc(m.workflow)}</b> · was due ${esc(full(m.at))} <span class="nothing">(${esc(m.reason)})</span></li>`).join("")}</ul>` : `<p class="nothing">${empty}</p>`;
  return head("Scheduler", `<span class="chip ${s.ok ? "ok" : "bad"}">${sym(s.ok ? "i-check" : "i-x")}${s.ok ? "Running" : "Not running"}</span>`) +
    `<div class="pbody"><div class="box"><dl class="kv"><dt>Time zone</dt><dd>${esc(s.timezone)}</dd><dt>Last check</dt><dd>${s.lastTick ? esc(full(s.lastTick)) : "never"} (every ${s.tickSeconds} s)</dd><dt>Next run</dt><dd>${s.next ? `${esc(s.next.workflow)}, ${esc(until(s.next.at))}` : "nothing scheduled"}</dd>${s.offlineGapMs ? `<dt>Offline</dt><dd>${Math.round(s.offlineGapMs / 3600000)} h before this start</dd>` : ""}</dl></div>
    <div class="sec"><h3>Missed runs</h3>${list(s.missed, "None.")}<p class="hint" style="margin-top:6px">${esc(s.catchUp)}</p></div>
    <div class="sec"><h3>Skipped</h3>${list(s.skipped, "None.")}</div></div>`;
}
function replyBox(it) {
  const asking = it?.kind === "session" && Array.isArray(it.detail) && it.detail.length;
  const opts = it?.options || [];
  const chips = opts.length ? `<div class="opts" role="group" aria-label="Suggested answers">${opts.map((o, i) => `<button type="button" class="opt" data-act="pick" data-i="${i}" aria-pressed="false">${esc(o.label)}</button>`).join("")}</div><p class="hint">Click one to fill the answer, edit it if you like, then send.</p>` : "";
  const presets = (D.tools || []).map((t, i) => `<label class="chk"><input type="checkbox" data-rtool="${i}"> ${esc(t.label)}</label>`).join(" ");
  return `<div class="sec" data-section="reply"><h3>${asking ? "Answer from here" : "Reply from here"}</h3>${chips}
    <label class="sr" for="reply-text">Your reply</label><textarea id="reply-text" rows="3" placeholder="${asking ? "Or write your own answer. " : ""}It continues this session in the background."></textarea>
    <div class="inline">${presets ? `<span class="hint">Allow also:</span> ${presets}` : ""}</div>
    <div class="inline"><button class="btn primary" data-act="reply-go">${asking ? "Send answer" : "Send reply"}</button><span class="hint">Runs <code>claude --resume</code> without asking for permissions; it can read files${(D.tools || []).length ? " and use the tools you tick" : ""}. If the session is still open in a terminal, answer it there.</span></div>
    <div id="reply-out" aria-live="polite"></div></div>`;
}
function sessionPanel(it) {
  return head(it.title, `${mark(it.projectKey, "sm")}<span>${esc(proj(it.projectKey).name)}</span>${prof(it.profile)}${chip(it)}<time>${ago(it.ts)}</time>`) +
    `<div class="pbody">${it.detail && Array.isArray(it.detail) && it.kind !== "session" ? "" : ""}${Array.isArray(it.detail) && it.detail.length ? `` : ""}
   ${Array.isArray(it.detail) && it.detail.length && it.kind === "session" ? `<div class="sec" data-k="last"><h3>Claude's message</h3>${renderMarkdown(it.answer || "")}</div>` : `<div class="sec"><h3>Last answer</h3>${renderMarkdown(typeof (it.answer || it.detail || it.line) === "string" ? (it.answer || it.detail || it.line) : "") || '<p class="nothing">Nothing recorded.</p>'}</div>`}
    ${it.sessionId && it.status !== "running" ? replyBox(it) : ""}
    <div class="inline">${it.sessionId ? `<button class="btn${Array.isArray(it.detail) && it.detail.length && it.kind === "session" ? "" : " primary"}" data-act="terminal" data-session="${esc(it.sessionId)}">Open in terminal (${esc(it.profile || "default")})</button>` : ""}<button class="btn" data-act="copy" data-value="${esc(it.resume || "")}">Copy command</button><button class="btn" data-act="save-session" data-id="${esc(it.id)}">Save as workflow</button>${it.kind === "session" && it.key ? `<button class="btn ghost" data-act="dismiss" data-key="${esc(it.key)}">Mark handled</button>` : ""}</div></div>`;
}

// ---------------------------------------------------------------- actions
const allItems = () => [...D.needs, ...D.older, ...D.running, ...D.results];
async function act(el) {
  const a = el.dataset.act, id = el.dataset.id;
  const guard = async (fn) => { if (el.disabled) return; el.disabled = true; try { await fn(); } catch (e) { toast(e.message); if (e.body?.runId) { /* already running */ } } finally { el.disabled = false; } };
  switch (a) {
    case "project": sel = id; localStorage.setItem("project", sel); render(); window.scrollTo(0, 0); break;
    case "close": closePanel(); break;
    case "ask": askLast = null; openPanel({ type: "ask" }); break;
    case "ask-quick": $("#ask-q").value = el.dataset.q; $("#ask-q").focus(); break;
    case "ask-go": return guard(async () => { const q = $("#ask-q").value.trim(); if (!q) { toast("Write a question first"); return; } askBusy(true); $("#ask-out").innerHTML = `<p class="chip run spin">${sym("i-run")}Starting…</p>`; try { const j = await api("/api/ask", { question: q, projectKey: sel }); askPoll(j.run.id); } catch (e) { askBusy(false); $("#ask-out").innerHTML = `<p class="err">${esc(e.message)}</p>`; } });
    case "ask-apply": return guard(async () => { const keys = [...$("#ask-out").querySelectorAll("[data-akey]:checked")].map((c) => c.dataset.akey); for (const key of keys) await api("/api/dismiss", { key }); await load(true); askLast = null; $("#ask-out").innerHTML = `<p>Marked ${keys.length} as handled.</p><button class="btn" data-act="ask-undo" data-keys="${esc(JSON.stringify(keys))}">Undo</button>`; });
    case "ask-undo": return guard(async () => { for (const key of JSON.parse(el.dataset.keys)) await api("/api/dismiss", { key, undo: true }); await load(true); $("#ask-out").innerHTML = "<p>Restored.</p>"; });
    case "open": { const it = allItems().find((i) => i.id === id); if (it && it.kind !== "run") return openPanel({ type: "session", item: it }); openPanel({ type: "run", id: it?.runId || id }); break; }
    case "wf": openPanel({ type: "wf", id, focus: el.dataset.focus }); fillWfHist(id); break;
    case "new": openPanel({ type: "wf", prefill: { projectKey: sel !== "all" ? sel : undefined } }); break;
    case "scheduler": openPanel({ type: "scheduler" }); break;
    case "notify": openPanel({ type: "notify" }); break;
    case "notify-on": return guard(async () => { await loadNotify(await api("/api/notify/phone", { action: "enable" })); toast("Phone alerts are on. Subscribe in the ntfy app."); });
    case "notify-off": return guard(async () => { await loadNotify(await api("/api/notify/phone", { action: "disable" })); toast("Phone alerts are off"); });
    case "notify-test": return guard(async () => { await api("/api/notify/phone", { action: "test" }); toast("Test sent"); });
    case "pick": { const o = panel?.item?.options?.[Number(el.dataset.i)]; if (!o) break; $("#reply-text").value = o.value; document.querySelectorAll("#panel .opt").forEach((b) => b.setAttribute("aria-pressed", String(b === el))); $("#reply-text").focus(); break; }
    case "pick-open": { const it = allItems().find((i) => i.id === id); if (!it) break; openPanel({ type: "session", item: it }); const o = it.options?.[Number(el.dataset.i)]; if (o) { $("#reply-text").value = o.value; document.querySelectorAll("#panel .opt")[Number(el.dataset.i)]?.setAttribute("aria-pressed", "true"); } $("#panel [data-section=reply]")?.scrollIntoView({ block: "center" }); break; }
    case "reply-go": return guard(async () => {
      const it = panel?.item; const text = $("#reply-text").value.trim(); if (!it?.sessionId || !text) { toast("Write a reply first"); return; }
      const tools = [...document.querySelectorAll("[data-rtool]:checked")].flatMap((c) => D.tools[Number(c.dataset.rtool)].tools);
      const out = $("#reply-out"); out.innerHTML = `<p class="chip run spin">${sym("i-run")}Sending…</p>`;
      const j = await api("/api/sessions/reply", { sessionId: it.sessionId, text, tools });
      for (let n = 0; n < 600; n++) {
        const r = await api(`/api/replies/${j.id}`); if (panel?.item !== it) return;
        if (r.state === "running") { out.innerHTML = `<p class="chip run spin">${sym("i-run")}Claude is answering…</p>`; await new Promise((res) => setTimeout(res, 2000)); continue; }
        out.innerHTML = r.state === "done" ? `<h3>Claude replied</h3>${renderMarkdown(r.result || "") || "<p>(no text)</p>"}` : `<p class="err" role="alert">${esc(r.error || "The reply failed.")}</p>`;
        if (r.state === "done") { $("#reply-text").value = ""; load(true).catch(() => {}); }
        return;
      }
    });
    case "terminal": return guard(async () => { const j = await api("/api/sessions/open", { sessionId: el.dataset.session }); toast(`Opened in ${j.terminal} with profile ${j.profile}`); });
    case "copy": await navigator.clipboard?.writeText(el.dataset.value).catch(() => {}); toast("Copied. Paste it in a terminal."); break;
    case "dismiss": return guard(async () => { await api("/api/dismiss", { key: el.dataset.key }); await load(true); if (panel?.type === "session") closePanel(); });
    case "save-session": { const it = allItems().find((i) => i.id === id) || panel?.item; if (!it) break; const w = { name: clip(it.title, 50), projectKey: it.projectKey, folder: it.projectKey, instructions: it.prompt || it.title, fromSession: it.sessionId, icon: "play" }; openPanel({ type: "wf", prefill: w }); break; }
    case "run": case "rerun": return guard(async () => { const j = await api(`/api/workflows/${id}/run`, { requestId: rid(), rerun: a === "rerun" }); toast(j.run.status === "blocked" ? "Not started: something is not connected" : "Started"); await load(true); if (j.run.status === "blocked" || panel?.type === "run") openPanel({ type: "run", id: j.run.id }); });
    case "inputs": { const w = wfOf(id); if (!w) break; if (panel?.type === "run") { $("#inputs-form").innerHTML = inputsForm(w, runData?.run?.supplied); $("#inputs-form [data-f]")?.focus(); } else { openPanel({ type: "wf", id }); fillWfHist(id); $("#panel").insertAdjacentHTML("afterbegin", `<div class="pbody" style="padding-bottom:0">${inputsForm(w)}</div>`); } break; }
    case "cancel-inputs": $("#inputs-box")?.remove(); break;
    case "run-inputs": return guard(async () => { const box = el.closest("#inputs-box"); try { const j = await api(`/api/workflows/${id}/run`, { inputs: readInputs(box), requestId: rid(), rerun: true }); toast("Started"); await load(true); openPanel({ type: "run", id: j.run.id }); } catch (e) { $("#in-err").textContent = e.message; } });
    case "pause-sched": case "resume-sched": return guard(async () => { await api(`/api/workflows/${id}/${a === "pause-sched" ? "pause" : "resume"}`, {}); toast(a === "pause-sched" ? "Schedule paused" : "Schedule resumed"); await load(true); });
    case "stop": return guard(async () => { await api(`/api/runs/${id}/stop`, {}); toast("Stopped"); await load(true); });
    case "restart":
      if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "Stop it and start a replacement?"; el.classList.add("primary"); setTimeout(() => { if (el.isConnected) { delete el.dataset.confirm; el.textContent = "Restart"; el.classList.remove("primary"); } }, 5000); break; }
      return guard(async () => { const j = await api(`/api/runs/${id}/restart`, {}); toast("Old attempt stopped, replacement started"); await load(true); openPanel({ type: "run", id: j.run.id }); });
    case "resume": return guard(async () => { await api(`/api/runs/${id}/resume`, {}); toast("Resumed the same session"); await load(true); refreshRunPanel(); });
    case "answer": return guard(async () => { await api(`/api/runs/${id}/answer`, { text: $("#answer").value }); toast("Answer sent"); await load(true); refreshRunPanel(); });
    case "approve": return guard(async () => { await api(`/api/runs/${id}/approve`, { note: $("#note")?.value }); toast("Approved, continuing"); await load(true); refreshRunPanel(); });
    case "reject": return guard(async () => { await api(`/api/runs/${id}/reject`, { note: $("#note")?.value }); toast("Rejected"); await load(true); refreshRunPanel(); });
    case "add-input": $("#inputs-rows").insertAdjacentHTML("beforeend", $("#in-tpl").innerHTML); $("#inputs-rows .irow:last-child input").focus(); break;
    case "delete-wf":
      if (el.dataset.confirm !== "1") { el.dataset.confirm = "1"; el.textContent = "Delete? Past runs stay"; break; }
      return guard(async () => { await api(`/api/workflows/${id}/delete`, {}); closePanel(); await load(true); toast("Deleted"); });
  }
}

document.addEventListener("click", (e) => {
  if (e.target === $("#scrim")) return closePanel();
  const el = e.target.closest("[data-act]"); if (el) { e.preventDefault(); act(el); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "f-rv") $("#rv-fields").hidden = !e.target.checked;
  if (e.target.id === "f-sc") $("#sc-fields").hidden = !e.target.checked;
  if (e.target.matches('[data-f="mode"]')) { const fixed = e.target.value === "fixed"; const f = e.target.closest("[data-in]"); $('[data-f="days"]', f).hidden = fixed; $('[data-f="from"]', f).hidden = !fixed; $('[data-f="to"]', f).hidden = !fixed; }
  if (e.target.matches('[data-f="in-type"]')) $('[data-f="in-val"]', e.target.closest(".irow")).placeholder = e.target.value === "period" ? "days" : "default";
});
document.addEventListener("submit", async (e) => {
  if (e.target.id !== "wf-form") return; e.preventDefault();
  const btn = $("button[type=submit]", e.target); if (btn.disabled) return; btn.disabled = true;
  try { const { workflow } = await api("/api/workflows", readWorkflowForm(e.target)); toast("Saved"); sel = workflow.projectKey; localStorage.setItem("project", sel); await load(true); openPanel({ type: "wf", id: workflow.id }); fillWfHist(workflow.id); }
  catch (err) { $("#wf-err").textContent = err.message; } finally { btn.disabled = false; }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panel) { closePanel(); return; }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target.id === "reply-text") { e.preventDefault(); document.querySelector('[data-act="reply-go"]')?.click(); return; }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey || panel) return;
  if (/^[0-9]$/.test(e.key) && D) { const k = e.key === "0" ? "all" : D.projects[Number(e.key) - 1]?.key; if (k) { sel = k; localStorage.setItem("project", sel); render(); } }
});
$("#refresh").addEventListener("click", async (e) => { e.target.disabled = true; try { await load(true); toast("Updated"); } finally { e.target.disabled = false; } });
$("#notify").addEventListener("click", () => act({ dataset: { act: "notify" } }));
$("#ask").addEventListener("click", () => act({ dataset: { act: "ask" } }));
$("#new-wf").addEventListener("click", () => act({ dataset: { act: "new" } }));
document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(() => {}); });
setInterval(() => { if (panel?.type === "run" && runData && ["running", "queued"].includes(runData.run.status) && !editingInPanel()) refreshRunPanel(); }, 2000);

// Update notice: the server checks GitHub once a day. Shown until you dismiss this particular update.
async function showUpdate() {
  const u = await api("/api/update").catch(() => null); const box = $("#update");
  if (!u?.available) { box.hidden = true; return; }
  let seen = ""; try { seen = localStorage.getItem("update-dismissed") || ""; } catch { /* private mode */ }
  if (seen === u.latest) { box.hidden = true; return; }
  const list = (u.changes || []).map((c) => `<li>${esc(c)}</li>`).join("");
  box.innerHTML = `<div class="update-head"><div><strong>Update available</strong>: ${u.behind} new change${u.behind === 1 ? "" : "s"} on main. ${u.diverged ? "You have local commits, so run <code>git pull --rebase</code> yourself." : "Run <code>./update.sh</code> in the folder you cloned into."} <a href="${esc(u.url)}" target="_blank" rel="noopener">See what changed</a></div><button class="btn" type="button" id="update-x">Dismiss</button></div>${list ? `<ul>${list}</ul>` : ""}`;
  box.hidden = false;
  $("#update-x").addEventListener("click", () => { try { localStorage.setItem("update-dismissed", u.latest); } catch { /* ignore */ } box.hidden = true; });
}

await load();
showUpdate();
const m = /^#(run|wf)=(\w+)$/.exec(location.hash);
if (m) { openPanel({ type: m[1], id: m[2] }); if (m[1] === "wf") fillWfHist(m[2]); }
// From the recap page: "Save as workflow" opens the form pre-filled; nothing is saved until you press Save.
const sv = /^#save=(.+)$/.exec(location.hash);
if (sv) {
  const d = await api(`/api/recap/session?key=${encodeURIComponent(decodeURIComponent(sv[1]))}`).catch(() => null);
  if (d) openPanel({ type: "wf", prefill: { name: clip(d.title, 50), projectKey: d.projectKey, folder: d.resume?.cwd || d.projectKey, instructions: d.firstPromptFull || d.title, fromSession: d.id, icon: "play" } });
}
