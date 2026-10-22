use mate_core::model::{Bookshelf, Page, Section, Unit};
use mate_core::storage::{EntityKind, NotebookTree, TrashItem};
use tauri::State;

use crate::state::AppState;

type Res<T> = Result<T, String>;

fn lock<'a>(
    state: &'a State<'_, AppState>,
) -> Res<std::sync::MutexGuard<'a, mate_core::storage::Storage>> {
    state.storage.lock().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_notebook_tree(state: State<'_, AppState>) -> Res<NotebookTree> {
    lock(&state)?.list_tree().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_bookshelf(state: State<'_, AppState>, b: Bookshelf) -> Res<()> {
    lock(&state)?.upsert_bookshelf(&b).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_unit(state: State<'_, AppState>, u: Unit) -> Res<()> {
    lock(&state)?.upsert_unit(&u).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_section(state: State<'_, AppState>, s: Section) -> Res<()> {
    lock(&state)?.upsert_section(&s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_page(state: State<'_, AppState>, p: Page) -> Res<()> {
    lock(&state)?.upsert_page(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn soft_delete_entity(state: State<'_, AppState>, kind: EntityKind, id: String) -> Res<()> {
    lock(&state)?.soft_delete(kind, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn restore_entity(state: State<'_, AppState>, kind: EntityKind, id: String) -> Res<()> {
    lock(&state)?.restore(kind, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> Res<Vec<TrashItem>> {
    lock(&state)?.list_trash().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn purge_entity(state: State<'_, AppState>, kind: EntityKind, id: String) -> Res<()> {
    lock(&state)?.purge(kind, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn purge_trash_older_than(state: State<'_, AppState>, days: i64) -> Res<usize> {
    lock(&state)?.purge_older_than(days).map_err(|e| e.to_string())
}
