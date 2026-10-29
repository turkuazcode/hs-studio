# Code signing policy

HS Studio's Windows release files are meant to be signed through the free code signing program for
open-source projects:

> Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
> [SignPath Foundation](https://signpath.org/).

**Status:** applying. Until SignPath accepts the project, release files are unsigned and their names
say so (`…-UNSIGNED-setup.exe`). This page will be updated when signing starts.

## What is signed

Only files built from this repository by the release workflow are signed:

- the HS Studio program (`HS Studio.exe`)
- the Windows installer (`HS Studio_<version>_x64-setup.exe`)

Third-party files that ship with the app are **not** signed by this project. These are the LGPL
libmpv / FFmpeg DLLs and their dependencies, built from source in CI
([third_party/mpv/build-windows.md](third_party/mpv/build-windows.md)). They are distributed as built,
and they are listed with their SHA-256 hashes in
[legal/inventory/native-windows-x64.json](legal/inventory/native-windows-x64.json).

## How files are built and signed

- Every signed file is built by GitHub Actions from a public commit of this repository, using
  [.github/workflows/release.yml](.github/workflows/release.yml). Nothing built on a personal
  computer is ever signed.
- The release workflow runs every test layer against the exact program file it later ships: unit,
  Rust, end-to-end, real AI, quality and installer tests. A release gate
  ([scripts/release-gate.mjs](scripts/release-gate.mjs)) must pass before a release candidate exists.
  Its report (`release-gate.md`) is attached to every release.
- The signing key is held by SignPath in a hardware security module. It is never in this repository,
  in CI secrets or on any developer machine.
- Each signing request needs a manual approval in SignPath.
- Each release publishes `SHA256SUMS.txt` and a CycloneDX SBOM (`*.cdx.json`) next to the installer.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [TurkuazCode](https://github.com/turkuazcode) |
| Approvers | [TurkuazCode](https://github.com/turkuazcode) |

Outside contributions come in as pull requests. A committer reviews them before merging, and they are
signed off under the [DCO](CONTRIBUTING.md). Pull requests from forks never have access to the signing
secrets.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it.

HS Studio has no account, no telemetry and no ads, and media files are never uploaded. It goes online
only for actions the user starts:

- opening a network stream or URL;
- downloading an AI model after the user agrees (from the model's pinned source, with a size and
  SHA-256 check);
- showing a photo's location on a map (OpenStreetMap tiles);
- casting to a device on the local network;
- opening a link in the default browser.

## Reporting a problem

To report a security issue, or a signed file that you think was not built by this project, follow
[SECURITY.md](SECURITY.md). Do not open a public issue for it.
