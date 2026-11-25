// Extra "needs you" sources: any tracker or script can feed the inbox. Each source returns items { id, title, url, line, ts }.
//   { "type": "command", "label": "Mine", "command": ["my-script", "--json"] }      prints a JSON array of items
//   { "type": "linear", "label": "Linear", "apiKeyEnv": "LINEAR_API_KEY" }           issues assigned to you that are not done
//   { "type": "jira", "label": "Jira", "baseUrl": "https://x.atlassian.net", "emailEnv": "JIRA_EMAIL", "tokenEnv": "JIRA_TOKEN" }
//   { "type": "github-reviews", "label": "Review requests" }                         PRs waiting for your review (needs gh)
// Secrets are read from environment variables, never from config.json. Links are limited to http(s).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(execFile);
const clip = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n - 1).trimEnd() + "…" : String(s ?? ""));
const safeUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };
const time = (v) => { const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };

/** Cleans whatever a source returned into safe items; drops anything without a title. */
export function normalize(raw, limit = 50) {
  if (!Array.isArray(raw)) throw new Error("The source did not return a JSON array.");
  const out = [];
  for (const r of raw.slice(0, limit)) {
    if (!r || typeof r !== "object" || !r.title) continue;
    out.push({ id: clip(r.id ?? r.url ?? r.title, 120), title: clip(r.title, 200), line: clip(r.line ?? "", 240), url: safeUrl(r.url), ts: time(r.ts ?? r.updatedAt) });
  }
  return out;
}

const SOURCES = {
  async command(spec, { run }) {
    if (!Array.isArray(spec.command) || !spec.command.length) throw new Error('"command" must be an array like ["my-script", "--json"].');
    const { stdout } = await run(String(spec.command[0]), spec.command.slice(1).map(String), { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  },
  async linear(spec, { fetch, env }) {
    const key = env[spec.apiKeyEnv || "LINEAR_API_KEY"]; if (!key) throw new Error(`Set the ${spec.apiKeyEnv || "LINEAR_API_KEY"} environment variable.`);
    const query = "{ viewer { assignedIssues(first: 50, filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }) { nodes { identifier title url updatedAt state { name } team { name } } } } }";
    const r = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Linear answered ${r.status}.`);
    const j = await r.json(); if (j.errors) throw new Error(j.errors[0]?.message || "Linear returned an error.");
    return (j.data?.viewer?.assignedIssues?.nodes || []).map((n) => ({ id: n.identifier, title: `${n.identifier} ${n.title}`, url: n.url, line: [n.team?.name, n.state?.name].filter(Boolean).join(" · "), ts: n.updatedAt }));
  },
  async jira(spec, { fetch, env }) {
    const email = env[spec.emailEnv || "JIRA_EMAIL"], token = env[spec.tokenEnv || "JIRA_TOKEN"];
    if (!spec.baseUrl || !email || !token) throw new Error("Set baseUrl and the JIRA_EMAIL and JIRA_TOKEN environment variables.");
    const base = spec.baseUrl.replace(/\/$/, "");
    const jql = encodeURIComponent(spec.jql || "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC");
    const r = await fetch(`${base}/rest/api/3/search?jql=${jql}&maxResults=50&fields=summary,status,updated`, { headers: { authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"), accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`Jira answered ${r.status}.`);
    return ((await r.json()).issues || []).map((i) => ({ id: i.key, title: `${i.key} ${i.fields?.summary ?? ""}`, url: `${base}/browse/${i.key}`, line: i.fields?.status?.name || "", ts: i.fields?.updated }));
  },
  async "github-reviews"(spec, { run }) {
    const { stdout } = await run("gh", ["search", "prs", "--review-requested=@me", "--state=open", "--limit", "30", "--json", "number,title,url,repository,updatedAt"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout).map((p) => ({ id: `${p.repository?.nameWithOwner}#${p.number}`, title: `${p.repository?.name ?? ""}#${p.number} ${p.title}`, url: p.url, line: "Review requested", ts: p.updatedAt }));
  },
};
export const SOURCE_TYPES = Object.keys(SOURCES);

/** Fetches one source. Never throws: returns { items, error } so one broken tracker cannot take the page down. */
export async function fetchSource(spec, deps = {}) {
  const d = { run: execP, fetch: (...a) => fetch(...a), env: process.env, ...deps };
  try {
    const fn = SOURCES[spec.type]; if (!fn) throw new Error(`Unknown source type "${spec.type}". Use one of: ${SOURCE_TYPES.join(", ")}.`);
    return { items: normalize(await fn(spec, d)), error: null };
  } catch (e) { return { items: [], error: clip(e.message || String(e), 200) }; }
}
