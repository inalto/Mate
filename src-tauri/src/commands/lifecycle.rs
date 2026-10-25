use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, State, Window};

use crate::state::AppState;

/// How long the frontend gets to flush before the close attempt is abandoned.
const WATCHDOG: Duration = Duration::from_secs(8);
const MAX_RECOVERY_BYTES: usize = 64 * 1024 * 1024;

/// Close-attempt state machine (pure, so it is testable without a window).
#[derive(Default)]
pub struct CloseGate {
    counter: u64,
    /// Current attempt id and whether the frontend acknowledged it.
    current: Option<(u64, bool)>,
    /// A user-initiated app quit (`RunEvent::ExitRequested`) is waiting for the flush to finish.
    exit_pending: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Expiry {
    Stale,
    /// The frontend never answered; the attempt is kept so the next close request goes through.
    Unacknowledged,
    /// The frontend was busy; the attempt is cleared and should be told it was cancelled.
    Acknowledged,
}

impl CloseGate {
    /// A close was requested. `None` = let the window close (the previous attempt was never
    /// acknowledged, so the frontend is unresponsive); otherwise the new, superseding attempt id.
    pub fn on_close_requested(&mut self) -> Option<u64> {
        if matches!(self.current, Some((_, false))) {
            return None;
        }
        self.counter += 1;
        self.current = Some((self.counter, false));
        Some(self.counter)
    }

    /// A user-initiated app quit (macOS Cmd+Q, Dock "Quit"): same handshake as a window close, but
    /// the app must exit once the main window is destroyed.
    pub fn on_exit_requested(&mut self) -> Option<u64> {
        let id = self.on_close_requested();
        if id.is_some() {
            self.exit_pending = true;
        }
        id
    }

    /// The window was destroyed: a window reopened under the same label starts with no attempt
    /// (a stale unacknowledged one would let its first close skip the flush). The counter is kept
    /// so a late watchdog of the old window can never match a new attempt id.
    pub fn forget_window(&mut self) {
        self.current = None;
        self.exit_pending = false;
    }

    /// Called after the main window was destroyed: true exactly once if an app quit is pending.
    pub fn take_exit_after_destroy(&mut self) -> bool {
        std::mem::take(&mut self.exit_pending)
    }

    /// The frontend acknowledged `id`; false if stale.
    pub fn acknowledge(&mut self, id: u64) -> bool {
        match self.current {
            Some((cur, _)) if cur == id => {
                self.current = Some((id, true));
                true
            }
            _ => false,
        }
    }

    pub fn is_current(&self, id: u64) -> bool {
        matches!(self.current, Some((cur, _)) if cur == id)
    }

    /// Clears the attempt if it is still `id`; returns whether it was.
    pub fn clear_if_current(&mut self, id: u64) -> bool {
        if self.is_current(id) {
            self.current = None;
            true
        } else {
            false
        }
    }

