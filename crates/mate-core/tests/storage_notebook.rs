mod common;

use common::{folder, page, seeded, stroke, unit};
use mate_core::model::{BackgroundType, PageMode};
use mate_core::storage::{EntityKind, Storage, StorageError};

#[test]
fn tree_round_trip() {
    let mut st = seeded();
    let mut child = page("p2", "sec1", Some("p1"));
    child.mode = PageMode::Page;
    child.background_config.r#type = BackgroundType::DotGrid;
    child.page_width = Some(816.0);
    st.upsert_page(&child).unwrap();

    let tree = st.list_tree().unwrap();
    assert_eq!(tree.bookshelves.len(), 1);
    assert_eq!(tree.bookshelves[0].id, "s1");
    assert_eq!(tree.units.len(), 1);
    assert_eq!(tree.units[0].bookshelf_id.as_deref(), Some("s1"));
    assert_eq!(tree.sections.len(), 1);
    assert_eq!(tree.sections[0].unit_id, "u1");
    assert_eq!(tree.pages.len(), 2);
    let p1 = tree.pages.iter().find(|p| p.id == "p1").unwrap();
    assert_eq!(p1.section_id, "sec1");
    assert_eq!(p1.parent_id, None);
    let p2 = tree.pages.iter().find(|p| p.id == "p2").unwrap();
    assert_eq!(p2.section_id, "sec1");
    assert_eq!(p2.parent_id.as_deref(), Some("p1"));
    assert_eq!(p2.mode, PageMode::Page);
    assert_eq!(p2.background_config.r#type, BackgroundType::DotGrid);
    assert_eq!(p2.page_width, Some(816.0));
    assert_eq!(p2.version, 1);
}

#[test]
fn upsert_page_bumps_version() {
    let mut st = seeded();
    let mut p = page("p1", "sec1", None);
    p.title = "Renamed".into();
    st.upsert_page(&p).unwrap();
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.pages.len(), 1);
    assert_eq!(tree.pages[0].title, "Renamed");
    assert_eq!(tree.pages[0].version, 2);
}

#[test]
fn soft_delete_unit_hides_descendants() {
    let mut st = seeded();
    st.upsert_page(&page("p2", "sec1", Some("p1"))).unwrap();
    st.soft_delete(EntityKind::Unit, "u1").unwrap();

    let tree = st.list_tree().unwrap();
    assert_eq!(tree.bookshelves.len(), 1);
    assert!(tree.units.is_empty());
    assert!(tree.sections.is_empty());
    assert!(tree.pages.is_empty());

    let trash = st.list_trash().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].kind, EntityKind::Unit);
    assert_eq!(trash[0].id, "u1");
    assert_eq!(trash[0].title, "Unit u1");
}

#[test]
fn restore_page_restores_elements() {
    let mut st = seeded();
    st.upsert_elements(&[
        stroke("e1", "p1", 3),
        stroke("e2", "p1", 3),
        stroke("e3", "p1", 3),
    ])
    .unwrap();

    st.soft_delete(EntityKind::Page, "p1").unwrap();
    assert!(st.load_elements("p1").unwrap().is_empty());

    st.restore(EntityKind::Page, "p1").unwrap();
    assert_eq!(st.load_elements("p1").unwrap().len(), 3);
    assert_eq!(st.list_tree().unwrap().pages.len(), 1);
    assert!(st.list_trash().unwrap().is_empty());
}

#[test]
fn restore_keeps_separately_deleted_items_in_trash() {
    let mut st = seeded();
    st.upsert_page(&page("p2", "sec1", None)).unwrap();
    st.upsert_elements(&[stroke("e1", "p1", 3), stroke("e2", "p1", 3)])
        .unwrap();

    st.delete_elements(&["e2".to_string()]).unwrap();
    st.soft_delete(EntityKind::Page, "p2").unwrap();
    // Distinct timestamps for the two delete operations.
    std::thread::sleep(std::time::Duration::from_millis(5));
    st.soft_delete(EntityKind::Section, "sec1").unwrap();
    assert_eq!(
        st.list_trash().unwrap().len(),
        1,
        "only the section is top-most"
    );

    st.restore(EntityKind::Section, "sec1").unwrap();
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.sections.len(), 1);
    let ids: Vec<_> = tree.pages.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["p1"]);
    let elements = st.load_elements("p1").unwrap();
    assert_eq!(elements.len(), 1);
    assert_eq!(elements[0].id, "e1");

    let trash = st.list_trash().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].kind, EntityKind::Page);
    assert_eq!(trash[0].id, "p2");
}

