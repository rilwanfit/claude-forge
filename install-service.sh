#!/bin/sh
# Installs a user service for this checkout. Detects the OS:
#   macOS  -> launchd agent
#   Linux  -> systemd user service (also WSL, when systemd is enabled there)
#   Windows (Git Bash / MSYS / Cygwin) -> not supported natively: the server needs `sh` and POSIX
#   process handling, so run this script from inside WSL instead.
#
# Usage: ./install-service.sh [-y]
#   -y  answer yes to the question about installing the notification helper
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
YES=0
case "${1:-}" in -y|--yes) YES=1 ;; esac

# Asks a yes/no question. Without a terminal to ask on, the answer is no (and nothing is installed).
confirm() {
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf "%s [y/N] " "$1"
  read -r answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# Desktop notifications. On macOS a click on an osascript notification opens Script Editor, so Claude Forge uses
# terminal-notifier when it is installed (a click opens the dashboard). On Linux it needs notify-send.
# Nothing is installed without your yes, and the exact command is shown first.
offer_notifier() {
  case "$OS" in
    Darwin)
      command -v terminal-notifier >/dev/null 2>&1 && return 0
      echo "Optional: terminal-notifier makes a click on a notification open the dashboard (without it, a click opens Script Editor)."
      if command -v brew >/dev/null 2>&1; then
        echo "  Command: brew install terminal-notifier"
        if confirm "Install it now?"; then brew install terminal-notifier || echo "Install failed. Notifications still work through osascript."
        else echo "Skipped. Install later with: brew install terminal-notifier"; fi
      else
        echo "  Install Homebrew (https://brew.sh), then run: brew install terminal-notifier"
      fi ;;
    Linux)
      command -v notify-send >/dev/null 2>&1 && return 0
      grep -qi microsoft /proc/version 2>/dev/null && return 0 # WSL has no desktop to notify
      SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo "
      if command -v apt-get >/dev/null 2>&1; then CMD="${SUDO}apt-get install -y libnotify-bin"
      elif command -v dnf >/dev/null 2>&1; then CMD="${SUDO}dnf install -y libnotify"
      elif command -v pacman >/dev/null 2>&1; then CMD="${SUDO}pacman -S --noconfirm libnotify"
      elif command -v zypper >/dev/null 2>&1; then CMD="${SUDO}zypper install -y libnotify-tools"
      else echo "Optional: install notify-send (libnotify) with your package manager to get desktop notifications."; return 0
      fi
      echo "Optional: notify-send is needed for desktop notifications."
      echo "  Command: $CMD"
      if confirm "Install it now?"; then $CMD || echo "Install failed. Everything else still works."
      else echo "Skipped. Install later with: $CMD"; fi ;;
  esac
}

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
command -v claude >/dev/null 2>&1 || echo "Note: 'claude' is not on your PATH. Claude Forge needs the Claude Code CLI to start runs."
command -v gh >/dev/null 2>&1 || echo "Note: 'gh' (GitHub CLI) is not on your PATH. GitHub items stay empty until you install it and run 'gh auth login'."
offer_notifier
case "$OS" in
  Darwin) install_launchd ;;
  Linux) install_systemd ;;
esac
