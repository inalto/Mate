//! In-app updater: check GitHub releases for a newer signed build, download it and restart.
//!
//! The plugin verifies the minisign signature of every download against `plugins.updater.pubkey`
//! (never bypassed here). A build is "configured" for updates only when that pubkey is not the
//! committed placeholder (see `src-tauri/updater.pub`) and the endpoint serves a manifest.
//!
//! Before an install every window flushes its write-behind queue (see `FlushCoordinator`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Window};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Notify;

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

/// A readable sentence for a failed check. Only the placeholder key means "not configured";
/// a missing manifest (404), a server error or no network are temporary: the user can retry.
fn check_error_message(err: &tauri_plugin_updater::Error) -> String {
  use tauri_plugin_updater::Error;
  match err {
    Error::ReleaseNotFound | Error::Serialization(_) | Error::EmptyEndpoints => {
      "No update information was found on the release server. Try again later.".into()
    }
    Error::Reqwest(_) | Error::Network(_) => "Could not reach the update server. Check your connection and try again.".into(),
    other => other.to_string(),
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
    Err(e) => {
      log::info!("updater: check failed ({e})");
      Err(check_error_message(&e))
    }
  }
}

// ---- Flush before install -------------------------------------------------------------------
//
// On Windows the installer runs and the plugin then calls `process::exit(0)`: no close handshake,
// no recovery artifact. So before downloading, every window flushes its write-behind queue (the
// frontend answers `window.__mateFlushOnly(token)` with `report_flush`) without being closed.
// If any window reports unsaved failures the install is aborted.

const FLUSH_TIMEOUT: Duration = Duration::from_secs(10);
const FLUSH_ABORTED: &str = "Some of your work is not saved yet, so Mate will not update now. Keep Mate open, resolve the save error shown in the window, and try again.";
const FLUSH_TIMED_OUT: &str = "Mate is still saving. Try the update again in a moment.";

struct Round {
  waiting: HashSet<String>,
  failed: Vec<String>,
  done: Arc<Notify>,
}

/// Collects the windows' answers to a flush request.
#[derive(Default)]
pub struct FlushCoordinator {
  next: AtomicU64,
  rounds: Mutex<HashMap<u64, Round>>,
}

/// The windows that can be asked to flush.
pub trait FlushHost {
  fn windows(&self) -> Vec<String>;
  /// Asks `label` to flush and answer via `FlushCoordinator::report`. False: it cannot be asked.
  fn request_flush(&self, label: &str, token: u64) -> bool;
}

impl FlushCoordinator {
  fn rounds(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Round>> {
    self.rounds.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// A window's answer for round `token`.
  pub fn report(&self, token: u64, label: &str, ok: bool) {
    let mut rounds = self.rounds();
    if let Some(r) = rounds.get_mut(&token) {
      if r.waiting.remove(label) && !ok {
        r.failed.push(label.to_owned());
      }
      if r.waiting.is_empty() {
        r.done.notify_one();
      }
    }
  }

  fn all_answered(&self, token: u64) -> bool {
    self.rounds().get(&token).is_none_or(|r| r.waiting.is_empty())
  }

  /// Flushes every window of `host` and waits (at most `timeout`) for all answers.
  pub async fn flush_all(&self, host: &impl FlushHost, timeout: Duration) -> Result<(), String> {
    let token = self.next.fetch_add(1, Ordering::Relaxed) + 1;
    let done = Arc::new(Notify::new());
    let labels = host.windows();
    self.rounds().insert(token, Round { waiting: labels.iter().cloned().collect(), failed: Vec::new(), done: done.clone() });
    for label in &labels {
      if !host.request_flush(label, token) {
        // A window without a live webview has nothing queued.
        self.report(token, label, true);
      }
    }
    let waited = tokio::time::timeout(timeout, async {
      while !self.all_answered(token) {
        done.notified().await;
      }
    })
    .await;
    let failed = self.rounds().remove(&token).is_some_and(|r| !r.failed.is_empty());
    if failed {
      Err(FLUSH_ABORTED.into())
    } else if waited.is_err() {
      Err(FLUSH_TIMED_OUT.into())
    } else {
      Ok(())
    }
  }
}

static FLUSH: LazyLock<FlushCoordinator> = LazyLock::new(FlushCoordinator::default);

struct TauriFlushHost<'a>(&'a AppHandle);

impl FlushHost for TauriFlushHost<'_> {
  fn windows(&self) -> Vec<String> {
    self.0.webview_windows().into_keys().collect()
  }
  fn request_flush(&self, label: &str, token: u64) -> bool {
    self.0.get_webview_window(label).is_some_and(|w| w.eval(format!("window.__mateFlushOnly && window.__mateFlushOnly({token})")).is_ok())
  }
}

/// A window's answer to `__mateFlushOnly(token)`: `ok` is false when notes could not be saved.
#[tauri::command]
pub fn report_flush(window: Window, token: u64, ok: bool) {
  FLUSH.report(token, window.label(), ok);
}

