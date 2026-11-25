import test from "node:test";
import assert from "node:assert/strict";
import { fetchSource, normalize } from "../lib/sources.mjs";

test("normalize keeps only safe, titled items and refuses javascript: links", () => {
  const items = normalize([{ id: 1, title: "A", url: "https://x.test/a", ts: "2026-11-01T10:00:00Z" }, { title: "B", url: "javascript:alert(1)" }, { url: "https://no-title" }, null, { title: "C".repeat(500) }]);
  assert.equal(items.length, 3);
  assert.equal(items[0].ts, Date.parse("2026-11-01T10:00:00Z"));
  assert.equal(items[1].url, null, "javascript: link dropped");
  assert.equal(items[2].title.length, 200);
  assert.throws(() => normalize({ not: "an array" }), /JSON array/);
});

test("command source runs the program without a shell and parses its JSON", async () => {
  const calls = []; const run = async (cmd, args) => { calls.push([cmd, args]); return { stdout: JSON.stringify([{ title: "Fix prod", url: "https://t.test/1" }]) }; };
  const r = await fetchSource({ type: "command", command: ["my-script", "--json; rm -rf ~"] }, { run });
  assert.deepEqual(calls[0], ["my-script", ["--json; rm -rf ~"]], "arguments are passed as data");
  assert.equal(r.items[0].title, "Fix prod");
});

test("linear: key comes from the environment, issues become items, and errors are reported not thrown", async () => {
  const seen = []; const fetch = async (url, init) => { seen.push({ url, auth: init.headers.authorization }); return { ok: true, json: async () => ({ data: { viewer: { assignedIssues: { nodes: [{ identifier: "ENG-7", title: "Login bug", url: "https://linear.app/x/ENG-7", updatedAt: "2026-11-20T00:00:00Z", state: { name: "In Progress" }, team: { name: "Eng" } }] } } } }) }; };
  const ok = await fetchSource({ type: "linear" }, { fetch, env: { LINEAR_API_KEY: "lin_k" } });
  assert.equal(ok.items[0].title, "ENG-7 Login bug"); assert.equal(ok.items[0].line, "Eng · In Progress"); assert.equal(seen[0].auth, "lin_k");
  const none = await fetchSource({ type: "linear" }, { fetch, env: {} });
  assert.match(none.error, /LINEAR_API_KEY/); assert.deepEqual(none.items, []);
  assert.match((await fetchSource({ type: "nope" })).error, /Unknown source type/);
});

test("jira: basic auth from env, browse links built from baseUrl; github-reviews maps gh output", async () => {
  let hdr; const fetch = async (url, init) => { hdr = init.headers.authorization; return { ok: true, json: async () => ({ issues: [{ key: "OPS-1", fields: { summary: "Rotate keys", status: { name: "To Do" }, updated: "2026-11-02T00:00:00Z" } }] }) }; };
  const j = await fetchSource({ type: "jira", baseUrl: "https://acme.atlassian.net/" }, { fetch, env: { JIRA_EMAIL: "me@x.test", JIRA_TOKEN: "t" } });
  assert.equal(j.items[0].url, "https://acme.atlassian.net/browse/OPS-1"); assert.equal(hdr, "Basic " + Buffer.from("me@x.test:t").toString("base64"));
  const run = async () => ({ stdout: JSON.stringify([{ number: 9, title: "Add retry", url: "https://github.com/o/r/pull/9", repository: { name: "r", nameWithOwner: "o/r" }, updatedAt: "2026-11-24T00:00:00Z" }]) });
  const g = await fetchSource({ type: "github-reviews" }, { run });
  assert.equal(g.items[0].title, "r#9 Add retry"); assert.equal(g.items[0].line, "Review requested");
});
