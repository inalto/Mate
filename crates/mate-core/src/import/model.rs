//! The format-neutral document every importer produces and [`super::place_document`] consumes.
//!
//! Coordinates are in the source's own page units (points, pixels, ...): the placer scales each
//! page so its width maps onto Mate's 1080-unit sheet.

use serde::{Deserialize, Serialize};

use crate::model::{BackgroundConfig, BackgroundType, PageMode, PenStyle};

/// The note-taking apps Mate imports from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportSource {
    GoodNotes,
    Notability,
    OneNote,
    Freenotes,
    SamsungNotes,
}

impl ImportSource {
    /// The serde (kebab-case) name, e.g. `"good-notes"`; stable, used in fingerprints.
    pub fn as_str(self) -> &'static str {
        match self {
            ImportSource::GoodNotes => "good-notes",
            ImportSource::Notability => "notability",
            ImportSource::OneNote => "one-note",
            ImportSource::Freenotes => "freenotes",
            ImportSource::SamsungNotes => "samsung-notes",
        }
    }

    /// The app's display name, for messages.
    pub fn display_name(self) -> &'static str {
        match self {
            ImportSource::GoodNotes => "GoodNotes",
            ImportSource::Notability => "Notability",
            ImportSource::OneNote => "OneNote",
            ImportSource::Freenotes => "Freenotes",
            ImportSource::SamsungNotes => "Samsung Notes",
        }
    }
}

/// A whole source notebook.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportDocument {
    pub source: ImportSource,
    pub title: String,
    pub default_page_mode: PageMode,
    pub sections: Vec<ImportSection>,
}

impl ImportDocument {
    /// Number of pages over all sections.
    pub fn page_count(&self) -> usize {
        self.sections.iter().map(|s| s.pages.len()).sum()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportSection {
    pub source_id: String,
    pub title: String,
    pub pages: Vec<ImportPage>,
}

/// One source page; `width`/`height` in source units (the placer scales width to 1080).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ImportPage {
    pub source_id: String,
    pub title: Option<String>,
    pub width: f64,
    pub height: f64,
    pub background: ImportBackground,
    pub strokes: Vec<ImportStroke>,
    pub texts: Vec<ImportText>,
    pub images: Vec<ImportImage>,
    pub skipped: ImportSkipped,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImportPoint {
    pub x: f64,
    pub y: f64,
    /// 0..1; `None` → 0.5.
    pub pressure: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportStroke {
    pub points: Vec<ImportPoint>,
    /// `#rrggbb`.
    pub color: String,
    /// 0..1.
    pub opacity: f64,
    /// Source units.
    pub width: f64,
    pub is_highlighter: bool,
    pub pen_style: PenStyle,
    /// Paint order within the page (lower first); ties keep source order.
    pub z_index: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportText {
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub text: String,
    pub font_size: Option<f64>,
    /// `#rrggbb`.
    pub color: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportImage {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub bytes: Vec<u8>,
    /// What the source claimed; the asset store sniffs the bytes regardless.
    pub mime: Option<String>,
}

/// Page paper; spacings in source units.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum ImportBackground {
    #[default]
    Plain,
    Lined { spacing: f64 },
    Grid { spacing: f64 },
    Dotted { spacing: f64 },
}

impl ImportBackground {
    /// The Mate background, spacings multiplied by `scale` (a non-positive or non-finite
    /// spacing falls back to the default one).
    pub fn to_config(self, scale: f64) -> BackgroundConfig {
        let d = BackgroundConfig::default();
        let (r#type, spacing) = match self {
            ImportBackground::Plain => (BackgroundType::Blank, None),
            ImportBackground::Lined { spacing } => (BackgroundType::Ruled, Some(spacing)),
            ImportBackground::Grid { spacing } => (BackgroundType::Grid, Some(spacing)),
            ImportBackground::Dotted { spacing } => (BackgroundType::DotGrid, Some(spacing)),
        };
        let spacing = spacing
            .map(|s| s * scale)
            .filter(|s| s.is_finite() && *s >= 4.0 && *s <= 1080.0)
            .unwrap_or(d.spacing);
        BackgroundConfig { r#type, spacing, ..d }
    }
}

/// Source items Mate does not import, counted for the report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ImportSkipped {
    pub tables: u32,
    pub shapes: u32,
    pub other: u32,
}
