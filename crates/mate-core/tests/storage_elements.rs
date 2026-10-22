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
