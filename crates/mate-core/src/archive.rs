//! `.mate` archives: a zip of one unit (book) with its sections, pages and elements.
//!
//! Layout: `manifest.json` (format marker + schema version), `unit.json`
//! (`{unit, sections, pages}`) and `pages/<pageId>.json` (that page's live elements).
//! Importing re-mints every id so an archive can be imported any number of times.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::model::{Element, Page, Section, Unit, new_id, now_iso};
use crate::storage::elements::{MAX_ELEMENTS_PER_PAGE, MAX_POINTS_PER_STROKE};
use crate::storage::{EntityKind, Result, Storage, StorageError};

pub const ARCHIVE_FORMAT: &str = "mate-archive";
pub const ARCHIVE_SCHEMA_VERSION: u32 = 1;
/// Largest archive accepted for import.
pub const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
/// Largest single (uncompressed) entry accepted for import.
pub const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

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

/// Serialises one live unit, its live sections and pages, and their live elements to a zip.
pub fn export_unit(storage: &Storage, unit_id: &str) -> Result<Vec<u8>> {
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
    for p in &pages {
        let elements = storage.load_elements(&p.id)?;
        put(
            &mut zip,
            &format!("pages/{}.json", p.id),
            serde_json::to_vec(&elements)?,
        )?;
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
    Ok(zip.finish().map_err(zip_err)?.into_inner())
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
/// counted. On failure, anything already written for the new unit is removed.
pub fn import_archive(storage: &mut Storage, bytes: &[u8]) -> Result<ImportReport> {
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
    let result = write_unit(storage, &mut zip, unit_file, &new_unit_id, order_index);
    if result.is_err() {
        let _ = storage.purge(EntityKind::Unit, &new_unit_id);
    }
    result
}

fn write_unit(
    storage: &mut Storage,
    zip: &mut ZipArchive<Cursor<&[u8]>>,
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
        for e in elements {
            if e.deleted_at.is_some() {
                continue;
            }
            if e.points.len() > MAX_POINTS_PER_STROKE || batch.len() as i64 >= MAX_ELEMENTS_PER_PAGE
            {
                skipped += 1;
                continue;
            }
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
