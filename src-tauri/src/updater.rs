//! Signed self-update (plan 14/R02, updater card) on top of `tauri-plugin-updater`.
//!
//! - Off by default: the frontend only checks when the user enabled "check for updates"
//!   (Settings > General) or clicks "check now". Nothing is downloaded without a click.
//! - The endpoint and public key come from `plugins.updater` in tauri.conf.json. Until the public
//!   repository exists both are empty and every check answers `not-configured` (no network use).
//! - Every artifact is verified against the minisign public key, and the signed version in the
//!   signature's trusted comment must match the announced version (`requireSignedVersion`), so an
//!   old genuine artifact cannot be replayed as a "newer" release. Older or equal versions are
//!   never offered (the plugin's default comparator).
//! - Errors are reduced to a short code for the UI: `offline` stays quiet, `signature` /
//!   `download` / `error` are shown only after a user action.
//!
//! Tests (tests/e2e/updater.e2e.mjs) point the app at a loopback manifest server with a throwaway
//! key generated at test time: `VHO_UPDATER_TEST_ENDPOINT` + `VHO_UPDATER_TEST_PUBKEY`, honoured only
//! for an `http://127.0.0.1:` / `http://localhost:` URL in an isolated test instance
//! (`VHO_DATA_DIR` set). `VHO_UPDATER_DRY_RUN=1` stops after download + verification.
use serde::Serialize;
use serde_json::json;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// The release found by the last successful check, installed by `updater_install`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// available | none | offline | not-configured | signature | error
    status: &'static str,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    error: Option<String>,
}

fn is_loopback_http(url: &str) -> bool {
    ["http://127.0.0.1:", "http://localhost:"].iter().any(|p| url.starts_with(p))
}

/// Test instances only: replace the updater configuration with a loopback endpoint and a
/// throwaway public key (see module docs). Must run before the plugin is set up.
pub fn apply_test_overrides<R: Runtime>(context: &mut tauri::Context<R>) {
    if crate::platform::data_dir_override().is_none() {
        return;
    }
    let (Ok(endpoint), Ok(pubkey)) = (std::env::var("VHO_UPDATER_TEST_ENDPOINT"), std::env::var("VHO_UPDATER_TEST_PUBKEY")) else {
        return;
    };
    if !is_loopback_http(&endpoint) || pubkey.trim().is_empty() {
        return;
    }
    context.config_mut().plugins.0.insert(
        "updater".into(),
        json!({
            "pubkey": pubkey,
            "endpoints": [endpoint],
            "dangerousInsecureTransportProtocol": true,
            "requireSignedVersion": true,
            "windows": { "installMode": "passive" }
        }),
    );
}

/// Endpoint and public key are both set (tauri.conf.json or the test override).
fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    let cfg = app.config().plugins.0.get("updater");
    let pubkey = cfg.and_then(|c| c.get("pubkey")).and_then(|v| v.as_str()).unwrap_or("");
    let endpoints = cfg.and_then(|c| c.get("endpoints")).and_then(|v| v.as_array()).map_or(0, Vec::len);
    !pubkey.trim().is_empty() && endpoints > 0
}

/// Short, stable code for the UI (texts are translated in the frontend).
pub fn classify(e: &Error) -> &'static str {
    match e {
        Error::EmptyEndpoints => "not-configured",
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => "offline",
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => "signature",
        _ => "error",
    }
}

fn result(status: &'static str, current: &str) -> CheckResult {
    CheckResult { status, current_version: current.to_string(), version: None, notes: None, error: None }
}

#[tauri::command]
pub async fn updater_check<R: Runtime>(app: AppHandle<R>, pending: State<'_, PendingUpdate>) -> Result<CheckResult, String> {
    let current = app.package_info().version.to_string();
    if !configured(&app) {
        return Ok(result("not-configured", &current));
    }
    let updater = match app.updater_builder().timeout(Duration::from_secs(20)).build() {
        Ok(u) => u,
        Err(e) => return Ok(CheckResult { error: Some(e.to_string()), ..result(classify(&e), &current) }),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let r = CheckResult {
                version: Some(update.version.clone()),
                notes: update.body.clone(),
                ..result("available", &current)
            };
            *pending.0.lock().unwrap() = Some(update);
            Ok(r)
        }
        Ok(None) => {
            *pending.0.lock().unwrap() = None;
            Ok(result("none", &current))
        }
        Err(e) => Ok(CheckResult { error: Some(e.to_string()), ..result(classify(&e), &current) }),
    }
}

/// Downloads the pending update, verifies its signature and signed version, then starts the
/// installer (Windows: the NSIS installer in passive mode; the app exits). Errors: `"<code>: <detail>"`.
#[tauri::command]
pub async fn updater_install(pending: State<'_, PendingUpdate>) -> Result<&'static str, String> {
    let update = pending.0.lock().unwrap().clone().ok_or("none: no pending update (check first)")?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("{}: {e}", match classify(&e) { "offline" => "download", c => c }))?;
    let dry_run = crate::platform::data_dir_override().is_some()
        && std::env::var("VHO_UPDATER_DRY_RUN").is_ok_and(|v| v == "1");
    if dry_run {
        return Ok("verified");
    }
    update.install(bytes).map_err(|e| format!("{}: {e}", classify(&e)))?;
    Ok("installing")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_only_for_test_endpoints() {
        assert!(is_loopback_http("http://127.0.0.1:10950/latest.json"));
        assert!(is_loopback_http("http://localhost:10950/x"));
        assert!(!is_loopback_http("https://127.0.0.1:10950/x"));
        assert!(!is_loopback_http("http://example.com/latest.json"));
        assert!(!is_loopback_http("http://127.0.0.1.evil.com/x"));
    }

    #[test]
    fn error_codes() {
        assert_eq!(classify(&Error::EmptyEndpoints), "not-configured");
        assert_eq!(classify(&Error::ReleaseNotFound), "offline");
        assert_eq!(classify(&Error::Network("x".into())), "offline");
        assert_eq!(classify(&Error::MissingSignedVersion), "signature");
        assert_eq!(classify(&Error::UnsupportedOs), "error");
    }
}
