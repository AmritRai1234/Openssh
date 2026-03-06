use serde::{Deserialize, Serialize};

pub mod qr;

/// Requests sent from the Client TUI to the Host daemon over a dedicated SSH channel.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum FileRequest {
    ListDir(String),
    ReadFile(String),
    WriteFile(String, Vec<u8>),
}

/// Responses sent from the Host daemon to the Client TUI.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum FileResponse {
    DirListed(Vec<FileInfo>),
    FileRead(Vec<u8>),
    FileWritten,
    Error(String),
}

/// Metadata about a single file or directory.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FileInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_secs: u64,
}

impl FileRequest {
    /// Serialize this request to binary format for transmission
    pub fn to_bytes(&self) -> Result<Vec<u8>, bincode::Error> {
        bincode::serialize(self)
    }

    /// Deserialize a request from binary format
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, bincode::Error> {
        bincode::deserialize(bytes)
    }
}

impl FileResponse {
    /// Serialize this response to binary format
    pub fn to_bytes(&self) -> Result<Vec<u8>, bincode::Error> {
        bincode::serialize(self)
    }

    /// Deserialize a response from binary format
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, bincode::Error> {
        bincode::deserialize(bytes)
    }
}
