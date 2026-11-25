import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { reduce, liveState, EventLog, addHooks, removeHooks } from "../lib/hooks.mjs";

const ev = (ev, t, o = {}) => ({ dir: "/c", id: "s1", ev, t, ...o });

test("a turn goes working → idle, and approvals are real until the transcript moves on", () => {
  const h = reduce([ev("SessionStart", 1), ev("UserPromptSubmit", 2)]).get("/c:s1");
  assert.equal(liveState(h, 0, 3).state, "working");
  const ap = reduce([ev("UserPromptSubmit", 2), ev("Notification", 3, { type: "permission_prompt", msg: "Run rm?" })]).get("/c:s1");
  assert.deepEqual(liveState(ap, 0, 4), { state: "approval", at: 3, message: "Run rm?" });
  assert.equal(liveState(ap, 5000, 6000).state, "working", "transcript written after the prompt: it was approved");
  assert.equal(liveState(reduce([ev("Stop", 9)], new Map([["/c:s1", ap]])).get("/c:s1"), 0, 10).state, "idle");
});

test("ended and stale sessions", () => {
  assert.equal(liveState(reduce([ev("SessionEnd", 1)]).get("/c:s1"), 0, 2).state, "ended");
  assert.equal(liveState(reduce([ev("UserPromptSubmit", 1)]).get("/c:s1"), 0, 1 + 13 * 3600_000), null, "a crash must not leave 'working' forever");
});

test("EventLog reads only appended lines and survives a torn write", async () => {
  const f = path.join(await mkdtemp(path.join(tmpdir(), "ev-")), "events.jsonl");
  await writeFile(f, JSON.stringify(ev("UserPromptSubmit", 1)) + "\n" + '{"t":2,"dir":"/c","id":"s1","ev":"St');
  const log = new EventLog(f);
  assert.equal((await log.poll()).get("/c:s1").state, "working");
  await appendFile(f, 'op"}\n');
  assert.equal((await log.poll()).get("/c:s1").state, "idle");
});

test("install is idempotent, keeps the user's own hooks, and uninstall removes only ours", () => {
  const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, theme: "dark" };
  const a = addHooks(mine, 'node "/x/hooks/dashboard-hook.mjs"');
  assert.ok(a.changed); assert.equal(a.settings.theme, "dark"); assert.equal(a.settings.hooks.Stop.length, 2);
  assert.ok(!addHooks(a.settings, 'node "/x/hooks/dashboard-hook.mjs"').changed);
  assert.deepEqual(removeHooks(a.settings).settings, mine);
  assert.deepEqual(mine.hooks.Stop.length, 1, "input not mutated");
});

test("the hook script records an event, ignores junk and always exits 0", async () => {
  const f = path.join(await mkdtemp(path.join(tmpdir(), "ev-")), "sub", "events.jsonl");
  const run = (input) => spawnSync("node", [path.join(import.meta.dirname, "../hooks/dashboard-hook.mjs")], { input, env: { ...process.env, DASH_EVENTS: f, CLAUDE_CONFIG_DIR: "/c" } });
  assert.equal(run(JSON.stringify({ session_id: "s9", hook_event_name: "Notification", notification_type: "permission_prompt", message: "ok", cwd: "/p" })).status, 0);
  assert.equal(run("not json").status, 0);
  assert.equal((await new EventLog(f).poll()).get("/c:s9").state, "approval");
});
