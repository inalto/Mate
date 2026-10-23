//! Places an [`ImportDocument`] into the notebook: a new unit or an existing one.
//!
//! Every source page is scaled so its width maps onto Mate's 1080-unit sheet (`s = 1080 /
//! width`; `page_width` stays `None`, `page_height = height * s`); coordinates are clamped to the
//! page, pressure defaults to 0.5 and points get synthetic timestamps 10 ms apart. A page whose
//! width gives an unusable scale is imported unscaled (with a warning); page heights are capped
//! at [`MAX_PAGE_HEIGHT`]; an element with a non-finite coordinate or size is skipped and counted. Each page and
//! its elements are written in one transaction, so a failure part-way keeps the pages already
//! placed (the failure becomes a report warning); a failure before any page landed rolls back
//! what this call created (the new unit or new sections, and stored images).
//!
//! Pages carry `import_metadata.sourceFingerprint` (file hash + source page id): placing the
//! same file into a unit that already holds one of its pages skips that page.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::fingerprint::{element_fingerprint, fnv1a64, page_fingerprint};
use super::model::{ImportDocument, ImportPage};
use super::MAX_PAGES_PER_IMPORT;
use crate::assets;
use crate::model::{Element, ElementType, Page, Point, Section, Unit, new_id, now_iso};
use crate::storage::elements::{MAX_ELEMENTS_PER_PAGE, MAX_POINTS_PER_STROKE};
use crate::storage::{EntityKind, Result, Storage, StorageError};

/// Width of Mate's page sheet; every imported page is scaled to it.
pub const SHEET_WIDTH: f64 = 1080.0;
/// Page height used when the source page has no usable height.
const DEFAULT_SHEET_HEIGHT: f64 = 1440.0;
/// Tallest page an import creates (20 sheet widths); taller sources are cut off at it.
pub const MAX_PAGE_HEIGHT: f64 = 20.0 * SHEET_WIDTH;
/// Scales outside this range (source pages narrower than ~0.1 or wider than ~10 million units)
/// are treated as a missing width: the page is imported unscaled.
const MIN_SCALE: f64 = 1e-4;
const MAX_SCALE: f64 = 1e4;
const DEFAULT_PRESSURE: f64 = 0.5;
/// Synthetic time between consecutive points of imported ink, in ms.
const POINT_INTERVAL_MS: f64 = 10.0;
const DEFAULT_SECTION_COLOR: &str = "#4a5d4e";
const DEFAULT_TEXT_SIZE: f64 = 21.77;
const MIN_FONT_SIZE: f64 = 4.0;
const MAX_FONT_SIZE: f64 = 400.0;
const LINE_HEIGHT: f64 = 1.4;

/// Where the imported pages go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PlaceTarget {
    /// A new unit placed after the existing ones; `title` (or the document's) names it.
    NewUnit { title: Option<String> },
    /// An existing unit: pages already imported from the same file are skipped.
    ExistingUnit {
        #[serde(rename = "unitId")]
        unit_id: String,
    },
}

/// What a placement did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub unit_id: String,
    /// Sections this import created, in order.
    pub section_ids: Vec<String>,
    pub pages_imported: usize,
    /// Pages already present in the target unit (same file, same source page).
    pub pages_skipped_duplicate: usize,
    /// Pages past [`MAX_PAGES_PER_IMPORT`].
    pub pages_skipped_limit: usize,
    pub strokes: usize,
    pub texts: usize,
    pub images: usize,
    /// Elements past the per-page limit, and strokes with too many points.
    pub elements_skipped_limit: usize,
    /// Elements with non-finite coordinates or sizes (never written).
    pub elements_skipped_invalid: usize,
    pub tables_skipped: usize,
    pub shapes_skipped: usize,
    /// Human-readable notes: unreadable images, items not imported, an early stop.
    pub warnings: Vec<String>,
    /// Technical details behind the warnings (e.g. the storage error that stopped the import),
    /// for logs rather than the user.
    pub details: Vec<String>,
}

