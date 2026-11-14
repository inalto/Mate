mod common;

use common::{seeded, stroke};
use mate_core::model::{ElementType, PenStyle, ShapeType};
use mate_core::storage::StorageError;

#[test]
fn upsert_is_idempotent_and_bumps_version() {
    let mut st = seeded();
    let e = stroke("e1", "p1", 4);
    st.upsert_elements(std::slice::from_ref(&e)).unwrap();
    st.upsert_elements(std::slice::from_ref(&e)).unwrap();

    let loaded = st.load_elements("p1").unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].version, 2);
    assert_eq!(loaded[0].points, e.points);
    assert_eq!(loaded[0].pen_style, Some(PenStyle::FountainPen));
    assert_eq!(st.count_elements("p1").unwrap(), 1);
}

#[test]
fn round_trips_optional_and_json_fields() {
    let mut st = seeded();
    let mut e = stroke("box", "p1", 0);
    e.r#type = ElementType::TextBox;
    e.shape_type = Some(ShapeType::Hexagon);
    e.pen_style = None;
    e.box_width = Some(200.0);
    e.content = Some(serde_json::json!({ "html": "<p>hi</p>" }));
    e.classification = Some(serde_json::json!(["math"]));
    st.upsert_elements(std::slice::from_ref(&e)).unwrap();

    let loaded = &st.load_elements("p1").unwrap()[0];
    assert_eq!(loaded.r#type, ElementType::TextBox);
    assert_eq!(loaded.shape_type, Some(ShapeType::Hexagon));
    assert_eq!(loaded.pen_style, None);
    assert_eq!(loaded.box_width, Some(200.0));
    assert_eq!(loaded.content, e.content);
    assert_eq!(loaded.classification, e.classification);
}

#[test]
fn delete_elements_is_soft() {
    let mut st = seeded();
    st.upsert_elements(&[stroke("e1", "p1", 2), stroke("e2", "p1", 2)])
        .unwrap();
    st.delete_elements(&["e1".to_string()]).unwrap();
    let loaded = st.load_elements("p1").unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "e2");
    assert_eq!(st.count_elements("p1").unwrap(), 1);
}

#[test]
fn limit_elements_per_page() {
    let mut st = seeded();
    let elements: Vec<_> = (0..5001)
        .map(|i| stroke(&format!("e{i}"), "p1", 1))
        .collect();
    let err = st.upsert_elements(&elements).unwrap_err();
    assert!(matches!(err, StorageError::Limit(_)), "got {err:?}");
    assert_eq!(st.count_elements("p1").unwrap(), 0, "nothing written");
}

#[test]
fn a_recording_marker_is_exempt_from_the_page_element_limit() {
    let mut st = seeded();
    let full: Vec<_> = (0..5000).map(|i| stroke(&format!("e{i}"), "p1", 1)).collect();
    st.upsert_elements(&full).unwrap();
    let marker = |id: &str| {
        let mut m = stroke(id, "p1", 0);
        m.r#type = ElementType::Media;
        m.pen_style = None;
        m.image_url = Some("seg-0".into());
        m.content = Some(serde_json::json!({ "kind": "audio", "recording": { "unitId": "u1", "spans": [], "segments": [] } }));
        m
    };
    st.upsert_elements(&[marker("rec1")]).unwrap();
    // A marker on the page does not use up a place either: a second one fits.
    st.upsert_elements(&[marker("rec2")]).unwrap();
    assert_eq!(st.count_elements("p1").unwrap(), 5002);
    // Anything else is still refused, with the markers there.
    let err = st.upsert_elements(&[stroke("one-more", "p1", 1)]).unwrap_err();
    assert!(matches!(err, StorageError::Limit(_)), "got {err:?}");
    // A plain audio clip is not a marker.
    let mut clip = marker("clip");
    clip.content = Some(serde_json::json!({ "kind": "audio" }));
    assert!(matches!(st.upsert_elements(&[clip]).unwrap_err(), StorageError::Limit(_)));

    // Stored markers are not counted against the limit: (limit - 1) strokes and 2 markers still
    // take one more stroke, and refuse the next.
    let mut st = seeded();
    let almost: Vec<_> = (0..4999).map(|i| stroke(&format!("e{i}"), "p1", 1)).collect();
    st.upsert_elements(&almost).unwrap();
    st.upsert_elements(&[marker("rec1"), marker("rec2")]).unwrap();
    st.upsert_elements(&[stroke("last", "p1", 1)]).unwrap();
    assert_eq!(st.count_elements("p1").unwrap(), 5002);
    let err = st.upsert_elements(&[stroke("one-more", "p1", 1)]).unwrap_err();
    assert!(matches!(err, StorageError::Limit(_)), "got {err:?}");
}

