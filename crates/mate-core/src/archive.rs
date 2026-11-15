//! `.mate` archives: a zip of one unit (book) with its sections, pages and elements.
//!
//! Layout: `manifest.json` (format marker + schema version), `unit.json`
//! (`{unit, sections, pages}`), `pages/<pageId>.json` (that page's live elements) and
//! `assets/<assetId>.<ext>` (every stored image, PDF or media file those elements reference through `image_url`,
//! `content.pdfSourceKey` or a recording's `content.recording.segments[].assetId`). Importing re-mints every id, asset ids included, so an archive can
//! be imported any number of times; a referenced asset missing from the archive leaves the
//! element's id dangling (the element renders its placeholder).
//!
//! A book written into a backup also carries `recall.json`, the cover study answers (a JSON array
//! of `learning_events` rows). Only the backup writer adds it and only [`restore_backup`] reads
//! it: an exported or shared book never says how its author scored.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Seek, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::assets;
use crate::model::{Element, ElementType, Page, Section, Unit, format_iso, new_id, now_iso};
use crate::import::MAX_MARKERS_PER_PAGE;
use crate::storage::elements::{MAX_ELEMENTS_PER_PAGE, MAX_POINTS_PER_STROKE, is_recording_marker};
use crate::storage::{EntityKind, LearningEvent, RECALL_KIND, Result, Storage, StorageError};

pub const ARCHIVE_FORMAT: &str = "mate-archive";
pub const ARCHIVE_SCHEMA_VERSION: u32 = 1;
/// Largest archive accepted for import.
pub const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
/// Largest single (uncompressed) `assets/` entry accepted for import (the largest asset, a media
/// file).
pub const MAX_ENTRY_BYTES: u64 = assets::MAX_ASSET_BYTES as u64;
/// Largest JSON entry (`manifest.json`, `unit.json`, `pages/*.json`) accepted for import.
pub const MAX_JSON_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Why [`export_unit`] refuses a book.
const TOO_LARGE: &str = "archive would be larger than 512 MiB";
/// Why a backup leaves a book out ([`SkippedBook::reason`]).
pub const BOOK_TOO_LARGE: &str = "left out of the backup: larger than 512 MiB";
/// Where a backup keeps recording audio: `recordings/<assetId>.<ext>`.
const RECORDINGS_DIR: &str = "recordings/";
/// The `format` of a backup's `backup.json`.
const BACKUP_FORMAT: &str = "mate-backup";
/// Most `assets/` entries an archive may carry.
pub const MAX_ARCHIVE_ASSETS: usize = 2000;
/// Most recall rows one book of a backup restores; rows past it are skipped.
pub const MAX_RECALL_ROWS: usize = 50_000;
/// A backup book's recall answers.
const RECALL_FILE: &str = "recall.json";

/// Bounds on what an import may write to the asset store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportLimits {
    /// Total decompressed bytes of all asset entries read (default [`MAX_ARCHIVE_BYTES`]).
    pub total_asset_bytes: u64,
    /// Most `assets/` entries (default [`MAX_ARCHIVE_ASSETS`]).
    pub max_assets: usize,
    /// Most recall rows a backup book restores (default [`MAX_RECALL_ROWS`]). Read only by a
    /// restore; it counts the entries of `recall.json`, the ones then skipped included.
    pub max_recall_rows: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        ImportLimits {
            total_asset_bytes: MAX_ARCHIVE_BYTES as u64,
            max_assets: MAX_ARCHIVE_ASSETS,
            max_recall_rows: MAX_RECALL_ROWS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    schema_version: u32,
    exported_at: String,
    app: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UnitFile {
    unit: Unit,
    sections: Vec<Section>,
    pages: Vec<Page>,
}

/// What an import created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub unit_id: String,
    pub pages: usize,
    pub elements: usize,
    /// Elements dropped for exceeding the per-stroke or per-page limits.
    pub skipped: usize,
}

fn limit(msg: impl Into<String>) -> StorageError {
    StorageError::Limit(msg.into())
}

fn zip_err(e: zip::result::ZipError) -> StorageError {
    limit(format!("archive error: {e}"))
}

fn io_err(e: std::io::Error) -> StorageError {
    limit(format!("archive i/o error: {e}"))
}

/// Asset ids an element references: `image_url`, `content.pdfSourceKey` and the
/// `content.recording.segments[].assetId` of a recording marker.
fn asset_refs(e: &Element) -> impl Iterator<Item = &str> {
    let pdf = e
        .content
        .as_ref()
        .and_then(|c| c.get("pdfSourceKey"))
        .and_then(|k| k.as_str());
    e.image_url.as_deref().into_iter().chain(pdf).chain(recording_segments(e))
}

/// The `content.recording.segments[].assetId`s of a recording marker.
fn recording_segments(e: &Element) -> impl Iterator<Item = &str> {
    e.content
        .as_ref()
        .and_then(|c| c.get("recording"))
        .and_then(|r| r.get("segments"))
        .and_then(|s| s.as_array())
        .into_iter()
        .flatten()
        .filter_map(|s| s.get("assetId").and_then(|a| a.as_str()))
}

/// Applies the export's recordings choice to `e`: without recordings a marker keeps its other
/// content but loses `content.recording` and its `image_url` (the first segment).
fn apply_recordings(e: &mut Element, recordings: Recordings) {
    match recordings {
        Recordings::Include | Recordings::External => {}
        Recordings::Exclude => {
            if let Some(serde_json::Value::Object(c)) = e.content.as_mut()
                && c.remove("recording").is_some()
            {
                e.image_url = None;
            }
        }
    }
}

