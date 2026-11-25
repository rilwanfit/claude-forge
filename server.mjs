// Claude Forge: what is done and what needs you, across Claude profiles, git and GitHub.
// Local only (127.0.0.1) unless "host" is set, which then requires an access token. No dependencies: Node 22 or later.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { readFile, writeFile, readdir, stat, open, rename, mkdir } from "node:fs/promises";
import { Engine, HttpError, redact, ACTIVE, WAITING, expand as expandPath } from "./lib/engine.mjs";
import { occurrences, nextRun, describeSchedule } from "./lib/schedule.mjs";
import { renderMarkdown } from "./mdview.mjs";
import { textOf, promptText, questionsIn } from "./lib/text.mjs";
import { TranscriptIndex } from "./lib/index.mjs";
import * as V from "./lib/views.mjs";
import * as H from "./lib/handoff.mjs";
import { loadConfig } from "./lib/config.mjs";
import { EventLog, liveState } from "./lib/hooks.mjs";
import { summarize as summarizeUsage } from "./lib/usage.mjs";
import { suggestOptions } from "./lib/options.mjs";
import { fetchSource } from "./lib/sources.mjs";
import { fetchPeer } from "./lib/peers.mjs";
import { Replies, BASE_TOOLS as REPLY_BASE } from "./lib/reply.mjs";
import { Notifier, makeDeliver, DEFAULT_EVENTS } from "./lib/notify.mjs";

const run = promisify(execFile);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const expand = (p) => (p.startsWith("~") ? path.join(HOME, p.slice(1)) : p);
const DAY = 86_400_000;

