import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 4900 + Math.floor(Math.random() * 90);
let tmp, proj, srv;
const base = () => `http://127.0.0.1:${PORT}`;
const api = async (p, body) => { const r = await fetch(base() + p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); } };
const runOf = async (id) => (await api(`/api/runs/${id}`)).json;
const waitStatus = (id, s) => until(async () => { const r = (await runOf(id)).run; return [].concat(s).includes(r.status) ? r : null; });

async function start() {
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, DASH_UPDATE_CHECK: "0", PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_CLAUDE_BIN: path.join(HERE, "fake-claude.mjs"), DASH_TICK_MS: "300" }, stdio: "inherit" });
  await until(async () => fetch(base() + "/api/overview").then((r) => r.ok).catch(() => false), 15000);
}
const stopServer = () => new Promise((r) => { srv.once("exit", r); srv.kill("SIGTERM"); });

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "dash-"));
  proj = path.join(tmp, "acme-site"); await mkdir(proj);
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [], sessionDays: 21, doneDays: 14, githubOwners: [], inputLabels: [], inputFiles: [], extraRepos: [], hideProjects: [], refreshSeconds: 600, githubRefreshSeconds: 600, maxConcurrent: 3, connections: { mixpanel: { label: "Mixpanel", mcp: "mixpanel", fix: "claude mcp add mixpanel" } } }));
  await start();
});
after(async () => { await stopServer(); });

const wfBody = (o = {}) => ({ name: "Weekly search performance", icon: "chart", projectKey: proj, folder: proj, instructions: "Count files. period: {{period}}", inputs: [{ name: "period", type: "period", days: 7 }], ...o });

test("project -> save workflow -> run -> open result -> rerun with changed inputs -> schedule -> next run on overview", async () => {
  const saved = (await api("/api/workflows", wfBody())).json.workflow;
  const { json: { run } } = await api(`/api/workflows/${saved.id}/run`, { requestId: "a1" });
  assert.equal(run.status === "queued" || run.status === "running", true);
  const done = await waitStatus(run.id, "done");
  assert.match(done.result.finding, /42 PHP files in \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d/);
  assert.equal(done.inputs.period.days, 7);
  assert.ok(done.inputs.period.previous.from && done.inputs.period.resolvedAt);
  const page = await (await fetch(`${base()}/runs/${run.id}/report`)).text();
  assert.match(page, /Period \d{4}-\d\d-\d\d to/);
  assert.equal((await fetch(`${base()}/runs/${run.id}/files/..%2F..%2Fstore.json`)).status, 404);

  // a richer report renders as real Markdown (tables, task lists), stays safe, is styled inline (the page's CSP allows nothing else) and is not "highlighted" like a question
  const outDir = path.join(tmp, "data/runs", run.id, "output");
  await writeFile(path.join(outDir, "rich.md"), "# Q4\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n<script>bad()</script>\n\nShould we ship this?\n");
  const rich = await (await fetch(`${base()}/runs/${run.id}/report?file=rich.md`)).text();
  assert.match(rich, /<div class="md">/); assert.match(rich, /<td>2<\/td>/); assert.match(rich, /class="task done"/);
  assert.ok(!rich.includes("<script>bad()"), "html in a report never runs"); assert.match(rich, /&lt;script&gt;bad\(\)/);
  assert.ok(!/<aside class="md-ask">/.test(rich), "a report is a deliverable, not a question");
  assert.match(rich, /<style>[^]*\.md-options/);

  // rerun with a changed input: a fresh run, the old result stays
  const second = (await api(`/api/workflows/${saved.id}/run`, { inputs: { period: { mode: "relative", days: 14 } }, requestId: "a2", rerun: true })).json.run;
  const d2 = await waitStatus(second.id, "done");
  assert.equal(d2.inputs.period.days, 14);
  assert.notEqual(d2.id, done.id);
  assert.equal((await runOf(done.id)).run.inputs.period.days, 7);

  // schedule it: it shows up in "up next" for the next 7 days
  const wf = (await api("/api/overview")).json.workflows.find((w) => w.id === saved.id);
  await api("/api/workflows", { ...wf, schedule: { enabled: true, days: [], time: "08:00", missed: "latest" } });
  const ov = (await api("/api/overview")).json;
  assert.ok(ov.upcoming.length >= 6 && ov.upcoming[0].workflowId === saved.id);
  assert.equal(ov.scheduler.next.workflowId, saved.id);
  assert.ok(ov.results.some((r) => r.runId === done.id), "recent results list the finished run");
});

test("double click starts one run; same request id returns the same run", async () => {
  const wf = (await api("/api/workflows", wfBody({ name: "Dup", instructions: "SLEEP {{period}}" }))).json.workflow;
  const [a, b] = await Promise.all([api(`/api/workflows/${wf.id}/run`, { requestId: "x" }), api(`/api/workflows/${wf.id}/run`, { requestId: "x" })]);
  assert.equal(a.json.run.id, b.json.run.id);
  const c = await api(`/api/workflows/${wf.id}/run`, { requestId: "y" });
  assert.equal(c.status, 409);
  await api(`/api/runs/${a.json.run.id}/stop`, {});
});