/// Whether an export carries the lecture recordings (audio segments) of its `media` markers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recordings {
    /// Keep each marker's `recording` and ship its segment assets.
    Include,
    /// Strip `recording` and `image_url` from the markers and ship no segment assets.
    Exclude,
    /// Keep each marker's `recording` and `image_url` but ship no segment assets: the caller
    /// stores them beside the archive (a backup's `recordings/` entries).
    External,
}

/// A book's archive, and the recording segments a [`Recordings::External`] export left out of it.
struct Exported {
    bytes: Vec<u8>,
    segments: Vec<String>,
}

/// Serialises one live unit, its live sections and pages, their live elements and the assets
/// (from `assets_dir`) those elements reference to a zip. Referenced assets that are not stored
/// are left out; the whole archive is capped at [`MAX_ARCHIVE_BYTES`].
pub fn export_unit(
    storage: &Storage,
    unit_id: &str,
    assets_dir: &Path,
    recordings: Recordings,
) -> Result<Vec<u8>> {
    export_unit_capped(storage, unit_id, assets_dir, MAX_ARCHIVE_BYTES as u64, recordings, false)?
        .map(|e| e.bytes)
        .ok_or_else(|| limit(TOO_LARGE))
}

/// [`export_unit`] with the size cap passed in; `Ok(None)` when the archive would be larger than
/// `cap`. The asset files' sizes are checked before any of them is read, and each one is copied
/// into the zip from disk rather than loaded whole. With [`Recordings::External`] the segment
/// assets are neither archived nor counted against `cap`; their ids are returned instead.
/// `private` (the backup writer only) adds the unit's recall rows as `recall.json`, when it has
/// any; an export or a share must never carry them.
fn export_unit_capped(
    storage: &Storage,
    unit_id: &str,
    assets_dir: &Path,
    cap: u64,
    recordings: Recordings,
    private: bool,
) -> Result<Option<Exported>> {
    let tree = storage.list_tree()?;
    let unit = tree
        .units
        .into_iter()
        .find(|u| u.id == unit_id)
        .ok_or_else(|| StorageError::NotFound(format!("unit {unit_id}")))?;
    let sections: Vec<Section> = tree
        .sections
        .into_iter()
        .filter(|s| s.unit_id == unit_id)
        .collect();
    let pages: Vec<Page> = tree
        .pages
        .into_iter()
        .filter(|p| sections.iter().any(|s| s.id == p.section_id))
        .collect();

    let manifest = Manifest {
        format: ARCHIVE_FORMAT.into(),
        schema_version: ARCHIVE_SCHEMA_VERSION,
        exported_at: now_iso(),
        app: "Mate".into(),
    };
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let put = |zip: &mut ZipWriter<Cursor<Vec<u8>>>, name: &str, data: Vec<u8>| {
        zip.start_file(name, opts).map_err(zip_err)?;
        zip.write_all(&data).map_err(io_err)
    };
    put(
        &mut zip,
        "manifest.json",
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    let mut asset_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut segments: Vec<String> = Vec::new();
    let mut seen_segments: HashSet<String> = HashSet::new();
    for p in &pages {
        let mut elements = storage.load_elements(&p.id)?;
        for e in &mut elements {
            apply_recordings(e, recordings);
        }
        for id in elements.iter().flat_map(asset_refs) {
            if seen.insert(id.to_owned()) {
                asset_ids.push(id.to_owned());
            }
        }
        if recordings == Recordings::External {
            for id in elements.iter().flat_map(recording_segments) {
                if seen_segments.insert(id.to_owned()) {
                    segments.push(id.to_owned());
                }
            }
        }
        put(
            &mut zip,
            &format!("pages/{}.json", p.id),
            serde_json::to_vec(&elements)?,
        )?;
    }
    // External segments (a marker's `image_url` is its first one) stay out of the book.
    asset_ids.retain(|id| !seen_segments.contains(id));
    // Images and PDFs are already compressed: store them as-is.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut files = Vec::with_capacity(asset_ids.len());
    let mut total: u64 = 0;
    for id in &asset_ids {
        let Some(path) = assets::asset_path(assets_dir, id) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        total += meta.len();
        if total > cap {
            return Ok(None);
        }
        files.push((id, path));
    }
    for (id, path) in files {
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("bin");
        zip.start_file(format!("assets/{id}.{ext}"), stored)
            .map_err(zip_err)?;
        std::io::copy(&mut file, &mut zip).map_err(io_err)?;
    }
    if private {
        let rows = storage.recall_rows(unit_id)?;
        if !rows.is_empty() {
            put(&mut zip, RECALL_FILE, serde_json::to_vec(&rows)?)?;
        }
    }
    let unit_file = UnitFile {
        unit,
        sections,
        pages,
    };
    put(
        &mut zip,
        "unit.json",
        serde_json::to_vec_pretty(&unit_file)?,
    )?;
    let bytes = zip.finish().map_err(zip_err)?.into_inner();
    Ok((bytes.len() as u64 <= cap).then_some(Exported { bytes, segments }))
}

/// A book a backup left out, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedBook {
    pub unit_id: String,
    pub title: String,
    pub reason: String,
}

