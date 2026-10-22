mod common;

use common::{page, seeded, stroke};
use mate_core::model::{BackgroundType, PageMode};
use mate_core::storage::{EntityKind, Storage};

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