/// Only one install at a time.
static INSTALLING: AtomicBool = AtomicBool::new(false);

struct InstallGuard;

impl InstallGuard {
  fn acquire() -> Result<Self, String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
      Err("An update is already being installed.".into())
    } else {
      Ok(Self)
    }
  }
}

impl Drop for InstallGuard {
  fn drop(&mut self) {
    INSTALLING.store(false, Ordering::SeqCst);
  }
}

/// Downloads (signature-verified by the plugin) and installs `expected_version`, emitting
/// `update://progress` as bytes arrive. Every window flushes first; an unsaved failure aborts.
/// Resolves once installed (macOS/Linux; the UI then offers `relaunch`). On Windows the
/// installer restarts the app itself and this never returns.
#[tauri::command]
pub async fn install_update(app: AppHandle, expected_version: String) -> Result<(), String> {
  if !is_configured(&configured_pubkey(&app)) {
    return Err("Updates are not configured for this build.".into());
  }
  let _guard = InstallGuard::acquire()?;
  let exit_app = app.clone();
  let updater = app
    .updater_builder()
    .on_before_exit(move || {
      // Last chance before the process exits (Windows): a short, best-effort flush on a thread
      // that is not an async worker. The real flush already happened before the download.
      let app = exit_app.clone();
      let _ = std::thread::spawn(move || {
        let _ = tauri::async_runtime::block_on(FLUSH.flush_all(&TauriFlushHost(&app), Duration::from_secs(2)));
      })
      .join();
    })
    .build()
    .map_err(|e| e.to_string())?;
  let update = updater
    .check()
    .await
    .map_err(|e| check_error_message(&e))?
    .filter(|u| is_newer(&u.current_version, &u.version))
    .ok_or_else(|| "No update is available.".to_string())?;
  if update.version != expected_version {
    return Err(format!(
      "Version {} is now available instead of {expected_version}. Check for updates again.",
      update.version
    ));
  }
  FLUSH.flush_all(&TauriFlushHost(&app), FLUSH_TIMEOUT).await?;
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
  fn committed_pubkey_file_matches_config_and_is_a_minisign_key() {
    use base64::Engine;
    let file = include_str!("../../updater.pub").trim();
    let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let in_conf = conf["plugins"]["updater"]["pubkey"].as_str().unwrap();
    assert_eq!(file, in_conf, "updater.pub and tauri.conf.json pubkey must be identical");
    let decoded = base64::engine::general_purpose::STANDARD.decode(file).expect("pubkey is base64");
    let text = String::from_utf8(decoded).expect("pubkey decodes to text");
    assert!(text.starts_with("untrusted comment: minisign public key"), "not a minisign public key: {text}");
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
  fn failed_checks_read_as_retryable_sentences() {
    use tauri_plugin_updater::Error;
    assert!(check_error_message(&Error::ReleaseNotFound).contains("Try again later"));
    assert!(check_error_message(&Error::Network("x".into())).contains("connection"));
  }

  struct FakeHost {
    coordinator: Arc<FlushCoordinator>,
    /// label -> Some(ok) answers at once; None never answers.
    answers: Vec<(&'static str, Option<bool>)>,
  }

  impl FlushHost for FakeHost {
    fn windows(&self) -> Vec<String> {
      self.answers.iter().map(|(l, _)| l.to_string()).collect()
    }
    fn request_flush(&self, label: &str, token: u64) -> bool {
      if let Some((_, Some(ok))) = self.answers.iter().find(|(l, _)| *l == label) {
        self.coordinator.report(token, label, *ok);
      }
      true
    }
  }

  fn run(answers: Vec<(&'static str, Option<bool>)>, timeout: Duration) -> Result<(), String> {
    let coordinator = Arc::new(FlushCoordinator::default());
    let host = FakeHost { coordinator: coordinator.clone(), answers };
    tauri::async_runtime::block_on(coordinator.flush_all(&host, timeout))
  }

  #[test]
  fn a_failing_flush_aborts_the_install() {
    assert_eq!(run(vec![("main", Some(true)), ("page-a", Some(true))], Duration::from_secs(1)), Ok(()));
    assert_eq!(run(vec![("main", Some(true)), ("page-a", Some(false))], Duration::from_secs(1)), Err(FLUSH_ABORTED.into()));
  }

  #[test]
  fn a_window_that_never_answers_times_out() {
    assert_eq!(run(vec![("main", Some(true)), ("page-a", None)], Duration::from_millis(50)), Err(FLUSH_TIMED_OUT.into()));
  }

  #[test]
  fn only_one_install_at_a_time() {
    let first = InstallGuard::acquire().unwrap();
    assert!(InstallGuard::acquire().is_err());
    drop(first);
    assert!(InstallGuard::acquire().is_ok());
  }

  #[test]
  fn check_result_serialises_camel_case_without_empty_fields() {
    let json = serde_json::to_value(UpdateCheck::not_configured()).unwrap();
    assert_eq!(json, serde_json::json!({ "configured": false, "available": false }));
  }
}