#[test]
fn purge_older_than_removes_only_old() {
    let path = std::env::temp_dir().join(format!("mate-test-{}.db", mate_core::model::new_id()));
    {
        let mut st = Storage::open(&path).unwrap();
        st.upsert_bookshelf(&common::shelf("s1")).unwrap();
        st.upsert_unit(&common::unit("u1", Some("s1"))).unwrap();
        st.upsert_section(&common::section("sec1", "u1")).unwrap();
        st.upsert_page(&page("old", "sec1", None)).unwrap();
        st.upsert_page(&page("old-child", "sec1", Some("old")))
            .unwrap();
        st.upsert_page(&page("new", "sec1", None)).unwrap();
        st.upsert_elements(&[stroke("e-old", "old", 2), stroke("e-new", "new", 2)])
            .unwrap();
        st.soft_delete(EntityKind::Page, "old").unwrap();
        st.soft_delete(EntityKind::Page, "new").unwrap();

        let raw = rusqlite::Connection::open(&path).unwrap();
        let backdated = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-40 days')";
        raw.execute(
            &format!("UPDATE pages SET deleted_at = {backdated} WHERE id IN ('old', 'old-child')"),
            [],
        )
        .unwrap();
        raw.execute(
            &format!("UPDATE elements SET deleted_at = {backdated} WHERE page_id = 'old'"),
            [],
        )
        .unwrap();
        drop(raw);

        assert_eq!(st.purge_older_than(30).unwrap(), 1);

        let trash = st.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, "new");
        assert_eq!(st.count_elements("old").unwrap(), 0);
        st.restore(EntityKind::Page, "new").unwrap();
        let tree = st.list_tree().unwrap();
        let ids: Vec<_> = tree.pages.iter().map(|p| p.id.as_str()).collect();
        assert!(!ids.contains(&"old") && !ids.contains(&"old-child"));
        assert_eq!(st.load_elements("new").unwrap().len(), 1);
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn purge_hard_deletes_descendants() {
    let mut st = seeded();
    st.upsert_page(&page("p2", "sec1", Some("p1"))).unwrap();
    st.upsert_elements(&[stroke("e1", "p2", 2)]).unwrap();
    st.soft_delete(EntityKind::Unit, "u1").unwrap();
    st.purge(EntityKind::Unit, "u1").unwrap();

    assert!(st.list_trash().unwrap().is_empty());
    assert_eq!(st.count_elements("p2").unwrap(), 0);
    // Restoring a purged row is NotFound, proving it is gone, not hidden.
    assert!(matches!(
        st.restore(EntityKind::Page, "p2"),
        Err(mate_core::storage::StorageError::NotFound(_))
    ));
}

#[test]
fn reopen_file_db_keeps_data() {
    let path = std::env::temp_dir().join(format!("mate-test-{}.db", mate_core::model::new_id()));
    {
        let mut st = Storage::open(&path).unwrap();
        st.upsert_bookshelf(&common::shelf("s1")).unwrap();
    }
    {
        let st = Storage::open(&path).unwrap();
        assert_eq!(st.list_tree().unwrap().bookshelves.len(), 1);
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn delete_bookshelf_detaches_units() {
    let mut st = seeded();
    let before = st.list_tree().unwrap().units[0].version;
    st.soft_delete(EntityKind::Bookshelf, "s1").unwrap();

    let tree = st.list_tree().unwrap();
    assert!(tree.bookshelves.is_empty());
    assert_eq!(tree.units.len(), 1);
    assert_eq!(tree.units[0].bookshelf_id, None);
    assert_eq!(tree.units[0].version, before + 1);
    assert_eq!(tree.sections.len(), 1);
    assert_eq!(tree.pages.len(), 1);

    let trash = st.list_trash().unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].kind, EntityKind::Bookshelf);
    assert_eq!(trash[0].id, "s1");

    st.restore(EntityKind::Bookshelf, "s1").unwrap();
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.bookshelves.len(), 1);
    assert_eq!(
        tree.units[0].bookshelf_id, None,
        "units are not re-attached"
    );
}

#[test]
fn purge_bookshelf_keeps_units() {
    let mut st = seeded();
    st.upsert_elements(&[stroke("e1", "p1", 2)]).unwrap();
    st.purge(EntityKind::Bookshelf, "s1").unwrap();

    let tree = st.list_tree().unwrap();
    assert!(tree.bookshelves.is_empty());
    assert_eq!(tree.units.len(), 1);
    assert_eq!(tree.units[0].bookshelf_id, None);
    assert_eq!(tree.sections.len(), 1);
    assert_eq!(tree.pages.len(), 1);
    assert_eq!(st.count_elements("p1").unwrap(), 1);
    assert!(st.list_trash().unwrap().is_empty());
    assert!(matches!(
        st.restore(EntityKind::Bookshelf, "s1"),
        Err(mate_core::storage::StorageError::NotFound(_))
    ));
}

