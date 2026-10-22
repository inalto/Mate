use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, State, Window};

use crate::state::AppState;

/// How long the frontend gets to flush before the close attempt is abandoned.
const WATCHDOG: Duration = Duration::from_secs(8);
const MAX_RECOVERY_BYTES: usize = 64 * 1024 * 1024;

/// Mints a new attempt id (monotonic from 1), superseding any earlier attempt.
pub fn begin_attempt(current: &Mutex<Option<u64>>, counter: &AtomicU64) -> u64 {
    let mut cur = current.lock().unwrap_or_else(|e| e.into_inner());
    let id = counter.fetch_add(1, Ordering::SeqCst) + 1;
    *cur = Some(id);
    id
}

/// True if `id` is the current attempt.
pub fn is_current(current: &Mutex<Option<u64>>, id: u64) -> bool {
    *current.lock().unwrap_or_else(|e| e.into_inner()) == Some(id)
}

/// Clears the attempt if it is still `id`; returns whether it was.
pub fn clear_if_current(current: &Mutex<Option<u64>>, id: u64) -> bool {
    let mut cur = current.lock().unwrap_or_else(|e| e.into_inner());
    if *cur == Some(id) {
        *cur = None;
        true
    } else {
        false
    }
}

fn eval_js(window: &Window, js: String) {
    if let Some(webview) = window.get_webview_window(window.label()) {
        let _ = webview.eval(js);
    }
}

/// Handles `CloseRequested`: the caller has already prevented the close.
pub fn start_close_attempt(window: &Window) {
    let state = window.state::<AppState>();
    let id = begin_attempt(&state.close_attempt, &state.close_counter);
    eval_js(window, format!(
        "window.__mateFlushAndClose && window.__mateFlushAndClose({id})"
    ));
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(WATCHDOG);
        let state = window.state::<AppState>();
        if clear_if_current(&state.close_attempt, id) {
            // Mate is still saving: tell the frontend to surface it.
            eval_js(&window, format!(
                "window.__mateCloseAttemptCancelled && window.__mateCloseAttemptCancelled({id})"
            ));
        }
    });
}

#[tauri::command]
pub fn close_attempt_started(state: State<'_, AppState>, attempt_id: u64) -> bool {
    is_current(&state.close_attempt, attempt_id)
}

#[tauri::command]
pub fn cancel_close_attempt(state: State<'_, AppState>, attempt_id: u64) {
    clear_if_current(&state.close_attempt, attempt_id);
}

#[tauri::command]
pub fn complete_close_attempt(
    window: Window,
    state: State<'_, AppState>,
    attempt_id: u64,
) -> Result<(), String> {
    if !clear_if_current(&state.close_attempt, attempt_id) {
        return Err("stale close attempt".into());
    }
    window.destroy().map_err(|e| e.to_string())
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
    fn second_attempt_supersedes_first() {
        let cur = Mutex::new(None);
        let counter = AtomicU64::new(0);
        let a = begin_attempt(&cur, &counter);
        let b = begin_attempt(&cur, &counter);
        assert!(b > a);
        assert!(!is_current(&cur, a));
        assert!(is_current(&cur, b));
        assert!(!clear_if_current(&cur, a));
        assert!(clear_if_current(&cur, b));
        assert!(!is_current(&cur, b));
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
