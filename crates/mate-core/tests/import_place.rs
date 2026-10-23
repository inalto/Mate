//! Placing imported documents into storage: scaling, limits, re-import, rollback, images.

mod common;

use std::io::{Cursor, Write};
use std::path::PathBuf;

use mate_core::import::{
    ImportBackground, ImportDocument, ImportError, ImportImage, ImportLimits, ImportPage,
    ImportPoint, ImportSection, ImportSkipped, ImportSource, ImportStroke, ImportText, PlaceTarget,
    file_fingerprint, parse, place_document,
};
use mate_core::model::{BackgroundType, ElementType, PageMode, PenStyle};
use mate_core::storage::Storage;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

fn tmp_assets(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mate-import-{name}-{}", uuid::Uuid::new_v4()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn stroke(points: &[(f64, f64)], color: &str, highlighter: bool, style: PenStyle) -> ImportStroke {
    ImportStroke {
        points: points.iter().map(|&(x, y)| ImportPoint { x, y, pressure: None }).collect(),
        color: color.into(),
        opacity: 1.0,
        width: 2.0,
        is_highlighter: highlighter,
        pen_style: style,
        z_index: 0,
    }
}

fn letter_page(id: &str) -> ImportPage {
    ImportPage {
        source_id: id.into(),
        title: Some(format!("Source {id}")),
        width: 612.0,
        height: 792.0,
        background: ImportBackground::Lined { spacing: 20.0 },
        strokes: vec![
            stroke(&[(0.0, 0.0), (306.0, 396.0), (612.0, 792.0)], "#FF0000", false, PenStyle::FountainPen),
            stroke(&[(10.0, 10.0), (20.0, 10.0)], "#00ff00", true, PenStyle::Highlighter),
        ],
        texts: vec![ImportText {
            x: 61.2,
            y: 100.0,
            width: None,
            text: "Hello <world>".into(),
            font_size: Some(12.0),
            color: "#123456".into(),
        }],
        images: vec![],
        skipped: ImportSkipped { tables: 1, shapes: 2, other: 0 },
    }
}

/// Two sections, three US-letter pages.
fn sample_doc() -> ImportDocument {
    ImportDocument {
        source: ImportSource::GoodNotes,
        title: "Biology".into(),
        default_page_mode: PageMode::Page,
        sections: vec![
            ImportSection {
                source_id: "s1".into(),
                title: "Cells".into(),
                pages: vec![letter_page("p1"), letter_page("p2")],
            },
            ImportSection { source_id: "s2".into(), title: "".into(), pages: vec![letter_page("p3")] },
        ],
    }
}

