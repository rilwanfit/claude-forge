import test from "node:test";
import assert from "node:assert/strict";
import { Notifier, kindOf, makeDeliver } from "../lib/notify.mjs";

const sess = (id, label = "Asked you") => ({ id, kind: "session", label, title: "Fix login", line: "Which provider?" });

test("the first look only learns; later new items notify once, and only the kinds you want", async () => {
  const got = []; const n = new Notifier({ deliver: async (m) => got.push(m), projectName: () => "shop" });
  await n.observe([sess("a")]);
  assert.equal(got.length, 0, "existing items are not replayed after a restart");
  await n.observe([sess("a"), sess("b", "Needs approval"), { id: "pr1", kind: "pr", label: "Pull request" }, { id: "r1", kind: "run", status: "running" }]);
  assert.deepEqual(got.map((m) => m.kind), ["approval"]);
  assert.match(got[0].title, /Needs approval · shop/);
  await n.observe([sess("a"), sess("b", "Needs approval")]);
  assert.equal(got.length, 1, "no repeat");
  assert.equal(kindOf({ kind: "run", status: "failed" }), "failed");
  assert.equal(kindOf({ kind: "checklist" }), null);
});

test("event filter", async () => {
  const got = []; const n = new Notifier({ events: ["approval"], deliver: async (m) => got.push(m) });
  await n.observe([]); await n.observe([sess("q")]);
  assert.equal(got.length, 0);
});

test("remote channels get generic text by default and the real text only when asked; delivery errors are swallowed", async () => {
  const calls = []; const post = async (url, init) => { calls.push({ url, init }); if (url.includes("down")) throw new Error("offline"); };
  const m = { title: "Needs approval · secret-project", body: "Fix login: rm -rf ?", generic: { title: "Claude needs you", body: "Needs approval" } };
  const sh = []; const run = (cmd, args) => sh.push([cmd, ...args]);
  await makeDeliver({ webhook: "https://hook.example/x", ntfy: { topic: "my topic" } }, { post, run, platform: "linux" })(m);
  assert.deepEqual(sh[0].slice(0, 2), ["notify-send", "--app-name=Claude Forge"]); assert.ok(sh[0].includes(m.body), "desktop shows the real text: it stays on this machine");
  assert.ok(!JSON.stringify(calls).includes("secret-project") && !JSON.stringify(calls).includes("rm -rf"), "nothing private leaves the machine by default");
  assert.equal(calls[1].url, "https://ntfy.sh/my%20topic");
  calls.length = 0; await makeDeliver({ webhook: "https://hook.example/x", includeText: true, desktop: false }, { post, run, platform: "linux" })(m);
  assert.match(calls[0].init.body, /secret-project/);
  await makeDeliver({ webhook: "https://down.example" }, { post, run, platform: "linux" })(m); // must not throw
});

test("macOS: terminal-notifier opens the dashboard on click; without it, osascript is the fallback", async () => {
  const m = { title: "Needs approval · shop", body: "-rf scary", generic: { title: "Claude needs you", body: "Needs approval" } };
  const calls = [];
  const have = (cmd, args, cb) => { calls.push([cmd, args]); cb(null); };
  await makeDeliver({}, { run: have, platform: "darwin", clickUrl: "http://127.0.0.1:4777" })(m);
  assert.deepEqual(calls.map((c) => c[0]), ["terminal-notifier"]);
  const a = calls[0][1];
  assert.deepEqual(a.slice(0, 2), ["-title", "Needs approval · shop"]);
  assert.equal(a[a.indexOf("-message") + 1], " -rf scary", "a body starting with - is not read as an option");
  assert.equal(a[a.indexOf("-open") + 1], "http://127.0.0.1:4777");

  calls.length = 0;
  const missing = (cmd, args, cb) => { calls.push([cmd, args]); cb(cmd === "terminal-notifier" ? Object.assign(new Error("spawn terminal-notifier ENOENT"), { code: "ENOENT" }) : null); };
  await makeDeliver({}, { run: missing, platform: "darwin", clickUrl: "http://127.0.0.1:4777" })(m);
  assert.deepEqual(calls.map((c) => c[0]), ["terminal-notifier", "osascript"]);

  calls.length = 0; // the webhook still gets the public URL only, never the localhost click URL
  const bodies = []; const post = async (u, init) => bodies.push(JSON.parse(init.body));
  await makeDeliver({ webhook: "https://hook.example/x", desktop: false }, { run: have, post, platform: "darwin", clickUrl: "http://127.0.0.1:4777" })(m);
  assert.equal(bodies[0].url, undefined); assert.equal(calls.length, 0, "desktop off: no popup");
});