/// What a backup holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReport {
    /// Books written to the backup.
    pub books: usize,
    /// Books left out because their archive would exceed the per-book cap.
    pub skipped: Vec<SkippedBook>,
    /// Titles of backed-up books with a recording segment whose audio file was not found.
    pub missing_audio: Vec<String>,
}

impl BackupReport {
    /// Titles of the books left out of the backup (the user must be told: they are not in it).
    pub fn skipped_books(&self) -> Vec<String> {
        self.skipped.iter().map(|b| b.title.clone()).collect()
    }
}

/// The `books/NN-<slug>.mate` name of a book in a backup.
fn backup_name(index: usize, title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(40)
        .collect();
    let slug = if slug.is_empty() { "book".to_string() } else { slug };
    format!("books/{:02}-{slug}.mate", index + 1)
}

/// Writes every live book as its own `.mate` archive (`books/NN-<title>.mate`, stored without
/// further compression) plus a `backup.json` manifest to `out`, so a whole library can be restored
/// one book at a time. Each book is exported and written before the next one is read, so at most
/// one book's archive is in memory. Recording audio is not put inside the books: every segment a
/// marker references is copied from disk, stored as-is, to `recordings/<assetId>.<ext>` beside
/// them (so it does not count against the per-book cap; [`restore_backup`] re-attaches it), and a
/// book whose segment file is missing is listed in [`BackupReport::missing_audio`]. A book whose
/// archive would still exceed [`MAX_ARCHIVE_BYTES`] is left out and listed in the report instead
/// of failing the backup. Used by "Download backup" and the pre-reset recovery file. Returns `out`
/// (finished) with the report.
pub fn write_backup<W: Write + Seek>(
    storage: &Storage,
    assets_dir: &Path,
    out: W,
) -> Result<(W, BackupReport)> {
    write_backup_capped(storage, assets_dir, out, MAX_ARCHIVE_BYTES as u64)
}

/// [`write_backup`] with the per-book cap passed in (tests use a small one).
pub fn write_backup_capped<W: Write + Seek>(
    storage: &Storage,
    assets_dir: &Path,
    out: W,
    max_book_bytes: u64,
) -> Result<(W, BackupReport)> {
    let units = storage.list_tree()?.units;
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut zip = ZipWriter::new(out);
    let mut report = BackupReport::default();
    let mut audio_written: HashSet<String> = HashSet::new();
    for (i, unit) in units.iter().enumerate() {
        let Some(book) = export_unit_capped(
            storage,
            &unit.id,
            assets_dir,
            max_book_bytes,
            Recordings::External,
            true,
        )? else {
            report.skipped.push(SkippedBook {
                unit_id: unit.id.clone(),
                title: unit.title.clone(),
                reason: BOOK_TOO_LARGE.into(),
            });
            continue;
        };
        zip.start_file(backup_name(i, &unit.title), stored)
            .map_err(zip_err)?;
        zip.write_all(&book.bytes).map_err(io_err)?;
        report.books += 1;
        if copy_segments(&mut zip, assets_dir, &book.segments, &mut audio_written)? {
            report.missing_audio.push(unit.title.clone());
        }
    }
    let manifest = serde_json::json!({
        "format": BACKUP_FORMAT,
        "exportedAt": now_iso(),
        "books": report.books,
        "skipped": report.skipped.iter().map(|b| &b.title).collect::<Vec<_>>(),
        "missingAudio": report.missing_audio,
    });
    zip.start_file("backup.json", stored).map_err(zip_err)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)
        .map_err(io_err)?;
    Ok((zip.finish().map_err(zip_err)?, report))
}

/// Copies each of `segments` not yet in `written` from the asset store to
/// `recordings/<assetId>.<ext>` in `zip` (stored as-is, streamed from disk). Returns whether a
/// segment was missing: only an asset that is not in the store counts; any other failure to open
/// or copy one (a locked or unreadable file) fails the backup, so a reset never deletes audio its
/// recovery zip does not hold.
fn copy_segments<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    assets_dir: &Path,
    segments: &[String],
    written: &mut HashSet<String>,
) -> Result<bool> {
    // `large_file`: a semester of audio can put an entry's offset past 4 GiB (zip64).
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);
    let mut missing = false;
    for id in segments {
        if written.contains(id) {
            continue;
        }
        let Some(path) = assets::asset_path(assets_dir, id) else {
            missing = true;
            continue;
        };
        let mut file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                missing = true;
                continue;
            }
            Err(e) => return Err(limit(format!("could not read recording audio {id}: {e}"))),
        };
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("bin");
        zip.start_file(format!("{RECORDINGS_DIR}{id}.{ext}"), stored)
            .map_err(zip_err)?;
        std::io::copy(&mut file, zip)
            .map_err(|e| limit(format!("could not read recording audio {id}: {e}")))?;
        written.insert(id.clone());
    }
    Ok(missing)
}

/// [`write_backup`] into memory.
pub fn export_backup(storage: &Storage, assets_dir: &Path) -> Result<(Vec<u8>, BackupReport)> {
    let (out, report) = write_backup(storage, assets_dir, Cursor::new(Vec::new()))?;
    Ok((out.into_inner(), report))
}

/// What a restore created.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// One import report per restored book, in backup order.
    pub books: Vec<ImportReport>,
    /// Each book that could not be imported (rolled back; the others still are).
    pub failed: Vec<FailedBook>,
    /// `recordings/` entries skipped as invalid (bad name, repeated id, not stored as-is, not
    /// audio or video, oversized or unreadable).
    pub rejected_audio: usize,
    /// Titles of restored books in which a recording lost (some of) its audio: stripped, or left
    /// with segments that point nowhere.
    pub lost_recordings: Vec<String>,
}

