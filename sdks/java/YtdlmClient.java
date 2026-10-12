package dev.ytdlm;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * YtdlmClient — Java 11+ SDK for Real-Time YouTube SABR UMP Audio Streaming.
 *
 * Compatible with:
 * - JDA (Java Discord API)
 * - Lavaplayer / Lavalink (via HTTP Stream URL `getStreamUrl(...)` or `HttpAudioSourceManager`)
 * - Direct `ProcessBuilder` stdout `InputStream` pipe (`openStreamPipe(...)`)
 * - Real-time Playback Speed Control from 0.10x to 4.00x (`speed` parameter)
 */
public class YtdlmClient {

    public static final double MIN_PLAYBACK_SPEED = 0.10;
    public static final double MAX_PLAYBACK_SPEED = 4.00;

    private final String binaryPath;
    private final String serverUrl;
    private final int defaultItag;
    private final boolean forceGuest;
    private final HttpClient httpClient;

    public YtdlmClient() {
        this("ytdlm", "http://127.0.0.1:8787", 251, true);
    }

    public YtdlmClient(String binaryPath, String serverUrl, int defaultItag, boolean forceGuest) {
        this.binaryPath = binaryPath != null ? binaryPath : "ytdlm";
        this.serverUrl = serverUrl != null ? serverUrl.replaceAll("/+$", "") : "http://127.0.0.1:8787";
        this.defaultItag = defaultItag;
        this.forceGuest = forceGuest;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    /**
     * Normalizes and clamps playback speed to a 2-decimal float in [0.10, 4.00].
     */
    public static double normalizeSpeed(double speed) {
        if (!Double.isFinite(speed) || speed <= 0.0) {
            return 1.0;
        }
        double clamped = Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, speed));
        return Math.round(clamped * 100.0) / 100.0;
    }

    /**
     * Parses a string speed (supporting both "0.10" and "0,10") and clamps to [0.10, 4.00].
     */
    public static double normalizeSpeed(String speedStr) {
        if (speedStr == null || speedStr.trim().isEmpty()) {
            return 1.0;
        }
        try {
            double val = Double.parseDouble(speedStr.trim().replace(',', '.'));
            return normalizeSpeed(val);
        } catch (NumberFormatException e) {
            return 1.0;
        }
    }

    /**
     * Builds an FFmpeg `atempo` filter chain for any speed in [0.10, 4.00].
     */
    public static String buildAtempoFilter(double speed) {
        double spd = normalizeSpeed(speed);
        if (Math.abs(spd - 1.0) < 1e-4) {
            return "atempo=1.0";
        }
        List<String> stages = new ArrayList<>();
        double rem = spd;
        while (rem < 0.5 - 1e-6) {
            stages.add("atempo=0.5");
            rem /= 0.5;
        }
        while (rem > 2.0 + 1e-6) {
            stages.add("atempo=2.0");
            rem /= 2.0;
        }
        double finalStage = Math.round(rem * 10000.0) / 10000.0;
        if (Math.abs(finalStage - 1.0) > 1e-4 || stages.isEmpty()) {
            stages.add(String.format(Locale.US, "atempo=%s", finalStage));
        }
        return String.join(",", stages);
    }

    /**
     * Returns a direct HTTP streaming URL for Lavaplayer / Lavalink `playerManager.loadItem(...)`.
     * Requires `ytdlm serve --port 8787` running locally or in a sidecar container.
     */
    public String getStreamUrl(String videoUrlOrQuery) {
        return getStreamUrl(videoUrlOrQuery, this.defaultItag, 0L, 1.0);
    }

    public String getStreamUrl(String videoUrlOrQuery, int itag, long startTimeMs) {
        return getStreamUrl(videoUrlOrQuery, itag, startTimeMs, 1.0);
    }

    public String getStreamUrl(String videoUrlOrQuery, int itag, long startTimeMs, double speed) {
        String encodedV = URLEncoder.encode(videoUrlOrQuery, StandardCharsets.UTF_8);
        String guestFlag = this.forceGuest ? "1" : "0";
        double spd = normalizeSpeed(speed);
        return String.format(Locale.US, "%s/stream?v=%s&itag=%d&guest=%s&start=%d&speed=%.2f",
                this.serverUrl, encodedV, itag, guestFlag, Math.max(0L, startTimeMs), spd);
    }

    /**
     * Fetches JSON metadata from the `ytdlm serve` HTTP gateway.
     */
    public String getInfoJsonViaHttp(String videoUrlOrQuery) throws IOException, InterruptedException {
        String encodedV = URLEncoder.encode(videoUrlOrQuery, StandardCharsets.UTF_8);
        String guestFlag = this.forceGuest ? "1" : "0";
        String url = String.format("%s/info?v=%s&itag=%d&guest=%s",
                this.serverUrl, encodedV, this.defaultItag, guestFlag);

        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(15))
                .GET()
                .build();

        HttpResponse<String> resp = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
        if (resp.statusCode() != 200) {
            throw new IOException("ytdlm HTTP /info error " + resp.statusCode() + ": " + resp.body());
        }
        return resp.body();
    }

    /**
     * Spawns `ytdlm stream <url> -o -` as a child process and returns the live Process.
     * Read live WebM/Opus audio chunks immediately via `process.getInputStream()`.
     */
    public Process openStreamProcess(String videoUrlOrQuery, int itag, long startTimeMs) throws IOException {
        return openStreamProcess(videoUrlOrQuery, itag, startTimeMs, 1.0);
    }

    public Process openStreamProcess(String videoUrlOrQuery, int itag, long startTimeMs, double speed) throws IOException {
        double spd = normalizeSpeed(speed);
        List<String> cmd = buildCommand(
                "stream",
                videoUrlOrQuery,
                "-f", String.valueOf(itag),
                "--start", String.valueOf(Math.max(0L, startTimeMs)),
                "--speed", String.format(Locale.US, "%.2f", spd),
                "-o", "-",
                "-q"
        );
        if (this.forceGuest) {
            cmd.add("--guest");
        }
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
        return pb.start();
    }

    public InputStream openStreamPipe(String videoUrlOrQuery) throws IOException {
        return openStreamProcess(videoUrlOrQuery, this.defaultItag, 0L, 1.0).getInputStream();
    }

    public InputStream openStreamPipe(String videoUrlOrQuery, double speed) throws IOException {
        return openStreamProcess(videoUrlOrQuery, this.defaultItag, 0L, speed).getInputStream();
    }

    /**
     * Fetches JSON metadata via CLI (`ytdlm info <url> -j -q`).
     */
    public String getInfoJsonViaCli(String videoUrlOrQuery) throws IOException, InterruptedException {
        List<String> cmd = buildCommand("info", videoUrlOrQuery, "-f", String.valueOf(this.defaultItag), "-j", "-q");
        if (this.forceGuest) {
            cmd.add("--guest");
        }
        Process proc = new ProcessBuilder(cmd).start();
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
        }
        int code = proc.waitFor();
        if (code != 0) {
            throw new IOException("ytdlm CLI exited with code " + code);
        }
        return sb.toString();
    }

    private List<String> buildCommand(String... args) {
        List<String> cmd = new ArrayList<>();
        if (this.binaryPath.endsWith(".js")) {
            cmd.add("node");
        }
        cmd.add(this.binaryPath);
        for (String a : args) {
            cmd.add(a);
        }
        return cmd;
    }
}
