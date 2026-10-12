"""
Example: Discord.py Music Bot using `ytdlm` Real-Time SABR UMP Pipe
===================================================================
Demonstrates both:
  1. Subprocess Pipe Mode (`pipe=True` with `-c:a copy` so FFmpeg only remuxes Opus packets without CPU re-encoding).
  2. HTTP Gateway Mode (`http://127.0.0.1:8787/stream?v=...`).
"""

import discord
from discord.ext import commands
from ytdlm import YtdlmClient

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

# Initialize ytdlm (Guest TVHTML5 ITAG 251 by default)
ytdlm = YtdlmClient(default_itag=251, force_guest=True)


@bot.command(name="play")
async def play(ctx: commands.Context, *, query: str):
    if not ctx.author.voice or not ctx.author.voice.channel:
        return await ctx.send("Please join a voice channel first!")

    voice_channel = ctx.author.voice.channel
    vc: discord.VoiceClient = ctx.voice_client or await voice_channel.connect()

    if vc.is_playing():
        vc.stop()

    track = ytdlm.get_info(query)
    proc = ytdlm.open_stream_pipe(track.video_id, itag=track.itag)

    # Because ytdlm outputs native 48kHz stereo WebM/Opus, `-c:a copy` copies Opus frames directly!
    audio_source = discord.FFmpegOpusAudio(
        proc.stdout,
        pipe=True,
        codec="copy",
    )

    def after_play(err):
        try:
            proc.terminate()
        except Exception:
            pass
        if err:
            print(f"[ytdlm] Playback error: {err}")

    vc.play(audio_source, after=after_play)
    await ctx.send(
        f"▶️ Now streaming (**{track.mode}**, `{track.abr_kbps}kbps` Opus): **{track.title}** — *{track.author}*"
    )


if __name__ == "__main__":
    # Replace with your Discord Bot Token:
    # bot.run("YOUR_DISCORD_BOT_TOKEN")
    pass
