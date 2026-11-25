// Local, incremental index of Claude Code transcripts. No model calls: everything is read from the files Claude Code
// already wrote. State lives in <data>/index.json; each transcript remembers how many bytes were parsed, so a refresh
// reads only what was appended. Heavy record types (tool output, api blobs, snapshots) are skipped without JSON.parse.
//
// What identifies what (verified against real transcripts, see docs/transcript-fields.md):
//   session   file name <sessionId>.jsonl under <profile>/projects/<slug>/    (key = profile + ":" + sessionId)
//   project   record.cwd -> git common dir (resolved by the server); slug = cwd with every non-alphanumeric as "-"
//   worktree  `worktree-state` / `relocated` records, cwd under .claude/worktrees/, subagent meta.worktreePath
//   children  <session>/subagents/agent-<id>.meta.json: toolUseId == parent tool_use.id, parentAgentId for nesting
//   workflow  <session>/workflows/wf_<id>.json, its agents in <session>/subagents/workflows/<runId>/
//   model     assistant.message.model per message (change points), toolUseResult.resolvedModel / meta.model for agents
//   live      <profile>/sessions/<pid>.json with a running pid
import path from "node:path";
import { open, readdir, stat, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { clip, textOf, promptText, questionsIn } from "./text.mjs";
import { redact } from "./redact.mjs";

const DAY = 86_400_000;
const VERSION = 4; // bump when the per-session shape changes: files are parsed again
const MAX_EVENTS = 500;
const TAIL_BYTES = 96 * 1024;
const HEAD_BYTES = 16 * 1024;
const PARSE_TYPES = new Set(["user", "assistant", "system", "ai-title", "agent-name", "worktree-state", "relocated", "derived-from", "continued-in", "pr-link", "frame-link", "cost-state"]);

export const slugOf = (cwd) => String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
const tsOf = (r) => (r.timestamp ? Date.parse(r.timestamp) || null : null);
const uniq = (a) => [...new Set(a)];

// ---------------------------------------------------------------- streaming reader
/** Yields { start, buf } for every complete line in [from, to). Never holds more than one chunk plus one line. */
async function* completeLines(file, from, to) {
  const fh = await open(file, "r");
  try {
    const CH = 4 * 1024 * 1024;
    let pos = from, carry = null, carryStart = from;
    while (pos < to) {
      const len = Math.min(CH, to - pos);
      const chunk = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(chunk, 0, len, pos);
      if (!bytesRead) break;
      let buf = bytesRead < len ? chunk.subarray(0, bytesRead) : chunk;
      let base = pos;
      if (carry) { buf = Buffer.concat([carry, buf]); base = carryStart; carry = null; }
      let s = 0;
      for (let nl = buf.indexOf(10, s); nl !== -1; nl = buf.indexOf(10, s)) {
        yield { start: base + s, buf: buf.subarray(s, nl), end: base + nl + 1 };
        s = nl + 1;
      }
      carry = s < buf.length ? Buffer.from(buf.subarray(s)) : null; carryStart = base + s;
      pos += bytesRead;
    }
  } finally { await fh.close(); }
}

async function readRange(file, start, end) {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf;
  } finally { await fh.close(); }
}

const TYPE_RE = /"type":"([\w-]+)"/;
const TOOL_USE_ID_RE = /"tool_use_id":"(toolu_\w+)"/;
// Assistant records put `message` first, so their own "type" comes after the content: recognise them by the role instead.
function quickType(buf) {
  const head = buf.toString("latin1", 0, Math.min(buf.length, 500));
  if (head.includes('"role":"assistant"') && head.includes('"message":{')) return "assistant";
  return TYPE_RE.exec(head)?.[1];
}

// ---------------------------------------------------------------- per-session aggregate
const newSession = () => ({
  cwds: [], branch: null, version: null, entrypoint: null, firstTs: null, lastTs: null, lastActivityTs: null,
  title: null, agentName: null, firstPrompt: null, firstPromptFull: null, handoffId: null,
  lastPrompt: null, lastAnswer: null, curAnswer: null, recap: null, lastKind: null, open: {}, want: {},
  models: {}, modelChanges: [], curModel: null,
  agents: [], decisions: [], events: [], tools: {}, skills: {}, mcp: {}, files: {}, prs: {}, artifacts: [],
  worktree: null, relocatedCwd: null, derivedFrom: [], continuedIn: null, fires: [], compacts: 0, errors: 0, cost: null,
  prompts: 0, turns: 0, search: [], use: {}, hrs: null, lastUse: null,
});

