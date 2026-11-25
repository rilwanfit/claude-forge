import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5100 + Math.floor(Math.random() * 90);
const api = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const until = async (fn, ms = 12000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
let tmp, srv, prof, events;
const S = { approve: "aaaaaaaa-0000-4000-8000-000000000001", work: "aaaaaaaa-0000-4000-8000-000000000002", idle: "aaaaaaaa-0000-4000-8000-000000000003" };
const ev = (id, e, o = {}) => JSON.stringify({ t: Date.now(), dir: prof, id, ev: e, cwd: path.join(tmp, "site"), ...o }) + "\n";

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "hk-")); prof = path.join(tmp, "profile"); events = path.join(tmp, "events.jsonl");
  const cwd = path.join(tmp, "site"); const dir = path.join(prof, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); await mkdir(dir, { recursive: true });
  const iso = new Date(Date.now() - 5000).toISOString();
  for (const [name, id] of Object.entries(S)) {
    const lines = [{ type: "user", uuid: `u-${name}`, message: { role: "user", content: `do the ${name} thing` }, timestamp: iso, cwd }];
    await writeFile(path.join(dir, id + ".jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600 }));
  await writeFile(events, "");
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: events }, stdio: "ignore" });
  await until(() => fetch(`http://127.0.0.1:${PORT}/api/overview`).then((r) => r.ok).catch(() => false), 15000);
});
after(() => srv.kill("SIGTERM"));

test("hook events decide running vs needs-approval within seconds, and idle beats the file-time guess", async () => {
  await appendFile(events, ev(S.work, "UserPromptSubmit") + ev(S.idle, "UserPromptSubmit") + ev(S.idle, "Stop") + ev(S.approve, "UserPromptSubmit") + ev(S.approve, "Notification", { type: "permission_prompt", msg: "Run: npm publish" }));
  const ov = await until(async () => { const o = await api("/api/overview"); return o.needs.some((n) => n.label === "Needs approval") ? o : null; });
  const appr = ov.needs.find((n) => n.label === "Needs approval");
  assert.match(appr.line, /npm publish/);
  assert.deepEqual(ov.running.map((r) => r.id), [S.work], "only the session that is really working is running");
  assert.ok(!ov.running.some((r) => r.id === S.idle), "a recently written but finished session is not 'running'");
});
