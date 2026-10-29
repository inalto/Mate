use std::sync::Mutex;

use mate_core::model::{Bookshelf, Page, Section, Unit};
use mate_core::storage::{EntityKind, NotebookTree, Storage, TrashItem};
use serde::Serialize;
use tauri::{Emitter, State, Window};

use crate::state::AppState;

type Res<T> = Result<T, String>;

/// Broadcast to every window after a notebook mutation, so page windows (each with its own
/// notebook store) and the main window stay in step.
pub const NOTEBOOK_CHANGED: &str = "notebook://changed";

/// Payload of `notebook://changed`. `kind`: "page-trashed" (a page was trashed or purged),
/// "page-updated" (a page record was saved: rename, icon, move...) or "tree" (anything else,
/// including trashing a section or unit with its pages). `source` is the window that made it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookChange {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub source: String,
}

impl NotebookChange {
    fn tree(source: &str) -> Self {
        NotebookChange { kind: "tree", page_id: None, title: None, source: source.into() }
    }
    fn page_updated(source: &str, page: &Page) -> Self {
        NotebookChange {
            kind: "page-updated",
            page_id: Some(page.id.clone()),
            title: Some(page.title.clone()),
            source: source.into(),
        }
    }
    fn removed(source: &str, kind: EntityKind, id: &str) -> Self {
        match kind {
            EntityKind::Page => NotebookChange {
                kind: "page-trashed",
                page_id: Some(id.into()),
                title: None,
                source: source.into(),
            },
            _ => Self::tree(source),
        }
    }
}

/// Where change notifications go (every window in the app; a recorder in tests).
pub trait NotebookSink {
    fn source(&self) -> String;
    fn notebook_changed(&self, change: NotebookChange);
}

impl NotebookSink for Window {
    fn source(&self) -> String {
        self.label().to_owned()
    }
    fn notebook_changed(&self, change: NotebookChange) {
        let _ = self.emit(NOTEBOOK_CHANGED, change);
    }
}

fn lock(storage: &Mutex<Storage>) -> Res<std::sync::MutexGuard<'_, Storage>> {
    storage.lock().map_err(|e| e.to_string())
}

/// Runs a mutation and, once it succeeded, notifies every window.
fn mutate<T>(
    storage: &Mutex<Storage>,
    sink: &impl NotebookSink,
    change: impl FnOnce(&str) -> NotebookChange,
    f: impl FnOnce(&mut Storage) -> mate_core::storage::Result<T>,
) -> Res<T> {
    let out = f(&mut *lock(storage)?).map_err(|e| e.to_string())?;
    sink.notebook_changed(change(&sink.source()));
    Ok(out)
}

