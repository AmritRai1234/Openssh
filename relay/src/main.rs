use anyhow::Result;
use async_trait::async_trait;
use axum::{
    extract::{Path, Query, State},
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use clap::Parser;
use log::{error, info, warn};
use russh::server::{Auth, Session, Server as _};
use russh_keys::key::{KeyPair, PublicKey};
use russh_keys::PublicKeyBase64;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─────────────────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────────────────
#[derive(Parser, Debug)]
#[command(about = "RustSSH Relay Server")]
struct Cli {
    #[arg(long, default_value = "0.0.0.0:2222")]
    bind: String,
    #[arg(long, default_value = "0.0.0.0:8080")]
    api_bind: String,
    #[arg(long, default_value = "/etc/russh-relay/host_key")]
    host_key: String,
    /// Derive relay addr from ssh bind (replace 0.0.0.0 with 127.0.0.1 for display)
    #[arg(long, default_value = "")]
    api_token: String,
    #[arg(long, default_value_t = 10)]
    rate_limit: u32,
    /// Public-facing API URL encoded in the setup QR (e.g. http://192.168.1.5:8080).
    /// Defaults to the api_bind with 0.0.0.0 replaced by 127.0.0.1.
    #[arg(long, default_value = "")]
    public_url: String,
}

// ─────────────────────────────────────────────────────────
//  Shared state
// ─────────────────────────────────────────────────────────
#[derive(Clone, Debug, Serialize)]
pub struct HostInfo {
    pub id: String,
    pub connected_at: u64, // unix secs
    pub relay_addr: String,
}

/// Live SSH handles for forwarding
type HostHandles = Arc<Mutex<HashMap<String, russh::server::Handle>>>;
/// Metadata for the HTTP API
type HostRegistry = Arc<Mutex<HashMap<String, HostInfo>>>;
/// Key pinning
type KeyRegistry = Arc<Mutex<HashMap<String, String>>>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event")]
pub enum RelayEvent {
    #[serde(rename = "connected")]
    Connected { id: String },
    #[serde(rename = "disconnected")]
    Disconnected { id: String },
}

/// All state shared between SSH server, axum, and WebSocket broadcaster
#[derive(Clone)]
struct AppState {
    host_handles: HostHandles,
    host_registry: HostRegistry,
    key_registry: KeyRegistry,
    events_tx: broadcast::Sender<String>,
    api_token: String,
    relay_addr: String,
}

// ─────────────────────────────────────────────────────────
//  Rate limiter
// ─────────────────────────────────────────────────────────
struct RateLimiter {
    map: Mutex<HashMap<SocketAddr, (u32, Instant)>>,
    max_per_minute: u32,
}
impl RateLimiter {
    fn new(max: u32) -> Arc<Self> {
        Arc::new(Self { map: Mutex::new(HashMap::new()), max_per_minute: max })
    }
    async fn is_allowed(&self, addr: Option<SocketAddr>) -> bool {
        if self.max_per_minute == 0 { return true; }
        let addr = match addr { Some(a) => a, None => return true };
        let mut map = self.map.lock().await;
        let now = Instant::now();
        let entry = map.entry(addr).or_insert((0, now));
        if now.duration_since(entry.1) >= Duration::from_secs(60) { *entry = (0, now); }
        if entry.0 >= self.max_per_minute { return false; }
        entry.0 += 1;
        true
    }
}

// ─────────────────────────────────────────────────────────
//  SSH Server
// ─────────────────────────────────────────────────────────
#[derive(Clone)]
struct SshServer {
    state: AppState,
    rate_limiter: Arc<RateLimiter>,
}

impl russh::server::Server for SshServer {
    type Handler = SessionHandler;
    fn new_client(&mut self, peer_addr: Option<SocketAddr>) -> Self::Handler {
        SessionHandler {
            state: self.state.clone(),
            rate_limiter: self.rate_limiter.clone(),
            peer_addr,
            id: None,
            is_host: false,
        }
    }
}

struct SessionHandler {
    state: AppState,
    rate_limiter: Arc<RateLimiter>,
    peer_addr: Option<SocketAddr>,
    id: Option<String>,
    is_host: bool,
}

fn fingerprint(key: &PublicKey) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(key.public_key_base64().as_bytes()))
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

