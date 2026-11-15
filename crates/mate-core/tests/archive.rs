mod common;

use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;

use common::{page, section, stroke, unit};
use mate_core::archive::{ImportLimits, Recordings, export_unit, import_archive, import_archive_with_limits};
use mate_core::assets;
use mate_core::storage::{Storage, StorageError};

/// A fresh (empty, not yet created) per-test directory under the system temp dir.
fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mate-archive-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
const PDF: &[u8] = b"%PDF-1.7
%fake
";

/// Unit `u1` with sections `sa`, `sb`; pages `pa1`, `pa2` (child of `pa1`), `pb1`; 10 elements.
fn source() -> Storage {
    let mut st = Storage::open_in_memory().unwrap();
    st.upsert_unit(&unit("u1", None)).unwrap();
    st.upsert_section(&section("sa", "u1")).unwrap();
    st.upsert_section(&section("sb", "u1")).unwrap();
    st.upsert_page(&page("pa1", "sa", None)).unwrap();
    st.upsert_page(&page("pa2", "sa", Some("pa1"))).unwrap();
    st.upsert_page(&page("pb1", "sb", None)).unwrap();
    let mut els = Vec::new();
    for i in 0..4 {
        els.push(stroke(&format!("ea{i}"), "pa1", 3 + i));
    }
    for i in 0..3 {
        els.push(stroke(&format!("eb{i}"), "pa2", 2));
    }
    for i in 0..3 {
        els.push(stroke(&format!("ec{i}"), "pb1", 5));
    }
    st.upsert_elements(&els).unwrap();
    st
}

#[test]
fn round_trip_preserves_structure_and_elements() {
    let src = source();
    let bytes = export_unit(&src, "u1", &tmp("none"), Recordings::Exclude).unwrap();

    let mut dst = Storage::open_in_memory().unwrap();
    dst.upsert_unit(&unit("existing", None)).unwrap();
    let report = import_archive(&mut dst, &bytes, &tmp("none-dst")).unwrap();
    assert_eq!(report.pages, 3);
    assert_eq!(report.elements, 10);
    assert_eq!(report.skipped, 0);
    assert_ne!(report.unit_id, "u1");

    let tree = dst.list_tree().unwrap();
    let u = tree.units.iter().find(|u| u.id == report.unit_id).unwrap();
    assert_eq!(u.title, "Unit u1");
    assert_eq!(u.bookshelf_id, None);
    assert_eq!(u.order_index, 1, "placed after the existing unit");

    let sections: Vec<_> = tree.sections.iter().filter(|s| s.unit_id == u.id).collect();
    assert_eq!(sections.len(), 2);
    let mut titles: Vec<_> = sections.iter().map(|s| s.title.as_str()).collect();
    titles.sort();
    assert_eq!(titles, ["Section sa", "Section sb"]);
    assert!(sections.iter().all(|s| s.id != "sa" && s.id != "sb"));

    let section_ids: Vec<_> = sections.iter().map(|s| s.id.clone()).collect();
    let pages: Vec<_> = tree
        .pages
        .iter()
        .filter(|p| section_ids.contains(&p.section_id))
        .collect();
    assert_eq!(pages.len(), 3);
    assert!(
        pages
            .iter()
            .all(|p| !["pa1", "pa2", "pb1"].contains(&p.id.as_str()))
    );
    let parent = pages.iter().find(|p| p.title == "Page pa1").unwrap();
    let child = pages.iter().find(|p| p.title == "Page pa2").unwrap();
    assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));
    assert_eq!(child.section_id, parent.section_id);

    let mut total = 0;
    for p in &pages {
        let original_id = &p.title["Page ".len()..];
        let originals = src.load_elements(original_id).unwrap();
        let imported = dst.load_elements(&p.id).unwrap();
        assert_eq!(imported.len(), originals.len());
        for (a, b) in originals.iter().zip(&imported) {
            assert_ne!(a.id, b.id);
            assert_eq!(b.page_id, p.id);
            assert_eq!(a.points, b.points);
            assert_eq!(a.color, b.color);
            assert_eq!(a.pen_style, b.pen_style);
        }
        total += imported.len();
    }
    assert_eq!(total, 10);

    // Re-importing never collides.
    let again = import_archive(&mut dst, &bytes, &tmp("none-dst")).unwrap();
    assert_ne!(again.unit_id, report.unit_id);
    assert_eq!(again.elements, 10);
}

#[test]
fn rejects_newer_schema() {
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(
            br#"{"format":"mate-archive","schemaVersion":2,"exportedAt":"2030-01-01T00:00:00.000Z","app":"Mate"}"#,
        )
        .unwrap();
        zip.finish().unwrap();
    }
    let mut dst = Storage::open_in_memory().unwrap();
    match import_archive(&mut dst, buf.get_ref(), &tmp("none-dst")) {
        Err(StorageError::Limit(msg)) => assert!(msg.contains("newer version"), "{msg}"),
        other => panic!("expected Limit error, got {other:?}"),
    }
    assert!(dst.list_tree().unwrap().units.is_empty());
}

