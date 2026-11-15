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
    assert_eq!(report.rejected_audio, 0);
    assert!(report.lost_recordings.is_empty());
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
    let restored = restore_backup(&mut dest, Cursor::new(bytes), &restored_dir).unwrap();
    let ids = segment_ids(&restored_marker(&dest).unwrap());
    assert!(assets::asset_info(&restored_dir, &ids[0]).is_some());
    assert_eq!(ids[1], b.id);
    assert_eq!(restored.lost_recordings, vec!["Unit u1".to_string()], "dangling segment reported");
    let json = serde_json::to_value(&restored).unwrap();
    assert_eq!(json["lostRecordings"], json!(["Unit u1"]));
    assert_eq!(json["rejectedAudio"], 0);
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
    assert_eq!(report.lost_recordings, vec!["Unit u1".to_string()], "stripped recording reported");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_segment_that_cannot_be_read_fails_the_backup() {
    // Present in the store but not readable as a file (here: a directory under its name), as a
    // locked or permission-denied file would be: not "missing", so the backup must not succeed
    // (a reset would otherwise delete audio its recovery zip does not hold).
    let dir = tmp("rec-unreadable");
    let assets_dir = dir.join("assets");
    let (st, [_, b]) = books_with_recording(&assets_dir);
    fs::remove_file(&b.path).unwrap();
    fs::create_dir(&b.path).unwrap();
    let err = write_backup_capped(&st, &assets_dir, Cursor::new(Vec::new()), CAP).unwrap_err();
    assert!(err.to_string().contains(&b.id), "{err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn restore_aborts_when_audio_cannot_be_written() {
    let dir = tmp("rec-nowrite");
    let assets_dir = dir.join("assets");
    let (st, _) = books_with_recording(&assets_dir);
    let (bytes, _) = backup_of(&st, &assets_dir);
    // The asset store cannot be created: a file is in its way.
    let blocked = dir.join("blocked");
    fs::write(&blocked, b"x").unwrap();
    let mut dest = Storage::open_in_memory().unwrap();
    let err = restore_backup(&mut dest, Cursor::new(bytes), &blocked).unwrap_err();
    assert!(matches!(err, mate_core::storage::StorageError::Io(_)), "{err:?}");
    assert!(dest.list_tree().unwrap().units.is_empty(), "nothing restored");
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
    type Entry = (String, Vec<u8>, bool);
    let cases: Vec<(&str, Vec<Entry>)> = vec![
        ("an image dressed as audio", vec![(seg(&a.id, "webm"), PNG.to_vec(), false), (seg(&b.id, "png"), PNG.to_vec(), false)]),
        ("audio over the per-entry limit", vec![(seg(&a.id, "webm"), big.clone(), false), (seg(&b.id, "webm"), big.clone(), false)]),
        // A backup stores audio as-is; a compressed entry could unpack to far more than it holds.
        ("compressed audio", vec![(seg(&a.id, "webm"), webm.clone(), true), (seg(&b.id, "webm"), webm.clone(), true)]),
        ("a directory", vec![(format!("recordings/{}.webm/", a.id), Vec::new(), false)]),
    ];
    for (why, entries) in cases {
        let hostile = entries.len();
        let mut all = vec![book_entry.clone()];
        all.extend(entries);
        let restored_dir = dir.join("restored");
        let mut dest = Storage::open_in_memory().unwrap();
        let report = restore_backup_capped(&mut dest, Cursor::new(zip_of(&all)), &restored_dir, 2048).unwrap();
        assert_eq!(report.books.len(), 1, "{why}");
        assert_eq!(report.rejected_audio, hostile, "{why}: counted");
        assert_eq!(report.lost_recordings, vec!["Unit u1".to_string()], "{why}");
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
    let report = restore_backup_capped(&mut dest, Cursor::new(zip_of(&entries)), &restored_dir, 2048).unwrap();
    // The repeat, both `..` names, the sub-path and the non-uuid; `/abs.webm` is no recording.
    assert_eq!(report.rejected_audio, 5);
    let ids = segment_ids(&restored_marker(&dest).unwrap());
    let first = assets::asset_info(&restored_dir, &ids[0]).expect("segment a re-attached");
    assert_eq!(fs::read(&first.path).unwrap(), webm, "the first entry for an id wins");
    assert_eq!(ids[1], b.id, "segment b had no entry: dangling");
    assert_eq!(fs::read_dir(&restored_dir).unwrap().count(), 1, "only segment a stored");
    assert!(!dir.join("escape.webm").exists() && !dir.join("../escape.webm").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_book_that_cannot_be_restored_is_named_and_the_rest_still_restore() {
    let dir = tmp("rec-failed-book");
    let assets_dir = dir.join("assets");
    let st = two_books();
    let good = export_unit(&st, "u1", &assets_dir, Recordings::Exclude).unwrap();
    // A book whose unit.json is readable but whose page is not: named by its title.
    let mut broken = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    let mut src = zip::ZipArchive::new(Cursor::new(export_unit(&st, "u2", &assets_dir, Recordings::Exclude).unwrap())).unwrap();
    for i in 0..src.len() {
        let mut f = src.by_index(i).unwrap();
        let name = f.name().to_owned();
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        broken.start_file(name.as_str(), opts).unwrap();
        broken.write_all(if name.starts_with("pages/") { b"not json" } else { &data }).unwrap();
    }
    let broken = broken.finish().unwrap().into_inner();
    let entries = vec![
        ("books/01-unit-u1.mate".to_string(), good, false),
        ("books/02-unit-u2.mate".to_string(), broken, false),
        // Not even a zip: named by its file name.
        ("books/03-garbage.mate".to_string(), b"garbage".to_vec(), false),
    ];
    let restored_dir = dir.join("restored");
    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup(&mut dest, Cursor::new(zip_of(&entries)), &restored_dir).unwrap();
    assert_eq!(report.books.len(), 1);
    let names: Vec<&str> = report.failed.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["Unit u2", "03-garbage.mate"]);
    assert!(report.failed.iter().all(|f| !f.error.is_empty()));
    assert_eq!(dest.list_tree().unwrap().units.len(), 1, "the broken book was rolled back");
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["failed"][0]["name"], "Unit u2");
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

// --- Recall results: in backups only ---------------------------------------------------------

use mate_core::archive::{MAX_RECALL_ROWS, restore_backup_recall_capped};
use mate_core::model::PenStyle;
use mate_core::storage::{EntityKind, LearningEvent, RECALL_KIND};

/// A cover stroke; `n` points tells covers apart after a restore re-mints their ids.
fn cover(id: &str, page_id: &str, n: usize) -> Element {
    Element { pen_style: Some(PenStyle::Cover), ..stroke(id, page_id, n) }
}

fn recall_row(st: &mut Storage, page_id: &str, element: &str, knew: bool, run: &str, at: &str) {
    st.record_learning_event(&LearningEvent {
        id: String::new(),
        page_id: page_id.into(),
        stroke_group_id: None,
        kind: RECALL_KIND.into(),
        payload: json!({ "elementId": element, "knew": knew, "runId": run }),
        created_at: at.into(),
    })
    .unwrap();
}

/// [`two_books`] with covers `c1` (3 points) and `c2` (4 points) on `p1`, answered in two runs.
fn books_with_recall() -> Storage {
    let mut st = two_books();
    st.upsert_elements(&[cover("c1", "p1", 3), cover("c2", "p1", 4)]).unwrap();
    recall_row(&mut st, "p1", "c1", true, "r1", "2026-11-01T10:00:00.000Z");
    recall_row(&mut st, "p1", "c2", false, "r1", "2026-11-01T10:00:01.000Z");
    recall_row(&mut st, "p1", "c1", false, "r2", "2026-11-02T10:00:00.000Z");
    recall_row(&mut st, "p1", "c2", true, "r2", "2026-11-02T10:00:01.000Z");
    st
}

/// The id of the restored page titled `Page <original>`.
fn restored_page(dest: &Storage, original: &str) -> String {
    let title = format!("Page {original}");
    dest.list_tree().unwrap().pages.into_iter().find(|p| p.title == title).unwrap().id
}

/// The id of the restored cover with `n` points on `page_id`.
fn restored_cover(dest: &Storage, page_id: &str, n: usize) -> String {
    let els = dest.load_elements(page_id).unwrap();
    els.into_iter().find(|e| e.pen_style == Some(PenStyle::Cover) && e.points.len() == n).unwrap().id
}

/// Every recall row of the restored library.
fn all_recall_rows(dest: &Storage) -> Vec<LearningEvent> {
    let units = dest.list_tree().unwrap().units;
    units.iter().flat_map(|u| dest.recall_rows(&u.id).unwrap()).collect()
}

/// `backup` with book `u1`'s `recall.json` replaced by `recall`.
fn with_recall_file(backup: &[u8], recall: &[u8]) -> Vec<u8> {
    fn read(f: &mut impl Read) -> Vec<u8> {
        let mut data = Vec::new();
        f.read_to_end(&mut data).unwrap();
        data
    }
    let mut src = zip::ZipArchive::new(Cursor::new(backup)).unwrap();
    let mut entries = Vec::new();
    for i in 0..src.len() {
        let mut f = src.by_index(i).unwrap();
        let name = f.name().to_owned();
        let mut data = read(&mut f);
        if name == "backup.json" {
            continue;
        }
        if name == "books/01-unit-u1.mate" {
            let mut book = zip::ZipArchive::new(Cursor::new(data)).unwrap();
            let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for j in 0..book.len() {
                let mut e = book.by_index(j).unwrap();
                let inner = e.name().to_owned();
                let d = read(&mut e);
                if inner != "recall.json" {
                    out.start_file(inner.as_str(), zip::write::SimpleFileOptions::default()).unwrap();
                    out.write_all(&d).unwrap();
                }
            }
            out.start_file("recall.json", zip::write::SimpleFileOptions::default()).unwrap();
            out.write_all(recall).unwrap();
            data = out.finish().unwrap().into_inner();
        }
        entries.push((name, data, false));
    }
    zip_of(&entries)
}

#[test]
fn a_backup_round_trips_recall_results() {
    let dir = tmp("recall-round-trip");
    let assets_dir = dir.join("assets");
    let mut st = books_with_recall();
    // A trashed page's rows travel in the backup but have no page to come back to.
    st.upsert_page(&page("p3", "s1", None)).unwrap();
    recall_row(&mut st, "p3", "x", true, "r1", "2026-11-01T10:00:02.000Z");
    st.soft_delete(EntityKind::Page, "p3").unwrap();
    let (bytes, _) = backup_of(&st, &assets_dir);
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    let mut book = Vec::new();
    zip.by_name("books/01-unit-u1.mate").unwrap().read_to_end(&mut book).unwrap();
    let book = zip::ZipArchive::new(Cursor::new(book)).unwrap();
    assert!(book.file_names().any(|n| n == "recall.json"), "the backup book carries its answers");
    let mut other = Vec::new();
    zip.by_name("books/02-unit-u2.mate").unwrap().read_to_end(&mut other).unwrap();
    let other = zip::ZipArchive::new(Cursor::new(other)).unwrap();
    assert!(!other.file_names().any(|n| n == "recall.json"), "no file for a book without answers");

    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup(&mut dest, Cursor::new(bytes), &dir.join("restored")).unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let page_id = restored_page(&dest, "p1");
    let mut original = st.recall_page("p1").unwrap();
    original.page_id = page_id.clone();
    assert_eq!(dest.recall_page(&page_id).unwrap(), original);
    assert_eq!(original.answers, 4);
    for (old, n) in [("c1", 3), ("c2", 4)] {
        let new = restored_cover(&dest, &page_id, n);
        assert_ne!(new, old);
        assert_eq!(dest.recall_element(&new, 5).unwrap(), st.recall_element(old, 5).unwrap(), "{old}");
        assert!(dest.recall_element(old, 5).unwrap().is_empty(), "{old}: answers follow the new id");
    }
    let rows = all_recall_rows(&dest);
    assert_eq!(rows.len(), 4, "the trashed page's row is dropped");
    let originals = st.recall_rows("u1").unwrap();
    assert!(rows.iter().all(|r| originals.iter().all(|o| o.id != r.id)), "row ids are new");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_restored_row_of_a_deleted_cover_still_counts_for_its_page() {
    let dir = tmp("recall-deleted-cover");
    let assets_dir = dir.join("assets");
    let mut st = books_with_recall();
    st.upsert_elements(&[cover("gone", "p1", 5)]).unwrap();
    recall_row(&mut st, "p1", "gone", true, "r3", "2026-11-03T10:00:00.000Z");
    st.delete_elements(&["gone".to_string()]).unwrap();
    let (bytes, _) = backup_of(&st, &assets_dir);

    let mut dest = Storage::open_in_memory().unwrap();
    restore_backup(&mut dest, Cursor::new(bytes), &dir.join("restored")).unwrap();
    let page_id = restored_page(&dest, "p1");
    let s = dest.recall_page(&page_id).unwrap();
    assert_eq!((s.covers, s.answers, s.known, s.runs), (2, 5, 3, 3));
    assert_eq!(s.last.unwrap().run_id, "r3");
    // The cover is not in the archive, so its id is kept as it was.
    assert_eq!(dest.recall_element("gone", 5).unwrap(), vec![true]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_broken_recall_file_does_not_fail_the_restore() {
    let dir = tmp("recall-broken");
    let assets_dir = dir.join("assets");
    let (bytes, _) = backup_of(&books_with_recall(), &assets_dir);

    let broken = with_recall_file(&bytes, b"not json");
    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup(&mut dest, Cursor::new(broken), &dir.join("restored")).unwrap();
    assert_eq!(report.books.len(), 2);
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(dest.load_elements(&restored_page(&dest, "p1")).unwrap().len(), 3, "the book is restored");
    assert!(all_recall_rows(&dest).is_empty());

    // Rows that do not parse are skipped; the others still restore.
    let at = "2026-11-01T10:00:00.000Z";
    let mixed = json!([
        "garbage",
        { "pageId": "p1", "kind": "recall", "payload": { "elementId": "c1" }, "createdAt": at },
        { "pageId": "p1", "kind": "attempt", "payload": { "elementId": "c1", "knew": true, "runId": "a" }, "createdAt": at },
        { "pageId": "p1", "kind": "recall", "payload": { "elementId": "c1", "knew": true, "runId": "r" }, "createdAt": at }
    ]);
    let mixed = with_recall_file(&bytes, &serde_json::to_vec(&mixed).unwrap());
    let mut dest = Storage::open_in_memory().unwrap();
    restore_backup(&mut dest, Cursor::new(mixed), &dir.join("restored2")).unwrap();
    let rows = all_recall_rows(&dest);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].payload["runId"], "r");
    assert_eq!(rows[0].created_at, at, "created_at is kept");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn restored_recall_rows_with_an_empty_element_or_run_id_are_dropped() {
    let dir = tmp("recall-empty-ids");
    let assets_dir = dir.join("assets");
    let (bytes, _) = backup_of(&books_with_recall(), &assets_dir);
    let at = "2026-11-01T10:00:00.000Z";
    let rows = json!([
        { "pageId": "p1", "kind": "recall", "payload": { "elementId": "", "knew": true, "runId": "r" }, "createdAt": at },
        { "pageId": "p1", "kind": "recall", "payload": { "elementId": "c1", "knew": true, "runId": "" }, "createdAt": at },
        { "pageId": "p1", "kind": "recall", "payload": { "elementId": "c1", "knew": false, "runId": "r" }, "createdAt": at }
    ]);
    let file = with_recall_file(&bytes, &serde_json::to_vec(&rows).unwrap());
    let mut dest = Storage::open_in_memory().unwrap();
    restore_backup(&mut dest, Cursor::new(file), &dir.join("restored")).unwrap();
    let rows = all_recall_rows(&dest);
    assert_eq!(rows.len(), 1, "only the row with both ids is restored");
    assert_eq!((rows[0].payload["runId"].as_str(), rows[0].payload["knew"].as_bool()), (Some("r"), Some(false)));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn recall_rows_beyond_the_cap_are_skipped() {
    let dir = tmp("recall-cap");
    let assets_dir = dir.join("assets");
    let (bytes, _) = backup_of(&books_with_recall(), &assets_dir);
    let mut dest = Storage::open_in_memory().unwrap();
    let report = restore_backup_recall_capped(&mut dest, Cursor::new(bytes), &dir.join("restored"), 3).unwrap();
    assert_eq!(report.books.len(), 2);
    let rows = all_recall_rows(&dest);
    assert_eq!(rows.len(), 3, "the fourth row is past the cap");
    assert_eq!((rows[2].payload["runId"].as_str(), rows[2].payload["knew"].as_bool()), (Some("r2"), Some(false)));
    assert_eq!(MAX_RECALL_ROWS, 50_000);
    let _ = fs::remove_dir_all(&dir);
}
