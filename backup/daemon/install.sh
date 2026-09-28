#!/usr/bin/env bash
# =============================================================================
# DevAccel Local Daemon — macOS / Linux installer
# =============================================================================
# Installs the daemon binary to ~/.devaccel (alongside its state files),
# registers it to auto-start at login (systemd --user on Linux, launchd
# LaunchAgent on macOS), and starts it. No sudo required.
#
# Usage (after downloading the binary next to this script):
#   chmod +x install.sh && ./install.sh
# =============================================================================
set -euo pipefail

BIN_DIR="$HOME/.devaccel"
TARGET="$BIN_DIR/devaccel"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

os="$(uname -s)"
case "$os" in
  Linux)  SRC="$SCRIPT_DIR/devaccel-daemon-linux" ;;
  Darwin) SRC="$SCRIPT_DIR/devaccel-daemon-macos" ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

if [ ! -f "$SRC" ]; then
  echo "ERROR: $(basename "$SRC") not found next to this script. Download it first." >&2
  exit 1
fi

echo ">> Installing daemon to $TARGET"
mkdir -p "$BIN_DIR"
# Migrate a pre-0.3.0 install (~/.local/bin is shared — remove only our file).
rm -f "$HOME/.local/bin/devaccel"
cp -f "$SRC" "$TARGET"
chmod +x "$TARGET"

if [ "$os" = "Linux" ]; then
  # systemd --user service → auto-start at login, restart on crash.
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/devaccel-daemon.service" <<EOF
[Unit]
Description=DevAccel Local Daemon
After=network.target

[Service]
ExecStart=$TARGET serve
Restart=on-failure

[Install]
WantedBy=default.target
EOF
  echo ">> Enabling + starting systemd --user service"
  systemctl --user daemon-reload
  systemctl --user enable --now devaccel-daemon.service
  echo "   (If auto-start after reboot is needed while logged out: 'sudo loginctl enable-linger $USER')"
else
  # macOS launchd LaunchAgent → auto-start at login, keep alive.
  PLIST="$HOME/Library/LaunchAgents/com.devaccel.daemon.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.devaccel.daemon</string>
  <key>ProgramArguments</key>
  <array><string>$TARGET</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
  echo ">> Loading launchd agent"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
fi

sleep 2
echo ""
echo "DevAccel daemon installed and started."
echo "It will start automatically each time you log in."
echo "Verify: curl http://127.0.0.1:17872/health"
