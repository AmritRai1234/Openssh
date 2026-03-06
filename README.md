# OpenSSH — Mobile SSH Terminal

> SSH into any machine from your phone — no port forwarding, no VPN needed.

[![Ko-fi](https://img.shields.io/badge/Support%20on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/YOUR_NAME)

---

## What is this?

OpenSSH is a mobile terminal app (Android/iOS) that lets you run commands on your home PC or server from your phone, even when you're on a completely different network.

Most SSH apps require you to open a port on your router or set up a VPN. **OpenSSH doesn't.** Instead, your machine connects *outward* to a relay server — your phone then connects through the relay from anywhere.

```
📱 Phone (any network)  ──────────┐
                                  ▼
                         ☁️  Relay Server  (VPS)
                                  ▲
🖥️  Home PC (behind router) ──────┘
       (no port forwarding needed)
```

---

## Architecture

The project has three components:

| Crate | What it does |
|---|---|
| `relay` | Cloud relay server — hosts connect to it, phones communicate through it |
| `host` | Daemon that runs on your PC, connects outward to the relay |
| `app` | React Native mobile app (Expo) |

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (for building relay + host)
- [Node.js](https://nodejs.org/) + [Expo Go](https://expo.dev/go) (for the mobile app)
- A Linux/macOS machine to SSH into
- *(Optional but recommended)* A VPS for the relay so it works over the internet

---

## 1. Build the Relay

The relay is the bridge between your phone and your PC.

```bash
# Clone the repo
git clone https://github.com/AmritRai1234/Openssh.git
cd Openssh

# Build in release mode
cargo build --release -p relay
```

### Run locally (same network only)

```bash
cargo run -p relay -- \
  --bind 0.0.0.0:2222 \
  --api-bind 0.0.0.0:8080 \
  --host-key ./host.key
```

On startup the relay prints a **QR code** containing the API URL and token — you'll scan this with the app.

### Run on a VPS (works from anywhere)

```bash
# On your VPS (e.g. DigitalOcean, Linode — $5/mo)
./relay \
  --bind 0.0.0.0:2222 \
  --api-bind 0.0.0.0:8080 \
  --host-key ./host.key \
  --public-url http://<YOUR_VPS_IP>:8080
```

> **Firewall:** Open ports `2222` (SSH/host connections) and `8080` (API/phone connections) on your VPS.

---

## 2. Start the Host Daemon

The host daemon runs on the machine you want to SSH into. It connects *outward* to the relay — no inbound firewall rules needed.

```bash
# Build
cargo build --release -p host

# Run (replace relay address with your relay's address)
cargo run -p host -- my-laptop --relay 127.0.0.1:2222
```

- `my-laptop` — the name that appears in the app
- `--relay` — address of the relay server

The host daemon automatically reconnects if the relay restarts.

---

## 3. Set Up the Mobile App

### Install dependencies

```bash
cd app
npm install
```

### Run with Expo Go

```bash
npx expo start
```

Scan the QR code with **Expo Go** on your Android phone.

### Connect to your relay

When the app opens:

1. Tap **Scan Relay QR Code**
2. Point the camera at the QR code printed by the relay on startup
3. The app auto-fills the relay URL and API token
4. Tap **Connect & Save**

> **Alternative:** Enter the relay URL and API token manually if QR scanning isn't available.

Once connected, your machine appears in the dashboard. Tap it to open a terminal.

---

## Using the Terminal

- The **command bar** is at the top — type your command and press ↵ to run
- Output appears below, newest at the top
- Scroll down to read older output — the app won't interrupt you while reading history
- The connection **auto-reconnects** if the network drops temporarily
- Tap **‹** to go back to the dashboard

---

## Building a Standalone APK

To use the app without Expo Go, build a standalone APK:

```bash
cd app

# Install EAS CLI
npm install -g eas-cli

# Log in to Expo
eas login

# Configure
eas build:configure

# Build APK for Android
eas build --platform android --profile preview
```

---

## Project Structure

```
openssh/
├── relay/          # Rust relay server
│   └── src/
│       └── main.rs
├── host/           # Rust host daemon
│   └── src/
│       └── main.rs
└── app/            # React Native mobile app (Expo)
    ├── App.tsx
    └── src/
        ├── screens/
        │   ├── DashboardScreen.tsx
        │   ├── TerminalScreen.tsx
        │   ├── HostDetailScreen.tsx
        │   └── SetupScreen.tsx
        ├── hooks/
        │   └── useRelaySocket.ts
        └── api/
            └── relay.ts
```

---

## Configuration

### Relay CLI flags

| Flag | Default | Description |
|---|---|---|
| `--bind` | `0.0.0.0:2222` | Address for host daemon SSH connections |
| `--api-bind` | `0.0.0.0:8080` | Address for phone API + WebSocket |
| `--host-key` | required | Path to SSH host key (auto-generated if missing) |
| `--public-url` | auto | Public URL encoded in the setup QR code |
| `--token-file` | — | Read API token from file instead of generating |

### Host daemon CLI flags

| Flag | Description |
|---|---|
| `<name>` | Name shown in the app (e.g. `my-laptop`) |
| `--relay` | Relay address (e.g. `1.2.3.4:2222`) |

---

## Roadmap

- [ ] PTY resize (so `vim`, `htop` work correctly on mobile)
- [ ] ANSI colour support in terminal output
- [ ] File browser UI for file transfers
- [ ] Standalone APK / iOS build guide
- [ ] Per-host SSH key pinning

---

## Support the Project ☕

The relay server costs ~$5/month to run on a VPS. If you find OpenSSH useful and want to help keep it online, a coffee goes a long way.

**[☕ Buy me a coffee on Ko-fi](https://ko-fi.com/YOUR_NAME)**

> Replace `YOUR_NAME` with your Ko-fi username, and update the badge at the top of this file too.

---

## Tech Stack

- **Relay & Host** — Rust (`axum`, `russh`, `tokio`, `clap`)
- **Mobile App** — React Native + Expo (TypeScript)
- **Protocol** — WebSocket over HTTP API, SSH over TCP

---

## License

MIT
