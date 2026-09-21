#!/usr/bin/env bash
# installs a systemd user unit for antigravity-proxy and starts it.
# usage: ./scripts/install-systemd.sh
set -euo pipefail

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd not found — run manually: node src/cli.js" >&2
  exit 1
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/antigravity-proxy.service"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$UNIT_DIR"

cat > "$UNIT" <<EOF
[Unit]
Description=antigravity-proxy: OpenAI-compatible relay over Google AI Pro OAuth
After=network-online.target

[Service]
ExecStart=$(command -v node) $REPO_DIR/src/cli.js
WorkingDirectory=$REPO_DIR
Restart=on-failure
RestartSec=3
# no proxy env — the relay talks to google directly; per-account egress belongs upstream
Environment=NO_PROXY=*
Environment=ANTIGRAVITY_PROXY_LOG_LEVEL=info

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now antigravity-proxy.service
sleep 1
systemctl --user is-active antigravity-proxy.service
echo "listening on http://127.0.0.1:8317 — check: curl -sS http://127.0.0.1:8317/health"
