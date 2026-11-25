// Live session state from Claude Code hook events, plus safe install/uninstall of the hook entries.
import { open, stat, readFile } from "node:fs/promises";

export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];
export const MARKER = "dashboard-hook.mjs";
const MAX_AGE = 12 * 3600_000;

/** Fold events (oldest first) into the last known state per `configDir:sessionId`. */
export function reduce(events, into = new Map()) {
  for (const e of events) {
    const key = `${e.dir}:${e.id}`; const prev = into.get(key) || {};
    let st = prev.state;
    if (e.ev === "UserPromptSubmit") st = "working";
    else if (e.ev === "Stop") st = "idle";
    else if (e.ev === "SessionStart") st = "idle";
    else if (e.ev === "SessionEnd") st = "ended";
    else if (e.ev === "Notification") st = e.type === "permission_prompt" || e.type === "elicitation_dialog" ? "approval" : e.type === "idle_prompt" ? "idle" : st;
    into.set(key, { ...prev, state: st, at: e.t, ev: e.ev, cwd: e.cwd || prev.cwd, ...(e.ev === "Notification" && st === "approval" ? { message: e.msg || "" } : e.ev === "Notification" ? {} : { message: undefined }) });
  }
  return into;
}

/**
 * What the dashboard should believe about a session. `activityAt` is the transcript's last write: Claude appends to it as soon as
 * a tool is approved, so an approval request older than the transcript is already answered.
 */
export function liveState(h, activityAt, now = Date.now()) {
  if (!h?.state || now - h.at > MAX_AGE) return null;
  if (h.state === "approval") return activityAt > h.at + 1500 ? { state: "working", at: activityAt } : { state: "approval", at: h.at, message: h.message || "Waiting for your approval" };
  return { state: h.state, at: h.at };
}

/** Incremental reader of the events file: only the appended bytes are parsed on each poll. */
export class EventLog {
  constructor(file) { this.file = file; this.pos = 0; this.states = new Map(); this.rest = ""; }
  async poll() {
    let st; try { st = await stat(this.file); } catch { return this.states; }
    if (st.size < this.pos) { this.pos = 0; this.rest = ""; this.states.clear(); } // rotated or truncated
    if (st.size === this.pos) return this.states;
    const fh = await open(this.file, "r");
    try {
      const buf = Buffer.alloc(st.size - this.pos); await fh.read(buf, 0, buf.length, this.pos); this.pos = st.size;
      const lines = (this.rest + buf.toString("utf8")).split("\n"); this.rest = lines.pop();
      const events = []; for (const l of lines) { try { const e = JSON.parse(l); if (e?.id && e.ev) events.push(e); } catch { /* skip a torn line */ } }
      reduce(events, this.states);
    } finally { await fh.close(); }
    return this.states;
  }
}

const isOurs = (h) => typeof h?.command === "string" && h.command.includes(MARKER);

/** Returns settings with our hook added for each event (idempotent). Does not mutate the input. */
export function addHooks(settings, command) {
  const out = structuredClone(settings || {}); out.hooks ||= {}; let changed = false;
  for (const ev of HOOK_EVENTS) {
    const groups = (out.hooks[ev] ||= []);
    if (groups.some((g) => (g.hooks || []).some(isOurs))) continue;
    groups.push({ hooks: [{ type: "command", command, timeout: 5 }] }); changed = true;
  }
  return { settings: out, changed };
}

/** Removes only entries that are ours; everything else stays exactly as it was. */
export function removeHooks(settings) {
  const out = structuredClone(settings || {}); let changed = false;
  for (const ev of Object.keys(out.hooks || {})) {
    const kept = [];
    for (const g of out.hooks[ev]) {
      const hs = (g.hooks || []).filter((h) => !isOurs(h));
      if (hs.length !== (g.hooks || []).length) changed = true;
      if (hs.length) kept.push({ ...g, hooks: hs }); else if (!(g.hooks || []).some(isOurs)) kept.push(g);
    }
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
  return { settings: out, changed };
}

export const readSettings = async (file) => { try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; } };
