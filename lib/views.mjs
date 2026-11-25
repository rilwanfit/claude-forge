// Read models over the transcript index: overview rows, session detail (timeline + delegation tree), search.
// Rules: only recorded facts; anything not recorded is "unknown". A recent timestamp never means "running" (that is
// the live registry), and a configured agent is never listed: only agents that were actually called.
import path from "node:path";
import { clip, questionsIn } from "./text.mjs";
import { slugOf } from "./index.mjs";
import { SECRET_FILE } from "./redact.mjs";

export const UNKNOWN = "unknown";
const DAY = 86_400_000;
const firstLine = (t) => (String(t || "").split("\n").map((l) => l.replace(/[*_`#>|]/g, "").trim()).find((l) => l.length > 12) || "").replace(/\s+/g, " ");

/** The folder `claude --resume` must run in: the cwd whose slug is the folder the transcript lives in. */
export function resumeCwd(s) {
  const hit = s.cwds.find((c) => slugOf(c.cwd) === s.slug);
  return hit?.cwd ?? null;
}
export const launchCwd = (s) => resumeCwd(s) ?? s.cwds[0]?.cwd ?? null;

export function worktreeOf(s, proj) {
  if (s.worktree) return { name: s.worktree.name, path: s.worktree.path, branch: s.worktree.branch || s.branch || null, source: "worktree-state record" };
  const rel = s.relocatedCwd || s.cwds.map((c) => c.cwd).reverse().find((c) => c.includes("/.claude/worktrees/"));
  if (rel) return { name: path.basename(rel), path: rel, branch: s.branch || null, source: s.relocatedCwd ? "relocated record" : "cwd under .claude/worktrees" };
  if (proj?.worktree) return { name: path.basename(proj.worktree), path: proj.worktree, branch: s.branch || null, source: "git worktree" };
  return null;
}

/** What state a session is in, from recorded facts only. */
export function stateOf(s, live) {
  if (live) return { state: "live", label: live.status ? `Live, ${live.status}` : "Live", why: `process ${live.pid} is running (status ${live.status || "not recorded"})`, questions: [] };
  const pending = Object.values(s.open || {}).find((o) => o.name === "AskUserQuestion");
  if (pending) { const d = s.decisions.at(-1); return { state: "waiting", label: "Waiting for your answer", why: "an AskUserQuestion has no recorded answer", questions: d ? [d.question] : [] }; }
  if (["prompt", "tool_use", "tool_result"].includes(s.lastKind)) return { state: "interrupted", label: "Stopped mid-turn", why: `the last record is a ${s.lastKind.replace("_", " ")} with no final answer after it`, questions: [] };
  if (s.lastKind === "assistant_text" && s.lastAnswer) {
    const questions = questionsIn(s.lastAnswer.text);
    if (questions.length) return { state: "waiting", label: "May be waiting on you", why: "the last answer contains a question (a guess from its wording)", questions };
    return { state: "answered", label: "Answered", why: "the last record is an answer without a question", questions: [] };
  }
  return { state: "unknown", label: UNKNOWN, why: "no prompt or answer was recorded", questions: [] };
}

const nextOf = (s) => {
  const t = s.recap?.text || ""; const m = /\bNext(?: action)?\s*[:,]\s*([^]*)$/i.exec(t);
  return m ? clip(m[1].replace(/\s+/g, " ").trim(), 220) : null;
};

/** Short "where I left off": the recap Claude Code recorded, else the last answer, else the last prompt. */
export function leftOff(s) {
  const promptTs = s.lastPrompt?.ts ?? 0;
  if (s.recap && (s.recap.ts ?? 0) >= promptTs) return { kind: "recap", ts: s.recap.ts, text: clip(s.recap.text, 240), ref: { f: "main", off: s.recap.off } };
  if (s.lastAnswer && (s.lastAnswer.ts ?? 0) >= promptTs) return { kind: "answer", ts: s.lastAnswer.ts, text: clip(firstLine(s.lastAnswer.text) || s.lastAnswer.text, 240), ref: { f: "main", off: s.lastAnswer.off } };
  if (s.lastPrompt) return { kind: "prompt", ts: s.lastPrompt.ts, text: clip(s.lastPrompt.text, 240), ref: { f: "main", off: s.lastPrompt.off } };
  return { kind: "none", ts: null, text: UNKNOWN, ref: null };
}

export function bestNext(s, st, ctx = {}) {
  if (st.state === "live") return { kind: "none", label: "Running now", detail: "Switch to its terminal" };
  if (ctx.workflowId) return { kind: "rerun", label: "Rerun workflow", detail: ctx.workflowName || "" };
  if (st.state === "waiting") return { kind: "resume", label: "Answer and resume", detail: clip(st.questions[0] || "", 160) };
  if (st.state === "interrupted") return { kind: "resume", label: "Resume", detail: "It stopped before answering" };
  const nxt = nextOf(s);
  if (nxt) return { kind: "resume", label: "Next", detail: nxt };
  if (s.job?.state === "blocked") return { kind: "resume", label: "Blocked", detail: s.job.detail };
  return { kind: "handoff", label: "Reuse", detail: "Start a fresh session from a handoff" };
}

const topModels = (s) => Object.entries(s.models).map(([id, v]) => ({ id, n: v.n })).sort((a, b) => b.n - a.n);

export function agentStats(s) {
  const calls = s.agents.length; let finished = 0, unclear = 0, failed = 0;
  for (const a of s.agents) { const n = agentNode(s, a, null); if (n.state === "finished") finished++; else if (n.state === "failed" || n.state === "stopped") failed++; else unclear++; }
  return { calls, finished, unclear, failed };
}

/** Row for the overview. `ctx` carries what the server knows beyond the transcript (project, live, linked workflow). */
export function rowOf(s, ctx) {
  const st = stateOf(s, ctx.live); const lo = leftOff(s); const wt = worktreeOf(s, ctx.project);
  const title = s.title || s.firstPrompt || null;
  const unknown = [];
  if (!title) unknown.push("title"); if (!s.cwds.length) unknown.push("project folder"); if (!Object.keys(s.models).length) unknown.push("model");
  const wfs = (s.workflows || []).map((w) => ({ name: w.name || UNKNOWN, status: w.status || UNKNOWN }));
  const unfinished = ["waiting", "interrupted"].includes(st.state) || s.job?.state === "blocked" || wfs.some((w) => w.status === "failed");
  return {
    key: s.key, id: s.id, profile: s.profile, title: title || "Untitled session", titleSource: s.title ? "Claude Code title" : s.firstPrompt ? "first prompt" : UNKNOWN,
    projectKey: ctx.project?.key ?? launchCwd(s) ?? UNKNOWN, projectName: ctx.project?.name ?? (launchCwd(s) ? path.basename(launchCwd(s)) : UNKNOWN),
    worktree: wt, branch: s.branch || null, state: st.state, stateLabel: st.label, stateWhy: st.why, unfinished,
    ts: s.lastActivityTs ?? s.lastTs ?? s.mtimeMs, leftOff: lo, next: bestNext(s, st, ctx), questions: st.questions,
    models: topModels(s), modelChanged: s.modelChanges.length > 0, agents: agentStats(s), workflows: wfs, mcp: Object.keys(s.mcp).slice(0, 4), skills: Object.keys(s.skills).slice(0, 4),
    headless: s.entrypoint === "sdk-cli", job: s.job ? { state: s.job.state, detail: s.job.detail } : null, handoffId: s.handoffId, unknown,
    canResume: !!resumeCwd(s),
  };
}

// ---------------------------------------------------------------- detail
const alias = /^(sonnet|opus|haiku|fable|inherit)$/i;

/** Which model did an agent run on, and how we know. */
function modelOf(a, sub, wfAgent) {
  const r = a?.result?.resolvedModel; if (r) return { id: r, source: "recorded when the agent launched" };
  if (wfAgent?.model) return { id: wfAgent.model, source: "recorded by the workflow run" };
  if (sub?.lastModel) return { id: sub.lastModel, source: "model of the agent's last message" };
  const arg = a?.modelArg || sub?.modelArg; if (arg && !alias.test(arg)) return { id: arg, source: "model requested for the agent" };
  if (arg) return { id: `${arg} (alias requested)`, source: "alias in the call, resolved model not recorded" };
  return { id: UNKNOWN, source: "not recorded" };
}

export function agentNode(s, a, sub, wfAgent) {
  const n = a?.notify;
  let state = "unclear", why = "no completion notice and no 'finished' flag recorded";
  if (sub?.stoppedByUser) { state = "stopped"; why = "stopped by you (meta.stoppedByUser)"; }
  else if (n?.status === "completed" || sub?.finished === true) { state = "finished"; why = n?.status === "completed" ? "completion notice recorded in the parent" : "meta.finished is true"; }
  else if (n?.status && n.status !== "completed") { state = "failed"; why = `notification status ${n.status}`; }
  else if (a?.result?.status && a.result.status !== "async_launched" && a.result.status !== "completed") { state = "failed"; why = `result status ${a.result.status}`; }
  else if (a?.result?.status === "completed") { state = "finished"; why = "tool result status completed"; }
  const resultText = sub?.result?.text || n?.result || a?.result?.text || "";
  const ref = sub?.result ? { f: sub.agentId, off: sub.result.off } : n?.result ? { f: "main", off: n.off } : a?.result?.off ? { f: "main", off: a.result.off } : null;
  return {
    kind: "agent", id: sub?.agentId || a?.agentId || a?.toolUseId, toolUseId: a?.toolUseId || sub?.toolUseId || null, label: a?.description || wfAgent?.label || sub?.description || "Agent", type: a?.subagentType || sub?.agentType || UNKNOWN,
    model: modelOf(a, sub, wfAgent), state, why, ts: a?.ts ?? sub?.firstTs ?? null, endTs: sub?.lastTs ?? null, background: a?.background ?? sub?.background ?? false,
    worktree: sub?.worktreePath ? { path: sub.worktreePath, branch: sub.worktreeBranch } : null, phase: sub?.phase ?? wfAgent?.phase ?? null,
    result: resultText ? { text: clip(resultText, 700), ref } : null, noTranscript: !sub, ask: a?.ref ?? null, launch: a ? { f: "main", off: a.off } : null, children: [],
  };
}

export function buildTree(s) {
  const subs = s.subs || []; const byTool = new Map(subs.filter((x) => x.toolUseId).map((x) => [x.toolUseId, x]));
  const used = new Set(); const nodes = new Map();
  const mk = (a, sub, wfa) => { const n = agentNode(s, a, sub, wfa); if (sub) used.add(sub.agentId); nodes.set(n.id, n); return n; };
  const top = [];
  for (const a of s.agents) { const sub = byTool.get(a.toolUseId) || subs.find((x) => a.agentId && x.agentId === a.agentId); top.push(mk(a, sub)); }
  // Workflow runs: phases -> agents (from the run's own progress record, matched to agent transcripts by id).
  const flows = (s.workflows || []).map((w) => {
    const phases = new Map((w.phases.length ? w.phases : [{ title: "Agents" }]).map((p) => [p.title, { title: p.title, detail: p.detail || "", agents: [] }]));
    const members = subs.filter((x) => x.runId === w.runId);
    const listed = new Set();
    for (const wa of w.agents) {
      const sub = members.find((x) => x.agentId === wa.agentId); if (sub) listed.add(sub.agentId);
      const node = mk(null, sub, wa); if (!sub) { node.state = wa.state === "done" ? "finished" : "unclear"; node.why = wa.state ? `workflow progress says ${wa.state}` : node.why; node.id = `${w.runId}:${wa.label}`; }
      const ph = phases.get(wa.phase) || phases.get("Agents") || (phases.set(wa.phase || "Agents", { title: wa.phase || "Agents", detail: "", agents: [] }), phases.get(wa.phase || "Agents")); ph.agents.push(node);
    }
    for (const sub of members) if (!listed.has(sub.agentId)) { const node = mk(null, sub, null); (phases.get(sub.phase) || [...phases.values()][0]).agents.push(node); }
    const ended = w.status === "completed" && w.error == null;
    return { kind: "workflow", runId: w.runId, label: w.name || UNKNOWN, status: w.status || UNKNOWN, ts: w.ts, durationMs: w.durationMs, agentCount: w.agentCount, model: w.defaultModel ? { id: w.defaultModel, source: "workflow default model" } : { id: UNKNOWN, source: "not recorded" },
      summary: w.summary, result: w.result ? { text: clip(w.result, 700) } : null, error: w.error, scriptPath: w.scriptPath, tokens: w.tokens, phases: [...phases.values()].filter((p) => p.agents.length || w.phases.length),
      // A run can say "completed" while its own result reports a stop: say that instead of claiming success.
      outcomeNote: ended && /\b(stopped|failed|blocked|error)\b/i.test(w.result || "") ? "Run status is completed, but its recorded result mentions a stop or failure. Check the result." : null };
  });
  // Nest by parentAgentId; anything whose parent we cannot find stays visible as an orphan.
  const orphans = subs.filter((x) => !used.has(x.agentId) && !x.runId);
  for (const sub of orphans) { const n = mk(null, sub, null); n.orphan = true; top.push(n); }
  const attach = [];
  for (const sub of subs) { if (!sub.parentAgentId) continue; const child = nodes.get(sub.agentId); const parent = nodes.get(sub.parentAgentId); if (child && parent && child !== parent) attach.push([child, parent]); }
  for (const [child, parent] of attach) { parent.children.push(child); const i = top.indexOf(child); if (i >= 0) top.splice(i, 1); }
  return { agents: top, workflows: flows };
}

export function timeline(s) {
  const items = s.events.map((e) => ({ k: e.k, ts: e.ts, text: e.text, ref: { f: "main", off: e.off } }));
  for (const d of s.decisions) items.push({ k: "decision", ts: d.ts, text: `${d.question}${d.answer ? ` → ${d.answer}` : " → no answer recorded"}`, ref: { f: "main", off: d.answerOff ?? d.off } });
  // Agent launches closer than a minute apart collapse into one line, expandable in the UI.
  const agents = [...s.agents].sort((a, b) => a.ts - b.ts); const batches = [];
  for (const a of agents) { const b = batches.at(-1); if (b && a.ts - b.last <= 60_000) { b.items.push(a); b.last = a.ts; } else batches.push({ ts: a.ts, last: a.ts, items: [a] }); }
  for (const b of batches) items.push({ k: "agents", ts: b.ts, text: b.items.length === 1 ? `Agent: ${b.items[0].description || "(no description)"}` : `${b.items.length} agents launched`, items: b.items.map((a) => ({ text: a.description || "(no description)", ref: { f: "main", off: a.off } })), ref: { f: "main", off: b.items[0].off } });
  for (const w of s.workflows || []) items.push({ k: "workflow", ts: w.ts, text: `Workflow ${w.name || UNKNOWN}: ${w.status || UNKNOWN}${w.agentCount ? `, ${w.agentCount} agents` : ""}`, ref: null });
  for (const c of s.cwds.slice(1)) items.push({ k: "cwd", ts: c.ts, text: `Working folder changed to ${c.cwd}`, ref: null });
  return items.filter((i) => i.ts).sort((a, b) => a.ts - b.ts);
}

export function outputsOf(s) {
  const files = Object.entries(s.files).filter(([f]) => !SECRET_FILE.test(f)).map(([f, v]) => ({ path: f, writes: v.w, ts: v.ts })).sort((a, b) => b.writes - a.writes || (b.ts ?? 0) - (a.ts ?? 0));
  return { files, prs: Object.values(s.prs), artifacts: s.artifacts };
}

export function detailOf(s, ctx) {
  const row = rowOf(s, ctx); const tree = buildTree(s); const out = outputsOf(s);
  const unknown = [...row.unknown];
  if (!s.recap) unknown.push("recap (Claude Code recorded none for this session)");
  if (s.agents.length && !(s.subs || []).length) unknown.push("subagent transcripts (not found next to this session)");
  const rc = resumeCwd(s);
  const modelsNote = s.modelChanges.length ? `${s.modelChanges.length} model change${s.modelChanges.length === 1 ? "" : "s"} recorded between messages.` : Object.keys(s.models).length > 1 ? "Several models answered; their order was not recorded." : Object.keys(s.models).length === 1 ? "One model answered the whole session (changes inside agents are not scanned)." : "No model was recorded.";
  return {
    ...row, firstPrompt: s.firstPrompt, firstPromptFull: s.firstPromptFull, cwdHistory: s.cwds, entrypoint: s.entrypoint, version: s.version, firstTs: s.firstTs, turns: s.turns, prompts: s.prompts, compacts: s.compacts, cost: s.cost, job: s.job,
    derivedFrom: s.derivedFrom, continuedIn: s.continuedIn, fires: s.fires, recap: s.recap ? { text: s.recap.text, ts: s.recap.ts, ref: { f: "main", off: s.recap.off } } : null,
    lastAnswer: s.lastAnswer ? { text: s.lastAnswer.text, ts: s.lastAnswer.ts, ref: { f: "main", off: s.lastAnswer.off } } : null,
    modelsUsed: Object.entries(s.models).map(([id, v]) => ({ id, n: v.n, first: v.first, last: v.last })), modelChanges: s.modelChanges.map((m) => ({ ...m, ref: { f: "main", off: m.off } })), modelsNote,
    timeline: timeline(s), tree, outputs: out, decisions: s.decisions.map((d) => ({ question: d.question, answer: d.answer, ts: d.ts, ref: { f: "main", off: d.answerOff ?? d.off } })),
    resume: rc ? { possible: true, cwd: rc, profile: s.profile } : { possible: false, reason: "The folder this session started in could not be determined from its records." },
    unknown, mcpUsed: s.mcp, skillsUsed: s.skills, toolsUsed: s.tools,
  };
}

// ---------------------------------------------------------------- overview
export function overview(rows, { now, upcomingByProject = {}, runsByProject = {} }) {
  const d = new Date(now); const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const weekStart = midnight - 6 * DAY;
  const groups = new Map();
  const g = (key, name) => { if (!groups.has(key)) groups.set(key, { key, name, today: [], week: [], unfinished: 0, live: 0, last: 0, upcoming: upcomingByProject[key] || [] }); return groups.get(key); };
  for (const r of rows) {
    if (!r.ts || r.ts < weekStart) continue;
    const grp = g(r.projectKey, r.projectName); (r.ts >= midnight ? grp.today : grp.week).push(r);
    if (r.unfinished) grp.unfinished++; if (r.state === "live") grp.live++; grp.last = Math.max(grp.last, r.ts);
  }
  for (const [key, runs] of Object.entries(runsByProject)) for (const r of runs) {
    if (!r.ts || r.ts < weekStart) continue;
    const grp = g(key, r.projectName); (r.ts >= midnight ? grp.today : grp.week).push(r);
    if (r.unfinished) grp.unfinished++; if (r.state === "live") grp.live++; grp.last = Math.max(grp.last, r.ts);
  }
  for (const [key, up] of Object.entries(upcomingByProject)) if (up.length) g(key, up[0].projectName);
  const by = (a, b) => (b.ts ?? 0) - (a.ts ?? 0);
  // Unfinished first inside a group, then newest: the Monday question is "where did I stop".
  const rank = (a, b) => Number(b.unfinished) - Number(a.unfinished) || by(a, b);
  const projects = [...groups.values()].map((p) => ({ ...p, today: p.today.sort(rank), week: p.week.sort(rank) })).sort((a, b) => b.unfinished - a.unfinished || b.last - a.last);
  return { now, midnight, weekStart, projects };
}

// ---------------------------------------------------------------- search
const tokens = (q) => String(q || "").toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length >= 2);
const snippet = (text, toks) => { const low = text.toLowerCase(); const i = Math.min(...toks.map((t) => { const k = low.indexOf(t); return k < 0 ? 1e9 : k; })); const from = Math.max(0, (i === 1e9 ? 0 : i) - 50); return (from ? "…" : "") + text.slice(from, from + 200).replace(/\s+/g, " ") + (text.length > from + 200 ? "…" : ""); };

/** Search by problem (prompts, answers), decision, workflow or output (files, PRs). Local scoring, no model. */
export function search(sessions, q, ctxOf) {
  const toks = tokens(q); if (!toks.length) return [];
  const results = [];
  for (const s of sessions) {
    const ctx = ctxOf(s); const hits = [];
    const field = (kind, text, weight, ref) => {
      if (!text) return; const low = String(text).toLowerCase(); const matched = toks.filter((t) => low.includes(t));
      if (!matched.length) return; hits.push({ kind, text: snippet(String(text), toks), score: weight * (matched.length / toks.length) * (matched.length === toks.length ? 2 : 1), ref });
    };
    field("title", s.title, 5); field("problem", s.firstPrompt, 4, s.lastPrompt ? null : null);
    for (const e of s.events) if (e.k === "prompt") field("problem", e.text, 3, { f: "main", off: e.off }); else if (e.k === "recap") field("recap", e.text, 3, { f: "main", off: e.off });
    for (const d of s.decisions) field("decision", `${d.question} → ${d.answer || ""}`, 4, { f: "main", off: d.answerOff ?? d.off });
    for (const w of s.workflows || []) { field("workflow", `${w.name} ${w.summary}`, 4); field("workflow", w.result, 2); }
    for (const a of s.agents) field("agent", a.description, 2, { f: "main", off: a.off });
    for (const [f, v] of Object.entries(s.files)) if (!SECRET_FILE.test(f)) field("output", f, 3);
    for (const p of Object.values(s.prs)) field("output", p.url, 3);
    for (const t of s.search) field("text", t, 1);
    if (s.lastAnswer) field("answer", s.lastAnswer.text, 2, { f: "main", off: s.lastAnswer.off });
    if (!hits.length) continue;
    hits.sort((a, b) => b.score - a.score);
    const seen = new Set(); const top = hits.filter((h) => { const k = h.kind + h.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
    const score = hits.reduce((n, h) => n + h.score, 0) + (hits.length > 1 ? 0 : 0) + ((s.lastActivityTs ?? 0) / 1e13);
    results.push({ key: s.key, score, row: rowOf(s, ctx), hits: top, kinds: [...new Set(hits.map((h) => h.kind))] });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 40);
}