/// A book a restore could not import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedBook {
    /// The book's title, or its file name in the backup when even that cannot be read.
    pub name: String,
    pub error: String,
}

/// The title in a `.mate` archive's `unit.json`, if it can be read.
fn archive_title(bytes: &[u8]) -> Option<String> {
    let mut zip = ZipArchive::new(Cursor::new(bytes)).ok()?;
    let raw = read_entry(&mut zip, "unit.json", MAX_JSON_ENTRY_BYTES).ok()??;
    Some(serde_json::from_slice::<UnitFile>(&raw).ok()?.unit.title)
}

/// The old asset id of a `recordings/<assetId>.<ext>` entry; `None` for any other name (paths,
/// names that are no asset id).
fn recording_entry_id(name: &str) -> Option<&str> {
    let (stem, _ext) = name.strip_prefix(RECORDINGS_DIR)?.rsplit_once('.')?;
    assets::valid_id(stem).then_some(stem)
}

/// Restores a [`write_backup`] zip read from `backup` (seeked, never loaded whole): each
/// `recordings/` entry is streamed into `assets_dir` under a new id first, then every
/// `books/*.mate` is imported as a new book (as [`import_archive`] does) with its markers'
/// segments re-attached to that audio. A backup without `recordings/` (older ones) restores
/// exactly as importing each book would. An audio entry that is not stored as-is, not audio or
/// video, larger than [`assets::MAX_MEDIA_BYTES`] or a repeat of an earlier one is skipped and
/// counted in [`RestoreReport::rejected_audio`]; failing to write a valid one to the store aborts
/// the restore (nothing is restored). A book that cannot be imported is rolled back and listed in
/// [`RestoreReport::failed`]; one whose recordings lost audio is named in
/// [`RestoreReport::lost_recordings`]. Audio no restored book references is removed again.
///
/// An `Err` means nothing was changed: every error is raised before the first book is imported
/// (audio saved so far is removed again); after that, failures are per book and reported.
pub fn restore_backup<R: Read + Seek>(
    storage: &mut Storage,
    backup: R,
    assets_dir: &Path,
) -> Result<RestoreReport> {
    restore_backup_capped(storage, backup, assets_dir, assets::MAX_MEDIA_BYTES as u64)
}

/// [`restore_backup`] with the per-entry audio limit passed in (tests use a small one).
pub fn restore_backup_capped<R: Read + Seek>(
    storage: &mut Storage,
    backup: R,
    assets_dir: &Path,
    max_audio_bytes: u64,
) -> Result<RestoreReport> {
    restore_backup_with(storage, backup, assets_dir, max_audio_bytes, ImportLimits::default())
}

/// [`restore_backup`] with the per-book recall row cap passed in (tests use a small one).
pub fn restore_backup_recall_capped<R: Read + Seek>(
    storage: &mut Storage,
    backup: R,
    assets_dir: &Path,
    max_recall_rows: usize,
) -> Result<RestoreReport> {
    let limits = ImportLimits { max_recall_rows, ..ImportLimits::default() };
    restore_backup_with(storage, backup, assets_dir, assets::MAX_MEDIA_BYTES as u64, limits)
}

fn restore_backup_with<R: Read + Seek>(
    storage: &mut Storage,
    backup: R,
    assets_dir: &Path,
    max_audio_bytes: u64,
    limits: ImportLimits,
) -> Result<RestoreReport> {
    let mut zip =
        ZipArchive::new(backup).map_err(|_| limit("not a Mate backup (not a zip file)"))?;
    let manifest = read_entry(&mut zip, "backup.json", MAX_JSON_ENTRY_BYTES)?
        .ok_or_else(|| limit("not a Mate backup (missing backup.json)"))?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest)
        .map_err(|e| limit(format!("not a Mate backup (bad backup.json: {e})")))?;
    if manifest.get("format").and_then(|f| f.as_str()) != Some(BACKUP_FORMAT) {
        return Err(limit("not a Mate backup (unknown format)"));
    }
    let names: Vec<String> = zip.file_names().map(str::to_owned).collect();

    // Audio first, so each book's markers can be pointed at it.
    let mut report = RestoreReport::default();
    let mut audio: HashMap<String, String> = HashMap::new();
    let saved = |zip: &mut ZipArchive<R>, name: &str, audio: &HashMap<String, String>| {
        let old = recording_entry_id(name)?;
        if audio.contains_key(old) {
            return None;
        }
        let entry = zip.by_name(name).ok()?;
        // A backup stores audio as-is, so an entry can never unpack to more than it occupies.
        if !entry.is_file()
            || entry.compression() != CompressionMethod::Stored
            || entry.size() > max_audio_bytes
        {
            return None;
        }
        Some((
            old.to_owned(),
            assets::save_sniffed_from_reader(
                assets_dir,
                entry,
                max_audio_bytes,
                assets::AssetKind::is_media,
            ),
        ))
    };
    // (The bare `recordings/` folder entry some zip tools add is neither audio nor a rejection.)
    for name in names.iter().filter(|n| n.starts_with(RECORDINGS_DIR) && *n != RECORDINGS_DIR) {
        match saved(&mut zip, name, &audio) {
            Some((old, Ok(info))) => {
                audio.insert(old, info.id);
            }
            Some((_, Err(e @ StorageError::Io(_)))) => {
                for id in audio.values() {
                    assets::delete_asset(assets_dir, id);
                }
                return Err(e);
            }
            Some((_, Err(_))) | None => report.rejected_audio += 1,
        }
    }

    let mut books: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("books/") && n.ends_with(".mate"))
        .collect();
    books.sort();
    for name in books {
        let file_name = name.strip_prefix("books/").unwrap_or(name);
        let bytes = match read_entry(&mut zip, name, MAX_ARCHIVE_BYTES as u64) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(e) => {
                report.failed.push(FailedBook { name: file_name.to_owned(), error: e.to_string() });
                continue;
            }
        };
        match import_archive_from(storage, &bytes, assets_dir, limits, Some(&audio), true) {
            Ok(book) => {
                if book.lost_audio {
                    report.lost_recordings.push(book.title);
                }
                report.books.push(book.report);
            }
            Err(e) => report.failed.push(FailedBook {
                name: archive_title(&bytes).unwrap_or_else(|| file_name.to_owned()),
                error: e.to_string(),
            }),
        }
    }
    // Best effort: books are already restored, so a failed lookup only leaves unused audio for
    // the asset collector instead of failing the restore.
    if let Ok(referenced) = storage.referenced_asset_ids() {
        for id in audio.values().filter(|id| !referenced.contains(*id)) {
            assets::delete_asset(assets_dir, id);
        }
    }
    Ok(report)
}

