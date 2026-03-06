use anyhow::Result;
use async_trait::async_trait;
use clap::{Parser, Subcommand};
use crossterm::{
    event::{DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use log::warn;
use ratatui::{
    backend::{Backend, CrosstermBackend},
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph},
    Frame, Terminal,
};
use russh::client::Handler;
use russh::Channel;
use russh_keys::key::PublicKey;
use russh_keys::PublicKeyBase64;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ─────────────────────────────────────────────
//  CLI
// ─────────────────────────────────────────────
#[derive(Parser, Debug)]
#[command(about = "RustSSH Client")]
struct Cli {
    /// Paste the pairing string from the host QR code here to auto-connect.
    /// When provided, --host/--relay/--relay-fingerprint are ignored.
    #[arg(long, value_name = "PAIRING_STRING")]
    pair: Option<String>,

    /// ID of the host to connect to (as registered on the relay)
    #[arg(long, default_value = "")]
    host: String,
    /// Relay server address
    #[arg(long, default_value = "127.0.0.1:2222")]
    relay: String,
    /// Path to this client's persistent key (PEM). Generated if missing.
    #[arg(long, default_value = "~/.config/russh-client/client_key")]
    key: String,
    /// Known relay host-key fingerprint (hex sha256). Empty = TOFU on first connect.
    #[arg(long, default_value = "")]
    relay_fingerprint: String,
    /// Client identity label (displayed to relay)
    #[arg(long, default_value = "local")]
    identity: String,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Drop into a raw interactive shell on the remote host
    Shell,
    /// Open the TUI file explorer
    Explore {
        #[arg(default_value = ".")]
        path: String,
    },
}

// ─────────────────────────────────────────────
//  Key helpers
// ─────────────────────────────────────────────
fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        dirs_home().join(rest)
    } else if p == "~" { dirs_home() }
    else { PathBuf::from(p) }
}
fn dirs_home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp"))
}

fn load_or_generate_key(path: &str) -> Result<russh_keys::key::KeyPair> {
    let path = expand_tilde(path);
    if path.exists() {
        let pem = std::fs::read_to_string(&path)?;
        Ok(russh_keys::decode_secret_key(&pem, None)?)
    } else {
        let key = russh_keys::key::KeyPair::generate_ed25519()
            .ok_or_else(|| anyhow::anyhow!("Key gen failed"))?;
        if let Some(p) = path.parent() { std::fs::create_dir_all(p)?; }
        let mut pem_bytes: Vec<u8> = Vec::new();
        russh_keys::encode_pkcs8_pem(&key, &mut pem_bytes)?;
        std::fs::write(&path, &pem_bytes)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        eprintln!("Generated client key at {:?}", path);
        Ok(key)
    }
}

fn fingerprint_pubkey(key: &PublicKey) -> String {
    use sha2::{Digest, Sha256};
    let b64 = key.public_key_base64();
    hex::encode(Sha256::digest(b64.as_bytes()))
}

// ─────────────────────────────────────────────
//  SSH client handler
// ─────────────────────────────────────────────
struct ClientHandler {
    expected_fp: Option<String>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = anyhow::Error;

    /// Verify the relay's server key to prevent MITM attacks.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = fingerprint_pubkey(server_public_key);
        match &self.expected_fp {
            Some(expected) => {
                if fp == *expected {
                    Ok(true)
                } else {
                    eprintln!("❌ RELAY KEY MISMATCH! Connection aborted.");
                    eprintln!("   Expected:  {}", expected);
                    eprintln!("   Got:       {}", fp);
                    Ok(false)
                }
            }
            None => {
                warn!("⚠️  TOFU: relay fingerprint = {}. Pin with --relay-fingerprint to harden.", fp);
                eprintln!("⚠️  Relay fingerprint (TOFU): {}", fp);
                eprintln!("   Add --relay-fingerprint={} to future calls to pin this key.", fp);
                Ok(true)
            }
        }
    }
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────
#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    let key = load_or_generate_key(&cli.key)?;
    let key = Arc::new(key);

    // ── Resolve connection params from --pair or explicit flags ───
    let (relay_addr, host_id, relay_fp_opt) = if let Some(ref pair_str) = cli.pair {
        match shared::qr::decode(pair_str) {
            Some((relay, id, fp)) => {
                eprintln!("✅ Pairing string decoded!");
                eprintln!("   Relay:          {}", relay);
                eprintln!("   Host ID:        {}", id);
                eprintln!("   Relay key pin:  {}", if fp.is_empty() { "(none – TOFU)" } else { &fp });
                let fp_opt = if fp.is_empty() { None } else { Some(fp) };
                (relay, id, fp_opt)
            }
            None => {
                eprintln!("❌ Invalid pairing string. Format: russh://relay=<addr>&id=<id>&fp=<hex>");
                return Ok(());
            }
        }
    } else {
        if cli.host.is_empty() {
            eprintln!("❌ Provide either --pair <string> or --host <id>");
            return Ok(());
        }
        let fp_opt = if cli.relay_fingerprint.is_empty() { None } else { Some(cli.relay_fingerprint.clone()) };
        (cli.relay.clone(), cli.host.clone(), fp_opt)
    };

    let config = Arc::new(russh::client::Config::default());
    let mut session = russh::client::connect(
        config,
        relay_addr.as_str(),
        ClientHandler { expected_fp: relay_fp_opt },
    ).await?;

    let username = format!("client:{}", cli.identity);
    let auth_ok = session.authenticate_publickey(username, key).await?;
    if !auth_ok {
        eprintln!("Authentication rejected by relay.");
        return Ok(());
    }

    match cli.command {
        Commands::Shell => {
            let channel = session.channel_open_direct_tcpip(&host_id, 22, "localhost", 0).await
                .map_err(|e| anyhow::anyhow!("Failed to open shell channel: {}", e))?;
            run_shell(channel).await?;
        }
        Commands::Explore { path } => {
            let channel = session.channel_open_direct_tcpip(&host_id, 23, "localhost", 0).await
                .map_err(|e| anyhow::anyhow!("Failed to open explorer channel: {}", e))?;
            run_explorer(channel, path).await?;
        }
    }

    let _ = session.disconnect(russh::Disconnect::ByApplication, "Done", "en-US").await;
    Ok(())
}

