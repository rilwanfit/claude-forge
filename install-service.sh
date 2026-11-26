#!/bin/sh
# Installs a user service for this checkout. Detects the OS:
#   macOS  -> launchd agent
#   Linux  -> systemd user service (also WSL, when systemd is enabled there)
#   Windows (Git Bash / MSYS / Cygwin) -> not supported natively: the server needs `sh` and POSIX
#   process handling, so run this script from inside WSL instead.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)

install_launchd() {
  AGENTS="$HOME/Library/LaunchAgents"
  PLIST="$AGENTS/com.claude-forge.plist"
  TARGET="gui/$(id -u)"
  mkdir -p "$AGENTS" "$HOME/Library/Logs"
  # Reload cleanly if it is already installed.
  launchctl bootout "$TARGET/com.claude-forge" 2>/dev/null || true
  sed -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" -e "s|@NODEDIR@|$(dirname "$NODE")|g" -e "s|@HOME@|$HOME|g" \
    "$DIR/claude-forge.plist.example" > "$PLIST"
  launchctl bootstrap "$TARGET" "$PLIST"
  launchctl kickstart -k "$TARGET/com.claude-forge"
  echo "Running at http://127.0.0.1:4777 (log: ~/Library/Logs/claude-forge.log)"
  echo "Stop it with: launchctl bootout $TARGET/com.claude-forge"
}

install_systemd() {
  if ! command -v systemctl >/dev/null 2>&1 || ! [ -d /run/systemd/system ]; then
    echo "systemd is not running on this machine, so there is no service to install." >&2
    if grep -qi microsoft /proc/version 2>/dev/null; then
      echo "This is WSL. Enable systemd: add the lines '[boot]' and 'systemd=true' to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and try again." >&2
    fi
    echo "You can still start it by hand with: node $DIR/server.mjs" >&2
    exit 1
  fi
  UNITS="$HOME/.config/systemd/user"
  mkdir -p "$UNITS"
  # This project used to be called project-dashboard, then nudge: stop and remove an old service so two copies never fight for the port.
  for old in project-dashboard nudge; do
    if [ -f "$UNITS/$old.service" ]; then
      systemctl --user disable --now "$old" 2>/dev/null || true
      rm -f "$UNITS/$old.service"
    fi
  done
  sed -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" "$DIR/claude-forge.service.example" > "$UNITS/claude-forge.service"
  systemctl --user daemon-reload
  systemctl --user enable --now claude-forge
  echo "Running at http://127.0.0.1:4777"
  echo "Stop it with: systemctl --user disable --now claude-forge"
}

OS=$(uname -s)
case "$OS" in
  MINGW*|MSYS*|CYGWIN*)
    echo "Native Windows is not supported: Claude Forge starts its runs through 'sh' and needs POSIX process handling." >&2
    echo "Install WSL (wsl --install), clone this repo inside it, and run ./install-service.sh there." >&2
    exit 1 ;;
  Darwin|Linux) ;;
  *) echo "Unsupported OS: $OS. Start it by hand with: node $DIR/server.mjs" >&2; exit 1 ;;
esac

NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
echo "Detected $OS"
case "$OS" in
  Darwin) install_launchd ;;
  Linux) install_systemd ;;
esac