#[test]
fn places_document_as_new_unit_scaled_to_sheet() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("place");
    let doc = sample_doc();
    let report = place_document(
        &mut st,
        &doc,
        PlaceTarget::NewUnit { title: None },
        &assets,
        &file_fingerprint(b"file"),
    )
    .unwrap();
    assert_eq!(report.pages_imported, 3);
    assert_eq!(report.section_ids.len(), 2);
    assert_eq!((report.strokes, report.texts, report.images), (6, 3, 0));
    assert_eq!((report.tables_skipped, report.shapes_skipped), (3, 6));
    assert_eq!(report.pages_skipped_duplicate + report.pages_skipped_limit, 0);

    let tree = st.list_tree().unwrap();
    let unit = tree.units.iter().find(|u| u.id == report.unit_id).unwrap();
    assert_eq!(unit.title, "Biology");
    let sections: Vec<_> = tree.sections.iter().filter(|s| s.unit_id == unit.id).collect();
    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0].title, "Cells");
    assert_eq!(sections[1].title, "Section 2");
    let pages: Vec<_> = tree.pages.iter().filter(|p| p.section_id == sections[0].id).collect();
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[1].order_index, 1);

    let s = 1080.0 / 612.0;
    let page = pages[0];
    assert_eq!(page.title, "Source p1");
    assert_eq!(page.mode, PageMode::Page);
    assert_eq!(page.page_width, None);
    assert!((page.page_height.unwrap() - 792.0 * s).abs() < 1e-9);
    assert_eq!(page.background_config.r#type, BackgroundType::Ruled);
    assert!((page.background_config.spacing - 20.0 * s).abs() < 1e-9);
    let meta = page.import_metadata.as_ref().unwrap();
    assert_eq!(meta["source"], "good-notes");
    assert_eq!(meta["sourcePageId"], "p1");
    assert_eq!(meta["sourceFingerprint"].as_str().unwrap().len(), 16);

    let els = st.load_elements(&page.id).unwrap();
    assert_eq!(els.len(), 3);
    let ink = &els[0];
    assert_eq!(ink.r#type, ElementType::Stroke);
    assert_eq!(ink.color, "#ff0000");
    assert!(!ink.is_highlighter);
    assert_eq!(ink.pen_style, Some(PenStyle::FountainPen));
    assert!((ink.points[1].x - 306.0 * s).abs() < 1e-9);
    assert!((ink.points[1].y - 396.0 * s).abs() < 1e-9);
    assert!((ink.points[2].x - 1080.0).abs() < 1e-9);
    assert!((ink.width - 2.0 * s).abs() < 1e-9);
    assert_eq!(ink.points[0].pressure, 0.5);
    assert_eq!(ink.points[1].timestamp - ink.points[0].timestamp, 10.0);
    let fp = ink.content.as_ref().unwrap()["importFingerprint"].as_str().unwrap();
    assert_eq!(fp.len(), 16);
    assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
    let hl = &els[1];
    assert!(hl.is_highlighter);
    assert_eq!(hl.pen_style, Some(PenStyle::Highlighter));
    assert_ne!(hl.content.as_ref().unwrap()["importFingerprint"], ink.content.as_ref().unwrap()["importFingerprint"]);
    let text = &els[2];
    assert_eq!(text.r#type, ElementType::TextBox);
    let c = text.content.as_ref().unwrap();
    assert_eq!(c["rawContent"], "Hello <world>");
    assert_eq!(c["contentHtml"], "<p>Hello &lt;world&gt;</p>");
    assert!((c["textAttributes"]["fontSize"].as_f64().unwrap() - 12.0 * s).abs() < 1e-9);
    assert!((text.points[0].x - 108.0).abs() < 1e-9);
    assert!(c["importFingerprint"].is_string());

    // A second new-unit import of the same file is a separate unit with all pages.
    let again = place_document(
        &mut st,
        &doc,
        PlaceTarget::NewUnit { title: Some("Copy".into()) },
        &assets,
        &file_fingerprint(b"file"),
    )
    .unwrap();
    assert_eq!(again.pages_imported, 3);
    assert_ne!(again.unit_id, report.unit_id);
    let _ = std::fs::remove_dir_all(&assets);
}

#[test]
fn import_truncates_at_limits_and_reports() {
    let tiny = |id: String| ImportPage { source_id: id, width: 100.0, height: 100.0, ..ImportPage::default() };
    let mut pages: Vec<ImportPage> = (0..2100).map(|i| tiny(format!("p{i}"))).collect();
    pages[0].strokes = (0..5200)
        .map(|i| stroke(&[(i as f64 % 100.0, 1.0)], "#000000", false, PenStyle::Pen))
        .collect();
    let long: Vec<(f64, f64)> = (0..60_000).map(|i| (i as f64 % 100.0, 2.0)).collect();
    pages[1].strokes = vec![
        stroke(&long, "#000000", false, PenStyle::Pen),
        stroke(&[(1.0, 1.0)], "#000000", false, PenStyle::Pen),
    ];
    let doc = ImportDocument {
        source: ImportSource::Notability,
        title: "Big".into(),
        default_page_mode: PageMode::Canvas,
        sections: vec![
            ImportSection { source_id: "a".into(), title: "A".into(), pages: pages.split_off(1000) },
            ImportSection { source_id: "b".into(), title: "B".into(), pages },
        ],
    };
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("limits");
    let report =
        place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "00000000000000aa")
            .unwrap();
    assert_eq!(report.pages_imported, 2000);
    assert_eq!(report.pages_skipped_limit, 100);
    assert_eq!(report.elements_skipped_limit, 200 + 1);
    assert_eq!(report.strokes, 5000 + 1);
    assert!(report.warnings.iter().any(|w| w.contains("2000")));
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.pages.len(), 2000);
    // Section A holds p1000..p2099 (all placed), section B p0..p999 (p900.. over the limit).
    let placed = |id: &str| {
        tree.pages.iter().find(|p| p.import_metadata.as_ref().unwrap()["sourcePageId"] == id)
    };
    assert!(placed("p899").is_some() && placed("p900").is_none());
    let crowded = placed("p0").expect("p0 placed");
    assert_eq!(st.count_elements(&crowded.id).unwrap(), 5000);
}