// ─────────────────────────────────────────────
//  Raw PTY shell
// ─────────────────────────────────────────────
async fn run_shell(channel: Channel<russh::client::Msg>) -> Result<()> {
    let stream = channel.into_stream();
    let (mut rx, mut tx) = tokio::io::split(stream);
    enable_raw_mode()?;

    let (stdin_tx, mut stdin_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    tokio::task::spawn_blocking(move || {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => { if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() { break; } }
            }
        }
    });

    let write_task = tokio::spawn(async move {
        while let Some(data) = stdin_rx.recv().await {
            if tx.write_all(&data).await.is_err() || tx.flush().await.is_err() { break; }
        }
    });
    let read_task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut stdout = io::stdout();
        loop {
            match rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => { if stdout.write_all(&buf[..n]).is_err() || stdout.flush().is_err() { break; } }
            }
        }
    });

    let _ = tokio::join!(write_task, read_task);
    disable_raw_mode()?;
    Ok(())
}

// ─────────────────────────────────────────────
//  TUI Explorer
// ─────────────────────────────────────────────
async fn run_explorer(channel: Channel<russh::client::Msg>, start_path: String) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let mut stream = channel.into_stream();

    let res = run_explorer_app(&mut terminal, &mut stream, start_path).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen, DisableMouseCapture)?;
    terminal.show_cursor()?;
    if let Err(e) = res { eprintln!("{:?}", e); }
    Ok(())
}

struct AppState {
    current_path: String,
    items: Vec<shared::FileInfo>,
    list_state: ListState,
    status_msg: String,
    pending_download: Option<String>,
}

