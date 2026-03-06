use anyhow::Result;
use async_trait::async_trait;
use clap::Parser;
use log::{error, info, warn};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use russh::client::{Handler, Session};
use russh::Channel;
use russh_keys::PublicKeyBase64;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────
#[derive(Parser, Debug)]
#[command(about = "RustSSH Host Daemon")]
struct Cli {
    /// Unique name for this host on the relay
    id: String,
    /// Relay server address
    #[arg(long, default_value = "127.0.0.1:2222")]
    relay: String,
    /// Path to this host's persistent key (PEM). Generated if missing.
    #[arg(long, default_value = "~/.config/russh-host/host_key")]
    key: String,
    /// Root jail for file-system RPC. Client cannot access anything outside this directory.
    #[arg(long, default_value = "~")]
    fs_root: String,
    /// Maximum RPC message size in bytes (default 100 MB)
    #[arg(long, default_value_t = 100 * 1024 * 1024)]
    max_rpc_bytes: usize,
    /// Known relay host-key fingerprint (hex sha256). Empty = TOFU on first connect.
    #[arg(long, default_value = "")]
    relay_fingerprint: String,
}

// ─────────────────────────────────────────────
//  Key helpers
// ─────────────────────────────────────────────
fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        dirs_home().join(rest)
    } else if p == "~" {
        dirs_home()
    } else {
        PathBuf::from(p)
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn load_or_generate_key(path: &str) -> Result<russh_keys::key::KeyPair> {
    let path = expand_tilde(path);
    if path.exists() {
        let pem = std::fs::read_to_string(&path)?;
        let key = russh_keys::decode_secret_key(&pem, None)?;
        info!("Loaded host key from {:?}", path);
        Ok(key)
    } else {
        let key = russh_keys::key::KeyPair::generate_ed25519()
            .ok_or_else(|| anyhow::anyhow!("Key gen failed"))?;
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        let mut pem_bytes: Vec<u8> = Vec::new();
        russh_keys::encode_pkcs8_pem(&key, &mut pem_bytes)?;
        std::fs::write(&path, &pem_bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        info!("Generated & saved host key to {:?}", path);
        Ok(key)
    }
}

fn fingerprint_pubkey(key: &russh_keys::key::PublicKey) -> String {
    use sha2::{Digest, Sha256};
    let b64 = key.public_key_base64();
    hex::encode(Sha256::digest(b64.as_bytes()))
}

// ─────────────────────────────────────────────
//  Path jail helper
// ─────────────────────────────────────────────
/// Canonicalise `requested` and verify it lives inside `root`.
/// Returns the safe absolute path or an error.
fn jail_path(root: &Path, requested: &str) -> Result<PathBuf> {
    if requested.contains('\0') {
        anyhow::bail!("Null byte in path");
    }
    let root = root.canonicalize()?;
    let candidate = if Path::new(requested).is_absolute() {
        PathBuf::from(requested)
    } else {
        root.join(requested)
    };
    let safe = if candidate.exists() {
        candidate.canonicalize()?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| anyhow::anyhow!("No parent dir"))?
            .canonicalize()?;
        parent.join(
            candidate
                .file_name()
                .ok_or_else(|| anyhow::anyhow!("No file name"))?,
        )
    };
    if !safe.starts_with(&root) {
        anyhow::bail!("Path escape attempt: {:?} is outside jail {:?}", safe, root);
    }
    Ok(safe)
}

// ─────────────────────────────────────────────
//  Client handler (receives forwarded channels)
// ─────────────────────────────────────────────
#[derive(Clone)]
struct ClientHandler {
    fs_root: PathBuf,
    max_rpc_bytes: usize,
    expected_relay_fp: Option<String>,
    /// Filled in after check_server_key – used to print QR code
    observed_relay_fp: Arc<tokio::sync::Mutex<String>>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = anyhow::Error;

    /// Verify the relay's host key (prevent MITM).
    async fn check_server_key(
        &mut self,
        server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = fingerprint_pubkey(server_public_key);
        // Always store the observed fingerprint so main can print the QR
        *self.observed_relay_fp.lock().await = fp.clone();
        match &self.expected_relay_fp {
            Some(expected) => {
                if fp == *expected {
                    info!("Relay server key verified: {}", fp);
                    Ok(true)
                } else {
                    error!("RELAY KEY MISMATCH! Expected {}, got {}", expected, fp);
                    Ok(false)
                }
            }
            None => {
                warn!("⚠️  TOFU: relay fingerprint = {}. Pin with --relay-fingerprint to enforce.", fp);
                Ok(true)
            }
        }
    }

    /// Handle a channel opened by the relay on our behalf.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        info!("Relay forwarding channel on port {}", connected_port);
        match connected_port {
            22 => { tokio::spawn(handle_pty_shell(channel)); }
            23 => {
                let root = self.fs_root.clone();
                let max = self.max_rpc_bytes;
                tokio::spawn(handle_fs_rpc(channel, root, max));
            }
            other => {
                error!("Rejected unknown port {}", other);
                return Err(anyhow::anyhow!("Unknown port {}", other));
            }
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────
//  Shell handler (PTY)
// ─────────────────────────────────────────────
async fn handle_pty_shell(channel: Channel<russh::client::Msg>) {
    info!("Starting PTY shell");
    let pty_system = NativePtySystem::default();
    let pair = match pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => { error!("openpty failed: {}", e); return; }
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/K"); // keep cmd open after each command
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = CommandBuilder::new("bash");
        // Suppress ANSI colour codes — our terminal strips them client-side,
        // but TERM=dumb / NO_COLOR stops bash/ls emitting them in the first place.
        c.env("TERM", "dumb");
        c.env("NO_COLOR", "1");
        c.env("LS_COLORS", "");
        c
    };
    if let Err(e) = pair.slave.spawn_command(cmd) {
        error!("Spawn shell failed: {}", e);
        return;
    }
    drop(pair.slave);

    let mut master_reader = pair.master.try_clone_reader().unwrap();
    let mut master_writer = pair.master.take_writer().unwrap();
    let (mut channel_rx, mut channel_tx) = tokio::io::split(channel.into_stream());

    let pty_to_channel = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        let rt = tokio::runtime::Handle::current();
        loop {
            match master_reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => rt.block_on(async {
                    let _ = channel_tx.write_all(&buf[..n]).await;
                    let _ = channel_tx.flush().await;
                }),
            }
        }
    });

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    let channel_to_pty = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match channel_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).await.is_err() { break; }
                }
            }
        }
    });
    let mpsc_to_pty = tokio::task::spawn_blocking(move || {
        while let Some(data) = rx.blocking_recv() {
            if master_writer.write_all(&data).is_err() { break; }
            let _ = master_writer.flush();
        }
    });

    let _ = tokio::join!(pty_to_channel, channel_to_pty, mpsc_to_pty);
    info!("PTY shell session ended");
}