/// Deletes the local database (with its `-wal`/`-shm` sidecars), the asset store, the recording
/// work area, `incoming/`, `exports/` and `settings.json` under `data_dir`. Missing files are fine.
/// The caller must have closed or replaced any open connection to the database first.
pub fn wipe_local_data(data_dir: &Path) -> std::io::Result<()> {
    use std::fs;
    use std::io::ErrorKind::NotFound;
    for name in ["mate.db", "mate.db-wal", "mate.db-shm", "settings.json"] {
        match fs::remove_file(data_dir.join(name)) {
            Err(e) if e.kind() != NotFound => return Err(e),
            _ => {}
        }
    }
    // `incoming/` holds files opened from other apps and `exports/` files waiting to be shared
    // (both mobile; absent on desktop). `recordings/` would otherwise bring an old lecture back at
    // the next launch.
    for dir in ["assets", "recordings", "incoming", "exports"] {
        match fs::remove_dir_all(data_dir.join(dir)) {
            Err(e) if e.kind() != NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// Reads one entry of at most `max` bytes ([`MAX_JSON_ENTRY_BYTES`] for JSON, [`MAX_ENTRY_BYTES`]
/// for assets); `None` if the entry does not exist.
fn read_entry<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
    max: u64,
) -> Result<Option<Vec<u8>>> {
    let file = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(zip_err(e)),
    };
    if file.size() > max {
        return Err(limit(format!("archive entry {name} is too large")));
    }
    let mut data = Vec::new();
    // `take` guards against entries whose declared size understates the real one.
    file.take(max + 1).read_to_end(&mut data).map_err(io_err)?;
    if data.len() as u64 > max {
        return Err(limit(format!("archive entry {name} is too large")));
    }
    Ok(Some(data))
}

/// Imports an archive as a new, unshelved unit placed after the existing ones. Every id is
/// re-minted; timestamps are reset to now, except an element's `created_at` (replay links notes to
/// audio by it), which is kept unless it is not an RFC 3339 time. Elements over the storage limits are skipped and
/// counted. Archived assets are stored in `assets_dir` under new ids (content-sniffed, size
/// limited) and the elements are rewritten to them; a referenced asset that is absent or invalid
/// is skipped and its element kept. On failure, anything already written for the new unit
/// (assets included) is removed.
pub fn import_archive(
    storage: &mut Storage,
    bytes: &[u8],
    assets_dir: &Path,
) -> Result<ImportReport> {
    import_archive_with_limits(storage, bytes, assets_dir, ImportLimits::default())
}

/// [`import_archive`] with explicit asset limits: the import fails (and is rolled back) once the
/// asset entries read decompress to more than `limits.total_asset_bytes`, or when the archive
/// carries more than `limits.max_assets` asset entries.
pub fn import_archive_with_limits(
    storage: &mut Storage,
    bytes: &[u8],
    assets_dir: &Path,
    limits: ImportLimits,
) -> Result<ImportReport> {
    import_archive_from(storage, bytes, assets_dir, limits, None, false).map(|book| book.report)
}

/// What [`import_archive_from`] imported.
struct ImportedBook {
    report: ImportReport,
    title: String,
    /// A recording kept a segment that points nowhere, or was stripped for having no audio.
    lost_audio: bool,
}

/// [`import_archive_with_limits`], resolving recording segments through `external` (old -> new
/// asset id of audio already in the store, from a backup's `recordings/`) before the archive's
/// own `assets/`. With `external`, a marker none of whose segments resolves loses `recording`
/// and `image_url`, as in a [`Recordings::Exclude`] archive. Only `private` (a restore) reads the
/// book's `recall.json`; a plain import ignores it.
fn import_archive_from(
    storage: &mut Storage,
    bytes: &[u8],
    assets_dir: &Path,
    limits: ImportLimits,
    external: Option<&HashMap<String, String>>,
    private: bool,
) -> Result<ImportedBook> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(limit("archive is larger than 512 MiB"));
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| limit("not a Mate archive (not a zip file)"))?;
    let manifest_raw = read_entry(&mut zip, "manifest.json", MAX_JSON_ENTRY_BYTES)?
        .ok_or_else(|| limit("not a Mate archive (missing manifest.json)"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_raw)
        .map_err(|e| limit(format!("not a Mate archive (bad manifest.json: {e})")))?;
    if manifest.format != ARCHIVE_FORMAT {
        return Err(limit("not a Mate archive (unknown format)"));
    }
    if manifest.schema_version > ARCHIVE_SCHEMA_VERSION {
        return Err(limit("written by a newer version of Mate"));
    }
    let unit_raw = read_entry(&mut zip, "unit.json", MAX_JSON_ENTRY_BYTES)?
        .ok_or_else(|| limit("not a Mate archive (missing unit.json)"))?;
    let unit_file: UnitFile =
        serde_json::from_slice(&unit_raw).map_err(|e| limit(format!("bad unit.json: {e}")))?;

    let order_index = storage.list_tree()?.units.len() as i64;
    let new_unit_id = new_id();
    let mut imported = AssetImport::new(&zip, assets_dir, limits, external)?;
    let title = unit_file.unit.title.clone();
    let result = write_unit(
        storage,
        &mut zip,
        &mut imported,
        unit_file,
        &new_unit_id,
        order_index,
    )
    .and_then(|(report, ids)| {
        if private {
            import_recall(storage, &mut zip, &ids, limits.max_recall_rows)?;
        }
        Ok(report)
    });
    if result.is_err() {
        let _ = storage.purge(EntityKind::Unit, &new_unit_id);
        for id in imported.minted.values().flatten() {
            assets::delete_asset(assets_dir, id);
        }
    }
    result.map(|report| ImportedBook { report, title, lost_audio: imported.lost_audio })
}

