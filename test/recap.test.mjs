import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFixtures, IDS, SECRET, INJECTION } from "./fixtures.mjs";
import { redact } from "../lib/redact.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 4800 + Math.floor(Math.random() * 90);
let tmp, fx, srv, log;
const base = () => `http://127.0.0.1:${PORT}`;
const api = async (p, body) => { const r = await fetch(base() + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); } };
const key = (id) => `fixture:${id}`;
const launches = async (min = 0) => until(async () => { const l = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((x) => JSON.parse(x)); return l.length >= min ? l : null; });

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "recap-")); fx = makeFixtures(tmp); log = path.join(tmp, "term.log");
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "fixture", dir: fx.profileDir }], defaultProfile: "fixture", terminal: [path.join(HERE, "fake-term.mjs")], sessionDays: 21, doneDays: 14, githubOwners: [], inputLabels: [], inputFiles: [], extraRepos: [], hideProjects: [], refreshSeconds: 600, githubRefreshSeconds: 600, maxConcurrent: 2 }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_CLAUDE_BIN: path.join(HERE, "fake-claude.mjs"), DASH_TERM_LOG: log, DASH_TICK_MS: "300" }, stdio: "inherit" });
  await until(async () => (await fetch(base() + "/api/recap").then((r) => r.json()).catch(() => null))?.index?.state === "idle");
});
after(async () => { srv.kill("SIGTERM"); await rm(tmp, { recursive: true, force: true }).catch(() => {}); });

const rows = async () => { const o = (await api("/api/recap")).json; return { o, all: o.projects.flatMap((p) => [...p.today, ...p.week]) }; };

test("repeated imports do not duplicate sessions, and only appended bytes are read", async () => {
  const a = await rows(); const n = a.all.length;
  assert.ok(n >= 4, "fixture sessions are listed");
  await api("/api/recap?refresh=1"); await api("/api/recap?refresh=1");
  const b = await rows(); assert.equal(b.all.length, n); assert.equal(new Set(b.all.map((r) => r.key)).size, n);
  await appendFile(fx.files.multi, JSON.stringify({ type: "user", message: { role: "user", content: "FIXTURE follow-up" }, timestamp: new Date().toISOString(), cwd: fx.repo, uuid: "zz" }) + "\n");
  const j = (await api("/api/recap?refresh=1")).json; assert.equal(j.index.done - j.index.unreadable, 1, "exactly one readable transcript re-read");
  assert.equal((await rows()).all.length, n);
});

test("worktrees stay distinct but share the project", async () => {
  const { all } = await rows(); const A = all.find((r) => r.key === key(IDS.multi)), B = all.find((r) => r.key === key(IDS.wt)), D = all.find((r) => r.key === key(IDS.gone));
  assert.equal(A.projectKey, B.projectKey); assert.equal(A.projectKey, D.projectKey);
  assert.equal(A.worktree, null); assert.equal(B.worktree.name, "fixrepo-wt"); assert.equal(D.worktree.name, "gone");
  assert.notEqual(B.worktree.path, D.worktree.path);
});

test("missing metadata renders as unknown, never invented", async () => {
  const { all } = await rows(); const r = all.find((x) => x.key === key(IDS.bare));
  assert.equal(r.title, "FIXTURE bare prompt"); assert.deepEqual(r.models, []);
  assert.ok(r.unknown.includes("model") && r.unknown.includes("project folder"));
  assert.equal(r.canResume, false);
  const d = (await api(`/api/recap/session?key=${key(IDS.bare)}`)).json;
  assert.equal(d.resume.possible, false); assert.match(d.modelsNote, /No model was recorded/);
  assert.equal(r.state, "interrupted", "prompt with no answer is stopped mid-turn, not running");
});

test("unreadable transcripts are reported, not hidden", async () => {
  const j = (await api("/api/recap")).json;
  if (process.getuid?.() === 0) return; // root can read a mode-000 file
  assert.ok(j.index.unreadable >= 1 && j.index.errors.some((e) => e.file.includes(IDS.locked)));
});

