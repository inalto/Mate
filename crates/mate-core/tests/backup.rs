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

// --- Recordings: audio streamed beside the books -------------------------------------------

use mate_core::archive::{BackupReport, Recordings, export_unit, restore_backup, restore_backup_capped};
use mate_core::model::{Element, ElementType};
use serde_json::json;
use std::io::Write;

const WEBM: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81];
const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
/// Per-book cap of these tests (scaled down from 512 MiB).
const CAP: u64 = 256 * 1024;

/// A `len`-byte WebM segment ending in `tail`.
fn segment(dir: &std::path::Path, len: usize, tail: u8) -> assets::AssetInfo {
    let mut d = WEBM.to_vec();
    d.resize(len - 1, 0);
    d.push(tail);
    assets::save_sniffed(dir, &d).unwrap()
}

/// [`two_books`] with a recording marker on `p1` (book `u1`) over two 200 KiB WebM segments:
/// 400 KiB of audio, more than [`CAP`].
fn books_with_recording(assets_dir: &std::path::Path) -> (Storage, [assets::AssetInfo; 2]) {
    let mut st = two_books();
    let (a, b) = (segment(assets_dir, 200 * 1024, 1), segment(assets_dir, 200 * 1024, 2));
    let mut marker = stroke("rec", "p1", 0);
    marker.r#type = ElementType::Media;
    marker.image_url = Some(a.id.clone());
    marker.content = Some(json!({
        "kind": "audio", "title": "Lecture",
        "recording": {
            "unitId": "u1",
            "spans": [{ "wallStart": "2026-11-14T09:00:00.000Z", "audioStartMs": 0, "durationMs": 600000 }],
            "segments": [
                { "assetId": a.id, "durationMs": 300000, "mime": "video/webm" },
                { "assetId": b.id, "durationMs": 300000, "mime": "video/webm" }
            ]
        }
    }));
    st.upsert_elements(&[marker]).unwrap();
    (st, [a, b])
}

fn backup_of(st: &Storage, assets_dir: &std::path::Path) -> (Vec<u8>, BackupReport) {
    let (out, report) = write_backup_capped(st, assets_dir, Cursor::new(Vec::new()), CAP).unwrap();
    (out.into_inner(), report)
}