#[test]
fn rejects_non_zip_and_missing_manifest() {
    let mut dst = Storage::open_in_memory().unwrap();
    assert!(matches!(
        import_archive(&mut dst, b"not a zip", &tmp("none-dst")),
        Err(StorageError::Limit(_))
    ));

    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        zip.start_file("unit.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"{}").unwrap();
        zip.finish().unwrap();
    }
    match import_archive(&mut dst, buf.get_ref(), &tmp("none-dst")) {
        Err(StorageError::Limit(msg)) => assert!(msg.contains("manifest"), "{msg}"),
        other => panic!("expected Limit error, got {other:?}"),
    }
}

#[test]
fn skips_elements_over_limits() {
    let mut src = Storage::open_in_memory().unwrap();
    src.upsert_unit(&unit("u1", None)).unwrap();
    src.upsert_section(&section("s", "u1")).unwrap();
    src.upsert_page(&page("p", "s", None)).unwrap();
    src.upsert_elements(&[stroke("ok", "p", 3)]).unwrap();
    let bytes = export_unit(&src, "u1", &tmp("none"), Recordings::Exclude).unwrap();

    // Re-pack the archive with one oversized element added to the page.
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut data).unwrap();
            if name == "pages/p.json" {
                let mut els: Vec<serde_json::Value> = serde_json::from_slice(&data).unwrap();
                els.push(serde_json::to_value(stroke("big", "p", 50_001)).unwrap());
                data = serde_json::to_vec(&els).unwrap();
            }
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&data).unwrap();
        }
        zip.finish().unwrap();
    }

    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, out.get_ref(), &tmp("none-dst")).unwrap();
    assert_eq!(report.elements, 1);
    assert_eq!(report.skipped, 1);
}

/// Unit `u1` / section `s` / page `p` with an image element and a PDF page element whose assets
/// live in `dir`, plus a stroke.
fn source_with_assets(dir: &std::path::Path) -> (Storage, String, String) {
    let img = assets::save_sniffed(dir, PNG).unwrap();
    let pdf = assets::save_sniffed(dir, PDF).unwrap();
    let mut st = Storage::open_in_memory().unwrap();
    st.upsert_unit(&unit("u1", None)).unwrap();
    st.upsert_section(&section("s", "u1")).unwrap();
    st.upsert_page(&page("p", "s", None)).unwrap();
    let mut image = stroke("img", "p", 2);
    image.r#type = mate_core::model::ElementType::Image;
    image.image_url = Some(img.id.clone());
    let mut pdf_page = stroke("pdfp", "p", 2);
    pdf_page.r#type = mate_core::model::ElementType::Image;
    pdf_page.content = Some(serde_json::json!({ "pdfSourceKey": pdf.id, "pdfPage": 1 }));
    st.upsert_elements(&[image, pdf_page, stroke("ink", "p", 3)])
        .unwrap();
    (st, img.id, pdf.id)
}

fn imported_elements(dst: &Storage, unit_id: &str) -> Vec<mate_core::model::Element> {
    let tree = dst.list_tree().unwrap();
    let sec = tree.sections.iter().find(|s| s.unit_id == unit_id).unwrap();
    let page = tree.pages.iter().find(|p| p.section_id == sec.id).unwrap();
    dst.load_elements(&page.id).unwrap()
}

