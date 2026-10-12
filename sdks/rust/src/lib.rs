//! # `ytdlm-rs` — Real-Time YouTube SABR UMP Audio Streamer for Rust & Discord Bots
//!
//! Integrates `ytdlm` with Rust Discord voice libraries (`songbird`, `serenity`, `twilight`):
//! 1. **Subprocess Live Pipe (`spawn_stream`)**: Spawns `ytdlm stream <url> -o -` and yields an
//!    async `tokio::process::Child` whose `stdout` emits live WebM/Opus audio chunks immediately.
//! 2. **HTTP Stream Gateway (`get_stream_url`)**: Returns an HTTP URL (`http://127.0.0.1:8787/stream?v=...`)
//!    that can be passed directly to `songbird::input::HttpRequest::new(client, stream_url)`.

use serde::{Deserialize, Serialize};
use std::io;
use std::process::Stdio;
use tokio::process::{Child, Command};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    #[serde(alias = "id")]
    pub video_id: String,
    pub title: String,
    #[serde(alias = "uploader")]
    pub author: String,
    #[serde(default)]
    pub duration_ms: u64,
    pub itag: u32,
    #[serde(default)]
    pub is_guest: bool,
    pub mode: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct YtdlmClient {
    pub binary_path: String,
    pub server_url: String,
    pub default_itag: u32,
    pub force_guest: bool,
}

impl Default for YtdlmClient {
    fn default() -> Self {
        Self {
            binary_path: "ytdlm".to_string(),
            server_url: "http://127.0.0.1:8787".to_string(),
            default_itag: 251,
            force_guest: true,
        }
    }
}

impl YtdlmClient {
    pub fn new(binary_path: impl Into<String>, default_itag: u32, force_guest: bool) -> Self {
        Self {
            binary_path: binary_path.into(),
            server_url: "http://127.0.0.1:8787".to_string(),
            default_itag,
            force_guest,
        }
    }

    pub fn with_server_url(mut self, server_url: impl Into<String>) -> Self {
        self.server_url = server_url.into().trim_end_matches('/').to_string();
        self
    }

    /// Returns a live HTTP streaming URL (`Content-Type: audio/webm; codecs="opus"`)
    /// suitable for `songbird::input::HttpRequest::new(http_client, url)`.
    pub fn get_stream_url(&self, url_or_query: &str, start_ms: u64) -> String {
        let encoded_v = urlencoding::encode(url_or_query);
        let guest_flag = if self.force_guest { "1" } else { "0" };
        format!(
            "{}/stream?v={}&itag={}&guest={}&start={}",
            self.server_url, encoded_v, self.default_itag, guest_flag, start_ms
        )
    }

    /// Fetches track metadata via `ytdlm info <url> -j -q`.
    pub async fn get_info(&self, url_or_query: &str) -> io::Result<TrackInfo> {
        let mut cmd = self.base_command();
        cmd.args([
            "info",
            url_or_query,
            "-f",
            &self.default_itag.to_string(),
            "-j",
            "-q",
        ]);
        if self.force_guest {
            cmd.arg("--guest");
        }

        let output = cmd.output().await?;
        if !output.status.success() {
            let err_str = String::from_utf8_lossy(&output.stderr);
            return Err(io::Error::new(
                io::ErrorKind::Other,
                format!("ytdlm info failed: {}", err_str),
            ));
        }

        serde_json::from_slice::<TrackInfo>(&output.stdout)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Spawns a live real-time WebM/Opus stream on `Child.stdout`.
    ///Starts emitting patched WebM Init + Clusters within ~300ms.
    pub fn spawn_stream(&self, url_or_query: &str, start_ms: u64) -> io::Result<Child> {
        let mut cmd = self.base_command();
        cmd.args([
            "stream",
            url_or_query,
            "-f",
            &self.default_itag.to_string(),
            "--start",
            &start_ms.to_string(),
            "-o",
            "-",
            "-q",
        ]);
        if self.force_guest {
            cmd.arg("--guest");
        }

        cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
    }

    fn base_command(&self) -> Command {
        if self.binary_path.ends_with(".js") {
            let mut c = Command::new("node");
            c.arg(&self.binary_path);
            c
        } else {
            Command::new(&self.binary_path)
        }
    }
}