test("restart stops the old attempt, confirms it, links a replacement, and is idempotent", async () => {
  const wf = (await api("/api/workflows", wfBody({ name: "Slow", instructions: "SLEEP {{period}}" }))).json.workflow;
  const r1 = (await api(`/api/workflows/${wf.id}/run`, {})).json.run;
  await waitStatus(r1.id, "running");
  const [x, y] = await Promise.all([api(`/api/runs/${r1.id}/restart`, {}), api(`/api/runs/${r1.id}/restart`, {})]);
  const ids = new Set([x, y].filter((r) => r.status === 200).map((r) => r.json.run.id));
  assert.equal(ids.size, 1, "one replacement only");
  const old = (await runOf(r1.id)).run;
  assert.equal(old.status, "stopped");
  assert.equal(old.replacedBy, [...ids][0]);
  const next = (await runOf([...ids][0])).run;
  assert.equal(next.replaces, r1.id);
  assert.deepEqual(next.inputs.period, old.inputs.period, "restart keeps the dates of the first attempt");
  await api(`/api/runs/${next.id}/stop`, {});
});

test("a question waits for you, the answer continues the same session", async () => {
  const wf = (await api("/api/workflows", wfBody({ name: "Competitor research", instructions: "ASK which folder. {{period}}" }))).json.workflow;
  const r = (await api(`/api/workflows/${wf.id}/run`, {})).json.run;
  const waiting = await waitStatus(r.id, "needs_input");
  assert.equal(waiting.decision.text, "Which folder should I scan?");
  assert.ok((await api("/api/overview")).json.needs.some((n) => n.runId === r.id && n.primary.label === "Answer question"));
  await api(`/api/runs/${r.id}/answer`, { text: "src" });
  const done = await waitStatus(r.id, "done");
  assert.match(done.result.finding, new RegExp(`continued same session ${done.sessionId}`));
  assert.equal(done.segments.length, 2);
});

test("review step: nothing runs until you approve; reject ends it", async () => {
  const body = wfBody({ name: "Social drafts", instructions: "Draft posts {{period}}", review: { enabled: true, question: "Publish 3 posts to Telegram?", action: "Post them" } });
  const wf = (await api("/api/workflows", body)).json.workflow;
  const r = (await api(`/api/workflows/${wf.id}/run`, {})).json.run;
  const w = await waitStatus(r.id, "needs_review");
  assert.equal(w.decision.text, "Publish 3 posts to Telegram?");
  assert.equal((await api(`/api/runs/${r.id}/resume`, {})).status, 409);
  await api(`/api/runs/${r.id}/approve`, {});
  const done = await waitStatus(r.id, "done");
  assert.equal(done.segments[1].kind, "publish");
  const r2 = (await api(`/api/workflows/${wf.id}/run`, {})).json.run;
  await waitStatus(r2.id, "needs_review");
  await api(`/api/runs/${r2.id}/reject`, { note: "tone is off" });
  assert.equal((await runOf(r2.id)).run.status, "rejected");
});

test("a missing connection is named, and nothing starts", async () => {
  const wf = (await api("/api/workflows", wfBody({ name: "Weekly Mixpanel report", requires: ["mixpanel"] }))).json.workflow;
  const r = (await api(`/api/workflows/${wf.id}/run`, {})).json.run;
  assert.equal(r.status, "blocked");
  assert.match(r.blocker.missing[0].detail, /MCP server "mixpanel" is not configured/);
  assert.equal(r.segments.length, 0);
});

test("validation: unknown placeholder and missing folder are refused", async () => {
  assert.equal((await api("/api/workflows", wfBody({ instructions: "x {{nope}}" }))).status, 400);
  assert.equal((await api("/api/workflows", wfBody({ folder: "/does/not/exist" }))).status, 400);
});

test("schedule survives a restart; a long gap gives one catch-up run and lists the rest as missed", async () => {
  const wf = (await api("/api/workflows", wfBody({ name: "Daily scan", schedule: { enabled: true, days: [], time: "08:00", missed: "latest" } }))).json.workflow;
  await stopServer();
  const f = path.join(tmp, "data/store.json");
  const store = JSON.parse(await readFile(f, "utf8"));
  const DAY = 86_400_000;
  store.workflows[wf.id].schedule.checkedAt = Date.now() - 5 * DAY; // the machine "slept" for five days
  store.scheduler.lastTick = Date.now() - 5 * DAY;
  await writeFile(f, JSON.stringify(store));
  await start();
  const ov = (await api("/api/overview")).json;
  assert.ok(ov.workflows.find((w) => w.id === wf.id), "workflow persisted");
  const runs = await until(async () => { const r = Object.values(JSON.parse(await readFile(f, "utf8")).runs).filter((x) => x.workflowId === wf.id && x.trigger === "schedule"); return r.length ? r : null; });
  assert.equal(runs.length, 1, "one catch-up run, not a burst");
  assert.equal(runs[0].late, true);
  assert.ok(ov.scheduler.offlineGapMs > 4 * DAY);
  assert.ok(ov.scheduler.missed.filter((m) => m.workflowId === wf.id).length >= 3);
});