#[async_trait]
impl russh::server::Handler for SessionHandler {
    type Error = anyhow::Error;

    async fn auth_publickey(&mut self, user: &str, public_key: &PublicKey) -> Result<Auth, Self::Error> {
        if !self.rate_limiter.is_allowed(self.peer_addr).await {
            warn!("Rate limited {:?}", self.peer_addr);
            return Ok(Auth::Reject { proceed_with_methods: None });
        }
        let (role, id) = if let Some(id) = user.strip_prefix("host:") { ("host", id) }
            else if let Some(id) = user.strip_prefix("client:") { ("client", id) }
            else { return Ok(Auth::Reject { proceed_with_methods: None }); };

        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
            return Ok(Auth::Reject { proceed_with_methods: None });
        }
        let fp = fingerprint(public_key);
        let registry_key = format!("{}:{}", role, id);
        {
            let mut reg = self.state.key_registry.lock().await;
            match reg.get(&registry_key) {
                Some(pinned) => if *pinned != fp {
                    warn!("Key mismatch for {}", registry_key);
                    return Ok(Auth::Reject { proceed_with_methods: None });
                },
                None => { reg.insert(registry_key.clone(), fp); }
            }
        }
        self.is_host = role == "host";
        self.id = Some(id.to_string());
        Ok(Auth::Accept)
    }

    async fn auth_succeeded(&mut self, session: &mut Session) -> Result<(), Self::Error> {
        if self.is_host {
            if let Some(id) = &self.id {
                let mut handles = self.state.host_handles.lock().await;
                handles.insert(id.clone(), session.handle());
                let mut reg = self.state.host_registry.lock().await;
                reg.insert(id.clone(), HostInfo {
                    id: id.clone(),
                    connected_at: unix_now(),
                    relay_addr: self.state.relay_addr.clone(),
                });
                drop(handles); drop(reg);
                let evt = serde_json::to_string(&json!({ "event": "connected", "id": id })).unwrap_or_default();
                let _ = self.state.events_tx.send(evt);
                info!("Host '{}' connected", id);
            }
        }
        Ok(())
    }

    async fn channel_open_session(&mut self, _channel: russh::Channel<russh::server::Msg>, _session: &mut Session) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.is_host { return Ok(false); }
        if port_to_connect != 22 && port_to_connect != 23 { return Ok(false); }
        let handles = self.state.host_handles.lock().await;
        if let Some(h) = handles.get(host_to_connect).cloned() {
            drop(handles);
            match h.channel_open_forwarded_tcpip(host_to_connect, port_to_connect, "relay", 0).await {
                Ok(hc) => {
                    let mut cs = channel.into_stream();
                    let mut hs = hc.into_stream();
                    tokio::spawn(async move {
                        if let Err(e) = tokio::io::copy_bidirectional(&mut cs, &mut hs).await {
                            error!("Pipe error: {}", e);
                        }
                    });
                    return Ok(true);
                }
                Err(e) => error!("Channel open failed: {}", e),
            }
        } else {
            // Clean up stale entry
            self.state.host_handles.lock().await.remove(host_to_connect);
        }
        Ok(false)
    }
}

