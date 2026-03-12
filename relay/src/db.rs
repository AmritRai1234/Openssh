use anyhow::{Result, Context};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::Mutex;

/// SHA-256 hex digest of a string
pub fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// Multi-tenant database backed by SQLite
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (or create) the database at `path` and run migrations.
    pub fn open(path: &str) -> Result<Arc<Self>> {
        let conn = Connection::open(path)
            .with_context(|| format!("Failed to open database at {}", path))?;

        // Enable WAL mode for concurrent reads
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                id          TEXT PRIMARY KEY,
                email       TEXT UNIQUE NOT NULL,
                password    TEXT NOT NULL,
                name        TEXT NOT NULL DEFAULT '',
                plan        TEXT NOT NULL DEFAULT 'free',
                max_hosts   INTEGER NOT NULL DEFAULT 3,
                created_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS api_tokens (
                token_hash  TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id),
                label       TEXT NOT NULL DEFAULT 'default',
                created_at  INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS host_keys (
                host_id     TEXT NOT NULL,
                user_id     TEXT NOT NULL REFERENCES users(id),
                key_fp      TEXT NOT NULL,
                PRIMARY KEY (user_id, host_id)
            );"
        )?;

        Ok(Arc::new(Self { conn: Mutex::new(conn) }))
    }

    // ── User management ──────────────────────────────────

    /// Register a new user. Returns `(user_id, raw_api_token)`.
    pub async fn create_user(&self, email: &str, password: &str, name: &str) -> Result<(String, String)> {
        let id = uuid::Uuid::new_v4().to_string();
        let hash = bcrypt::hash(password, 10)
            .map_err(|e| anyhow::anyhow!("bcrypt error: {}", e))?;
        let now = unix_now();

        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO users (id, email, password, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, email.to_lowercase(), hash, name, now],
        ).with_context(|| "Email already registered")?;

        // Create a default API token for this user
        let raw_token = uuid::Uuid::new_v4().to_string();
        let token_hash = sha256_hex(&raw_token);
        conn.execute(
            "INSERT INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![token_hash, id, "default", now],
        )?;

        Ok((id, raw_token))
    }

    /// Verify email + password. Returns `(user_id, raw_api_token)` on success.
    pub async fn verify_login(&self, email: &str, password: &str) -> Result<Option<(String, String)>> {
        let conn = self.conn.lock().await;

        let result = conn.query_row(
            "SELECT id, password FROM users WHERE email = ?1",
            params![email.to_lowercase()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );

        match result {
            Ok((user_id, hash)) => {
                if bcrypt::verify(password, &hash).unwrap_or(false) {
                    // Return existing token or create new one
                    let token = conn.query_row(
                        "SELECT token_hash FROM api_tokens WHERE user_id = ?1 LIMIT 1",
                        params![user_id],
                        |row| row.get::<_, String>(0),
                    ).ok();

                    if let Some(_existing_hash) = token {
                        // Generate a fresh token for this login session
                        let raw_token = uuid::Uuid::new_v4().to_string();
                        let token_hash = sha256_hex(&raw_token);
                        conn.execute(
                            "INSERT INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?1, ?2, ?3, ?4)",
                            params![token_hash, user_id, "login", unix_now()],
                        )?;
                        Ok(Some((user_id, raw_token)))
                    } else {
                        let raw_token = uuid::Uuid::new_v4().to_string();
                        let token_hash = sha256_hex(&raw_token);
                        conn.execute(
                            "INSERT INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?1, ?2, ?3, ?4)",
                            params![token_hash, user_id, "login", unix_now()],
                        )?;
                        Ok(Some((user_id, raw_token)))
                    }
                } else {
                    Ok(None) // wrong password
                }
            }
            Err(_) => Ok(None), // email not found
        }
    }

    // ── Token management ─────────────────────────────────

    /// Look up a raw API token → returns `user_id` if valid.
    pub async fn lookup_token(&self, raw_token: &str) -> Option<String> {
        let hash = sha256_hex(raw_token);
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT user_id FROM api_tokens WHERE token_hash = ?1",
            params![hash],
            |row| row.get::<_, String>(0),
        ).ok()
    }

    // ── Host key pinning ─────────────────────────────────

    /// Pin a host key for a user (TOFU). Returns `Ok(true)` if newly pinned,
    /// `Ok(false)` if already pinned and matches, `Err` if mismatch.
    pub async fn pin_host_key(&self, user_id: &str, host_id: &str, key_fp: &str) -> Result<bool> {
        let conn = self.conn.lock().await;

        let existing = conn.query_row(
            "SELECT key_fp FROM host_keys WHERE user_id = ?1 AND host_id = ?2",
            params![user_id, host_id],
            |row| row.get::<_, String>(0),
        );

        match existing {
            Ok(pinned_fp) => {
                if pinned_fp == key_fp {
                    Ok(false) // already pinned, matches
                } else {
                    anyhow::bail!("Key mismatch for {}/{}: expected {}…, got {}…", user_id, host_id, &pinned_fp[..pinned_fp.len().min(16)], &key_fp[..key_fp.len().min(16)]);
                }
            }
            Err(_) => {
                conn.execute(
                    "INSERT INTO host_keys (user_id, host_id, key_fp) VALUES (?1, ?2, ?3)",
                    params![user_id, host_id, key_fp],
                )?;
                Ok(true) // newly pinned
            }
        }
    }

    /// Count how many hosts a user has pinned keys for.
    pub async fn count_user_hosts(&self, user_id: &str) -> usize {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM host_keys WHERE user_id = ?1",
            params![user_id],
            |row| row.get::<_, usize>(0),
        ).unwrap_or(0)
    }

    /// Get the max_hosts limit for a user.
    pub async fn max_hosts(&self, user_id: &str) -> usize {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT max_hosts FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get::<_, usize>(0),
        ).unwrap_or(3)
    }

    /// Get user profile by ID.
    pub async fn get_user(&self, user_id: &str) -> Option<UserInfo> {
        let conn = self.conn.lock().await;
        conn.query_row(
            "SELECT id, email, name, plan, max_hosts, created_at FROM users WHERE id = ?1",
            params![user_id],
            |row| Ok(UserInfo {
                id: row.get(0)?,
                email: row.get(1)?,
                name: row.get(2)?,
                plan: row.get(3)?,
                max_hosts: row.get(4)?,
                created_at: row.get(5)?,
            }),
        ).ok()
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UserInfo {
    pub id: String,
    pub email: String,
    pub name: String,
    pub plan: String,
    pub max_hosts: usize,
    pub created_at: u64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_user_lifecycle() {
        let db = Db::open(":memory:").unwrap();

        // Register
        let (user_id, token) = db.create_user("test@example.com", "password123", "Test").await.unwrap();
        assert!(!user_id.is_empty());
        assert!(!token.is_empty());

        // Lookup token
        let found = db.lookup_token(&token).await;
        assert_eq!(found, Some(user_id.clone()));

        // Login with correct password
        let login = db.verify_login("test@example.com", "password123").await.unwrap();
        assert!(login.is_some());

        // Login with wrong password
        let bad = db.verify_login("test@example.com", "wrong").await.unwrap();
        assert!(bad.is_none());

        // Login with wrong email
        let bad2 = db.verify_login("nope@example.com", "password123").await.unwrap();
        assert!(bad2.is_none());

        // Duplicate email rejection
        let dup = db.create_user("test@example.com", "pass", "Dup").await;
        assert!(dup.is_err());

        // Host key pinning
        let pinned = db.pin_host_key(&user_id, "my-pc", "fp_abc123").await.unwrap();
        assert!(pinned); // newly pinned

        let again = db.pin_host_key(&user_id, "my-pc", "fp_abc123").await.unwrap();
        assert!(!again); // already pinned, matches

        let mismatch = db.pin_host_key(&user_id, "my-pc", "fp_different_key").await;
        assert!(mismatch.is_err()); // key mismatch

        // Host count
        assert_eq!(db.count_user_hosts(&user_id).await, 1);
        assert_eq!(db.max_hosts(&user_id).await, 3);

        // User profile
        let user = db.get_user(&user_id).await.unwrap();
        assert_eq!(user.email, "test@example.com");
        assert_eq!(user.plan, "free");
    }
}
