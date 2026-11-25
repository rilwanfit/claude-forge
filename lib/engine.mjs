// Workflows, runs, the runner and the scheduler. State lives in <data>/store.json; each run has a folder
// <data>/runs/<id>/ with its prompt, Claude's stream-json log per segment and its output files.
// Runner processes are detached, so they survive a dashboard restart; the monitor re-attaches by pid.
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, rename, mkdir, readdir, stat, open, rm } from "node:fs/promises";
import { occurrences, nextRun, planDue, resolveInputs, renderTemplate, describeSchedule } from "./schedule.mjs";

const HOME = os.homedir();
export const expand = (p) => (p?.startsWith("~") ? path.join(HOME, p.slice(1)) : p);
const uid = () => crypto.randomBytes(5).toString("hex");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

const ACTIVE = new Set(["queued", "running"]);
const WAITING = new Set(["needs_review", "needs_input", "blocked"]);
const ICONS = ["chart", "search", "write", "scan", "globe", "play"];
const BASE_TOOLS = ["Read", "Glob", "Grep"];

// ---------------------------------------------------------------- redaction (logs are shown, never secrets)
import { redact } from "./redact.mjs";
export { redact };

export class Engine {
  constructor({ dataDir, config, claudeBin, now = () => Date.now(), tickMs = 15_000 }) {
    this.dir = dataDir; this.config = config; this.claudeBin = claudeBin; this.now = now; this.tickMs = tickMs;
    this.file = path.join(dataDir, "store.json");
    this.store = { workflows: {}, runs: {}, scheduler: { lastTick: null, missed: [], skipped: [] } };
    this.restarting = new Set(); this.locks = new Map();
    this.secretValues = (config.secretEnv || []).map((n) => process.env[n]).filter(Boolean);
  }

  async init() {
    await mkdir(path.join(this.dir, "runs"), { recursive: true });
    try { this.store = { ...this.store, ...JSON.parse(await readFile(this.file, "utf8")) }; } catch { /* first run */ }
    this.previousTick = this.store.scheduler.lastTick;
    this.startedAt = this.now();
    // Runs that were queued when we stopped are started again; running ones are re-attached by pid in monitor().
    await this.tickScheduler();
    this.timers = [setInterval(() => this.tickScheduler().catch((e) => console.error("scheduler:", e)), this.tickMs), setInterval(() => this.monitor().catch((e) => console.error("monitor:", e)), 1000)];
    this.timers.forEach((t) => t.unref?.());
    return this;
  }
  stop() { this.timers?.forEach(clearInterval); }

  async save() {
    this.saving = (this.saving || Promise.resolve()).then(async () => { await writeFile(this.file + ".tmp", JSON.stringify(this.store)); await rename(this.file + ".tmp", this.file); });
    return this.saving;
  }