impl Drop for SessionHandler {
    fn drop(&mut self) {
        if self.is_host {
            if let Some(id) = &self.id {
                let id = id.clone();
                let state = self.state.clone();
                tokio::spawn(async move {
                    state.host_handles.lock().await.remove(&id);
                    state.host_registry.lock().await.remove(&id);
                    let evt = serde_json::to_string(&json!({ "event": "disconnected", "id": id })).unwrap_or_default();
                    let _ = state.events_tx.send(evt);
                    info!("Host '{}' disconnected", id);
                });
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
//  Auth middleware helper
// ─────────────────────────────────────────────────────────
fn check_token(headers: &HeaderMap, expected: &str) -> bool {
    headers.get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == expected)
        .unwrap_or(false)
}

/// Accept token from Authorization header OR ?token= query param (needed for WebSocket clients
/// that cannot set headers, e.g. React Native's built-in WebSocket).
fn check_auth(headers: &HeaderMap, params: &HashMap<String, String>, expected: &str) -> bool {
    check_token(headers, expected)
        || params.get("token").map(|t| t.as_str() == expected).unwrap_or(false)
}

// ─────────────────────────────────────────────────────────
//  HTTP API handlers
// ─────────────────────────────────────────────────────────

/// GET /api/hosts — list connected hosts
async fn api_hosts(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_token(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"Unauthorized"}))).into_response();
    }
    let reg = state.host_registry.lock().await;
    let hosts: Vec<&HostInfo> = reg.values().collect();
    Json(json!({ "hosts": hosts })).into_response()
}

/// GET /api/host/:id/pair — pairing string + QR as base64 PNG
async fn api_host_pair(
    headers: HeaderMap,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    if !check_token(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"Unauthorized"}))).into_response();
    }
    let reg = state.host_registry.lock().await;
    if let Some(info) = reg.get(&id) {
        // We don't store the relay fp per-host here; use empty for now (client can TOFU)
        let pair_str = shared::qr::encode(&info.relay_addr, &id, "");
        drop(reg);

        // Generate QR as PNG bytes, return as base64
        let qr_b64 = generate_qr_png_b64(&pair_str);
        Json(json!({
            "id": id,
            "pairing_string": pair_str,
            "qr_png_base64": qr_b64,
        })).into_response()
    } else {
        drop(reg);
        (StatusCode::NOT_FOUND, Json(json!({"error":"Host not connected"}))).into_response()
    }
}

fn generate_qr_png_b64(data: &str) -> String {
    use qrcode::QrCode;
    use image::Luma;

    match QrCode::new(data.as_bytes()) {
        Ok(code) => {
            let img = code.render::<Luma<u8>>().build();
            let mut png_bytes: Vec<u8> = Vec::new();
            let mut cursor = std::io::Cursor::new(&mut png_bytes);
            if img.write_to(&mut cursor, image::ImageFormat::Png).is_ok() {
                B64.encode(&png_bytes)
            } else {
                String::new()
            }
        }
        Err(_) => String::new(),
    }
}

/// GET /api/setup-qr — returns QR code PNG (base64) encoding relayUrl + token for phone setup.
/// No auth required — the QR itself is the secret (contains the token).
async fn api_setup_qr(State(state): State<AppState>) -> Response {
    // Encode: "openssh://<relay_addr>?token=<token>"
    let payload = format!("openssh://{}?token={}", state.relay_addr, state.api_token);
    let qr_b64 = generate_qr_png_b64(&payload);
    Json(json!({
        "qr_png_base64": qr_b64,
        "relay_url": format!("http://{}", state.relay_addr),
        "token": state.api_token,
    })).into_response()
}

/// GET /api/status
async fn api_status(headers: HeaderMap, State(state): State<AppState>) -> Response {
    if !check_token(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"Unauthorized"}))).into_response();
    }
    let count = state.host_handles.lock().await.len();
    Json(json!({ "status": "ok", "connected_hosts": count })).into_response()
}

/// WS /api/events — real-time push stream
async fn api_events(
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, &params, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws(socket, state.events_tx.subscribe()))
}

async fn handle_ws(mut ws: WebSocket, mut rx: broadcast::Receiver<String>) {
    // Send current hosts on connect would go here; for now just stream events
    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Ok(text) => { if ws.send(Message::Text(text.into())).await.is_err() { break; } }
                    Err(_) => break,
                }
            }
        }
    }
}

// ─────────────────────────────────────────────────────────
//  Terminal WebSocket — bridges mobile app ↔ host PTY
// ─────────────────────────────────────────────────────────