const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/** Tokens per local day. Claude Code writes one record per content block with the same message id, so only growth within a message is added. */
function addUsage(s, r, ts) {
  const u = r.message?.usage, id = r.message?.id; if (!u || !ts || r.message?.model === "<synthetic>") return;
  const cur = { id, i: u.input_tokens || 0, o: u.output_tokens || 0, cc: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 };
  const prev = id && s.lastUse?.id === id ? s.lastUse : { i: 0, o: 0, cc: 0, cr: 0 };
  const b = (s.use[dayKey(ts)] ??= { i: 0, o: 0, cc: 0, cr: 0, n: 0 });
  for (const k of ["i", "o", "cc", "cr"]) b[k] += Math.max(0, cur[k] - prev[k]);
  if (prev !== s.lastUse) b.n++;
  s.lastUse = cur;
}
function addHour(s, ts) { if (!ts) return; const d = new Date(ts); (s.hrs ??= new Array(168).fill(0))[((d.getDay() + 6) % 7) * 24 + d.getHours()]++; }

function pushEvent(s, e) {
  s.events.push(e);
  if (s.events.length > MAX_EVENTS) {
    const i = s.events.findIndex((x) => x.k === "answer" || x.k === "tool");
    s.events.splice(i === -1 ? 0 : i, 1);
  }
}
const addSearch = (s, t) => { if (t) s.search.push(clip(String(t), 400)); if (s.search.length > 120) s.search.splice(20, 1); };

function flushAnswer(s, ts) {
  const a = s.curAnswer; if (!a) return;
  pushEvent(s, { k: "answer", ts: a.ts ?? ts, text: clip(a.text, 700), off: a.off, uuid: a.uuid });
  addSearch(s, clip(a.text, 400)); s.curAnswer = null;
}

function parseNotification(text) {
  const g = (tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1]?.trim();
  const id = g("tool-use-id"); if (!id) return null;
  return { toolUseId: id, agentId: g("task-id"), status: g("status"), summary: g("summary"), result: g("result") };
}

function applyRecord(s, r, off) {
  if (r.isSidechain) return;
  const ts = tsOf(r);
  if (ts) { s.firstTs = Math.min(s.firstTs ?? ts, ts); if (!["file-history-snapshot", "queue-operation"].includes(r.type)) s.lastTs = Math.max(s.lastTs ?? 0, ts); }
  if (r.cwd && s.cwds.at(-1)?.cwd !== r.cwd) { s.cwds.push({ cwd: r.cwd, ts }); if (s.cwds.length > 30) s.cwds.splice(1, 1); }
  if (r.gitBranch) s.branch = r.gitBranch;
  if (r.version) s.version = r.version;
  if (r.entrypoint) s.entrypoint = r.entrypoint;

  switch (r.type) {
    case "ai-title": if (r.aiTitle) s.title = r.aiTitle; return;
    case "agent-name": if (r.agentName) s.agentName = r.agentName; return;
    case "worktree-state": {
      const w = r.worktreeSession;
      if (w?.worktreePath) s.worktree = { path: w.worktreePath, name: w.worktreeName || path.basename(w.worktreePath), branch: w.worktreeBranch || null, originalCwd: w.originalCwd || null, originalBranch: w.originalBranch || null };
      return;
    }
    case "relocated": if (r.relocatedCwd) s.relocatedCwd = r.relocatedCwd; return;
    case "derived-from": s.derivedFrom = (r.sessions || []).map((x) => ({ id: x.id, via: x.via })); return;
    case "continued-in": if (r.continuedInSessionId) s.continuedIn = r.continuedInSessionId; return;
    case "pr-link": if (r.prUrl) s.prs[r.prUrl] = { url: r.prUrl, number: r.prNumber ?? null, repo: r.prRepository ?? null, ts }; return;
    case "frame-link": if (r.frameUrl) s.artifacts.push({ url: r.frameUrl, title: r.title || "artifact", ts }); return;
    case "cost-state": s.cost = { usd: r.totalCostUSD ?? null, models: Object.fromEntries(Object.entries(r.modelUsage || {}).map(([m, u]) => [m, { in: u.inputTokens ?? 0, out: u.outputTokens ?? 0 }])) }; return;
    case "system": return applySystem(s, r, ts, off);
    case "user": return applyUser(s, r, ts, off);
    case "assistant": return applyAssistant(s, r, ts, off);
  }
}

