# OpenSSH.ca — SSH From Anywhere

> SSH into any machine from your phone or browser — no port forwarding, no VPN.

[![Website](https://img.shields.io/badge/Website-openssh.ca-000?style=for-the-badge)](https://openssh.ca)
[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/openssh)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

---

## What is this?

OpenSSH.ca lets you control any machine from anywhere — phone, tablet, or browser. Your PC connects *outward* to a relay server, and you connect through it. **No port forwarding, no VPN, no firewall rules.**

```
📱 Phone / 🌐 Browser ──────────┐
                                 ▼
                        ☁️  Relay Server
                                 ▲
🖥️  Your PC (behind any firewall) ─┘
         (connects outward — no ports to open)
```

### Use it from:
- **📱 Mobile app** — Android APK (iOS coming soon)
- **🌐 Web terminal** — `openssh.ca/dashboard.html` — no install needed
- **🖥️ Self-hosted** — run your own relay for free

---

## Quick Start

### 1. Create an account

Visit [openssh.ca/dashboard.html](https://openssh.ca/dashboard.html) or use the mobile app.
Register with your email and password.

### 2. Install the host daemon on your PC

```bash
curl -fsSL https://raw.githubusercontent.com/AmritRai1234/Openssh/main/install.sh | bash -s -- --relay relay.openssh.ca:2222
```

### 3. SSH from anywhere

Open the dashboard or mobile app → your PC appears → tap to connect. Full terminal, file browser — done.

---

## Architecture

| Component | Stack | Description |
|-----------|-------|-------------|
| **Relay** | Rust (Axum, Russh, Tokio) | Multi-tenant relay server — bridges phone/browser ↔ PC |
| **Host daemon** | Rust | Runs on your PC, connects outward to relay via SSH |
| **Web dashboard** | HTML/JS, xterm.js | Browser-based terminal at openssh.ca/dashboard.html |
| **Mobile app** | React Native (Expo) | Android/iOS SSH terminal |
| **Landing page** | HTML/CSS | Marketing site at openssh.ca |

---

## Self-Hosting

The entire project is open source. Run your own relay for free.

### Docker (recommended)

```bash
git clone https://github.com/AmritRai1234/Openssh.git
cd Openssh
docker compose up -d
```

This starts the relay on:
- **Port 8080** — HTTP API + website
- **Port 2222** — SSH relay (host daemons connect here)

### From source

```bash
# Build
cargo build --release -p relay

# Run
cargo run -p relay -- \
  --bind 0.0.0.0:2222 \
  --api-bind 0.0.0.0:8080 \
  --host-key ./host.key
```

### Host daemon (on your PC)

```bash
cargo build --release -p host
cargo run -p host -- my-laptop --relay YOUR_RELAY_IP:2222
```

---

## Project Structure

```
openssh/
├── relay/          # Rust relay server + SQLite user DB
│   └── src/
│       ├── main.rs     # API, SSH, WebSocket, static files
│       └── db.rs       # Users, tokens, host key pinning
├── host/           # Rust host daemon
├── app/            # React Native mobile app (Expo)
│   └── src/
│       ├── screens/    # Auth, Dashboard, Terminal, Files
│       └── api/        # Relay API client
├── website/        # Landing page + web terminal dashboard
│   ├── index.html
│   ├── dashboard.html  # xterm.js web terminal
│   └── style.css
├── Dockerfile      # Multi-stage Rust build
└── docker-compose.yml
```

---

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/register` | POST | — | Create account (email, password, name) |
| `/api/login` | POST | — | Login → returns API token |
| `/api/account` | GET | Token | Get account info |
| `/api/hosts` | GET | Token | List your connected machines |
| `/api/terminal/:id` | WS | Token | Open terminal to a host |
| `/api/events` | WS | Token | Real-time host connect/disconnect |
| `/` | GET | — | Landing page |
| `/dashboard.html` | GET | — | Web terminal |

---

## Pricing

- **Self-host**: Free forever — clone, run, own your data
- **Hosted relay** ([openssh.ca](https://openssh.ca)): Pay what you want via [Ko-fi](https://ko-fi.com/openssh)

---

## Relay CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--bind` | `0.0.0.0:2222` | SSH listen address (host daemons connect here) |
| `--api-bind` | `0.0.0.0:8080` | HTTP API + website |
| `--host-key` | required | Path to SSH host key (auto-generated if missing) |
| `--public-url` | auto | Public URL for the relay |

---

## Tech Stack

- **Rust** — relay server, host daemon (Axum, Russh, Tokio, SQLite)
- **React Native** — mobile app (Expo, TypeScript)
- **xterm.js** — web terminal
- **WebSocket** — real-time terminal + events
- **bcrypt + SHA-256** — password hashing + token auth
- **TOFU** — SSH host key pinning

---

## Support the Project ☕

If you use the hosted relay and find it useful, consider supporting the project:

**[☕ Support on Ko-fi](https://ko-fi.com/openssh)**

---

## License

MIT
