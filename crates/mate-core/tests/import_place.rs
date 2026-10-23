//! Placing imported documents into storage: scaling, limits, re-import, rollback, images.

mod common;

use std::io::{Cursor, Write};
use std::path::PathBuf;

use mate_core::import::{
    ImportBackground, ImportDocument, ImportError, ImportImage, ImportLimits, ImportPage,
    ImportPoint, ImportSection, ImportSkipped, ImportSource, ImportStroke, ImportText, PlaceControl,
    PlaceTarget, file_fingerprint, parse, place_document, place_document_with,
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
    assert!(
        report.warnings.iter().any(|w| w == "The import stopped after 1 page because a page could not be saved."),
        "{:?}",
        report.warnings
    );
    assert!(report.details.iter().any(|d| d.contains("disk full")), "{:?}", report.details);
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

/// Every stored coordinate and size of the page's elements is finite.
fn assert_all_finite(st: &Storage, page_id: &str) {
    for e in st.load_elements(page_id).expect("page loads back") {
        assert!(e.width.is_finite() && e.height.is_none_or(f64::is_finite), "{e:?}");
        assert!(e.box_width.is_none_or(f64::is_finite) && e.box_height.is_none_or(f64::is_finite));
        for p in &e.points {
            assert!(p.x.is_finite() && p.y.is_finite() && p.pressure.is_finite() && p.timestamp.is_finite());
        }
    }
}

fn odd_page(id: &str, width: f64, height: f64) -> ImportPage {
    let mut p = letter_page(id);
    p.width = width;
    p.height = height;
    p.strokes.push(ImportStroke {
        points: vec![
            ImportPoint { x: 1.0, y: 1.0, pressure: Some(f64::NAN) },
            ImportPoint { x: f64::MAX, y: 1e300, pressure: Some(2.0) },
        ],
        ..stroke(&[], "#000", false, PenStyle::Pen)
    });
    p.strokes.push(stroke(&[(f64::NAN, 1.0)], "#000", false, PenStyle::Pen));
    p.images.push(ImportImage {
        x: f64::INFINITY,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        bytes: PNG.to_vec(),
        mime: None,
    });
    p.images.push(ImportImage { x: 0.0, y: 0.0, width: 1e9, height: 1e9, bytes: PNG.to_vec(), mime: None });
    p
}

#[test]
fn non_finite_scale_never_writes_nan() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("nan");
    let doc = ImportDocument {
        sections: vec![ImportSection {
            source_id: "s".into(),
            title: "S".into(),
            pages: vec![
                odd_page("tiny", 1e-310, 792.0),
                odd_page("small", 1e-30, 1e9),
                odd_page("zero", 0.0, 0.0),
                odd_page("nan", f64::NAN, f64::INFINITY),
            ],
        }],
        ..sample_doc()
    };
    let report =
        place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "3").unwrap();
    assert_eq!(report.pages_imported, 4);
    // Per page: the NaN stroke and the image at x = inf are skipped as invalid.
    assert_eq!(report.elements_skipped_invalid, 4 * 2);
    assert!(report.warnings.iter().any(|w| w.contains("no usable width")));
    let tree = st.list_tree().unwrap();
    for page in &tree.pages {
        let h = page.page_height.unwrap_or(1440.0);
        assert!(h.is_finite() && h > 0.0 && h <= 21_600.0, "{h}");
        assert_all_finite(&st, &page.id);
        let els = st.load_elements(&page.id).unwrap();
        let big = els.iter().find(|e| e.r#type == ElementType::Image).unwrap();
        assert!(big.width <= 1080.0 && big.height.unwrap() <= h);
        for e in &els {
            for p in &e.points {
                assert!((0.0..=1080.0).contains(&p.x) && (0.0..=h).contains(&p.y));
                assert!((0.0..=1.0).contains(&p.pressure));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&assets);
}

#[test]
fn tall_source_page_height_is_capped() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("tall");
    let mut page = letter_page("scroll");
    page.height = 612.0 * 100.0; // 100 sheet widths tall
    page.strokes.push(stroke(&[(10.0, 612.0 * 99.0)], "#000", false, PenStyle::Pen));
    let doc = ImportDocument {
        sections: vec![ImportSection { source_id: "s".into(), title: "S".into(), pages: vec![page] }],
        ..sample_doc()
    };
    place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "4").unwrap();
    let page = &st.list_tree().unwrap().pages[0];
    assert_eq!(page.page_height, Some(20.0 * 1080.0));
    let els = st.load_elements(&page.id).unwrap();
    assert!(els.iter().flat_map(|e| &e.points).all(|p| p.y <= 20.0 * 1080.0));
    assert_all_finite(&st, &page.id);
}

#[test]
fn new_pages_follow_the_highest_order_index() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("order");
    let doc = sample_doc();
    let fp = file_fingerprint(b"ordered");
    let first =
        place_document(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, &fp).unwrap();
    // Leave a gap: the second page of "Cells" moves to order 7.
    let tree = st.list_tree().unwrap();
    let mut moved = tree
        .pages
        .iter()
        .find(|p| p.section_id == first.section_ids[0] && p.order_index == 1)
        .unwrap()
        .clone();
    moved.order_index = 7;
    st.upsert_page(&moved).unwrap();

    let mut grown = sample_doc();
    grown.sections[0].pages.push(letter_page("p9"));
    place_document(&mut st, &grown, PlaceTarget::ExistingUnit { unit_id: first.unit_id }, &assets, &fp)
        .unwrap();
    let p9 = st
        .list_tree()
        .unwrap()
        .pages
        .into_iter()
        .find(|p| p.import_metadata.as_ref().is_some_and(|m| m["sourcePageId"] == "p9"))
        .unwrap();
    assert_eq!(p9.order_index, 8);
}