/// GET /api/terminal/:id  — open a live shell to a connected host.
///
/// Auth: `Authorization: Bearer <token>` header  OR  `?token=<token>` query param.
/// Once authenticated, opens an SSH forwarded-tcpip channel to the host's PTY
/// (port 22) and bidirectionally pipes WebSocket frames ↔ SSH bytes.
async fn api_terminal(
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    if !check_auth(&headers, &params, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Unauthorized"}))).into_response();
    }

    // Grab the SSH handle for this host (clone so we can drop the lock)
    let handle = {
        let handles = state.host_handles.lock().await;
        handles.get(&id).cloned()
    };
    let handle = match handle {
        Some(h) => h,
        None => return (StatusCode::NOT_FOUND, Json(json!({"error": "Host not connected"}))).into_response(),
    };

    // Open SSH forwarded-tcpip channel to the host's PTY (port 22).
    // Must happen *before* on_upgrade so we can return a proper HTTP error if it fails.
    let channel = match handle.channel_open_forwarded_tcpip(&id, 22, "relay", 0).await {
        Ok(ch) => ch,
        Err(e) => {
            error!("Terminal: failed to open SSH channel to {}: {}", id, e);
            return (StatusCode::BAD_GATEWAY, Json(json!({"error": "Could not open channel to host"}))).into_response();
        }
    };

    info!("Terminal WebSocket opened for host '{}'", id);
    ws.on_upgrade(move |socket| handle_terminal_ws(socket, channel))
}

async fn handle_terminal_ws(
    mut ws: WebSocket,
    channel: russh::Channel<russh::server::Msg>,
) {
    let ssh_stream = channel.into_stream();
    let (mut ssh_rx, mut ssh_tx) = tokio::io::split(ssh_stream);

    // Offload blocking SSH reads onto a task that forwards via mpsc
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match ssh_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).await.is_err() { break; }
                }
            }
        }
    });

    // Main loop: select between SSH output → WS and WS input → SSH
    loop {
        tokio::select! {
            data = out_rx.recv() => {
                match data {
                    Some(bytes) => {
                        if ws.send(Message::Binary(bytes.into())).await.is_err() { break; }
                    }
                    None => break, // SSH channel closed
                }
            }
            msg = ws.recv() => {
                match msg {
                    Some(Ok(Message::Text(t)))   => { if ssh_tx.write_all(t.as_bytes()).await.is_err() { break; } }
                    Some(Ok(Message::Binary(b))) => { if ssh_tx.write_all(&b).await.is_err() { break; } }
                    Some(Ok(Message::Close(_)))  => break,
                    None | Some(Err(_))          => break,
                    _                            => {}
                }
            }
        }
    }
    info!("Terminal WebSocket closed");
}

// ─────────────────────────────────────────────────────────
//  Host key persistence
// ─────────────────────────────────────────────────────────
fn load_or_generate_host_key(path: &str) -> Result<KeyPair> {
    if std::path::Path::new(path).exists() {
        let pem = std::fs::read_to_string(path)?;
        Ok(russh_keys::decode_secret_key(&pem, None)?)
    } else {
        let key = KeyPair::generate_ed25519()
            .ok_or_else(|| anyhow::anyhow!("Key gen failed"))?;
        if let Some(p) = std::path::Path::new(path).parent() { std::fs::create_dir_all(p)?; }
        let mut pem: Vec<u8> = Vec::new();
        russh_keys::encode_pkcs8_pem(&key, &mut pem)?;
        std::fs::write(path, &pem)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?; }
        info!("Generated relay host key at {}", path);
        Ok(key)
    }
}

fn load_or_generate_token(path: &str, provided: &str) -> Result<String> {
    if !provided.is_empty() { return Ok(provided.to_string()); }
    if std::path::Path::new(path).exists() {
        return Ok(std::fs::read_to_string(path)?.trim().to_string());
    }
    use uuid::Uuid;
    let token = Uuid::new_v4().to_string().replace('-', "");
    if let Some(p) = std::path::Path::new(path).parent() { std::fs::create_dir_all(p)?; }
    std::fs::write(path, &token)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?; }
    Ok(token)
}

