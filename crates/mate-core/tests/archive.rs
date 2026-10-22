mod common;

use std::io::{Cursor, Write};

use common::{page, section, stroke, unit};
use mate_core::archive::{export_unit, import_archive};
use mate_core::storage::{Storage, StorageError};

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
    let bytes = export_unit(&src, "u1").unwrap();

    let mut dst = Storage::open_in_memory().unwrap();
    dst.upsert_unit(&unit("existing", None)).unwrap();
    let report = import_archive(&mut dst, &bytes).unwrap();
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
    let again = import_archive(&mut dst, &bytes).unwrap();
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
    match import_archive(&mut dst, buf.get_ref()) {
        Err(StorageError::Limit(msg)) => assert!(msg.contains("newer version"), "{msg}"),
        other => panic!("expected Limit error, got {other:?}"),
    }
    assert!(dst.list_tree().unwrap().units.is_empty());
}

#[test]
fn rejects_non_zip_and_missing_manifest() {
    let mut dst = Storage::open_in_memory().unwrap();
    assert!(matches!(
        import_archive(&mut dst, b"not a zip"),
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
    match import_archive(&mut dst, buf.get_ref()) {
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
    let bytes = export_unit(&src, "u1").unwrap();

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
    let report = import_archive(&mut dst, out.get_ref()).unwrap();
    assert_eq!(report.elements, 1);
    assert_eq!(report.skipped, 1);
}