/// Places `doc` into `target`. `file_fingerprint` identifies the source file (16 hex digits,
/// [`super::file_fingerprint`]; any other string is hashed). Images are stored in `assets_dir`.
pub fn place_document(
    storage: &mut Storage,
    doc: &ImportDocument,
    target: PlaceTarget,
    assets_dir: &Path,
    file_fingerprint: &str,
) -> Result<ImportReport> {
    if doc.page_count() == 0 {
        return Err(StorageError::Limit("the file has no pages to import".into()));
    }
    let file_fp = u64::from_str_radix(file_fingerprint, 16)
        .unwrap_or_else(|_| fnv1a64(file_fingerprint.as_bytes()));
    let tree = storage.list_tree()?;
    let now = now_iso();

    let (unit_id, new_unit) = match target {
        PlaceTarget::NewUnit { title } => {
            let title = title
                .map(|t| t.trim().to_owned())
                .filter(|t| !t.is_empty())
                .or_else(|| Some(doc.title.trim().to_owned()).filter(|t| !t.is_empty()))
                .unwrap_or_else(|| format!("{} import", doc.source.display_name()));
            let id = new_id();
            storage.upsert_unit(&Unit {
                id: id.clone(),
                title,
                icon: None,
                color: None,
                is_favourite: false,
                bookshelf_id: None,
                is_expanded: true,
                order_index: tree.units.len() as i64,
                created_at: now.clone(),
                updated_at: now.clone(),
                deleted_at: None,
                version: 0,
            })?;
            (id, true)
        }
        PlaceTarget::ExistingUnit { unit_id } => {
            if !tree.units.iter().any(|u| u.id == unit_id) {
                return Err(StorageError::NotFound(format!("unit {unit_id}")));
            }
            (unit_id, false)
        }
    };

    let sections: HashSet<&str> = tree
        .sections
        .iter()
        .filter(|s| s.unit_id == unit_id)
        .map(|s| s.id.as_str())
        .collect();
    let mut placer = Placer {
        doc,
        assets_dir,
        file_fp,
        now,
        unit_id: unit_id.clone(),
        next_section_order: sections.len() as i64,
        existing: HashMap::new(),
        next_page_order: HashMap::new(),
        created_sections: Vec::new(),
        filled_sections: HashSet::new(),
        report: ImportReport { unit_id: unit_id.clone(), ..ImportReport::default() },
    };
    for p in tree.pages.iter().filter(|p| sections.contains(p.section_id.as_str())) {
        if p.parent_id.is_none() {
            let next = placer.next_page_order.entry(p.section_id.clone()).or_default();
            *next = (*next).max(p.order_index + 1);
        }
        if let Some(fp) = p
            .import_metadata
            .as_ref()
            .and_then(|m| m.get("sourceFingerprint"))
            .and_then(|f| f.as_str())
        {
            placer.existing.insert(fp.to_owned(), p.section_id.clone());
        }
    }

    let outcome = placer.place_all(storage);
    let mut report = std::mem::take(&mut placer.report);
    // Sections created but left empty (the failing page's, or all-duplicate ones) go away.
    let empty: Vec<&String> = placer
        .created_sections
        .iter()
        .filter(|s| !placer.filled_sections.contains(*s))
        .collect();
    match outcome {
        Err(e) if report.pages_imported == 0 => {
            if new_unit {
                let _ = storage.purge(EntityKind::Unit, &unit_id);
            } else {
                for s in &placer.created_sections {
                    let _ = storage.purge(EntityKind::Section, s);
                }
            }
            Err(e)
        }
        outcome => {
            for s in empty {
                let _ = storage.purge(EntityKind::Section, s);
            }
            report.section_ids.retain(|s| placer.filled_sections.contains(s));
            if let Err(e) = outcome {
                let n = report.pages_imported;
                report.warnings.push(format!(
                    "The import stopped after {n} {} because a page could not be saved.",
                    if n == 1 { "page" } else { "pages" }
                ));
                report.details.push(format!("page write failed: {e}"));
            }
            Ok(report)
        }
    }
}

struct Placer<'a> {
    doc: &'a ImportDocument,
    assets_dir: &'a Path,
    file_fp: u64,
    now: String,
    unit_id: String,
    next_section_order: i64,
    /// Page fingerprint → section holding it, for pages already in the unit.
    existing: HashMap<String, String>,
    /// Section id → order index for its next top-level page (max existing + 1).
    next_page_order: HashMap<String, i64>,
    created_sections: Vec<String>,
    /// Sections that received a page during this call.
    filled_sections: HashSet<String>,
    report: ImportReport,
}

/// One page ready to write, with the assets stored for it.
struct BuiltPage {
    page: Page,
    elements: Vec<Element>,
    assets: Vec<String>,
    strokes: usize,
    texts: usize,
    images: usize,
}

