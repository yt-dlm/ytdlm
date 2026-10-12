"""
ytdlm Python SDK — Real-Time YouTube SABR UMP Audio Streamer & Client
=====================================================================
Supports two zero-latency modes for Python apps and `discord.py` / `py-cord` / `nextcord` bots:
1. Subprocess Pipe Mode (`open_stream_pipe`): Spawns `ytdlm stream <url> -o -` and yields a live
   stdout binary pipe of WebM/Opus audio chunks (starts in ~300ms).
2. HTTP Gateway Mode (`get_stream_url`): Connects to `ytdlm serve` HTTP micro-server (`http://127.0.0.1:8787`)
   so FFmpeg or `discord.FFmpegOpusAudio` can stream directly via HTTP URL.
"""

from __future__ import annotations
import json
import shutil
import subprocess
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


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
    stream_url: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "TrackInfo":
        return cls(
            video_id=data.get("videoId") or data.get("id", ""),
            title=data.get("title", "YouTube Audio"),
            author=data.get("author") or data.get("uploader", ""),
            duration_sec=int(data.get("durationSec") or data.get("duration") or 0),
            duration_ms=int(data.get("durationMs") or 0),
            url=data.get("url") or data.get("webpage_url", ""),
            thumbnail=data.get("thumbnail"),
            itag=int(data.get("itag") or 251),
            abr_kbps=int(data.get("abr") or round(int(data.get("bitrate", 135000)) / 1000)),
            sample_rate=int(data.get("sampleRate") or data.get("asr") or 48000),
            channels=int(data.get("channels") or data.get("audio_channels") or 2),
            is_guest=bool(data.get("isGuest", True)),
            mode=data.get("mode", "TV_GUEST_SABR_251"),
            stream_url=data.get("streamUrl"),
        )


class YtdlmClient:
    def __init__(
        self,
        binary_path: Optional[str] = None,
        server_url: Optional[str] = None,
        default_itag: int = 251,
        force_guest: bool = True,
    ):
        """
        :param binary_path: Path to `ytdlm` CLI or `node /path/to/ytdlm/bin/ytdlm.js`.
        :param server_url: Optional URL of running `ytdlm serve` instance (e.g. "http://127.0.0.1:8787").
        :param default_itag: 251 (Guest ~160kbps Opus) or 774 (TV Premium ~256kbps Opus).
        :param force_guest: Force anonymous Guest TVHTML5 mode (default True for 251).
        """
        self.binary_path = binary_path or shutil.which("ytdlm") or "ytdlm"
        self.server_url = server_url.rstrip("/") if server_url else None
        self.default_itag = default_itag
        self.force_guest = force_guest

    def _build_cmd(self, *args: str) -> List[str]:
        if self.binary_path.endswith(".js"):
            return ["node", self.binary_path, *args]
        return [self.binary_path, *args]

    def get_info(self, url_or_query: str, itag: Optional[int] = None) -> TrackInfo:
        """Fetches track metadata and SABR format details."""
        target_itag = itag or self.default_itag
        if self.server_url:
            params = urllib.parse.urlencode(
                {
                    "v": url_or_query,
                    "itag": str(target_itag),
                    "guest": "1" if self.force_guest else "0",
                }
            )
            with urllib.request.urlopen(f"{self.server_url}/info?{params}", timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return TrackInfo.from_dict(data)

        cmd = self._build_cmd("info", url_or_query, "-f", str(target_itag), "-j", "-q")
        if self.force_guest:
            cmd.append("--guest")
        out = subprocess.check_output(cmd, text=True, encoding="utf-8")
        return TrackInfo.from_dict(json.loads(out))

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
    ) -> subprocess.Popen:
        """
        Spawns `ytdlm stream` and returns a `Popen` process whose `.stdout` is a live
        real-time WebM/Opus byte stream suitable for `discord.FFmpegOpusAudio(..., pipe=True)`.
        """
        target_itag = itag or self.default_itag
        cmd = self._build_cmd(
            "stream",
            url_or_query,
            "-f",
            str(target_itag),
            "--start",
            str(start_ms),
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
        loop: bool = False,
    ) -> str:
        """
        Returns an HTTP streaming URL when using `ytdlm serve` mode (default http://127.0.0.1:8787).
        """
        base = self.server_url or "http://127.0.0.1:8787"
        target_itag = itag or self.default_itag
        params = urllib.parse.urlencode(
            {
                "v": url_or_query,
                "itag": str(target_itag),
                "guest": "1" if self.force_guest else "0",
                "start": str(start_ms),
                "loop": "1" if loop else "0",
            }
        )
        return f"{base}/stream?{params}"

    def download(self, url_or_query: str, output_path: str, itag: Optional[int] = None) -> str:
        """Downloads a 100% seekable `.opus` file with patched Duration, SeekHead & Cues."""
        target_itag = itag or self.default_itag
        cmd = self._build_cmd("download", url_or_query, "-f", str(target_itag), "-o", output_path, "-q")
        if self.force_guest:
            cmd.append("--guest")
        subprocess.check_call(cmd)
        return output_path
