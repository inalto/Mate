//! Segment store: streamed parts, atomic manifest, recovery of unfinished recordings.

use std::fs;
use std::path::PathBuf;

use mate_core::assets::{self, AssetKind};
use mate_core::recording::{MAX_APPEND_BYTES, RecordingDir};
use serde_json::json;
use uuid::Uuid;

/// A minimal WebM (EBML) header: the first chunk of a segment.
const WEBM: &[u8] = b"\x1A\x45\xDF\xA3\x9F\x42\x86\x81";

struct Fixture {
    root: PathBuf,
    rec: RecordingDir,
    assets: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fixture(name: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("mate-rec-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let rec = RecordingDir::new(root.join("recordings"));
    let assets = root.join("assets");
    Fixture { root, rec, assets }
}

fn id() -> String {
    Uuid::new_v4().to_string()
}

#[test]
fn append_then_finish_moves_the_part_into_assets() {
    let f = fixture("finish");
    let rid = id();
    f.rec.begin(&rid, &json!({"recId": rid})).unwrap();
    f.rec.append(&rid, 0, WEBM).unwrap();
    f.rec.append(&rid, 0, b"more audio").unwrap();
    let info = f.rec.finish_segment(&rid, 0, &f.assets).unwrap().expect("a segment");
    assert_eq!(info.mime, AssetKind::Webm.mime());
    let mut want = WEBM.to_vec();
    want.extend_from_slice(b"more audio");
    assert_eq!(fs::read(&info.path).unwrap(), want);
    assert_eq!(info.bytes, want.len() as u64);
    assert!(assets::asset_path(&f.assets, &info.id).is_some());
    assert!(!f.root.join("recordings").join(&rid).join("0.part").exists());
}

#[test]
fn finish_of_an_empty_or_missing_part_is_none() {
    let f = fixture("empty");
    let rid = id();
    f.rec.begin(&rid, &json!({})).unwrap();
    assert!(f.rec.finish_segment(&rid, 3, &f.assets).unwrap().is_none());
    f.rec.append(&rid, 1, b"").unwrap();
    assert!(f.rec.finish_segment(&rid, 1, &f.assets).unwrap().is_none());
}

#[test]
fn finish_of_a_part_that_is_not_media_is_an_error_and_keeps_the_part() {
    let f = fixture("notmedia");
    let rid = id();
    f.rec.begin(&rid, &json!({})).unwrap();
    f.rec.append(&rid, 0, b"hello world").unwrap();
    assert!(f.rec.finish_segment(&rid, 0, &f.assets).is_err());
    assert!(f.root.join("recordings").join(&rid).join("0.part").exists());
}

#[test]
fn append_refuses_an_unknown_recording_and_oversized_chunks() {
    let f = fixture("append");
    assert!(f.rec.append(&id(), 0, WEBM).is_err());
    let rid = id();
    f.rec.begin(&rid, &json!({})).unwrap();
    assert!(f.rec.append(&rid, 0, &vec![0u8; MAX_APPEND_BYTES + 1]).is_err());
    assert!(f.rec.append(&rid, 0, &vec![0u8; MAX_APPEND_BYTES]).is_ok());
}

#[test]
fn rec_id_must_be_a_uuid() {
    let f = fixture("uuid");
    let m = json!({});
    for bad in ["../x", "..", "", "not-a-uuid", "A0B1C2D3-0000-4000-8000-000000000000x"] {
        assert!(f.rec.begin(bad, &m).is_err(), "begin {bad}");
        assert!(f.rec.save_manifest(bad, &m).is_err(), "save_manifest {bad}");
        assert!(f.rec.append(bad, 0, WEBM).is_err(), "append {bad}");
        assert!(f.rec.finish_segment(bad, 0, &f.assets).is_err(), "finish {bad}");
        assert!(f.rec.close(bad).is_err(), "close {bad}");
    }
    assert!(!f.root.join("x").exists());
}

#[test]
fn manifest_save_is_atomic() {
    let f = fixture("manifest");
    let rid = id();
    f.rec.begin(&rid, &json!({"v": 1})).unwrap();
    f.rec.save_manifest(&rid, &json!({"v": 2})).unwrap();
    let dir = f.root.join("recordings").join(&rid);
    let m: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(m, json!({"v": 2}));
    assert!(!fs::read_dir(&dir).unwrap().any(|e| e.unwrap().path().extension().is_some_and(|x| x == "tmp")));
    assert!(f.rec.save_manifest(&id(), &json!({})).is_err(), "unknown recording");
}

#[test]
fn recover_lists_unfinished_with_their_non_empty_parts() {
    let f = fixture("recover");
    let (a, b) = (id(), id());
    f.rec.begin(&a, &json!({"n": "a"})).unwrap();
    f.rec.append(&a, 0, WEBM).unwrap();
    f.rec.append(&a, 1, b"").unwrap();
    f.rec.begin(&b, &json!({"n": "b"})).unwrap();
    let mut all = f.rec.unfinished().unwrap();
    all.sort_by(|x, y| x.manifest["n"].as_str().cmp(&y.manifest["n"].as_str()));
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].rec_id, a);
    assert_eq!(all[0].parts, vec![0]);
    assert_eq!(all[1].parts, Vec::<u32>::new());
    let wire = serde_json::to_value(&all[0]).unwrap();
    assert!(wire.get("recId").is_some() && wire.get("manifest").is_some() && wire.get("parts").is_some());
    f.rec.close(&a).unwrap();
    let left = f.rec.unfinished().unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].rec_id, b);
}

#[test]
fn recover_ignores_a_folder_without_a_manifest() {
    let f = fixture("nomanifest");
    let rid = id();
    let dir = f.root.join("recordings").join(&rid);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("0.part"), WEBM).unwrap();
    fs::create_dir_all(f.root.join("recordings").join("not-a-uuid")).unwrap();
    assert!(f.rec.unfinished().unwrap().is_empty());
    assert!(!dir.exists());
    assert!(f.root.join("recordings").join("not-a-uuid").exists(), "foreign folders are left alone");
}

#[test]
fn unfinished_is_empty_when_nothing_was_ever_recorded() {
    let f = fixture("none");
    assert!(f.rec.unfinished().unwrap().is_empty());
}

#[test]
fn recover_keeps_a_folder_whose_manifest_cannot_be_read() {
    let f = fixture("unreadable");
    let rid = id();
    let dir = f.root.join("recordings").join(&rid);
    // A directory where the manifest file should be: reading it fails with something other than NotFound.
    fs::create_dir_all(dir.join("manifest.json")).unwrap();
    fs::write(dir.join("0.part"), WEBM).unwrap();
    assert!(f.rec.unfinished().unwrap().is_empty());
    assert!(dir.join("0.part").exists());
}
