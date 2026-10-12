"""
ytdlm Python SDK — Real-Time YouTube SABR UMP Audio Streamer & Client
=====================================================================
Supports two zero-latency modes for Python apps and `discord.py` / `py-cord` / `nextcord` bots:
1. Subprocess Pipe Mode (`open_stream_pipe`): Spawns `ytdlm stream <url> -o -` and yields a live
   stdout binary pipe of WebM/Opus audio chunks (starts in ~300ms).
2. HTTP Gateway Mode (`get_stream_url`): Connects to `ytdlm serve` HTTP micro-server (`http://127.0.0.1:8787`)
   so FFmpeg or `discord.FFmpegOpusAudio` can stream directly via HTTP URL (including playback speed 0.10x to 4.00x).
"""

from __future__ import annotations
import json
import shutil
import subprocess
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Union

MIN_PLAYBACK_SPEED = 0.10
MAX_PLAYBACK_SPEED = 4.00


def normalize_playback_speed(speed: Union[float, int, str, None] = 1.0) -> float:
    """
    Normalizes and clamps playback speed to a 2-decimal float in [0.10, 4.00].
    Supports both dot ("0.10", 1.25) and comma ("0,10", "0,11") decimal strings.
    """
    if speed is None or speed == "":
        return 1.0
    try:
        raw = float(str(speed).strip().replace(",", "."))
    except (ValueError, TypeError):
        return 1.0
    if raw <= 0:
        return 1.0
    clamped = min(MAX_PLAYBACK_SPEED, max(MIN_PLAYBACK_SPEED, raw))
    return round(clamped, 2)


def build_atempo_filter(speed: Union[float, int, str, None] = 1.0) -> str:
    """
    Builds an FFmpeg `atempo` filter chain for any playback speed in [0.10, 4.00],
    keeping each stage within [0.5, 2.0].
    """
    spd = normalize_playback_speed(speed)
    if abs(spd - 1.0) < 1e-4:
        return "atempo=1.0"
    stages: List[str] = []
    rem = spd
    while rem < 0.5 - 1e-6:
        stages.append("atempo=0.5")
        rem /= 0.5
    while rem > 2.0 + 1e-6:
        stages.append("atempo=2.0")
        rem /= 2.0
    final_stage = round(rem, 4)
    if abs(final_stage - 1.0) > 1e-4 or not stages:
        stages.append(f"atempo={final_stage:g}")
    return ",".join(stages)


@dataclass
class TrackInfo:
    video_id: str
    title: str
    author: str
    duration_sec: int
    duration_ms: int
    url: str
    thumbnail: Optional[str]
    itag: int
    abr_kbps: int
    sample_rate: int
    channels: int
    is_guest: bool
    mode: str
    speed: float = 1.0
    atempo_filter: str = "atempo=1.0"
    effective_duration_ms: int = 0
    stream_url: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TrackInfo":
        dur_ms = int(data.get("durationMs") or 0)
        spd = normalize_playback_speed(data.get("speed", 1.0))
        return cls(
            video_id=data.get("videoId") or data.get("id", ""),
            title=data.get("title", "YouTube Audio"),
            author=data.get("author") or data.get("uploader", ""),
            duration_sec=int(data.get("durationSec") or data.get("duration") or 0),
            duration_ms=dur_ms,
            url=data.get("url") or data.get("webpage_url", ""),
            thumbnail=data.get("thumbnail"),
            itag=int(data.get("itag") or 251),
            abr_kbps=int(data.get("abr") or round(int(data.get("bitrate", 135000)) / 1000)),
            sample_rate=int(data.get("sampleRate") or data.get("asr") or 48000),
            channels=int(data.get("channels") or data.get("audio_channels") or 2),
            is_guest=bool(data.get("isGuest", True)),
            mode=data.get("mode", "TV_GUEST_SABR_251"),
            speed=spd,
            atempo_filter=data.get("atempoFilter") or build_atempo_filter(spd),
            effective_duration_ms=int(data.get("effectiveDurationMs") or round(dur_ms / spd)),
            stream_url=data.get("streamUrl"),
        )