#[tauri::command]
pub fn get_notebook_tree(state: State<'_, AppState>) -> Res<NotebookTree> {
    lock(&state.storage)?.list_tree().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_bookshelf(window: Window, state: State<'_, AppState>, b: Bookshelf) -> Res<()> {
    mutate(&state.storage, &window, NotebookChange::tree, |s| s.upsert_bookshelf(&b))
}

/// Moves folder `id` into `parent_id` (`None`: the Library root). A move into the folder itself
/// or one of its subfolders fails with the readable message of `StorageError::FolderCycle`.
#[tauri::command]
pub fn move_bookshelf(
    window: Window,
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> Res<()> {
    move_bookshelf_op(&state.storage, &window, &id, parent_id.as_deref())
}

fn move_bookshelf_op(
    storage: &Mutex<Storage>,
    sink: &impl NotebookSink,
    id: &str,
    parent_id: Option<&str>,
) -> Res<()> {
    mutate(storage, sink, NotebookChange::tree, |s| s.move_bookshelf(id, parent_id))
}

#[tauri::command]
pub fn upsert_unit(window: Window, state: State<'_, AppState>, u: Unit) -> Res<()> {
    mutate(&state.storage, &window, NotebookChange::tree, |s| s.upsert_unit(&u))
}

#[tauri::command]
pub fn upsert_section(window: Window, state: State<'_, AppState>, s: Section) -> Res<()> {
    mutate(&state.storage, &window, NotebookChange::tree, |st| st.upsert_section(&s))
}

#[tauri::command]
pub fn upsert_page(window: Window, state: State<'_, AppState>, p: Page) -> Res<()> {
    upsert_page_op(&state.storage, &window, &p)
}

fn upsert_page_op(storage: &Mutex<Storage>, sink: &impl NotebookSink, p: &Page) -> Res<()> {
    mutate(storage, sink, |src| NotebookChange::page_updated(src, p), |s| s.upsert_page(p))
}

#[tauri::command]
pub fn soft_delete_entity(window: Window, state: State<'_, AppState>, kind: EntityKind, id: String) -> Res<()> {
    soft_delete_op(&state.storage, &window, kind, &id)
}

fn soft_delete_op(storage: &Mutex<Storage>, sink: &impl NotebookSink, kind: EntityKind, id: &str) -> Res<()> {
    mutate(storage, sink, |src| NotebookChange::removed(src, kind, id), |s| s.soft_delete(kind, id))
}

#[tauri::command]
pub fn restore_entity(window: Window, state: State<'_, AppState>, kind: EntityKind, id: String) -> Res<()> {
    mutate(&state.storage, &window, NotebookChange::tree, |s| s.restore(kind, &id))
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> Res<Vec<TrashItem>> {
    lock(&state.storage)?.list_trash().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn purge_entity(window: Window, state: State<'_, AppState>, kind: EntityKind, id: String) -> Res<()> {
    purge_op(&state.storage, &window, kind, &id)
}

fn purge_op(storage: &Mutex<Storage>, sink: &impl NotebookSink, kind: EntityKind, id: &str) -> Res<()> {
    mutate(storage, sink, |src| NotebookChange::removed(src, kind, id), |s| s.purge(kind, id))
}

#[tauri::command]
pub fn purge_trash_older_than(window: Window, state: State<'_, AppState>, days: i64) -> Res<usize> {
    mutate(&state.storage, &window, NotebookChange::tree, |s| s.purge_older_than(days))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mate_core::model::{BackgroundConfig, PageMode, now_iso};
    use std::cell::RefCell;

    struct Recorder(RefCell<Vec<NotebookChange>>);
    impl NotebookSink for Recorder {
        fn source(&self) -> String {
            "page-p1".into()
        }
        fn notebook_changed(&self, change: NotebookChange) {
            self.0.borrow_mut().push(change);
        }
    }

    fn page(id: &str, title: &str) -> Page {
        let now = now_iso();
        Page {
            id: id.into(),
            section_id: "s1".into(),
            parent_id: None,
            title: title.into(),
            is_expanded: false,
            is_favourite: false,
            depth: 0,
            mode: PageMode::Canvas,
            background_config: BackgroundConfig::default(),
            page_width: None,
            page_height: None,
            thumbnail_version: 0,
            icon: None,
            order_index: 0,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
            version: 0,
            import_metadata: None,
        }
    }

    #[test]
    fn mutating_commands_emit_notebook_changes() {
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let sink = Recorder(RefCell::new(Vec::new()));
        let unit = Unit {
            id: "u1".into(),
            title: "U".into(),
            icon: None,
            color: None,
            is_favourite: false,
            bookshelf_id: None,
            is_expanded: true,
            order_index: 0,
            created_at: now_iso(),
            updated_at: now_iso(),
            deleted_at: None,
            version: 0,
        };
        mutate(&storage, &sink, NotebookChange::tree, |s| s.upsert_unit(&unit)).unwrap();
        let section = Section {
            id: "s1".into(),
            unit_id: "u1".into(),
            title: "S".into(),
            color: "#000".into(),
            icon: None,
            order_index: 0,
            is_expanded: true,
            created_at: now_iso(),
            updated_at: now_iso(),
            deleted_at: None,
            version: 0,
        };
        mutate(&storage, &sink, NotebookChange::tree, |s| s.upsert_section(&section)).unwrap();
        upsert_page_op(&storage, &sink, &page("p1", "Algebra")).unwrap();
        soft_delete_op(&storage, &sink, EntityKind::Page, "p1").unwrap();
        soft_delete_op(&storage, &sink, EntityKind::Section, "s1").unwrap();
        purge_op(&storage, &sink, EntityKind::Page, "p1").unwrap();

        let got: Vec<_> = sink.0.borrow().iter().map(|c| (c.kind, c.page_id.clone(), c.title.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("tree", None, None),
                ("tree", None, None),
                ("page-updated", Some("p1".into()), Some("Algebra".into())),
                ("page-trashed", Some("p1".into()), None),
                ("tree", None, None),
                ("page-trashed", Some("p1".into()), None),
            ]
        );
        assert!(sink.0.borrow().iter().all(|c| c.source == "page-p1"));
        let json = serde_json::to_value(&sink.0.borrow()[2]).unwrap();
        assert_eq!(json["pageId"], "p1");
        assert_eq!(json["kind"], "page-updated");
    }

    fn folder(id: &str, parent: Option<&str>) -> Bookshelf {
        Bookshelf {
            id: id.into(),
            title: id.into(),
            icon: None,
            color: None,
            order: 0,
            is_expanded: true,
            created_at: now_iso(),
            updated_at: now_iso(),
            deleted_at: None,
            version: 0,
            parent_id: parent.map(Into::into),
        }
    }

    #[test]
    fn move_bookshelf_moves_and_refuses_a_cycle_with_a_readable_message() {
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let sink = Recorder(RefCell::new(Vec::new()));
        storage.lock().unwrap().upsert_bookshelf(&folder("a", None)).unwrap();
        storage.lock().unwrap().upsert_bookshelf(&folder("b", None)).unwrap();

        move_bookshelf_op(&storage, &sink, "b", Some("a")).unwrap();
        let tree = storage.lock().unwrap().list_tree().unwrap();
        assert_eq!(tree.bookshelves[1].parent_id.as_deref(), Some("a"));
        assert_eq!(sink.0.borrow().len(), 1);

        let err = move_bookshelf_op(&storage, &sink, "a", Some("b")).unwrap_err();
        assert_eq!(err, "Cannot move a folder into itself");
        assert_eq!(sink.0.borrow().len(), 1, "a refused move notifies nobody");
    }

    #[test]
    fn failed_mutation_emits_nothing() {
        let storage = Mutex::new(Storage::open_in_memory().unwrap());
        let sink = Recorder(RefCell::new(Vec::new()));
        let failed: Res<()> = mutate(&storage, &sink, NotebookChange::tree, |_| {
            Err(mate_core::storage::StorageError::NotFound("x".into()))
        });
        assert!(failed.is_err());
        assert!(sink.0.borrow().is_empty());
    }
}
