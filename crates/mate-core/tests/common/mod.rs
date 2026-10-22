//! Fixture builders shared by the storage integration tests.
#![allow(dead_code)]

use mate_core::model::{
    BackgroundConfig, Bookshelf, Element, ElementType, Page, PageMode, PenStyle, Point, Section,
    Unit, now_iso,
};
use mate_core::storage::Storage;

pub fn shelf(id: &str) -> Bookshelf {
    let now = now_iso();
    Bookshelf {
        id: id.into(),
        title: format!("Shelf {id}"),
        icon: None,
        color: Some("#336699".into()),
        order: 0,
        is_expanded: true,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        version: 0,
    }
}

pub fn unit(id: &str, bookshelf_id: Option<&str>) -> Unit {
    let now = now_iso();
    Unit {
        id: id.into(),
        title: format!("Unit {id}"),
        icon: None,
        color: None,
        is_favourite: false,
        bookshelf_id: bookshelf_id.map(Into::into),
        is_expanded: true,
        order_index: 0,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        version: 0,
    }
}

pub fn section(id: &str, unit_id: &str) -> Section {
    let now = now_iso();
    Section {
        id: id.into(),
        unit_id: unit_id.into(),
        title: format!("Section {id}"),
        color: "#ff8800".into(),
        icon: None,
        order_index: 0,
        is_expanded: false,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        version: 0,
    }
}

pub fn page(id: &str, section_id: &str, parent_id: Option<&str>) -> Page {
    let now = now_iso();
    Page {
        id: id.into(),
        section_id: section_id.into(),
        parent_id: parent_id.map(Into::into),
        title: format!("Page {id}"),
        is_expanded: false,
        is_favourite: false,
        depth: if parent_id.is_some() { 1 } else { 0 },
        mode: PageMode::Canvas,
        background_config: BackgroundConfig::default(),
        page_width: None,
        page_height: None,
        thumbnail_version: 0,
        icon: None,
        order_index: 0,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        version: 0,
    }
}

pub fn stroke(id: &str, page_id: &str, n_points: usize) -> Element {
    let now = now_iso();
    Element {
        id: id.into(),
        page_id: page_id.into(),
        r#type: ElementType::Stroke,
        points: (0..n_points)
            .map(|i| Point {
                x: i as f64,
                y: i as f64 * 2.0,
                pressure: 0.5,
                timestamp: i as f64,
                tilt_x: None,
                tilt_y: None,
                width: None,
            })
            .collect(),
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
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        version: 0,
        last_write_id: None,
    }
}

/// Shelf `s1` → unit `u1` → section `sec1` → page `p1`.
pub fn seeded() -> Storage {
    let mut st = Storage::open_in_memory().expect("open in-memory db");
    st.upsert_bookshelf(&shelf("s1")).unwrap();
    st.upsert_unit(&unit("u1", Some("s1"))).unwrap();
    st.upsert_section(&section("sec1", "u1")).unwrap();
    st.upsert_page(&page("p1", "sec1", None)).unwrap();
    st
}
