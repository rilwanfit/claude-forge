#!/usr/bin/env node
// Claude Code hook: appends one small line per event to a local file the dashboard reads.
// It never prints, never touches the network, and always exits 0 so it can never block a session.
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const e = JSON.parse(raw);
  if (!e.session_id || !e.hook_event_name) process.exit(0);
  const file = process.env.DASH_EVENTS || path.join(os.homedir(), ".nudge", "events.jsonl");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = {
    t: Date.now(), dir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), id: e.session_id, ev: e.hook_event_name, cwd: e.cwd,
    ...(e.notification_type ? { type: e.notification_type } : {}), ...(e.message ? { msg: String(e.message).slice(0, 300) } : {}), ...(e.reason ? { reason: String(e.reason) } : {}),
  };
  appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 }); // one short append is atomic enough for concurrent sessions
} catch { /* never disturb the session */ }
process.exit(0);
