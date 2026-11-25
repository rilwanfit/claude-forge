#!/usr/bin/env node
// Stands in for `claude -p --output-format stream-json`: no network, no credentials.
import { writeFileSync, mkdirSync } from "node:fs";
const a = process.argv.slice(2);
const val = (f) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
const prompt = val("-p"); const sid = val("--session-id") || val("--resume");
const out = /Markdown to (\S+)report\.md/.exec(prompt)?.[1];
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "system", subtype: "init", session_id: sid, resumed: a.includes("--resume") });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Glob", input: { pattern: "**/*.php" } }] } });
if (prompt.includes("SLEEP")) { setTimeout(() => {}, 60_000); process.on("SIGTERM", () => process.exit(143)); }
else {
  const period = /period: (\S+ to \S+)/.exec(prompt)?.[1] || "none";
  const ask = prompt.includes("ASK") && !prompt.includes("My answer");
  const resumed = a.includes("--resume");
  if (out) mkdirSync(out, { recursive: true });
  if (out && !resumed) writeFileSync(out + "report.md", `# Report\n\nPeriod ${period}\n\nargs: ${process.env.CLAUDE_CONFIG_DIR || ""}\n`);
  const text = ask ? "Need a decision.\nQUESTION: Which folder should I scan?" : resumed ? `Done after resume.\nFINDING: continued same session ${sid}` : `Counted files for ${period}.\nFINDING: 42 PHP files in ${period}`;
  emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid, total_cost_usd: 0 });
}
