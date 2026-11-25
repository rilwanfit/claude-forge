import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5400 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let tmp, srv, prof, cwd; const IDLE = "dddddddd-0000-4000-8000-000000000001", LIVE = "dddddddd-0000-4000-8000-000000000002", GONE = "dddddddd-0000-4000-8000-000000000003";

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "rp-")); prof = path.join(tmp, "profile"); cwd = path.join(tmp, "site"); await mkdir(cwd);
  const dir = (c) => path.join(prof, "projects", c.replace(/[^A-Za-z0-9]/g, "-")); const gone = path.join(tmp, "removed");
  for (const [id, c] of [[IDLE, cwd], [LIVE, cwd], [GONE, gone]]) {
    await mkdir(dir(c), { recursive: true });
    await writeFile(path.join(dir(c), id + ".jsonl"), JSON.stringify({ type: "user", uuid: "u" + id, message: { role: "user", content: "hi" }, timestamp: new Date(Date.now() - 60000).toISOString(), cwd: c }) + "\n");
  }
  // a live session: pid file whose process is this test process (alive) and whose start time matches
  await mkdir(path.join(prof, "sessions"), { recursive: true });
  const stat = (await import("node:fs")).readFileSync(`/proc/${process.pid}/stat`, "utf8"); const procStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  await writeFile(path.join(prof, "sessions", `${process.pid}.json`), JSON.stringify({ sessionId: LIVE, pid: process.pid, procStart, status: "waiting", startedAt: Date.now() }));
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false, toolPresets: [{ label: "Web", tools: ["WebSearch"] }] }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl"), DASH_CLAUDE_BIN: path.join(HERE, "fake-claude.mjs") }, stdio: "ignore" });
  await until(() => fetch(base + "/api/overview").then((r) => r.ok).catch(() => false));
  await until(async () => (await (await fetch(base + "/api/recap")).json()).index?.sessions >= 3);
});
after(() => srv.kill("SIGTERM"));

test("a reply continues the same session and the result is readable", async () => {
  const r = await post("/api/sessions/reply", { sessionId: IDLE, text: "Use Stripe", tools: ["WebSearch", "Bash(rm:*)"] });
  assert.equal(r.status, 202); assert.match(r.json.id, /^rp_/);
  const done = await until(async () => { const j = await (await fetch(`${base}/api/replies/${r.json.id}`)).json(); return j.state !== "running" ? j : null; });
  assert.equal(done.state, "done"); assert.match(done.result, new RegExp(`continued same session ${IDLE}`));
});

test("refused: empty text, an unknown session, a session still open in a terminal, a removed folder", async () => {
  assert.equal((await post("/api/sessions/reply", { sessionId: IDLE, text: "  " })).status, 400);
  assert.equal((await post("/api/sessions/reply", { sessionId: "nope-nope-nope", text: "x" })).status, 404);
  const live = await post("/api/sessions/reply", { sessionId: LIVE, text: "x" });
  assert.equal(live.status, 409); assert.match(live.json.error, /still open in a terminal/);
  const gone = await post("/api/sessions/reply", { sessionId: GONE, text: "x" });
  assert.equal(gone.status, 409); assert.match(gone.json.error, /no longer exists/);
});
