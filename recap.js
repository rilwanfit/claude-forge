// Recap page: where did I leave off, who did the work, what can I resume, rerun or reuse.
import { renderMarkdown } from "/mdview.mjs";
// All transcript text is DATA: it is only ever inserted escaped, never as HTML, and never acted on.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const DAY = 86_400_000;
const two = (n) => String(n).padStart(2, "0");
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

let D = null, sel = localStorage.getItem("recap.project") || null, scope = localStorage.getItem("recap.scope") || "project", query = "", results = null;
let panel = null, opener = null, pollTimer = null;
const expanded = new Set();

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status, body: j });
  return j;
}
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200); }

function ago(ts) {
  if (!ts) return "unknown time";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400); return d === 1 ? "yesterday" : `${d} days ago`;
}
const full = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "unknown");
const hm = (ts) => (ts ? `${two(new Date(ts).getHours())}:${two(new Date(ts).getMinutes())}` : "");
const shortModel = (m) => String(m || "unknown").replace(/^claude-/, "");
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (n) => { const w = String(n).replace(/[^A-Za-z0-9]+/g, " ").trim().split(" "); return (w.length > 1 ? w[0][0] + w[1][0] : String(n).slice(0, 2)).toUpperCase(); };
const mark = (name) => `<span class="mark sm" style="--h:${hue(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
const prof = (name) => (name ? `<span class="prof" style="--h:${hue("p" + name)}" title="Claude profile">${esc(name)}</span>` : "");
const tag = (t, cls = "", title = "") => `<span class="tag ${cls}" ${title ? `title="${esc(title)}"` : ""}>${esc(t)}</span>`;
const unk = (what) => tag(`${what} unknown`, "unk", "Not recorded in the transcript");

// ---------------------------------------------------------------- overview
const currentProject = () => (sel && D?.projects.some((p) => p.key === sel) ? sel : null) ?? D?.projects[0]?.key ?? null;
const projName = (key) => D?.projects.find((p) => p.key === key)?.name || (key ? String(key).split("/").pop() : "?");

function tagsOf(r) {
  const t = [];
  if (r.kind === "run") t.push(tag("workflow run", "wfk", r.trigger ? `Started by: ${r.trigger}` : ""));
  if (r.worktree) t.push(tag(`worktree ${r.worktree.name}`, "wt", `${r.worktree.path}${r.worktree.branch ? ` · branch ${r.worktree.branch}` : ""} (${r.worktree.source})`));
  const ms = r.models || [];
  if (!ms.length) t.push(unk("model"));
  else if (ms.length > 1) t.push(tag(`${ms.length} models`, "multi", ms.map((m) => `${m.id} × ${m.n}`).join("\n")));
  else t.push(tag(shortModel(ms[0].id), "mdl", ms[0].id));
  if (r.modelChanged) t.push(tag("model changed", "multi"));
  if (r.agents?.calls) t.push(tag(`${r.agents.calls} agent${r.agents.calls === 1 ? "" : "s"}`, "", `${r.agents.finished} finished, ${r.agents.unclear} outcome not recorded${r.agents.failed ? `, ${r.agents.failed} failed or stopped` : ""}`));
  for (const w of (r.workflows || []).slice(0, 2)) t.push(tag(`wf ${w.name}: ${w.status}`, "wfk"));
  return t.join(" ");
}
function nextBtn(r) {
  const n = r.next || {};
  const lbl = { resume: n.label === "Answer and resume" ? "Answer & resume" : "Resume", rerun: "Rerun…", run: n.label, handoff: "Handoff…" }[n.kind];
  if (!lbl) return "";
  return `<button class="btn sm go-btn ${n.kind === "resume" || n.kind === "run" ? "primary" : ""}" data-act="next" data-key="${esc(r.key)}" data-kind="${esc(n.kind)}" data-wf="${esc(r.workflowId || "")}" data-run="${esc(r.runId || "")}" title="${esc(n.kind === "resume" ? `Reopens this conversation in its own folder. ${n.detail || ""}` : n.kind === "rerun" ? "Starts a NEW run of the saved workflow; earlier runs and outputs stay" : n.detail || "")}">${esc(lbl)}</button>`;
}
function rowHtml(r) {
  const nx = r.next?.detail && r.next.kind !== "handoff" && r.next.kind !== "none" ? `<br><b>${r.state === "waiting" || r.state === "needs_input" ? "Asked" : "Next"}:</b> ${esc(clip(r.next.detail, 150))}` : "";
  const lo = r.leftOff?.text && r.leftOff.text !== "unknown" ? esc(clip(r.leftOff.text, 170)) : `<span class="nothing">nothing recorded</span>`;
  const src = { recap: "Recap", answer: "Last reply", prompt: "You asked", result: "Result", none: "" }[r.leftOff?.kind] || "";
  return `<div class="srow s-${esc(r.state)}" tabindex="0" role="button" data-act="open" data-key="${esc(r.key)}" data-kind="${esc(r.kind || "session")}" data-run="${esc(r.runId || "")}" aria-label="${esc(r.title)}: ${esc(r.stateLabel)}">
    <span class="dot" aria-hidden="true"></span>
    <div class="t"><span class="tt" title="${esc(r.title)}">${esc(r.title)}</span>${tagsOf(r)}</div>
    <div class="go"><span class="when" title="${esc(full(r.ts))}">${esc(ago(r.ts))}</span>${nextBtn(r)}</div>
    <div class="lo"><span class="st ${esc(r.state)}">${esc(r.stateLabel)}</span> · ${src ? `<b>${esc(src)}:</b> ` : ""}${lo}${nx}</div>
  </div>`;
}
function upcomingText(p) {
  if (!p.upcoming?.length) return "";
  const u = p.upcoming[0]; const d = new Date(u.at); const day = d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString("en-GB", { weekday: "short" });
  return `<div class="pc-up"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Scheduled: <b>${esc(u.name)}</b> ${esc(day)} ${esc(hm(u.at))}${p.upcoming.length > 1 ? ` · +${p.upcoming.length - 1} more this week` : ""}</span></div>`;
}
const CAP = 4;
function cardHtml(p) {
  const all = [...p.today.map((r) => ({ r, per: "Today" })), ...p.week.map((r) => ({ r, per: "This week" }))];
  const open = expanded.has(p.key); const shown = open ? all : all.slice(0, CAP); let last = "", body = "";
  for (const { r, per } of shown) { if (per !== last) { body += `<div class="per">${per}</div>`; last = per; } body += rowHtml(r); }
  const hidden = all.length - shown.length;
  if (!all.length) body = `<p class="nothing" style="padding:8px 12px">No sessions in the last 7 days.</p>`;
  return `<section class="pc ${p.key === currentProject() ? "sel" : ""}" aria-label="${esc(p.name)}">
    <div class="pc-head">${mark(p.name)}<button class="pc-name" data-act="project" data-key="${esc(p.key)}" title="Make this the current project for search">${esc(p.name)}</button>
      <span class="pc-meta">${p.unfinished ? `<span class="u">${p.unfinished} unfinished</span>` : ""}${p.live ? `<span class="l">${p.live} live</span>` : ""}<span>${p.today.length + p.week.length} in 7 days</span></span></div>
    ${upcomingText(p)}${body}${hidden > 0 ? `<button class="more" data-act="more" data-key="${esc(p.key)}">Show ${hidden} more</button>` : open && all.length > CAP ? `<button class="more" data-act="less" data-key="${esc(p.key)}">Show fewer</button>` : ""}</section>`;
}

function renderStrip() {
  const ps = D.projects; const unf = ps.reduce((n, p) => n + p.unfinished, 0), live = ps.reduce((n, p) => n + p.live, 0);
  const ups = ps.flatMap((p) => (p.upcoming || []).map((u) => ({ ...u, project: p.name }))).sort((a, b) => a.at - b.at)[0];
  const ix = D.index; const busy = ix.state === "indexing";
  $("#strip").innerHTML = `<span><b>${unf}</b> unfinished</span><span class="sep">|</span><span><b>${live}</b> live now</span><span class="sep">|</span><span><b>${ps.length}</b> projects active in 7 days</span>
    ${ups ? `<span class="sep">|</span><span>Next scheduled: <b>${esc(ups.name)}</b> (${esc(ups.project)}) ${esc(full(ups.at))}</span>` : `<span class="sep">|</span><span class="nothing">no scheduled runs this week</span>`}
    <span class="idx ${busy ? "busy" : ""}" title="Local index of ${ix.days} days of transcripts. No model is called to build it.">${busy ? `Indexing ${ix.done}/${ix.total}…` : `${ix.sessions} sessions indexed${ix.ms ? ` in ${(ix.ms / 1000).toFixed(1)} s` : ""}`}${ix.unreadable ? ` · <span title="${esc((ix.errors || []).map((e) => `${e.file}: ${e.error}`).join("\n"))}">${ix.unreadable} transcript${ix.unreadable === 1 ? "" : "s"} unreadable</span>` : ""}</span>`;
  $("#scope-project").textContent = `This project (${projName(currentProject())})`;
  $("#scope-project").setAttribute("aria-pressed", String(scope === "project")); $("#scope-all").setAttribute("aria-pressed", String(scope === "all"));
  $("#sub").textContent = results ? `Search: “${results.q}” in ${results.scope === "all" ? "all projects" : projName(results.scope)} · ${results.results.length} sessions of ${results.searched}` : "Today and this week, by project. Unfinished work first.";
}

function resultHtml(r) {
  const row = r.row; const toks = (results.q || "").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const hl = (t) => esc(t).replace(new RegExp(`(${toks.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).map(esc).join("|")})`, "gi"), "<mark>$1</mark>");
  return `<article class="res"><h3><span>${esc(row.title)}</span>${tagsOf(row)}<span class="st ${esc(row.state)}">${esc(row.stateLabel)}</span></h3>
    <div class="rmeta" style="margin-top:2px">${mark(row.projectName)}<span>${esc(row.projectName)}</span>${prof(row.profile)}<span>${esc(full(row.ts))}</span></div>
    ${r.hits.map((h) => `<p class="hit"><span class="k">${esc(h.kind)}</span><span>${hl(h.text)}</span></p>`).join("")}
    <div class="acts"><button class="btn sm" data-act="open" data-key="${esc(r.key)}">Details</button><button class="btn sm primary" data-act="handoff" data-key="${esc(r.key)}">Create handoff</button>${row.canResume ? `<button class="btn sm" data-act="resume" data-key="${esc(r.key)}" title="Reopens this exact conversation">Resume</button>` : ""}</div></article>`;
}

function render() {
  if (!D) return;
  renderStrip();
  const main = $("#main");
  if (results) { main.innerHTML = results.results.length ? results.results.map(resultHtml).join("") : `<p class="empty-state">No session matches “${esc(results.q)}” ${results.scope === "all" ? "in any project" : `in ${esc(projName(results.scope))}`}. ${results.scope !== "all" ? `<button class="btn sm" data-act="search-all">Search all projects</button>` : ""}</p>`; return; }
  if (D.index.state === "indexing" && !D.projects.length) { main.innerHTML = `<p class="empty-state">Reading your transcripts for the first time (${D.index.done}/${D.index.total})…</p>`; return; }
  main.innerHTML = D.projects.length ? `<div class="rc-grid">${D.projects.map(cardHtml).join("")}</div>` : `<p class="empty-state">No Claude sessions in the last 7 days.</p>`;
}

async function load(force = false) {
  D = await api(`/api/recap${force ? "?refresh=1" : ""}`);
  render(); clearTimeout(pollTimer);
  pollTimer = setTimeout(() => load().catch(() => {}), D.index.state === "indexing" ? 1500 : 30_000);
}

async function runSearch() {
  query = $("#q").value.trim();
  if (!query) { results = null; render(); return; }
  const project = scope === "all" ? "all" : currentProject();
  try { results = await api(`/api/recap/search?q=${encodeURIComponent(query)}&project=${encodeURIComponent(project)}`); } catch (e) { toast(e.message); return; }
  render();
}

// ---------------------------------------------------------------- panel
function openPanel(html, p) {
  opener = document.activeElement; panel = p; $("#panel").innerHTML = html; $("#panel").hidden = false; $("#scrim").hidden = false; $("#panel").focus({ preventScroll: true }); $("#panel").scrollTop = 0;
}
function closePanel() { if (!panel) return; panel = null; $("#panel").hidden = true; $("#scrim").hidden = true; (opener && document.contains(opener) ? opener : $("#main")).focus?.({ preventScroll: true }); }
const head = (title, sub) => `<div class="phead"><div><h2 id="panel-title">${esc(title)}</h2><div class="rmeta">${sub}</div></div><button class="btn ghost" data-act="close" aria-label="Close">Close</button></div>`;
const evBtn = (key, ref, label = "source event") => (ref && ref.off != null ? `<button class="evlink" data-act="ev" data-key="${esc(key)}" data-f="${esc(ref.f || "main")}" data-off="${esc(ref.off)}" title="Shows the transcript line this comes from, credentials removed">${esc(label)}</button>` : "");

function nodeHtml(key, n) {
  const kids = n.children?.length ? `<ul>${n.children.map((c) => `<li>${nodeHtml(key, c)}</li>`).join("")}</ul>` : "";
  const stcls = n.state === "finished" ? "answered" : n.state === "failed" ? "failed" : n.state === "stopped" ? "interrupted" : "unknown";
  return `<details><summary><span class="st ${stcls}">${esc(n.state === "unclear" ? "outcome unclear" : n.state)}</span> <b>${esc(clip(n.label, 90))}</b> ${tag(n.type, "")} ${n.model.id === "unknown" ? unk("model") : tag(shortModel(n.model.id), "mdl", `${n.model.id}\n(${n.model.source})`)}${n.worktree ? tag(`worktree ${String(n.worktree.path).split("/").pop()}`, "wt", n.worktree.path) : ""}${n.orphan ? tag("parent call not found", "unk") : ""}${n.noTranscript ? tag("no transcript", "unk", "No subagent transcript file was found for this agent") : ""}</summary>
    <div class="nb"><div>${esc(n.why)} · model: ${esc(n.model.source)}</div>${n.result ? `<span class="res-t">${esc(n.result.text)}</span>${evBtn(key, n.result.ref, "result event")}` : `<div>No result text recorded.</div>`} ${evBtn(key, n.launch, "launch event")}</div>${kids}</details>`;
}
function treeHtml(d) {
  const t = d.tree; const bits = [];
  const modelLine = d.modelsUsed.length ? d.modelsUsed.map((m) => `${shortModel(m.id)} ×${m.n}`).join(", ") : "model unknown";
  bits.push(`<div class="root">Session ${tag(modelLine, "mdl")} ${d.modelChanges.map((c) => `<span class="chg">changed ${esc(shortModel(c.from))} → ${esc(shortModel(c.to))} at ${esc(hm(c.ts))}</span> ${evBtn(d.key, c.ref, "event")}`).join(" ")}</div>`);
  if (t.agents.length) {
    const lis = t.agents.map((n) => `<li>${nodeHtml(d.key, n)}</li>`).join("");
    bits.push(`<ul><li><details ${t.agents.length <= 12 ? "open" : ""}><summary><b>${t.agents.length}</b> agent call${t.agents.length === 1 ? "" : "s"} made by this session</summary><ul>${lis}</ul></details></li>`);
  } else bits.push("<ul>");
  for (const w of t.workflows) {
    const stcls = w.status === "completed" && !w.outcomeNote ? "answered" : w.status === "failed" ? "failed" : "interrupted";
    bits.push(`<li><details><summary><span class="st ${stcls}">${esc(w.status)}</span> <b>Workflow ${esc(w.label)}</b> ${tag(`${w.agentCount ?? "?"} agents`)} ${w.model.id === "unknown" ? unk("model") : tag(shortModel(w.model.id), "mdl", `${w.model.id} (${w.model.source})`)}</summary>
      <div class="nb">${w.summary ? `<div>${esc(w.summary)}</div>` : ""}${w.outcomeNote ? `<div class="notice" style="margin:4px 0">${esc(w.outcomeNote)}</div>` : ""}${w.error ? `<div class="err">${esc(w.error)}</div>` : ""}${w.result ? `<span class="res-t">${esc(w.result.text)}</span>` : "<div>No result recorded.</div>"}${w.scriptPath ? `<div>Script: ${esc(w.scriptPath)}</div>` : ""}</div>
      <ul>${w.phases.map((ph) => `<li><details><summary><b>${esc(ph.title)}</b> ${tag(`${ph.agents.length} agents`)}</summary><div class="nb">${esc(ph.detail || "")}</div><ul>${ph.agents.map((a) => `<li>${nodeHtml(d.key, a)}</li>`).join("")}</ul></details></li>`).join("")}</ul></details></li>`);
  }
  bits.push("</ul>");
  return `<div class="tree">${bits.join("")}</div>`;
}
function timelineHtml(d) {
  const items = [...d.timeline].reverse(); const SHOW = 30;
  const li = (i) => `<li class="k-${esc(i.k)}"><time>${esc(full(i.ts))}</time><span class="kind">${esc(i.k)}</span><span class="tx">${esc(clip(i.text, 260))}</span> ${evBtn(d.key, i.ref, "event")}${i.items && i.items.length > 1 ? `<details><summary class="nothing">show the ${i.items.length} agents</summary>${i.items.map((x) => `<div class="nothing">· ${esc(clip(x.text, 120))} ${evBtn(d.key, x.ref, "event")}</div>`).join("")}</details>` : ""}</li>`;
  return `<ul class="tl">${items.slice(0, SHOW).map(li).join("")}</ul>${items.length > SHOW ? `<details><summary class="hint">Show ${items.length - SHOW} earlier events</summary><ul class="tl">${items.slice(SHOW).map(li).join("")}</ul></details>` : ""}`;
}

function sessionPanel(d) {
  const lo = d.leftOff; const src = { recap: "Recap recorded by Claude Code", answer: "Last answer", prompt: "Your last prompt (no answer after it)", none: "" }[lo.kind] || "";
  const live = d.state === "live";
  const canResume = d.resume?.possible && !d.resumeNote && !live;
  const why = live ? "Already running in a terminal: switch to it instead of opening a second copy." : d.resumeNote || (d.resume?.possible ? `Reopens this exact conversation in ${d.resume.cwd} with profile ${d.profile}.` : d.resume?.reason);
  const simple = !d.tree.agents.length && !d.tree.workflows.length;
  const links = d.run ? `<button class="btn" data-act="rerun" data-wf="${esc(d.run.workflowId || "")}" data-key="${esc(d.key)}" title="Starts a NEW run of the saved workflow; this run and its output stay">Rerun “${esc(clip(d.run.name, 28))}”…</button>` : "";
  return head(d.title, `${mark(d.projectName)}<span>${esc(d.projectName)}</span>${d.worktree ? tag(`worktree ${d.worktree.name}`, "wt", d.worktree.path) : ""}${d.branch ? tag(d.branch, "", "git branch recorded in the transcript") : ""}${prof(d.profile)}<span class="st ${esc(d.state)}" title="${esc(d.stateWhy)}">${esc(d.stateLabel)}</span><time>${esc(ago(d.ts))}</time>`) + `<div class="pbody">
    <div class="sec"><h3>Where it stands</h3><div class="leftoff">${lo.text === "unknown" ? `<span class="nothing">Nothing recorded about the last activity.</span>` : (lo.kind === "answer" || lo.kind === "recap" ? renderMarkdown(lo.text) : esc(lo.text))}</div>
      <div class="leftoff"><span class="src">${esc(src)} · ${esc(full(lo.ts))} ${evBtn(d.key, lo.ref)}</span></div>
      ${d.next?.detail ? `<p style="margin-top:6px"><b>${d.next.kind === "resume" && d.state !== "waiting" ? "Next" : d.next.label}:</b> ${esc(d.next.detail)}</p>` : ""}
      ${d.questions?.length ? `<ul style="margin:6px 0 0;padding-left:18px">${d.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : ""}
      <p class="nothing" style="margin-top:4px">State: ${esc(d.stateWhy)}.</p></div>
    ${d.job ? `<div class="notice">Recorded job state: <b>${esc(d.job.state || "unknown")}</b>${d.job.detail ? ` · ${esc(d.job.detail)}` : ""}</div>` : ""}
    ${d.resumeNote ? `<div class="notice bad">${esc(d.resumeNote)}</div>` : ""}
    <div class="acts-bar">
      <button class="btn primary" data-act="resume" data-key="${esc(d.key)}" ${canResume ? "" : "disabled"} title="${esc(why || "")}">Resume this conversation</button>
      <button class="btn" data-act="handoff" data-key="${esc(d.key)}" title="Start a FRESH session from a short brief of this one">Create handoff…</button>
      ${links}${!d.run ? `<a class="btn" href="/#save=${encodeURIComponent(d.key)}" title="Keep this prompt as a reusable workflow. Until you do, it stays a one-off session.">Save as workflow</a>` : ""}
      <button class="btn ghost" data-act="copy" data-value="cd ${esc(d.resume?.cwd || "")} &amp;&amp; CLAUDE_CONFIG_DIR=${esc(d.profile)} claude --resume ${esc(d.id)}">Copy command</button>
      <span class="why">${esc(why || "")}</span></div>
    <div class="sec"><h3>${simple ? "Models" : "Delegation: who did what, on which model"}</h3>${simple ? `<p>${d.modelsUsed.length ? d.modelsUsed.map((m) => `${esc(shortModel(m.id))} × ${m.n} messages`).join(", ") : "Model unknown."} <span class="nothing">${esc(d.modelsNote)}</span></p>${d.modelChanges.map((c) => `<p class="chg">Changed ${esc(shortModel(c.from))} → ${esc(shortModel(c.to))} at ${esc(full(c.ts))} ${evBtn(d.key, c.ref, "event")}</p>`).join("")}` : `${treeHtml(d)}<p class="nothing" style="margin-top:6px">${esc(d.modelsNote)} “Outcome unclear” means no completion notice or finished flag was recorded.</p>`}</div>
    <div class="sec"><h3>Timeline <span class="nothing" style="text-transform:none;letter-spacing:0">(newest first)</span></h3>${d.timeline.length ? timelineHtml(d) : `<p class="nothing">No events recorded.</p>`}</div>
    ${d.decisions.length ? `<div class="sec"><h3>Decisions you made</h3><ul style="margin:0;padding-left:18px">${d.decisions.map((x) => `<li>${esc(clip(x.question, 200))} → <b>${esc(x.answer || "no answer recorded")}</b> ${evBtn(d.key, x.ref, "event")}</li>`).join("")}</ul></div>` : ""}
    <div class="sec"><h3>Outputs</h3>${d.outputs.files.length || d.outputs.prs.length || d.outputs.artifacts.length ? `<ul style="margin:0;padding-left:18px">${d.outputs.prs.map((p) => `<li>Pull request ${esc(p.repo || "")}${p.number ? ` #${p.number}` : ""} <span class="nothing">${esc(p.url)}</span></li>`).join("")}${d.outputs.artifacts.map((a) => `<li>Artifact: ${esc(a.title)} <span class="nothing">${esc(a.url)}</span></li>`).join("")}${d.outputs.files.slice(0, 12).map((f) => `<li><code>${esc(f.path)}</code> <span class="nothing">written ${f.writes}×</span></li>`).join("")}</ul>${d.outputs.files.length > 12 ? `<p class="nothing">+${d.outputs.files.length - 12} more files</p>` : ""}` : `<p class="nothing">No files, pull requests or artifacts recorded.</p>`}</div>
    ${d.fires?.length ? `<div class="sec"><h3>Scheduled tasks that fired here</h3><ul style="margin:0;padding-left:18px">${d.fires.map((f) => `<li>${esc(full(f.ts))} · ${esc(f.text)} ${f.cron ? `<span class="nothing">cron ${esc(f.cron)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
    <div class="sec"><h3>Not recorded</h3>${d.unknown.length ? `<ul class="unk-list">${d.unknown.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>` : `<p class="nothing">Nothing important is missing.</p>`}</div>
    <details class="sec"><summary>Technical details</summary><dl class="kv"><dt>Session id</dt><dd>${esc(d.id)}</dd><dt>Started</dt><dd>${esc(full(d.firstTs))}</dd><dt>Claude Code</dt><dd>${esc(d.version || "unknown")} · ${esc(d.entrypoint || "unknown")}</dd><dt>Turns</dt><dd>${d.turns} (${d.prompts} prompts${d.compacts ? `, ${d.compacts} compactions` : ""})</dd>
      <dt>Folders</dt><dd>${d.cwdHistory.length ? d.cwdHistory.map((c) => esc(c.cwd)).join("<br>") : "unknown"}</dd><dt>Tools</dt><dd>${esc(Object.entries(d.toolsUsed).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}×${v}`).join(", ") || "none")}</dd>${Object.keys(d.mcpUsed).length ? `<dt>MCP servers</dt><dd>${esc(Object.entries(d.mcpUsed).map(([k, v]) => `${k}×${v}`).join(", "))}</dd>` : ""}${Object.keys(d.skillsUsed).length ? `<dt>Skills</dt><dd>${esc(Object.keys(d.skillsUsed).join(", "))}</dd>` : ""}${d.derivedFrom?.length ? `<dt>Derived from</dt><dd>${d.derivedFrom.map((x) => `${esc(x.id)} (${esc(x.via)})`).join(", ")}</dd>` : ""}${d.continuedIn ? `<dt>Continued in</dt><dd>${esc(d.continuedIn)}</dd>` : ""}${d.cost?.usd != null ? `<dt>Cost recorded</dt><dd>$${Number(d.cost.usd).toFixed(2)}</dd>` : ""}</dl></details></div>`;
}

async function openSession(key) {
  openPanel(head("Loading…", "") + `<div class="pbody"><p class="empty">Loading…</p></div>`, { type: "session", key });
  try { const d = await api(`/api/recap/session?key=${encodeURIComponent(key)}`); if (panel?.key === key) { $("#panel").innerHTML = sessionPanel(d); panel.d = d; } }
  catch (e) { $("#panel").innerHTML = head("Not found", "") + `<div class="pbody"><p class="err">${esc(e.message)}</p></div>`; }
}

// ---------------------------------------------------------------- handoff
let hp = null; // handoff form state
async function openHandoff(key) {
  openPanel(head("Create handoff", "Loading…") + `<div class="pbody"><p class="empty">Reading the session…</p></div>`, { type: "handoff", key });
  let d, c; try { [d, c] = await Promise.all([api(`/api/recap/session?key=${encodeURIComponent(key)}`), api("/api/handoff/candidates", { key })]); } catch (e) { $("#panel").innerHTML = head("Create handoff", "") + `<div class="pbody"><p class="err">${esc(e.message)}</p></div>`; return; }
  hp = { key, d, c };
  const row = (kind, text, src, checked = false) => `<div class="frow"><input type="checkbox" data-hf="${kind}" ${checked ? "checked" : ""} aria-label="Include"><div><textarea rows="${text.length > 120 ? 3 : 2}" data-ht="${kind}">${esc(text)}</textarea>${src ? `<div class="src">${esc(src)}</div>` : ""}</div></div>`;
  $("#panel").innerHTML = head("Create handoff", `${mark(d.projectName)}<span>${esc(d.projectName)}</span>${d.worktree ? tag(`worktree ${d.worktree.name}`, "wt") : ""}${prof(d.profile)}<span>from session ${esc(d.id.slice(0, 8))} · ${esc(full(d.ts))}</span>`) + `<div class="pbody">
    <p class="hint">A handoff starts a <b>fresh</b> Claude session with only what you tick below. Everything is editable. Credentials are removed. Findings are claims recorded in the old session: they are passed on as notes, not as verified facts.</p>
    <div class="field"><label for="h-goal">Goal</label><textarea id="h-goal" rows="2" data-hin="1">${esc(c.goal)}</textarea></div>
    <div class="sec"><h3>Findings to carry over <span class="nothing" style="text-transform:none;letter-spacing:0">(tick the ones you stand behind)</span></h3>
      ${c.findings.length ? `<div class="inline" style="margin-bottom:6px"><button class="btn sm" data-act="hsel" data-v="1">Tick all</button><button class="btn sm" data-act="hsel" data-v="0">Untick all</button></div><div class="fgrid" id="h-findings">${c.findings.map((f) => row("finding", f.text, `${f.source}${f.ref ? "" : ""}`)).join("")}</div>` : `<p class="nothing">No findings could be extracted from this session.</p>`}</div>
    <div class="sec"><h3>Relevant files and links</h3>${c.files.length ? `<div class="fgrid" id="h-files">${c.files.map((f) => row("file", f, "")).join("")}</div>` : `<p class="nothing">No files recorded.</p>`}</div>
    <div class="sec"><h3>Unresolved questions</h3>${c.questions.length ? `<div class="fgrid" id="h-questions">${c.questions.map((q) => row("question", q, "")).join("")}</div>` : `<p class="nothing">None found.</p>`}</div>
    <div class="field"><label for="h-next">Next step</label><textarea id="h-next" rows="2" data-hin="1">${esc(c.next)}</textarea></div>
    <div class="field"><label for="h-profile">Start with Claude profile</label><select id="h-profile">${(D.profiles || []).map((p) => `<option ${p === d.profile ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></div>
    <div class="preview"><div class="inline" style="justify-content:space-between"><h3 class="lab" style="margin:0">Preview: exactly what Claude receives</h3><span class="cnt" id="h-cnt"></span></div><pre class="raw" id="h-pre" aria-live="polite"></pre>
      <p class="err" id="h-err" role="alert"></p><div class="inline" style="margin-top:8px"><button class="btn primary" data-act="hstart" id="h-start">Start fresh session</button><button class="btn" data-act="hcopy">Copy text</button><button class="btn ghost" data-act="open" data-key="${esc(key)}">Back to session</button></div></div></div>`;
  hpreview();
}
function hbody() {
  const picked = (kind) => [...document.querySelectorAll(`#panel [data-hf="${kind}"]`)].filter((c) => c.checked).map((c) => c.closest(".frow").querySelector("[data-ht]").value.trim()).filter(Boolean);
  return { key: hp.key, handoffId: hp.id, goal: $("#h-goal").value, findings: picked("finding"), files: picked("file"), questions: picked("question"), next: $("#h-next").value };
}
let hTimer;
function hpreview() {
  clearTimeout(hTimer);
  hTimer = setTimeout(async () => {
    if (!hp || panel?.type !== "handoff") return;
    try { const p = await api("/api/handoff/preview", hbody()); $("#h-pre").textContent = p.text; $("#h-cnt").textContent = `${p.chars} / ${p.limit} characters`; $("#h-cnt").classList.toggle("over", p.tooLong); $("#h-start").disabled = p.tooLong; $("#h-err").textContent = p.tooLong ? "Too long: untick some findings or shorten the text." : ""; hp.text = p.text; hp.id = p.id; }
    catch (e) { $("#h-err").textContent = e.message; }
  }, 200);
}

// ---------------------------------------------------------------- rerun
const today = () => new Date().toISOString().slice(0, 10);
function inputField(i, v) {
  if (i.type === "period") {
    const fixed = v?.mode === "fixed"; const days = v?.days ?? i.days ?? 7;
    return `<div class="field" data-in="${esc(i.name)}" data-type="period"><label>${esc(i.label)}</label><div class="inline"><select data-f="mode" aria-label="Period type"><option value="relative" ${fixed ? "" : "selected"}>Last N days (resolved when the run starts)</option><option value="fixed" ${fixed ? "selected" : ""}>Fixed dates</option></select>
      <input type="number" min="1" max="366" data-f="days" value="${esc(days)}" ${fixed ? "hidden" : ""} aria-label="Days" style="width:80px"><input type="date" data-f="from" value="${esc(v?.from || "")}" ${fixed ? "" : "hidden"} aria-label="From"><input type="date" data-f="to" value="${esc(v?.to || today())}" ${fixed ? "" : "hidden"} aria-label="To"></div></div>`;
  }
  return `<div class="field" data-in="${esc(i.name)}" data-type="text"><label>${esc(i.label)}</label><input type="text" data-f="text" value="${esc(v ?? i.default ?? "")}"></div>`;
}
function readInputs(box) {
  const out = {};
  box.querySelectorAll("[data-in]").forEach((el) => {
    if (el.dataset.type === "period") out[el.dataset.in] = $('[data-f="mode"]', el).value === "fixed" ? { mode: "fixed", from: $('[data-f="from"]', el).value, to: $('[data-f="to"]', el).value } : { mode: "relative", days: Number($('[data-f="days"]', el).value) || 7 };
    else out[el.dataset.in] = $('[data-f="text"]', el).value;
  });
  return out;
}
async function openRerun(wfId) {
  openPanel(head("Rerun workflow", "Loading…") + `<div class="pbody"><p class="empty">Loading…</p></div>`, { type: "rerun", id: wfId });
  let j; try { j = await api(`/api/recap/workflow?id=${encodeURIComponent(wfId)}`); } catch (e) { $("#panel").innerHTML = head("Rerun workflow", "") + `<div class="pbody"><p class="err">${esc(e.message)}</p></div>`; return; }
  const w = j.workflow;
  $("#panel").innerHTML = head(`Rerun: ${w.name}`, `<span>Saved workflow · ${esc(w.scheduleText || "not scheduled")}</span>${prof(w.profile)}`) + `<div class="pbody">
    <p class="hint">Rerun starts a <b>new run</b> of this saved workflow with the inputs below. Earlier runs, their inputs and their outputs are kept untouched. (To continue an old conversation instead, use Resume.)</p>
    ${j.active ? `<div class="notice">A run is already active. <a href="/#run=${esc(j.active)}">Open it</a>. A second one cannot start until it finishes.</div>` : ""}
    <div class="box" id="rr-box" data-id="${esc(w.id)}"><h3 class="lab" style="margin-bottom:8px">Inputs for the new run</h3>${w.inputs.length ? w.inputs.map((i) => inputField(i, w.lastInputs?.[i.name])).join("") : `<p class="nothing">This workflow has no inputs.</p>`}
      <p class="err" id="rr-err" role="alert"></p><div class="inline"><button class="btn primary" data-act="rr-go" ${j.active ? "disabled" : ""}>Start new run</button><span class="hint">Folder: ${esc(w.folder)}${w.requires?.length ? ` · needs ${esc(w.requires.join(", "))}` : ""}</span></div><div id="rr-out" aria-live="polite"></div></div>
    <details class="sec"><summary>Instructions (what the workflow tells Claude)</summary><pre class="raw">${esc(w.instructions)}</pre></details>
    <div class="sec"><h3>Earlier runs</h3>${j.runs.length ? `<ul class="runlist">${j.runs.map((r) => `<li><div class="rl-h"><span class="st ${esc(r.status)}">${esc(r.label)}</span><span>${esc(full(r.ts))}</span>${r.trigger ? tag(r.trigger) : ""}<a href="/#run=${esc(r.id)}">Open run</a>${r.report ? `<a href="${esc(r.report)}" target="_blank" rel="noopener">Report</a>` : ""}</div><div class="rl-in">${esc(r.inputs || "no inputs")}</div>${r.finding ? `<div>${esc(clip(r.finding, 200))}</div>` : ""}</li>`).join("")}</ul>` : `<p class="nothing">No runs yet.</p>`}</div></div>`;
}

// ---------------------------------------------------------------- actions
async function act(el) {
  const a = el.dataset.act, key = el.dataset.key;
  const guard = async (fn) => { if (el.disabled) return; el.disabled = true; try { await fn(); } catch (e) { toast(e.message); const o = $("#rr-err") || $("#h-err"); if (o && panel) o.textContent = e.message; } finally { el.disabled = false; } };
  switch (a) {
    case "close": return closePanel();
    case "project": sel = key; localStorage.setItem("recap.project", sel); if (scope === "project" && query) await runSearch(); render(); return;
    case "more": expanded.add(key); return render();
    case "less": expanded.delete(key); return render();
    case "open": return openSession(key).then(() => { if (el.dataset.kind === "run" && el.dataset.run) { /* run rows open their session; run detail is one click away */ } });
    case "next": {
      const kind = el.dataset.kind;
      if (kind === "resume") return guard(async () => { const j = await api("/api/sessions/resume", { key }); toast(`Resumed in ${j.terminal} (profile ${j.profile})`); });
      if (kind === "rerun") return openRerun(el.dataset.wf);
      if (kind === "handoff") return openHandoff(key);
      if (kind === "run") { location.href = `/#run=${el.dataset.run}`; return; }
      return;
    }
    case "resume": return guard(async () => { const j = await api("/api/sessions/resume", { key }); toast(`Resumed in ${j.terminal} (profile ${j.profile})`); });
    case "rerun": return openRerun(el.dataset.wf);
    case "handoff": return openHandoff(key);
    case "hsel": document.querySelectorAll('#panel [data-hf="finding"]').forEach((c) => (c.checked = el.dataset.v === "1")); return hpreview();
    case "hcopy": await navigator.clipboard?.writeText(hp?.text || "").catch(() => {}); return toast("Copied exactly what Claude would receive");
    case "hstart": return guard(async () => {
      const j = await api("/api/handoff/start", { ...hbody(), profile: $("#h-profile").value });
      $("#h-err").textContent = ""; toast(`Fresh session started in ${j.terminal} (${j.profile})`);
      $("#h-pre").insertAdjacentHTML("beforebegin", `<p class="notice" role="status">Started in ${esc(j.cwd)} with profile ${esc(j.profile)}. Handoff id <b>${esc(j.id)}</b> (${j.chars} characters). ${j.note ? esc(j.note) : ""}</p>`);
    });
    case "rr-go": return guard(async () => {
      const box = $("#rr-box"); const j = await api(`/api/workflows/${box.dataset.id}/run`, { inputs: readInputs(box), requestId: rid(), rerun: true });
      $("#rr-out").innerHTML = `<p class="notice" role="status">${j.run.status === "blocked" ? "Not started: something is not connected. " : "Started a new run. "}Earlier runs are unchanged. <a href="/#run=${esc(j.run.id)}">Open run ${esc(j.run.id)}</a></p>`; toast(j.run.status === "blocked" ? "Not started: a connection is missing" : "New run started");
      await load(true);
    });
    case "search-all": scope = "all"; localStorage.setItem("recap.scope", scope); return runSearch();
    case "copy": await navigator.clipboard?.writeText(el.dataset.value.replace(/&amp;/g, "&")).catch(() => {}); return toast("Copied. Paste it in a terminal.");
    case "ev": {
      const holder = el.parentElement; let box = holder.querySelector(":scope > pre.raw[data-ev]");
      if (box) { box.remove(); return; }
      try { const j = await api(`/api/recap/event?key=${encodeURIComponent(key)}&f=${encodeURIComponent(el.dataset.f)}&off=${encodeURIComponent(el.dataset.off)}`); el.insertAdjacentHTML("afterend", `<pre class="raw" data-ev="1">${esc(j.text)}</pre>`); }
      catch (e) { toast(e.message); }
    }
  }
}

document.addEventListener("click", (e) => {
  if (e.target === $("#scrim")) return closePanel();
  const el = e.target.closest("[data-act]"); if (!el) return;
  if (el.matches(".srow") && e.target.closest("button, a")) { const b = e.target.closest("button"); if (b && b !== el) { e.stopPropagation(); return act(b); } return; }
  e.preventDefault(); act(el);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && panel) return closePanel();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".srow")) { e.preventDefault(); act(e.target); }
});
document.addEventListener("input", (e) => { if (panel?.type === "handoff" && e.target.closest("#panel")) hpreview(); });
document.addEventListener("change", (e) => {
  if (panel?.type === "handoff" && e.target.closest("#panel")) hpreview();
  if (e.target.matches('[data-f="mode"]')) { const fixed = e.target.value === "fixed"; const f = e.target.closest("[data-in]"); $('[data-f="days"]', f).hidden = fixed; $('[data-f="from"]', f).hidden = !fixed; $('[data-f="to"]', f).hidden = !fixed; }
});
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
$("#q").addEventListener("input", () => { if (!$("#q").value.trim() && results) { results = null; query = ""; render(); } });
$("#scope-project").addEventListener("click", () => { scope = "project"; localStorage.setItem("recap.scope", scope); if (query) runSearch(); else render(); });
$("#scope-all").addEventListener("click", () => { scope = "all"; localStorage.setItem("recap.scope", scope); if (query) runSearch(); else render(); });
$("#refresh").addEventListener("click", async (e) => { e.target.disabled = true; try { await load(true); if (query) await runSearch(); toast("Updated"); } finally { e.target.disabled = false; } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(() => {}); });

await load();
const m = /^#session=(.+)$/.exec(location.hash); if (m) openSession(decodeURIComponent(m[1]));
