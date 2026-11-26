import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OPEN = 6100 + Math.floor(Math.random() * 40); // network-visible, token required
const LOCAL = 6150 + Math.floor(Math.random() * 40); // the default: this computer only
const TOKEN = "t0ken-" + "a1b2c3d4e5f6".repeat(3);
let tmp, open, local;
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
const bearer = { authorization: `Bearer ${TOKEN}` };
const get = (port, p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: "manual" });
const post = (port, p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

const startServer = async (port, extra) => {
  const prof = path.join(tmp, "profile-" + port); await mkdir(path.join(prof, "projects"), { recursive: true });
  await writeFile(path.join(tmp, `config-${port}.json`), JSON.stringify({ port, profiles: [{ name: "p", dir: prof }], githubOwners: [], inputFiles: [], refreshSeconds: 600, githubRefreshSeconds: 600, notify: false }));
  const srv = spawn("node", [path.join(HERE, "../server.mjs")], { env: { ...process.env, PORT: port, DASH_UPDATE_CHECK: "0", DASH_CONFIG: path.join(tmp, `config-${port}.json`), DASH_DATA: path.join(tmp, "data-" + port), DASH_STATE: path.join(tmp, `state-${port}.json`), DASH_EVENTS: path.join(tmp, `e-${port}.jsonl`), ...extra }, stdio: "ignore" });
  await until(() => fetch(`http://127.0.0.1:${port}/pair`, { headers: bearer }).then(() => true).catch(() => false));
  return srv;
};
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "pair-"));
  open = await startServer(OPEN, { DASH_HOST: "0.0.0.0", DASH_TOKEN: TOKEN, DASH_PAIR_TTL_MS: "1500" });
  local = await startServer(LOCAL, {});
});
after(() => { open?.kill("SIGTERM"); local?.kill("SIGTERM"); });

test("by default pairing is off: the page is told how to turn it on, and no code can be made", async () => {
  const v = await (await get(LOCAL, "/api/pair")).json();
  assert.equal(v.exposed, false); assert.deepEqual(v.addresses, []);
  const r = await post(LOCAL, "/api/pair"); assert.equal(r.status, 409); assert.match((await r.json()).error, /DASH_HOST/);
  assert.equal((await get(LOCAL, "/pair?code=anything")).status, 404, "no pairing door on a local-only server");
});

test("on a network-visible server the pairing API itself needs the access token", async () => {
  assert.equal((await get(OPEN, "/api/pair")).status, 401);
  assert.equal((await post(OPEN, "/api/pair")).status, 401, "a stranger on the network cannot mint a code");
  const v = await (await get(OPEN, "/api/pair", bearer)).json();
  assert.equal(v.exposed, true); assert.equal(v.ttlSeconds, 1.5);
});

test("a one-time link logs a phone in once, without the token in the link", async (t) => {
  const r = await post(OPEN, "/api/pair", bearer); assert.equal(r.status, 201);
  const j = await r.json();
  if (!j.links.length) return t.skip("this machine has no network address to put in a link");
  for (const l of j.links) assert.ok(!l.includes(TOKEN), "the QR link never contains the access token");
  const code = new URL(j.links[0]).searchParams.get("code"); assert.ok(code.length >= 32, "an unguessable code");
  assert.equal((await get(OPEN, "/api/overview")).status, 401, "before pairing: no access");
  const redeem = await get(OPEN, `/pair?code=${code}`); // the phone has no cookie yet
  assert.equal(redeem.status, 302); assert.equal(redeem.headers.get("location"), "/");
  const setCookie = redeem.headers.get("set-cookie"); const cookie = /dash_token=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(cookie, "sets the login cookie"); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.equal((await get(OPEN, "/api/overview", { cookie: `dash_token=${cookie}` })).status, 200, "the cookie works");
  const again = await get(OPEN, `/pair?code=${code}`); assert.equal(again.status, 410, "single use"); assert.equal(again.headers.get("set-cookie"), null);
});

test("an unknown, empty or expired code is refused and sets no cookie", async (t) => {
  for (const q of ["code=nope", "code=", ""]) { const r = await get(OPEN, `/pair?${q}`); assert.equal(r.status, 410, q); assert.equal(r.headers.get("set-cookie"), null); }
  const j = await (await post(OPEN, "/api/pair", bearer)).json();
  if (!j.links.length) return t.skip("this machine has no network address to put in a link");
  await new Promise((r) => setTimeout(r, 1700)); // longer than the 1.5 s test lifetime
  const late = await get(OPEN, `/pair?code=${new URL(j.links[0]).searchParams.get("code")}`); assert.equal(late.status, 410, "expired"); assert.equal(late.headers.get("set-cookie"), null);
});

test("serves the QR module to the page", async () => {
  const r = await get(OPEN, "/qr.mjs", bearer); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /javascript/); assert.match(await r.text(), /export function qrSvg/);
});