#[test]
fn reimport_skips_fingerprinted_pages() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("reimport");
    let doc = sample_doc();
    let fp = file_fingerprint(b"same file");
    let first =
        place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, &fp).unwrap();
    let pages_before = st.list_tree().unwrap().pages.len();
    let sections_before = st.list_tree().unwrap().sections.len();

    let target = PlaceTarget::ExistingUnit { unit_id: first.unit_id.clone() };
    let second = place_document(&mut st, &doc, target.clone(), &assets, &fp).unwrap();
    assert_eq!(second.pages_skipped_duplicate, 3);
    assert_eq!(second.pages_imported, 0);
    assert!(second.section_ids.is_empty());
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.pages.len(), pages_before);
    assert_eq!(tree.sections.len(), sections_before);

    // A grown source: the known page is skipped, the new one lands in the same section.
    let mut grown = sample_doc();
    grown.sections[0].pages.push(letter_page("p9"));
    let third = place_document(&mut st, &grown, target, &assets, &fp).unwrap();
    assert_eq!((third.pages_imported, third.pages_skipped_duplicate), (1, 3));
    assert!(third.section_ids.is_empty(), "reuses the section of its siblings");
    let tree = st.list_tree().unwrap();
    let p9 = tree
        .pages
        .iter()
        .find(|p| p.import_metadata.as_ref().is_some_and(|m| m["sourcePageId"] == "p9"))
        .unwrap();
    assert_eq!(p9.section_id, first.section_ids[0]);
    assert_eq!(p9.order_index, 2);

    // A different file is not a duplicate.
    let other = place_document(
        &mut st,
        &doc,
        PlaceTarget::ExistingUnit { unit_id: first.unit_id.clone() },
        &assets,
        &file_fingerprint(b"another file"),
    )
    .unwrap();
    assert_eq!(other.pages_imported, 3);
}

/// A zip whose central directory declares 2 GiB for each of its two entries.
fn zip_bomb() -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    for name in ["note.note", "pageIdInfo.dat"] {
        w.start_file(name, opts).unwrap();
        w.write_all(b"tiny").unwrap();
    }
    let mut bytes = w.finish().unwrap().into_inner();
    let mut patched = 0;
    let mut i = 0;
    while i + 46 <= bytes.len() {
        if bytes[i..i + 4] == [0x50, 0x4b, 0x01, 0x02] {
            // Central directory header: uncompressed size at offset 24.
            bytes[i + 24..i + 28].copy_from_slice(&0x8000_0000u32.to_le_bytes());
            patched += 1;
        }
        i += 1;
    }
    assert_eq!(patched, 2);
    bytes
}

#[test]
fn import_rejects_zip_bomb_and_rolls_back() {
    let st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("bomb");
    std::fs::create_dir_all(&assets).unwrap();
    let units_before = st.list_tree().unwrap().units.len();

    let bomb = zip_bomb();
    let err = parse(&bomb, "bomb.sdocx", &ImportLimits::default()).unwrap_err();
    assert!(matches!(err, ImportError::Limit(_)), "{err:?}");
    assert!(err.to_string().contains("1024 MiB"), "{err}");

    let tree = st.list_tree().unwrap();
    assert_eq!(tree.units.len(), units_before);
    assert_eq!(std::fs::read_dir(&assets).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&assets);
}

fn temp_db() -> PathBuf {
    std::env::temp_dir().join(format!("mate-import-{}.db", uuid::Uuid::new_v4()))
}