/// The (first) media element of the restored library.
fn restored_marker(dest: &Storage) -> Option<Element> {
    let tree = dest.list_tree().unwrap();
    tree.pages
        .iter()
        .flat_map(|p| dest.load_elements(&p.id).unwrap())
        .find(|e| e.r#type == ElementType::Media)
}

fn segment_ids(e: &Element) -> Vec<String> {
    e.content.as_ref().unwrap()["recording"]["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["assetId"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn backup_streams_recording_audio_beside_the_books() {
    let dir = tmp("rec-stream");
    let assets_dir = dir.join("assets");
    let (st, [a, b]) = books_with_recording(&assets_dir);
    let (bytes, report) = backup_of(&st, &assets_dir);
    assert_eq!(report.books, 2);
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert!(report.missing_audio.is_empty());

    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    for seg in [&a, &b] {
        let mut entry = zip.by_name(&format!("recordings/{}.webm", seg.id)).unwrap();
        assert_eq!(entry.compression(), zip::CompressionMethod::Stored, "audio is stored as-is");
        let mut data = Vec::new();
        entry.read_to_end(&mut data).unwrap();
        assert_eq!(data, fs::read(&seg.path).unwrap());
    }
    let mut inner = Vec::new();
    zip.by_name("books/01-unit-u1.mate").unwrap().read_to_end(&mut inner).unwrap();
    let mut book = zip::ZipArchive::new(Cursor::new(inner)).unwrap();
    assert!(!book.file_names().any(|n| n.starts_with("assets/")), "no audio inside the book");
    let mut page = String::new();
    book.by_name("pages/p1.json").unwrap().read_to_string(&mut page).unwrap();
    let els: Vec<Element> = serde_json::from_str(&page).unwrap();
    let marker = els.iter().find(|e| e.id == "rec").unwrap();
    assert_eq!(segment_ids(marker), vec![a.id.clone(), b.id.clone()], "the marker keeps its recording");
    assert_eq!(marker.image_url.as_deref(), Some(a.id.as_str()));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn restore_reattaches_recording_audio() {
    let dir = tmp("rec-restore");
    let assets_dir = dir.join("assets");
    let (st, [a, b]) = books_with_recording(&assets_dir);
    let (bytes, _) = backup_of(&st, &assets_dir);

    let restored_dir = dir.join("restored");
    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup(&mut dest, Cursor::new(bytes), &restored_dir).unwrap();
    assert_eq!(report.books.len(), 2);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let marker = restored_marker(&dest).unwrap();
    let rec = &marker.content.as_ref().unwrap()["recording"];
    assert_eq!(rec["unitId"], report.books[0].unit_id.as_str());
    assert_eq!(rec["spans"][0]["durationMs"], 600000);
    let ids = segment_ids(&marker);
    assert_eq!(ids.len(), 2);
    for (id, original) in ids.iter().zip([&a, &b]) {
        assert_ne!(id, &original.id, "ids are new");
        let info = assets::asset_info(&restored_dir, id).expect("segment resolves to a stored asset");
        assert_eq!(info.mime, "video/webm");
        assert_eq!(fs::read(&info.path).unwrap(), fs::read(&original.path).unwrap());
    }
    assert_eq!(marker.image_url.as_deref(), Some(ids[0].as_str()));
    assert_eq!(fs::read_dir(&restored_dir).unwrap().count(), 2, "only the two segments stored");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_book_left_out_of_a_backup_is_an_error_not_a_footnote() {
    let dir = tmp("rec-left-out");
    let assets_dir = dir.join("assets");
    let (mut st, _) = books_with_recording(&assets_dir);
    // Book u2's own image is over the cap: the streamed audio of u1 does not count, this does.
    let mut png = PNG.to_vec();
    png.resize(300 * 1024, 0);
    let info = assets::save_sniffed(&assets_dir, &png).unwrap();
    let mut image = stroke("img", "p2", 2);
    image.r#type = ElementType::Image;
    image.image_url = Some(info.id);
    st.upsert_elements(&[image]).unwrap();

    let (_, report) = backup_of(&st, &assets_dir);
    assert_eq!(report.books, 1);
    assert_eq!(report.skipped_books(), vec!["Unit u2".to_string()]);
    assert!(report.missing_audio.is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn missing_segment_audio_is_reported_not_fatal() {
    let dir = tmp("rec-missing");
    let assets_dir = dir.join("assets");
    let (st, [a, b]) = books_with_recording(&assets_dir);
    fs::remove_file(&b.path).unwrap();
    let (bytes, report) = backup_of(&st, &assets_dir);
    assert_eq!(report.books, 2);
    assert_eq!(report.missing_audio, vec!["Unit u1".to_string()]);
    assert_eq!(serde_json::to_value(&report).unwrap()["missingAudio"], json!(["Unit u1"]));
    let zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    let audio: Vec<&str> = zip.file_names().filter(|n| n.starts_with("recordings/")).collect();
    assert_eq!(audio, vec![format!("recordings/{}.webm", a.id).as_str()]);

    // The segment that was found is re-attached; the lost one stays dangling.
    let restored_dir = dir.join("restored");
    let mut dest = Storage::open_in_memory().unwrap();
    restore_backup(&mut dest, Cursor::new(bytes), &restored_dir).unwrap();
    let ids = segment_ids(&restored_marker(&dest).unwrap());
    assert!(assets::asset_info(&restored_dir, &ids[0]).is_some());
    assert_eq!(ids[1], b.id);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_recording_whose_audio_is_nowhere_restores_like_an_excluded_one() {
    let dir = tmp("rec-nowhere");
    let assets_dir = dir.join("assets");
    let (st, [a, b]) = books_with_recording(&assets_dir);
    fs::remove_file(&a.path).unwrap();
    fs::remove_file(&b.path).unwrap();
    let (bytes, report) = backup_of(&st, &assets_dir);
    assert_eq!(report.missing_audio, vec!["Unit u1".to_string()]);

    let restored_dir = dir.join("restored");
    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup(&mut dest, Cursor::new(bytes), &restored_dir).unwrap();
    assert_eq!(report.books.len(), 2);
    let marker = restored_marker(&dest).unwrap();
    let content = marker.content.as_ref().unwrap();
    assert!(content.get("recording").is_none());
    assert_eq!(content["title"], "Lecture");
    assert_eq!(marker.image_url, None);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_old_format_backup_restores_as_before() {
    // Books only, each `.mate` carrying its own assets, as backups were written before recordings.
    let dir = tmp("rec-old");
    let assets_dir = dir.join("assets");
    let mut st = two_books();
    let img = assets::save_sniffed(&assets_dir, PNG).unwrap();
    let mut image = stroke("img", "p1", 2);
    image.r#type = ElementType::Image;
    image.image_url = Some(img.id.clone());
    st.upsert_elements(&[image]).unwrap();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for (i, u) in ["u1", "u2"].iter().enumerate() {
        zip.start_file(format!("books/0{}-unit-{u}.mate", i + 1), opts).unwrap();
        zip.write_all(&export_unit(&st, u, &assets_dir, Recordings::Exclude).unwrap()).unwrap();
    }
    zip.start_file("backup.json", opts).unwrap();
    zip.write_all(br#"{"format":"mate-backup","books":2,"skipped":[]}"#).unwrap();
    let bytes = zip.finish().unwrap().into_inner();

    let restored_dir = dir.join("restored");
    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup(&mut dest, Cursor::new(bytes), &restored_dir).unwrap();
    assert_eq!(report.books.len(), 2);
    assert!(report.failed.is_empty());
    let tree = dest.list_tree().unwrap();
    let titles: Vec<&str> = tree.units.iter().map(|u| u.title.as_str()).collect();
    assert_eq!(titles, ["Unit u1", "Unit u2"]);
    let restored_img = tree
        .pages
        .iter()
        .flat_map(|p| dest.load_elements(&p.id).unwrap())
        .find(|e| e.r#type == ElementType::Image)
        .unwrap();
    let id = restored_img.image_url.unwrap();
    assert_ne!(id, img.id);
    assert_eq!(assets::asset_info(&restored_dir, &id).unwrap().mime, "image/png");
    let _ = fs::remove_dir_all(&dir);
}

/// A backup zip of `entries` (name, data, compressed?) plus a `backup.json`.
fn zip_of(entries: &[(String, Vec<u8>, bool)]) -> Vec<u8> {
    let method = |deflate: bool| if deflate { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data, deflate) in entries {
        zip.start_file(name.as_str(), zip::write::SimpleFileOptions::default().compression_method(method(*deflate)))
            .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.start_file("backup.json", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(br#"{"format":"mate-backup"}"#).unwrap();
    zip.finish().unwrap().into_inner()
}

#[test]
fn restore_ignores_hostile_recording_entries() {
    let dir = tmp("rec-hostile");
    let assets_dir = dir.join("assets");
    let (st, [a, b]) = books_with_recording(&assets_dir);
    let (bytes, _) = backup_of(&st, &assets_dir);
    let mut src = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut book = Vec::new();
    src.by_name("books/01-unit-u1.mate").unwrap().read_to_end(&mut book).unwrap();
    let book_entry = ("books/01-unit-u1.mate".to_string(), book, false);
    let mut webm = WEBM.to_vec();
    webm.resize(1024, 7);
    let mut big = WEBM.to_vec();
    big.resize(4096, 0);
    let seg = |id: &str, ext: &str| format!("recordings/{id}.{ext}");

    // Both segments' entries are unusable (each in its own way): the marker loses its recording.
    let cases: Vec<(&str, Vec<(String, Vec<u8>, bool)>)> = vec![
        ("an image dressed as audio", vec![(seg(&a.id, "webm"), PNG.to_vec(), false), (seg(&b.id, "png"), PNG.to_vec(), false)]),
        ("audio over the per-entry limit", vec![(seg(&a.id, "webm"), big.clone(), false), (seg(&b.id, "webm"), big.clone(), false)]),
        // A backup stores audio as-is; a compressed entry could unpack to far more than it holds.
        ("compressed audio", vec![(seg(&a.id, "webm"), webm.clone(), true), (seg(&b.id, "webm"), webm.clone(), true)]),
        ("a directory", vec![(format!("recordings/{}.webm/", a.id), Vec::new(), false)]),
    ];
    for (why, entries) in cases {
        let mut all = vec![book_entry.clone()];
        all.extend(entries);
        let restored_dir = dir.join("restored");
        let mut dest = Storage::open_in_memory().unwrap();
        let report = restore_backup_capped(&mut dest, Cursor::new(zip_of(&all)), &restored_dir, 2048).unwrap();
        assert_eq!(report.books.len(), 1, "{why}");
        let marker = restored_marker(&dest).unwrap();
        assert!(marker.content.as_ref().unwrap().get("recording").is_none(), "{why}: stripped");
        assert_eq!(marker.image_url, None, "{why}");
        assert_eq!(fs::read_dir(&restored_dir).map(|d| d.count()).unwrap_or(0), 0, "{why}: nothing stored");
        let _ = fs::remove_dir_all(&restored_dir);
    }

    // A repeated id keeps the first entry; path tricks and names that are no asset id never
    // reach the store, nor anywhere outside it.
    let entries = vec![
        book_entry,
        (seg(&a.id, "webm"), webm.clone(), false),
        (seg(&a.id, "ogg"), PNG.to_vec(), false),
        ("recordings/../escape.webm".to_string(), webm.clone(), false),
        ("recordings/../../escape.webm".to_string(), webm.clone(), false),
        ("recordings/sub/x.webm".to_string(), webm.clone(), false),
        ("recordings/not-a-uuid.webm".to_string(), webm.clone(), false),
        ("/abs.webm".to_string(), webm.clone(), false),
    ];
    let restored_dir = dir.join("restored");
    let mut dest = Storage::open_in_memory().unwrap();
    restore_backup_capped(&mut dest, Cursor::new(zip_of(&entries)), &restored_dir, 2048).unwrap();
    let ids = segment_ids(&restored_marker(&dest).unwrap());
    let first = assets::asset_info(&restored_dir, &ids[0]).expect("segment a re-attached");
    assert_eq!(fs::read(&first.path).unwrap(), webm, "the first entry for an id wins");
    assert_eq!(ids[1], b.id, "segment b had no entry: dangling");
    assert_eq!(fs::read_dir(&restored_dir).unwrap().count(), 1, "only segment a stored");
    assert!(!dir.join("escape.webm").exists() && !dir.join("../escape.webm").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn restore_refuses_a_zip_that_is_no_backup() {
    let dir = tmp("rec-nobackup");
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("hello.txt", zip::write::SimpleFileOptions::default()).unwrap();
    zip.write_all(b"hi").unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let mut dest = Storage::open_in_memory().unwrap();
    assert!(restore_backup(&mut dest, Cursor::new(bytes), &dir).is_err());
    assert!(restore_backup(&mut dest, Cursor::new(b"not a zip".to_vec()), &dir).is_err());
    assert!(dest.list_tree().unwrap().units.is_empty());
    let _ = fs::remove_dir_all(&dir);
}