// ─────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────
#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();
    let cli = Cli::parse();

    let host_key = load_or_generate_host_key(&cli.host_key)?;

    // Derive token file path next to host key
    let token_path = format!("{}_api_token", cli.host_key);
    let api_token = load_or_generate_token(&token_path, &cli.api_token)?;

    // Derive the public API URL for the QR code.
    // If --public-url is provided use that; otherwise replace 0.0.0.0 with 127.0.0.1.
    let public_api_url = if cli.public_url.is_empty() {
        format!("http://{}", cli.api_bind.replace("0.0.0.0", "127.0.0.1"))
    } else {
        cli.public_url.clone()
    };

    // Encode setup QR: russh-api://url=<api_url>&token=<token>
    // The mobile app scans this to auto-configure — no manual typing needed.
    let setup_qr_data = format!("russh-api://url={}&token={}", public_api_url, api_token);

    // Print connection info clearly on startup
    println!("┌─────────────────────────────────────────────────┐");
    println!("│       RustSSH Relay                             │");
    println!("│  SSH:  {}   │", cli.bind);
    println!("│  API:  {}             │", public_api_url);
    println!("│  Token: {}  │", &api_token[..8.min(api_token.len())]);
    println!("│  (full token saved to: {})  │", token_path);
    println!("└─────────────────────────────────────────────────┘");
    println!();
    println!("API Token (copy into app): {}", api_token);
    println!();
    println!("╔══════════════════════════════════════════════════════╗");
    println!("║  📱  Scan this QR in the RustSSH app to connect       ║");
    println!("╚══════════════════════════════════════════════════════╝");
    shared::qr::print_qr(&setup_qr_data);
    println!("Or paste this into the app manually:");
    println!("  URL:   {}", public_api_url);
    println!("  Token: {}", api_token);
    println!();


    let (events_tx, _) = broadcast::channel::<String>(256);

    let app_state = AppState {
        host_handles: Arc::new(Mutex::new(HashMap::new())),
        host_registry: Arc::new(Mutex::new(HashMap::new())),
        key_registry: Arc::new(Mutex::new(HashMap::new())),
        events_tx: events_tx.clone(),
        api_token: api_token.clone(),
        relay_addr: cli.bind.clone(),
    };

    // ── Axum HTTP API ─────────────────────────────────────
    let api_app = Router::new()
        .route("/api/setup-qr", get(api_setup_qr))
        .route("/api/status", get(api_status))
        .route("/api/hosts", get(api_hosts))
        .route("/api/host/{id}/pair", get(api_host_pair))
        .route("/api/events", get(api_events))
        .route("/api/terminal/{id}", get(api_terminal))
        .with_state(app_state.clone());

    let api_addr: SocketAddr = cli.api_bind.parse()?;
    info!("API listening on http://{}", api_addr);
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::bind(api_addr).await.unwrap();
        axum::serve(listener, api_app).await.unwrap();
    });

    // ── SSH Server ────────────────────────────────────────
    let mut ssh_config = russh::server::Config::default();
    ssh_config.auth_rejection_time = Duration::from_secs(3);
    ssh_config.auth_rejection_time_initial = Some(Duration::from_millis(100));
    ssh_config.keys.push(host_key);
    let ssh_config = Arc::new(ssh_config);

    let mut ssh_server = SshServer {
        state: app_state,
        rate_limiter: RateLimiter::new(cli.rate_limit),
    };

    let ssh_addr: SocketAddr = cli.bind.parse()?;
    info!("SSH listening on {}", ssh_addr);
    ssh_server
        .run_on_address(ssh_config, ssh_addr)
        .await
        .map_err(|e| anyhow::anyhow!("SSH error: {}", e))?;

    Ok(())
}
