import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5200 + Math.floor(Math.random() * 90);
let tmp, srv;
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 200)); } };

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "us-")); const prof = path.join(tmp, "profile"); const cwd = path.join(tmp, "site");
  const dir = path.join(prof, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); await mkdir(dir, { recursive: true });
  const t = (ago) => new Date(Date.now() - ago).toISOString();
  const asst = (id, out, ago) => ({ type: "assistant", uuid: `a-${id}-${out}`, timestamp: t(ago), cwd, message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const lines = [
    { type: "user", uuid: "u1", message: { role: "user", content: "hello" }, timestamp: t(60_000), cwd },
    asst("m1", 5, 50_000), asst("m1", 100, 49_000), // same message id: streamed in two records, counted once at its final size
    asst("m2", 50, 40_000),
    { type: "cost-state", totalCostUSD: 2, modelUsage: { "claude-sonnet-5-5": { inputTokens: 20, outputTokens: 150 } }, timestamp: t(30_000) },
  ];
  await writeFile(path.join(dir, "bbbbbbbb-0000-4000-8000-000000000001.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600 }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl") }, stdio: "ignore" });
  await until(() => fetch(`http://127.0.0.1:${PORT}/api/overview`).then((r) => r.ok).catch(() => false));
});
after(() => srv.kill("SIGTERM"));

test("/api/usage counts a streamed message once and reports the session cost", async () => {
  const d = await until(async () => { const j = await (await fetch(`http://127.0.0.1:${PORT}/api/usage?days=7`)).json(); return j.total.sessions ? j : null; });
  assert.equal(d.total.tokens.o, 150, "100 (final of m1) + 50 (m2), not 5 + 100 + 50");
  assert.equal(d.total.tokens.i, 20);
  assert.equal(d.total.usd, 2);
  assert.equal(d.byModel[0].model, "claude-sonnet-5-5");
  assert.equal(d.heatMax, 1, "one prompt");
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/usage`)).status, 200);
});
