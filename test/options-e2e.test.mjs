import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const PORT = 5700 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 200)); } };
let tmp, srv; const ID = "eeeeeeee-0000-4000-8000-000000000001";

before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "op-")); const prof = path.join(tmp, "profile"); const cwd = path.join(tmp, "shop");
  const dir = path.join(prof, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-")); await mkdir(dir, { recursive: true });
  const t = (ago) => new Date(Date.now() - ago).toISOString();
  const text = "The checkout retries on 500 errors.\n\n1. **Retry with backoff** — simple\n2. **Idempotency keys** — safer\n\nWhich approach should I take?";
  const lines = [{ type: "user", uuid: "u1", message: { role: "user", content: "fix checkout retries" }, timestamp: t(900_000), cwd }, { type: "assistant", uuid: "a1", timestamp: t(800_000), cwd, message: { id: "m1", model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text }] } }, { type: "system", subtype: "turn_duration", durationMs: 1000, timestamp: t(799_000), cwd }];
  const f = path.join(dir, ID + ".jsonl"); await writeFile(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const old = new Date(Date.now() - 600_000); await utimes(f, old, old);
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false }));
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl") }, stdio: "ignore" });
  await until(() => fetch(base + "/api/overview").then((r) => r.ok).catch(() => false));
});
after(() => srv.kill("SIGTERM"));

test("a session that asked a numbered question carries clickable options in the overview", async () => {
  const o = await until(async () => { const j = await (await fetch(base + "/api/overview")).json(); return j.needs.find((n) => n.kind === "session" && n.options?.length) ? j : null; });
  const n = o.needs.find((x) => x.kind === "session");
  assert.deepEqual(n.options.map((x) => x.label), ["Retry with backoff", "Idempotency keys"]);
  assert.equal(n.options[1].value, "Option 2: Idempotency keys");
  assert.match(n.detail[0], /Which approach/);
});
