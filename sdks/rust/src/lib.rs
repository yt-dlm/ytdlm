//! # `ytdlm-rs` — Real-Time YouTube SABR UMP Audio Streamer for Rust & Discord Bots
//!
//! Integrates `ytdlm` with Rust Discord voice libraries (`songbird`, `serenity`, `twilight`):
//! 1. **Subprocess Live Pipe (`spawn_stream` / `spawn_stream_with_speed`)**: Spawns `ytdlm stream <url> -o -`
//!    and yields an async `tokio::process::Child` whose `stdout` emits live WebM/Opus audio chunks immediately.
//! 2. **HTTP Stream Gateway (`get_stream_url` / `get_stream_url_with_speed`)**: Returns an HTTP URL
//!    (`http://127.0.0.1:8787/stream?v=...&speed=1.25`) that can be passed directly to
//!    `songbird::input::HttpRequest::new(client, stream_url)`.
//! 3. **Real-Time Speed Control (`0.10x` to `4.00x`)**: Supports fine-grained 2-decimal float speeds
//!    (`0.10`, `0.11`, ..., `4.00`).

use serde::{Deserialize, Serialize};
use std::io;
use std::process::Stdio;
use tokio::process::{Child, Command};

pub const MIN_PLAYBACK_SPEED: f64 = 0.10;
pub const MAX_PLAYBACK_SPEED: f64 = 4.00;

/// Normalizes and clamps playback speed to a 2-decimal float in `[0.10, 4.00]`.
pub fn normalize_speed(speed: f64) -> f64 {
    if !speed.is_finite() || speed <= 0.0 {
        return 1.0;
    }
    let clamped = speed.clamp(MIN_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED);
    (clamped * 100.0).round() / 100.0
}

/// Parses a string playback speed (supporting both `"0.10"` and `"0,10"`) and clamps to `[0.10, 4.00]`.
pub fn parse_speed(speed_str: &str) -> f64 {
    let cleaned = speed_str.trim().replace(',', ".");
    match cleaned.parse::<f64>() {
        Ok(val) => normalize_speed(val),
        Err(_) => 1.0,
    }
}

/// Builds an FFmpeg `atempo` filter chain for any playback speed in `[0.10, 4.00]`.
pub fn build_atempo_filter(speed: f64) -> String {
    let spd = normalize_speed(speed);
    if (spd - 1.0).abs() < 1e-4 {
        return "atempo=1.0".to_string();
    }
    let mut stages = Vec::new();
    let mut rem = spd;
    while rem < 0.5 - 1e-6 {
        stages.push("atempo=0.5".to_string());
        rem /= 0.5;
    }
    while rem > 2.0 + 1e-6 {
        stages.push("atempo=2.0".to_string());
        rem /= 2.0;
    }
    let final_stage = (rem * 10000.0).round() / 10000.0;
    if (final_stage - 1.0).abs() > 1e-4 || stages.is_empty() {
        stages.push(format!("atempo={}", final_stage));
    }
    stages.join(",")
}

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
    #[serde(default)]
    pub effective_duration_ms: u64,
    pub itag: u32,
    #[serde(default)]
    pub is_guest: bool,
    pub mode: String,
    #[serde(default = "default_speed_val")]
    pub speed: f64,
    pub thumbnail: Option<String>,
}

fn default_speed_val() -> f64 {
    1.0
}

#[derive(Debug, Clone)]
pub struct YtdlmClient {
    pub binary_path: String,
    pub server_url: String,
    pub default_itag: u32,
    pub force_guest: bool,
    pub default_speed: f64,
}

impl Default for YtdlmClient {
    fn default() -> Self {
        Self {
            binary_path: "ytdlm".to_string(),
            server_url: "http://127.0.0.1:8787".to_string(),
            default_itag: 251,
            force_guest: true,
            default_speed: 1.0,
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
            default_speed: 1.0,
        }
    }

    pub fn with_server_url(mut self, server_url: impl Into<String>) -> Self {
        self.server_url = server_url.into().trim_end_matches('/').to_string();
        self
    }

    pub fn with_default_speed(mut self, speed: f64) -> Self {
        self.default_speed = normalize_speed(speed);
        self
    }

    /// Returns a live HTTP streaming URL (`Content-Type: audio/webm; codecs="opus"`)
    /// suitable for `songbird::input::HttpRequest::new(http_client, url)`.
    pub fn get_stream_url(&self, url_or_query: &str, start_ms: u64) -> String {
        self.get_stream_url_with_speed(url_or_query, start_ms, self.default_speed)
    }

    /// Returns a live HTTP streaming URL with custom playback speed in `[0.10, 4.00]`.
    pub fn get_stream_url_with_speed(&self, url_or_query: &str, start_ms: u64, speed: f64) -> String {
        let encoded_v = urlencoding::encode(url_or_query);
        let guest_flag = if self.force_guest { "1" } else { "0" };
        let spd = normalize_speed(speed);
        format!(
            "{}/stream?v={}&itag={}&guest={}&start={}&speed={:.2}",
            self.server_url, encoded_v, self.default_itag, guest_flag, start_ms, spd
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
            "--speed",
            &format!("{:.2}", self.default_speed),
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
    /// Starts emitting patched WebM Init + Clusters within ~300ms.
    pub fn spawn_stream(&self, url_or_query: &str, start_ms: u64) -> io::Result<Child> {
        self.spawn_stream_with_speed(url_or_query, start_ms, self.default_speed)
    }

    /// Spawns a live real-time WebM/Opus stream on `Child.stdout` with custom playback speed in `[0.10, 4.00]`.
    pub fn spawn_stream_with_speed(&self, url_or_query: &str, start_ms: u64, speed: f64) -> io::Result<Child> {
        let mut cmd = self.base_command();
        let spd = normalize_speed(speed);
        cmd.args([
            "stream",
            url_or_query,
            "-f",
            &self.default_itag.to_string(),
            "--start",
            &start_ms.to_string(),
            "--speed",
            &format!("{:.2}", spd),
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
