#!/bin/sh
# Updates this checkout to the latest commit on its upstream branch, then restarts the service if one is installed.
# It never discards your changes: if the update cannot apply cleanly, it stops and says why.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"

git rev-parse --git-dir >/dev/null 2>&1 || { echo "This folder is not a git checkout, so it cannot update itself. Download the latest version again." >&2; exit 1; }
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || { echo "This branch has no upstream. Run: git branch --set-upstream-to=origin/main" >&2; exit 1; }

echo "Checking for updates..."
git fetch --quiet
BEHIND=$(git rev-list --count 'HEAD..@{u}')
if [ "$BEHIND" -eq 0 ]; then
  echo "Already up to date ($(git rev-parse --short HEAD))."
  exit 0
fi

echo "$BEHIND new commit(s):"
git log --format='  %h %s' 'HEAD..@{u}' | head -20

if ! git pull --ff-only --quiet; then
  echo "" >&2
  echo "The update could not be applied cleanly. You have local changes or local commits." >&2
  echo "Commit or stash your changes, then run: git pull --rebase" >&2
  exit 1
fi
echo "Updated to $(git rev-parse --short HEAD)."

case "$(uname -s)" in
  Darwin)
    if [ -f "$HOME/Library/LaunchAgents/com.claude-forge.plist" ]; then
      launchctl kickstart -k "gui/$(id -u)/com.claude-forge" && echo "Restarted the service."
    else
      echo "No service is installed. If the server is running, stop it and start it again."
    fi ;;
  Linux)
    if [ -f "$HOME/.config/systemd/user/claude-forge.service" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl --user restart claude-forge && echo "Restarted the service."
    else
      echo "No service is installed. If the server is running, stop it and start it again."
    fi ;;
  *) echo "Restart the server to use the new version." ;;
esac
