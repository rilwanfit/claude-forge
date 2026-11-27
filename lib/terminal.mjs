// macOS: open Terminal.app and run a command in it. Terminal has no "run this" command-line option,
// so Claude Forge asks it through AppleScript. The command travels as an argument to osascript, so it needs no
// AppleScript quoting, only shell quoting: a folder name with spaces, quotes or $( ) must reach the shell as plain text.

/** Quote a string for sh: wrap in single quotes, and turn each ' into '\'' . */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The command line Terminal runs: the same as launching `sh -c script sh cwd ...args` in cwd, with a clean screen first. */
export const macCommand = (cwd, script, args = []) => `clear; cd ${shellQuote(cwd)} && exec sh -c ${shellQuote(script)} sh ${[cwd, ...args].map(shellQuote).join(" ")}`;

/** Arguments for osascript: open a Terminal window running the command, and bring Terminal to the front. */
export const osascriptArgs = (command) => ["-e", "on run argv", "-e", 'tell application "Terminal"', "-e", "activate", "-e", "do script (item 1 of argv)", "-e", "end tell", "-e", "end run", command];