async fn send_request(
    stream: &mut russh::ChannelStream<russh::client::Msg>,
    req: shared::FileRequest,
) -> Result<()> {
    let bytes = req.to_bytes()?;
    let len = bytes.len() as u32;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

async fn run_explorer_app<B: Backend>(
    terminal: &mut Terminal<B>,
    stream: &mut russh::ChannelStream<russh::client::Msg>,
    start_path: String,
) -> Result<()> {
    let mut state = AppState {
        current_path: start_path,
        items: Vec::new(),
        list_state: ListState::default(),
        status_msg: "Loading...".into(),
        pending_download: None,
    };

    send_request(stream, shared::FileRequest::ListDir(state.current_path.clone())).await?;

    loop {
        terminal.draw(|f| ui(f, &mut state))?;

        if crossterm::event::poll(std::time::Duration::from_millis(50))? {
            if let Event::Key(key) = crossterm::event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                        KeyCode::Down | KeyCode::Char('j') => {
                            let max = state.items.len().saturating_sub(1);
                            let i = state.list_state.selected().map(|i| (i + 1).min(max)).unwrap_or(0);
                            state.list_state.select(Some(i));
                        }
                        KeyCode::Up | KeyCode::Char('k') => {
                            let i = state.list_state.selected().map(|i| i.saturating_sub(1)).unwrap_or(0);
                            state.list_state.select(Some(i));
                        }
                        KeyCode::Enter => {
                            if let Some(i) = state.list_state.selected() {
                                if let Some(item) = state.items.get(i).cloned() {
                                    if item.is_dir {
                                        let new_path = if item.name == ".." {
                                            let p = std::path::Path::new(&state.current_path);
                                            p.parent().unwrap_or(p).to_string_lossy().to_string()
                                        } else {
                                            std::path::Path::new(&state.current_path).join(&item.name).to_string_lossy().to_string()
                                        };
                                        state.current_path = new_path;
                                        state.status_msg = "Loading...".into();
                                        send_request(stream, shared::FileRequest::ListDir(state.current_path.clone())).await?;
                                    } else {
                                        let file_path = std::path::Path::new(&state.current_path).join(&item.name).to_string_lossy().to_string();
                                        state.pending_download = Some(file_path.clone());
                                        state.status_msg = format!("Downloading {}...", item.name);
                                        send_request(stream, shared::FileRequest::ReadFile(file_path)).await?;
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        // Non-blocking peek for incoming response
        let mut len_buf = [0u8; 4];
        let bytes_read = {
            let mut pin = std::pin::Pin::new(&mut *stream);
            let waker = futures::task::noop_waker();
            let mut cx = std::task::Context::from_waker(&waker);
            let mut read_buf = tokio::io::ReadBuf::new(&mut len_buf);
            match tokio::io::AsyncRead::poll_read(pin.as_mut(), &mut cx, &mut read_buf) {
                std::task::Poll::Ready(Ok(())) => read_buf.filled().len(),
                _ => 0,
            }
        };

        if bytes_read == 4 {
            let msg_len = u32::from_be_bytes(len_buf) as usize;
            // Guard against absurd server responses too
            if msg_len > 200 * 1024 * 1024 {
                state.status_msg = "Error: oversized server response".to_string();
                continue;
            }
            let mut msg_buf = vec![0u8; msg_len];
            stream.read_exact(&mut msg_buf).await?;

            if let Ok(resp) = shared::FileResponse::from_bytes(&msg_buf) {
                match resp {
                    shared::FileResponse::DirListed(mut items) => {
                        items.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
                        if state.current_path != "/" {
                            items.insert(0, shared::FileInfo { name: "..".into(), is_dir: true, size: 0, modified_secs: 0 });
                        }
                        state.items = items;
                        state.list_state.select(Some(0));
                        state.status_msg = format!("{} items", state.items.len().saturating_sub(1));
                    }
                    shared::FileResponse::FileRead(data) => {
                        if let Some(remote_path) = state.pending_download.take() {
                            // 1. Suspend TUI
                            disable_raw_mode()?;
                            execute!(io::stdout(), LeaveAlternateScreen, DisableMouseCapture)?;

                            // 2. Write to a SECURE temp file (mode 0o600, unique, random path)
                            let tmp_file = tempfile::Builder::new()
                                .prefix("russh_edit_")
                                .suffix(".tmp")
                                .tempfile()?;
                            let tmp_path = tmp_file.path().to_path_buf();
                            std::fs::write(&tmp_path, &data)?;

                            let mut child = std::process::Command::new("vim").arg(&tmp_path).spawn()?;
                            child.wait()?;

                            let new_data = std::fs::read(&tmp_path)?;
                            // tempfile auto-deletes on drop — explicitly drop now
                            drop(tmp_file);

                            // 3. Resume TUI
                            enable_raw_mode()?;
                            execute!(io::stdout(), EnterAlternateScreen, EnableMouseCapture)?;
                            terminal.clear()?;

                            // 4. Upload if changed
                            if new_data != data {
                                send_request(stream, shared::FileRequest::WriteFile(remote_path, new_data)).await?;
                                state.status_msg = "Uploading changes...".into();
                            } else {
                                state.status_msg = "No changes made.".into();
                            }
                        }
                    }
                    shared::FileResponse::FileWritten => {
                        state.status_msg = "✓ File saved.".into();
                        // Refresh the current dir
                        send_request(stream, shared::FileRequest::ListDir(state.current_path.clone())).await?;
                    }
                    shared::FileResponse::Error(e) => {
                        state.status_msg = format!("Error: {}", e);
                    }
                }
            }
        }
    }
}

fn ui(f: &mut Frame, state: &mut AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0), Constraint::Length(3)].as_ref())
        .split(f.size());

    let header = Paragraph::new(format!(" {} ", state.current_path))
        .style(Style::default().fg(Color::Cyan))
        .block(Block::default().borders(Borders::ALL).title(" Remote File Explorer "));
    f.render_widget(header, chunks[0]);

    let items: Vec<ListItem> = state.items.iter().map(|i| {
        let style = if i.is_dir {
            Style::default().fg(Color::Blue).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let size_str = if i.is_dir { "".into() } else { format!("{} B", i.size) };
        ListItem::new(format!("{:<42}{}", i.name, size_str)).style(style)
    }).collect();

    let list = List::new(items)
        .block(Block::default().borders(Borders::ALL).title(" Files (↑↓/jk=nav  Enter=open  q=quit) "))
        .highlight_style(Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD))
        .highlight_symbol("▶ ");
    f.render_stateful_widget(list, chunks[1], &mut state.list_state);

    let footer = Paragraph::new(format!(" {} ", state.status_msg))
        .style(Style::default().fg(Color::Yellow))
        .block(Block::default().borders(Borders::ALL));
    f.render_widget(footer, chunks[2]);
}