/// Copies archived assets into the asset store on first reference, remembering old -> new ids.
struct AssetImport<'a> {
    dir: &'a Path,
    /// Old asset id -> new id of audio already stored beside the archive (a backup's recordings).
    external: Option<&'a HashMap<String, String>>,
    /// Old asset id -> its `assets/...` entry name.
    entries: HashMap<String, String>,
    /// Old asset id -> new id (`None`: absent or unusable, the old id is kept).
    minted: HashMap<String, Option<String>>,
    limits: ImportLimits,
    /// Decompressed bytes of the asset entries read so far.
    total: u64,
    /// A recording kept a segment that resolved nowhere, or was stripped for having none.
    lost_audio: bool,
}

/// What a reference may point at: a media element's `image_url` an audio or video file, any
/// other element's `image_url` an image, `pdfSourceKey` a PDF.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Want {
    Image,
    Media,
    Pdf,
}

impl Want {
    fn accepts(self, kind: assets::AssetKind) -> bool {
        match self {
            Want::Image => !kind.is_media() && kind != assets::AssetKind::Pdf,
            Want::Media => kind.is_media(),
            Want::Pdf => kind == assets::AssetKind::Pdf,
        }
    }
}

impl<'a> AssetImport<'a> {
    fn new(
        zip: &ZipArchive<Cursor<&[u8]>>,
        dir: &'a Path,
        limits: ImportLimits,
        external: Option<&'a HashMap<String, String>>,
    ) -> Result<Self> {
        let entries: HashMap<String, String> = zip
            .file_names()
            .filter_map(|name| {
                let file = name.strip_prefix("assets/")?;
                let (stem, _ext) = file.rsplit_once('.')?;
                (!stem.is_empty() && !stem.contains('/'))
                    .then(|| (stem.to_owned(), name.to_owned()))
            })
            .collect();
        if entries.len() > limits.max_assets {
            return Err(limit(format!(
                "archive carries more than {} assets",
                limits.max_assets
            )));
        }
        Ok(AssetImport {
            dir,
            external,
            entries,
            minted: HashMap::new(),
            limits,
            total: 0,
            lost_audio: false,
        })
    }

    /// New id for old asset `id`, importing it on first use; `None` if it cannot be imported.
    /// An asset whose content is not of the `want`ed kind counts as missing. Media is looked up
    /// in `external` first (it holds only audio and video).
    fn map(
        &mut self,
        zip: &mut ZipArchive<Cursor<&[u8]>>,
        id: &str,
        want: Want,
    ) -> Result<Option<String>> {
        if want == Want::Media
            && let Some(new) = self.external.and_then(|m| m.get(id))
        {
            return Ok(Some(new.clone()));
        }
        if let Some(m) = self.minted.get(id) {
            return Ok(m.clone());
        }
        let data = match self.entries.get(id) {
            Some(name) => read_entry(zip, name, MAX_ENTRY_BYTES)?,
            None => None,
        };
        if let Some(d) = &data {
            self.total += d.len() as u64;
            if self.total > self.limits.total_asset_bytes {
                return Err(limit("archive assets exceed the import size limit"));
            }
        }
        let new = data
            .filter(|d| assets::sniff(d).is_some_and(|k| want.accepts(k)))
            .and_then(|d| assets::save_sniffed(self.dir, &d).ok())
            .map(|info| info.id);
        self.minted.insert(id.to_owned(), new.clone());
        Ok(new)
    }

