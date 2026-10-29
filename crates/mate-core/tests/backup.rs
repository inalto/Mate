mod common;

use std::fs;
use std::io::{Cursor, Read};
use std::path::PathBuf;

use common::{page, section, stroke, unit};
use mate_core::archive::{BOOK_TOO_LARGE, export_backup, import_archive, wipe_local_data, write_backup_capped};
use mate_core::assets;
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
    let (bytes, report) = export_backup(&two_books(), &dir.join("assets")).unwrap();
    assert_eq!(report.books, 2);
    assert!(report.skipped.is_empty());
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

#[test]
fn a_book_over_the_cap_is_skipped_and_the_rest_still_backs_up() {
    let dir = tmp("skip");
    let assets_dir = dir.join("assets");
    let mut st = two_books();
    // Book u2 references a 300 KiB image: over a 256 KiB per-book cap (scaled down from 512 MiB).
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png.resize(300 * 1024, 0);
    let info = assets::save_sniffed(&assets_dir, &png).unwrap();
    let mut image = stroke("img", "p2", 2);
    image.r#type = mate_core::model::ElementType::Image;
    image.image_url = Some(info.id);
    st.upsert_elements(&[image]).unwrap();

    let (out, report) = write_backup_capped(&st, &assets_dir, Cursor::new(Vec::new()), 256 * 1024).unwrap();
    assert_eq!(report.books, 1);
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].unit_id, "u2");
    assert_eq!(report.skipped[0].title, "Unit u2");
    assert_eq!(report.skipped[0].reason, BOOK_TOO_LARGE);

    let mut zip = zip::ZipArchive::new(out).unwrap();
    let books: Vec<String> = zip.file_names().filter(|n| n.starts_with("books/")).map(String::from).collect();
    assert_eq!(books, vec!["books/01-unit-u1.mate".to_string()]);
    let mut manifest = String::new();
    zip.by_name("backup.json").unwrap().read_to_string(&mut manifest).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["books"], 1);
    assert_eq!(manifest["skipped"], serde_json::json!(["Unit u2"]));
    let mut inner = Vec::new();
    zip.by_name(&books[0]).unwrap().read_to_end(&mut inner).unwrap();
    let mut dest = Storage::open_in_memory().unwrap();
    assert_eq!(import_archive(&mut dest, &inner, &dir.join("assets2")).unwrap().pages, 1);
    let _ = fs::remove_dir_all(&dir);
}
