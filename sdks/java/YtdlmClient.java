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

/**
 * YtdlmClient — Java 11+ SDK for Real-Time YouTube SABR UMP Audio Streaming.
 *
 * Compatible with:
 * - JDA (Java Discord API)
 * - Lavaplayer / Lavalink (via HTTP Stream URL `getStreamUrl(...)` or `HttpAudioSourceManager`)
 * - Direct `ProcessBuilder` stdout `InputStream` pipe (`openStreamPipe(...)`)
 */
public class YtdlmClient {

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
     * Returns a direct HTTP streaming URL for Lavaplayer / Lavalink `playerManager.loadItem(...)`.
     * Requires `ytdlm serve --port 8787` running locally or in a sidecar container.
     *
     * Example in JDA + Lavaplayer:
     *   String streamUrl = ytdlm.getStreamUrl("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
     *   playerManager.loadItem(streamUrl, audioLoadResultHandler);
     */
    public String getStreamUrl(String videoUrlOrQuery) {
        return getStreamUrl(videoUrlOrQuery, this.defaultItag, 0);
    }

    public String getStreamUrl(String videoUrlOrQuery, int itag, long startTimeMs) {
        String encodedV = URLEncoder.encode(videoUrlOrQuery, StandardCharsets.UTF_8);
        String guestFlag = this.forceGuest ? "1" : "0";
        return String.format("%s/stream?v=%s&itag=%d&guest=%s&start=%d",
                this.serverUrl, encodedV, itag, guestFlag, startTimeMs);
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
        List<String> cmd = buildCommand(
                "stream",
                videoUrlOrQuery,
                "-f", String.valueOf(itag),
                "--start", String.valueOf(startTimeMs),
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
        return openStreamProcess(videoUrlOrQuery, this.defaultItag, 0).getInputStream();
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
