#!/bin/sh
# Installs the systemd user service for this checkout (Linux).
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }
mkdir -p "$HOME/.config/systemd/user"
sed -e "s|@DIR@|$DIR|g" -e "s|@NODE@|$NODE|g" "$DIR/project-dashboard.service.example" > "$HOME/.config/systemd/user/project-dashboard.service"
systemctl --user daemon-reload
systemctl --user enable --now project-dashboard
echo "Running at http://127.0.0.1:4777"