// ─────────────────────────────────────────────
//  FS RPC handler – with path jail + max size
// ─────────────────────────────────────────────
async fn handle_fs_rpc(channel: Channel<russh::client::Msg>, fs_root: PathBuf, max_bytes: usize) {
    info!("Starting FS RPC (root: {:?})", fs_root);
    let mut stream = channel.into_stream();

    loop {
        let mut len_buf = [0u8; 4];
        if stream.read_exact(&mut len_buf).await.is_err() { break; }
        let len = u32::from_be_bytes(len_buf) as usize;

        // ── Max message size guard ──────────────────────────────
        if len > max_bytes {
            error!("RPC message too large: {} > {} bytes – closing", len, max_bytes);
            break;
        }

        let mut msg_buf = vec![0u8; len];
        if stream.read_exact(&mut msg_buf).await.is_err() { break; }

        let resp = match shared::FileRequest::from_bytes(&msg_buf) {
            Ok(req) => process_fs_request(req, &fs_root).await,
            Err(e) => {
                error!("Invalid RPC request: {}", e);
                shared::FileResponse::Error("Malformed request".into())
            }
        };

        if let Ok(resp_bytes) = resp.to_bytes() {
            let resp_len = resp_bytes.len() as u32;
            let _ = stream.write_all(&resp_len.to_be_bytes()).await;
            let _ = stream.write_all(&resp_bytes).await;
        }
    }
    info!("FS RPC session ended");
}

