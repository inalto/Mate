//! Recording work area: a lecture is captured in segments that the web view streams to disk as they
//! grow, so a crash loses at most the last chunk. Layout: `<root>/<rec_id>/manifest.json` plus one
//! `<index>.part` per segment. A finished part is moved into the asset store; the folder goes away
//! once the marker element is saved. Folders found at startup are unfinished recordings to recover.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use crate::assets::{self, AssetInfo};
use crate::storage::{Result, StorageError};

/// Largest chunk accepted by one [`RecordingDir::append`].
pub const MAX_APPEND_BYTES: usize = 4 * 1024 * 1024;

const MANIFEST: &str = "manifest.json";

fn io(e: std::io::Error) -> StorageError {
    StorageError::Limit(format!("recording io error: {e}"))
}

/// A recording folder left behind by a crash or an unclean exit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unfinished {
    pub rec_id: String,
    pub manifest: serde_json::Value,
    /// Indexes of the non-empty parts, ascending.
    pub parts: Vec<u32>,
}

/// Work area `<data>/recordings/`.
pub struct RecordingDir {
    root: PathBuf,
}

impl RecordingDir {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The recording's folder; `rec_id` reaches the file system, so only a canonical UUID is accepted.
    fn dir(&self, rec_id: &str) -> Result<PathBuf> {
        if !assets::valid_id(rec_id) {
            return Err(StorageError::Limit("invalid recording id".into()));
        }
        Ok(self.root.join(rec_id))
    }

    /// The folder of a recording that was begun.
    fn existing(&self, rec_id: &str) -> Result<PathBuf> {
        let dir = self.dir(rec_id)?;
        if dir.is_dir() {
            Ok(dir)
        } else {
            Err(StorageError::NotFound(format!("recording {rec_id}")))
        }
    }

    /// Creates the recording's folder and writes the first manifest. `rec_id` must be a UUID.
    pub fn begin(&self, rec_id: &str, manifest: &serde_json::Value) -> Result<()> {
        let dir = self.dir(rec_id)?;
        fs::create_dir_all(&dir).map_err(io)?;
        write_manifest(&dir, manifest)
    }

    /// Replaces the manifest atomically (tmp + rename, sync_all before rename).
    pub fn save_manifest(&self, rec_id: &str, manifest: &serde_json::Value) -> Result<()> {
        write_manifest(&self.existing(rec_id)?, manifest)
    }

    /// Appends to `<index>.part`, creating it; flushes. Errors on a missing recording.
    pub fn append(&self, rec_id: &str, index: u32, bytes: &[u8]) -> Result<()> {
        let dir = self.existing(rec_id)?;
        if bytes.len() > MAX_APPEND_BYTES {
            return Err(StorageError::Limit(format!(
                "chunk is {} bytes (max {MAX_APPEND_BYTES})",
                bytes.len()
            )));
        }
        let mut f = OpenOptions::new().create(true).append(true).open(part_path(&dir, index)).map_err(io)?;
        f.write_all(bytes).map_err(io)?;
        f.sync_data().map_err(io)
    }

    /// Moves `<index>.part` into the asset store; empty or missing part → Ok(None). A non-empty part that
    /// is not audio or video is an error and stays where it is.
    pub fn finish_segment(&self, rec_id: &str, index: u32, assets_dir: &Path) -> Result<Option<AssetInfo>> {
        let part = part_path(&self.existing(rec_id)?, index);
        match fs::metadata(&part) {
            Ok(m) if m.len() > 0 => {}
            Ok(_) => return Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io(e)),
        }
        let mut head = Vec::with_capacity(assets::SVG_SNIFF_BYTES);
        File::open(&part)
            .and_then(|f| f.take(assets::SVG_SNIFF_BYTES as u64).read_to_end(&mut head))
            .map_err(io)?;
        let kind = assets::sniff(&head)
            .filter(|k| k.is_media())
            .ok_or_else(|| StorageError::Limit("segment is not audio or video".into()))?;
        assets::save_asset_from_file(assets_dir, &part, kind).map(Some)
    }

    /// Removes the recording's folder (after the marker element is saved).
    pub fn close(&self, rec_id: &str) -> Result<()> {
        match fs::remove_dir_all(self.dir(rec_id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io(e)),
        }
    }

    /// Every recording folder left behind: its manifest and the indexes of non-empty parts, oldest first.
    /// A UUID-named folder without a manifest holds nothing recoverable and is removed; other names are
    /// not ours and are left alone.
    pub fn unfinished(&self) -> Result<Vec<Unfinished>> {
        let Ok(read) = fs::read_dir(&self.root) else {
            return Ok(Vec::new());
        };
        let mut found: Vec<(SystemTime, Unfinished)> = Vec::new();
        for entry in read.flatten() {
            let path = entry.path();
            let Some(rec_id) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
                continue;
            };
            if !assets::valid_id(&rec_id) || !path.is_dir() {
                continue;
            }
            let manifest_path = path.join(MANIFEST);
            let raw = match fs::read(&manifest_path) {
                Ok(raw) => raw,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    let _ = fs::remove_dir_all(&path);
                    continue;
                }
                // Any other failure may be transient: never delete audio over it.
                Err(_) => continue,
            };
            // A manifest that does not parse is kept untouched: the audio beside it may still be wanted.
            let Ok(manifest) = serde_json::from_slice(&raw) else {
                continue;
            };
            let at = fs::metadata(&manifest_path).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
            found.push((at, Unfinished { rec_id, manifest, parts: parts_of(&path) }));
        }
        found.sort_by_key(|(at, _)| *at);
        Ok(found.into_iter().map(|(_, u)| u).collect())
    }
}

fn part_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("{index}.part"))
}

fn parts_of(dir: &Path) -> Vec<u32> {
    let mut parts: Vec<u32> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.metadata().is_ok_and(|m| m.is_file() && m.len() > 0))
        .filter_map(|e| e.path().file_name()?.to_str()?.strip_suffix(".part")?.parse().ok())
        .collect();
    parts.sort_unstable();
    parts
}

fn write_manifest(dir: &Path, manifest: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec(manifest)?;
    let tmp = dir.join("manifest.tmp");
    let mut f = File::create(&tmp).map_err(io)?;
    f.write_all(&bytes).and_then(|()| f.sync_all()).map_err(io)?;
    drop(f);
    fs::rename(&tmp, dir.join(MANIFEST)).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io(e)
    })
}
