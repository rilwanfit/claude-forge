import test from "node:test";
import assert from "node:assert/strict";
import { fetchPeer, fromOverview } from "../lib/peers.mjs";

const peer = { name: "work-pc", url: "http://10.0.0.5:4777", tokenEnv: "T" };
const ov = { needs: [{ id: "s1", kind: "session", title: "Fix login", line: "Which provider?", label: "Needs approval", rank: 0, ts: 5, resume: "cd /secret && claude --resume x", answer: "long private text" }, { id: "p1", kind: "peer", title: "from another peer" }], running: [{ id: "s2", title: "Refactor" }] };

test("peer items are read-only, carry only what the page needs, and peer-of-peer items are dropped", () => {
  const r = fromOverview(peer, ov);
  assert.equal(r.needs.length, 1);
  assert.deepEqual(Object.keys(r.needs[0]).sort(), ["id", "kind", "label", "line", "machine", "peerStatus", "primary", "projectKey", "rank", "title", "ts"]);
  assert.ok(!JSON.stringify(r).includes("secret"), "no resume command or answer text crosses over");
  assert.equal(r.needs[0].primary.href, "http://10.0.0.5:4777/");
  assert.equal(r.running[0].peerStatus, "running");
});

test("fetchPeer sends the token from the environment, refuses redirects and reports problems without throwing", async () => {
  let seen; const fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ov }; };
  const ok = await fetchPeer(peer, { fetch, env: { T: "tok" } });
  assert.equal(seen.url, "http://10.0.0.5:4777/api/overview"); assert.equal(seen.init.headers.authorization, "Bearer tok"); assert.equal(seen.init.redirect, "error");
  assert.equal(ok.error, null);
  assert.match((await fetchPeer(peer, { fetch, env: {} })).error, /Set the T environment variable/);
  assert.match((await fetchPeer(peer, { fetch: async () => ({ ok: false, status: 401 }), env: { T: "x" } })).error, /access token/);
  assert.match((await fetchPeer({ ...peer, url: "file:///etc/passwd" }, { fetch, env: { T: "x" } })).error, /http or https/);
  assert.match((await fetchPeer(peer, { fetch: async () => { throw new Error("ECONNREFUSED"); }, env: { T: "x" } })).error, /ECONNREFUSED/);
});
