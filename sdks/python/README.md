# ytdlm (Python SDK)

Python SDK and `discord.py` voice helper for **[ytdlm](https://github.com/ytdlm/ytdlm)** — a Real-Time SABR UMP WebM/Opus (`251` / `774`) Audio Streaming & Seekable Downloading Engine.

## Installation

```bash
pip install ytdlm
```

*(Requires the `ytdlm` Node.js CLI or HTTP Gateway: `npm install -g ytdlm`)*

## Quick Start

```python
from ytdlm import YtdlmClient

client = YtdlmClient(gateway_url="http://127.0.0.1:8787")

# 1. Resolve track metadata
info = client.info("aqz-KE-bpKQ")
print(info.title, info.duration_sec)

# 2. Build direct HTTP stream URL for FFmpegOpusAudio (with instant seek & loop)
stream_url = client.get_stream_url("aqz-KE-bpKQ", start_sec=30, loop=True)
```

### `discord.py` Bot Integration

```python
import discord
from ytdlm import YtdlmClient

ytdlm = YtdlmClient("http://127.0.0.1:8787")
source = await discord.FFmpegOpusAudio.from_probe(
    ytdlm.get_stream_url("aqz-KE-bpKQ", start_sec=0)
)
voice_client.play(source)
```

## License

[MIT License](https://github.com/ytdlm/ytdlm/blob/main/LICENSE) — See also [Legal Disclaimer](https://github.com/ytdlm/ytdlm/blob/main/DISCLAIMER.md).