const { config, userConfig } = await loadConfig(HERE);
if (process.env.PORT) config.port = Number(process.env.PORT);
if (config.timezone) process.env.TZ = config.timezone; // before any Date is used: the scheduler runs on local time
const DATA_DIR = process.env.DASH_DATA || path.join(HERE, "data");
const STATE_FILE = process.env.DASH_STATE || path.join(HERE, "state.json");
let saved = { dismissed: {} };
try { saved = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { /* first run */ }
const persist = async () => {
  await writeFile(STATE_FILE + ".tmp", JSON.stringify(saved, null, 1));
  await rename(STATE_FILE + ".tmp", STATE_FILE);
};

const hash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

async function sh(cmd, args, opts = {}) {
  try {
    const { stdout } = await run(cmd, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...opts });
    return stdout;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Sessions

/** Per transcript file: what we already parsed, so a refresh only reads what was appended. */
const sessionCache = new Map();
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

async function readRange(file, start, end) {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

function applyLines(s, chunk) {
  for (const line of chunk.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.cwd && !s.cwd) s.cwd = rec.cwd;
    if (rec.gitBranch) s.branch = rec.gitBranch;
    if (rec.type === "ai-title" && rec.aiTitle) s.title = rec.aiTitle;
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
    const prompt = promptText(rec);
    if (prompt !== null) {
      s.lastPrompt = { text: clip(prompt, 300), ts };
      if (!s.firstPrompt && !prompt.startsWith("/")) { s.firstPrompt = clip(prompt, 120); s.firstPromptFull = clip(prompt, 4000); }
    }
    if (rec.type === "assistant" && !rec.isSidechain) {
      const t = textOf(rec.message?.content).trim();
      if (t) s.lastAnswer = { text: t, ts, uuid: rec.uuid };
    }
    if (rec.type === "system" && rec.subtype === "turn_duration") s.lastTurnEnd = ts;
  }
}

async function parseSession(file, size) {
  let s = sessionCache.get(file);
  if (s && s.size === size) return s;
  if (!s || size < s.size) {
    s = { size: 0 };
    // Head for cwd and the first prompt, tail for the latest state: never the whole file.
    applyLines(s, await readRange(file, 0, Math.min(size, HEAD_BYTES)));
    const from = Math.max(HEAD_BYTES, size - TAIL_BYTES);
    if (size > HEAD_BYTES) {
      const tail = await readRange(file, from, size);
      applyLines(s, from > HEAD_BYTES ? tail.slice(tail.indexOf("\n") + 1) : tail);
    }
  } else {
    const chunk = await readRange(file, s.size, size);
    applyLines(s, chunk.slice(0, chunk.lastIndexOf("\n") + 1));
  }
  s.size = size;
  sessionCache.set(file, s);
  return s;
}

async function collectSessions() {
  const since = Date.now() - Math.max(config.sessionDays, config.doneDays) * DAY;
  const sessions = [];
  for (const profile of config.profiles) {
    const root = path.join(expand(profile.dir), "projects");
    let slugs;
    try { slugs = await readdir(root); } catch { continue; }
    for (const slug of slugs) {
      let files;
      try { files = (await readdir(path.join(root, slug))).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const file = path.join(root, slug, f);
        let st;
        try { st = await stat(file); } catch { continue; }
        if (st.mtimeMs < since) continue;
        try {
          const s = await parseSession(file, st.size);
          if (!s.lastAnswer && !s.lastPrompt) continue;
          sessions.push({ ...s, id: f.replace(/\.jsonl$/, ""), profile: profile.name, profileDir: profile.dir, mtime: st.mtimeMs, file });
        } catch { /* unreadable transcript: skip */ }
      }
    }
  }
  return sessions;
}

// ---------------------------------------------------------------- Projects

const repoRootCache = new Map();
async function repoRootOf(dir) {
  if (!dir) return null;
  if (repoRootCache.has(dir)) return repoRootCache.get(dir);
  // A worktree that was removed since: its project is the checkout that held it.
  const wt = dir.indexOf("/.claude/worktrees/");
  if (wt > 0) {
    const root = await repoRootOf(dir.slice(0, wt));
    repoRootCache.set(dir, root);
    return root;
  }
  // A worktree belongs to the project of its main checkout.
  const common = await sh("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const root = common ? path.dirname(common.trim()) : null;
  repoRootCache.set(dir, root);
  return root;
}

const projectName = (root, cwd) => (root ? path.basename(root) : cwd === HOME ? "~ (home)" : cwd ? path.basename(cwd) : "unknown");

async function githubRepoOf(root) {
  const url = await sh("git", ["-C", root, "remote", "get-url", "origin"]);
  const m = url && /github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?\s*$/.exec(url.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- Git and GitHub

async function gitFacts(root) {
  const facts = { commits: [], loose: [] };
  const log = await sh("git", ["-C", root, "log", "--branches", "--remotes", "--no-merges", `--since=${config.doneDays}.days`, "--format=%H%x09%ct%x09%an%x09%s", "-n", "40"]);
  const seen = new Set();
  for (const line of (log || "").split("\n").filter(Boolean)) {
    const [sha, ct, author, subject] = line.split("\t");
    if (seen.has(subject)) continue;
    seen.add(subject);
    facts.commits.push({ sha: sha.slice(0, 8), ts: Number(ct) * 1000, author, subject });
  }
  const wts = await sh("git", ["-C", root, "worktree", "list", "--porcelain"]);
  for (const block of (wts || "").split("\n\n")) {
    const wt = /^worktree (.+)$/m.exec(block)?.[1];
    if (!wt) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "detached";
    const dirty = await sh("git", ["-C", wt, "status", "--porcelain"]);
    const n = dirty === null ? 0 : dirty.split("\n").filter(Boolean).length;
    if (n > 0) facts.loose.push({ kind: "dirty", text: `${n} uncommitted file${n === 1 ? "" : "s"} in ${wt === root ? "the main checkout" : path.relative(root, wt)} (${branch})`, key: `dirty:${wt}:${n}` });
  }
  const refs = await sh("git", ["-C", root, "for-each-ref", "refs/heads", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)"]);
  for (const line of (refs || "").split("\n").filter(Boolean)) {
    const [branch, upstream, track] = line.split("\t");
    const ahead = /ahead (\d+)/.exec(track || "")?.[1];
    if (upstream && ahead) facts.loose.push({ kind: "unpushed", text: `${branch}: ${ahead} commit${ahead === "1" ? "" : "s"} not pushed`, key: `ahead:${root}:${branch}:${ahead}` });
  }
  return facts;
}

async function githubFacts(repo) {
  const facts = { prsOpen: [], prsMerged: [], issuesInput: [], error: null };
  const sinceDate = new Date(Date.now() - config.doneDays * DAY).toISOString().slice(0, 10);
  const json = async (args) => {
    const out = await sh("gh", args, { timeout: 45_000 });
    if (out === null) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed`);
    return JSON.parse(out || "[]");
  };
  try {
    facts.prsOpen = await json(["pr", "list", "-R", repo, "--state", "open", "--limit", "30", "--json", "number,title,url,isDraft,updatedAt,headRefName"]);
    facts.prsMerged = await json(["pr", "list", "-R", repo, "--state", "merged", "--limit", "30", "--search", `merged:>=${sinceDate}`, "--json", "number,title,url,mergedAt"]);
    for (const label of config.inputLabels) {
      const issues = await sh("gh", ["issue", "list", "-R", repo, "--state", "open", "--label", label, "--limit", "50", "--json", "number,title,url,updatedAt"], { timeout: 45_000 });
      if (issues) facts.issuesInput.push(...JSON.parse(issues).map((i) => ({ ...i, label })));
    }
  } catch (err) {
    facts.error = err.message;
  }
  return facts;
}

/** Unchecked "- [ ]" items of a living checklist file, such as founder-actions.md. */
async function inputFileItems(spec) {
  const file = path.join(expand(spec.repo), spec.path);
  let text;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  return text.split("\n").filter((l) => /^\s*-\s\[ \]\s/.test(l)).map((l) => {
    const body = l.replace(/^\s*-\s\[ \]\s*/, "");
    const bold = /\*\*(.+?)\*\*/.exec(body)?.[1];
    return { title: clip((bold || body).replace(/[`*]/g, ""), 160), detail: clip(body.replace(/\*\*/g, "").replace(/`/g, ""), 700), key: `file:${spec.path}:${hash(body)}`, file: spec.path };
  });
}

// ---------------------------------------------------------------- Assemble

const sessionIndex = new Map(); // session id -> where to resume it; the browser never sends a path or command
let githubCache = { at: 0, byRepo: {} };
let snapshot = { generatedAt: null, projects: [], sources: [] };
const EVENTS_FILE = process.env.DASH_EVENTS || path.join(HOME, ".config", "claude-forge", "events.jsonl");
const eventLog = new EventLog(EVENTS_FILE);
const hookKey = (profileDir, id) => `${path.resolve(expand(profileDir))}:${id}`;
let building = null;
let extCache = { at: 0, byName: {} };

async function build({ forceGithub = false } = {}) {
  const t0 = Date.now();
  const sources = [];
  const hookStates = await eventLog.poll();
  const sessions = await collectSessions();
  sources.push({ name: "Claude sessions", ok: true, detail: `${sessions.length} sessions in ${config.profiles.length} profiles` });

  const projects = new Map();
  const projectFor = async (cwd) => {
    const root = await repoRootOf(cwd);
    const key = root || cwd || "unknown";
    if (!projects.has(key)) projects.set(key, { key, name: projectName(root, cwd), root, repo: null, input: [], done: [], loose: [], running: [] });
    return projects.get(key);
  };

  const inputSince = Date.now() - config.sessionDays * DAY;
  const doneSince = Date.now() - config.doneDays * DAY;
  sessionIndex.clear();
  for (const s of sessions) {
    sessionIndex.set(s.id, { cwd: s.cwd, profileDir: s.profileDir, profile: s.profile, file: s.file });
    const p = await projectFor(s.cwd);
    const title = s.title || s.firstPrompt || "Untitled session";
    const resume = `cd ${s.cwd || HOME} && CLAUDE_CONFIG_DIR=${s.profileDir} claude --resume ${s.id}`;
    const base = { title, profile: s.profile, branch: s.branch, cwd: s.cwd, sessionId: s.id, resume, ts: s.mtime, projectKey: p.key, prompt: s.firstPromptFull || "" };
    const answerTs = s.lastAnswer?.ts ?? 0;
    const promptTs = s.lastPrompt?.ts ?? 0;
    // Hook events (when installed) are exact; without them, a transcript written in the last 90 s during an unfinished turn counts as running.
    const hk = liveState(hookStates.get(hookKey(s.profileDir, s.id)), s.mtime);
    if (hk?.state === "approval") {
      const key = `approval:${s.id}:${hk.at}`;
      p.input.push({ ...base, kind: "session", approval: true, key, ts: hk.at, questions: [hk.message], answer: "", dismissed: !!saved.dismissed[key] });
      continue;
    }
    if (hk ? hk.state === "working" : Date.now() - s.mtime < 90_000 && promptTs > (s.lastTurnEnd ?? 0)) {
      p.running.push({ ...base, kind: "running", text: s.lastPrompt?.text ?? "" });
      continue;
    }
    if (!s.lastAnswer) continue;
    const waiting = answerTs >= promptTs;
    const questions = waiting ? questionsIn(s.lastAnswer.text) : [];
    const key = `session:${s.id}:${s.lastAnswer.uuid ?? answerTs}`;
    if (waiting && questions.length > 0 && s.mtime >= inputSince) {
      const pend = index.get(`${s.profile}:${s.id}`)?.decisions?.at(-1); // a pending AskUserQuestion carries Claude's own options
      p.input.push({ ...base, kind: "session", key, questions, options: suggestOptions(s.lastAnswer.text, questions, pend && pend.answer == null ? pend.options : []), answer: clip(s.lastAnswer.text, 6000), dismissed: !!saved.dismissed[key] });
    } else if (s.mtime >= doneSince) {
      const firstLine = s.lastAnswer.text.split("\n").map((l) => l.replace(/[*_`#>]/g, "").trim()).find((l) => l.length > 20) || "";
      p.done.push({ ...base, kind: "session", key, summary: clip(firstLine, 280), answer: clip(s.lastAnswer.text, 6000), interrupted: !waiting });
    }
  }

  // Git and GitHub for every repository worked on recently, plus the configured extras.
  for (const extra of config.extraRepos) await projectFor(expand(extra));
  for (const spec of config.inputFiles) await projectFor(expand(spec.repo));
  const refreshGithub = forceGithub || Date.now() - githubCache.at > config.githubRefreshSeconds * 1000;
  const nextGithub = {};
  for (const p of projects.values()) {
    if (!p.root) continue;
    const g = await gitFacts(p.root);
    p.loose.push(...g.loose.map((l) => ({ ...l, dismissed: !!saved.dismissed[l.key] })));
    p.done.push(...g.commits.map((c) => ({ kind: "commit", key: `commit:${c.sha}`, title: c.subject, summary: `${c.sha} by ${c.author}`, ts: c.ts })));
    p.repo = await githubRepoOf(p.root);
    const owner = p.repo?.split("/")[0];
    if (!p.repo || !config.githubOwners.includes(owner)) continue;
    const gh = refreshGithub ? await githubFacts(p.repo) : githubCache.byRepo[p.repo] ?? (await githubFacts(p.repo));
    nextGithub[p.repo] = gh;
    if (gh.error) sources.push({ name: `GitHub ${p.repo}`, ok: false, detail: gh.error });
    for (const pr of gh.prsOpen) {
      const key = `pr:${p.repo}#${pr.number}:${pr.updatedAt}`;
      p.input.push({ kind: "pr", key, title: `PR #${pr.number}: ${pr.title}`, url: pr.url, ts: Date.parse(pr.updatedAt), questions: [pr.isDraft ? "Draft pull request" : "Open pull request: review or merge"], branch: pr.headRefName, dismissed: !!saved.dismissed[key] });
    }
    for (const issue of gh.issuesInput) {
      const key = `issue:${p.repo}#${issue.number}:${issue.updatedAt}`;
      p.input.push({ kind: "issue", key, title: `#${issue.number}: ${issue.title}`, url: issue.url, ts: Date.parse(issue.updatedAt), questions: [`Labelled ${issue.label}`], dismissed: !!saved.dismissed[key] });
    }
    for (const pr of gh.prsMerged) {
      p.done.push({ kind: "pr", key: `merged:${p.repo}#${pr.number}`, title: `PR #${pr.number}: ${pr.title}`, url: pr.url, summary: "Merged", ts: Date.parse(pr.mergedAt) });
    }
  }
  if (refreshGithub) githubCache = { at: Date.now(), byRepo: nextGithub };
  else githubCache.byRepo = { ...githubCache.byRepo, ...nextGithub };
  sources.push({ name: "GitHub", ok: true, detail: `${Object.keys(nextGithub).length} repositories, refreshed ${new Date(githubCache.at).toLocaleTimeString("nl-NL")}` });

  for (const spec of config.inputFiles) {
    const p = await projectFor(expand(spec.repo));
    const items = await inputFileItems(spec);
    // One card for the whole list: each item can still be marked handled inside it.
    if (items.length) p.input.push({ kind: "checklist", key: `file:${spec.path}`, title: `${path.basename(spec.path)}: ${items.length} open items`, source: spec.path, ts: null, items: items.map((i) => ({ ...i, dismissed: !!saved.dismissed[i.key] })), dismissed: items.every((i) => saved.dismissed[i.key]) });
    sources.push({ name: spec.path, ok: true, detail: `${items.length} open items` });
  }

  // Extra sources (Linear, Jira, review requests, your own script): each becomes its own group in the sidebar.
  const specs = Array.isArray(config.sources) ? config.sources : [];
  if (specs.length && (forceGithub || Date.now() - extCache.at > config.githubRefreshSeconds * 1000)) {
    const next = {};
    for (const spec of specs) { const name = spec.label || spec.type; const r = await fetchSource(spec); next[name] = r.error && extCache.byName[name] ? { ...extCache.byName[name], error: r.error } : r; }
    extCache = { at: Date.now(), byName: next };
  }
  for (const spec of specs) {
    const name = spec.label || spec.type; const r = extCache.byName[name]; if (!r) continue;
    const key = `source:${name}`;
    const p = { key, name, root: null, repo: null, input: [], done: [], loose: [], running: [] }; projects.set(key, p);
    for (const it of r.items) { const k = `ext:${name}:${it.id}`; p.input.push({ kind: "external", key: k, title: it.title, label: name, line: it.line, url: it.url, ts: it.ts, dismissed: !!saved.dismissed[k] }); }
    sources.push({ name, ok: !r.error, detail: r.error || `${r.items.length} items` });
  }

  const byTime = (a, b) => (b.ts ?? 0) - (a.ts ?? 0);
  const list = [...projects.values()]
    .filter((p) => !config.hideProjects.includes(p.name))
    .map((p) => ({ ...p, input: p.input.sort(byTime), done: p.done.sort(byTime).slice(0, 40), lastActivity: Math.max(0, ...[...p.input, ...p.done, ...p.running].map((x) => x.ts ?? 0)) }))
    .filter((p) => p.input.length || p.done.length || p.loose.length || p.running.length)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  snapshot = { generatedAt: Date.now(), buildMs: Date.now() - t0, projects: list, sources };
  return snapshot;
}

function rebuild(opts) {
  if (!building) building = build(opts).catch((err) => { console.error("build failed:", err); return snapshot; }).finally(() => { building = null; });
  return building;
}


// ---------------------------------------------------------------- Workflows and runs

const engine = new Engine({ dataDir: DATA_DIR, config, claudeBin: process.env.DASH_CLAUDE_BIN || config.claudeBin || "claude", tickMs: Number(process.env.DASH_TICK_MS) || 15_000 });
const connCache = new Map();
async function connectionsOf(wf) {
  const key = wf.id + "|" + (wf.requires || []).join(",") + "|" + wf.profile;
  const hit = connCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = await engine.checkConnections(wf);
  connCache.set(key, { at: Date.now(), v });
  return v;
}

// Other machines: refreshed in the background (a slow peer never slows the page); the page shows the last answer.
const peerSpecs = Array.isArray(config.peers) ? config.peers.filter((p) => p?.name) : [];
const peerState = { at: 0, busy: false, byName: {} };
function refreshPeers() {
  if (!peerSpecs.length || peerState.busy || Date.now() - peerState.at < 15_000) return;
  peerState.busy = true;
  Promise.all(peerSpecs.map(async (p) => [p.name, await fetchPeer(p)])).then((rs) => { peerState.byName = Object.fromEntries(rs); peerState.at = Date.now(); }).finally(() => { peerState.busy = false; });
}

const projectOf = (key) => ({ key, name: key ? path.basename(key) : "unknown" });

function runItem(r) {
  const base = { id: r.id, kind: "run", profile: r.profile, runId: r.id, workflowId: r.workflowId, projectKey: r.projectKey, title: r.workflowName, icon: r.icon, status: r.status, trigger: r.trigger, late: r.late, ts: r.endedAt || r.startedAt || r.createdAt };
  const open = { act: "open" };
  switch (r.status) {
    case "needs_review": return { ...base, label: "Review needed", line: r.decision?.text, primary: { ...open, label: "Review draft" } };
    case "needs_input": return { ...base, label: "Question", line: r.decision?.text, primary: { ...open, label: "Answer question" } };
    case "blocked": return { ...base, label: "Not connected", line: (r.blocker?.missing || []).map((m) => m.label).join(", ") + " is not set up", primary: { ...open, label: "See what's missing" } };
    case "queued": case "running": return { ...base, label: r.status === "queued" ? "Queued" : "Running", ts: r.startedAt || r.createdAt, line: r.activity?.last || "Starting…", primary: { ...open, label: "View progress" } };
    case "done": return { ...base, label: "Done", line: r.result?.finding, primary: r.result?.primary ? { act: "href", href: `/runs/${r.id}/report`, label: "Open report" } : { ...open, label: "View result" } };
    case "failed": return { ...base, label: "Failed", line: r.error, primary: { act: "rerun", label: "Run again" } };
    case "rejected": return { ...base, label: "Rejected", line: r.decision?.rejectedNote || "You rejected the draft", primary: { act: "rerun", label: "Run again" } };
    default: return { ...base, label: "Stopped", line: "Stopped before it finished", primary: { act: "rerun", label: "Run again" } };
  }
}

async function overview() {
  const now = Date.now();
  const runs = Object.values(engine.store.runs).filter((r) => !r.system);
  const workflows = [];
  const upcoming = [];
  for (const wf of Object.values(engine.store.workflows)) {
    if (wf.system) continue;
    const mine = runs.filter((r) => r.workflowId === wf.id).sort((a, b) => b.createdAt - a.createdAt);
    const last = mine[0];
    const sched = wf.schedule;
    workflows.push({
      id: wf.id, name: wf.name, icon: wf.icon, projectKey: wf.projectKey, folder: wf.folder, instructions: wf.instructions, inputs: wf.inputs, lastInputs: wf.lastInputs, allowedTools: wf.allowedTools, requires: wf.requires, outputDir: wf.outputDir, review: wf.review, schedule: sched, profile: wf.profile, model: wf.model,
      scheduleText: describeSchedule(sched), paused: !!(sched.enabled && sched.paused), next: sched.enabled && !sched.paused ? nextRun(sched, now) : null,
      missing: await connectionsOf(wf), last: last ? { id: last.id, status: last.status, ts: last.endedAt || last.createdAt, finding: last.result?.finding } : null, open: mine.find((r) => ACTIVE.has(r.status))?.id ?? null, runCount: mine.length,
    });
    if (sched.enabled && !sched.paused) for (const at of occurrences(sched, now, now + 7 * DAY)) upcoming.push({ workflowId: wf.id, name: wf.name, icon: wf.icon, projectKey: wf.projectKey, at });
  }
  upcoming.sort((a, b) => a.at - b.at);

  const needs = [], running = [], results = [], older = [];
  const needsSince = now - (config.needsDays ?? 2) * DAY; // an old unanswered session is not today's request
  const latestPerWf = new Map();
  for (const r of runs) if (!latestPerWf.has(r.workflowId) || latestPerWf.get(r.workflowId).createdAt < r.createdAt) latestPerWf.set(r.workflowId, r);
  const resultSince = now - 21 * DAY;
  for (const r of runs) {
    const item = runItem(r);
    if (["needs_review", "needs_input", "blocked"].includes(r.status)) needs.push({ ...item, rank: 0 });
    else if (ACTIVE.has(r.status)) running.push(item);
    else if (r.status === "failed" && latestPerWf.get(r.workflowId) === r && now - r.endedAt < 7 * DAY) needs.push({ ...item, rank: 2 });
    else if (item.ts > resultSince) results.push(item);
  }
  const projects = new Map();
  const ensure = (key, name) => { if (!projects.has(key)) projects.set(key, { key, name: name || projectOf(key).name, needs: 0, running: 0, workflows: 0, last: 0, git: null }); return projects.get(key); };
  for (const p of snapshot.projects) {
    const proj = ensure(p.key, p.name); proj.last = p.lastActivity;
    proj.git = { loose: p.loose.filter((l) => !l.dismissed).map((l) => l.text), recent: p.done.filter((d) => d.kind === "commit" || d.kind === "pr").slice(0, 8).map((d) => ({ title: d.title, ts: d.ts, url: d.url })) };
    for (const it of p.input) {
      if (it.dismissed) continue;
      const common = { profile: it.profile, projectKey: p.key, title: it.title, ts: it.ts, key: it.key, line: it.questions?.[0] ?? "", detail: it.questions, options: it.options, answer: it.answer, resume: it.resume, prompt: it.prompt };
      if (it.kind === "session" && it.ts < needsSince) older.push({ ...common, id: it.key, kind: "session", label: it.approval ? "Needs approval" : "Asked you", rank: it.approval ? 0 : 1, primary: { act: "terminal", label: "Open in terminal", sessionId: it.sessionId, value: it.resume }, sessionId: it.sessionId });
      else if (it.kind === "session") needs.push({ ...common, id: it.key, kind: "session", label: it.approval ? "Needs approval" : "Asked you", rank: it.approval ? 0 : 1, primary: { act: "terminal", label: "Open in terminal", sessionId: it.sessionId, value: it.resume }, sessionId: it.sessionId });
      else if (it.kind === "checklist") needs.push({ ...common, id: it.key, kind: "checklist", label: "Checklist", rank: 3, line: `${it.items.filter((i) => !i.dismissed).length} open items`, primary: { act: "dismiss", label: "Mark handled" }, items: it.items });
      else if (it.kind === "external") needs.push({ ...common, id: it.key, kind: "external", label: it.label, rank: 3, line: it.line || "", primary: it.url ? { act: "href", href: it.url, label: `Open in ${it.label}` } : { act: "dismiss", label: "Mark handled" } });
      else needs.push({ ...common, id: it.key, kind: it.kind, label: it.kind === "pr" ? "Pull request" : "Issue", rank: 3, primary: { act: "href", href: it.url, label: "Open on GitHub" } });
    }
    for (const it of p.running) running.push({ id: it.sessionId, kind: "session", profile: it.profile, projectKey: p.key, title: it.title, label: "Running", ts: it.ts, line: it.text, status: "running", primary: { act: "terminal", label: "Open in terminal", sessionId: it.sessionId, value: it.resume } });
    for (const it of p.done) if (it.kind === "session") results.push({ id: it.key, kind: "session", profile: it.profile, projectKey: p.key, title: it.title, label: it.interrupted ? "Interrupted" : "Session", status: "session", ts: it.ts, line: it.summary, detail: it.answer, resume: it.resume, prompt: it.prompt, sessionId: it.sessionId, branch: it.branch, primary: { act: "terminal", label: "Open in terminal", sessionId: it.sessionId, value: it.resume } });
  }
  for (const wf of workflows) ensure(wf.projectKey).workflows++;
  for (const r of runs) ensure(r.projectKey, null).last = Math.max(projects.get(r.projectKey)?.last ?? 0, r.createdAt);
  refreshPeers();
  const peerSources = [];
  for (const p of peerSpecs) {
    const r = peerState.byName[p.name]; if (!r) { peerSources.push({ name: `Machine ${p.name}`, ok: true, detail: "connecting…" }); continue; }
    peerSources.push({ name: `Machine ${p.name}`, ok: !r.error, detail: r.error || `${r.needs.length} need you, ${r.running.length} running` });
    ensure(`peer:${p.name}`, p.name);
    for (const i of r.needs) needs.push({ ...i, profile: p.name }); for (const i of r.running) running.push({ ...i, profile: p.name, label: "Running" });
  }
  for (const i of needs) ensure(i.projectKey).needs++;
  for (const i of running) ensure(i.projectKey).running++;
  const byTime = (a, b) => (b.ts ?? 0) - (a.ts ?? 0);
  needs.sort((a, b) => a.rank - b.rank || byTime(a, b));
  return {
    now, projects: [...projects.values()].filter((p) => !config.hideProjects.includes(p.name)).sort((a, b) => b.needs - a.needs || b.last - a.last),
    needs, older: older.sort(byTime), running: running.sort(byTime), results: results.sort(byTime).slice(0, 60), upcoming, workflows, scheduler: engine.health(), sources: [...snapshot.sources, ...peerSources],
    connections: Object.entries(config.connections || {}).map(([id, c]) => ({ id, label: c.label || id })),
    tools: config.toolPresets || [],
  };
}

// ---------------------------------------------------------------- Assistant (ask about sessions)

const ASSISTANT_DIR = path.join(DATA_DIR, "assistant");
const ASSISTANT_INSTRUCTIONS = `You are the assistant of the owner's Claude session dashboard. You only READ: never edit, move or delete anything except the files in the output folder.
Data: {{digest}} is a JSON file listing the owner's recent sessions and runs (key, title, project, profile, time, the last answer, the questions it asked, and the transcript path). Open it first.
Full transcripts are under {{profiles}}; search them (Grep) or open one (Read) only when the digest is not enough.
Scope: {{scope}}.
Question from the owner: {{question}}
Answer in report.md: start with a one-line answer, then short sections. Name each item with its project and title. Write plainly, no filler.
If the question is about cleanup, duplicates, stale or already-answered items, ALSO write actions.json in the output folder: a JSON array of {"key": "<key from the digest>", "reason": "<one short sentence>"} for items that are safe to mark as handled. Use only keys from the digest. Marking handled only hides an item; nothing is deleted.`;

async function ensureAssistant() {
  await mkdir(ASSISTANT_DIR, { recursive: true });
  const prof = config.defaultProfile || config.profiles[0]?.name;
  engine.store.workflows.wf_assistant = {
    id: "wf_assistant", system: true, name: "Ask the dashboard", icon: "search", projectKey: ASSISTANT_DIR, folder: ASSISTANT_DIR, instructions: ASSISTANT_INSTRUCTIONS,
    inputs: ["digest", "profiles", "scope", "question"].map((n) => ({ name: n, label: n, type: "text", default: "" })), allowedTools: [], requires: [], outputDir: "", review: { enabled: false },
    profile: prof, model: config.assistantModel || "sonnet", extraDirs: [ASSISTANT_DIR, ...config.profiles.map((p) => path.join(expandPath(p.dir), "projects"))],
    schedule: { enabled: false, paused: false, days: [], time: "08:00", missed: "latest", checkedAt: Date.now() }, createdAt: Date.now(), updatedAt: Date.now(), lastInputs: null,
  };
  await engine.save();
}

async function askAssistant(question, projectKey) {
  question = String(question || "").trim();
  if (!question || question.length > 2000) throw new HttpError(400, "Write a question (max 2000 characters)");
  if (!snapshot.generatedAt) await rebuild(); // right after a restart the first scan may still be running
  const o = await overview();
  const scoped = (i) => !projectKey || projectKey === "all" || i.projectKey === projectKey;
  const items = [...o.needs, ...o.older, ...o.running, ...o.results].filter(scoped).slice(0, 150).map((i) => ({
    key: i.key || i.id, kind: i.kind, project: proj0(o, i.projectKey), profile: i.profile, title: i.title, status: i.label, when: i.ts ? new Date(i.ts).toISOString() : null,
    asked: i.detail && Array.isArray(i.detail) ? i.detail : i.line ? [i.line] : [], lastAnswer: clip(String(i.answer || i.detail || i.line || ""), 1200), transcript: sessionIndex.get(i.sessionId)?.file ?? null, canMarkHandled: !!i.key && i.kind !== "run",
  }));
  const digest = path.join(ASSISTANT_DIR, "sessions.json");
  await writeFile(digest, JSON.stringify({ generatedAt: new Date().toISOString(), scope: projectKey || "all", items }, null, 1));
  const scope = !projectKey || projectKey === "all" ? "all projects" : `project ${proj0(o, projectKey)}`;
  const profiles = config.profiles.map((p) => path.join(expandPath(p.dir), "projects")).join(", ");
  return engine.startRun("wf_assistant", { inputs: { digest, profiles, scope, question }, trigger: "manual", requestId: null });
}
const proj0 = (o, key) => o.projects.find((p) => p.key === key)?.name || String(key || "").split("/").pop();

/** The answer of an assistant run, plus the cleanup it suggests (only items that still exist and can be marked handled). */
async function assistantAnswer(run) {
  const dir = path.resolve(run.outputDir);
  const report = await readFile(path.join(dir, "report.md"), "utf8").catch(() => run.result?.summary || "");
  let actions = [];
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "actions.json"), "utf8"));
    const o = await overview();
    const byKey = new Map([...o.needs, ...o.older].filter((i) => i.key && i.kind !== "run").map((i) => [i.key, i]));
    actions = (Array.isArray(raw) ? raw : []).filter((a) => byKey.has(a?.key)).slice(0, 100).map((a) => ({ key: a.key, reason: clip(String(a.reason || ""), 200), title: byKey.get(a.key).title, project: proj0(o, byKey.get(a.key).projectKey), profile: byKey.get(a.key).profile }));
  } catch { /* no suggestions */ }
  return { status: run.status, html: renderMarkdown(redactText(report), { highlight: false }), actions, error: run.error, activity: run.activity };
}
const redactText = (t) => redact(t, engine.secretValues);