impl Placer<'_> {
    fn place_all(&mut self, storage: &mut Storage) -> Result<()> {
        let mut considered = 0usize;
        let mut other_skipped: u64 = 0;
        for (si, sec) in self.doc.sections.iter().enumerate() {
            let mut section_id: Option<String> = None;
            for (pi, page) in sec.pages.iter().enumerate() {
                if considered >= MAX_PAGES_PER_IMPORT {
                    self.report.pages_skipped_limit += 1;
                    continue;
                }
                considered += 1;
                let fp = page_fingerprint(self.file_fp, &page.source_id);
                if let Some(sid) = self.existing.get(&fp) {
                    self.report.pages_skipped_duplicate += 1;
                    section_id.get_or_insert_with(|| sid.clone());
                    continue;
                }
                let sid = match &section_id {
                    Some(s) => s.clone(),
                    None => {
                        let s = self.create_section(storage, &sec.title, si)?;
                        section_id = Some(s.clone());
                        s
                    }
                };
                let order = self.next_page_order.get(&sid).copied().unwrap_or(0);
                let built = self.build_page(page, pi, &sid, order, &fp);
                if let Err(e) = storage.upsert_page_with_elements(&built.page, &built.elements) {
                    for id in &built.assets {
                        assets::delete_asset(self.assets_dir, id);
                    }
                    return Err(e);
                }
                self.next_page_order.insert(sid.clone(), order + 1);
                self.filled_sections.insert(sid.clone());
                self.existing.insert(fp, sid);
                let r = &mut self.report;
                r.pages_imported += 1;
                r.strokes += built.strokes;
                r.texts += built.texts;
                r.images += built.images;
                r.tables_skipped += page.skipped.tables as usize;
                r.shapes_skipped += page.skipped.shapes as usize;
                other_skipped += u64::from(page.skipped.other);
            }
        }
        if self.report.tables_skipped > 0 {
            self.report
                .warnings
                .push(format!("{} tables were not imported.", self.report.tables_skipped));
        }
        if self.report.shapes_skipped > 0 {
            self.report
                .warnings
                .push(format!("{} shapes were not imported.", self.report.shapes_skipped));
        }
        if other_skipped > 0 {
            self.report.warnings.push(format!("{other_skipped} other items were not imported."));
        }
        if self.report.pages_skipped_limit > 0 {
            self.report.warnings.push(format!(
                "Only the first {MAX_PAGES_PER_IMPORT} pages were imported; {} were left out.",
                self.report.pages_skipped_limit
            ));
        }
        if self.report.elements_skipped_invalid > 0 {
            self.report.warnings.push(format!(
                "{} items were left out because their position or size was unreadable.",
                self.report.elements_skipped_invalid
            ));
        }
        if self.report.elements_skipped_limit > 0 {
            self.report.warnings.push(format!(
                "{} items were left out because a page or stroke was too large.",
                self.report.elements_skipped_limit
            ));
        }
        Ok(())
    }

    fn create_section(&mut self, storage: &mut Storage, title: &str, index: usize) -> Result<String> {
        let id = new_id();
        let title = title.trim();
        storage.upsert_section(&Section {
            id: id.clone(),
            unit_id: self.unit_id.clone(),
            title: if title.is_empty() { format!("Section {}", index + 1) } else { title.to_owned() },
            color: DEFAULT_SECTION_COLOR.into(),
            icon: None,
            order_index: self.next_section_order,
            is_expanded: true,
            created_at: self.now.clone(),
            updated_at: self.now.clone(),
            deleted_at: None,
            version: 0,
        })?;
        self.next_section_order += 1;
        self.created_sections.push(id.clone());
        self.report.section_ids.push(id.clone());
        Ok(id)
    }

    /// The Mate page and elements for source page `page` (`index` within its section). Images
    /// are stored on the way; one that cannot be stored becomes a warning.
    fn build_page(
        &mut self,
        page: &ImportPage,
        index: usize,
        section_id: &str,
        order_index: i64,
        fingerprint: &str,
    ) -> BuiltPage {
        let source = self.doc.source;
        let scale = SHEET_WIDTH / page.width;
        let scale = if scale.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&scale) {
            scale
        } else {
            self.report.warnings.push(format!(
                "Page {} of \"{}\" had no usable width; it was imported unscaled.",
                index + 1,
                page.title.as_deref().unwrap_or(&page.source_id)
            ));
            1.0
        };
        let page_height = Some(page.height * scale)
            .filter(|h| h.is_finite() && *h > 0.0)
            .map(|h| h.clamp(1.0, MAX_PAGE_HEIGHT));
        let max_y = page_height.unwrap_or(DEFAULT_SHEET_HEIGHT);
        let page_id = new_id();
        let title = page
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Page {}", index + 1));
        let mate_page = Page {
            id: page_id.clone(),
            section_id: section_id.to_owned(),
            parent_id: None,
            title,
            is_expanded: false,
            is_favourite: false,
            depth: 0,
            mode: self.doc.default_page_mode.clone(),
            background_config: page.background.to_config(scale),
            page_width: None,
            page_height,
            thumbnail_version: 0,
            icon: None,
            order_index,
            created_at: self.now.clone(),
            updated_at: self.now.clone(),
            deleted_at: None,
            version: 0,
            import_metadata: Some(json!({
                "source": source,
                "sourcePageId": page.source_id,
                "sourceFingerprint": fingerprint,
            })),
        };

        // Scaled, clamped coordinates; `None` when not finite (the element is then skipped).
        let px = |x: f64| Some(x * scale).filter(|v| v.is_finite()).map(|v| v.clamp(0.0, SHEET_WIDTH));
        let py = |y: f64| Some(y * scale).filter(|v| v.is_finite()).map(|v| v.clamp(0.0, max_y));
        let fp = |i: usize| element_fingerprint(source, &page.source_id, i);
        let cap = MAX_ELEMENTS_PER_PAGE as usize;
        let mut out = BuiltPage {
            page: mate_page,
            elements: Vec::new(),
            assets: Vec::new(),
            strokes: 0,
            texts: 0,
            images: 0,
        };
        let base = |page_id: &str, r#type: ElementType, x: f64, y: f64| Element {
            id: new_id(),
            page_id: page_id.to_owned(),
            r#type,
            points: vec![point(x, y, DEFAULT_PRESSURE, 0.0)],
            color: "#000000".into(),
            width: 1.0,
            height: None,
            is_highlighter: false,
            pen_style: None,
            image_url: None,
            shape_type: None,
            fill_color: None,
            box_width: None,
            box_height: None,
            content: None,
            classification: None,
            ui_group_id: None,
            created_at: self.now.clone(),
            updated_at: self.now.clone(),
            deleted_at: None,
            version: 0,
            last_write_id: None,
        };
        let n_strokes = page.strokes.len();
        let n_texts = page.texts.len();

        // Images first (they are usually backgrounds), then ink in z order, then text.
        for (i, img) in page.images.iter().enumerate() {
            let (w, h) = (img.width * scale, img.height * scale);
            let (Some(x), Some(y)) = (px(img.x), py(img.y)) else {
                self.report.elements_skipped_invalid += 1;
                continue;
            };
            if !(w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0) {
                self.report.elements_skipped_invalid += 1;
                continue;
            }
            let (w, h) = (w.min(SHEET_WIDTH), h.min(max_y));
            if out.elements.len() >= cap {
                self.report.elements_skipped_limit += 1;
                continue;
            }
            let info = match assets::save_sniffed(self.assets_dir, &img.bytes) {
                Ok(info) => info,
                Err(e) => {
                    self.report
                        .warnings
                        .push(format!("An image on page {} could not be imported: {e}", index + 1));
                    continue;
                }
            };
            out.assets.push(info.id.clone());
            let mut e = base(&page_id, ElementType::Image, x, y);
            e.width = w;
            e.height = Some(h);
            e.image_url = Some(info.id);
            e.content = Some(json!({ "importFingerprint": fp(n_strokes + n_texts + i) }));
            out.elements.push(e);
            out.images += 1;
        }

        let mut order: Vec<usize> = (0..n_strokes).collect();
        order.sort_by_key(|&i| page.strokes[i].z_index);
        let mut clock = 0.0;
        for i in order {
            let s = &page.strokes[i];
            if s.points.len() > MAX_POINTS_PER_STROKE {
                self.report.elements_skipped_limit += 1;
                continue;
            }
            let start = clock;
            let points: Option<Vec<Point>> = s
                .points
                .iter()
                .map(|p| {
                    clock += POINT_INTERVAL_MS;
                    let pressure = p
                        .pressure
                        .filter(|v| v.is_finite())
                        .map_or(DEFAULT_PRESSURE, |v| v.clamp(0.0, 1.0));
                    Some(point(px(p.x)?, py(p.y)?, pressure, clock))
                })
                .collect();
            let Some(points) = points else {
                clock = start;
                self.report.elements_skipped_invalid += 1;
                continue;
            };
            if points.is_empty() {
                continue;
            }
            if out.elements.len() >= cap {
                self.report.elements_skipped_limit += 1;
                continue;
            }
            let width = Some(s.width * scale).filter(|w| w.is_finite() && *w > 0.0).unwrap_or(2.0);
            let mut e = base(&page_id, ElementType::Stroke, 0.0, 0.0);
            e.points = points;
            e.color = normalize_color(&s.color);
            e.width = width.min(500.0);
            e.is_highlighter = s.is_highlighter;
            e.pen_style = Some(s.pen_style.clone());
            e.content = Some(json!({ "importFingerprint": fp(i) }));
            out.elements.push(e);
            out.strokes += 1;
        }

        for (i, t) in page.texts.iter().enumerate() {
            let text = t.text.trim_end();
            if text.trim().is_empty() {
                continue;
            }
            let (Some(x), Some(y)) = (px(t.x), py(t.y)) else {
                self.report.elements_skipped_invalid += 1;
                continue;
            };
            if out.elements.len() >= cap {
                self.report.elements_skipped_limit += 1;
                continue;
            }
            let font_size = t
                .font_size
                .map(|f| f * scale)
                .filter(|f| f.is_finite())
                .map_or(DEFAULT_TEXT_SIZE, |f| f.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE));
            let box_width = t
                .width
                .map(|w| w * scale)
                .filter(|w| w.is_finite() && *w > 0.0)
                .unwrap_or(SHEET_WIDTH - x)
                .clamp(40.0, SHEET_WIDTH);
            let lines = text.lines().count().max(1) as f64;
            let color = normalize_color(&t.color);
            let mut e = base(&page_id, ElementType::TextBox, x, y);
            e.color = color.clone();
            e.box_width = Some(box_width);
            e.box_height = Some((lines * font_size * LINE_HEIGHT + 8.0).ceil());
            e.content = Some(json!({
                "contentHtml": text_html(text),
                "rawContent": text,
                "textAttributes": {
                    "fontFamily": "sans",
                    "fontSize": font_size,
                    "color": color,
                    "align": "left",
                },
                "importFingerprint": fp(n_strokes + i),
            }));
            out.elements.push(e);
            out.texts += 1;
        }
        out
    }
}

