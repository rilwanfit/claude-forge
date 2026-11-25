// Writes a realistic demo store (six projects, every run state) into a separate data folder.
// Usage: node test/seed-demo.mjs /tmp/dash-demo   then start the server with DASH_DATA=/tmp/dash-demo
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveInputs } from "../lib/schedule.mjs";
const dir = process.argv[2] || "/tmp/dash-demo"; const home = process.env.HOME;
const now = Date.now(), H = 3600_000, D = 24 * H;
const P = { site: `${home}/Code/marketing-site`, snap: `${home}/Code/mobile-app`, front: `${home}/Code/web-store`, blog: `${home}/Code/blog-content`, tax: `${home}/Code/docs-site`, social: `${home}/Code/community-bot` };
const wf = (id, name, icon, projectKey, instructions, o = {}) => ({ id, name, icon, projectKey, folder: projectKey, instructions, inputs: o.inputs ?? [], allowedTools: o.tools ?? [], requires: o.requires ?? [], outputDir: "", profile: "default", model: "", review: o.review ?? { enabled: false }, lastInputs: null, createdAt: now - 30 * D, updatedAt: now - D, schedule: { enabled: !!o.sched, paused: !!o.paused, days: o.sched?.days ?? [], time: o.sched?.time ?? "08:00", missed: "latest", checkedAt: now } });
const period = [{ name: "period", label: "Period", type: "period", days: 7 }];
const W = [
  wf("wf_gsc", "Weekly search performance", "chart", P.site, "Use Search Console to compare {{period}} with {{period.previous}}. List pages that lost clicks.", { inputs: period, requires: ["gsc"], tools: ["mcp__gsc"], sched: { days: [1], time: "08:00" } }),
  wf("wf_seo", "SEO page review", "scan", P.site, "Review the public pages for SEO problems and link each finding to its page.", { sched: { days: [3], time: "09:30" } }),
  wf("wf_mix", "Weekly Mixpanel report", "chart", P.snap, "Compare {{period}} with {{period.previous}} in Mixpanel.", { inputs: period, requires: ["mixpanel"], sched: { days: [2], time: "09:00" } }),
  wf("wf_comp", "Competitor research", "globe", P.snap, "Compare three competitors on pricing and positioning: {{topic}}", { inputs: [{ name: "topic", label: "Topic", type: "text", default: "pricing" }], tools: ["WebSearch", "WebFetch"] }),
  wf("wf_site", "Site content review", "scan", P.front, "Review the site copy for outdated claims.", { sched: { days: [5], time: "10:00" } }),
  wf("wf_drafts", "Website content drafts", "write", P.blog, "Draft two blog posts from the latest changelog.", { sched: { days: [4], time: "07:30" } }),
  wf("wf_lost", "Lost clicks review", "search", P.tax, "Which pages lost clicks in {{period}}?", { inputs: period, requires: ["gsc"], sched: { days: [1], time: "08:30" }, paused: true }),
  wf("wf_soc", "Social drafts", "write", P.social, "Draft three chat posts from this week's vacancies.", { review: { enabled: true, question: "Publish 3 posts to the chat channel?", action: "Post the three drafts to the chat channel.", tools: [] }, sched: { days: [1, 3, 5], time: "11:00" } }),
];
const runs = {};
function run(id, w, status, o = {}) {
  const outputDir = path.join(dir, "runs", id, "output"); mkdirSync(outputDir, { recursive: true });
  const res = resolveInputs(w.inputs, {}, new Date(now - (o.age ?? 0)));
  if (o.report) writeFileSync(path.join(outputDir, "report.md"), o.report);
  runs[id] = { id, workflowId: w.id, workflowName: w.name, icon: w.icon, projectKey: w.projectKey, folder: w.folder, profile: "default", trigger: o.trigger ?? "schedule", scheduledFor: null, late: false, status, createdAt: now - (o.age ?? 0), startedAt: now - (o.age ?? 0), endedAt: ["queued", "running"].includes(status) ? null : now - (o.age ?? 0) + 4 * 60_000, sessionId: "00000000-0000-4000-8000-" + id.slice(-12).padStart(12, "0"), requestId: null, instructions: w.instructions, inputs: res.values, flat: res.flat, supplied: {}, tools: w.allowedTools, requires: w.requires, review: w.review, model: "", outputDir, segments: [], activity: o.activity ?? { steps: 0, last: "", at: null }, result: o.finding ? { finding: o.finding, primary: o.report ? "report.md" : null, files: o.report ? ["report.md"] : [], summary: "" } : null, decision: o.decision ?? null, blocker: o.blocker ?? null, error: o.error ?? null, replaces: null, replacedBy: null };
}
const w = Object.fromEntries(W.map((x) => [x.id, x]));
run("run_d1", w.wf_gsc, "done", { age: 1 * D + 2 * H, finding: "Clicks fell 12% (1,840 to 1,620); 4 pages lost more than 20 clicks.", report: "# Weekly search performance\n\n**Clicks fell 12%** week on week.\n\n| Page | Last week | This week |\n|---|---|---|\n| /nl/it-projecten | 210 | 146 |\n| /nl/kosten | 154 | 118 |\n\n- Title changed on /nl/kosten on 17 Nov\n" });
run("run_d2", w.wf_gsc, "done", { age: 8 * D + 2 * H, finding: "Clicks up 3% to 1,840.", report: "# Weekly search performance\n\nClicks up 3%.\n" });
run("run_d3", w.wf_drafts, "done", { age: 3 * H, trigger: "manual", finding: "Two drafts ready: Product launch and Pricing update.", report: "# Drafts\n\n## Product launch\n\n...\n" });
run("run_d4", w.wf_seo, "done", { age: 2 * D, finding: "9 findings: 3 missing meta descriptions, 2 duplicate titles.", report: "# SEO review\n\n- [/nl/kosten](/nl/kosten) has no meta description\n" });
run("run_n1", w.wf_soc, "needs_review", { age: 40 * 60_000, finding: "Three posts drafted for chat.", report: "# Drafts\n\n1. New: 12 sponsored vacancies this week\n", decision: { kind: "review", text: w.wf_soc.review.question, action: w.wf_soc.review.action } });
run("run_n2", w.wf_comp, "needs_input", { age: 2 * H, trigger: "manual", finding: "Waiting on the competitor list.", decision: { kind: "question", text: "Which three competitors should I compare?" } });
run("run_n3", w.wf_mix, "blocked", { age: 5 * H, blocker: { missing: [{ id: "mixpanel", label: "Mixpanel", detail: 'MCP server "mixpanel" is not configured for profile "default"', fix: "Add the Mixpanel MCP server to the profile (claude mcp add) and sign in" }] } });
run("run_f1", w.wf_lost, "failed", { age: 1 * D + 6 * H, error: "Search Console returned 403 for property sc-domain:example.com: the signed-in account has no access." });
run("run_r1", w.wf_site, "running", { age: 7 * 60_000, trigger: "manual", activity: { steps: 14, last: "Read templates/home/index.html.twig", at: now - 20_000 } });
const sl = spawn("sleep", ["3000"], { detached: true, stdio: "ignore" }); sl.unref();
runs.run_r1.segments = [{ n: 1, kind: "run", startedAt: now - 7 * 60_000, pid: sl.pid, offset: 0, log: path.join(dir, "runs/run_r1/log-1.jsonl"), exit: path.join(dir, "runs/run_r1/exit-1") }];
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "store.json"), JSON.stringify({ workflows: w, runs, scheduler: { lastTick: now, missed: [{ workflowId: "wf_mix", workflow: "Weekly Mixpanel report", at: now - 3 * D, reason: "superseded by a later run", recordedAt: now - D }], skipped: [] } }));
console.log("seeded", dir);
