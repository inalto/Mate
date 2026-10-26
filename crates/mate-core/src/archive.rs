//! `.mate` archives: a zip of one unit (book) with its sections, pages and elements.
//!
//! Layout: `manifest.json` (format marker + schema version), `unit.json`
//! (`{unit, sections, pages}`), `pages/<pageId>.json` (that page's live elements) and
//! `assets/<assetId>.<ext>` (every stored image/PDF those elements reference through `image_url`
//! or `content.pdfSourceKey`). Importing re-mints every id, asset ids included, so an archive can
//! be imported any number of times; a referenced asset missing from the archive leaves the
//! element's id dangling (the element renders its placeholder).

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::assets;
use crate::model::{Element, Page, Section, Unit, new_id, now_iso};
use crate::storage::elements::{MAX_ELEMENTS_PER_PAGE, MAX_POINTS_PER_STROKE};
use crate::storage::{EntityKind, Result, Storage, StorageError};

pub const ARCHIVE_FORMAT: &str = "mate-archive";
pub const ARCHIVE_SCHEMA_VERSION: u32 = 1;
/// Largest archive accepted for import.
pub const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
/// Largest single (uncompressed) entry accepted for import.
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Most `assets/` entries an archive may carry.
pub const MAX_ARCHIVE_ASSETS: usize = 2000;

/// Bounds on what an import may write to the asset store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportLimits {
    /// Total decompressed bytes of all asset entries read (default [`MAX_ARCHIVE_BYTES`]).
    pub total_asset_bytes: u64,
    /// Most `assets/` entries (default [`MAX_ARCHIVE_ASSETS`]).
    pub max_assets: usize,
}