fn point(x: f64, y: f64, pressure: f64, timestamp: f64) -> Point {
    Point { x, y, pressure, timestamp, tilt_x: None, tilt_y: None, width: None }
}

/// `#rrggbb` (lower case) from `#rgb`/`#rrggbb`/`#rrggbbaa`; anything else is black.
fn normalize_color(c: &str) -> String {
    let hex = c.trim().trim_start_matches('#');
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return "#000000".into();
    }
    match hex.len() {
        3 => hex.chars().flat_map(|ch| [ch, ch]).fold(String::from("#"), |mut s, ch| {
            s.push(ch.to_ascii_lowercase());
            s
        }),
        6 | 8 => format!("#{}", hex[..6].to_ascii_lowercase()),
        _ => "#000000".into(),
    }
}

/// One `<p>` per line, HTML-escaped (an empty line keeps its height with `<br>`).
fn text_html(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.is_empty() {
                return "<p><br></p>".to_owned();
            }
            let mut p = String::from("<p>");
            for ch in line.chars() {
                match ch {
                    '&' => p.push_str("&amp;"),
                    '<' => p.push_str("&lt;"),
                    '>' => p.push_str("&gt;"),
                    '"' => p.push_str("&quot;"),
                    '\'' => p.push_str("&#39;"),
                    c => p.push(c),
                }
            }
            p.push_str("</p>");
            p
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_and_html() {
        assert_eq!(normalize_color("#ABC"), "#aabbcc");
        assert_eq!(normalize_color("#112233ff"), "#112233");
        assert_eq!(normalize_color("red"), "#000000");
        assert_eq!(text_html("a<b\n\nc"), "<p>a&lt;b</p><p><br></p><p>c</p>");
    }
}
