# Security policy

> **Türkçe özet:** Güvenlik açıklarını herkese açık issue/PR/tartışma olarak paylaşmayın.
> Özel bildirim kanalı **henüz tanımlanmadı** (aşağıdaki yer tutucu); ilk herkese açık sürümden
> önce proje sahibi tarafından doldurulacak. Bildirimde etkilenen sürüm/commit, işletim sistemi,
> yeniden üretme adımları ve etkisi olsun; kişisel medya dosyası göndermeyin.

## Supported versions

VHO has not had a public release yet. Until it does, only the latest commit of the default branch
receives fixes. This table will list supported release lines once releases exist.

| Version | Supported |
|---|---|
| unreleased (default branch) | yes |

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for a security problem.**

> **PLACEHOLDER — private reporting channel not set up yet.**
> Before the first public release the maintainer must replace this block with one real channel,
> for example GitHub private vulnerability reporting ("Security" tab → "Report a vulnerability")
> on the published repository, or a dedicated security mailbox. Until then there is no
> confidential channel; do not post details publicly — contact the maintainer through the
> repository owner's profile and ask for a private channel first.

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

In scope: the VHO application and its source in this repository, including

- Tauri IPC commands and capabilities (file read/write/delete/rename outside what the user chose,
  process execution, path traversal, symlink/UNC tricks);
- parsing of untrusted media, subtitles, playlists, EXIF/metadata, ZIP archives and URLs;
- the AI model manager (download URL pinning, SHA-256 verification, extraction);
- the way VHO launches ffmpeg/ffprobe and loads libmpv;
- privacy: VHO has no telemetry, and media is never uploaded; anything that sends user data
  off the machine is a security bug.

Out of scope here (report upstream, but tell us if VHO ships an affected version): vulnerabilities
in libmpv, FFmpeg, the MSYS2 DLLs, WebView2, ONNX Runtime Web or the AI models themselves. The
exact versions VHO ships are in [legal/inventory/](legal/inventory/) and the SBOM in
[legal/sbom/](legal/sbom/).

## For maintainers

Release blockers (plan 14/Q04): known critical/high issues that cause data loss or unauthorized
file/process operations. Dependency scan findings are triaged for reachability and version, not
silently allow-listed.