#[test]
fn archive_round_trips_assets() {
    let src_dir = tmp("assets-src");
    let (src, img_id, pdf_id) = source_with_assets(&src_dir);
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();

    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    let names: Vec<String> = zip.file_names().map(str::to_owned).collect();
    assert!(names.contains(&format!("assets/{img_id}.png")), "{names:?}");
    assert!(names.contains(&format!("assets/{pdf_id}.pdf")), "{names:?}");
    let mut manifest = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("manifest.json").unwrap(), &mut manifest)
        .unwrap();
    assert!(manifest.contains("\"schemaVersion\": 1"), "{manifest}");

    let dst_dir = tmp("assets-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    assert_eq!(report.elements, 3);
    let els = imported_elements(&dst, &report.unit_id);
    let image = els.iter().find(|e| e.image_url.is_some()).unwrap();
    let new_img = image.image_url.clone().unwrap();
    assert_ne!(new_img, img_id, "asset ids are re-minted");
    assert_eq!(
        fs::read(assets::asset_path(&dst_dir, &new_img).unwrap()).unwrap(),
        PNG
    );
    let pdf_el = els
        .iter()
        .find(|e| {
            e.content
                .as_ref()
                .is_some_and(|c| c.get("pdfSourceKey").is_some())
        })
        .unwrap();
    let content = pdf_el.content.as_ref().unwrap();
    let new_pdf = content["pdfSourceKey"].as_str().unwrap();
    assert_ne!(new_pdf, pdf_id);
    assert_eq!(content["pdfPage"], 1, "other content fields are kept");
    assert_eq!(
        fs::read(assets::asset_path(&dst_dir, new_pdf).unwrap()).unwrap(),
        PDF
    );

    // A second import mints another copy rather than sharing files.
    let again = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    let again_img = imported_elements(&dst, &again.unit_id)
        .into_iter()
        .find_map(|e| e.image_url)
        .unwrap();
    assert_ne!(again_img, new_img);
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn import_tolerates_missing_asset() {
    let src_dir = tmp("missing-src");
    let (src, img_id, pdf_id) = source_with_assets(&src_dir);
    // The PDF file vanished before export: its entry is simply absent.
    assert!(assets::delete_asset(&src_dir, &pdf_id));
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();
    let zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    assert!(!zip.file_names().any(|n| n.contains(&pdf_id)));

    let dst_dir = tmp("missing-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    assert_eq!(
        report.elements, 3,
        "the element with the missing asset is kept"
    );
    let els = imported_elements(&dst, &report.unit_id);
    let pdf_el = els
        .iter()
        .find(|e| {
            e.content
                .as_ref()
                .is_some_and(|c| c.get("pdfSourceKey").is_some())
        })
        .unwrap();
    assert_eq!(
        pdf_el.content.as_ref().unwrap()["pdfSourceKey"],
        pdf_id.as_str(),
        "id left dangling"
    );
    let image = els.iter().find_map(|e| e.image_url.clone()).unwrap();
    assert_ne!(image, img_id);
    assert!(assets::asset_path(&dst_dir, &image).is_some());
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

/// Asset files in `dir` (ignores a missing directory).
fn asset_files(dir: &std::path::Path) -> usize {
    fs::read_dir(dir).map(|d| d.count()).unwrap_or(0)
}

/// Unit `u1` / `s` / `p` with `n` image elements, each referencing its own `bytes`-long PNG.
fn source_with_images(dir: &std::path::Path, n: usize, bytes: usize) -> Storage {
    let mut st = Storage::open_in_memory().unwrap();
    st.upsert_unit(&unit("u1", None)).unwrap();
    st.upsert_section(&section("s", "u1")).unwrap();
    st.upsert_page(&page("p", "s", None)).unwrap();
    let mut els = Vec::new();
    for i in 0..n {
        let mut data = PNG.to_vec();
        data.resize(bytes, 0);
        data[bytes - 1] = i as u8; // distinct files
        let info = assets::save_sniffed(dir, &data).unwrap();
        let mut image = stroke(&format!("img{i}"), "p", 2);
        image.r#type = mate_core::model::ElementType::Image;
        image.image_url = Some(info.id);
        els.push(image);
    }
    st.upsert_elements(&els).unwrap();
    st
}

#[test]
fn import_rejects_decompressed_assets_over_cap() {
    // Scaled down: three 200 KiB assets against a 512 KiB cap (the default cap is 512 MiB, with
    // up to 256 MiB per asset entry, so at full size three media files of ~200 MiB would trip it).
    let src_dir = tmp("cap-src");
    let src = source_with_images(&src_dir, 3, 200 * 1024);
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();

    let dst_dir = tmp("cap-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let limits = ImportLimits {
        total_asset_bytes: 512 * 1024,
        ..ImportLimits::default()
    };
    match import_archive_with_limits(&mut dst, &bytes, &dst_dir, limits) {
        Err(StorageError::Limit(msg)) => assert!(msg.contains("assets"), "{msg}"),
        other => panic!("expected Limit error, got {other:?}"),
    }
    assert!(
        dst.list_tree().unwrap().units.is_empty(),
        "unit rolled back"
    );
    assert_eq!(
        asset_files(&dst_dir),
        0,
        "assets already written are removed"
    );

    // Within the cap the same archive imports.
    let ok = ImportLimits {
        total_asset_bytes: 1024 * 1024,
        ..ImportLimits::default()
    };
    assert_eq!(
        import_archive_with_limits(&mut dst, &bytes, &dst_dir, ok)
            .unwrap()
            .elements,
        3
    );
    assert_eq!(asset_files(&dst_dir), 3);
    assert_eq!(ImportLimits::default().total_asset_bytes, 512 * 1024 * 1024);
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn import_rejects_too_many_assets() {
    let src_dir = tmp("count-src");
    let src = source_with_images(&src_dir, 3, 64);
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();
    let dst_dir = tmp("count-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let limits = ImportLimits {
        max_assets: 2,
        ..ImportLimits::default()
    };
    assert!(matches!(
        import_archive_with_limits(&mut dst, &bytes, &dst_dir, limits),
        Err(StorageError::Limit(_))
    ));
    assert!(dst.list_tree().unwrap().units.is_empty());
    assert_eq!(ImportLimits::default().max_assets, 2000);
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn import_skips_asset_kind_mismatch() {
    let src_dir = tmp("kind-src");
    let img = assets::save_sniffed(&src_dir, PNG).unwrap();
    let pdf = assets::save_sniffed(&src_dir, PDF).unwrap();
    let mut src = Storage::open_in_memory().unwrap();
    src.upsert_unit(&unit("u1", None)).unwrap();
    src.upsert_section(&section("s", "u1")).unwrap();
    src.upsert_page(&page("p", "s", None)).unwrap();
    // Swapped: the image points at the PDF and the PDF page at the PNG.
    let mut image = stroke("img", "p", 2);
    image.r#type = mate_core::model::ElementType::Image;
    image.image_url = Some(pdf.id.clone());
    let mut pdf_page = stroke("pdfp", "p", 2);
    pdf_page.r#type = mate_core::model::ElementType::Image;
    pdf_page.content = Some(serde_json::json!({ "pdfSourceKey": img.id }));
    src.upsert_elements(&[image, pdf_page]).unwrap();
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();

    let dst_dir = tmp("kind-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    assert_eq!(report.elements, 2, "elements kept");
    let els = imported_elements(&dst, &report.unit_id);
    assert!(
        els.iter()
            .any(|e| e.image_url.as_deref() == Some(pdf.id.as_str())),
        "left dangling"
    );
    assert!(els.iter().any(|e| {
        e.content
            .as_ref()
            .is_some_and(|c| c["pdfSourceKey"] == img.id.as_str())
    }));
    assert_eq!(asset_files(&dst_dir), 0, "nothing imported");
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn archive_round_trips_media_assets() {
    // ID3v2 header + an MPEG frame sync: enough for the content sniffer.
    const MP3: &[u8] = &[0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xFF, 0xFB, 0x90, 0x00];
    let src_dir = tmp("media-src");
    let audio = assets::save_sniffed(&src_dir, MP3).unwrap();
    assert_eq!(audio.mime, "audio/mpeg");
    let mut src = Storage::open_in_memory().unwrap();
    src.upsert_unit(&unit("u1", None)).unwrap();
    src.upsert_section(&section("s", "u1")).unwrap();
    src.upsert_page(&page("p", "s", None)).unwrap();
    let mut media = stroke("m", "p", 1);
    media.r#type = mate_core::model::ElementType::Media;
    media.image_url = Some(audio.id.clone());
    media.content = Some(serde_json::json!({ "kind": "audio", "title": "Lecture" }));
    src.upsert_elements(&[media]).unwrap();
    assert!(src.referenced_asset_ids().unwrap().contains(&audio.id), "media stays GC-safe");

    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();
    let zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    assert!(
        zip.file_names().any(|n| n == format!("assets/{}.mp3", audio.id)),
        "media asset is archived"
    );

    let dst_dir = tmp("media-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    let els = imported_elements(&dst, &report.unit_id);
    assert_eq!(els.len(), 1);
    assert_eq!(els[0].r#type, mate_core::model::ElementType::Media);
    let new_id = els[0].image_url.clone().unwrap();
    assert_ne!(new_id, audio.id);
    let info = assets::asset_info(&dst_dir, &new_id).unwrap();
    assert_eq!(info.mime, "audio/mpeg");
    assert_eq!(fs::read(info.path).unwrap(), MP3);
    assert_eq!(els[0].content.as_ref().unwrap()["kind"], "audio");
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn import_matches_the_element_type_to_the_asset_kind() {
    const MP3: &[u8] = &[0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xFF, 0xFB, 0x90, 0x00];
    let src_dir = tmp("media-kind-src");
    let img = assets::save_sniffed(&src_dir, PNG).unwrap();
    let audio = assets::save_sniffed(&src_dir, MP3).unwrap();
    let mut src = Storage::open_in_memory().unwrap();
    src.upsert_unit(&unit("u1", None)).unwrap();
    src.upsert_section(&section("s", "u1")).unwrap();
    src.upsert_page(&page("p", "s", None)).unwrap();
    // Swapped: the image element points at the MP3 and the media element at the PNG.
    let mut image = stroke("img", "p", 2);
    image.r#type = mate_core::model::ElementType::Image;
    image.image_url = Some(audio.id.clone());
    let mut media = stroke("m", "p", 1);
    media.r#type = mate_core::model::ElementType::Media;
    media.image_url = Some(img.id.clone());
    src.upsert_elements(&[image, media]).unwrap();
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();

    let dst_dir = tmp("media-kind-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    assert_eq!(report.elements, 2, "elements kept");
    let els = imported_elements(&dst, &report.unit_id);
    let url_of = |t| els.iter().find(|e| e.r#type == t).and_then(|e| e.image_url.clone());
    assert_eq!(url_of(mate_core::model::ElementType::Image), Some(audio.id.clone()), "left dangling");
    assert_eq!(url_of(mate_core::model::ElementType::Media), Some(img.id.clone()), "left dangling");
    assert_eq!(asset_files(&dst_dir), 0, "nothing imported");
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn json_entries_keep_their_own_smaller_cap() {
    use mate_core::archive::{MAX_ENTRY_BYTES, MAX_JSON_ENTRY_BYTES};
    assert_eq!(MAX_JSON_ENTRY_BYTES, 64 * 1024 * 1024);
    assert_eq!(MAX_ENTRY_BYTES, assets::MAX_ASSET_BYTES as u64);
    // A unit.json declared larger than the JSON cap is refused before it is read.
    let big = vec![b' '; MAX_JSON_ENTRY_BYTES as usize + 1];
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("manifest.json", opts).unwrap();
    zip.write_all(br#"{"format":"mate-archive","schemaVersion":1,"exportedAt":"x","app":"Mate"}"#).unwrap();
    zip.start_file("unit.json", opts).unwrap();
    zip.write_all(&big).unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let mut dst = Storage::open_in_memory().unwrap();
    match import_archive(&mut dst, &bytes, &tmp("json-cap")) {
        Err(StorageError::Limit(msg)) => assert!(msg.contains("unit.json is too large"), "{msg}"),
        other => panic!("expected Limit error, got {other:?}"),
    }
}

#[test]
fn archive_round_trips_whiteboard_elements() {
    use mate_core::model::ElementType;
    use serde_json::json;
    let mut src = Storage::open_in_memory().unwrap();
    src.upsert_unit(&unit("u1", None)).unwrap();
    src.upsert_section(&section("s", "u1")).unwrap();
    src.upsert_page(&page("p", "s", None)).unwrap();

    let mut card = stroke("card", "p", 1);
    card.r#type = ElementType::TextBox;
    card.box_width = Some(200.0);
    card.box_height = Some(120.0);
    let card_content = json!({
        "card": { "background": "yellow", "radius": 8, "shadow": "soft", "border": false },
        "contentHtml": "<p>Note</p>", "rawContent": "Note", "textAttributes": {}
    });
    card.content = Some(card_content.clone());
    let mut frame = stroke("frame", "p", 1);
    frame.r#type = ElementType::Frame;
    frame.box_width = Some(800.0);
    frame.box_height = Some(600.0);
    let frame_content = json!({ "title": "Slide 1", "order": 0 });
    frame.content = Some(frame_content.clone());
    let mut map = stroke("map", "p", 1);
    map.r#type = ElementType::Mindmap;
    let map_content = json!({
        "layout": "balance", "style": 4,
        "root": { "id": "r", "text": "Topic", "children": [
            { "id": "a", "text": "Alpha", "collapsed": true, "children": [
                { "id": "a1", "text": "Leaf", "children": [] } ] },
            { "id": "b", "text": "Beta", "color": "#0277BD", "children": [] } ] }
    });
    map.content = Some(map_content.clone());
    let mut conn = stroke("conn", "p", 2);
    conn.r#type = ElementType::Connector;
    conn.content = Some(json!({
        "mode": "elbow",
        "source": { "id": "card", "side": "right" },
        "target": { "id": "map", "side": "auto" },
        "caps": { "start": "none", "end": "arrow" },
        "label": { "text": "leads to", "t": 0.5 },
        "route": [{ "x": 0.0, "y": 0.0 }, { "x": 10.0, "y": 0.0 }]
    }));
    // Created (and so exported and imported) before the elements it binds to: the id map must
    // cover every element before any connector is rewritten.
    conn.created_at = "2000-01-01T00:00:00.000Z".into();
    // A connector bound to an element that is not in the archive comes back with a free end.
    let mut dangling = stroke("dangling", "p", 2);
    dangling.r#type = ElementType::Connector;
    let dangling_route = json!([{ "x": 0.0, "y": 0.0 }, { "x": 1.0, "y": 2.0 }]);
    dangling.content = Some(json!({
        "mode": "straight", "source": { "id": "gone", "side": "auto" },
        "caps": { "start": "none", "end": "none" }, "route": dangling_route
    }));
    let dangling_points = dangling.points.clone();
    src.upsert_elements(&[conn, card, frame, map, dangling]).unwrap();

    let bytes = export_unit(&src, "u1", &tmp("wb-src"), Recordings::Exclude).unwrap();
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &tmp("wb-dst")).unwrap();
    assert_eq!(report.elements, 5);
    let els = imported_elements(&dst, &report.unit_id);
    let by_type = |t: ElementType| els.iter().filter(move |e| e.r#type == t);

    let card = by_type(ElementType::TextBox).next().unwrap();
    assert_eq!(card.content.as_ref(), Some(&card_content));
    assert_eq!((card.box_width, card.box_height), (Some(200.0), Some(120.0)));
    let frame = by_type(ElementType::Frame).next().unwrap();
    assert_eq!(frame.content.as_ref(), Some(&frame_content));
    assert_eq!((frame.box_width, frame.box_height), (Some(800.0), Some(600.0)));
    let map = by_type(ElementType::Mindmap).next().unwrap();
    assert_eq!(map.content.as_ref(), Some(&map_content));

    let conns: Vec<_> = by_type(ElementType::Connector).collect();
    assert_eq!(conns.len(), 2);
    let bound = conns.iter().find(|c| c.content.as_ref().unwrap()["mode"] == "elbow").unwrap();
    let c = bound.content.as_ref().unwrap();
    assert_eq!(c["source"], json!({ "id": card.id, "side": "right" }));
    assert_eq!(c["target"], json!({ "id": map.id, "side": "auto" }));
    assert_eq!(c["label"], json!({ "text": "leads to", "t": 0.5 }));
    assert_eq!(c["caps"], json!({ "start": "none", "end": "arrow" }));
    let free = conns.iter().find(|c| c.content.as_ref().unwrap()["mode"] == "straight").unwrap();
    let fc = free.content.as_ref().unwrap();
    assert!(fc.get("source").is_none());
    assert!(fc.get("target").is_none());
    // The freed end keeps its absolute point, and the cached route is kept.
    assert_eq!(free.points, dangling_points);
    assert_eq!(fc["route"], dangling_route);
}

use serde_json::json;

const WEBM: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81];
/// When the stroke of [`source_with_recording`] was drawn.
const STROKE_AT: &str = "2026-11-14T09:05:00.000Z";

/// Unit `u1` / `s` / `p` with a recording marker over two WebM segments and one stroke taken at
/// [`STROKE_AT`]. Returns the source and the two segment assets.
fn source_with_recording(dir: &std::path::Path) -> (Storage, [assets::AssetInfo; 2]) {
    let seg = |tail: u8| {
        let mut d = WEBM.to_vec();
        d.push(tail);
        assets::save_sniffed(dir, &d).unwrap()
    };
    let (a, b) = (seg(1), seg(2));
    let mut st = Storage::open_in_memory().unwrap();
    st.upsert_unit(&unit("u1", None)).unwrap();
    st.upsert_section(&section("s", "u1")).unwrap();
    st.upsert_page(&page("p", "s", None)).unwrap();
    let mut marker = stroke("rec", "p", 0);
    marker.r#type = mate_core::model::ElementType::Media;
    marker.image_url = Some(a.id.clone());
    marker.content = Some(json!({
        "kind": "audio", "title": "Lecture",
        "recording": {
            "unitId": "u1",
            "spans": [{ "wallStart": "2026-11-14T09:00:00.000Z", "audioStartMs": 0, "durationMs": 600000 }],
            "segments": [
                { "assetId": a.id, "durationMs": 300000, "mime": "audio/webm" },
                { "assetId": b.id, "durationMs": 300000, "mime": "audio/webm" }
            ]
        }
    }));
    let mut ink = stroke("ink", "p", 3);
    ink.created_at = STROKE_AT.into();
    st.upsert_elements(&[marker, ink]).unwrap();
    (st, [a, b])
}

fn recording_segment_ids(e: &mate_core::model::Element) -> Vec<String> {
    e.content.as_ref().unwrap()["recording"]["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["assetId"].as_str().unwrap().to_owned())
        .collect()
}

fn marker_of(els: &[mate_core::model::Element]) -> &mate_core::model::Element {
    els.iter().find(|e| e.r#type == mate_core::model::ElementType::Media).unwrap()
}

#[test]
fn recording_round_trips_through_an_archive() {
    let src_dir = tmp("rec-src");
    let (src, [a, b]) = source_with_recording(&src_dir);
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Include).unwrap();
    let zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    let names: Vec<&str> = zip.file_names().collect();
    for id in [&a.id, &b.id] {
        assert!(names.contains(&format!("assets/{id}.webm").as_str()), "segment {id} archived");
    }

    let dst_dir = tmp("rec-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    let els = imported_elements(&dst, &report.unit_id);
    let ink = els.iter().find(|e| e.r#type == mate_core::model::ElementType::Stroke).unwrap();
    assert_eq!(ink.created_at, STROKE_AT, "the stroke keeps its creation time");
    let marker = marker_of(&els);
    let rec = &marker.content.as_ref().unwrap()["recording"];
    assert_eq!(rec["unitId"], report.unit_id.as_str());
    assert_eq!(rec["spans"][0]["wallStart"], "2026-11-14T09:00:00.000Z");
    let ids = recording_segment_ids(marker);
    assert_eq!(ids.len(), 2);
    assert!(ids.iter().all(|i| *i != a.id && *i != b.id), "ids are new");
    for id in &ids {
        assert_eq!(assets::asset_info(&dst_dir, id).unwrap().mime, "video/webm", "WebM sniffs as video");
    }
    assert_eq!(marker.image_url.as_deref(), Some(ids[0].as_str()));
    assert!(dst.referenced_asset_ids().unwrap().contains(&ids[1]));
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn recordings_are_left_out_unless_asked() {
    let src_dir = tmp("rec-off-src");
    let (src, _) = source_with_recording(&src_dir);
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Exclude).unwrap();
    let zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).unwrap();
    assert!(!zip.file_names().any(|n| n.starts_with("assets/")), "no audio in the archive");

    let dst_dir = tmp("rec-off-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    assert_eq!(report.elements, 2);
    let els = imported_elements(&dst, &report.unit_id);
    let marker = marker_of(&els);
    let content = marker.content.as_ref().unwrap();
    assert!(content.get("recording").is_none());
    assert_eq!(content["title"], "Lecture");
    assert_eq!(marker.image_url, None);
    assert_eq!(asset_files(&dst_dir), 0);
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

#[test]
fn recording_segments_must_be_audio_or_video() {
    let src_dir = tmp("rec-kind-src");
    let img = assets::save_sniffed(&src_dir, PNG).unwrap();
    let (mut src, [a, _]) = source_with_recording(&src_dir);
    let mut marker = src.load_elements("p").unwrap().into_iter().find(|e| e.id == "rec").unwrap();
    marker.content.as_mut().unwrap()["recording"]["segments"][1]["assetId"] = json!(img.id);
    src.upsert_elements(&[marker]).unwrap();
    let bytes = export_unit(&src, "u1", &src_dir, Recordings::Include).unwrap();

    let dst_dir = tmp("rec-kind-dst");
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &dst_dir).unwrap();
    let els = imported_elements(&dst, &report.unit_id);
    let ids = recording_segment_ids(marker_of(&els));
    assert_ne!(ids[0], a.id);
    assert_eq!(ids[1], img.id, "an image is no segment: left dangling");
    assert_eq!(asset_files(&dst_dir), 1, "only the audio segment imported");
    let _ = fs::remove_dir_all(&src_dir);
    let _ = fs::remove_dir_all(&dst_dir);
}

/// Source `u1` / `sa` / `pa1` whose strokes were created at `stamps`.
fn stamped_source(stamps: &[&str]) -> Storage {
    let mut st = Storage::open_in_memory().unwrap();
    st.upsert_unit(&unit("u1", None)).unwrap();
    st.upsert_section(&section("sa", "u1")).unwrap();
    st.upsert_page(&page("pa1", "sa", None)).unwrap();
    let els: Vec<_> = (0..4)
        .map(|i| {
            let mut e = stroke(&format!("e{i}"), "pa1", 2);
            e.created_at = stamps.get(i).copied().unwrap_or("2025-03-01T10:00:09.000Z").into();
            e
        })
        .collect();
    st.upsert_elements(&els).unwrap();
    st
}

/// Imports `src`'s unit and returns the new unit's tree and the loaded elements of its page titled
/// "Page pa1".
fn import_and_load(src: &Storage, name: &str) -> (mate_core::storage::NotebookTree, Vec<mate_core::model::Element>) {
    let bytes = export_unit(src, "u1", &tmp(name), Recordings::Exclude).unwrap();
    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &bytes, &tmp(&format!("{name}-dst"))).unwrap();
    let tree = dst.list_tree().unwrap();
    let secs: Vec<_> = tree.sections.iter().filter(|s| s.unit_id == report.unit_id).map(|s| s.id.clone()).collect();
    let page = tree.pages.iter().find(|p| secs.contains(&p.section_id) && p.title == "Page pa1").unwrap();
    let els = dst.load_elements(&page.id).unwrap();
    (tree, els)
}

#[test]
fn imported_elements_keep_created_at() {
    let stamps = [
        "2025-03-01T10:00:00.000Z",
        "2025-03-01T10:00:01.000Z",
        "2025-03-01T10:00:02.000Z",
        "2025-03-01T10:00:03.000Z",
    ];
    let (tree, els) = import_and_load(&stamped_source(&stamps), "keep-ca");
    assert_eq!(els.iter().map(|e| e.created_at.as_str()).collect::<Vec<_>>(), stamps);
    // Units, sections and pages still get the import time.
    assert!(tree.units.iter().all(|u| !u.created_at.starts_with("2025")));
    assert!(tree.sections.iter().all(|s| !s.created_at.starts_with("2025")));
    assert!(tree.pages.iter().all(|p| !p.created_at.starts_with("2025")));
}

#[test]
fn a_bad_element_created_at_falls_back_to_now() {
    let (_, els) = import_and_load(&stamped_source(&["not a time", ""]), "bad-ca");
    assert_eq!(els.len(), 4);
    for e in &els {
        assert!(
            time::OffsetDateTime::parse(&e.created_at, &time::format_description::well_known::Rfc3339).is_ok(),
            "{:?} parses",
            e.created_at
        );
    }
    assert_eq!(
        els.iter().filter(|e| e.created_at.as_str() >= "2026").count(),
        2,
        "the two bad stamps became now; the other two kept theirs"
    );
}

#[test]
fn a_non_utc_created_at_is_normalised_to_utc() {
    let (_, els) = import_and_load(
        &stamped_source(&["2025-03-01T12:00:00.000+02:00", "2025-03-01T05:30:00-04:30"]),
        "offset-ca",
    );
    let mut got: Vec<&str> = els.iter().map(|e| e.created_at.as_str()).collect();
    got.sort_unstable();
    assert_eq!(got, ["2025-03-01T10:00:00.000Z", "2025-03-01T10:00:00.000Z", "2025-03-01T10:00:09.000Z", "2025-03-01T10:00:09.000Z"]);
}

#[test]
fn an_import_keeps_at_most_the_marker_cap_per_page() {
    use mate_core::import::MAX_MARKERS_PER_PAGE;
    let src = source();
    let bytes = export_unit(&src, "u1", &tmp("none"), Recordings::Exclude).unwrap();

    // Re-pack the archive with cap + 5 minimal recording markers added to page `pa1`.
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut data = Vec::new();
            std::io::Read::read_to_end(&mut f, &mut data).unwrap();
            if name == "pages/pa1.json" {
                let mut els: Vec<serde_json::Value> = serde_json::from_slice(&data).unwrap();
                for k in 0..MAX_MARKERS_PER_PAGE + 5 {
                    let mut m = stroke(&format!("rec{k}"), "pa1", 0);
                    m.r#type = mate_core::model::ElementType::Media;
                    m.pen_style = None;
                    m.content = Some(json!({ "kind": "audio", "recording": {} }));
                    els.push(serde_json::to_value(m).unwrap());
                }
                data = serde_json::to_vec(&els).unwrap();
            }
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&data).unwrap();
        }
        zip.finish().unwrap();
    }

    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, out.get_ref(), &tmp("marker-cap-dst")).unwrap();
    assert_eq!(report.pages, 3, "the book imports");
    assert_eq!(report.elements, 10 + MAX_MARKERS_PER_PAGE);
    assert_eq!(report.skipped, 5, "the markers past the cap are skipped");
    let tree = dst.list_tree().unwrap();
    let sections: Vec<_> = tree.sections.iter().filter(|s| s.unit_id == report.unit_id).map(|s| s.id.clone()).collect();
    let (mut markers, mut strokes) = (0, 0);
    for p in tree.pages.iter().filter(|p| sections.contains(&p.section_id)) {
        let els = dst.load_elements(&p.id).unwrap();
        let m = els.iter().filter(|e| e.r#type == mate_core::model::ElementType::Media).count();
        if p.title == "Page pa1" {
            assert_eq!(m, MAX_MARKERS_PER_PAGE, "page pa1 keeps exactly the cap");
        } else {
            assert_eq!(m, 0);
        }
        markers += m;
        strokes += els.iter().filter(|e| e.r#type == mate_core::model::ElementType::Stroke).count();
    }
    assert_eq!(markers, MAX_MARKERS_PER_PAGE);
    assert_eq!(strokes, 10, "the rest of the page and the other pages import normally");
}

// --- Recall results never leave in an export or a share -------------------------------------

/// [`source`] with recall answers on `pa1` and `pb1`.
fn source_with_recall() -> Storage {
    let mut st = source();
    for (page, element, knew) in [("pa1", "ea0", true), ("pa1", "ea1", false), ("pb1", "ec0", true)] {
        st.record_recall(&mate_core::storage::RecallAnswer {
            page_id: page.into(),
            element_id: element.into(),
            knew,
            run_id: "r1".into(),
        })
        .unwrap();
    }
    assert_eq!(st.recall_rows("u1").unwrap().len(), 3);
    st
}

fn entry_names(bytes: &[u8]) -> Vec<String> {
    zip::ZipArchive::new(Cursor::new(bytes)).unwrap().file_names().map(str::to_owned).collect()
}

#[test]
fn an_exported_book_carries_no_recall_file() {
    let src = source_with_recall();
    for recordings in [Recordings::Include, Recordings::Exclude, Recordings::External] {
        let bytes = export_unit(&src, "u1", &tmp("recall-export"), recordings).unwrap();
        let names = entry_names(&bytes);
        assert!(names.iter().any(|n| n == "unit.json"), "{names:?}");
        assert!(!names.iter().any(|n| n.contains("recall")), "{recordings:?}: {names:?}");
        assert!(!String::from_utf8_lossy(&bytes).contains("runId"), "{recordings:?}: no answer anywhere");
    }
}

#[test]
fn a_plain_import_ignores_a_recall_file() {
    // The book as a backup writes it, with its `recall.json`.
    let src = source_with_recall();
    let (backup, _) = mate_core::archive::export_backup(&src, &tmp("recall-plain")).unwrap();
    let mut zip = zip::ZipArchive::new(Cursor::new(backup)).unwrap();
    let mut book = Vec::new();
    std::io::Read::read_to_end(&mut zip.by_name("books/01-unit-u1.mate").unwrap(), &mut book).unwrap();
    assert!(entry_names(&book).iter().any(|n| n == "recall.json"));

    let mut dst = Storage::open_in_memory().unwrap();
    let report = import_archive(&mut dst, &book, &tmp("recall-plain-dst")).unwrap();
    assert_eq!(report.pages, 3);
    assert!(dst.recall_rows(&report.unit_id).unwrap().is_empty());
    let limits = ImportLimits::default();
    let again = import_archive_with_limits(&mut dst, &book, &tmp("recall-plain-dst"), limits).unwrap();
    assert!(dst.recall_rows(&again.unit_id).unwrap().is_empty());
}
