import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkForUpdate } from "../lib/update.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHA = "a".repeat(40);
const compare = (o) => ({ status: "ahead", ahead_by: 2, commits: [{ sha: "b".repeat(40), commit: { message: "First change\n\nbody" } }, { sha: "c".repeat(40), commit: { message: "Second change" } }], ...o });

test("a checkout behind main is reported, newest change first", async () => {
  const seen = [];
  const r = await checkForUpdate({ head: async () => SHA, get: async (p) => { seen.push(p); return compare(); } });
  assert.deepEqual(seen, [`/repos/rilwanfit/claude-forge/compare/${SHA}...main`]);
  assert.equal(r.available, true); assert.equal(r.behind, 2); assert.equal(r.diverged, false);
  assert.equal(r.latest, "ccccccc"); assert.equal(r.current, "aaaaaaa");
  assert.deepEqual(r.changes, ["Second change", "First change"]);
});

test("an up-to-date checkout, or one ahead of main, shows nothing", async () => {
  for (const o of [{ status: "identical", ahead_by: 0, commits: [] }, { status: "behind", ahead_by: 0, commits: [] }]) {
    assert.equal((await checkForUpdate({ head: async () => SHA, get: async () => compare(o) })).available, false);
  }
});

test("local commits plus new commits on main are flagged as diverged", async () => {
  const r = await checkForUpdate({ head: async () => SHA, get: async () => compare({ status: "diverged" }) });
  assert.equal(r.available, true); assert.equal(r.diverged, true);
});

test("an unknown answer (not a git checkout, offline, a commit GitHub does not know) shows nothing", async () => {
  assert.equal(await checkForUpdate({ head: async () => null, get: async () => assert.fail("no request without a commit") }), null);
  assert.equal(await checkForUpdate({ head: async () => SHA, get: async () => null }), null);
  assert.equal(await checkForUpdate({ head: async () => SHA, get: async () => ({ message: "Not Found" }) }), null);
});

// --- the server: a fake GitHub API stands in for api.github.com
const PORT = 5900 + Math.floor(Math.random() * 90);
let tmp, srv, fake, asked = [];
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };

before(async () => {
  fake = http.createServer((req, res) => { asked.push({ url: req.url, ua: req.headers["user-agent"] }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(compare())); });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  tmp = await mkdtemp(path.join(tmpdir(), "up-")); const prof = path.join(tmp, "profile"); await mkdir(path.join(prof, "projects"), { recursive: true });
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false }));
});
after(() => { srv?.kill("SIGTERM"); fake.close(); });
const start = async (extra = {}) => {
  asked = [];
  srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_UPDATE_CHECK: "1", DASH_UPDATE_API: `http://127.0.0.1:${fake.address().port}`, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl"), ...extra }, stdio: "ignore" });
  await until(() => fetch(`http://127.0.0.1:${PORT}/api/update`).then((r) => r.ok).catch(() => false));
};

test("the server reports an update, and sends only the commit id with a generic user agent", async () => {
  const head = spawnSync("git", ["-C", path.join(HERE, ".."), "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  if (!head) return; // not a git checkout (a zip download): nothing to compare
  await start();
  const u = await until(async () => { const j = await fetch(`http://127.0.0.1:${PORT}/api/update`).then((r) => r.json()); return j.available ? j : null; });
  assert.equal(u.behind, 2); assert.equal(u.enabled, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, `/repos/rilwanfit/claude-forge/compare/${head}...main`);
  assert.equal(asked[0].ua, "claude-forge-update-check");
  srv.kill("SIGTERM"); await new Promise((r) => srv.once("exit", r));
});

test("DASH_UPDATE_CHECK=0 makes no request at all", async () => {
  await start({ DASH_UPDATE_CHECK: "0" });
  await new Promise((r) => setTimeout(r, 1500));
  const u = await fetch(`http://127.0.0.1:${PORT}/api/update`).then((r) => r.json());
  assert.deepEqual(u, { enabled: false, available: false }); assert.equal(asked.length, 0);
  srv.kill("SIGTERM"); await new Promise((r) => srv.once("exit", r));
});

// --- update.sh: real git repos in a temp folder, and HOME pointed there so no real service is touched
const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, HOME: tmp, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", ...env } });
const git = (cwd, ...a) => { const r = sh(cwd, "git", a); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
async function repos() {
  const base = await mkdtemp(path.join(tmpdir(), "upsh-")); const origin = path.join(base, "origin.git"); const a = path.join(base, "a"); const b = path.join(base, "b");
  git(base, "init", "-q", "--bare", "-b", "main", origin); git(base, "clone", "-q", origin, a);
  await writeFile(path.join(a, "f.txt"), "1\n"); git(a, "add", "."); git(a, "commit", "-q", "-m", "first"); git(a, "push", "-q", "origin", "main");
  git(base, "clone", "-q", origin, b); await copyFile(path.join(HERE, "../update.sh"), path.join(b, "update.sh"));
  return { a, b };
}

test("update.sh pulls new commits and says what it did", async () => {
  const { a, b } = await repos();
  assert.match(sh(b, "sh", ["update.sh"]).stdout, /Already up to date/);
  await writeFile(path.join(a, "f.txt"), "2\n"); git(a, "commit", "-qam", "second change"); git(a, "push", "-q", "origin", "main");
  const r = sh(b, "sh", ["update.sh"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /1 new commit/); assert.match(r.stdout, /second change/); assert.match(r.stdout, /Updated to/);
  assert.equal((await readFile(path.join(b, "f.txt"), "utf8")), "2\n");
});

test("update.sh refuses, and keeps your work, when it cannot fast-forward", async () => {
  const { a, b } = await repos();
  await writeFile(path.join(b, "f.txt"), "mine\n"); git(b, "commit", "-qam", "my local commit");
  await writeFile(path.join(a, "g.txt"), "x\n"); git(a, "add", "."); git(a, "commit", "-qm", "remote change"); git(a, "push", "-q", "origin", "main");
  const r = sh(b, "sh", ["update.sh"]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /could not be applied cleanly/);
  assert.equal(await readFile(path.join(b, "f.txt"), "utf8"), "mine\n");
  assert.equal(git(b, "log", "-1", "--format=%s"), "my local commit");
});
