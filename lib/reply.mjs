// Answer a Claude session from the browser: continue it headlessly with `claude -p --resume`.
// Safety: one reply per session at a time, tools limited to read-only plus presets you pick, and the server refuses sessions that are still open in a terminal.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, open } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export const BASE_TOOLS = ["Read", "Glob", "Grep"];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + "…" : String(s));

export class Replies {
  constructor({ dir, claudeBin = "claude", now = Date.now }) { this.dir = dir; this.claudeBin = claudeBin; this.now = now; this.meta = new Map(); this.loaded = false; }
  async load() {
    if (this.loaded) return; this.loaded = true;
    for (const f of await readdir(this.dir).catch(() => [])) if (f.endsWith(".json")) { try { const m = JSON.parse(await readFile(path.join(this.dir, f), "utf8")); this.meta.set(m.id, m); } catch { /* skip */ } }
  }
  async busy(sessionId) { await this.load(); for (const m of this.meta.values()) if (m.sessionId === sessionId && (await this.refresh(m)).state === "running") return m; return null; }

  async start({ sessionId, cwd, configDir, text, tools = [] }) {
    await this.load(); await mkdir(this.dir, { recursive: true });
    const id = "rp_" + crypto.randomBytes(5).toString("hex");
    const log = path.join(this.dir, id + ".log"), exit = path.join(this.dir, id + ".exit");
    const prompt = text.startsWith("-") ? " " + text : text; // a leading dash must not be read as an option
    const args = ["-p", prompt, "--resume", sessionId, "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--allowedTools", [...BASE_TOOLS, ...tools].join(",")];
    const out = await open(log, "a");
    const env = { ...process.env }; if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
    // sh records the exit code in a file, so a dashboard restart can still learn how it ended.
    const child = spawn("sh", ["-c", '"$@"; echo $? > "$EXITFILE"', "sh", this.claudeBin, ...args], { cwd, env: { ...env, EXITFILE: exit }, detached: true, stdio: ["ignore", out.fd, out.fd] });
    child.on("error", () => {}); child.unref(); await out.close();
    const m = { id, sessionId, text: clip(text, 500), tools, startedAt: this.now(), endedAt: null, pid: child.pid, log, exit, state: "running", result: null, error: null };
    this.meta.set(id, m); await this.save(m); return m;
  }
  save(m) { return writeFile(path.join(this.dir, m.id + ".json"), JSON.stringify(m)); }

  async refresh(m) {
    if (m.state !== "running") return m;
    let code = null; try { code = Number((await readFile(m.exit, "utf8")).trim()); } catch { /* not finished */ }
    if (code === null && !alive(m.pid)) code = -1; // killed or the machine restarted
    if (code === null) return m;
    let result = null, isError = false;
    for (const l of (await readFile(m.log, "utf8").catch(() => "")).split("\n")) { try { const j = JSON.parse(l); if (j.type === "result") { result = typeof j.result === "string" ? j.result : result; isError = !!j.is_error; } } catch { /* not json */ } }
    m.endedAt = this.now(); m.result = result;
    if (code === 0 && !isError) m.state = "done";
    else { m.state = "failed"; m.error = result || (code === -1 ? "The process stopped before it finished." : `claude exited with code ${code}.`); }
    await this.save(m); return m;
  }
  async status(id) { await this.load(); const m = this.meta.get(id); return m ? this.refresh(m) : null; }
}
