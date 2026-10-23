//! Page windows from the frontend: open (or focus) a page in its own window, list them.
use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::windows::{PageWindowInfo, PageWindows, TauriHost};

/// Title of a live (not trashed) page; errors if there is none.
fn page_title(state: &AppState, page_id: &str) -> Result<String, String> {
    let storage = state.storage.lock().map_err(|e| e.to_string())?;
    let tree = storage.list_tree().map_err(|e| e.to_string())?;
    let page = tree
        .pages
        .into_iter()
        .find(|p| p.id == page_id && p.deleted_at.is_none())
        .ok_or_else(|| "page not found".to_string())?;
    Ok(if page.title.trim().is_empty() { "Untitled".into() } else { page.title })
}

/// Opens `page_id` in its own window (or focuses the one showing it); returns the window label.
/// Async: creating a window from a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn open_page_window(
    app: AppHandle,
    state: State<'_, AppState>,
    windows: State<'_, PageWindows>,
    page_id: String,
) -> Result<String, String> {
    let title = page_title(&state, &page_id)?;
    windows.open(&TauriHost(&app), &page_id, &title)
}

/// Focuses the window showing `page_id`; false if none is open.
#[tauri::command]
pub async fn focus_page_window(
    app: AppHandle,
    windows: State<'_, PageWindows>,
    page_id: String,
) -> Result<bool, String> {
    windows.focus(&TauriHost(&app), &page_id)
}

#[tauri::command]
pub fn list_page_windows(windows: State<'_, PageWindows>) -> Vec<PageWindowInfo> {
    windows.list()
}