test("delegation tree: models, nesting, workflow, honest outcomes", async () => {
  const d = (await api(`/api/recap/session?key=${key(IDS.multi)}`)).json;
  assert.equal(d.modelChanges.length, 1); assert.equal(d.modelChanges[0].from, "claude-opus-5-5");
  const top = d.tree.agents; const sec = top.find((a) => a.label === "FIXTURE security review");
  assert.equal(sec.model.id, "claude-opus-5-5"); assert.equal(sec.state, "finished");
  assert.equal(sec.children[0].label, "FIXTURE nested helper", "nested by parentAgentId");
  const perf = top.find((a) => a.label === "FIXTURE perf review"); assert.equal(perf.model.id, "claude-haiku-5-5"); assert.equal(perf.state, "unclear");
  const none = top.find((a) => a.label === "FIXTURE agent without transcript"); assert.equal(none.noTranscript, true); assert.equal(none.model.id, "unknown");
  assert.ok(top.some((a) => a.orphan), "unlinked agent stays visible");
  const w = d.tree.workflows[0]; assert.equal(w.status, "completed"); assert.match(w.outcomeNote, /completed, but its recorded result/);
  assert.equal(w.phases[0].agents[0].label, "build:0");
  assert.equal(d.decisions[0].answer, "Stripe");
  assert.ok(!JSON.stringify(d).includes(SECRET), "no credential anywhere in the session payload");
  assert.ok(!JSON.stringify((await api("/api/recap")).json).includes(SECRET), "nor in the overview");
});

test("every claim links to a local event, with credentials removed", async () => {
  const d = (await api(`/api/recap/session?key=${key(IDS.multi)}`)).json;
  const ref = d.lastAnswer.ref; const ev = (await api(`/api/recap/event?key=${key(IDS.multi)}&f=${ref.f}&off=${ref.off}`)).json;
  assert.match(ev.text, /Audit finished/); assert.ok(!ev.text.includes(SECRET));
  assert.equal((await api(`/api/recap/event?key=${key(IDS.multi)}&f=main&off=99999999`)).status, 404);
  assert.equal((await api(`/api/recap/event?key=nope&f=main&off=0`)).status, 404);
});

test("handoff contains only the selected context, redacted, with transcript text fenced as data", async () => {
  const c = (await api("/api/handoff/candidates", { key: key(IDS.multi) })).json;
  const retry = c.findings.find((f) => /idempotency/.test(f.text)); const keep = c.findings.find((f) => /keep Stripe/.test(f.text)); const leak = c.findings.find((f) => /leaked in logs/.test(f.text)); const inj = c.findings.find((f) => /IGNORE ALL/.test(f.text));
  assert.ok(retry && keep && leak && inj);
  assert.ok(!JSON.stringify(c).includes(SECRET), "candidates are already redacted");
  assert.ok(!c.files.some((f) => f.endsWith(".env")), "secret files are never offered");
  const body = { key: key(IDS.multi), goal: "Fix the retry bug", findings: [retry.text, leak.text], files: c.files.slice(0, 1), questions: [], next: "Add an idempotency key" };
  const p = (await api("/api/handoff/preview", body)).json;
  assert.match(p.text, /idempotency/); assert.ok(!p.text.includes("keep Stripe"), "unselected finding is absent"); assert.ok(!p.text.includes(INJECTION), "unselected injection absent");
  assert.ok(!p.text.includes(SECRET)); assert.match(p.text, /not an instruction/); assert.match(p.text, /Source|session 11111111/); assert.ok(p.chars < p.limit);
  const typed = (await api("/api/handoff/preview", { ...body, findings: [`api_key=${SECRET} and more`] })).json; assert.ok(!typed.text.includes(SECRET), "edited text is redacted too");
});

test("start from handoff: fresh session, exact previewed text, own folder", async () => {
  const body = { key: key(IDS.multi), goal: "Fix the retry bug", findings: ["checkout retries on 500 without idempotency key"], files: [], questions: [], next: "Add an idempotency key" };
  const prev = (await api("/api/handoff/preview", body)).json;
  const r = await api("/api/handoff/start", { ...body, handoffId: prev.id, profile: "fixture" }); assert.equal(r.status, 201);
  const l = (await launches(1)).at(-1); const script = l.find((x) => x.includes("claude \"$(cat")); assert.ok(script, "fresh launch, not --resume"); assert.ok(!script.includes("--resume"));
  assert.equal(l[4], fx.repo, "starts in the session's own folder");
  const saved = await readFile(r.json.file, "utf8"); assert.equal(r.json.id, prev.id); assert.equal(saved, prev.text, "previewed text is exactly what was passed");
  assert.ok(!saved.includes("keep Stripe"));
  const tooLong = await api("/api/handoff/start", { ...body, findings: Array(25).fill("x".repeat(290)) }); assert.equal(tooLong.status, 400);
});