class YtdlmClient:
    def __init__(
        self,
        binary_path: Optional[str] = None,
        server_url: Optional[str] = None,
        gateway_url: Optional[str] = None,
        default_itag: int = 251,
        force_guest: bool = True,
        default_speed: Union[float, str] = 1.0,
    ):
        """
        :param binary_path: Path to `ytdlm` CLI or `node /path/to/ytdlm/bin/ytdlm.js`.
        :param server_url: Optional URL of running `ytdlm serve` instance (e.g. "http://127.0.0.1:8787").
        :param gateway_url: Alias for `server_url`.
        :param default_itag: 251 (Guest ~160kbps Opus) or 774 (TV Premium ~256kbps Opus).
        :param force_guest: Force anonymous Guest TVHTML5 mode (default True for 251).
        :param default_speed: Default playback speed float in [0.10, 4.00] (default 1.0).
        """
        resolved_server = server_url or gateway_url
        if binary_path and (binary_path.startswith("http://") or binary_path.startswith("https://")) and not resolved_server:
            resolved_server = binary_path
            binary_path = None
        self.binary_path = binary_path or shutil.which("ytdlm") or "ytdlm"
        self.server_url = resolved_server.rstrip("/") if resolved_server else None
        self.default_itag = default_itag
        self.force_guest = force_guest
        self.default_speed = normalize_playback_speed(default_speed)

    @staticmethod
    def normalize_speed(speed: Union[float, int, str, None]) -> float:
        return normalize_playback_speed(speed)

    @staticmethod
    def build_atempo_filter(speed: Union[float, int, str, None]) -> str:
        return build_atempo_filter(speed)

    def _build_cmd(self, *args: str) -> List[str]:
        if self.binary_path.endswith(".js"):
            return ["node", self.binary_path, *args]
        return [self.binary_path, *args]

    def get_info(
        self,
        url_or_query: str,
        itag: Optional[int] = None,
        speed: Union[float, str, None] = None,
    ) -> TrackInfo:
        """Fetches track metadata and SABR format details."""
        target_itag = itag or self.default_itag
        spd = normalize_playback_speed(speed if speed is not None else self.default_speed)
        if self.server_url:
            params = urllib.parse.urlencode(
                {
                    "v": url_or_query,
                    "itag": str(target_itag),
                    "guest": "1" if self.force_guest else "0",
                    "speed": str(spd),
                }
            )
            with urllib.request.urlopen(f"{self.server_url}/info?{params}", timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return TrackInfo.from_dict(data)

        cmd = self._build_cmd("info", url_or_query, "-f", str(target_itag), "--speed", str(spd), "-j", "-q")
        if self.force_guest:
            cmd.append("--guest")
        out = subprocess.check_output(cmd, text=True, encoding="utf-8")
        return TrackInfo.from_dict(json.loads(out))

    info = get_info

    def search(self, query: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Searches YouTube in anonymous Guest mode."""
        if self.server_url:
            params = urllib.parse.urlencode({"q": query, "limit": str(limit)})
            with urllib.request.urlopen(f"{self.server_url}/search?{params}", timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8")).get("results", [])

        cmd = self._build_cmd("search", query, "-n", str(limit), "-j", "-q")
        out = subprocess.check_output(cmd, text=True, encoding="utf-8")
        return json.loads(out)

    def open_stream_pipe(
        self,
        url_or_query: str,
        itag: Optional[int] = None,
        start_ms: int = 0,
        loop: bool = False,
        speed: Union[float, str, None] = None,
    ) -> subprocess.Popen:
        """
        Spawns `ytdlm stream` and returns a `Popen` process whose `.stdout` is a live
        real-time WebM/Opus byte stream suitable for `discord.FFmpegOpusAudio(..., pipe=True)`.
        """
        target_itag = itag or self.default_itag
        spd = normalize_playback_speed(speed if speed is not None else self.default_speed)
        cmd = self._build_cmd(
            "stream",
            url_or_query,
            "-f",
            str(target_itag),
            "--start",
            str(start_ms),
            "--speed",
            str(spd),
            "-o",
            "-",
            "-q",
        )
        if self.force_guest:
            cmd.append("--guest")
        if loop:
            cmd.append("--loop")

        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=64 * 1024,
        )

    def get_stream_url(
        self,
        url_or_query: str,
        itag: Optional[int] = None,
        start_ms: int = 0,
        start_sec: Optional[float] = None,
        loop: bool = False,
        speed: Union[float, str, None] = None,
    ) -> str:
        """
        Returns an HTTP streaming URL when using `ytdlm serve` mode (default http://127.0.0.1:8787).
        Supports playback speed in [0.10, 4.00] (e.g. speed=0.10, speed=1.25, speed="0,75", speed=4.00).
        """
        base = self.server_url or "http://127.0.0.1:8787"
        target_itag = itag or self.default_itag
        effective_start_ms = int(start_sec * 1000) if start_sec is not None else int(start_ms)
        spd = normalize_playback_speed(speed if speed is not None else self.default_speed)
        params = urllib.parse.urlencode(
            {
                "v": url_or_query,
                "itag": str(target_itag),
                "guest": "1" if self.force_guest else "0",
                "start": str(max(0, effective_start_ms)),
                "loop": "1" if loop else "0",
                "speed": str(spd),
            }
        )
        return f"{base}/stream?{params}"

    def download(
        self,
        url_or_query: str,
        output_path: str,
        itag: Optional[int] = None,
        speed: Union[float, str, None] = None,
    ) -> str:
        """Downloads a 100% seekable `.opus` / `.webm` file with patched Duration, SeekHead & Cues."""
        target_itag = itag or self.default_itag
        spd = normalize_playback_speed(speed if speed is not None else self.default_speed)
        cmd = self._build_cmd(
            "download",
            url_or_query,
            "-f",
            str(target_itag),
            "--speed",
            str(spd),
            "-o",
            output_path,
            "-q",
        )
        if self.force_guest:
            cmd.append("--guest")
        subprocess.check_call(cmd)
        return output_path
