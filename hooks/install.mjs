#!/usr/bin/env node
// Adds (or removes) the dashboard's hook entries in your Claude settings, after showing exactly what changes.
//   node hooks/install.mjs                 install into every detected profile (asks first)
//   node hooks/install.mjs --uninstall     remove only our entries
//   node hooks/install.mjs --yes           do not ask
//   node hooks/install.mjs --dir ~/.claude-work   one specific profile folder
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { writeFile, copyFile, rename } from "node:fs/promises";
import { loadConfig } from "../lib/config.mjs";
import { addHooks, removeHooks, readSettings, HOOK_EVENTS } from "../lib/hooks.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const dirArg = args[args.indexOf("--dir") + 1];
const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const command = `node "${path.join(here, "dashboard-hook.mjs")}"`;
const uninstall = flag("--uninstall");

const { config } = await loadConfig(path.join(here, ".."));
const dirs = (flag("--dir") && dirArg ? [dirArg] : config.profiles.map((p) => p.dir)).map((d) => path.resolve(expand(d)));
if (!dirs.length) { console.error("No Claude profile found. Use --dir <folder>."); process.exit(1); }

const plan = [];
for (const dir of dirs) {
  const file = path.join(dir, "settings.json");
  let current; try { current = await readSettings(file); } catch (e) { console.error(`Skipping ${file}: ${e.message}`); continue; }
  const { settings, changed } = (uninstall ? removeHooks : (s) => addHooks(s, command))(current);
  plan.push({ file, settings, changed });
}
const todo = plan.filter((p) => p.changed);
if (!todo.length) { console.log(uninstall ? "Nothing to remove." : "Already installed in every profile."); process.exit(0); }

console.log(uninstall ? "This removes the dashboard hook from:" : `This adds a hook that records ${HOOK_EVENTS.join(", ")} events to ~/.nudge/events.jsonl.`);
console.log("It writes only: session id, event name, folder, and the text of a permission request. No network. Your other settings and hooks are untouched.\n");
for (const p of todo) console.log(`  ${p.file}`);
if (!uninstall) console.log(`\nEach file gets, per event:  { "hooks": [{ "type": "command", "command": ${JSON.stringify(command)}, "timeout": 5 }] }`);

if (!flag("--yes")) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question("\nContinue? [y/N] ")).trim().toLowerCase(); rl.close();
  if (a !== "y" && a !== "yes") { console.log("Nothing changed."); process.exit(0); }
}
for (const p of todo) {
  await copyFile(p.file, `${p.file}.dashboard-backup`).catch(() => {}); // only exists when the file did
  await writeFile(`${p.file}.tmp`, JSON.stringify(p.settings, null, 2) + "\n"); await rename(`${p.file}.tmp`, p.file);
  console.log(`${uninstall ? "Removed from" : "Installed in"} ${p.file}  (backup: ${p.file}.dashboard-backup)`);
}
console.log(uninstall ? "Done." : "Done. Sessions started from now on report live status; restart running sessions to pick it up.");
