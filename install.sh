#!/usr/bin/env bash
# OpenSSH Host Daemon Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AmritRai1234/Openssh/main/install.sh | bash -s -- --relay <relay-address> --name <machine-name>
# Example: curl -fsSL .../install.sh | bash -s -- --relay relay.example.com:2222 --name my-server
set -euo pipefail

REPO="AmritRai1234/Openssh"
INSTALL_DIR="/usr/local/bin"
SERVICE_NAME="openssh-host"

# ── Parse args ─────────────────────────────────────────────────────
RELAY=""
NAME="$(hostname)"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --relay) RELAY="$2"; shift 2 ;;
        --name)  NAME="$2";  shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

if [[ -z "$RELAY" ]]; then
    echo "Usage: install.sh --relay <host:port> [--name <machine-name>]"
    exit 1
fi

# ── Detect platform ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux)
        case "$ARCH" in
            x86_64)  ASSET="openssh-host-linux-x64" ;;
            aarch64) ASSET="openssh-host-linux-arm64" ;;
            *) echo "Unsupported arch: $ARCH"; exit 1 ;;
        esac ;;
    Darwin)
        case "$ARCH" in
            x86_64)  ASSET="openssh-host-macos-x64" ;;
            arm64)   ASSET="openssh-host-macos-arm64" ;;
            *) echo "Unsupported arch: $ARCH"; exit 1 ;;
        esac ;;
    *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

# ── Download latest binary ─────────────────────────────────────────
echo "→ Detecting latest release..."
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": "\(.*\)".*/\1/')
echo "→ Downloading $ASSET ($LATEST)..."
curl -fsSL "https://github.com/${REPO}/releases/download/${LATEST}/${ASSET}" -o "/tmp/openssh-host"
chmod +x /tmp/openssh-host
mv /tmp/openssh-host "$INSTALL_DIR/openssh-host"
echo "→ Installed to $INSTALL_DIR/openssh-host"

# ── Install as a system service ────────────────────────────────────
if [[ "$OS" == "Linux" ]] && command -v systemctl &>/dev/null; then
    echo "→ Installing systemd service..."
    cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=OpenSSH Host Daemon
After=network.target
Wants=network-online.target

[Service]
ExecStart=$INSTALL_DIR/openssh-host $NAME --relay $RELAY
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
    echo ""
    echo "✅ OpenSSH host daemon installed and started!"
    echo "   Machine name : $NAME"
    echo "   Relay        : $RELAY"
    echo ""
    echo "   Check status : systemctl status $SERVICE_NAME"
    echo "   View logs    : journalctl -u $SERVICE_NAME -f"

elif [[ "$OS" == "Darwin" ]]; then
    echo "→ Installing LaunchAgent (macOS)..."
    PLIST="$HOME/Library/LaunchAgents/com.openssh.host.plist"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.openssh.host</string>
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/openssh-host</string>
        <string>$NAME</string>
        <string>--relay</string>
        <string>$RELAY</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/openssh-host.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/openssh-host.log</string>
</dict>
</plist>
EOF
    launchctl load "$PLIST"
    echo ""
    echo "✅ OpenSSH host daemon installed and started!"
    echo "   Machine name : $NAME"
    echo "   Relay        : $RELAY"
    echo ""
    echo "   View logs    : tail -f /tmp/openssh-host.log"
else
    echo ""
    echo "✅ Binary installed to $INSTALL_DIR/openssh-host"
    echo "   Run manually: openssh-host $NAME --relay $RELAY"
fi
