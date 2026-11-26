# FAQ

## Installing and updating

### How do I install it as a service?

Run `./install-service.sh` in the folder you cloned into. It detects your OS:

| OS | What it installs |
|---|---|
| macOS | A launchd agent. The log is `~/Library/Logs/claude-forge.log`. |
| Linux | A systemd user service. |
| Windows | Nothing. See "Does it run on Windows?" below. |

The script shows the command for each optional helper and installs it only after you answer `y`. Add `-y` to accept without a prompt.

### How do I update?

Run `./update.sh`. It fetches the latest commits, shows what is new, fast-forwards your checkout and restarts the service. It never discards your work. If you have local commits or edits that block the update, it stops and tells you what to do.

If your copy is older than the update notice and has no `update.sh`, run `git pull` once and run `./install-service.sh` again. After that, `./update.sh` works.

### How do I know a new version exists?

Once a day the server asks GitHub whether `main` has commits you do not have. If it does, a banner appears at the top of the page with the list of changes and a **Dismiss** button. A new commit can take up to a day to show. Restart the service to check at once.

The check follows commits on `main`. The project does not publish numbered releases.

### What does the update check send?

One anonymous request to `api.github.com`. It contains the commit id of your checkout and a generic user agent (`claude-forge-update-check`). Nothing else. To turn it off, set `"updateCheck": false` in `config.json`. It does nothing when the folder is not a git checkout.

### I updated, but I see no banner. Is that a problem?

No. The banner shows only when `main` is ahead of your checkout. If you are up to date, nothing shows. You can also see the raw answer at `http://127.0.0.1:4777/api/update`.

## Notifications

### Why does clicking a notification open Script Editor on macOS?

macOS attributes notifications sent with `osascript` to Script Editor. A click on one opens that app, and `osascript` cannot change this.

Install `terminal-notifier`:

```sh
brew install terminal-notifier
```

Claude Forge then uses it automatically, and a click opens the dashboard. Without it, Claude Forge falls back to `osascript`. `./install-service.sh` offers to install it for you.

### I also get "Claude Code needs your attention" and it opens Script Editor. Is that Claude Forge?

No. That is a `Notification` hook in your own Claude Code settings (`~/.claude/settings.json`) that calls `osascript`. Change the hook command to use `terminal-notifier`, for example:

```sh
terminal-notifier -title "Claude Code" -message "Claude Code needs your attention" -activate com.apple.Terminal
```

Replace `com.apple.Terminal` with the bundle id of your terminal app. A click then brings that app to the front. It cannot focus one specific tab or window.

### I get no desktop notifications on Linux.

Claude Forge uses `notify-send`. Install it with your package manager (`libnotify-bin` on Debian and Ubuntu, `libnotify` on Fedora and Arch). `./install-service.sh` offers this. On WSL there is no desktop to notify.

### Can I connect a nearby phone with Bluetooth or NFC?

No. Node.js has no built-in Bluetooth, a Mac cannot send NFC, and a phone browser cannot receive alerts over either. Use a QR code instead: set a host and token (see "Reaching it from other devices" in the README), open **Notifications**, and press **Show QR code**. The phone camera opens a one-time link that logs the phone in over your Wi-Fi. No account and no outside service are involved. For alerts when the page is closed, use the ntfy phone alerts, which can use your own ntfy server (`"ntfy": { "server": "http://..." }` in `config.json`).

### How do I turn notifications off?

Set `"desktop": false` inside `"notify"` in `config.json` for the desktop popup, or `"notify": false` for everything. See the Notifications section of the README.

## Errors

### An error message disappears too fast. How do I copy it?

Errors now stay on screen until you close them. Select the text, or press **Copy** to put the whole message on the clipboard. Short confirmations such as "Saved" still fade out. Paste the error text into your bug report.

## Claude Code settings

### Can this project's settings override my own Claude Code settings?

For most settings, yes. Claude Code reads several files. When two files set the same single value, the one higher in this list wins:

1. Managed settings from your organization, if you have any
2. Command-line flags
3. `.claude/settings.local.json` in the project (personal, not shared)
4. `.claude/settings.json` in the project (shared with everyone)
5. `~/.claude/settings.json` (yours, for all projects)

Lists do not override each other. Permission lists such as `allow` and `deny` are merged. Hooks from every level are collected, and all matching hooks run. A project cannot replace or remove a hook from your `~/.claude/settings.json`. If you add a second notification hook in a project, you get both notifications.

### Where should I put my own preferences for this project?

Put them in `.claude/settings.local.json`. It overrides your global single-value settings and stays on your machine. Check that git ignores it before you commit anything (`git status` must not list it).

Do not put personal preferences in `.claude/settings.json`. That file is committed, so it applies to every contributor who opens the project in Claude Code.

## Platforms

### Does it run on Windows?

Not natively. Claude Forge starts its runs through `sh` and needs POSIX process handling. Use WSL: install it with `wsl --install`, clone the repository inside it, and run `./install-service.sh` there. The service needs systemd, which you enable in WSL by adding `[boot]` and `systemd=true` to `/etc/wsl.conf` and then running `wsl --shutdown` from Windows. Without systemd, start it by hand with `node server.mjs`.

### Why do three tests fail on my Mac?

Three tests in `test/reply.test.mjs` read `/proc`, which exists only on Linux. They pass on Linux and in CI. Other tests are not affected.

### My GitHub items (reviews, pull requests) are empty.

Claude Forge reads GitHub through the `gh` command. Install the GitHub CLI and sign in:

```sh
brew install gh      # or your package manager
gh auth login
```

## Running it

### How do I stop or restart the service?

| OS | Stop | Restart |
|---|---|---|
| macOS | `launchctl bootout gui/$(id -u)/com.claude-forge` | `launchctl kickstart -k gui/$(id -u)/com.claude-forge` |
| Linux | `systemctl --user disable --now claude-forge` | `systemctl --user restart claude-forge` |

Runs are detached from the service, so a restart does not stop a run that is in progress.

### Can other people on my network open it?

Not by default. It listens on `127.0.0.1` only. See "Reaching it from other devices" in the README before you change this. It needs a token, and anyone with the token can read your session snippets and start Claude runs on your machine.

## Contributing

### Why can I not push to `main`?

`main` is protected. Fork the repository, make your change on a branch, and open a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).