// ---------------------------------------------------------------- Recap: transcript index, session detail, handoff, resume

const index = await new TranscriptIndex({ profiles: config.profiles, dataDir: DATA_DIR, days: config.indexDays ?? 60, expand: expandPath }).load();
const HANDOFF_DIR = path.join(DATA_DIR, "handoffs");
const projCache = new Map();
const projMap = new Map(); // session key -> project, filled after each index pass (git is asked once per folder)

/** Project = the main checkout; a worktree of it stays a distinct `worktree` on the same project. */
async function resolveProject(cwd) {
  if (!cwd) return { key: "unknown", name: "unknown", root: null, worktree: null };
  if (projCache.has(cwd)) return projCache.get(cwd);
  const root = await repoRootOf(cwd);
  let worktree = null;
  const at = cwd.indexOf("/.claude/worktrees/");
  if (at > 0) { const rest = cwd.slice(at + 19); worktree = cwd.slice(0, at + 19) + rest.split("/")[0]; }
  else if (root && existsSync(cwd)) { const top = (await sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"]))?.trim(); if (top && top !== root) worktree = top; }
  const p = { key: root || cwd, name: projectName(root, cwd), root, worktree };
  if (root || !existsSync(cwd)) projCache.set(cwd, p);
  return p;
}
async function annotate() { for (const s of index.sessions) if (!projMap.has(s.key) || !s.cwds.length) projMap.set(s.key, await resolveProject(V.launchCwd(s))); }
async function refreshIndex() { await index.refresh(); await annotate(); }

const isSystemSession = (s) => (V.launchCwd(s) || "").startsWith(DATA_DIR + path.sep) || V.launchCwd(s) === DATA_DIR; // the dashboard's own assistant
const runBySession = () => new Map(Object.values(engine.store.runs).filter((r) => r.sessionId && !r.system).map((r) => [`${r.profile}:${r.sessionId}`, r]));
const rowMemo = new Map();

async function ctxFor(s, live, runs) {
  const run = runs.get(s.key);
  return { project: projMap.get(s.key) ?? (await resolveProject(V.launchCwd(s))), live: live.get(s.key) || null, workflowId: run?.workflowId && engine.store.workflows[run.workflowId] ? run.workflowId : null, workflowName: run?.workflowName };
}

const runStateLabel = { needs_review: "Review needed", needs_input: "Waiting for your answer", blocked: "Not connected", queued: "Queued", running: "Running", done: "Done", failed: "Failed", rejected: "Rejected", stopped: "Stopped" };
function runInputsText(r) { return Object.entries(r.inputs || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? `${v.from} to ${v.to}` : v}`).join(" · "); }

async function runRows(now) {
  const rows = []; const out = {};
  for (const r of Object.values(engine.store.runs)) {
    if (r.system) continue;
    const ts = r.endedAt || r.startedAt || r.createdAt; if (now - ts > 8 * DAY) continue;
    const proj = await resolveProject(r.folder || r.projectKey);
    const open = ["needs_review", "needs_input", "blocked", "failed"].includes(r.status);
    const wfOk = !!engine.store.workflows[r.workflowId];
    const next = r.status === "needs_review" ? { kind: "run", label: "Review draft", detail: r.decision?.text || "" } : r.status === "needs_input" ? { kind: "run", label: "Answer question", detail: r.decision?.text || "" }
      : r.status === "blocked" ? { kind: "run", label: "See what is missing", detail: (r.blocker?.missing || []).map((m) => m.label).join(", ") } : ACTIVE.has(r.status) ? { kind: "run", label: "View progress", detail: r.activity?.last || "" }
      : wfOk ? { kind: "rerun", label: "Rerun", detail: "Same workflow, new inputs" } : { kind: "none", label: "Workflow was deleted", detail: "" };
    const row = { key: r.id, kind: "run", runId: r.id, workflowId: wfOk ? r.workflowId : null, id: r.id, profile: r.profile, title: r.workflowName, titleSource: "saved workflow", projectKey: proj.key, projectName: proj.name, worktree: null, branch: null,
      state: r.status, stateLabel: runStateLabel[r.status] || r.status, stateWhy: r.error || "", unfinished: open, ts, leftOff: { kind: "result", ts, text: clip(r.result?.finding || r.decision?.text || r.error || runInputsText(r) || "no result recorded", 240), ref: null },
      next, questions: [], models: r.model ? [{ id: r.model, n: 0 }] : [], modelChanged: false, agents: { calls: 0 }, workflows: [], mcp: [], skills: [], headless: true, job: null, unknown: r.model ? [] : ["model"], canResume: !!r.sessionId && r.segments?.length > 0,
      inputs: runInputsText(r), sessionKey: `${r.profile}:${r.sessionId}`, trigger: r.trigger };
    rows.push(row);
  }
  for (const r of rows) (out[r.projectKey] ||= []).push(r);
  return out;
}

async function upcomingByProject(now) {
  const out = {};
  for (const wf of Object.values(engine.store.workflows)) {
    if (wf.system || !wf.schedule?.enabled || wf.schedule.paused) continue;
    const proj = await resolveProject(wf.folder || wf.projectKey);
    for (const at of occurrences(wf.schedule, now, now + 7 * DAY).slice(0, 3)) (out[proj.key] ||= []).push({ workflowId: wf.id, name: wf.name, at, projectName: proj.name });
  }
  for (const k of Object.keys(out)) out[k] = out[k].sort((a, b) => a.at - b.at).slice(0, 4);
  return out;
}

async function recapOverview(query) {
  const now = Date.now(); const live = await index.live(); const runs = runBySession();
  const showSystem = query.get("system") === "1"; const rows = [];
  for (const s of index.sessions) {
    if (!showSystem && isSystemSession(s)) continue;
    if (runs.has(s.key)) continue; // a dashboard run is shown as the run, with the session one click away
    const lv = live.get(s.key); const sig = `${s.indexedAt}:${s.enrichedAt}:${lv?.status}:${projMap.get(s.key)?.key}:${engine.store.workflows[runs.get(s.key)?.workflowId] ? 1 : 0}`;
    let hit = rowMemo.get(s.key);
    if (!hit || hit.sig !== sig) { hit = { sig, row: V.rowOf(s, await ctxFor(s, live, runs)) }; rowMemo.set(s.key, hit); }
    rows.push(hit.row);
  }
  const ov = V.overview(rows, { now, upcomingByProject: await upcomingByProject(now), runsByProject: await runRows(now) });
  return { ...ov, index: { ...index.status, sessions: index.sessions.length, unreadable: index.errors.length, errors: index.errors.slice(0, 5), days: index.days }, profiles: config.profiles.map((p) => p.name), scheduler: engine.health() };
}

const secrets = () => engine.secretValues;
/** Everything the recap API sends is transcript text: strip credentials from every string, wherever it sits. */
const scrub = (v) => (typeof v === "string" ? redactText(v) : Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v);
const sessionOr404 = (key) => { const s = index.get(String(key || "")); if (!s) throw new HttpError(404, "Session not found. Press Refresh and try again."); return s; };

async function recapSession(key) {
  const s = sessionOr404(key); const live = await index.live(); const runs = runBySession(); const ctx = await ctxFor(s, live, runs);
  const d = V.detailOf(s, ctx); const run = runs.get(key);
  const cand = H.candidates(s, secrets());
  const worktree = d.worktree?.name || null;
  return { ...d, run: run ? { id: run.id, workflowId: run.workflowId, name: run.workflowName } : null, candidates: cand, resumeNote: d.resume.possible && !existsSync(d.resume.cwd) ? `The folder ${d.resume.cwd} no longer exists${worktree ? " (the worktree was removed)" : ""}, so this session cannot be resumed there. Start a fresh session from a handoff instead.` : null, leftOffText: undefined };
}

function recapSearch(query) {
  const q = query.get("q") || ""; const scope = query.get("project") || "all";
  const live = new Map(); const runs = runBySession();
  const sessions = index.sessions.filter((s) => !isSystemSession(s) && (scope === "all" || projMap.get(s.key)?.key === scope));
  const results = V.search(sessions, q, (s) => ({ project: projMap.get(s.key), live: live.get(s.key), workflowId: runs.get(s.key)?.workflowId ?? null, workflowName: runs.get(s.key)?.workflowName }));
  return { q, scope, results: results.map((r) => ({ ...r, hits: r.hits.map((h) => ({ ...h, text: redactText(h.text) })) })), searched: sessions.length };
}

async function buildHandoff(body, { start = false } = {}) {
  const s = sessionOr404(body.key); const project = projMap.get(s.key); const wt = V.worktreeOf(s, project);
  // The preview mints the id and start reuses it, so what you previewed is byte for byte what Claude receives.
  const id = /^h_[0-9a-f]{8}$/.test(body.handoffId || "") && !existsSync(path.join(HANDOFF_DIR, `${body.handoffId}.md`)) ? body.handoffId : `h_${crypto.randomBytes(4).toString("hex")}`;
  const b = H.build(body, s, project, secrets(), { id, worktree: wt?.name });
  return { s, project, id, ...b };
}

// A terminal runs the command: the browser never sends a path or a command, only ids that are looked up here.
const TERMINALS = [
  ["cosmic-term", (d) => ["-w", d, "-e"]], ["gnome-terminal", (d) => [`--working-directory=${d}`, "--"]], ["konsole", (d) => ["--workdir", d, "-e"]],
  ["xfce4-terminal", (d) => [`--working-directory=${d}`, "-x"]], ["kitty", (d) => ["-d", d]], ["alacritty", (d) => ["--working-directory", d, "-e"]], ["xterm", () => ["-e"]],
];
const onPath = (bin) => (process.env.PATH || "").split(":").some((d) => existsSync(path.join(d, bin)));
function launchTerminal(cwd, script, args, title) {
  const custom = config.terminal; // optional: ["my-term", "-e"]; the command is appended
  const t = custom ? [custom[0], () => custom.slice(1)] : TERMINALS.find(([b]) => onPath(b));
  if (!t) throw new HttpError(500, 'No terminal found. Set "terminal" in config.json, for example ["xterm", "-e"].');
  const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}` };
  const child = spawn(t[0], [...t[1](cwd), "sh", "-c", script, "sh", cwd, ...args], { cwd, env, detached: true, stdio: "ignore" });
  child.on("error", () => {}); child.unref();
  return t[0];
}
const RESUME_SCRIPT = 'printf "\\033]0;claude (%s)\\007" "$4"; printf "Claude profile: %s (%s)\\n" "$4" "$2"; cd "$1" && CLAUDE_CONFIG_DIR="$2" claude --resume "$3"; exec "${SHELL:-sh}"';
const FRESH_SCRIPT = 'printf "\\033]0;claude handoff (%s)\\007" "$4"; printf "Claude profile: %s (%s). Starting a fresh session from handoff %s\\n" "$4" "$2" "$5"; cd "$1" && CLAUDE_CONFIG_DIR="$2" claude "$(cat "$3")"; exec "${SHELL:-sh}"';

/** Resume = reopen the ORIGINAL conversation in the folder it was started in, with the profile that owns it. */
function resumeSession(key) {
  const s = sessionOr404(key); const cwd = V.resumeCwd(s);
  if (!cwd) throw new HttpError(409, "Cannot resume: the folder this session started in is not recorded. Start a fresh session from a handoff instead.");
  if (!existsSync(cwd)) throw new HttpError(409, `Cannot resume: ${cwd} no longer exists (a removed worktree?). Claude only finds a session from the folder it started in. Start a fresh session from a handoff instead.`);
  if (!/^[\w-]{8,64}$/.test(s.id)) throw new HttpError(400, "bad session id");
  const terminal = launchTerminal(cwd, RESUME_SCRIPT, [expandPath(s.profileDir), s.id, s.profile], s.title);
  return { terminal, profile: s.profile, cwd, command: `cd ${cwd} && CLAUDE_CONFIG_DIR=${s.profileDir} claude --resume ${s.id}` };
}

async function startFromHandoff(body) {
  const b = await buildHandoff(body, { start: true });
  if (b.tooLong) throw new HttpError(400, `The handoff is ${b.chars} characters; the limit is ${H.MAX_CHARS}. Untick some findings or shorten it.`);
  const profile = config.profiles.find((p) => p.name === (body.profile || b.s.profile)); if (!profile) throw new HttpError(400, "Unknown profile");
  let cwd = V.resumeCwd(b.s) || b.project?.root; let note = null;
  if (!cwd || !existsSync(cwd)) { cwd = b.project?.root && existsSync(b.project.root) ? b.project.root : null; note = cwd ? "The original folder is gone; the fresh session starts in the project's main checkout." : null; }
  if (!cwd) throw new HttpError(409, "No existing folder to start in for this project.");
  await mkdir(HANDOFF_DIR, { recursive: true });
  const file = path.join(HANDOFF_DIR, `${b.id}.md`);
  await writeFile(file, b.text);
  const terminal = launchTerminal(cwd, FRESH_SCRIPT, [expandPath(profile.dir), file, profile.name, b.id], b.s.title);
  await writeFile(path.join(HANDOFF_DIR, `${b.id}.json`), JSON.stringify({ id: b.id, createdAt: Date.now(), source: { key: b.s.key, id: b.s.id, profile: b.s.profile, project: b.project?.name }, startedIn: { cwd, profile: profile.name }, chars: b.chars, findings: b.handoff.findings.length }, null, 1));
  return { id: b.id, terminal, profile: profile.name, cwd, note, chars: b.chars, file };
}

/** Everything about one saved workflow that a rerun needs: its inputs, and every earlier run with its own inputs and output. */
function recapWorkflow(id) {
  const wf = engine.store.workflows[id]; if (!wf || wf.system) throw new HttpError(404, "Workflow not found");
  const runs = engine.runsOf(id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12).map((r) => ({ id: r.id, status: r.status, label: runStateLabel[r.status] || r.status, ts: r.endedAt || r.createdAt, trigger: r.trigger, inputs: runInputsText(r), finding: r.result?.finding || r.error || "", report: r.result?.primary ? `/runs/${r.id}/report` : null, replaces: r.replaces, sessionKey: `${r.profile}:${r.sessionId}` }));
  return { workflow: { id: wf.id, name: wf.name, icon: wf.icon, folder: wf.folder, instructions: wf.instructions, inputs: wf.inputs, lastInputs: wf.lastInputs, requires: wf.requires, profile: wf.profile, model: wf.model, scheduleText: describeSchedule(wf.schedule), review: wf.review }, runs, active: engine.openRun(id)?.id ?? null };
}

// ---------------------------------------------------------------- HTTP

function openInTerminal(sessionId) {
  if (!/^[\w-]{8,64}$/.test(sessionId)) throw new HttpError(404, "Session not found. Press Refresh and try again.");
  const hit = index.sessions.find((x) => x.id === sessionId);
  if (hit) return resumeSession(hit.key);
  const s = sessionIndex.get(sessionId); if (!s) throw new HttpError(404, "Session not found. Press Refresh and try again.");
  const cwd = s.cwd && existsSync(s.cwd) ? s.cwd : HOME;
  const terminal = launchTerminal(cwd, RESUME_SCRIPT, [expandPath(s.profileDir), sessionId, s.profile], s.profile);
  return { terminal, profile: s.profile };
}

const replies = new Replies({ dir: path.join(DATA_DIR, "replies"), claudeBin: process.env.DASH_CLAUDE_BIN || config.claudeBin || "claude" });
async function replyToSession(body) {
  const id = String(body.sessionId || ""); if (!/^[\w-]{8,64}$/.test(id)) throw new HttpError(404, "Session not found. Press Refresh and try again.");
  const text = String(body.text ?? "").trim();
  if (!text) throw new HttpError(400, "Write a reply first."); if (text.length > 8000) throw new HttpError(400, "That reply is too long (8000 characters at most).");
  const hit = index.sessions.find((x) => x.id === id); const legacy = sessionIndex.get(id);
  const s = hit ? { profile: hit.profile, profileDir: hit.profileDir, cwd: V.resumeCwd(hit), key: hit.key } : legacy ? { profile: legacy.profile, profileDir: legacy.profileDir, cwd: legacy.cwd, key: `${legacy.profile}:${id}` } : null;
  if (!s) throw new HttpError(404, "Session not found. Press Refresh and try again.");
  if ((await index.live()).has(s.key)) throw new HttpError(409, "This session is still open in a terminal. Answer it there: two programs writing to one conversation would corrupt it.");
  if (!s.cwd || !existsSync(s.cwd)) throw new HttpError(409, "Cannot reply: the folder this session started in no longer exists. Start a fresh session from a handoff instead.");
  if (await replies.busy(id)) throw new HttpError(409, "A reply to this session is already running.");
  const allowed = new Set((config.toolPresets || []).flatMap((p) => p.tools));
  const tools = (Array.isArray(body.tools) ? body.tools : []).map(String).filter((t) => allowed.has(t) && !REPLY_BASE.includes(t));
  return replies.start({ sessionId: id, cwd: s.cwd, configDir: expandPath(s.profileDir), text, tools });
}
const replyView = (m) => ({ id: m.id, sessionId: m.sessionId, state: m.state, startedAt: m.startedAt, endedAt: m.endedAt, result: m.result ? redactText(m.result) : null, error: m.error ? redactText(m.error) : null });

const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" };
const FILE_TYPES = { ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json", ".csv": "text/csv; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(415, "json only");
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 65_536) throw new HttpError(413, "too large"); }
  try { return body ? JSON.parse(body) : {}; } catch { throw new HttpError(400, "bad json"); }
}

