//! Page-mode geometry: page sizes and the vertical stack of pages separated by gaps.

use serde::{Deserialize, Serialize};

pub const PAGE_WIDTH: f64 = 1080.0;
pub const PAGE_HEIGHT: f64 = 1440.0;
pub const PAGE_GAP: f64 = 24.0;
pub const PAGE_BORDER_RADIUS: f64 = 12.0;
pub const PAGE_MODE_TOP_MARGIN: f64 = 64.0;
pub const PAGE_MODE_SIDE_MARGIN: f64 = 56.0;
pub const PAGE_MODE_BOTTOM_MARGIN: f64 = 1200.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AspectPreset {
    A4,
    Letter,
    #[serde(rename = "16:9")]
    Wide16x9,
    #[serde(rename = "4:3")]
    Standard4x3,
    Square,
}

/// Page size `(width, height)` for a preset: portrait is `PAGE_WIDTH` wide, landscape swaps.
pub fn preset_size(p: AspectPreset, landscape: bool) -> (f64, f64) {
    let height = match p {
        AspectPreset::A4 => 1528.0,
        AspectPreset::Letter => 1397.0,
        AspectPreset::Wide16x9 => 1920.0,
        AspectPreset::Standard4x3 => 1440.0,
        AspectPreset::Square => PAGE_WIDTH,
    };
    if landscape {
        (height, PAGE_WIDTH)
    } else {
        (PAGE_WIDTH, height)
    }
}

/// Vertical distance from one page top to the next page top.
pub fn page_stride(h: f64) -> f64 {
    h + PAGE_GAP
}

/// Index of the page slot (page plus its trailing gap) containing document `y`.
pub fn page_index_at(y: f64, h: f64) -> i64 {
    (y / page_stride(h)).floor() as i64
}

/// Document `y` of the top edge of page `i`.
pub fn page_top_at_index(i: i64, h: f64) -> f64 {
    i as f64 * page_stride(h)
}

/// Whether `(x, y)` lies on a page: not in a gap, not left, right or above the stack.
pub fn is_point_inside_page(x: f64, y: f64, w: f64, h: f64) -> bool {
    if x < 0.0 || x > w || y < 0.0 {
        return false;
    }
    let local_y = y - page_top_at_index(page_index_at(y, h), h);
    local_y <= h
}
