import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5600 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 200)); } };
let tmp, srv, peer; const auth = [];

before(async () => {
  peer = http.createServer((req, res) => { auth.push(req.headers.authorization); if (req.headers.authorization !== "Bearer s3cret") { res.writeHead(401); return res.end("no"); }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ needs: [{ id: "x1", kind: "session", title: "Deploy fails", line: "Rollback?", label: "Asked you", rank: 1, ts: Date.now(), resume: "cd /private && claude" }], running: [{ id: "x2", title: "Indexing" }] })); });
  await new Promise((r) => peer.listen(0, "127.0.0.1", r));
  tmp = await mkdtemp(path.join(tmpdir(), "pe-"));
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false, peers: [{ name: "work-pc", url: `http://127.0.0.1:${peer.address().port}`, tokenEnv: "WORKPC_TOKEN" }, { name: "offline-box", url: "http://127.0.0.1:1" }] }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, WORKPC_TOKEN: "s3cret", PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl") }, stdio: "ignore" });
  await until(() => fetch(base + "/api/overview").then((r) => r.ok).catch(() => false));
});
after(() => { srv.kill("SIGTERM"); peer.close(); });

test("another machine's items appear read-only with its name; an offline peer shows an error and nothing breaks", async () => {
  const o = await until(async () => { const j = await (await fetch(base + "/api/overview")).json(); return j.needs.some((n) => n.kind === "peer") ? j : null; });
  const n = o.needs.find((x) => x.kind === "peer");
  assert.deepEqual([n.title, n.profile, n.machine, n.primary.act], ["Deploy fails", "work-pc", "work-pc", "href"]);
  assert.ok(!JSON.stringify(o).includes("/private"), "the peer's resume command is not passed on");
  assert.ok(o.running.some((r) => r.title === "Indexing" && r.profile === "work-pc"));
  assert.ok(auth.includes("Bearer s3cret"));
  const s = o.sources.filter((x) => x.name.startsWith("Machine"));
  assert.equal(s.find((x) => x.name.endsWith("work-pc")).ok, true);
  assert.equal(s.find((x) => x.name.endsWith("offline-box")).ok, false);
  assert.ok(o.projects.some((p) => p.name === "work-pc" && p.needs === 1));
});
