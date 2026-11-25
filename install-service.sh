#!/bin/sh
# Installs the systemd user service for this checkout (Linux).
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
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