function applySystem(s, r, ts, off) {
  switch (r.subtype) {
    case "turn_duration": flushAnswer(s, ts); s.turns++; s.lastActivityTs = ts ?? s.lastActivityTs; return;
    case "away_summary": if (r.content) { s.recap = { text: clip(r.content.replace(/\s*\(turn off recaps[^)]*\)\s*$/i, ""), 1500), ts, off }; pushEvent(s, { k: "recap", ts, text: clip(r.content, 500), off }); addSearch(s, r.content); } return;
    case "compact_boundary": s.compacts++; pushEvent(s, { k: "compact", ts, text: "Conversation compacted", off }); return;
    case "scheduled_task_fire": s.fires.push({ ts, cron: r.cron || null, text: clip(r.content || "", 160), prompt: clip(r.prompt || "", 300), off }); pushEvent(s, { k: "schedule", ts, text: clip(r.content || "Scheduled task fired", 200), off }); return;
    case "api_error": s.errors++; pushEvent(s, { k: "error", ts, text: clip(r.content || r.error?.message || "API error", 200), off }); return;
    case "agents_killed": pushEvent(s, { k: "error", ts, text: "Background agents were stopped", off }); return;
    case "local_command": { const c = r.commandRun?.command; if (c === "model") pushEvent(s, { k: "model-cmd", ts, text: "/model command used", off }); return; }
  }
}

function applyUser(s, r, ts, off) {
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) {
    for (const b of c) {
      if (b?.type !== "tool_result") continue;
      const id = b.tool_use_id; delete s.open[id];
      const kind = s.want[id]; if (kind) delete s.want[id];
      if (kind === "agent") {
        const t = r.toolUseResult; const a = s.agents.find((x) => x.toolUseId === id);
        if (a && t && typeof t === "object") {
          const body = Array.isArray(t.content) ? textOf(t.content) : typeof t.content === "string" ? t.content : "";
          a.result = { status: t.status || null, agentId: t.agentId || null, resolvedModel: t.resolvedModel || null, durationMs: t.totalDurationMs ?? null, tokens: t.totalTokens ?? null, text: clip(body, 1200), off, ts };
          if (t.agentId) a.agentId = t.agentId;
        }
      } else if (kind === "ask") {
        const d = s.decisions.find((x) => x.toolUseId === id);
        if (d) {
          const t = r.toolUseResult; const raw = typeof b.content === "string" ? b.content : textOf(b.content);
          const answers = t?.answers && typeof t.answers === "object" ? Object.values(t.answers).map(String) : [...raw.matchAll(/"[^"]*"="([^"]*)"/g)].map((m) => m[1]);
          d.answer = clip(answers.join("; "), 300); d.answeredTs = ts; d.answerOff = off;
          addSearch(s, `${d.question} → ${d.answer}`);
        }
      }
    }
    s.lastKind = "tool_result"; return;
  }
  const text = textOf(c);
  if (text.includes("<task-notification>")) {
    const n = parseNotification(text); const a = n && s.agents.find((x) => x.toolUseId === n.toolUseId);
    if (a) a.notify = { status: n.status || null, summary: clip(n.summary || "", 300), result: clip(n.result || "", 1200), ts, off };
    return;
  }
  const prompt = promptText(r);
  if (prompt === null) return;
  flushAnswer(s, ts);
  addHour(s, ts);
  s.prompts++; s.lastKind = "prompt"; s.lastActivityTs = ts ?? s.lastActivityTs;
  s.lastPrompt = { text: clip(prompt, 600), ts, off };
  if (!s.firstPrompt && !prompt.startsWith("/")) { s.firstPrompt = clip(prompt, 160); s.firstPromptFull = clip(prompt, 4000); s.handoffId = /Handoff ID: (h_\w+)/.exec(prompt)?.[1] ?? null; }
  pushEvent(s, { k: "prompt", ts, text: clip(prompt, 400), off, uuid: r.uuid });
  addSearch(s, clip(prompt, 300));
}