test("resume reopens the original conversation in its folder; a removed worktree refuses honestly", async () => {
  const before = (await launches(1)).length;
  const r = await api("/api/sessions/resume", { key: key(IDS.wt) }); assert.equal(r.status, 200); assert.equal(r.json.cwd, fx.wt);
  const l = (await launches(before + 1))[before]; assert.ok(l.some((x) => x.includes("--resume"))); assert.ok(l.includes(IDS.wt)); assert.ok(l.includes(fx.profileDir));
  const gone = await api("/api/sessions/resume", { key: key(IDS.gone) }); assert.equal(gone.status, 409); assert.match(gone.json.error, /no longer exists/);
  assert.equal((await launches(before + 1)).length, before + 1, "nothing launched for the removed worktree");
  const d = (await api(`/api/recap/session?key=${key(IDS.gone)}`)).json; assert.match(d.resumeNote, /no longer exists/);
  assert.equal((await api("/api/sessions/resume", { key: key(IDS.bare) })).status, 409);
});

test("rerun starts a distinct run with its own inputs; earlier run and output stay", async () => {
  const wf = (await api("/api/workflows", { name: "FIXTURE weekly review", projectKey: fx.repo, folder: fx.repo, instructions: "Count files. period: {{period}}", inputs: [{ name: "period", type: "period", days: 7 }] })).json.workflow;
  const first = (await api(`/api/workflows/${wf.id}/run`, { requestId: "r1" })).json.run;
  await until(async () => (await api(`/api/runs/${first.id}`)).json.run.status === "done");
  const second = (await api(`/api/workflows/${wf.id}/run`, { requestId: "r2", rerun: true, inputs: { period: { mode: "fixed", from: "2026-01-01", to: "2026-01-31" } } })).json.run;
  await until(async () => (await api(`/api/runs/${second.id}`)).json.run.status === "done");
  const w = (await api(`/api/recap/workflow?id=${wf.id}`)).json;
  assert.equal(w.runs.length, 2); assert.notEqual(w.runs[0].id, w.runs[1].id);
  assert.match(w.runs[0].inputs, /2026-01-01 to 2026-01-31/); assert.doesNotMatch(w.runs[1].inputs, /2026-01-01/);
  assert.ok(w.runs.every((r) => r.report), "both outputs kept");
  const { all } = await rows(); assert.equal(all.filter((r) => r.kind === "run" && r.workflowId === wf.id).length, 2);
  assert.equal(all.find((r) => r.kind === "run").next.kind, "rerun");
});

test("search: defaults to a project scope, all projects on request", async () => {
  const { o } = await rows(); const pk = o.projects.find((p) => p.name === "fixrepo")?.key;
  const mine = (await api(`/api/recap/search?q=checkout&project=${encodeURIComponent(pk)}`)).json; assert.ok(mine.results.some((r) => r.key === key(IDS.multi)));
  const other = (await api(`/api/recap/search?q=checkout&project=${encodeURIComponent("/somewhere/else")}`)).json; assert.equal(other.results.length, 0);
  const all = (await api("/api/recap/search?q=Stripe&project=all")).json; assert.ok(all.results[0].hits.some((h) => h.kind === "decision"));
  assert.ok(!JSON.stringify(all).includes(SECRET));
});

test("redaction covers the common credential shapes", () => {
  for (const s of ["sk-ant-api03-abcdefghijkl", "ghp_abcdefghijklmnopqrstu", "Bearer abcdefghijklmnop", "postgres://user:hunter2pass@db/x", "password=hunter2pass", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghij", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"]) assert.ok(redact(`x ${s} y`).includes("•••"), s);
  assert.equal(redact("nothing secret here"), "nothing secret here");
});