const MD_CSS = await readFile(path.join(HERE, "md.css"), "utf8");
const REPORT_TOKENS = ":root{--bg:#f7f6f2;--surface:#fff;--sunk:#efede6;--ink:#1c1b18;--muted:#6a675f;--line:#e3e0d6;--accent:#b4481a;--accent-ink:#fff;--accent-soft:#fbece3;--run:#2c5fa5;--ok:#2b7344;--warn:#8a5b00}@media (prefers-color-scheme:dark){:root{--bg:#151513;--surface:#1e1e1b;--sunk:#272622;--ink:#efeee9;--muted:#a09d94;--line:#34332e;--accent:#e8905f;--accent-ink:#1a0f08;--accent-soft:#33221a;--run:#8db1ea;--ok:#78c794;--warn:#e0b75a}}";
async function reportPage(run, file) {
  const dir = path.resolve(run.outputDir);
  const target = path.resolve(dir, file || run.result?.primary || "report.md");
  if (!target.startsWith(dir + path.sep)) throw new HttpError(404, "not found");
  const text = await readFile(target, "utf8").catch(() => { throw new HttpError(404, "File not found"); });
  const used = Object.entries(run.inputs || {}).map(([k, v]) => `${k}: ${typeof v === "object" ? `${v.from} to ${v.to}${v.previous ? ` (previous ${v.previous.from} to ${v.previous.to})` : ""}` : v}`).join(" · ");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(run.workflowName)}</title>
