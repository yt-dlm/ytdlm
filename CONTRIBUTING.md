# Contributing to ytdlm

First off, thank you for considering contributing to **`ytdlm`**! Like `yt-dlp`, this project thrives on community contributions—whether you are updating InnerTube/SABR protocol fields, improving EBML/WebM container assembly, or expanding our multi-language Discord bot SDKs (`JavaScript`, `Python`, `Java`, `Rust`, `Go`, `C#`).

To keep the repository fast, maintainable, and legally protected for all contributors, please follow the guidelines below.

---

## 1. Mandatory Legal & Copyright Rules (The `yt-dlp` Golden Rules)

To protect the project and all contributors from DMCA notices or copyright claims, **every Pull Request, Issue, Commit Message, Test, and Documentation update MUST strictly adhere to these rules**:

1. **NO Copyrighted Commercial Media in Tests, Docs, or PRs**:
   - **Never** reference URLs, video IDs, titles, or lyrics of copyrighted commercial music or movies (e.g., Vevo, Sony, Universal, Warner) in code comments, unit tests (`test/`), documentation (`README.md`), or issue descriptions.
   - Always use **Creative Commons**, **Public Domain**, or **Open Source benchmark media**—such as the Blender Foundation's *Big Buck Bunny* (`aqz-KE-bpKQ`, licensed under CC-BY 3.0).
2. **NO DRM Circumvention**:
   - `ytdlm` only interacts with unencrypted media streams. Pull requests that attempt to bypass, decrypt, or circumvent Digital Rights Management (DRM) systems (such as Widevine, PlayReady, or FairPlay) will be rejected immediately.
3. **NO Hardcoded Credentials, Cookies, or Tokens**:
   - Never commit personal `auth.json` files, OAuth tokens, cookies, or private API keys.

---

## 2. Technical & Architecture Guidelines

1. **Zero External Dependencies in Core (`src/`)**:
   - The core engine (`src/*.js` and `bin/ytdlm.js`) must remain **100% free of third-party npm dependencies**, relying solely on built-in Node.js (`>= 18.0.0`) APIs (`fetch`, `stream`, `http`, `vm`, `crypto`, `fs`).
2. **Strict Guest Session Isolation for `itag 251`**:
   - Any changes to `src/innertube.js` must preserve strict isolation for `itag 251` (`TV_GUEST_SABR_251` with anonymous Guest `visitorData` and zero account tokens/cookies).
3. **Constant $O(1)$ Memory in Live Streams**:
   - Live streaming paths (`createSabrAudioStream`) must never retain emitted media clusters in memory (`retainClusters: false`) and must respect Node.js `Readable` stream backpressure.

---

## 3. Development & Pull Request Workflow

1. **Fork & Clone** the repository:
   ```bash
   git clone https://github.com/ytdlm/ytdlm.git
   cd ytdlm
   ```
2. **Run the Verification Suite**:
   Before submitting a Pull Request, ensure all metadata, live streaming Time-to-First-Byte, and HTTP server checks pass:
   ```bash
   npm test
   ```
3. **Commit Messages**:
   Use clear, concise English commit messages (e.g., `fix(protobuf): follow UMP part 43 SabrRedirect URLs`, `feat(sdk-rust): add loop parameter to spawn_stream`).

---

## 4. Contributor License & Protection

By submitting a contribution to `ytdlm`, you agree that your contribution is licensed under the project's **[MIT License](./LICENSE)** and covered by the **[Legal Disclaimer & Contributor Protection](./DISCLAIMER.md)**, which disclaims all warranties and liabilities to the fullest extent permitted by law.