  // ------------------------------------------------------------ workflows
  validateWorkflow(w) {
    const name = String(w.name || "").trim();
    if (!name || name.length > 60) throw new HttpError(400, "Name is required (max 60 characters)");
    const instructions = String(w.instructions || "").trim();
    if (!instructions) throw new HttpError(400, "Instructions are required");
    const projectKey = String(w.projectKey || "");
    const folder = expand(String(w.folder || projectKey));
    if (!folder || !path.isAbsolute(folder)) throw new HttpError(400, "Project folder must be an absolute path");
    const inputs = (w.inputs || []).map((i) => {
      const n = String(i.name || "").trim();
      if (!/^[a-z][a-z0-9_]{0,30}$/.test(n)) throw new HttpError(400, `Input name "${n}" must be lowercase letters, digits or _`);
      return i.type === "period" ? { name: n, label: String(i.label || n), type: "period", days: Math.max(1, Math.min(366, Number(i.days) || 7)) } : { name: n, label: String(i.label || n), type: "text", default: String(i.default ?? ""), required: !!i.required };
    });
    // Fail on a bad template now, not at 03:00 on the first scheduled run.
    try { renderTemplate(instructions, resolveInputs(inputs.map((i) => ({ ...i, required: false })), {}, new Date(this.now())).flat); } catch (e) { throw new HttpError(400, e.message); }
    const sc = w.schedule || {};
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(sc.time || "") ? sc.time : "08:00";
    const schedule = { enabled: !!sc.enabled, paused: !!sc.paused, days: [...new Set((sc.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort(), time, missed: sc.missed === "skip" ? "skip" : "latest" };
    const review = w.review?.enabled ? { enabled: true, question: String(w.review.question || "Publish this?").slice(0, 200), action: String(w.review.action || "").slice(0, 2000), tools: (w.review.tools || []).map(String) } : { enabled: false };
    if (review.enabled && !review.action) throw new HttpError(400, "A review step needs the action to carry out after you approve");
    return {
      name, icon: ICONS.includes(w.icon) ? w.icon : "play", projectKey, folder, instructions, inputs, schedule, review,
      allowedTools: (w.allowedTools || []).map(String).filter(Boolean), requires: (w.requires || []).map(String), outputDir: w.outputDir ? String(w.outputDir) : "", profile: String(w.profile || this.config.defaultProfile || this.config.profiles?.[0]?.name || ""), model: w.model ? String(w.model) : "",
    };
  }

  async saveWorkflow(body) {
    const v = this.validateWorkflow(body);
    try { if (!(await stat(v.folder)).isDirectory()) throw 0; } catch { throw new HttpError(400, `Project folder does not exist: ${v.folder}`); }
    const old = body.id ? this.store.workflows[body.id] : null;
    if (body.id && !old) throw new HttpError(404, "Workflow not found");
    const id = old?.id || `wf_${uid()}`;
    // A schedule only counts from the moment it was set: switching it on never backfills the past.
    const schedChanged = !old || JSON.stringify({ ...old.schedule, checkedAt: 0 }) !== JSON.stringify({ ...v.schedule, checkedAt: 0 });
    const wf = { ...(old || {}), ...v, id, createdAt: old?.createdAt ?? this.now(), updatedAt: this.now(), lastInputs: old?.lastInputs ?? null, fromSession: body.fromSession ?? old?.fromSession ?? null };
    wf.schedule.checkedAt = schedChanged ? this.now() : old.schedule.checkedAt ?? this.now();
    this.store.workflows[id] = wf;
    await this.save();
    return wf;
  }

  async deleteWorkflow(id) {
    if (!this.store.workflows[id]) throw new HttpError(404, "Workflow not found");
    if (this.runsOf(id).some((r) => ACTIVE.has(r.status))) throw new HttpError(409, "Stop its active run first");
    delete this.store.workflows[id]; // runs keep their own snapshot of the workflow, so history survives
    await this.save();
  }

  runsOf(wfId) { return Object.values(this.store.runs).filter((r) => r.workflowId === wfId); }

  async setPaused(id, paused) {
    const wf = this.store.workflows[id]; if (!wf) throw new HttpError(404, "Workflow not found");
    wf.schedule.paused = !!paused; wf.schedule.checkedAt = this.now(); // resuming never backfills
    await this.save(); return wf;
  }

  // ------------------------------------------------------------ connections
  async mcpConfigured(profileName, folder, name) {
    const prof = (this.config.profiles || []).find((p) => p.name === profileName) || this.config.profiles?.[0];
    if (!prof) return false;
    try {
      const j = JSON.parse(await readFile(path.join(expand(prof.dir), ".claude.json"), "utf8"));
      if (j.mcpServers?.[name]) return true;
      for (const [p, v] of Object.entries(j.projects || {})) if ((folder === p || folder.startsWith(p + "/")) && v.mcpServers?.[name]) return true;
    } catch { /* no config */ }
    try { if (JSON.parse(await readFile(path.join(folder, ".mcp.json"), "utf8")).mcpServers?.[name]) return true; } catch { /* none */ }
    return false;
  }

  async checkConnections(wf) {
    const missing = [];
    for (const id of wf.requires || []) {
      const def = this.config.connections?.[id];
      if (!def) { missing.push({ id, label: id, detail: `"${id}" is not defined under "connections" in config.json` }); continue; }
      let ok = true;
      if (def.mcp) ok = await this.mcpConfigured(wf.profile, wf.folder, def.mcp);
      else if (def.command) ok = await new Promise((r) => execFile(def.command[0], def.command.slice(1), { timeout: 15_000 }, (e) => r(!e)));
      if (!ok) missing.push({ id, label: def.label || id, detail: def.mcp ? `MCP server "${def.mcp}" is not configured for profile "${wf.profile}" in ${wf.folder}` : `"${def.command.join(" ")}" failed`, fix: def.fix || "" });
    }
    return missing;
  }

  // ------------------------------------------------------------ runs
  openRun(wfId) { return this.runsOf(wfId).find((r) => ACTIVE.has(r.status) || WAITING.has(r.status)); }

  /** Starts for one workflow run one at a time, so two clicks can never both pass the "already running" check. */
  startRun(wfId, opts = {}) {
    const prev = this.locks.get(wfId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.startRunLocked(wfId, opts));
    this.locks.set(wfId, next.catch(() => {}));
    return next;
  }

  async startRunLocked(wfId, { inputs, trigger = "manual", scheduledFor = null, late = false, requestId = null, replaces = null, resolved = null } = {}) {
    const wf = this.store.workflows[wfId]; if (!wf) throw new HttpError(404, "Workflow not found");
    if (requestId) { const dup = Object.values(this.store.runs).find((r) => r.requestId === requestId); if (dup) return dup; }
    const active = this.runsOf(wfId).find((r) => ACTIVE.has(r.status));
    if (active) throw new HttpError(409, `"${wf.name}" is already running`, { runId: active.id });
    let res;
    try { res = resolved || resolveInputs(wf.inputs, inputs ?? wf.lastInputs ?? {}, new Date(this.now())); } catch (e) { throw new HttpError(400, e.message); }
    const id = `run_${new Date(this.now()).toISOString().slice(0, 10).replace(/-/g, "")}_${uid()}`;
    const runDir = path.join(this.dir, "runs", id);
    const outputDir = wf.outputDir ? path.join(path.isAbsolute(expand(wf.outputDir)) ? expand(wf.outputDir) : path.join(wf.folder, wf.outputDir), id) : path.join(runDir, "output");
    await mkdir(outputDir, { recursive: true });
    const flat = { ...res.flat, outputDir, project: path.basename(wf.projectKey || wf.folder) };
    let instructions;
    try { instructions = renderTemplate(wf.instructions, flat); } catch (e) { throw new HttpError(400, e.message); }
    const run = {
      id, workflowId: wf.id, workflowName: wf.name, icon: wf.icon, projectKey: wf.projectKey, folder: wf.folder, profile: wf.profile, trigger, scheduledFor, late,
      status: "queued", createdAt: this.now(), startedAt: null, endedAt: null, sessionId: crypto.randomUUID(), requestId,
      instructions, inputs: res.values, flat, supplied: inputs ?? wf.lastInputs ?? {}, tools: wf.allowedTools, requires: wf.requires, review: wf.review, model: wf.model,
      outputDir, extraDirs: wf.extraDirs || [], system: !!wf.system, segments: [], activity: { steps: 0, last: "", at: null }, result: null, decision: null, blocker: null, error: null, replaces, replacedBy: null,
    };
    this.store.runs[id] = run;
    if (trigger === "manual" || trigger === "rerun") wf.lastInputs = run.supplied;
    const missing = await this.checkConnections(wf);
    if (missing.length) { run.status = "blocked"; run.blocker = { missing }; run.endedAt = this.now(); }
    await this.save();
    if (!missing.length) await this.pump();
    return run;
  }

  contract(run, kind) {
    const lines = [
      "", "---", "Run contract from the dashboard (follow it exactly):",
      `- Write the result as Markdown to ${path.join(run.outputDir, "report.md")}. Other files may go in the same folder.`,
      "- End your final answer with one line: FINDING: <one sentence with the key result>.",
      "- If you cannot continue without a decision from the owner, do not guess: end with one line QUESTION: <the exact decision needed>.",
    ];
    if (run.review?.enabled && kind === "run") lines.push("- Do NOT publish, send, post or change anything outside the output folder in this step. Prepare it as a draft in report.md; the owner reviews it first.");
    return lines.join("\n");
  }

  async pump() {
    const max = this.config.maxConcurrent ?? 2;
    let running = Object.values(this.store.runs).filter((r) => r.status === "running").length;
    for (const r of Object.values(this.store.runs).filter((x) => x.status === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
      if (running >= max) break;
      await this.launch(r, r.pending || { kind: "run" }); running++;
    }
  }

  async launch(run, { kind, message }) {
    if (!run.segments.length) kind = "run"; // stopped while still queued: nothing to continue yet
    const n = run.segments.length + 1;
    const dir = path.join(this.dir, "runs", run.id);
    const prompt = (kind === "run" ? run.instructions : message) + this.contract(run, kind);
    await writeFile(path.join(dir, `prompt-${n}.txt`), prompt);
    const tools = [...BASE_TOOLS, `Edit(//${run.outputDir.replace(/^\//, "")}/**)`, ...run.tools, ...(kind === "publish" ? run.review.tools : [])];
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--allowedTools", tools.join(","), "--add-dir", run.outputDir, ...(run.extraDirs || []).flatMap((d) => ["--add-dir", d])];
    if (run.segments.length === 0) args.push("--session-id", run.sessionId); else args.push("--resume", run.sessionId);
    if (run.model) args.push("--model", run.model);
    const logPath = path.join(dir, `log-${n}.jsonl`), exitPath = path.join(dir, `exit-${n}`);
    const out = await open(logPath, "a");
    const env = { ...process.env, DASHBOARD_RUN: run.id };
    const prof = (this.config.profiles || []).find((p) => p.name === run.profile);
    if (prof) env.CLAUDE_CONFIG_DIR = expand(prof.dir);
    // sh records the exit code in a file, so a dashboard restart can still learn how the run ended.
    const child = spawn("sh", ["-c", '"$@"; echo $? > "$EXITFILE"', "sh", this.claudeBin, ...args], { cwd: run.folder, env: { ...env, EXITFILE: exitPath }, detached: true, stdio: ["ignore", out.fd, out.fd] });
    child.on("error", () => {}); child.unref(); await out.close();
    run.segments.push({ n, kind, message: message ? clip(message, 500) : null, startedAt: this.now(), endedAt: null, pid: child.pid, offset: 0, log: logPath, exit: exitPath });
    run.status = "running"; run.startedAt ??= this.now(); run.endedAt = null; run.pending = null; run.decision = null;
    await this.save();
  }

  // ------------------------------------------------------------ monitor: tail logs, detect the end
  async monitor() {
    for (const run of Object.values(this.store.runs)) {
      if (run.status !== "running") continue;
      const seg = run.segments.at(-1);
      if (!seg) { run.status = "failed"; run.error = "The run has no process to follow."; run.endedAt = this.now(); await this.save(); continue; }
      try { await this.readProgress(run, seg); } catch { /* log not there yet */ }
      let code = null;
      try { code = Number((await readFile(seg.exit, "utf8")).trim()); } catch { /* still running or killed */ }
      if (code === null && !alive(seg.pid)) { await sleep(150); try { code = Number((await readFile(seg.exit, "utf8")).trim()); } catch { code = run.stopRequested ? 143 : -1; } }
      if (code !== null) { await this.readProgress(run, seg).catch(() => {}); await this.finish(run, seg, code); }
    }
    if (Object.values(this.store.runs).some((r) => r.status === "queued")) await this.pump();
  }

  async readProgress(run, seg) {
    const st = await stat(seg.log);
    if (st.size <= seg.offset) return;
    const fh = await open(seg.log, "r");
    const buf = Buffer.alloc(st.size - seg.offset);
    await fh.read(buf, 0, buf.length, seg.offset); await fh.close();
    const text = buf.toString("utf8");
    const cut = text.lastIndexOf("\n") + 1; // never parse a half-written line
    seg.offset += Buffer.byteLength(text.slice(0, cut));
    for (const line of text.slice(0, cut).split("\n")) {
      if (!line.startsWith("{")) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.session_id && rec.type === "system") run.sessionId = rec.session_id;
      if (rec.type === "assistant") for (const b of rec.message?.content || []) {
        if (b.type === "tool_use") { run.activity.steps++; run.activity.last = toolLabel(b); run.activity.at = this.now(); }
      }
      if (rec.type === "result") seg.result = { text: rec.result ?? "", isError: !!rec.is_error, cost: rec.total_cost_usd ?? null };
    }
    await this.save();
  }

  async finish(run, seg, code) {
    seg.endedAt = this.now(); seg.code = code;
    run.endedAt = this.now();
    const res = seg.result;
    if (run.stopRequested) { run.status = "stopped"; run.stopRequested = false; }
    else if (code !== 0 || !res || res.isError) { run.status = "failed"; run.error = clip(redact(res?.text || (code === -1 ? "The runner stopped without an answer (machine restarted?). Resume to continue." : `Claude exited with code ${code}`), this.secretValues), 600); }
    else {
      const text = res.text;
      const q = /^\s*QUESTION:\s*(.+)$/m.exec(text)?.[1];
      run.error = null;
      if (q) { run.status = "needs_input"; run.decision = { kind: "question", text: clip(q.trim(), 400) }; }
      else if (run.review?.enabled && seg.kind === "run") { run.status = "needs_review"; run.decision = { kind: "review", text: run.review.question, action: run.review.action }; }
      else run.status = "done";
      run.result = await this.buildResult(run, text);
    }
    await this.save();
    await this.pump();
  }

  async buildResult(run, text) {
    const files = [];
    const walk = async (d, rel = "") => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) { if (e.isDirectory()) await walk(path.join(d, e.name), rel + e.name + "/"); else files.push(rel + e.name); } };
    await walk(run.outputDir);
    const primary = files.includes("report.md") ? "report.md" : files.find((f) => /\.(md|html)$/.test(f)) || files[0] || null;
    const finding = /^\s*FINDING:\s*(.+)$/m.exec(text)?.[1]?.trim() || text.split("\n").map((l) => l.trim()).find((l) => l.length > 20) || "";
    return { finding: clip(redact(finding, this.secretValues), 300), primary, files, summary: clip(redact(text, this.secretValues), 6000) };
  }

  // ------------------------------------------------------------ controls
  getRun(id) { const r = this.store.runs[id]; if (!r) throw new HttpError(404, "Run not found"); return r; }

  async stopRun(id) {
    const run = this.getRun(id);
    if (run.status === "queued") { run.status = "stopped"; run.endedAt = this.now(); await this.save(); return run; }
    if (run.status !== "running") throw new HttpError(409, "This run is not running");
    const seg = run.segments.at(-1);
    run.stopRequested = true; await this.save();
    const kill = (sig) => { try { process.kill(-seg.pid, sig); } catch { try { process.kill(seg.pid, sig); } catch { /* gone */ } } };
    kill("SIGTERM");
    for (let i = 0; i < 40 && alive(seg.pid); i++) await sleep(100);
    if (alive(seg.pid)) { kill("SIGKILL"); for (let i = 0; i < 20 && alive(seg.pid); i++) await sleep(100); }
    if (alive(seg.pid)) throw new HttpError(500, "The run did not stop. Nothing new was started.");
    await this.readProgress(run, seg).catch(() => {});
    if (run.status === "running") await this.finish(run, seg, 143);
    return run;
  }

  /** Stop the active attempt, confirm it is gone, then launch a linked replacement. Idempotent per run. */
  async restartRun(id) {
    const run = this.getRun(id);
    if (run.replacedBy) return this.store.runs[run.replacedBy];
    if (this.restarting.has(id)) throw new HttpError(409, "Restart already in progress");
    this.restarting.add(id);
    try {
      if (ACTIVE.has(run.status)) await this.stopRun(id);
      const next = await this.startRun(run.workflowId, { trigger: "restart", replaces: id, resolved: { values: run.inputs, flat: run.flat }, inputs: run.supplied });
      run.replacedBy = next.id; await this.save();
      return next;
    } finally { this.restarting.delete(id); }
  }

  async continueRun(id, kind, message) {
    const run = this.getRun(id);
    const ok = kind === "answer" ? run.status === "needs_input" : kind === "publish" ? run.status === "needs_review" : ["failed", "stopped"].includes(run.status);
    if (!ok) throw new HttpError(409, `Cannot ${kind} a run that is ${run.status}`);
    run.status = "queued"; run.pending = { kind, message }; run.error = null; // claimed before launching: a second click finds it queued
    await this.save(); await this.pump(); return run;
  }
  resumeRun(id) { const r = this.getRun(id); return this.continueRun(id, "resume", "Continue where you stopped. Finish the task as instructed."); }
  answerRun(id, text) { if (!String(text || "").trim()) throw new HttpError(400, "Write your answer first"); return this.continueRun(id, "answer", `My answer: ${String(text).trim()}\nContinue and finish the task.`); }
  approveRun(id, note) { const r = this.getRun(id); return this.continueRun(id, "publish", `Approved by the owner${note ? ` (note: ${String(note).trim()})` : ""}. Now carry out: ${r.review.action}\nThen end with a FINDING: line saying what was done.`); }
  async rejectRun(id, note) {
    const run = this.getRun(id);
    if (run.status !== "needs_review") throw new HttpError(409, "Nothing to reject");
    run.status = "rejected"; run.decision = { ...run.decision, rejectedNote: String(note || "").slice(0, 300) }; run.endedAt = this.now(); await this.save(); return run;
  }

  // ------------------------------------------------------------ scheduler
  async tickScheduler() {
    const now = this.now();
    const sch = this.store.scheduler;
    for (const wf of Object.values(this.store.workflows)) {
      const s = wf.schedule; if (!s?.enabled) continue;
      const from = s.checkedAt ?? now;
      if (s.paused) { s.checkedAt = now; continue; }
      const due = occurrences(s, from, now);
      s.checkedAt = now;
      if (!due.length) continue;
      const plan = planDue(due, now, { policy: s.missed, graceMs: Math.max(5 * 60_000, this.tickMs * 3), windowMs: (this.config.catchUpWindowHours ?? 12) * 3600_000 });
      for (const m of plan.missed) sch.missed.push({ workflowId: wf.id, workflow: wf.name, at: m.at, reason: m.reason, recordedAt: now });
      if (plan.start) {
        const dup = this.runsOf(wf.id).some((r) => r.scheduledFor === plan.start.at);
        const open = this.openRun(wf.id);
        if (dup) continue;
        if (open) sch.skipped.push({ workflowId: wf.id, workflow: wf.name, at: plan.start.at, reason: `previous run still ${open.status.replace("_", " ")}`, recordedAt: now });
        else await this.startRun(wf.id, { trigger: "schedule", scheduledFor: plan.start.at, late: plan.start.late, inputs: wf.lastInputs ?? {} }).catch((e) => sch.skipped.push({ workflowId: wf.id, workflow: wf.name, at: plan.start.at, reason: e.message, recordedAt: now }));
      }
    }
    sch.missed = sch.missed.slice(-100); sch.skipped = sch.skipped.slice(-100);
    sch.lastTick = now;
    await this.save();
  }

  health() {
    const now = this.now(); const sch = this.store.scheduler;
    const next = Object.values(this.store.workflows).filter((w) => w.schedule?.enabled && !w.schedule.paused).map((w) => ({ w, at: nextRun(w.schedule, now) })).filter((x) => x.at).sort((a, b) => a.at - b.at)[0];
    const gap = this.previousTick ? this.startedAt - this.previousTick : null;
    return {
      ok: sch.lastTick != null && now - sch.lastTick < this.tickMs * 3 + 2000, lastTick: sch.lastTick, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, tickSeconds: this.tickMs / 1000,
      startedAt: this.startedAt, offlineGapMs: gap && gap > this.tickMs * 3 ? gap : 0, next: next ? { at: next.at, workflowId: next.w.id, workflow: next.w.name } : null,
      missed: sch.missed.slice(-20).reverse(), skipped: sch.skipped.slice(-20).reverse(), catchUp: `After a gap the scheduler starts at most one catch-up run per workflow (only if it was due within ${this.config.catchUpWindowHours ?? 12} h) and lists the rest as missed. Workflows set to "skip" never catch up.`,
    };
  }

  // ------------------------------------------------------------ views
  async logLines(run, after = 0) {
    const lines = [];
    for (const seg of run.segments) {
      let text = ""; try { text = await readFile(seg.log, "utf8"); } catch { continue; }
      lines.push({ t: seg.startedAt, kind: "segment", text: `${seg.kind === "run" ? "Started" : seg.kind === "publish" ? "Approved, carrying out the action" : seg.kind === "answer" ? "Answered, continuing" : "Resumed"}` });
      for (const l of text.split("\n")) {
        if (!l.startsWith("{")) { if (l.trim()) lines.push({ kind: "error", text: l }); continue; }
        let rec; try { rec = JSON.parse(l); } catch { continue; }
        if (rec.type === "assistant") for (const b of rec.message?.content || []) {
          if (b.type === "text" && b.text.trim()) lines.push({ kind: "text", text: b.text.trim() });
          if (b.type === "tool_use") lines.push({ kind: "tool", text: toolLabel(b) });
        }
        if (rec.type === "result") lines.push({ kind: rec.is_error ? "error" : "result", text: rec.result || "" });
      }
    }
    return lines.slice(after).map((l) => ({ ...l, text: clip(redact(l.text, this.secretValues), 4000) }));
  }

  publicRun(r, { full = false } = {}) {
    const { segments, pending, stopRequested, ...rest } = r;
    const out = { ...rest, segments: segments.map(({ n, kind, message, startedAt, endedAt, code }) => ({ n, kind, message, startedAt, endedAt, code })) };
    if (!full) { delete out.instructions; delete out.flat; delete out.supplied; }
    return out;
  }
}

function toolLabel(b) {
  const i = b.input || {};
  const arg = i.file_path || i.path || i.pattern || i.command || i.url || i.query || i.description || "";
  return clip(`${b.name}${arg ? " " + String(arg).replace(/\s+/g, " ") : ""}`, 160);
}
export { ACTIVE, WAITING, describeSchedule };
