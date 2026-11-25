import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5300 + Math.floor(Math.random() * 90);
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
let tmp, srv, hook, prof, events; const received = [];
const ID = "cccccccc-0000-4000-8000-000000000001";

before(async () => {
  hook = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push(JSON.parse(b)); res.end("ok"); }); });
  await new Promise((r) => hook.listen(0, "127.0.0.1", r));
  tmp = await mkdtemp(path.join(tmpdir(), "nt-")); prof = path.join(tmp, "profile"); events = path.join(tmp, "events.jsonl"); await writeFile(events, "");
  const cwd = path.join(tmp, "secret-shop"); const dir = path.join(prof, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ID + ".jsonl"), JSON.stringify({ type: "user", uuid: "u", message: { role: "user", content: "ship it" }, timestamp: new Date(Date.now() - 5000).toISOString(), cwd }) + "\n");
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: { desktop: false, webhook: `http://127.0.0.1:${hook.address().port}/h` } }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: events }, stdio: "ignore" });
  await until(() => fetch(`http://127.0.0.1:${PORT}/api/overview`).then((r) => r.ok).catch(() => false));
  await new Promise((r) => setTimeout(r, 6500)); // let the notifier learn what is already there
});
after(() => { srv.kill("SIGTERM"); hook.close(); });

test("a new approval request reaches the webhook once, with generic text", async () => {
  assert.equal(received.length, 0, "nothing at startup");
  const ev = (e, o = {}) => JSON.stringify({ t: Date.now(), dir: prof, id: ID, ev: e, cwd: path.join(tmp, "secret-shop"), ...o }) + "\n";
  await appendFile(events, ev("UserPromptSubmit") + ev("Notification", { type: "permission_prompt", msg: "Run: rm -rf secrets" }));
  await until(() => received.length);
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(received.length, 1, "once");
  assert.deepEqual(received[0], { title: "Claude needs you", body: "Needs approval" });
});