<style>${REPORT_TOKENS}${MD_CSS}:root{color-scheme:light dark}body{background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:2rem 1.25rem 4rem}.md{font-size:16px}header a{color:var(--accent)}header{font-size:13px;color:var(--muted);margin-bottom:1.5rem}h1,h2,h3{line-height:1.25}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:.3rem .6rem;text-align:left}pre{background:#8882;padding:.75rem;overflow:auto;border-radius:6px}code{background:#8882;padding:0 .25rem;border-radius:3px}</style>
<header><a href="/#run=${esc(run.id)}">← ${esc(run.workflowName)}</a> · ${new Date(run.endedAt || run.createdAt).toLocaleString("en-GB")}${used ? `<br>${esc(used)}` : ""}</header>
<main>${/\.md$/.test(target) ? renderMarkdown(text, { highlight: false }) : `<pre>${esc(text)}</pre>`}</main></html>`;
}

const HOST = process.env.DASH_HOST || config.host || "127.0.0.1";
const EXPOSED = !["127.0.0.1", "localhost", "::1"].includes(HOST);
const TOKEN = process.env.DASH_TOKEN || config.token || "";
const tokenOk = (t) => { const a = crypto.createHash("sha256").update(t).digest(), b = crypto.createHash("sha256").update(TOKEN).digest(); return crypto.timingSafeEqual(a, b); };
if (EXPOSED && TOKEN.length < 16) { console.error(`Refusing to listen on ${HOST}: this dashboard shows session text and can start Claude runs, so a network-visible instance needs an access token of at least 16 characters (DASH_TOKEN env var or "token" in config.json). Generate one with: openssl rand -hex 24`); process.exit(1); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra }); res.end(body); };
  const json = (body, code = 200) => send(code, "application/json", JSON.stringify(body));
  // Only this page may call the API: a page on another site cannot read the transcripts or start runs through the browser.
  const host = req.headers.host || "";
  if (!EXPOSED && !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(403, "text/plain", "forbidden");
  if (EXPOSED) { // reachable from the network: every request needs the access token (header, or the cookie set by visiting /?token=...)
    const cookie = /(?:^|;\s*)dash_token=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || (cookie && decodeURIComponent(cookie));
    if (!given || !tokenOk(given)) return send(401, "text/plain", "Access token required. Open /?token=<your token> once.");
    if (url.searchParams.get("token") && req.method === "GET" && url.pathname === "/") return send(302, "text/plain", "", { location: "/", "set-cookie": `dash_token=${encodeURIComponent(given)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
  }
  if (req.method === "POST" && req.headers.origin && req.headers.origin !== `http://${host}`) return send(403, "text/plain", "forbidden");
  try {
    const p = url.pathname;
    if (req.method === "GET") {
      if (p === "/") return send(200, "text/html; charset=utf-8", await readFile(path.join(HERE, "index.html")));
      if (["/app.css", "/app.js", "/recap.css", "/recap.js", "/usage.css", "/usage.js", "/mdview.mjs", "/md.css"].includes(p)) return send(200, TYPES[path.extname(p)], await readFile(path.join(HERE, p)));
      if (p === "/api/notify") return json(notifyView());
      if (p === "/usage") return send(200, "text/html; charset=utf-8", await readFile(path.join(HERE, "usage.html")));
      if (p === "/api/usage") {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30)); const only = url.searchParams.get("project");
        const sessions = index.sessions.filter((s) => !only || projMap.get(s.key)?.key === only);
        return json(scrub({ ...summarizeUsage(sessions, { days, projectOf: (s) => projMap.get(s.key) }), projects: [...new Map([...projMap.values()].filter(Boolean).map((p) => [p.key, p.name]))].map(([key, name]) => ({ key, name })) }));
      }
      const rm = /^\/api\/replies\/(rp_\w+)$/.exec(p); if (rm) { const r = await replies.status(rm[1]); if (!r) throw new HttpError(404, "Unknown reply"); return json(replyView(r)); }
      if (p === "/recap") return send(200, "text/html; charset=utf-8", await readFile(path.join(HERE, "recap.html")));
      if (p === "/api/recap") { if (url.searchParams.get("refresh") === "1") await refreshIndex(); return json(scrub(await recapOverview(url.searchParams))); }
      if (p === "/api/recap/session") return json(scrub(await recapSession(url.searchParams.get("key"))));
      if (p === "/api/recap/search") return json(scrub(recapSearch(url.searchParams)));
      if (p === "/api/recap/workflow") return json(recapWorkflow(url.searchParams.get("id")));
      if (p === "/api/recap/event") {
        const ev = await index.rawEvent(String(url.searchParams.get("key") || ""), { f: url.searchParams.get("f") || "main", off: url.searchParams.get("off") }, secrets());
        if (!ev) throw new HttpError(404, "That transcript line is not available any more");
        return json({ off: ev.off, text: ev.text });
      }
      if (p === "/api/overview") { if (url.searchParams.get("refresh") === "1") await rebuild({ forceGithub: true }); else if (!snapshot.generatedAt) await rebuild(); return json(await overview()); }
      if (p === "/api/state") { if (url.searchParams.get("refresh") === "1") await rebuild({ forceGithub: true }); else if (!snapshot.generatedAt) await rebuild(); return json(snapshot); }
      let m;
      if ((m = /^\/api\/runs\/([\w]+)$/.exec(p))) { const r = engine.getRun(m[1]); return json({ run: engine.publicRun(r, { full: true }), log: await engine.logLines(r), workflow: engine.store.workflows[r.workflowId] ? { id: r.workflowId } : null }); }
      if ((m = /^\/api\/runs\/([\w]+)\/answer$/.exec(p))) return json(await assistantAnswer(engine.getRun(m[1])));
      if ((m = /^\/api\/runs\/([\w]+)\/log$/.exec(p))) { const r = engine.getRun(m[1]); return json({ status: r.status, activity: r.activity, lines: await engine.logLines(r, Number(url.searchParams.get("after")) || 0) }); }
      if ((m = /^\/api\/workflows\/([\w]+)\/runs$/.exec(p))) return json(engine.runsOf(m[1]).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((r) => runItem(r)));
      if ((m = /^\/runs\/([\w]+)\/report$/.exec(p))) return send(200, "text/html; charset=utf-8", await reportPage(engine.getRun(m[1]), url.searchParams.get("file")), { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'" });
      if ((m = /^\/runs\/([\w]+)\/files\/(.+)$/.exec(p))) {
        const r = engine.getRun(m[1]); const dir = path.resolve(r.outputDir); const target = path.resolve(dir, decodeURIComponent(m[2]));
        if (!target.startsWith(dir + path.sep)) throw new HttpError(404, "not found");
        const type = FILE_TYPES[path.extname(target)] || "application/octet-stream";
        return send(200, type, await readFile(target).catch(() => { throw new HttpError(404, "not found"); }), { "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self'" });
      }
      return send(404, "text/plain", "not found");
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      let m;
      if (p === "/api/notify/phone") {
        if (NOTIFY_OFF) throw new HttpError(409, 'Notifications are turned off in config.json ("notify": false).');
        const action = String(body.action || "");
        if (action === "enable") { saved.notify = { ...(saved.notify || {}), ntfyTopic: saved.notify?.ntfyTopic || "forge-" + crypto.randomBytes(15).toString("base64url") }; await persist(); }
        else if (action === "disable") { if (saved.notify) delete saved.notify.ntfyTopic; await persist(); }
        else if (action === "test") { await deliverNow({ title: "Test · Claude Forge", body: "If you can read this, notifications work.", generic: { title: "Test notification", body: "Notifications work." } }); }
        else throw new HttpError(400, "Unknown action");
        return json(notifyView());
      }
      if (p === "/api/dismiss") {
        const { key, undo } = body;
        if (typeof key !== "string" || key.length > 500) return send(400, "text/plain", "bad key");
        if (undo) delete saved.dismissed[key]; else saved.dismissed[key] = Date.now();
        await persist(); await rebuild(); return json({ ok: true });
      }
      if (p === "/api/handoff/candidates") return json(H.candidates(sessionOr404(body.key), secrets()));
      if (p === "/api/handoff/preview") { const b = await buildHandoff(body); return json({ id: b.id, text: b.text, chars: b.chars, limit: H.MAX_CHARS, tooLong: b.tooLong, source: b.source, handoff: b.handoff }); }
      if (p === "/api/handoff/start") return json(await startFromHandoff(body), 201);
      if (p === "/api/sessions/resume") return json({ ok: true, ...resumeSession(String(body.key || "")) });
      if (p === "/api/ask") return json({ run: engine.publicRun(await askAssistant(body.question, body.projectKey)) }, 201);
      if (p === "/api/sessions/reply") return json(replyView(await replyToSession(body)), 202);
      if (p === "/api/sessions/open") return json({ ok: true, ...openInTerminal(String(body.sessionId || "")) });
      if (p === "/api/workflows") return json({ workflow: await engine.saveWorkflow(body) });
      if ((m = /^\/api\/workflows\/(\w+)\/(run|delete|pause|resume)$/.exec(p))) {
        if (m[2] === "run") return json({ run: engine.publicRun(await engine.startRun(m[1], { inputs: body.inputs, requestId: body.requestId, trigger: body.rerun ? "rerun" : "manual" })) }, 201);
        if (m[2] === "delete") { await engine.deleteWorkflow(m[1]); return json({ ok: true }); }
        return json({ workflow: await engine.setPaused(m[1], m[2] === "pause") });
      }
      if ((m = /^\/api\/runs\/(\w+)\/(stop|restart|resume|answer|approve|reject)$/.exec(p))) {
        const id = m[1]; const act = m[2];
        const run = act === "stop" ? await engine.stopRun(id) : act === "restart" ? await engine.restartRun(id) : act === "resume" ? await engine.resumeRun(id) : act === "answer" ? await engine.answerRun(id, body.text) : act === "approve" ? await engine.approveRun(id, body.note) : await engine.rejectRun(id, body.note);
        return json({ run: engine.publicRun(run) });
      }
      return send(404, "text/plain", "not found");
    }
    send(405, "text/plain", "method not allowed");
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, runId: err.runId }, err.status);
    console.error(err);
    send(500, "text/plain", "error");
  }
});