#[test]
fn the_marker_cap_refuses_one_more_marker() {
    use mate_core::import::MAX_MARKERS_PER_PAGE;
    let mut st = seeded();
    let marker = |id: &str| {
        let mut m = stroke(id, "p1", 0);
        m.r#type = ElementType::Media;
        m.pen_style = None;
        m.content = Some(serde_json::json!({ "kind": "audio", "recording": {} }));
        m
    };
    let cap: Vec<_> = (0..MAX_MARKERS_PER_PAGE).map(|i| marker(&format!("rec{i}"))).collect();
    st.upsert_elements(&cap).unwrap();
    let err = st.upsert_elements(&[marker("one-more")]).unwrap_err();
    assert!(matches!(err, StorageError::Limit(_)), "got {err:?}");
    assert_eq!(st.count_elements("p1").unwrap(), MAX_MARKERS_PER_PAGE as i64, "nothing written");
    // A marker already there can still be changed (a transcript saved), and a stroke still fits.
    let mut again = marker("rec0");
    again.content = Some(serde_json::json!({ "kind": "audio", "recording": { "transcript": {} } }));
    st.upsert_elements(&[again]).unwrap();
    st.upsert_elements(&[stroke("ink", "p1", 1)]).unwrap();
    // A single batch past the cap is refused too.
    let mut st = seeded();
    let over: Vec<_> = (0..=MAX_MARKERS_PER_PAGE).map(|i| marker(&format!("r{i}"))).collect();
    assert!(matches!(st.upsert_elements(&over).unwrap_err(), StorageError::Limit(_)));
}

#[test]
fn limit_points_per_stroke() {
    let mut st = seeded();
    let elements = [stroke("ok", "p1", 2), stroke("huge", "p1", 50001)];
    let err = st.upsert_elements(&elements).unwrap_err();
    assert!(matches!(err, StorageError::Limit(_)), "got {err:?}");
    assert_eq!(st.count_elements("p1").unwrap(), 0, "nothing written");
}

#[test]
fn referenced_asset_ids_include_images_pdf_keys_and_soft_deleted() {
    let mut st = seeded();
    let mut img = stroke("i1", "p1", 0);
    img.r#type = ElementType::Image;
    img.image_url = Some("asset-a".into());
    let mut pdf = stroke("i2", "p1", 0);
    pdf.r#type = ElementType::Image;
    pdf.image_url = Some("asset-b".into());
    pdf.content = Some(serde_json::json!({ "pdfSourceKey": "asset-pdf" }));
    let mut gone = stroke("i3", "p1", 0);
    gone.r#type = ElementType::Image;
    gone.image_url = Some("asset-trashed".into());
    st.upsert_elements(&[img, pdf, gone, stroke("s", "p1", 2)]).unwrap();
    st.delete_elements(&["i3".to_string()]).unwrap();

    let ids = st.referenced_asset_ids().unwrap();
    let want: std::collections::HashSet<String> =
        ["asset-a", "asset-b", "asset-pdf", "asset-trashed"].iter().map(|s| s.to_string()).collect();
    assert_eq!(ids, want);
}

