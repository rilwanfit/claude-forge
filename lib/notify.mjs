// Notifications for things that need you: a new approval request, a question, a run to review, a failed run.
// Desktop notifications stay on this machine. Webhook / ntfy go off-machine, so they carry generic text unless includeText is set.
import { execFile } from "node:child_process";

export const DEFAULT_EVENTS = ["approval", "question", "review", "failed"];

/** Which kind of event a "needs you" item is, or null for items that should not ping (PRs, checklists, issues). */
export function kindOf(item) {
  if (item.kind === "session") return item.label === "Needs approval" ? "approval" : "question";
  if (item.kind === "run") return item.status === "failed" ? "failed" : ["needs_review", "needs_input", "blocked"].includes(item.status) ? "review" : null;
  return null;
}

const TITLES = { approval: "Needs approval", question: "Asked you a question", review: "Needs your review", failed: "Run failed" };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + "…" : String(s));

export function describe(item, project) {
  const kind = kindOf(item);
  return { kind, id: item.id || item.key, title: `${TITLES[kind]} · ${project || "project"}`, body: clip([item.title, item.line].filter(Boolean).join(": "), 200), generic: { title: "Claude needs you", body: TITLES[kind] } };
}

/** Remembers what it has seen. The first call only learns, so a restart never replays old items. */
export class Notifier {
  constructor({ events = DEFAULT_EVENTS, deliver, projectName = () => "" }) { this.events = new Set(events); this.deliver = deliver; this.projectName = projectName; this.seen = new Set(); this.primed = false; }
  async observe(needs) {
    const sent = [];
    for (const item of needs) {
      const id = item.id || item.key; if (!id || this.seen.has(id)) continue;
      this.seen.add(id);
      if (!this.primed) continue;
      const kind = kindOf(item); if (!kind || !this.events.has(kind)) continue;
      const msg = describe(item, this.projectName(item)); sent.push(msg);
      await this.deliver(msg).catch(() => {});
    }
    this.primed = true;
    return sent;
  }
}

/**
 * macOS: osascript notifications belong to Script Editor, so clicking one opens Script Editor.
 * terminal-notifier (brew install terminal-notifier) can open a URL on click instead. Without it, fall back to osascript.
 */
function notifyMac(run, m, url) {
  const osascript = () => run("osascript", ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run", m.body, m.title], () => {});
  // The leading space keeps a body that starts with "-" from being read as an option.
  run("terminal-notifier", ["-title", m.title, "-message", " " + m.body, "-group", "claude-forge", ...(url ? ["-open", url] : [])], (err) => { if (err) osascript(); });
}

/** Builds the deliver() function from config.notify. Every channel fails quietly: a notification must never break the dashboard. */
export function makeDeliver(cfg = {}, { run = execFile, post = (url, init) => fetch(url, init), platform = process.platform, publicUrl = "", clickUrl = publicUrl } = {}) {
  const desktop = cfg.desktop !== false;
  const text = (m) => (cfg.includeText ? m : m.generic);
  return async (m) => {
    if (desktop) {
      if (platform === "linux") run("notify-send", ["--app-name=Claude Forge", "--", m.title, m.body], () => {});
      else if (platform === "darwin") notifyMac(run, m, clickUrl);
    }
    const t = text(m);
    if (cfg.webhook) await post(cfg.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: t.title, body: t.body, url: publicUrl || undefined }) }).catch(() => {});
    if (cfg.ntfy?.topic) await post(`${(cfg.ntfy.server || "https://ntfy.sh").replace(/\/$/, "")}/${encodeURIComponent(cfg.ntfy.topic)}`, { method: "POST", headers: { Title: t.title, ...(publicUrl ? { Click: publicUrl } : {}) }, body: t.body }).catch(() => {});
  };
}
