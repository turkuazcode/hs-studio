//! Coded errors of the AI component manager. The frontend shows `aiModels.errors.<code>`
//! (i18n); `detail` is technical context for logs only and is never the user-facing text.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// No such component in the manifest
    UnknownComponent,
    /// Component files are not on disk (install first)
    NotInstalled,
    /// Connection failed / dropped / timed out / HTTP error, after the bounded retries
    DownloadNetwork,
    /// Size or SHA-256 differs from the manifest (download or file on disk)
    Checksum,
    /// Not enough free space on the target volume
    DiskFull,
    /// The data folder is not writable
    Permission,
    /// Cancelled by the requester
    Cancelled,
    /// The manifest entry has no license/author information (never downloaded)
    LicenseUnavailable,
    /// The component is used by a running job (remove refused)
    InUse,
    /// A download / verification of the component is running (remove refused)
    Busy,
    /// Archive is malformed or contains a forbidden entry (symlink, encrypted, method...)
    ArchiveInvalid,
    /// Other file system error
    Io,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: ErrorCode,
    pub detail: String,
}

impl AiError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    /// File system error, classified (disk full / permission / other).
    pub fn io(context: &str, e: &std::io::Error) -> Self {
        Self::new(io_code(e), format!("{context}: {e}"))
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.detail)
    }
}

pub fn io_code(e: &std::io::Error) -> ErrorCode {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded => return ErrorCode::DiskFull,
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => return ErrorCode::Permission,
        _ => {}
    }
    // ERROR_HANDLE_DISK_FULL (39) / ERROR_DISK_FULL (112) on Windows, ENOSPC (28) elsewhere
    match (cfg!(windows), e.raw_os_error()) {
        (true, Some(39 | 112)) | (false, Some(28)) => ErrorCode::DiskFull,
        _ => ErrorCode::Io,
    }
}

pub type AiResult<T> = Result<T, AiError>;