#[test]
fn asset_gc_only_when_unreferenced() {
    use mate_core::assets::{gc_unreferenced, save_sniffed};
    use mate_core::storage::EntityKind;
    use std::time::Duration;

    let dir = std::env::temp_dir().join(format!("mate-gc-pdf-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let pdf = save_sniffed(&dir, b"%PDF-1.7\n%stub\n").unwrap();

    let mut st = seeded();
    st.upsert_page(&common::page("p2", "sec1", None)).unwrap();
    let placement = |id: &str, page_id: &str| {
        let mut e = stroke(id, page_id, 1);
        e.r#type = ElementType::Image;
        e.pen_style = None;
        e.content = Some(serde_json::json!({ "pdfSourceKey": pdf.id, "pdfPageIndex": 1 }));
        e
    };
    st.upsert_elements(&[placement("a", "p1"), placement("b", "p2")]).unwrap();

    // Purging one of the two pages keeps the shared PDF source.
    st.soft_delete(EntityKind::Page, "p1").unwrap();
    st.purge(EntityKind::Page, "p1").unwrap();
    assert_eq!(gc_unreferenced(&dir, &st.referenced_asset_ids().unwrap(), Duration::ZERO), 0);
    assert!(pdf.path.exists());

    // Trashed but not purged: still referenced (the trash can be restored).
    st.soft_delete(EntityKind::Page, "p2").unwrap();
    assert_eq!(gc_unreferenced(&dir, &st.referenced_asset_ids().unwrap(), Duration::ZERO), 0);
    assert!(pdf.path.exists());

    // Purging the last page referencing it removes the file.
    st.purge(EntityKind::Page, "p2").unwrap();
    assert_eq!(gc_unreferenced(&dir, &st.referenced_asset_ids().unwrap(), Duration::ZERO), 1);
    assert!(!pdf.path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn referenced_asset_ids_follow_recording_segments() {
    let mut st = seeded();
    let mut rec = stroke("rec", "p1", 0);
    rec.r#type = ElementType::Media;
    rec.image_url = Some("seg-a".into());
    rec.content = Some(serde_json::json!({
        "kind": "audio",
        "recording": { "unitId": "u1", "spans": [], "segments": [
            { "assetId": "seg-a", "durationMs": 1, "mime": "audio/webm" },
            { "assetId": "seg-b", "durationMs": 1, "mime": "audio/webm" }
        ] }
    }));
    st.upsert_elements(&[rec]).unwrap();
    let want: std::collections::HashSet<String> = ["seg-a", "seg-b"].iter().map(|s| s.to_string()).collect();
    assert_eq!(st.referenced_asset_ids().unwrap(), want);
}

#[test]
fn unit_element_times_returns_live_elements_in_range_oldest_first() {
    use common::{page, section, unit};
    use mate_core::storage::EntityKind;
    let mut st = seeded();
    st.upsert_page(&page("p2", "sec1", None)).unwrap(); // trashed below
    st.upsert_unit(&unit("u2", Some("s1"))).unwrap();
    st.upsert_section(&section("sec2", "u2")).unwrap();
    st.upsert_page(&page("p3", "sec2", None)).unwrap(); // another unit
    let at = |id: &str, page_id: &str, created: &str| {
        let mut e = stroke(id, page_id, 2);
        e.created_at = created.into();
        e
    };
    let mut media = at("media", "p1", "2026-11-14T09:02:00.000Z");
    media.r#type = ElementType::Media;
    st.upsert_elements(&[
        at("late", "p1", "2026-11-14T09:05:00.000Z"),
        at("early", "p1", "2026-11-14T09:01:00.000Z"),
        at("before", "p1", "2026-11-14T08:59:59.999Z"),
        at("after", "p1", "2026-11-14T09:10:00.001Z"),
        at("edge", "p1", "2026-11-14T09:10:00.000Z"),
        at("gone", "p1", "2026-11-14T09:03:00.000Z"),
        at("trashed-page", "p2", "2026-11-14T09:04:00.000Z"),
        at("other-unit", "p3", "2026-11-14T09:04:00.000Z"),
        media,
    ])
    .unwrap();
    st.delete_elements(&["gone".to_string()]).unwrap();
    st.soft_delete(EntityKind::Page, "p2").unwrap();

    let got = st
        .unit_element_times("u1", "2026-11-14T09:00:00.000Z", "2026-11-14T09:10:00.000Z")
        .unwrap();
    let ids: Vec<&str> = got.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["early", "late", "edge"]);
    assert_eq!(got[0].page_id, "p1");
    assert_eq!(got[0].created_at, "2026-11-14T09:01:00.000Z");
}

/// Timing of the range query on a 10 000-element unit (run with `--ignored --nocapture`).
#[test]
#[ignore]
fn unit_element_times_timing_on_10000_elements() {
    use common::page;
    let mut st = seeded();
    for p in ["p2", "p3", "p4"] {
        st.upsert_page(&page(p, "sec1", None)).unwrap();
    }
    let pages = ["p1", "p2", "p3", "p4"];
    for (n, chunk) in (0..10_000).collect::<Vec<_>>().chunks(2500).enumerate() {
        let els: Vec<_> = chunk
            .iter()
            .map(|i| {
                let mut e = stroke(&format!("e{i}"), pages[n], 20);
                e.created_at = format!("2026-11-14T{:02}:{:02}:{:02}.000Z", 8 + i / 3600, (i / 60) % 60, i % 60);
                e
            })
            .collect();
        st.upsert_elements(&els).unwrap();
    }
    let start = std::time::Instant::now();
    let got = st
        .unit_element_times("u1", "2026-11-14T09:00:00.000Z", "2026-11-14T10:00:00.000Z")
        .unwrap();
    let took = start.elapsed();
    println!("unit_element_times: {} rows in {took:?}", got.len());
    assert_eq!(got.len(), 3601);
}

#[test]
fn unit_has_recordings_sees_only_live_recordings() {
    use common::{page, section, unit};
    use mate_core::storage::EntityKind;
    let mut st = seeded();
    assert!(!st.unit_has_recordings("u1").unwrap(), "empty unit");

    let media = |id: &str, page_id: &str, content: serde_json::Value| {
        let mut e = stroke(id, page_id, 0);
        e.r#type = ElementType::Media;
        e.content = Some(content);
        e
    };
    let recording = || serde_json::json!({
        "kind": "audio",
        "recording": { "unitId": "u1", "spans": [], "segments": [] }
    });

    // A plain audio element and a text box that mentions the word do not count.
    let mut text = stroke("text", "p1", 0);
    text.r#type = ElementType::TextBox;
    text.content = Some(serde_json::json!({ "html": "<p>\"recording\"</p>" }));
    st.upsert_elements(&[media("plain", "p1", serde_json::json!({ "kind": "audio" })), text]).unwrap();
    assert!(!st.unit_has_recordings("u1").unwrap(), "plain audio and text");

    // Another unit's recording.
    st.upsert_unit(&unit("u2", Some("s1"))).unwrap();
    st.upsert_section(&section("sec2", "u2")).unwrap();
    st.upsert_page(&page("p3", "sec2", None)).unwrap();
    st.upsert_elements(&[media("other", "p3", recording())]).unwrap();
    assert!(!st.unit_has_recordings("u1").unwrap(), "another unit");
    assert!(st.unit_has_recordings("u2").unwrap());

    // Deleted element, and one on a trashed page.
    st.upsert_page(&page("p2", "sec1", None)).unwrap();
    st.upsert_elements(&[media("gone", "p1", recording()), media("on-trash", "p2", recording())]).unwrap();
    st.delete_elements(&["gone".to_string()]).unwrap();
    st.soft_delete(EntityKind::Page, "p2").unwrap();
    assert!(!st.unit_has_recordings("u1").unwrap(), "deleted and trashed");

    st.upsert_elements(&[media("live", "p1", recording())]).unwrap();
    assert!(st.unit_has_recordings("u1").unwrap());
}