fn remove_db(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn failure_before_the_first_page_rolls_back_the_new_unit_and_images() {
    let path = temp_db();
    let mut st = Storage::open(&path).unwrap();
    let assets = tmp_assets("rollback");
    std::fs::create_dir_all(&assets).unwrap();
    let mut doc = sample_doc();
    doc.sections[0].pages[0].images.push(ImportImage {
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        bytes: PNG.to_vec(),
        mime: Some("image/png".into()),
    });
    // Every page write fails.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER no_pages BEFORE INSERT ON pages BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    )
    .unwrap();
    let err = place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "1");
    assert!(err.is_err());
    let tree = st.list_tree().unwrap();
    assert!(tree.units.is_empty() && tree.sections.is_empty() && tree.pages.is_empty());
    assert_eq!(std::fs::read_dir(&assets).unwrap().count(), 0, "stored image removed");

    // Into an existing unit: the sections it created go, the unit stays.
    st.upsert_unit(&common::unit("u1", None)).unwrap();
    let err = place_document(
        &mut st,
        &doc,
        PlaceTarget::ExistingUnit { unit_id: "u1".into() },
        &assets,
        "1",
    );
    assert!(err.is_err());
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.units.len(), 1);
    assert!(tree.sections.is_empty());

    // Unknown unit and empty documents are refused up front.
    let missing = PlaceTarget::ExistingUnit { unit_id: "nope".into() };
    assert!(place_document(&mut st, &doc, missing, &assets, "1").is_err());
    let empty = ImportDocument { sections: vec![], ..sample_doc() };
    assert!(place_document(&mut st, &empty, PlaceTarget::NewUnit { title: None }, &assets, "1").is_err());
    assert_eq!(st.list_tree().unwrap().units.len(), 1);

    // A failure after the first page keeps what landed and reports it.
    conn.execute_batch(
        "DROP TRIGGER no_pages;
         CREATE TRIGGER no_p2 BEFORE INSERT ON pages WHEN NEW.title = 'Source p2'
         BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    )
    .unwrap();
    let report =
        place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "1").unwrap();
    assert_eq!(report.pages_imported, 1);
    assert!(report.warnings.iter().any(|w| w.contains("stopped after 1 pages")), "{:?}", report.warnings);
    let tree = st.list_tree().unwrap();
    let pages: Vec<_> = tree.pages.iter().collect();
    assert_eq!(pages.len(), 1);
    assert_eq!(report.section_ids.len(), 1);
    assert_eq!(std::fs::read_dir(&assets).unwrap().count(), 1, "the landed page's image");
    drop(conn);
    drop(st);
    remove_db(&path);
    let _ = std::fs::remove_dir_all(&assets);
}

#[test]
fn image_assets_are_stored_and_referenced() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("images");
    let mut doc = sample_doc();
    doc.sections.truncate(1);
    doc.sections[0].pages.truncate(1);
    let page = &mut doc.sections[0].pages[0];
    page.images = vec![
        ImportImage {
            x: 61.2,
            y: 61.2,
            width: 306.0,
            height: 153.0,
            bytes: PNG.to_vec(),
            mime: Some("image/png".into()),
        },
        ImportImage {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            bytes: b"not an image".to_vec(),
            mime: None,
        },
    ];
    let report =
        place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "2").unwrap();
    assert_eq!(report.images, 1);
    assert!(report.warnings.iter().any(|w| w.contains("image")));
    let page_id = &st.list_tree().unwrap().pages[0].id;
    let els = st.load_elements(page_id).unwrap();
    let img = els.iter().find(|e| e.r#type == ElementType::Image).unwrap();
    let id = img.image_url.as_deref().unwrap();
    let path = mate_core::assets::asset_path(&assets, id).expect("asset stored");
    assert_eq!(std::fs::read(path).unwrap(), PNG);
    let s = 1080.0 / 612.0;
    assert!((img.width - 306.0 * s).abs() < 1e-9);
    assert!((img.height.unwrap() - 153.0 * s).abs() < 1e-9);
    assert!((img.points[0].x - 108.0).abs() < 1e-9);
    assert!(st.referenced_asset_ids().unwrap().contains(id));
    assert_eq!(std::fs::read_dir(&assets).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(&assets);
}