function applyAssistant(s, r, ts, off) {
  addUsage(s, r, ts);
  const m = r.message?.model;
  if (m && m !== "<synthetic>") {
    const e = (s.models[m] ??= { n: 0, first: ts, last: ts }); e.n++; e.last = ts;
    if (s.curModel && s.curModel !== m) { s.modelChanges.push({ from: s.curModel, to: m, ts, off }); pushEvent(s, { k: "model", ts, text: `${s.curModel} → ${m}`, off }); }
    s.curModel = m;
  }
  const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
  s.lastActivityTs = ts ?? s.lastActivityTs;
  for (const b of blocks) {
    if (b.type === "text" && b.text?.trim()) {
      s.curAnswer = { text: b.text.trim(), ts, off, uuid: r.uuid };
      s.lastAnswer = { text: clip(b.text.trim(), 6000), ts, off, uuid: r.uuid };
      s.lastKind = "assistant_text";
    } else if (b.type === "tool_use") {
      s.lastKind = "tool_use"; s.open[b.id] = { name: b.name, ts };
      s.tools[b.name] = (s.tools[b.name] || 0) + 1;
      toolUse(s, b, ts, off);
    }
  }
}

function toolUse(s, b, ts, off) {
  const i = b.input || {};
  if (b.name === "Agent" || b.name === "Task") {
    s.agents.push({ toolUseId: b.id, ts, off, description: clip(String(i.description || ""), 200), subagentType: i.subagent_type || null, modelArg: i.model || null, background: !!i.run_in_background, prompt: clip(String(i.prompt || ""), 500), agentId: null, result: null, notify: null });
    s.want[b.id] = "agent"; addSearch(s, `agent: ${i.description || ""} ${clip(String(i.prompt || ""), 160)}`);
  } else if (b.name === "AskUserQuestion") {
    const qs = Array.isArray(i.questions) ? i.questions : [];
    const q = qs.map((x) => x.question).filter(Boolean).join(" / ");
    s.decisions.push({ toolUseId: b.id, ts, off, question: clip(q, 400), options: qs.flatMap((x) => (x.options || []).map((o) => o.label)).slice(0, 8), answer: null });
    s.want[b.id] = "ask";
  } else if (b.name === "Skill" && i.skill) s.skills[i.skill] = (s.skills[i.skill] || 0) + 1;
  else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name) && (i.file_path || i.notebook_path)) {
    const f = i.file_path || i.notebook_path; const e = (s.files[f] ??= { w: 0, ts: null }); e.w++; e.ts = ts;
  } else if (b.name.startsWith("mcp__")) { const srv = b.name.split("__")[1]; s.mcp[srv] = (s.mcp[srv] || 0) + 1; }
  else if (b.name === "Workflow") pushEvent(s, { k: "workflow-call", ts, text: "Workflow started", off });
}

// ---------------------------------------------------------------- index
export class TranscriptIndex {
  constructor({ profiles, dataDir, days = 60, now = () => Date.now(), expand = (p) => p, stateName = "index.json" }) {
    this.profiles = profiles; this.dir = dataDir; this.days = days; this.now = now; this.expand = expand;
    this.file = path.join(dataDir, stateName);
    this.s = { v: VERSION, sessions: {}, subSigs: {} };
    this.errors = []; this.status = { state: "idle", done: 0, total: 0, startedAt: null, finishedAt: null, ms: 0, parsedBytes: 0 };
    this.running = null; this.dirty = false; this.jobs = new Map();
  }

