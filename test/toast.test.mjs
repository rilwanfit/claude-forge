import test, { mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A tiny stand-in for the parts of the DOM that toast.mjs uses.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.cls = new Set(); this.handlers = {}; this._text = ""; this.className = ""; }
  get classList() { const s = this.cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) }; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...k) { this.children.push(...k); }
  addEventListener(e, f) { this.handlers[e] = f; }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text; }
}
const box = new El("div");
globalThis.document = { querySelector: () => box, createElement: (t) => new El(t), createRange: () => ({}) };
const clipboard = []; Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (t) => clipboard.push(t) } }, configurable: true });
const { toast } = await import("../toast.mjs");

test("a confirmation fades out after a moment", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  toast("Saved");
  assert.ok(box.cls.has("show")); assert.ok(!box.cls.has("error")); assert.equal(box.attrs.role, "status");
  mock.timers.tick(2600);
  assert.ok(!box.cls.has("show"));
  mock.timers.reset();
});

test("an error stays until closed, and has Copy and Close buttons", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  toast("Request failed (409): reason you want to report", { error: true });
  assert.ok(box.cls.has("show") && box.cls.has("error")); assert.equal(box.attrs.role, "alert");
  mock.timers.tick(10 * 60 * 1000);
  assert.ok(box.cls.has("show"), "still visible after ten minutes");
  const [text, copy, close] = box.children;
  assert.equal(text.textContent, "Request failed (409): reason you want to report");
  assert.deepEqual([copy.textContent, close.textContent], ["Copy", "×"]);
  await copy.handlers.click();
  assert.deepEqual(clipboard, ["Request failed (409): reason you want to report"]); assert.equal(copy.textContent, "Copied");
  close.handlers.click();
  assert.ok(!box.cls.has("show"));
  mock.timers.reset();
});

test("the message is shown as text, never as HTML", () => {
  toast("<img src=x onerror=alert(1)>", { error: true });
  assert.equal(box.children[0].textContent, "<img src=x onerror=alert(1)>"); assert.equal(box.children[0].tag, "span");
});

// The server must serve the shared module, or every page loses its toasts.
const PORT = 6000 + Math.floor(Math.random() * 90);
let tmp, srv;
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "ts-")); const prof = path.join(tmp, "profile"); await mkdir(path.join(prof, "projects"), { recursive: true });
  await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false }));
  srv = spawn("node", [path.join(path.dirname(new URL(import.meta.url).pathname), "../server.mjs")], { env: { ...process.env, PORT, DASH_UPDATE_CHECK: "0", DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_EVENTS: path.join(tmp, "e.jsonl") }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { if (await fetch(`http://127.0.0.1:${PORT}/api/notify`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 150)); }
});
after(() => srv?.kill("SIGTERM"));
test("the server serves /toast.mjs as JavaScript", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/toast.mjs`);
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /javascript/);
  assert.match(await r.text(), /export function toast/);
});