    /// Rewrites `e`'s asset references to the imported copies, and a recording marker's
    /// `recording.unitId` to `new_unit_id`.
    fn rewrite(
        &mut self,
        zip: &mut ZipArchive<Cursor<&[u8]>>,
        e: &mut Element,
        new_unit_id: &str,
    ) -> Result<()> {
        let want = if e.r#type == ElementType::Media { Want::Media } else { Want::Image };
        if let Some(old) = e.image_url.clone()
            && let Some(new) = self.map(zip, &old, want)?
        {
            e.image_url = Some(new);
        }
        let old_pdf = e
            .content
            .as_ref()
            .and_then(|c| c.get("pdfSourceKey"))
            .and_then(|k| k.as_str())
            .map(str::to_owned);
        if let Some(old) = old_pdf
            && let Some(new) = self.map(zip, &old, Want::Pdf)?
            && let Some(serde_json::Value::Object(c)) = e.content.as_mut()
        {
            c.insert("pdfSourceKey".into(), serde_json::Value::String(new));
        }
        self.rewrite_recording(zip, e, new_unit_id)
    }

    /// Points a recording's segments at the imported copies (an audio or video file, like a media
    /// element's `image_url`) and its `unitId` at the imported unit. A segment that resolves
    /// nowhere keeps its old id (dangling); with `external` audio, a recording that has segments
    /// but none that resolves is dropped with `image_url`, as [`Recordings::Exclude`] would.
    fn rewrite_recording(
        &mut self,
        zip: &mut ZipArchive<Cursor<&[u8]>>,
        e: &mut Element,
        new_unit_id: &str,
    ) -> Result<()> {
        let Some(serde_json::Value::Object(rec)) = e
            .content
            .as_mut()
            .and_then(|c| c.get_mut("recording"))
        else {
            return Ok(());
        };
        rec.insert("unitId".into(), serde_json::Value::String(new_unit_id.to_owned()));
        let (mut total, mut resolved) = (0, 0);
        if let Some(serde_json::Value::Array(segments)) = rec.get_mut("segments") {
            for seg in segments {
                total += 1;
                let old = seg.get("assetId").and_then(|a| a.as_str()).map(str::to_owned);
                if let Some(old) = old
                    && let Some(new) = self.map(zip, &old, Want::Media)?
                    && let Some(seg) = seg.as_object_mut()
                {
                    seg.insert("assetId".into(), serde_json::Value::String(new));
                    resolved += 1;
                }
            }
        }
        self.lost_audio |= resolved < total;
        if self.external.is_some() && total > 0 && resolved == 0 {
            apply_recordings(e, Recordings::Exclude);
        }
        Ok(())
    }
}

/// Points connector `e`'s bound ends (`content.source.id` / `content.target.id`) at the imported
/// copies; an end bound to an element that was not imported becomes free.
fn rebind_connector(e: &mut Element, ids: &HashMap<String, String>) {
    let Some(serde_json::Value::Object(c)) = e.content.as_mut() else {
        return;
    };
    for key in ["source", "target"] {
        let old = c
            .get(key)
            .and_then(|end| end.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_owned);
        let Some(old) = old else { continue };
        match ids.get(&old) {
            Some(new) => {
                if let Some(serde_json::Value::Object(end)) = c.get_mut(key) {
                    end.insert("id".into(), serde_json::Value::String(new.clone()));
                }
            }
            None => {
                c.remove(key);
            }
        }
    }
}

/// `created_at` as an element's creation time (normalised to UTC milliseconds, so the stored
/// strings sort chronologically), or `now` when it is not an RFC 3339 time.
fn keep_created_at(created_at: &str, now: &str) -> String {
    OffsetDateTime::parse(created_at, &Rfc3339)
        .map(|at| format_iso(at.to_offset(time::UtcOffset::UTC)))
        .unwrap_or_else(|_| now.to_owned())
}

/// Old -> new ids of what [`write_unit`] imported.
struct ImportedIds {
    pages: HashMap<String, String>,
    elements: HashMap<String, String>,
}

/// Restores a backup book's `recall.json` onto the imported pages and covers. Each row gets a new
/// id and keeps its `runId` and time; its page goes through `ids.pages` (a row of a page that was
/// not imported, a trashed one, is dropped) and its `elementId` through `ids.elements` (kept as it
/// is when the element was not in the archive: a deleted cover, whose answers still count for the
/// page). A missing or unreadable file restores no rows rather than failing the book; rows that do
/// not parse, rows with an empty `elementId` or `runId`, and rows past `max_rows`, are skipped.
fn import_recall(
    storage: &mut Storage,
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    ids: &ImportedIds,
    max_rows: usize,
) -> Result<()> {
    let Ok(Some(raw)) = read_entry(zip, RECALL_FILE, MAX_JSON_ENTRY_BYTES) else {
        return Ok(());
    };
    let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&raw) else {
        return Ok(());
    };
    let now = now_iso();
    let restored: Vec<LearningEvent> = rows
        .into_iter()
        .take(max_rows)
        .filter_map(|row| {
            let row: LearningEvent = serde_json::from_value(row).ok()?;
            if row.kind != RECALL_KIND {
                return None;
            }
            let page_id = ids.pages.get(&row.page_id)?;
            let p = &row.payload;
            let element = p.get("elementId")?.as_str()?;
            let knew = p.get("knew")?.as_bool()?;
            let run = p.get("runId")?.as_str()?;
            // The live path never stores a row without a cover or a run: neither does a restore.
            if element.is_empty() || run.is_empty() {
                return None;
            }
            let element = ids.elements.get(element).map_or(element, String::as_str);
            Some(LearningEvent {
                id: new_id(),
                page_id: page_id.clone(),
                stroke_group_id: None,
                kind: RECALL_KIND.into(),
                payload: serde_json::json!({ "elementId": element, "knew": knew, "runId": run }),
                created_at: keep_created_at(&row.created_at, &now),
            })
        })
        .collect();
    storage.insert_recall_rows(&restored)
}

