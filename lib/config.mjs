import os from "node:os";
import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

const HOME = os.homedir();

/** Claude config folders on this machine: ~/.claude and ~/.claude-*, but only those that hold sessions (so ~/.claude-secrets and the like are never picked up). */
export async function detectProfiles() {
  const found = [];
  for (const d of (await readdir(HOME).catch(() => [])).filter((n) => n === ".claude" || n.startsWith(".claude-")).sort()) {
    if (!(await stat(path.join(HOME, d, "projects")).catch(() => null))?.isDirectory()) continue;
    found.push({ name: d === ".claude" ? "default" : d.slice(".claude-".length), dir: `~/${d}` });
  }
  return found;
}
// config.json is yours and git-ignored; without one the defaults below apply (see config.example.json for every setting).
export async function loadConfig(here) {
const CONFIG_FILE = process.env.DASH_CONFIG || path.join(here, "config.json");
const userConfig = JSON.parse(await readFile(CONFIG_FILE, "utf8").catch((e) => (e.code === "ENOENT" ? "{}" : Promise.reject(e))));
const config = { port: 4777, sessionDays: 21, doneDays: 14, githubOwners: [], inputLabels: ["needs-input"], inputFiles: [], extraRepos: [], hideProjects: [], refreshSeconds: 60, githubRefreshSeconds: 300, claudeBin: "claude", maxConcurrent: 2, catchUpWindowHours: 12, secretEnv: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"], connections: {}, toolPresets: [], ...userConfig };
if (!Array.isArray(config.profiles)) config.profiles = await detectProfiles(); // an explicit [] means "none"
if (!config.profiles.length && !userConfig.profiles) console.warn("No Claude profile found (looked for ~/.claude and ~/.claude-* with a projects folder). Set \"profiles\" in config.json.");
return { config, userConfig };
}