#[test]
fn bump_thumbnail_version_increments_and_never_regresses() {
    let mut st = seeded();
    assert_eq!(st.bump_thumbnail_version("p1").unwrap(), 1);
    assert_eq!(st.bump_thumbnail_version("p1").unwrap(), 2);
    // A stale client copy of the page (thumbnail_version 0) must not move the counter back.
    st.upsert_page(&page("p1", "sec1", None)).unwrap();
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.pages[0].thumbnail_version, 2);
    // Bumping does not count as an edit of the page.
    assert_eq!(tree.pages[0].version, 2);
}

#[test]
fn bump_thumbnail_version_unknown_page_is_not_found() {
    let mut st = seeded();
    assert!(st.bump_thumbnail_version("nope").is_err());
}

// ---- Folders (nested bookshelves, schema v4) ----

fn shelf_ids(st: &Storage) -> Vec<String> {
    st.list_tree().unwrap().bookshelves.into_iter().map(|b| b.id).collect()
}

fn parent_of(st: &Storage, id: &str) -> Option<String> {
    st.list_tree()
        .unwrap()
        .bookshelves
        .into_iter()
        .find(|b| b.id == id)
        .expect("live folder")
        .parent_id
}

fn trash_ids(st: &Storage) -> Vec<String> {
    st.list_trash().unwrap().into_iter().map(|t| t.id).collect()
}

/// s1 > s2 > s3, with book u1 in s1 (from `seeded`) and u3 in s3.
fn nested() -> Storage {
    let mut st = seeded();
    st.upsert_bookshelf(&folder("s2", Some("s1"))).unwrap();
    st.upsert_bookshelf(&folder("s3", Some("s2"))).unwrap();
    st.upsert_unit(&unit("u3", Some("s3"))).unwrap();
    st
}

#[test]
fn migrates_v3_to_v4_keeping_shelves_at_the_root() {
    let path = std::env::temp_dir().join(format!("mate-v3-{}.db", mate_core::model::new_id()));
    {
        // A database exactly as v0.8 left it: schema v3 with one shelf holding one book.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(include_str!("../src/storage/schema.sql")).unwrap();
        conn.execute_batch(include_str!("../src/storage/schema_v2.sql")).unwrap();
        conn.execute_batch(include_str!("../src/storage/schema_v3.sql")).unwrap();
        conn.execute_batch("INSERT INTO schema_version (version) VALUES (1), (2), (3)").unwrap();
        let now = "2026-01-01T00:00:00.000Z";
        conn.execute(
            "INSERT INTO bookshelves (id, title, created_at, updated_at) VALUES ('s1', 'Maths', ?1, ?1)",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO units (id, title, bookshelf_id, created_at, updated_at) \
             VALUES ('u1', 'Algebra', 's1', ?1, ?1)",
            [now],
        )
        .unwrap();
    }

    let mut st = Storage::open(&path).unwrap();
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.bookshelves.len(), 1);
    assert_eq!(tree.bookshelves[0].title, "Maths");
    assert_eq!(tree.bookshelves[0].parent_id, None);
    assert_eq!(tree.units[0].bookshelf_id.as_deref(), Some("s1"));
    // The v4 column works on the migrated database and serializes as `parentId`.
    st.upsert_bookshelf(&folder("s2", Some("s1"))).unwrap();
    let child = st.list_tree().unwrap().bookshelves.into_iter().find(|b| b.id == "s2").unwrap();
    assert_eq!(serde_json::to_value(&child).unwrap()["parentId"], "s1");
    drop(st);

    // Reopening is a no-op migration and keeps the hierarchy.
    let st = Storage::open(&path).unwrap();
    assert_eq!(parent_of(&st, "s2").as_deref(), Some("s1"));
    drop(st);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn folder_moves_between_parents_and_to_the_root() {
    let mut st = nested();
    st.upsert_bookshelf(&folder("other", None)).unwrap();
    st.move_bookshelf("s3", Some("other")).unwrap();
    assert_eq!(parent_of(&st, "s3").as_deref(), Some("other"));
    st.move_bookshelf("s3", None).unwrap();
    assert_eq!(parent_of(&st, "s3"), None);
    // The book inside travels with its folder.
    let u3 = st.list_tree().unwrap().units.into_iter().find(|u| u.id == "u3").unwrap();
    assert_eq!(u3.bookshelf_id.as_deref(), Some("s3"));
}