    pub fn expire(&mut self, id: u64) -> Expiry {
        match self.current {
            Some((cur, true)) if cur == id => {
                self.current = None;
                Expiry::Acknowledged
            }
            Some((cur, false)) if cur == id => Expiry::Unacknowledged,
            _ => Expiry::Stale,
        }
    }
}

/// One close gate per window label: every window (the main one and each page window) runs its own
/// handshake with its own webview. Attempt ids are per window.
#[derive(Default)]
pub struct CloseGates(Mutex<HashMap<String, CloseGate>>);

impl CloseGates {
    pub fn with<R>(&self, label: &str, f: impl FnOnce(&mut CloseGate) -> R) -> R {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        f(map.entry(label.to_owned()).or_default())
    }
}

fn gate<R>(state: &AppState, label: &str, f: impl FnOnce(&mut CloseGate) -> R) -> R {
    state.close_attempt.with(label, f)
}

fn eval_js(window: &Window, js: String) {
    if let Some(webview) = window.get_webview_window(window.label()) {
        let _ = webview.eval(js);
    }
}

/// Handles `CloseRequested`. Returns true if the close was prevented (the frontend flushes first);
/// false if the window should close now.
#[cfg(desktop)] // Mobile has no window close request.
pub fn start_close_attempt(window: &Window) -> bool {
    start_attempt(window, false)
}

/// Starts `window`'s own handshake. `exit`: a user-initiated `RunEvent::ExitRequested` (macOS Cmd+Q
/// / app menu "Quit" / Dock quit, which never send `CloseRequested`) on the main window, so the app
/// exits once `complete_close_attempt` destroyed it. True =
/// the frontend flushes first; false = the window should close now (its frontend never answered the
/// previous attempt).
pub(crate) fn start_attempt(window: &Window, exit: bool) -> bool {
    let state = window.state::<AppState>();
    let label = window.label().to_owned();
    let id = gate(&state, &label, |g| if exit { g.on_exit_requested() } else { g.on_close_requested() });
    let Some(id) = id else {
        return false;
    };
    eval_js(window, format!(
        "window.__mateFlushAndClose && window.__mateFlushAndClose({id})"
    ));
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(WATCHDOG);
        let state = window.state::<AppState>();
        let expiry = gate(&state, &label, |g| g.expire(id));
        if expiry == Expiry::Acknowledged {
            // Mate is still saving: tell the frontend to surface it.
            eval_js(&window, format!(
                "window.__mateCloseAttemptCancelled && window.__mateCloseAttemptCancelled({id})"
            ));
            // A page window that could not flush holds up a pending main-window close: cancel it.
            crate::windows::secondary_refused(window.app_handle(), &label);
        }
    });
    true
}

#[tauri::command]
pub fn close_attempt_started(window: Window, state: State<'_, AppState>, attempt_id: u64) -> bool {
    gate(&state, window.label(), |g| g.acknowledge(attempt_id))
}

#[tauri::command]
pub fn cancel_close_attempt(window: Window, state: State<'_, AppState>, attempt_id: u64) {
    if gate(&state, window.label(), |g| g.clear_if_current(attempt_id)) {
        // The frontend could not flush (it shows why); a pending main-window close waits no more.
        crate::windows::secondary_refused(window.app_handle(), window.label());
    }
}

