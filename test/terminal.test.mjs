import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellQuote, macCommand, osascriptArgs } from "../lib/terminal.mjs";

const run = (command, cwd) => spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", env: { ...process.env, TERM: "dumb" } });

test("shellQuote keeps hostile text as plain text", () => {
  for (const s of ["plain", "with space", "it's", 'say "hi"', "$(touch pwned)", "`touch pwned`", "a;b&c|d", "back\\slash", "new\nline", "", "ünïcode ✓"]) {
    const r = run(`printf %s ${shellQuote(s)}`); assert.equal(r.stdout, s, JSON.stringify(s));
  }
});

test("macCommand runs the script in the folder with the same arguments as the Linux terminals get", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "term-"));
  for (const name of ["plain", "with space", "it's here", "$(touch pwned)", 'q"uote', "semi;colon"]) {
    const cwd = path.join(base, name); await mkdir(cwd);
    const args = ["/Users/x y/.claude-work", "sess-ion'id", "$(touch pwned)", 'p"rofile'];
    const script = 'printf "%s\\0" "$(pwd -P)" "$@"'; // prints the real folder it runs in, then every argument
    const r = run(macCommand(cwd, script, args), base);
    assert.equal(r.status, 0, r.stderr);
    const got = r.stdout.split("\0").slice(0, -1);
    assert.equal(got[0], await (await import("node:fs/promises")).realpath(cwd), "runs in the project folder");
    assert.deepEqual(got.slice(1), [cwd, ...args], `arguments arrive unchanged for ${name}`); // $1 is the folder, then the rest
  }
  await assert.rejects(access(path.join(base, "pwned")), "no injected command ran");
  await assert.rejects(access(path.join(process.cwd(), "pwned")));
});

test("osascript gets the command as one argument, never inside AppleScript source", () => {
  const cmd = `clear; cd 'a "b"' && exec sh -c 'x' sh`;
  const a = osascriptArgs(cmd);
  assert.equal(a.at(-1), cmd); assert.equal(a.filter((x) => x === cmd).length, 1);
  assert.ok(a.slice(0, -1).every((x) => x === "-e" || !x.includes(cmd)));
  assert.ok(a.includes('tell application "Terminal"') && a.includes("do script (item 1 of argv)"));
});