  async load() {
    try { const j = JSON.parse(await readFile(this.file, "utf8")); if (j.v === VERSION) this.s = j; } catch { /* first run */ }
    return this;
  }
  async save() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file + ".tmp", JSON.stringify(this.s)); await rename(this.file + ".tmp", this.file); this.dirty = false;
  }

  get sessions() { return Object.values(this.s.sessions); }
  get(key) { return this.s.sessions[key] || null; }

  /** One pass: find transcripts, parse what changed, enrich with subagent and workflow files. Safe to call often. */
  refresh() {
    if (!this.running) this.running = this.#refresh().catch((e) => { console.error("index:", e); this.status.state = "error"; this.status.error = e.message; }).finally(() => { this.running = null; });
    return this.running;
  }

  async #listFiles() {
    const since = this.now() - this.days * DAY; const found = [];
    for (const profile of this.profiles) {
      const root = path.join(this.expand(profile.dir), "projects");
      let slugs; try { slugs = await readdir(root); } catch { continue; }
      for (const slug of slugs) {
        let files; try { files = (await readdir(path.join(root, slug))).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
        for (const f of files) {
          const file = path.join(root, slug, f); let st;
          try { st = await stat(file); } catch (e) { this.errors.push({ file, error: e.code || e.message }); continue; }
          const id = f.slice(0, -6); const key = `${profile.name}:${id}`;
          if (st.mtimeMs < since && !this.s.sessions[key]) continue;
          found.push({ key, id, profile: profile.name, profileDir: profile.dir, slug, file, size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
    return found;
  }

  async #refresh() {
    const t0 = Date.now(); this.errors = [];
    const found = await this.#listFiles();
    const seen = new Set(found.map((f) => f.key));
    for (const key of Object.keys(this.s.sessions)) if (!seen.has(key)) { delete this.s.sessions[key]; this.dirty = true; }
    const todo = found.filter((f) => { const e = this.s.sessions[f.key]; return !e || e.file !== f.file || e.size !== f.size || e.mtimeMs !== f.mtimeMs || e.offset < f.size; });
    this.status = { state: "indexing", done: 0, total: todo.length, startedAt: t0, finishedAt: null, ms: 0, parsedBytes: 0, error: null };
    todo.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first: the Monday view fills up before old history
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const f = todo[next++];
        try { await this.#parse(f); } catch (e) { this.errors.push({ file: f.file, error: e.code || e.message }); }
        this.status.done++;
        if (this.status.done % 20 === 0) await this.save().catch(() => {});
      }
    };
    await Promise.all([worker(), worker()]);
    // Subagents and workflows: recent sessions every pass (agents finish without touching the main file), old ones only when new.
    this.jobs = await this.#loadJobs();
    const recent = this.now() - 3 * DAY;
    for (const f of found) {
      const e = this.s.sessions[f.key]; if (!e) continue;
      if (e.enrichedAt && e.lastTs < recent && !todo.includes(f)) continue;
      try { await this.#enrich(e); } catch (err) { this.errors.push({ file: e.dir, error: err.code || err.message }); }
    }
    await this.save().catch(() => {});
    this.status = { ...this.status, state: "idle", finishedAt: Date.now(), ms: Date.now() - t0 };
  }

  async #parse(f) {
    let e = this.s.sessions[f.key];
    const fresh = !e || e.file !== f.file || f.size < e.offset;
    if (fresh) e = this.s.sessions[f.key] = { key: f.key, id: f.id, profile: f.profile, profileDir: f.profileDir, slug: f.slug, file: f.file, dir: f.file.slice(0, -6), offset: 0, size: 0, mtimeMs: 0, ...newSession() };
    const from = e.offset;
    let last = from;
    for await (const ln of completeLines(f.file, from, f.size)) {
      last = ln.end; this.status.parsedBytes += ln.end - ln.start;
      if (ln.buf.length < 3 || ln.buf[0] !== 0x7b) continue;
      const type = quickType(ln.buf);
      if (!type || !PARSE_TYPES.has(type)) continue;
      if (type === "user") {
        // Tool results carry the bulk of a transcript: parse one only when we are waiting for that exact result.
        const head = ln.buf.toString("latin1", 0, Math.min(ln.buf.length, 800));
        if (head.includes('"tool_result"')) { const id = TOOL_USE_ID_RE.exec(head)?.[1]; if (id && e.want[id]) { /* needed */ } else { if (id) delete e.open[id]; e.lastKind = "tool_result"; continue; } }
      }
      let rec; try { rec = JSON.parse(ln.buf.toString("utf8")); } catch { continue; }
      applyRecord(e, rec, ln.start);
    }
    e.offset = last; e.size = f.size; e.mtimeMs = f.mtimeMs; this.dirty = true;
    e.indexedAt = Date.now();
  }

  // ---- subagents, workflows, recorded job state
  async #enrich(e) {
    const subDir = path.join(e.dir, "subagents");
    let names = []; try { names = await readdir(subDir); } catch { /* no subagents */ }
    const metas = names.filter((n) => n.endsWith(".meta.json"));
    const subs = [];
    for (const n of metas) subs.push(await this.#sub(e, subDir, n.slice(0, -10), null));
    const wfDir = path.join(subDir, "workflows"); let runs = []; try { runs = await readdir(wfDir); } catch { /* none */ }
    for (const runId of runs) {
      let ns = []; try { ns = await readdir(path.join(wfDir, runId)); } catch { continue; }
      for (const n of ns.filter((x) => x.endsWith(".meta.json"))) subs.push(await this.#sub(e, path.join(wfDir, runId), n.slice(0, -10), runId));
    }
    e.subs = subs.filter(Boolean);
    e.workflows = await this.#workflows(e);
    e.job = this.jobs.get(e.key) || null;
    e.enrichedAt = Date.now(); this.dirty = true;
  }

  async #sub(e, dir, base, runId) {
    const metaFile = path.join(dir, base + ".meta.json"), file = path.join(dir, base + ".jsonl");
    let meta, st; try { meta = JSON.parse(await readFile(metaFile, "utf8")); } catch { return null; }
    try { st = await stat(file); } catch { st = null; }
    const agentId = base.replace(/^agent-/, "");
    const sig = `${st?.size ?? -1}:${meta.finished}:${meta.stoppedByUser}`;
    const prev = e.subs?.find((x) => x.agentId === agentId);
    if (prev && prev.sig === sig) return prev;
    const o = { agentId, sig, file: st ? file : null, metaFile, toolUseId: meta.toolUseId || null, agentType: meta.agentType || null, description: clip(meta.description || "", 200), spawnDepth: meta.spawnDepth ?? null, parentAgentId: meta.parentAgentId || null,
      modelArg: meta.model || null, pickedModel: meta.pickedEffortModel || null, finished: meta.finished ?? null, stoppedByUser: !!meta.stoppedByUser, worktreePath: meta.worktreePath || null, worktreeBranch: meta.worktreeBranch || null,
      runId: runId || meta.inWorkflowRun || null, phase: meta.workflowPhase ?? null, background: meta.requestShape === "background", size: st?.size ?? null, firstTs: null, lastTs: null, lastModel: null, result: null, endedOn: null };
    if (st && st.size > 0) {
      const head = await readRange(file, 0, Math.min(st.size, HEAD_BYTES));
      for (const l of head.toString("utf8").split("\n")) { if (!l.startsWith("{")) continue; try { const r = JSON.parse(l); const t = tsOf(r); if (t) { o.firstTs = t; break; } } catch { /* partial line */ } }
      const from = Math.max(0, st.size - TAIL_BYTES); const tail = await readRange(file, from, st.size);
      let lineStart = 0; const lines = [];
      for (let nl = tail.indexOf(10); nl !== -1; nl = tail.indexOf(10, lineStart)) { lines.push({ s: lineStart, b: tail.subarray(lineStart, nl) }); lineStart = nl + 1; }
      if (lineStart < tail.length) lines.push({ s: lineStart, b: tail.subarray(lineStart) });
      if (from > 0) lines.shift(); // first line is cut
      for (let i = lines.length - 1; i >= 0; i--) {
        const { s: so, b } = lines[i]; if (b[0] !== 0x7b) continue; const type = quickType(b); if (type !== "assistant" && type !== "user") continue;
        let r; try { r = JSON.parse(b.toString("utf8")); } catch { continue; }
        const t = tsOf(r); if (t && !o.lastTs) o.lastTs = t;
        if (r.type === "assistant") {
          if (!o.lastModel && r.message?.model && r.message.model !== "<synthetic>") o.lastModel = r.message.model;
          const txt = textOf(r.message?.content).trim();
          if (txt && !o.result) { o.result = { text: clip(txt, 1500), ts: t, off: from + so }; }
          if (!o.endedOn) o.endedOn = (r.message?.content || []).at(-1)?.type === "tool_use" ? "tool_use" : "text";
        } else if (!o.endedOn) o.endedOn = "tool_result";
        if (o.result && o.lastModel && o.lastTs) break;
      }
    }
    return o;
  }

  async #workflows(e) {
    const dir = path.join(e.dir, "workflows"); let names = []; try { names = await readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names.filter((x) => /^wf_.*\.json$/.test(x))) {
      try {
        const j = JSON.parse(await readFile(path.join(dir, n), "utf8"));
        const progress = Array.isArray(j.workflowProgress) ? j.workflowProgress : [];
        out.push({ runId: j.runId || n.slice(0, -5), file: path.join(dir, n), name: j.workflowName || null, status: j.status || null, ts: j.timestamp ? Date.parse(j.timestamp) : j.startTime ?? null, durationMs: j.durationMs ?? null, agentCount: j.agentCount ?? null,
          summary: clip(String(j.summary || ""), 300), result: clip(typeof j.result === "string" ? j.result : j.result == null ? "" : JSON.stringify(j.result), 1200), error: j.error ? clip(String(j.error), 300) : null,
          defaultModel: j.defaultModel || null, tokens: j.totalTokens ?? null, toolCalls: j.totalToolCalls ?? null, scriptPath: j.scriptPath || null,
          phases: (j.phases || []).map((p) => ({ title: p.title, detail: p.detail || "" })),
          agents: progress.filter((p) => p.type === "workflow_agent").map((p) => ({ label: p.label, phase: p.phaseTitle ?? null, agentId: p.agentId || null, model: p.model || null, state: p.state || null })) });
      } catch { /* unreadable workflow file */ }
    }
    return out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  }

  /** Recorded state of background jobs (`jobs/<short id>/state.json`), matched by the sessionId inside. Few sessions have one. */
  async #loadJobs() {
    const map = new Map();
    for (const profile of this.profiles) {
      const root = path.join(this.expand(profile.dir), "jobs"); let ids = []; try { ids = await readdir(root); } catch { continue; }
      for (const id of ids) {
        try {
          const j = JSON.parse(await readFile(path.join(root, id, "state.json"), "utf8")); if (!j.sessionId) continue;
          map.set(`${profile.name}:${j.sessionId}`, { state: j.state || null, detail: clip(String(j.detail || ""), 300), needs: Array.isArray(j.needs) ? j.needs.map((x) => clip(typeof x === "string" ? x : x.text || x.label || JSON.stringify(x), 200)).slice(0, 5) : [], updatedAt: j.updatedAt ? Date.parse(j.updatedAt) || null : null });
        } catch { /* no state file */ }
      }
    }
    return map;
  }

  // ---------------------------------------------------------------- live sessions
  /** sessionId -> { pid, status } for processes that really exist (a stale pid file is not "running"). */
  async live() {
    const out = new Map();
    for (const profile of this.profiles) {
      const dir = path.join(this.expand(profile.dir), "sessions"); let names = [];
      try { names = await readdir(dir); } catch { continue; }
      for (const n of names.filter((x) => /^\d+\.json$/.test(x))) {
        try {
          const j = JSON.parse(await readFile(path.join(dir, n), "utf8"));
          if (!j.sessionId || !j.pid || !(await pidMatches(j.pid, j.procStart))) continue;
          out.set(`${profile.name}:${j.sessionId}`, { pid: j.pid, status: j.status || null, kind: j.kind || null, startedAt: j.startedAt || null, name: j.name || null });
        } catch { /* stale or unreadable */ }
      }
    }
    return out;
  }

  /** The raw transcript line behind an event, with credentials removed, so every claim can be checked. */
  async rawEvent(key, ref, extra = []) {
    const e = this.get(key); if (!e) return null;
    let file = e.file;
    if (ref.f && ref.f !== "main") { const sub = e.subs?.find((x) => x.agentId === ref.f); if (!sub?.file) return null; file = sub.file; }
    const off = Number(ref.off); if (!Number.isFinite(off) || off < 0) return null;
    const st = await stat(file); if (off >= st.size) return null;
    const buf = await readRange(file, off, Math.min(st.size, off + 256 * 1024));
    const nl = buf.indexOf(10); const line = (nl === -1 ? buf : buf.subarray(0, nl)).toString("utf8");
    if (!line.startsWith("{")) return null;
    let pretty = line; try { pretty = JSON.stringify(JSON.parse(line), (k, v) => (typeof v === "string" && v.length > 2000 ? v.slice(0, 2000) + "…" : v), 1); } catch { /* truncated line: show as is */ }
    return { file, off, text: redact(clip(pretty, 20000), extra) };
  }
}

async function pidMatches(pid, procStart) {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22: start time in clock ticks
    if (procStart && start && String(procStart) !== start) return false; // pid was reused by another process
  } catch { /* no /proc: pid check is all we have */ }
  return true;
}

export { questionsIn };
