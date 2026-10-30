//! Core domain model shared by storage, Tauri commands and the frontend mirror types.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::FormatItem;
use time::macros::format_description;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageMode {
    Canvas,
    Page,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PenStyle {
    Pen,
    Highlighter,
    FountainPen,
    Pencil,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ElementType {
    Stroke,
    Shape,
    Text,
    Image,
    TextBox,
    Codespace,
    Graph,
    Slide,
    Table,
    Media,
    Connector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackgroundType {
    Blank,
    Ruled,
    RuledNoMargin,
    Grid,
    GridUniform,
    DotGrid,
    Isometric,
    Hex,
    Cornell,
    Handwriting,
    Columns,
    Music,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeType {
    Rectangle,
    Circle,
    Ellipse,
    Triangle,
    Line,
    Arrow,
    Diamond,
    Pentagon,
    Hexagon,
    Star,
    Polygon,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub pressure: f64,
    pub timestamp: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tilt_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tilt_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundConfig {
    pub r#type: BackgroundType,
    pub spacing: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_inset_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_x: Option<f64>,
    pub dot_radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_image_url: Option<String>,
}

impl Default for BackgroundConfig {
    fn default() -> Self {
        Self {
            r#type: BackgroundType::Ruled,
            spacing: 40.0,
            grid_color: None,
            rule_inset_x: None,
            offset_x: None,
            dot_radius: 1.5,
            custom_image_url: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookshelf {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub order: i64,
    pub is_expanded: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub version: i64,
    /// The folder this bookshelf sits in; `None` is the Library root (schema v4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub is_favourite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bookshelf_id: Option<String>,
    pub is_expanded: bool,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub unit_id: String,
    pub title: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub order_index: i64,
    pub is_expanded: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub version: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub section_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub title: String,
    pub is_expanded: bool,
    pub is_favourite: bool,
    pub depth: i64,
    pub mode: PageMode,
    pub background_config: BackgroundConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_height: Option<f64>,
    pub thumbnail_version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub version: i64,
    /// Where an imported page came from (`source`, `sourcePageId`, `sourceFingerprint`); `None`
    /// for pages created in Mate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    pub page_id: String,
    pub r#type: ElementType,
    pub points: Vec<Point>,
    pub color: String,
    pub width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    pub is_highlighter: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pen_style: Option<PenStyle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape_type: Option<ShapeType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub box_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_group_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_write_id: Option<String>,
}

/// RFC 3339 with a fixed three-digit fraction and a `Z` offset (the value is always UTC).
const ISO_MILLIS: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z");

/// Current UTC time as RFC 3339 with millisecond precision, e.g. `2026-10-22T13:05:07.123Z`.
pub fn now_iso() -> String {
    format_iso(OffsetDateTime::now_utc())
}

/// Formats a UTC instant exactly like [`now_iso`], so the strings compare chronologically.
pub(crate) fn format_iso(at: OffsetDateTime) -> String {
    at.format(ISO_MILLIS)
        .expect("formatting a UTC timestamp cannot fail")
}

/// A fresh random (v4) UUID in hyphenated string form.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_element_type_round_trips() {
        let json = serde_json::to_string(&ElementType::Connector).unwrap();
        assert_eq!(json, "\"connector\"");
        let back: ElementType = serde_json::from_str("\"connector\"").unwrap();
        assert_eq!(back, ElementType::Connector);
    }
}