impl Default for ImportLimits {
    fn default() -> Self {
        ImportLimits {
            total_asset_bytes: MAX_ARCHIVE_BYTES as u64,
            max_assets: MAX_ARCHIVE_ASSETS,
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

/// Asset ids an element references: `image_url` and `content.pdfSourceKey`.
fn asset_refs(e: &Element) -> impl Iterator<Item = &str> {
    let pdf = e
        .content
        .as_ref()
        .and_then(|c| c.get("pdfSourceKey"))
        .and_then(|k| k.as_str());
    e.image_url.as_deref().into_iter().chain(pdf)
}

/// Serialises one live unit, its live sections and pages, their live elements and the assets
/// (from `assets_dir`) those elements reference to a zip. Referenced assets that are not stored
/// are left out; the whole archive is capped at [`MAX_ARCHIVE_BYTES`].
pub fn export_unit(storage: &Storage, unit_id: &str, assets_dir: &Path) -> Result<Vec<u8>> {
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
    for p in &pages {
        let elements = storage.load_elements(&p.id)?;
        for id in elements.iter().flat_map(asset_refs) {
            if seen.insert(id.to_owned()) {
                asset_ids.push(id.to_owned());
            }
        }
        put(
            &mut zip,
            &format!("pages/{}.json", p.id),
            serde_json::to_vec(&elements)?,
        )?;
    }
    // Images and PDFs are already compressed: store them as-is.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut total: u64 = 0;
    for id in &asset_ids {
        let Some(path) = assets::asset_path(assets_dir, id) else {
            continue;
        };
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        total += data.len() as u64;
        if total > MAX_ARCHIVE_BYTES as u64 {
            return Err(limit("archive would be larger than 512 MiB"));
        }
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("bin");
        zip.start_file(format!("assets/{id}.{ext}"), stored)
            .map_err(zip_err)?;
        zip.write_all(&data).map_err(io_err)?;
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
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(limit("archive would be larger than 512 MiB"));
    }
    Ok(bytes)
}

/// One book of a backup: its entry name inside the zip and its `.mate` bytes.
pub struct BackupEntry {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Exports every live book as a `.mate` archive. This is the part that needs the database, so
/// callers can hold the storage lock for it and build the zip ([`zip_backup`]) afterwards.
pub fn backup_entries(storage: &Storage, assets_dir: &Path) -> Result<Vec<BackupEntry>> {
    let units = storage.list_tree()?.units;
    let mut out = Vec::with_capacity(units.len());
    for (i, unit) in units.iter().enumerate() {
        let slug: String = unit
            .title
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
        out.push(BackupEntry {
            name: format!("books/{:02}-{slug}.mate", i + 1),
            bytes: export_unit(storage, &unit.id, assets_dir)?,
        });
    }
    Ok(out)
}

/// Zips backup entries (stored without further compression) plus a `backup.json` manifest.
pub fn zip_backup(entries: &[BackupEntry]) -> Result<Vec<u8>> {
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for e in entries {
        zip.start_file(&e.name, stored).map_err(zip_err)?;
        zip.write_all(&e.bytes).map_err(io_err)?;
    }
    let manifest = serde_json::json!({
        "format": "mate-backup",
        "exportedAt": now_iso(),
        "books": entries.len(),
    });
    zip.start_file("backup.json", stored).map_err(zip_err)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)
        .map_err(io_err)?;
    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

/// Zips every live book as its own `.mate` archive (`books/NN-<title>.mate`) so a whole library
/// can be restored one book at a time. Used by "Download backup" and the pre-reset recovery file.
pub fn export_backup(storage: &Storage, assets_dir: &Path) -> Result<Vec<u8>> {
    zip_backup(&backup_entries(storage, assets_dir)?)
}

/// Deletes the local database (with its `-wal`/`-shm` sidecars), the asset store,
/// `incoming/`, `exports/` and `settings.json` under `data_dir`. Missing files are fine. The
/// caller must have closed or replaced any open connection to the database first.
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
    // (both mobile; absent on desktop).
    for dir in ["assets", "incoming", "exports"] {
        match fs::remove_dir_all(data_dir.join(dir)) {
            Err(e) if e.kind() != NotFound => return Err(e),
            _ => {}
        }
    }
    Ok(())
}

/// Reads one entry, enforcing [`MAX_ENTRY_BYTES`]; `None` if the entry does not exist.
fn read_entry(zip: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<Option<Vec<u8>>> {
    let file = match zip.by_name(name) {
        Ok(f) => f,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(zip_err(e)),
    };
    if file.size() > MAX_ENTRY_BYTES {
        return Err(limit(format!("archive entry {name} is too large")));
    }
    let mut data = Vec::new();
    // `take` guards against entries whose declared size understates the real one.
    file.take(MAX_ENTRY_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(io_err)?;
    if data.len() as u64 > MAX_ENTRY_BYTES {
        return Err(limit(format!("archive entry {name} is too large")));
    }
    Ok(Some(data))
}

/// Imports an archive as a new, unshelved unit placed after the existing ones. Every id is
/// re-minted; timestamps are reset to now. Elements over the storage limits are skipped and
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
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(limit("archive is larger than 512 MiB"));
    }
    let mut zip = ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| limit("not a Mate archive (not a zip file)"))?;
    let manifest_raw = read_entry(&mut zip, "manifest.json")?
        .ok_or_else(|| limit("not a Mate archive (missing manifest.json)"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_raw)
        .map_err(|e| limit(format!("not a Mate archive (bad manifest.json: {e})")))?;
    if manifest.format != ARCHIVE_FORMAT {
        return Err(limit("not a Mate archive (unknown format)"));
    }
    if manifest.schema_version > ARCHIVE_SCHEMA_VERSION {
        return Err(limit("written by a newer version of Mate"));
    }
    let unit_raw = read_entry(&mut zip, "unit.json")?
        .ok_or_else(|| limit("not a Mate archive (missing unit.json)"))?;
    let unit_file: UnitFile =
        serde_json::from_slice(&unit_raw).map_err(|e| limit(format!("bad unit.json: {e}")))?;

    let order_index = storage.list_tree()?.units.len() as i64;
    let new_unit_id = new_id();
    let mut imported = AssetImport::new(&zip, assets_dir, limits)?;
    let result = write_unit(
        storage,
        &mut zip,
        &mut imported,
        unit_file,
        &new_unit_id,
        order_index,
    );
    if result.is_err() {
        let _ = storage.purge(EntityKind::Unit, &new_unit_id);
        for id in imported.minted.values().flatten() {
            assets::delete_asset(assets_dir, id);
        }
    }
    result
}

/// Copies archived assets into the asset store on first reference, remembering old -> new ids.
struct AssetImport<'a> {
    dir: &'a Path,
    /// Old asset id -> its `assets/...` entry name.
    entries: HashMap<String, String>,
    /// Old asset id -> new id (`None`: absent or unusable, the old id is kept).
    minted: HashMap<String, Option<String>>,
    limits: ImportLimits,
    /// Decompressed bytes of the asset entries read so far.
    total: u64,
}

/// What a reference may point at: `image_url` an image, `pdfSourceKey` a PDF.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Want {
    Image,
    Pdf,
}

impl Want {
    fn accepts(self, kind: assets::AssetKind) -> bool {
        (kind == assets::AssetKind::Pdf) == (self == Want::Pdf)
    }
}

impl<'a> AssetImport<'a> {
    fn new(zip: &ZipArchive<Cursor<&[u8]>>, dir: &'a Path, limits: ImportLimits) -> Result<Self> {
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
            entries,
            minted: HashMap::new(),
            limits,
            total: 0,
        })
    }

    /// New id for old asset `id`, importing it on first use; `None` if it cannot be imported.
    /// An asset whose content is not of the `want`ed kind counts as missing.
    fn map(
        &mut self,
        zip: &mut ZipArchive<Cursor<&[u8]>>,
        id: &str,
        want: Want,
    ) -> Result<Option<String>> {
        if let Some(m) = self.minted.get(id) {
            return Ok(m.clone());
        }
        let data = match self.entries.get(id) {
            Some(name) => read_entry(zip, name)?,
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

    /// Rewrites `e`'s asset references to the imported copies.
    fn rewrite(&mut self, zip: &mut ZipArchive<Cursor<&[u8]>>, e: &mut Element) -> Result<()> {
        if let Some(old) = e.image_url.clone()
            && let Some(new) = self.map(zip, &old, Want::Image)?
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
        Ok(())
    }
}

fn write_unit(
    storage: &mut Storage,
    zip: &mut ZipArchive<Cursor<&[u8]>>,
    imported: &mut AssetImport,
    file: UnitFile,
    new_unit_id: &str,
    order_index: i64,
) -> Result<ImportReport> {
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
    for old_page in &order {
        let Some(raw) = read_entry(zip, &format!("pages/{old_page}.json"))? else {
            continue;
        };
        let elements: Vec<Element> = serde_json::from_slice(&raw)
            .map_err(|e| limit(format!("bad pages/{old_page}.json: {e}")))?;
        let new_page = &page_ids[old_page];
        let mut batch = Vec::new();
        for mut e in elements {
            if e.deleted_at.is_some() {
                continue;
            }
            if e.points.len() > MAX_POINTS_PER_STROKE || batch.len() as i64 >= MAX_ELEMENTS_PER_PAGE
            {
                skipped += 1;
                continue;
            }
            imported.rewrite(zip, &mut e)?;
            let ui_group_id = e
                .ui_group_id
                .as_ref()
                .map(|g| group_ids.entry(g.clone()).or_insert_with(new_id).clone());
            batch.push(Element {
                id: new_id(),
                page_id: new_page.clone(),
                ui_group_id,
                created_at: now.clone(),
                updated_at: now.clone(),
                deleted_at: None,
                version: 0,
                last_write_id: None,
                ..e
            });
        }
        elements_count += batch.len();
        storage.upsert_elements(&batch)?;
    }

    Ok(ImportReport {
        unit_id: new_unit_id.to_string(),
        pages: order.len(),
        elements: elements_count,
        skipped,
    })
}
