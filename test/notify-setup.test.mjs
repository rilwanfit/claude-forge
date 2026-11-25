import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json().catch(() => null) }; };
let tmp, srv, ntfy; const got = [];

before(async () => {
  ntfy = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push({ url: req.url, title: req.headers.title, body: b }); res.end("ok"); }); });
  await new Promise((r) => ntfy.listen(0, "127.0.0.1", r));
  tmp = await mkdtemp(path.join(tmpdir(), "ns-"));
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: { desktop: false, ntfy: { server: `http://127.0.0.1:${ntfy.address().port}` } } }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl") }, stdio: "ignore" });
  await until(() => fetch(base + "/api/overview").then((r) => r.ok).catch(() => false));
});
after(() => { srv.kill("SIGTERM"); ntfy.close(); });

test("phone alerts: off until set up, then a private topic, a generic test message, and off again", async () => {
  const off = await (await fetch(base + "/api/notify")).json();
  assert.equal(off.phone.on, false); assert.equal(off.disabled, false);
  const on = (await post("/api/notify/phone", { action: "enable" })).json;
  assert.equal(on.phone.on, true); assert.match(on.phone.topic, /^nudge-[\w-]{20}$/);
  assert.equal((await post("/api/notify/phone", { action: "enable" })).json.phone.topic, on.phone.topic, "enabling twice keeps the same topic");
  await post("/api/notify/phone", { action: "test" });
  await until(() => got.length);
  assert.equal(got[0].url, "/" + on.phone.topic); assert.equal(got[0].title, "Test notification"); assert.equal(got[0].body, "Notifications work.");
  assert.match(await readFile(path.join(tmp, "state.json"), "utf8"), /nudge-/, "the topic lives in state.json");
  assert.equal((await post("/api/notify/phone", { action: "disable" })).json.phone.on, false);
  assert.equal((await post("/api/notify/phone", { action: "bogus" })).status, 400);
});
