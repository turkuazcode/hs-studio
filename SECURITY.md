# Security policy

> **Türkçe özet:** Güvenlik açıklarını herkese açık issue/PR/tartışma olarak paylaşmayın.
> Özel bildirim adresi: **turkuazcode@gmail.com** (e-posta konusu "SECURITY:" ile başlasın). Bildirimde etkilenen sürüm/commit, işletim sistemi,
> yeniden üretme adımları ve etkisi olsun; kişisel medya dosyası göndermeyin.

## Supported versions

HS Studio is in alpha. Fixes go to the default branch and ship in the next 0.1.x release; older
releases do not receive fixes.

| Version | Supported |
|---|---|
| latest 0.1.x release | yes |
| default branch | yes |
| older releases | no |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

Report privately by e-mail to **turkuazcode@gmail.com**, with a subject starting with
`SECURITY:`. GitHub private vulnerability reporting
("Security" tab → "Report a vulnerability") may be enabled as a second channel.

Please include:

- affected version or commit, OS and architecture, and which playback engine was active
  (libmpv or the HTML5 fallback);
- steps to reproduce, ideally with a **small synthetic** file (never send personal photos or
  videos), and the impact you observed or expect;
- whether the issue is already public anywhere.

What to expect (targets, not guarantees, for a small volunteer project): acknowledgement within
7 days, an assessment within 30 days, and coordinated disclosure after a fix is available or
90 days, whichever comes first. Credit is given in the changelog unless you prefer otherwise.

## Scope

In scope: the HS Studio application and its source in this repository, including

- Tauri IPC commands and capabilities (file read/write/delete/rename outside what the user chose,
  process execution, path traversal, symlink/UNC tricks);
- parsing of untrusted media, subtitles, playlists, EXIF/metadata, ZIP archives and URLs;
- the AI model manager (download URL pinning, SHA-256 verification, extraction);
- the way HS Studio launches ffmpeg/ffprobe and loads libmpv;
- privacy: HS Studio has no telemetry, and media is never uploaded; anything that sends user data
  off the machine is a security bug.

Out of scope here (report upstream, but tell us if HS Studio ships an affected version): vulnerabilities
in libmpv, FFmpeg, the MSYS2 DLLs, WebView2, ONNX Runtime Web or the AI models themselves. The
exact versions HS Studio ships are in [legal/inventory/](legal/inventory/) and the SBOM in
[legal/sbom/](legal/sbom/).

## For maintainers

Release blockers (plan 14/Q04): known critical/high issues that cause data loss or unauthorized
file/process operations. Dependency scan findings are triaged for reachability and version, not
silently allow-listed.
