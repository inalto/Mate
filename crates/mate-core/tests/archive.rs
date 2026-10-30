mod common;

use std::fs;
use std::io::{Cursor, Write};
use std::path::PathBuf;

use common::{page, section, stroke, unit};
use mate_core::archive::{ImportLimits, export_unit, import_archive, import_archive_with_limits};
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
    let bytes = export_unit(&src, "u1", &tmp("none")).unwrap();

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
    let bytes = export_unit(&src, "u1", &tmp("none")).unwrap();

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
    let bytes = export_unit(&src, "u1", &src_dir).unwrap();

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
    let bytes = export_unit(&src, "u1", &src_dir).unwrap();
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
    let bytes = export_unit(&src, "u1", &src_dir).unwrap();

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
    let bytes = export_unit(&src, "u1", &src_dir).unwrap();
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
    let bytes = export_unit(&src, "u1", &src_dir).unwrap();

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

    let bytes = export_unit(&src, "u1", &src_dir).unwrap();
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
    let bytes = export_unit(&src, "u1", &src_dir).unwrap();

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
    // A connector bound to an element that is not in the archive comes back with a free end.
    let mut dangling = stroke("dangling", "p", 2);
    dangling.r#type = ElementType::Connector;
    dangling.content = Some(json!({
        "mode": "straight", "source": { "id": "gone", "side": "auto" },
        "caps": { "start": "none", "end": "none" }, "route": []
    }));
    src.upsert_elements(&[card, frame, map, conn, dangling]).unwrap();

    let bytes = export_unit(&src, "u1", &tmp("wb-src")).unwrap();
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
    assert!(free.content.as_ref().unwrap().get("source").is_none());
}
