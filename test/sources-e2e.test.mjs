import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5500 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
let tmp, srv;

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "src-"));
  const script = path.join(tmp, "tracker.mjs");
  await writeFile(script, `console.log(JSON.stringify([{id:"T-1",title:"Renew the certificate",url:"https://tracker.test/T-1",line:"Due Friday",ts:Date.now()},{id:"T-2",title:"Evil link",url:"javascript:alert(1)"}]))`);
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false, sources: [{ type: "command", label: "Tracker", command: ["node", script] }, { type: "linear", label: "Linear" }] }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, DASH_UPDATE_CHECK: "0", LINEAR_API_KEY: "", PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl") }, stdio: "ignore" });
  await until(() => fetch(base + "/api/overview").then((r) => r.ok).catch(() => false));
});
after(() => srv.kill("SIGTERM"));

test("a command source appears in needs-you with a safe link; a misconfigured source shows its error instead of breaking the page", async () => {
  const o = await until(async () => { const j = await (await fetch(base + "/api/overview")).json(); return j.needs.some((n) => n.kind === "external") ? j : null; });
  const ext = o.needs.filter((n) => n.kind === "external");
  assert.equal(ext.length, 2);
  const good = ext.find((n) => /certificate/.test(n.title));
  assert.deepEqual([good.label, good.line, good.primary.act, good.primary.href], ["Tracker", "Due Friday", "href", "https://tracker.test/T-1"]);
  assert.equal(ext.find((n) => /Evil/.test(n.title)).primary.act, "dismiss", "javascript: link never becomes a link");
  const src = o.sources.find((s) => s.name === "Linear");
  assert.equal(src.ok, false); assert.match(src.detail, /LINEAR_API_KEY/);
  assert.ok(o.projects.some((p) => p.name === "Tracker" && p.needs === 2));
});