#[tauri::command]
pub fn complete_close_attempt(
    window: Window,
    state: State<'_, AppState>,
    attempt_id: u64,
    force: Option<bool>,
) -> Result<(), String> {
    // `force` is the user's explicit "Close anyway" after a recovery file was written; the attempt
    // was already cancelled at that point, so it is no longer current.
    let label = window.label().to_owned();
    let current = gate(&state, &label, |g| g.clear_if_current(attempt_id));
    if !current && force != Some(true) {
        return Err("stale close attempt".into());
    }
    crate::windows::mark_dying(window.app_handle(), &label);
    window.destroy().map_err(|e| e.to_string())?;
    // A quit (Cmd+Q) was prevented to flush first. Destroying the last window usually ends the
    // app on its own (it emits ExitRequested again, which then finds no main window and is let
    // through); exit explicitly in case it does not. The gate hands this out once.
    if gate(&state, &label, |g| g.take_exit_after_destroy()) {
        window.app_handle().exit(0);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct RecoveryArtifact {
    pub path: String,
    pub size: u64,
}

fn valid_artifact_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.ends_with(".json")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.contains("..")
}

/// Writes `<dir>/<name>` atomically (temp file + rename).
fn write_recovery(dir: &Path, name: &str, contents: &str) -> Result<RecoveryArtifact, String> {
    if !valid_artifact_name(name) {
        return Err("invalid recovery file name".into());
    }
    if contents.len() > MAX_RECOVERY_BYTES {
        return Err("recovery artifact too large".into());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(RecoveryArtifact {
        path: path.to_string_lossy().into_owned(),
        size: contents.len() as u64,
    })
}

/// Recovery files kept per kind; older ones are deleted at startup.
pub const KEEP_RECOVERY_FILES: usize = 10;

/// Deletes all but the `keep` newest recovery files: the reset zips (`mate-recovery-*.zip`, in
/// the data dir) and the close-time json files (`mate-recovery-*.json`, in `recovery/` and, from
/// Phase 1, next to the database). Each kind is counted across those folders. Returns how many
/// files were removed; a file that cannot be removed is left and ignored.
pub fn prune_recovery_files(data_dir: &Path, keep: usize) -> usize {
    let mut removed = 0;
    for ext in ["zip", "json"] {
        let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
        for dir in [data_dir.to_path_buf(), data_dir.join("recovery")] {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let ours = name.starts_with("mate-recovery-") && name.ends_with(&format!(".{ext}"));
                let Ok(meta) = entry.metadata() else { continue };
                if ours && meta.is_file() {
                    files.push((meta.modified().unwrap_or(std::time::UNIX_EPOCH), entry.path()));
                }
            }
        }
        // Newest first; the name (it carries a timestamp) breaks ties between equal mtimes.
        files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        for (_, path) in files.into_iter().skip(keep) {
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[tauri::command]
pub async fn write_recovery_artifact(
    state: State<'_, AppState>,
    suggested_name: String,
    contents: String,
) -> Result<RecoveryArtifact, String> {
    let dir = state.data_dir.join("recovery");
    tauri::async_runtime::spawn_blocking(move || write_recovery(&dir, &suggested_name, &contents))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acknowledged_attempt_is_superseded() {
        let mut g = CloseGate::default();
        let a = g.on_close_requested().unwrap();
        assert!(g.acknowledge(a));
        let b = g.on_close_requested().unwrap();
        assert!(b > a);
        assert!(!g.is_current(a));
        assert!(!g.acknowledge(a));
        assert!(g.is_current(b));
        assert!(!g.clear_if_current(a));
        assert!(g.clear_if_current(b));
    }

    #[test]
    fn unacknowledged_attempt_lets_next_close_through() {
        let mut g = CloseGate::default();
        let a = g.on_close_requested().unwrap();
        assert_eq!(g.on_close_requested(), None);
        // Still lets through after the watchdog expires without acknowledgement.
        assert_eq!(g.expire(a), Expiry::Unacknowledged);
        assert_eq!(g.on_close_requested(), None);
    }

    #[test]
    fn acknowledged_expiry_clears_and_allows_new_attempt() {
        let mut g = CloseGate::default();
        let a = g.on_close_requested().unwrap();
        g.acknowledge(a);
        assert_eq!(g.expire(a), Expiry::Acknowledged);
        assert_eq!(g.expire(a), Expiry::Stale);
        assert!(g.on_close_requested().is_some());
    }

    #[test]
    fn exit_request_starts_attempt_like_close() {
        let mut g = CloseGate::default();
        let a = g.on_exit_requested().unwrap();
        assert!(g.is_current(a));
        assert!(g.acknowledge(a));
        // The flushed attempt completes: the app exits exactly once.
        assert!(g.clear_if_current(a));
        assert!(g.take_exit_after_destroy());
        assert!(!g.take_exit_after_destroy());
        // An unresponsive frontend lets the next exit request through, like a window close.
        let mut g = CloseGate::default();
        g.on_exit_requested().unwrap();
        assert_eq!(g.on_exit_requested(), None);
        // A plain window close never asks for an app exit.
        let mut g = CloseGate::default();
        let c = g.on_close_requested().unwrap();
        assert!(g.clear_if_current(c));
        assert!(!g.take_exit_after_destroy());
    }

    #[test]
    fn each_window_has_its_own_gate() {
        let gates = CloseGates::default();
        let main = gates.with("main", |g| g.on_close_requested()).unwrap();
        let page = gates.with("page-p1", |g| g.on_close_requested()).unwrap();
        // An unacknowledged attempt in one window does not let another window's close through.
        assert!(gates.with("page-p1", |g| g.acknowledge(page)));
        assert!(gates.with("main", |g| g.is_current(main)));
        assert!(gates.with("page-p1", |g| g.clear_if_current(page)));
        assert_eq!(gates.with("main", |g| g.on_close_requested()), None);
    }

    #[test]
    fn reopened_page_window_gets_a_fresh_gate() {
        let gates = CloseGates::default();
        // The page window never answered and was destroyed (fail open).
        let old = gates.with("page-p1", |g| g.on_close_requested()).unwrap();
        assert_eq!(gates.with("page-p1", |g| g.on_close_requested()), None);
        gates.with("page-p1", |g| g.forget_window());
        // Reopened under the same label: its first close runs the flush handshake again.
        let new = gates.with("page-p1", |g| g.on_close_requested()).unwrap();
        assert!(new > old, "ids never repeat, so a late watchdog cannot hit the new attempt");
        assert_eq!(gates.with("page-p1", |g| g.expire(old)), Expiry::Stale);
        assert!(gates.with("page-p1", |g| g.is_current(new)));
    }

    #[test]
    fn prune_keeps_the_ten_newest_recovery_files_of_each_kind() {
        let dir = std::env::temp_dir().join(format!("mate-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("recovery")).unwrap();
        let t0 = std::time::SystemTime::now() - Duration::from_secs(10_000);
        let put = |path: std::path::PathBuf, age: u64| {
            fs::write(&path, "x").unwrap();
            let f = fs::File::options().write(true).open(&path).unwrap();
            f.set_modified(t0 + Duration::from_secs(age)).unwrap();
        };
        for i in 0..13 {
            put(dir.join(format!("mate-recovery-{i:02}.zip")), i);
        }
        for i in 0..7 {
            put(dir.join("recovery").join(format!("mate-recovery-j{i:02}.json")), 100 + i);
        }
        for i in 0..6 {
            put(dir.join(format!("mate-recovery-k{i:02}.json")), 200 + i); // next to the DB
        }
        put(dir.join("mate.db"), 0);
        put(dir.join("settings.json"), 0);
        put(dir.join("recovery").join("notes.json"), 0);

        assert_eq!(prune_recovery_files(&dir, KEEP_RECOVERY_FILES), 3 + 3);
        let left = |d: &Path, ext: &str| {
            let mut v: Vec<String> = fs::read_dir(d)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("mate-recovery-") && n.ends_with(ext))
                .collect();
            v.sort();
            v
        };
        let zips = left(&dir, ".zip");
        assert_eq!(zips.len(), 10);
        assert_eq!(zips[0], "mate-recovery-03.zip"); // the three oldest went
        // 13 json files across both folders: the 3 oldest (j00..j02) went.
        assert_eq!(left(&dir.join("recovery"), ".json").len(), 4);
        assert_eq!(left(&dir, ".json").len(), 6);
        assert!(dir.join("mate.db").exists() && dir.join("settings.json").exists());
        assert!(dir.join("recovery").join("notes.json").exists());
        // Idempotent, and a missing directory is fine.
        assert_eq!(prune_recovery_files(&dir, KEEP_RECOVERY_FILES), 0);
        assert_eq!(prune_recovery_files(&dir.join("nope"), KEEP_RECOVERY_FILES), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_recovery_file_and_rejects_bad_names() {
        let dir = std::env::temp_dir().join(format!("mate-recovery-{}", std::process::id()));
        let r = write_recovery(&dir, "mate-recovery-1.json", "{}").unwrap();
        assert_eq!(r.size, 2);
        assert_eq!(fs::read_to_string(&r.path).unwrap(), "{}");
        assert!(write_recovery(&dir, "../x.json", "{}").is_err());
        assert!(write_recovery(&dir, "x.txt", "{}").is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