#[test]
fn import_metadata_survives_an_archive_round_trip() {
    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("archive");
    let report = place_document(
        &mut st,
        &sample_doc(),
        PlaceTarget::NewUnit { title: None },
        &assets,
        &file_fingerprint(b"archived"),
    )
    .unwrap();
    let before: Vec<_> = st
        .list_tree()
        .unwrap()
        .pages
        .into_iter()
        .map(|p| p.import_metadata.unwrap())
        .collect();
    let bytes = mate_core::archive::export_unit(&st, &report.unit_id, &assets).unwrap();

    let mut other = Storage::open_in_memory().unwrap();
    let imported = mate_core::archive::import_archive(&mut other, &bytes, &assets).unwrap();
    assert_eq!(imported.pages, 3);
    let mut after: Vec<_> = other
        .list_tree()
        .unwrap()
        .pages
        .into_iter()
        .map(|p| p.import_metadata.expect("importMetadata kept"))
        .collect();
    let key = |m: &serde_json::Value| m["sourcePageId"].as_str().unwrap().to_owned();
    let mut before = before;
    before.sort_by_key(key);
    after.sort_by_key(key);
    assert_eq!(before, after);

    // Re-importing the same source file into the restored unit finds every page.
    let unit_id = other.list_tree().unwrap().units[0].id.clone();
    let again = place_document(
        &mut other,
        &sample_doc(),
        PlaceTarget::ExistingUnit { unit_id },
        &assets,
        &file_fingerprint(b"archived"),
    )
    .unwrap();
    assert_eq!(again.pages_skipped_duplicate, 3);
    let _ = std::fs::remove_dir_all(&assets);
}

/// One section of `n` letter pages.
fn many_pages(n: usize) -> ImportDocument {
    ImportDocument {
        sections: vec![ImportSection {
            source_id: "s".into(),
            title: "Many".into(),
            pages: (0..n).map(|i| letter_page(&format!("p{i}"))).collect(),
        }],
        ..sample_doc()
    }
}

#[test]
fn placement_stops_at_deadline_keeps_finished_pages() {
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("deadline");
    let doc = many_pages(20);
    let limits = ImportLimits { deadline: Some(Instant::now() + Duration::from_millis(150)), ..ImportLimits::default() };
    let cancel = AtomicBool::new(false);
    let seen = std::cell::RefCell::new(Vec::new());
    // Each page takes 40 ms (in the progress callback, outside the storage step).
    let progress = |done: usize, total: usize| {
        seen.borrow_mut().push((done, total));
        std::thread::sleep(Duration::from_millis(40));
    };
    let control = PlaceControl { limits: &limits, cancel: &cancel, progress: &progress };
    let report = place_document_with(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "5", &control)
        .unwrap();
    let n = report.pages_imported;
    assert!((1..20).contains(&n), "{n}");
    assert!(
        report.warnings.iter().any(|w| w.starts_with(&format!("The import stopped after {n} page"))
            && w.ends_with("because it took too long.")),
        "{:?}",
        report.warnings
    );
    assert_eq!(seen.borrow().len(), n);
    assert_eq!(seen.borrow()[0], (1, 20));
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.pages.len(), n);

    // A deadline already passed: nothing is placed and the new unit is removed.
    let past = ImportLimits { deadline: Some(Instant::now() - Duration::from_secs(1)), ..ImportLimits::default() };
    let control = PlaceControl { limits: &past, cancel: &cancel, progress: &|_, _| {} };
    let err = place_document_with(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "6", &control)
        .unwrap_err();
    assert!(err.to_string().contains("took too long"), "{err}");
    assert_eq!(st.list_tree().unwrap().units.len(), 1);
}

#[test]
fn placement_honours_cancel() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let mut st = Storage::open_in_memory().unwrap();
    let assets = tmp_assets("cancel");
    let doc = many_pages(10);
    let limits = ImportLimits::default();
    let cancel = AtomicBool::new(false);
    // Cancelled once three pages are done.
    let progress = |done: usize, _| {
        if done == 3 {
            cancel.store(true, Ordering::SeqCst);
        }
    };
    let control = PlaceControl { limits: &limits, cancel: &cancel, progress: &progress };
    let report = place_document_with(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "7", &control)
        .unwrap();
    assert_eq!(report.pages_imported, 3);
    assert!(report.warnings.contains(&"The import stopped after 3 pages because it was cancelled.".to_string()));
    assert_eq!(st.list_tree().unwrap().pages.len(), 3);

    // Cancelled before the first page: an error, and the unit it created is gone.
    let control = PlaceControl { limits: &limits, cancel: &cancel, progress: &|_, _| {} };
    let err = place_document_with(&mut st, &doc, PlaceTarget::NewUnit { title: None }, &assets, "8", &control)
        .unwrap_err();
    assert!(err.to_string().contains("cancelled"), "{err}");
    assert_eq!(st.list_tree().unwrap().units.len(), 1);
}
