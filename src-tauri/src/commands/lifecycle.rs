use std::fs;
use std::path::Path;
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

fn gate(state: &AppState) -> std::sync::MutexGuard<'_, CloseGate> {
    state.close_attempt.lock().unwrap_or_else(|e| e.into_inner())
}

fn eval_js(window: &Window, js: String) {
    if let Some(webview) = window.get_webview_window(window.label()) {
        let _ = webview.eval(js);
    }
}

/// Handles `CloseRequested`. Returns true if the close was prevented (the frontend flushes first);
/// false if the window should close now.
pub fn start_close_attempt(window: &Window) -> bool {
    start_attempt(window, false)
}

/// Handles a user-initiated `RunEvent::ExitRequested` (macOS Cmd+Q / app menu "Quit" / Dock quit,
/// which never send `CloseRequested`). Same contract as `start_close_attempt`: true = the exit was
/// prevented and the frontend flushes first; `complete_close_attempt` then destroys the window and
/// exits the app.
pub fn start_exit_attempt(window: &Window) -> bool {
    start_attempt(window, true)
}

fn start_attempt(window: &Window, exit: bool) -> bool {
    let state = window.state::<AppState>();
    let id = {
        let mut g = gate(&state);
        if exit { g.on_exit_requested() } else { g.on_close_requested() }
    };
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
        let expiry = gate(&state).expire(id);
        if expiry == Expiry::Acknowledged {
            // Mate is still saving: tell the frontend to surface it.
            eval_js(&window, format!(
                "window.__mateCloseAttemptCancelled && window.__mateCloseAttemptCancelled({id})"
            ));
        }
    });
    true
}

#[tauri::command]
pub fn close_attempt_started(state: State<'_, AppState>, attempt_id: u64) -> bool {
    gate(&state).acknowledge(attempt_id)
}

#[tauri::command]
pub fn cancel_close_attempt(state: State<'_, AppState>, attempt_id: u64) {
    gate(&state).clear_if_current(attempt_id);
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
    let current = gate(&state).clear_if_current(attempt_id);
    if !current && force != Some(true) {
        return Err("stale close attempt".into());
    }
    window.destroy().map_err(|e| e.to_string())?;
    // A quit (Cmd+Q) was prevented to flush first. Destroying the last window usually ends the
    // app on its own (it emits ExitRequested again, which then finds no main window and is let
    // through); exit explicitly in case it does not. The gate hands this out once.
    if gate(&state).take_exit_after_destroy() {
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
