#!/usr/bin/env bash
# Linux developer environment for VHO (P03). Tested on Ubuntu 24.04 (WSL2 + WSLg).
# Installs: build tools, Tauri v2 / WebKitGTK 4.1 deps, the build deps of the LGPL
# libmpv/FFmpeg recipe (third_party/mpv/build-linux.sh), Rust (pinned) and Node (pinned).
# Does NOT install the distribution's mpv/libmpv/ffmpeg (those are GPL builds).
#   sudo bash scripts/linux/setup-dev.sh
set -euo pipefail

RUST_VERSION=1.99.1
NODE_VERSION=24.20.0

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential pkg-config git curl ca-certificates xz-utils file patchelf python3 \
  meson ninja-build nasm \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
  libass-dev libfreetype-dev libharfbuzz-dev libfribidi-dev libfontconfig-dev libdav1d-dev liblcms2-dev \
  libuchardet-dev libjpeg-dev zlib1g-dev libva-dev libdrm-dev \
  libwayland-dev wayland-protocols libxkbcommon-dev libegl-dev libgl-dev libgles-dev libvulkan-dev \
  libplacebo-dev libpulse-dev libpipewire-0.3-dev libasound2-dev \
  mesa-utils vainfo pulseaudio-utils fonts-dejavu-core

# Rust (rustup, minimal profile, same toolchain as Windows)
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$RUST_VERSION"
fi
"$HOME/.cargo/bin/rustup" toolchain install "$RUST_VERSION" --profile minimal
"$HOME/.cargo/bin/rustup" default "$RUST_VERSION"

# Node (official tarball, pinned)
if [ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sed 's/node-v.*/node.tar.xz/' | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$tmp/node.tar.xz" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /opt/node/bin/npm /opt/node/bin/npx /usr/local/bin/
  rm -rf "$tmp"
fi

"$HOME/.cargo/bin/rustc" --version
node --version
pkg-config --modversion webkit2gtk-4.1 libplacebo
