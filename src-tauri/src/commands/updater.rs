//! In-app updater: check GitHub releases for a newer signed build, download it and restart.
//!
//! The plugin verifies the minisign signature of every download against `plugins.updater.pubkey`
//! (never bypassed here). A build is "configured" for updates only when that pubkey is not the
//! committed placeholder (see `src-tauri/updater.pub`) and the endpoint serves a manifest.

use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// The throwaway public key committed in `updater.pub` until the maintainer generates a real
/// key pair. Its private half was discarded, so nothing can ever be signed for it: a build that
/// still carries it reports "Updates are not configured".
pub const PLACEHOLDER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENDOEM1MjQ4MDFGNUNBMkYKUldRdnl2VUJTRktNekZtOC9OTzJlTFR3ck0waUt2c25ZZFVvS3FvTGZBTVNCLzFNVUJyUEMxaEUK";

/// Event carrying `{ downloaded, total }` (bytes; `total` is `null` when the server sent no length).
pub const PROGRESS_EVENT: &str = "update://progress";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
  pub configured: bool,
  pub available: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub version: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub notes: Option<String>,
}

impl UpdateCheck {
  fn not_configured() -> Self {
    Self { configured: false, available: false, version: None, notes: None }
  }
  fn up_to_date() -> Self {
    Self { configured: true, available: false, version: None, notes: None }
  }
}

#[derive(Debug, Serialize, Clone)]
struct Progress {
  downloaded: u64,
  total: Option<u64>,
}

/// True when `pubkey` is a real key (non-empty and not the committed placeholder).
pub fn is_configured(pubkey: &str) -> bool {
  let key = pubkey.trim();
  !key.is_empty() && key != PLACEHOLDER_PUBKEY
}

fn parse_version(s: &str) -> Option<Version> {
  Version::parse(s.trim().trim_start_matches('v')).ok()
}

/// True when `candidate` is a strictly newer semver than `current` (a leading `v` is ignored,
/// `1.0.0-beta.1 < 1.0.0`, build metadata is ignored by semver precedence). Unparseable input
/// is never "newer", so a malformed manifest cannot trigger an install.
pub fn is_newer(current: &str, candidate: &str) -> bool {
  match (parse_version(current), parse_version(candidate)) {
    (Some(cur), Some(cand)) => cand.cmp_precedence(&cur).is_gt(),
    _ => false,
  }
}

/// How a failed check should be reported.
#[derive(Debug, PartialEq, Eq)]
enum CheckFailure {
  /// The endpoint has no (valid) manifest: 404, empty release, malformed JSON.
  NoManifest,
  Other,
}

fn classify(err: &tauri_plugin_updater::Error) -> CheckFailure {
  use tauri_plugin_updater::Error;
  match err {
    Error::ReleaseNotFound | Error::Serialization(_) | Error::EmptyEndpoints => CheckFailure::NoManifest,
    _ => CheckFailure::Other,
  }
}

fn configured_pubkey(app: &AppHandle) -> String {
  app
    .config()
    .plugins
    .0
    .get("updater")
    .and_then(|v| v.get("pubkey"))
    .and_then(|v| v.as_str())
    .unwrap_or_default()
    .to_string()
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheck, String> {
  if !is_configured(&configured_pubkey(&app)) {
    return Ok(UpdateCheck::not_configured());
  }
  let updater = app.updater().map_err(|e| e.to_string())?;
  match updater.check().await {
    Ok(Some(update)) if is_newer(&update.current_version, &update.version) => Ok(UpdateCheck {
      configured: true,
      available: true,
      version: Some(update.version),
      notes: update.body,
    }),
    Ok(_) => Ok(UpdateCheck::up_to_date()),
    Err(e) if classify(&e) == CheckFailure::NoManifest => {
      log::info!("updater: no manifest ({e})");
      Ok(UpdateCheck::not_configured())
    }
    Err(e) => Err(e.to_string()),
  }
}

/// Downloads (signature-verified by the plugin) and installs the update, emitting
/// `update://progress` as bytes arrive. Resolves once installed; call `relaunch` to restart.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
  if !is_configured(&configured_pubkey(&app)) {
    return Err("Updates are not configured for this build.".into());
  }
  let updater = app.updater().map_err(|e| e.to_string())?;
  let update = updater
    .check()
    .await
    .map_err(|e| e.to_string())?
    .filter(|u| is_newer(&u.current_version, &u.version))
    .ok_or_else(|| "No update is available.".to_string())?;
  let mut downloaded: u64 = 0;
  let emitter = app.clone();
  update
    .download_and_install(
      move |chunk, total| {
        downloaded += chunk as u64;
        let _ = emitter.emit(PROGRESS_EVENT, Progress { downloaded, total });
      },
      || {},
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn relaunch(app: AppHandle) {
  app.restart()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn placeholder_pubkey_is_not_configured() {
    assert!(!is_configured(PLACEHOLDER_PUBKEY));
    assert!(!is_configured(&format!("  {PLACEHOLDER_PUBKEY}\n")));
    assert!(!is_configured(""));
    assert!(is_configured("dW50cnVzdGVkIGNvbW1lbnQ6IHNvbWUgb3RoZXIga2V5"));
  }

  #[test]
  fn committed_pubkey_file_matches_config_and_placeholder() {
    let file = include_str!("../../updater.pub").trim();
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let in_conf = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    assert_eq!(file, in_conf, "updater.pub and tauri.conf.json pubkey must be identical");
    // Until a real key is generated the committed key is the placeholder.
    assert!(file == PLACEHOLDER_PUBKEY || is_configured(file));
  }

  #[test]
  fn config_points_at_github_latest_json() {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(
      conf["plugins"]["updater"]["endpoints"][0],
      "https://github.com/inalto/Mate/releases/latest/download/latest.json"
    );
    assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
  }

  #[test]
  fn semver_comparison() {
    assert!(is_newer("0.4.0", "0.4.1"));
    assert!(is_newer("0.4.0", "v0.5.0"));
    assert!(is_newer("0.9.0", "0.10.0"));
    assert!(!is_newer("0.4.0", "0.4.0"));
    assert!(!is_newer("0.5.0", "0.4.9"));
    // Prerelease sorts before its release.
    assert!(is_newer("1.0.0-beta.1", "1.0.0"));
    assert!(!is_newer("1.0.0", "1.0.0-rc.1"));
    assert!(is_newer("1.0.0-beta.1", "1.0.0-beta.2"));
    assert!(is_newer("1.0.0-alpha", "1.0.0-beta"));
    // Build metadata does not affect precedence.
    assert!(!is_newer("1.0.0+1", "1.0.0+2"));
    // Garbage is never newer.
    assert!(!is_newer("0.4.0", "latest"));
    assert!(!is_newer("nope", "1.0.0"));
  }

  #[test]
  fn missing_manifest_errors_mean_not_configured() {
    use tauri_plugin_updater::Error;
    assert_eq!(classify(&Error::ReleaseNotFound), CheckFailure::NoManifest);
    assert_eq!(classify(&Error::Network("offline".into())), CheckFailure::Other);
  }

  #[test]
  fn check_result_serialises_camel_case_without_empty_fields() {
    let json = serde_json::to_value(UpdateCheck::not_configured()).unwrap();
    assert_eq!(json, serde_json::json!({ "configured": false, "available": false }));
  }
}
