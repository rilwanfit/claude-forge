#!/bin/sh
# Installs the systemd user service for this checkout (Linux).
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"
# This project used to be called project-dashboard: stop and remove the old service so two copies never fight for the port.
if [ -f "$UNITS/project-dashboard.service" ]; then
  systemctl --user disable --now project-dashboard 2>/dev/null || true
  rm -f "$UNITS/project-dashboard.service"
fi
sed -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" "$DIR/nudge.service.example" > "$UNITS/nudge.service"
systemctl --user daemon-reload
systemctl --user enable --now nudge
echo "Running at http://127.0.0.1:4777"
