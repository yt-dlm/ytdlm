# ytdlm (Python SDK)

Python SDK and `discord.py` voice helper for **[ytdlm](https://github.com/yt-dlm/ytdlm)** — a Real-Time SABR UMP WebM/Opus (`251` / `774`) Audio Streaming & Seekable Downloading Engine.

## Installation

```bash
pip install ytdlm
```

*(Requires the `ytdlm` Node.js CLI or HTTP Gateway: `npm install -g ytdlm`)*

## Quick Start

```python
from ytdlm import YtdlmClient

client = YtdlmClient(gateway_url="http://127.0.0.1:8787")

# 1. Resolve track metadata (with optional speed 0.10..4.00)
info = client.get_info("aqz-KE-bpKQ", speed="1,25")
print(info.title, info.duration_sec, info.speed, info.atempo_filter)

# 2. Build direct HTTP stream URL for FFmpegOpusAudio (with instant seek, speed & loop)
stream_url = client.get_stream_url("aqz-KE-bpKQ", start_ms=30000, loop=True, speed=1.25)
```

### `discord.py` Bot Integration

```python
import discord
from ytdlm import YtdlmClient

ytdlm = YtdlmClient(server_url="http://127.0.0.1:8787")
source = await discord.FFmpegOpusAudio.from_probe(
    ytdlm.get_stream_url("aqz-KE-bpKQ", start_ms=0, speed="1,25")
)
voice_client.play(source)
```

## License

[MIT License](https://github.com/yt-dlm/ytdlm/blob/main/LICENSE) — See also [Legal Disclaimer](https://github.com/yt-dlm/ytdlm/blob/main/DISCLAIMER.md).
