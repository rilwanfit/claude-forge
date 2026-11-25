// Drives the REAL page in headless Chrome (DevTools protocol, no dependencies) against FIXTURE data:
//   node test/ui-check.mjs [screenshot-dir]
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { makeFixtures, IDS, SECRET } from "./fixtures.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const shots = process.argv[2]; const PORT = 4890 + Math.floor(Math.random() * 9), CDP = 9300 + Math.floor(Math.random() * 99);
const tmp = await mkdtemp(path.join(tmpdir(), "ui-")); const fx = makeFixtures(tmp); const log = path.join(tmp, "term.log");
await writeFile(path.join(tmp, "config.json"), JSON.stringify({ port: PORT, profiles: [{ name: "fixture", dir: fx.profileDir }], defaultProfile: "fixture", terminal: [path.join(HERE, "fake-term.mjs")], sessionDays: 21, doneDays: 14, githubOwners: [], inputLabels: [], inputFiles: [], extraRepos: [], hideProjects: [], refreshSeconds: 600, githubRefreshSeconds: 600, maxConcurrent: 2 }));
const srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT, DASH_CONFIG: path.join(tmp, "config.json"), DASH_DATA: path.join(tmp, "data"), DASH_STATE: path.join(tmp, "state.json"), DASH_CLAUDE_BIN: path.join(HERE, "fake-claude.mjs"), DASH_TERM_LOG: log, DASH_TICK_MS: "300" }, stdio: "ignore" });
const chrome = spawn(process.env.CHROME || "google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", `--remote-debugging-port=${CDP}`, `--user-data-dir=${tmp}/chrome`, "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + fn); await sleep(100); } };
const base = `http://127.0.0.1:${PORT}`;
let ws, id = 0; const pending = new Map();
try {
  await until(async () => (await fetch(base + "/api/recap").then((r) => r.json())).index.state === "idle");
  const tabs = await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json())).find((t) => t.type === "page"));
  ws = new WebSocket(tabs.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const j = JSON.parse(m.data); pending.get(j.id)?.(j); pending.delete(j.id); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails)); return r.result.result.value; };
  const text = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
  const click = (sel) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) throw new Error('no element ${sel.replace(/'/g, "")}'); e.click(); return true})()`);
  const shot = async (name) => { if (!shots) return; const r = await send("Page.captureScreenshot", { format: "png" }); await writeFile(path.join(shots, name + ".png"), Buffer.from(r.result.data, "base64")); };
  const type = (sel, v) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
  const errors = []; await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: base + "/recap" });
  const step = (n) => console.log("ok -", n);

  // 1. overview: fixture project, two worktrees as distinct tags, unknowns honest
  await until(() => js(`document.querySelectorAll('.srow').length >= 4`));
  const ov = await text("#main");
  assert.match(ov, /fixrepo/); assert.match(ov, /worktree fixrepo-wt/); assert.match(ov, /worktree gone/); assert.match(ov, /model unknown/);
  await shot("1-overview"); step("overview lists project, distinct worktrees, unknown model");

  // 2. session detail with delegation tree
  await click(`.srow[data-key="fixture:${IDS.multi}"]`);
  await until(() => js(`document.querySelector('#panel .tree')`));
  const det = await text("#panel");
  assert.match(det, /FIXTURE security review/); assert.match(det, /changed opus-5-5 → sonnet-5-5/); assert.match(det, /outcome unclear/); assert.match(det, /parent call not found/); assert.match(await js(`document.querySelector('#panel .tree').textContent`), /completed, but its recorded result/);
  assert.ok(!det.includes(SECRET)); await shot("2-detail"); step("detail shows tree, model change, unclear outcomes, no secret");

  // 3. claim -> underlying event, redacted
  await click(`#panel .evlink[data-act="ev"]`); await until(() => js(`document.querySelector('#panel pre.raw[data-ev]')`));
  assert.ok(!(await text("#panel pre.raw[data-ev]")).includes(SECRET)); step("event link shows the raw line");

  // 4. handoff: pick one finding, preview is exactly the selection
  await click(`#panel [data-act="handoff"]`); await until(() => js(`document.querySelector('#h-findings')`));
  await until(() => text("#h-pre"));
  assert.doesNotMatch(await text("#h-pre"), /idempotency/);
  await js(`(()=>{const rows=[...document.querySelectorAll('#h-findings .frow')]; const r=rows.find(x=>/idempotency/.test(x.querySelector('textarea').value)); r.querySelector('input').click(); return true})()`);
  await until(async () => /idempotency/.test(await text("#h-pre")));
  const pre = await text("#h-pre"); assert.doesNotMatch(pre, /keep Stripe/); assert.ok(!pre.includes(SECRET)); await shot("3-handoff"); step("handoff preview contains only the ticked finding");
  await click("#h-start"); await until(() => readFile(log, "utf8").then((t) => t.includes('claude \\"$(cat')));
  const handoffFile = JSON.parse((await readFile(log, "utf8")).trim().split("\n").at(-1)); assert.ok(handoffFile.some((x) => x.endsWith(".md")));
  assert.equal(await readFile(handoffFile.find((x) => x.endsWith(".md")), "utf8"), await js(`document.querySelector('#h-pre').textContent`)); step("fresh session launched with exactly the previewed text");

  // 5. resume (separate action) in its worktree
  await click(`[data-act="close"]`); await click(`.srow[data-key="fixture:${IDS.wt}"]`); await until(() => js(`document.querySelector('#panel [data-act="resume"]:not([disabled])')`)); await click(`#panel [data-act="resume"]`);
  await until(async () => (await readFile(log, "utf8")).includes("--resume"));
  const rl = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).find((l) => l.some((x) => x.includes("--resume"))); assert.equal(rl[4], fx.wt); assert.ok(rl.includes(IDS.wt)); step("resume opened the original session in its worktree");

  // 6. removed worktree: resume disabled with the reason
  await click(`.srow[data-key="fixture:${IDS.gone}"]`); await until(() => js(`document.querySelector('#panel .notice.bad')`));
  assert.equal(await js(`document.querySelector('#panel [data-act="resume"]').disabled`), true); assert.match(await text("#panel .notice.bad"), /no longer exists/); await shot("4-removed-worktree"); step("removed worktree: resume refused with a reason");

  // 7. rerun: separate action, new run, old run kept
  await click(`[data-act="close"]`);
  const wf = await (await fetch(base + "/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "FIXTURE weekly review", projectKey: fx.repo, folder: fx.repo, instructions: "Count files. period: {{period}}", inputs: [{ name: "period", type: "period", days: 7 }] }) })).json();
  const run1 = await (await fetch(`${base}/api/workflows/${wf.workflow.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "ui1" }) })).json();
  await until(async () => (await (await fetch(`${base}/api/runs/${run1.run.id}`)).json()).run.status === "done");
  await click("#refresh"); await until(() => js(`document.querySelector('.srow[data-kind="run"] [data-act="next"][data-kind="rerun"]')`));
  await click(`.srow[data-kind="run"] [data-act="next"][data-kind="rerun"]`); await until(() => js(`document.querySelector('#rr-box')`));
  await js(`(()=>{const m=document.querySelector('#rr-box [data-f=mode]'); m.value='fixed'; m.dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#rr-box [data-f=from]').value='2026-02-01'; document.querySelector('#rr-box [data-f=to]').value='2026-02-28'; return true})()`);
  await shot("5-rerun"); await click(`[data-act="rr-go"]`); await until(() => js(`document.querySelector('#rr-out .notice')`));
  const runs = (await (await fetch(`${base}/api/recap/workflow?id=${wf.workflow.id}`)).json()).runs; assert.equal(runs.length, 2); assert.ok(runs.some((r) => /2026-02-01 to 2026-02-28/.test(r.inputs))); step("rerun created a second, distinct run with the new dates; the first stays");

  // 8. search scope
  await click(`[data-act="close"]`); await type("#q", "checkout"); await js(`document.querySelector('#search-form').requestSubmit()`);
  await until(() => js(`document.querySelector('.res')`)); assert.match(await text("#main"), /FIXTURE multi-agent audit/); await shot("6-search"); step("search finds the session by problem");
  console.log("\nUI check passed");
} catch (e) { console.error("UI check FAILED:", e.message); process.exitCode = 1; }
finally { ws?.close(); chrome.kill(); srv.kill(); await sleep(200); await rm(tmp, { recursive: true, force: true }).catch(() => {}); }