await engine.init();
await ensureAssistant();
refreshIndex().catch((e) => console.error("index:", e)); // in the background: pages show what is indexed so far
setInterval(() => refreshIndex().catch((e) => console.error("index:", e)), config.refreshSeconds * 1000);
server.listen(config.port, HOST, () => console.log(`claude-forge on http://${HOST}:${config.port}${EXPOSED ? " (network-visible, token required)" : ""}`));
await rebuild({ forceGithub: true });
setInterval(() => rebuild(), config.refreshSeconds * 1000);
// Notifications: watch the same "needs you" list the page shows. Off with "notify": false; the first pass only learns what is already there.
const NOTIFY_OFF = config.notify === false;
const notifyCfg = () => { // config.json plus the phone-push topic you set up in the page (kept in state.json, never in git)
  const base = typeof config.notify === "object" ? config.notify : {};
  const topic = saved.notify?.ntfyTopic;
  return { ...base, ...(topic ? { ntfy: { server: base.ntfy?.server || saved.notify?.server, topic } } : {}) };
};
const deliverNow = (m) => makeDeliver(notifyCfg(), { publicUrl: config.publicUrl || "" })(m);
if (!NOTIFY_OFF) {
  const notifier = new Notifier({ events: notifyCfg().events || DEFAULT_EVENTS, deliver: deliverNow, projectName: (i) => projectOf(i.projectKey)?.name || "" });
  setInterval(async () => { try { await notifier.observe((await overview()).needs); } catch { /* next tick */ } }, 5000);
}
const notifyView = () => { const c = notifyCfg(); return { disabled: NOTIFY_OFF, desktop: !NOTIFY_OFF && c.desktop !== false, platform: process.platform, events: c.events || DEFAULT_EVENTS, phone: c.ntfy?.topic ? { on: true, topic: c.ntfy.topic, server: (c.ntfy.server || "https://ntfy.sh").replace(/\/$/, ""), fromConfig: !saved.notify?.ntfyTopic } : { on: false }, includeText: !!c.includeText }; };
// Hook events arrive instantly; refresh within a few seconds instead of waiting for the minute tick.
let lastQuick = 0;
setInterval(async () => { try { const at = eventLog.pos; const st = await stat(EVENTS_FILE).catch(() => null); if (st && st.size !== at && Date.now() - lastQuick > 4000) { lastQuick = Date.now(); await rebuild(); } } catch { /* next tick */ } }, 2000);
