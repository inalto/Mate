use mate_core::model::{BackgroundConfig, BackgroundType, Element, ElementType, PenStyle, Point};

fn point(x: f64, y: f64, t: f64) -> Point {
    Point {
        x,
        y,
        pressure: 0.5,
        timestamp: t,
        tilt_x: None,
        tilt_y: None,
        width: Some(2.5),
    }
}

#[test]
fn element_round_trips_json() {
    let element = Element {
        id: "e1".into(),
        page_id: "p1".into(),
        r#type: ElementType::Stroke,
        points: vec![point(1.0, 2.0, 10.0), point(3.0, 4.0, 20.0)],
        color: "#000000".into(),
        width: 3.0,
        height: None,
        is_highlighter: false,
        pen_style: Some(PenStyle::FountainPen),
        image_url: None,
        shape_type: None,
        fill_color: None,
        box_width: None,
        box_height: None,
        content: None,
        classification: None,
        ui_group_id: None,
        created_at: "2026-10-22T13:05:07.123Z".into(),
        updated_at: "2026-10-22T13:05:07.123Z".into(),
        deleted_at: None,
        version: 1,
        last_write_id: None,
    };

    let json = serde_json::to_string(&element).unwrap();
    assert!(json.contains(r#""penStyle":"fountain-pen""#), "{json}");
    assert!(json.contains(r#""type":"stroke""#), "{json}");
    assert!(json.contains(r#""pageId":"p1""#), "{json}");
    assert!(
        !json.contains("imageUrl"),
        "None fields are skipped: {json}"
    );

    let back: Element = serde_json::from_str(&json).unwrap();
    assert_eq!(back, element);
}

#[test]
fn background_default_is_ruled_40() {
    let bg = BackgroundConfig::default();
    assert_eq!(bg.r#type, BackgroundType::Ruled);
    assert_eq!(bg.spacing, 40.0);
    assert_eq!(bg.dot_radius, 1.5);
    assert_eq!(bg.grid_color, None);
    assert_eq!(bg.custom_image_url, None);
}

#[test]
fn now_iso_is_utc_with_millis() {
    let s = mate_core::model::now_iso();
    assert_eq!(s.len(), "2026-10-22T13:05:07.123Z".len(), "{s}");
    assert!(s.ends_with('Z'), "{s}");
    assert_eq!(&s[19..20], ".", "{s}");
    time::OffsetDateTime::parse(&s, &time::format_description::well_known::Rfc3339).unwrap();
}

#[test]
fn new_id_is_uuid() {
    let id = mate_core::model::new_id();
    assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
    assert_ne!(id, mate_core::model::new_id());
}