#[test]
fn folder_cannot_move_into_itself_or_a_descendant() {
    let mut st = nested();
    assert!(matches!(st.move_bookshelf("s1", Some("s1")), Err(StorageError::FolderCycle)));
    assert!(matches!(st.move_bookshelf("s1", Some("s3")), Err(StorageError::FolderCycle)));
    // The same rule holds for a full upsert carrying a parent.
    assert!(matches!(
        st.upsert_bookshelf(&folder("s1", Some("s2"))),
        Err(StorageError::FolderCycle)
    ));
    assert_eq!(parent_of(&st, "s1"), None);
    assert_eq!(parent_of(&st, "s2").as_deref(), Some("s1"));
    assert_eq!(StorageError::FolderCycle.to_string(), "Cannot move a folder into itself");
}

#[test]
fn folder_parent_must_exist_and_be_live() {
    let mut st = nested();
    assert!(matches!(st.move_bookshelf("s3", Some("nope")), Err(StorageError::NotFound(_))));
    assert!(matches!(st.move_bookshelf("nope", None), Err(StorageError::NotFound(_))));
    st.upsert_bookshelf(&folder("gone", None)).unwrap();
    st.soft_delete(EntityKind::Bookshelf, "gone").unwrap();
    assert!(matches!(st.move_bookshelf("s3", Some("gone")), Err(StorageError::NotFound(_))));
    assert!(matches!(
        st.upsert_bookshelf(&folder("new", Some("gone"))),
        Err(StorageError::NotFound(_))
    ));
}

#[test]
fn trashing_a_folder_trashes_subfolders_and_unfiles_books() {
    let mut st = nested();
    st.soft_delete(EntityKind::Bookshelf, "s1").unwrap();

    let tree = st.list_tree().unwrap();
    assert!(tree.bookshelves.is_empty());
    assert_eq!(tree.units.len(), 2, "books are never trashed with a folder");
    assert!(tree.units.iter().all(|u| u.bookshelf_id.is_none()));
    assert_eq!(trash_ids(&st), ["s1"], "only the top-most folder is listed");

    st.restore(EntityKind::Bookshelf, "s1").unwrap();
    assert_eq!(shelf_ids(&st), ["s1", "s2", "s3"]);
    assert_eq!(parent_of(&st, "s1"), None);
    assert_eq!(parent_of(&st, "s2").as_deref(), Some("s1"));
    assert_eq!(parent_of(&st, "s3").as_deref(), Some("s2"));
    assert!(st.list_trash().unwrap().is_empty());
}

#[test]
fn restore_keeps_a_separately_trashed_subfolder_in_the_trash() {
    let mut st = nested();
    st.soft_delete(EntityKind::Bookshelf, "s3").unwrap();
    st.soft_delete(EntityKind::Bookshelf, "s1").unwrap();
    // s3 sits under a trashed folder: hidden until its parent comes back.
    assert_eq!(trash_ids(&st), ["s1"]);
    st.restore(EntityKind::Bookshelf, "s1").unwrap();
    assert_eq!(shelf_ids(&st), ["s1", "s2"]);
    assert_eq!(trash_ids(&st), ["s3"]);
}

#[test]
fn restoring_a_folder_whose_parent_is_trashed_puts_it_at_the_root() {
    let mut st = nested();
    st.soft_delete(EntityKind::Bookshelf, "s1").unwrap();
    st.restore(EntityKind::Bookshelf, "s2").unwrap();
    assert_eq!(shelf_ids(&st), ["s2", "s3"]);
    assert_eq!(parent_of(&st, "s2"), None);
    assert_eq!(parent_of(&st, "s3").as_deref(), Some("s2"));
}

#[test]
fn purging_a_folder_removes_subfolders_and_keeps_books() {
    let mut st = nested();
    st.upsert_elements(&[stroke("e1", "p1", 2)]).unwrap();
    st.soft_delete(EntityKind::Bookshelf, "s1").unwrap();
    st.purge(EntityKind::Bookshelf, "s1").unwrap();

    let tree = st.list_tree().unwrap();
    assert!(tree.bookshelves.is_empty());
    assert_eq!(tree.units.len(), 2);
    assert!(tree.units.iter().all(|u| u.bookshelf_id.is_none()));
    assert_eq!(st.count_elements("p1").unwrap(), 1);
    assert!(st.list_trash().unwrap().is_empty());
    for id in ["s1", "s2", "s3"] {
        assert!(matches!(st.restore(EntityKind::Bookshelf, id), Err(StorageError::NotFound(_))));
    }
}