fn write_unit(
    storage: &mut Storage,
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    imported: &mut AssetImport,
    file: UnitFile,
    new_unit_id: &str,
    order_index: i64,
) -> Result<(ImportReport, ImportedIds)> {
    let now = now_iso();
    storage.upsert_unit(&Unit {
        id: new_unit_id.to_string(),
        bookshelf_id: None,
        order_index,
        created_at: now.clone(),
        updated_at: now.clone(),
        deleted_at: None,
        version: 0,
        ..file.unit
    })?;

    let mut section_ids: HashMap<String, String> = HashMap::new();
    for s in file.sections {
        let id = new_id();
        section_ids.insert(s.id.clone(), id.clone());
        storage.upsert_section(&Section {
            id,
            unit_id: new_unit_id.to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            deleted_at: None,
            version: 0,
            ..s
        })?;
    }

    // Pages whose section is in the archive; ids minted up front so parents can be remapped.
    let pages: Vec<Page> = file
        .pages
        .into_iter()
        .filter(|p| section_ids.contains_key(&p.section_id))
        .collect();
    let page_ids: HashMap<String, String> =
        pages.iter().map(|p| (p.id.clone(), new_id())).collect();

    // Insert parents before children; a page whose parent is not in the archive becomes
    // top-level, and a parent cycle is broken by detaching one of its pages.
    let mut pending = pages;
    let mut inserted: HashSet<String> = HashSet::new();
    let mut order: Vec<String> = Vec::new();
    while !pending.is_empty() {
        let (mut ready, mut waiting): (Vec<Page>, Vec<Page>) = pending.into_iter().partition(|p| {
            p.parent_id
                .as_ref()
                .is_none_or(|pid| !page_ids.contains_key(pid) || inserted.contains(pid))
        });
        if ready.is_empty() {
            let mut first = waiting.remove(0);
            first.parent_id = None;
            ready.push(first);
        }
        for p in ready {
            let parent_id = p
                .parent_id
                .as_ref()
                .filter(|pid| inserted.contains(*pid))
                .map(|pid| page_ids[pid].clone());
            inserted.insert(p.id.clone());
            order.push(p.id.clone());
            storage.upsert_page(&Page {
                id: page_ids[&p.id].clone(),
                section_id: section_ids[&p.section_id].clone(),
                depth: if parent_id.is_some() { p.depth } else { 0 },
                parent_id,
                thumbnail_version: 0,
                created_at: now.clone(),
                updated_at: now.clone(),
                deleted_at: None,
                version: 0,
                ..p
            })?;
        }
        pending = waiting;
    }

    let mut elements_count = 0;
    let mut skipped = 0;
    let mut group_ids: HashMap<String, String> = HashMap::new();
    // Every page's element ids, for the recall pass after the pages are written.
    let mut all_element_ids: HashMap<String, String> = HashMap::new();
    for old_page in &order {
        let Some(raw) = read_entry(zip, &format!("pages/{old_page}.json"), MAX_JSON_ENTRY_BYTES)? else {
            continue;
        };
        let elements: Vec<Element> = serde_json::from_slice(&raw)
            .map_err(|e| limit(format!("bad pages/{old_page}.json: {e}")))?;
        let new_page = &page_ids[old_page];
        // Fresh ids first, so connector ends can follow the elements they are bound to.
        let mut kept = Vec::new();
        // Recording markers are exempt from the page limit, as in storage, but have their own cap
        // (a marker past it is skipped before its audio is imported).
        let mut counted = 0i64;
        let mut markers = 0usize;
        for e in elements {
            if e.deleted_at.is_some() {
                continue;
            }
            let marker = is_recording_marker(&e);
            let full = if marker { markers >= MAX_MARKERS_PER_PAGE } else { counted >= MAX_ELEMENTS_PER_PAGE };
            if e.points.len() > MAX_POINTS_PER_STROKE || full {
                skipped += 1;
                continue;
            }
            counted += i64::from(!marker);
            markers += usize::from(marker);
            kept.push((new_id(), e));
        }
        let element_ids: HashMap<String, String> = kept
            .iter()
            .map(|(new, e)| (e.id.clone(), new.clone()))
            .collect();
        let mut batch = Vec::new();
        for (id, mut e) in kept {
            imported.rewrite(zip, &mut e, new_unit_id)?;
            if e.r#type == ElementType::Connector {
                rebind_connector(&mut e, &element_ids);
            }
            let ui_group_id = e
                .ui_group_id
                .as_ref()
                .map(|g| group_ids.entry(g.clone()).or_insert_with(new_id).clone());
            // Replay links notes to audio by creation time: elements keep theirs.
            let created_at = keep_created_at(&e.created_at, &now);
            batch.push(Element {
                id,
                page_id: new_page.clone(),
                ui_group_id,
                created_at,
                updated_at: now.clone(),
                deleted_at: None,
                version: 0,
                last_write_id: None,
                ..e
            });
        }
        elements_count += batch.len();
        storage.upsert_elements(&batch)?;
        all_element_ids.extend(element_ids);
    }

    let report = ImportReport {
        unit_id: new_unit_id.to_string(),
        pages: order.len(),
        elements: elements_count,
        skipped,
    };
    Ok((report, ImportedIds { pages: page_ids, elements: all_element_ids }))
}