// ─────────────────────────────────────────────
//  Process one FS request (jailed)
// ─────────────────────────────────────────────
async fn process_fs_request(req: shared::FileRequest, root: &Path) -> shared::FileResponse {
    use shared::{FileInfo, FileResponse};
    match req {
        shared::FileRequest::ListDir(path) => {
            let safe = match jail_path(root, &path) {
                Ok(p) => p,
                Err(e) => { warn!("ListDir jailed: {}", e); return FileResponse::Error(e.to_string()); }
            };
            match tokio::fs::read_dir(&safe).await {
                Ok(mut entries) => {
                    let mut list = Vec::new();
                    while let Ok(Some(entry)) = entries.next_entry().await {
                        if let Ok(meta) = entry.metadata().await {
                            list.push(FileInfo {
                                name: entry.file_name().to_string_lossy().to_string(),
                                is_dir: meta.is_dir(),
                                size: meta.len(),
                                modified_secs: meta
                                    .modified()
                                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
                                    .duration_since(std::time::SystemTime::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs(),
                            });
                        }
                    }
                    FileResponse::DirListed(list)
                }
                Err(e) => FileResponse::Error(e.to_string()),
            }
        }
        shared::FileRequest::ReadFile(path) => {
            let safe = match jail_path(root, &path) {
                Ok(p) => p,
                Err(e) => { warn!("ReadFile jailed: {}", e); return FileResponse::Error(e.to_string()); }
            };
            match tokio::fs::read(&safe).await {
                Ok(data) => FileResponse::FileRead(data),
                Err(e) => FileResponse::Error(e.to_string()),
            }
        }
        shared::FileRequest::WriteFile(path, data) => {
            let safe = match jail_path(root, &path) {
                Ok(p) => p,
                Err(e) => { warn!("WriteFile jailed: {}", e); return FileResponse::Error(e.to_string()); }
            };
            match tokio::fs::write(&safe, data).await {
                Ok(_) => FileResponse::FileWritten,
                Err(e) => FileResponse::Error(e.to_string()),
            }
        }
    }
}

// ─────────────────────────────────────────────
//  Main — with auto-reconnect + exponential backoff
// ─────────────────────────────────────────────
#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();
    let cli = Cli::parse();

    let key = load_or_generate_key(&cli.key)?;
    let key = Arc::new(key);
    let fs_root = expand_tilde(&cli.fs_root)
        .canonicalize()
        .unwrap_or_else(|_| expand_tilde(&cli.fs_root));
    let expected_fp = if cli.relay_fingerprint.is_empty() {
        None
    } else {
        Some(cli.relay_fingerprint.clone())
    };

    let mut backoff = Duration::from_secs(2);
    let mut first_connect = true;
    loop {
        info!("Connecting to relay {} as host:{}", cli.relay, cli.id);
        let observed_fp: Arc<tokio::sync::Mutex<String>> = Arc::new(tokio::sync::Mutex::new(String::new()));
        let handler = ClientHandler {
            fs_root: fs_root.clone(),
            max_rpc_bytes: cli.max_rpc_bytes,
            expected_relay_fp: expected_fp.clone(),
            observed_relay_fp: observed_fp.clone(),
        };
        let config = Arc::new(russh::client::Config::default());

        match russh::client::connect(config, cli.relay.as_str(), handler).await {
            Ok(mut session) => {
                match session
                    .authenticate_publickey(format!("host:{}", cli.id), key.clone())
                    .await
                {
                    Ok(true) => {
                        info!("Authenticated. Waiting for channels...");
                        backoff = Duration::from_secs(2);

                        // ── Print QR on first successful connection ──────────
                        if first_connect {
                            first_connect = false;
                            let relay_fp = observed_fp.lock().await.clone();
                            let pairing_str = shared::qr::encode(&cli.relay, &cli.id, &relay_fp);
                            println!();
                            println!("╔══════════════════════════════════════════════════════╗");
                            println!("║  📱  Scan this QR with your phone to connect          ║");
                            println!("╚══════════════════════════════════════════════════════╝");
                            shared::qr::print_qr(&pairing_str);
                            println!("Or paste this string into the client:");
                            println!("  {}", pairing_str);
                            println!();
                        }

                        if let Err(e) = session.await {
                            warn!("Session ended: {}", e);
                        }
                    }
                    Ok(false) => {
                        error!("Authentication rejected. Your key may not be pinned on the relay yet.");
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    }
                    Err(e) => warn!("Auth error: {}", e),
                }
            }
            Err(e) => warn!("Connection failed: {}", e),
        }

        info!("Reconnecting in {:?}...", backoff);
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}
