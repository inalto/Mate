mod common;

use std::fs;
use std::io::{Cursor, Read};
use std::path::PathBuf;

use common::{page, section, stroke, unit};
use mate_core::archive::{export_backup, import_archive, wipe_local_data};
use mate_core::storage::Storage;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mate-backup-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn two_books() -> Storage {
    let mut st = Storage::open_in_memory().unwrap();
    for (u, s, p) in [("u1", "s1", "p1"), ("u2", "s2", "p2")] {
        st.upsert_unit(&unit(u, None)).unwrap();
        st.upsert_section(&section(s, u)).unwrap();
        st.upsert_page(&page(p, s, None)).unwrap();
        st.upsert_elements(&[stroke(&format!("e-{p}"), p, 3)]).unwrap();
    }
    st
}

#[test]
fn export_backup_contains_every_book_as_importable_archive() {
    let dir = tmp("export");
    let bytes = export_backup(&two_books(), &dir.join("assets")).unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
    assert!(names.contains(&"backup.json".to_string()));
    let books: Vec<&String> = names.iter().filter(|n| n.starts_with("books/") && n.ends_with(".mate")).collect();
    assert_eq!(books.len(), 2, "{names:?}");
    let mut inner = Vec::new();
    zip.by_name(books[0]).unwrap().read_to_end(&mut inner).unwrap();
    let mut dest = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dest, &inner, &dir.join("assets2")).unwrap();
    assert_eq!(report.pages, 1);
}

#[test]
fn wipe_local_data_removes_db_assets_and_settings() {
    let dir = tmp("wipe");
    for f in ["mate.db", "mate.db-wal", "settings.json", "keep.txt"] {
        fs::write(dir.join(f), b"x").unwrap();
    }
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::write(dir.join("assets/a.png"), b"x").unwrap();
    wipe_local_data(&dir).unwrap();
    assert!(!dir.join("mate.db").exists());
    assert!(!dir.join("mate.db-wal").exists());
    assert!(!dir.join("settings.json").exists());
    assert!(!dir.join("assets").exists());
    assert!(dir.join("keep.txt").exists());
    wipe_local_data(&dir).unwrap(); // idempotent
}
