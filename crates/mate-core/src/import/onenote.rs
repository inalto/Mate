//! OneNote (`.one` sections, `.onepkg` cabinet notebooks): MS-ONESTORE revision stores, read with
//! the `onenote_parser` crate (MPL-2.0, used unmodified).
//!
//! Two layers:
//!
//! - **Extraction** (this module): `onenote_parser` → small view structs ([`adapter::SectionView`]
//!   and friends) holding raw source values (HIMETRIC ink units, half-inch layout units, BGR
//!   colours). The crate parses untrusted input and has a few internal `panic!`s, so the crate call
//!   *and* the walk over its lazily read data run under `catch_unwind`; a panic becomes
//!   [`ImportError::Corrupt`].
//! - **Mapping** ([`adapter::from_sections`]): views → [`ImportDocument`], pure and unit-tested
//!   with hand-built views (the crate has no public constructors and no `.one` encoder exists).
//!
//! Units: ink coordinates are 0.01 mm (HIMETRIC) → px at 96 dpi (`× 96 / 2540`); outline, image
//! and ink-container offsets are half-inches → px (`× 48`). Pages are 1080 px wide (wider when the
//! content reaches further), so the placer's scale is usually 1.

use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::panic::{AssertUnwindSafe, catch_unwind};

use onenote_parser::contents::{Content, Image, Ink, Outline, OutlineItem, RichText};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::section::{Section, SectionEntry};
use onenote_parser::{FileSystem, Parser};
use typed_path::{PathType, TypedPath, TypedPathBuf};

use super::{
    CAB_MAGIC, ImportBudget, ImportDocument, ImportError, ImportLimits, ImportSkipped,
    check_deadline,
};
use adapter::{ImageView, InkView, OutlineView, PageView, SectionView, StrokeView};

/// Longest crate error message carried into [`ImportError::Corrupt`].
const MAX_DETAIL_CHARS: usize = 160;
const MIB: u64 = 1024 * 1024;
/// Most files a `.onepkg` may hold (real exports hold a `.onetoc2` and tens of sections).
pub const MAX_ONEPKG_ENTRIES: usize = 512;
/// Uncompressed size of one CAB data block (CFDATA): 32 KiB for MSZIP and LZX (the CAB spec's
/// maximum, and what `cab`'s writer produces). A hostile file with up-to-64 KiB blocks reaches at
/// most twice the work budget.
const CAB_BLOCK_BYTES: u64 = 32_768;
/// Decompression work allowed for a `.onepkg`, as a multiple of `max_unzipped_bytes`.
const CAB_WORK_FACTOR: u64 = 4;

pub fn parse(
    bytes: &[u8],
    filename: &str,
    limits: &ImportLimits,
) -> Result<ImportDocument, ImportError> {
    check_deadline(limits)?;
    if bytes.len() as u64 > limits.max_file_bytes {
        return Err(ImportError::Limit(format!(
            "OneNote files over {} MiB are not imported",
            limits.max_file_bytes / MIB
        )));
    }
    let base = file_base_name(filename);
    let (title, sections) = if bytes.starts_with(CAB_MAGIC) {
        check_cabinet(bytes, limits)?;
        let title = strip_suffix_ci(base, ".onepkg").to_owned();
        let sections = guarded("the OneNote notebook", || {
            let notebook = Parser::new_with_fs(MemFs { data: bytes })
                .parse_package(TypedPath::new("notebook.onepkg", PathType::Unix))
                .map_err(|e| crate_error("the OneNote notebook could not be read", &e))?;
            let mut budget = Budget::new(limits);
            let mut out = Vec::new();
            extract_entries(notebook.entries(), "", limits, &mut budget, &mut out)?;
            Ok(out)
        })?;
        if sections.is_empty() {
            return Err(ImportError::Corrupt(
                "none of the notebook's sections could be read".into(),
            ));
        }
        (title, sections)
    } else {
        let name = if base.is_empty() { "section.one" } else { base };
        let sections = guarded("the OneNote section", || {
            let section = Parser::new_with_fs(MemFs { data: &[] })
                .parse_section_buffer(bytes, TypedPath::new(name, PathType::Windows))
                .map_err(|e| crate_error("the OneNote section could not be read", &e))?;
            let mut budget = Budget::new(limits);
            Ok(vec![extract_section(&section, "", limits, &mut budget)?])
        })?;
        let title = strip_suffix_ci(&sections[0].title, ".one").to_owned();
        (title, sections)
    };
    Ok(adapter::from_sections(&title, sections, limits.max_pages))
}

/// Runs `f`, turning a panic inside `onenote_parser` (or `cab`) into `Corrupt`.
fn guarded<T>(what: &str, f: impl FnOnce() -> Result<T, ImportError>) -> Result<T, ImportError> {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(_) => Err(ImportError::Corrupt(format!(
            "{what} has an invalid internal structure"
        ))),
    }
}

fn crate_error(what: &str, e: &dyn std::fmt::Display) -> ImportError {
    let detail: String = e.to_string().chars().take(MAX_DETAIL_CHARS).collect();
    if detail.trim().is_empty() {
        ImportError::Corrupt(what.to_owned())
    } else {
        ImportError::Corrupt(format!("{what}: {detail}"))
    }
}

fn file_base_name(filename: &str) -> &str {
    filename.rsplit(['/', '\\']).next().unwrap_or(filename)
}

/// `name` without `suffix`, compared ASCII case-insensitively; an all-suffix name is kept.
fn strip_suffix_ci<'a>(name: &'a str, suffix: &str) -> &'a str {
    let cut = name.len().wrapping_sub(suffix.len());
    match name.get(cut..) {
        Some(tail) if cut > 0 && tail.eq_ignore_ascii_case(suffix) => &name[..cut],
        _ => name,
    }
}

/// A cabinet entry name as `onenote_parser` normalises it (separators, `.`/`..`).
fn normalize_cab_name(name: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// A `.onepkg` is unpacked fully into memory by `onenote_parser`, so check the cabinet first:
///
/// - at most [`MAX_ONEPKG_ENTRIES`] files (and `max_zip_entries`), no duplicate names: the crate
///   reads entries by name and `cab` resolves a name to its first match, so duplicates would
///   decompress the same data again and again;
/// - the declared sizes sum to at most `max_unzipped_bytes` (the `cab` reader never yields more
///   than an entry's declared size);
/// - the decompression *work*: `cab` 0.6 re-decompresses an entry's folder from its first block
///   on every read, so the cost is the sum over entries of the folder's blocks × 64 KiB, which
///   must stay within [`CAB_WORK_FACTOR`] × `max_unzipped_bytes` (many entries in one folder are
///   quadratic).
///
/// Peak memory of a package import is still a few times `max_unzipped_bytes`: the unpacked files,
/// the crate's copy of the section being parsed, and the image bytes read for the document.
fn check_cabinet(bytes: &[u8], limits: &ImportLimits) -> Result<(), ImportError> {
    struct Stats {
        entries: usize,
        total: u64,
        work: u64,
        duplicate: Option<String>,
    }
    let stats = guarded("the OneNote notebook package", || {
        let cab = cab::Cabinet::new(Cursor::new(bytes))
            .map_err(|e| crate_error("the OneNote notebook package could not be opened", &e))?;
        let mut stats = Stats {
            entries: 0,
            total: 0,
            work: 0,
            duplicate: None,
        };
        let mut raw = HashSet::new();
        let mut normalized = HashSet::new();
        for folder in cab.folder_entries() {
            let folder_work = u64::from(folder.num_data_blocks()) * CAB_BLOCK_BYTES;
            for file in folder.file_entries() {
                stats.entries += 1;
                stats.total += u64::from(file.uncompressed_size());
                stats.work = stats.work.saturating_add(folder_work);
                let name = file.name();
                let fresh =
                    raw.insert(name.to_owned()) & normalized.insert(normalize_cab_name(name));
                if !fresh && stats.duplicate.is_none() {
                    stats.duplicate = Some(name.chars().take(MAX_DETAIL_CHARS).collect());
                }
            }
        }
        Ok(stats)
    })?;
    let max_entries = limits.max_zip_entries.min(MAX_ONEPKG_ENTRIES);
    if stats.entries > max_entries {
        return Err(ImportError::Limit(format!(
            "it contains {} files; the most Mate reads is {}",
            super::fmt_count(stats.entries as u64),
            super::fmt_count(max_entries as u64)
        )));
    }
    if let Some(name) = stats.duplicate {
        return Err(ImportError::Corrupt(format!(
            "the OneNote notebook package lists the file \"{name}\" more than once"
        )));
    }
    if stats.total > limits.max_unzipped_bytes {
        return Err(ImportError::Limit(format!(
            "it unpacks to more than {} MiB",
            limits.max_unzipped_bytes / MIB
        )));
    }
    if stats.work > limits.max_unzipped_bytes.saturating_mul(CAB_WORK_FACTOR) {
        return Err(ImportError::Limit(
            "unpacking its many files would take too long".into(),
        ));
    }
    Ok(())
}

/// A read-only, single-file [`FileSystem`]: every path reads `data`. `parse_package` reads the
/// package through it once; `parse_section_buffer` never touches it.
#[derive(Clone, Copy)]
struct MemFs<'a> {
    data: &'a [u8],
}

fn read_only() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "read-only in-memory file system",
    )
}

impl FileSystem for MemFs<'_> {
    fn is_directory(&self, _path: TypedPath) -> std::io::Result<bool> {
        Ok(false)
    }
    fn read_dir(&self, _path: TypedPath) -> std::io::Result<Vec<TypedPathBuf>> {
        Ok(Vec::new())
    }
    fn read_file(&self, _path: TypedPath) -> std::io::Result<Vec<u8>> {
        Ok(self.data.to_vec())
    }
    fn write_file(&self, _path: TypedPath, _data: &[u8]) -> std::io::Result<()> {
        Err(read_only())
    }
    fn stream_to_file(&self, _path: TypedPath, _reader: &mut dyn Read) -> std::io::Result<()> {
        Err(read_only())
    }
    fn make_dir(&self, _path: TypedPath) -> std::io::Result<()> {
        Err(read_only())
    }
    fn canonicalize(&self, path: TypedPath) -> std::io::Result<TypedPathBuf> {
        Ok(path.to_path_buf())
    }
    fn exists(&self, _path: TypedPath) -> std::io::Result<bool> {
        Ok(true)
    }
}

/// What extraction may still produce: image bytes, starting at `max_unzipped_bytes` (an image
/// blob can be referenced many times, so the file size alone does not bound what reading every
/// image allocates), and pages over all sections, starting at `max_pages` (pages past it are not
/// read at all, images included), and the points and elements of the whole document.
struct Budget {
    left: u64,
    pages_left: usize,
    output: ImportBudget,
}

impl Budget {
    fn new(limits: &ImportLimits) -> Budget {
        Budget {
            left: limits.max_unzipped_bytes,
            pages_left: limits.max_pages,
            output: ImportBudget::new(limits),
        }
    }
}

fn extract_entries(
    entries: &[SectionEntry],
    prefix: &str,
    limits: &ImportLimits,
    budget: &mut Budget,
    out: &mut Vec<SectionView>,
) -> Result<(), ImportError> {
    for entry in entries {
        match entry {
            SectionEntry::Section(section) => {
                out.push(extract_section(section, prefix, limits, budget)?);
            }
            SectionEntry::SectionGroup(group) => {
                let prefix = format!("{prefix}{} / ", group.display_name());
                extract_entries(group.entries(), &prefix, limits, budget, out)?;
            }
        }
    }
    Ok(())
}

fn extract_section(
    section: &Section,
    prefix: &str,
    limits: &ImportLimits,
    budget: &mut Budget,
) -> Result<SectionView, ImportError> {
    let mut pages = Vec::new();
    for page in section.page_series().iter().flat_map(|s| s.pages()) {
        check_deadline(limits)?;
        if budget.pages_left == 0 {
            break;
        }
        budget.pages_left -= 1;
        pages.push(extract_page(page, limits, budget)?);
    }
    Ok(SectionView {
        source_id: section.file_identity().to_string(),
        title: format!("{prefix}{}", section.display_name()),
        pages,
    })
}

fn extract_page(
    page: &Page,
    limits: &ImportLimits,
    budget: &mut Budget,
) -> Result<PageView, ImportError> {
    let mut view = PageView {
        source_id: page.link_target_id().to_owned(),
        title: page
            .title_text()
            .map(str::to_owned)
            .filter(|t| !t.trim().is_empty()),
        height: page.height(),
        ..PageView::default()
    };
    budget.output.start_page();
    for content in page.contents() {
        match content {
            PageContent::Outline(outline) => extract_outline(outline, &mut view, limits, budget)?,
            PageContent::Image(image) => {
                if budget.output.page_full() {
                    budget.output.skip(&mut view.skipped)?;
                    continue;
                }
                match extract_image(image, limits, budget)? {
                    Some(img) => {
                        if budget.output.admit(0, &mut view.skipped)? {
                            view.images.push(img);
                        }
                    }
                    None => view.skipped.other += 1,
                }
            }
            PageContent::Ink(ink) => {
                extract_ink(ink, 0.0, 0.0, &mut view.inks, &mut budget.output, &mut view.skipped)?
            }
            PageContent::EmbeddedFile(_) | PageContent::Unknown => view.skipped.other += 1,
        }
    }
    Ok(view)
}

/// Flattens an ink tree; container offsets are relative to the parent, so they add up. Every
/// stroke is admitted through `output` (past the page limit it is counted, not read).
fn extract_ink(
    ink: &Ink,
    parent_h: f32,
    parent_v: f32,
    out: &mut Vec<InkView>,
    output: &mut ImportBudget,
    skipped: &mut ImportSkipped,
) -> Result<(), ImportError> {
    let h = parent_h + ink.offset_horizontal().unwrap_or(0.0);
    let v = parent_v + ink.offset_vertical().unwrap_or(0.0);
    let strokes = admit_strokes(
        ink.ink_strokes(),
        |s| StrokeView {
            points: s.absolute_path().iter().map(|p| (p.x(), p.y())).collect(),
            color: s.color(),
            transparency: s.transparency(),
            width: s.width(),
        },
        output,
        skipped,
    )?;
    if !strokes.is_empty() {
        out.push(InkView {
            offset_horizontal: h,
            offset_vertical: v,
            strokes,
        });
    }
    for child in ink.child_groups() {
        extract_ink(child, h, v, out, output, skipped)?;
    }
    Ok(())
}

/// The views of `strokes` that `output` admits; a stroke past the page limit is counted in
/// `skipped` without being read.
fn admit_strokes<S>(
    strokes: &[S],
    read: impl Fn(&S) -> StrokeView,
    output: &mut ImportBudget,
    skipped: &mut ImportSkipped,
) -> Result<Vec<StrokeView>, ImportError> {
    let mut out = Vec::new();
    for s in strokes {
        if output.page_full() {
            output.skip(skipped)?;
            continue;
        }
        let view = read(s);
        if output.admit(view.points.len(), skipped)? {
            out.push(view);
        }
    }
    Ok(out)
}

fn extract_outline(
    outline: &Outline,
    page: &mut PageView,
    limits: &ImportLimits,
    budget: &mut Budget,
) -> Result<(), ImportError> {
    let mut view = OutlineView {
        offset_horizontal: outline.offset_horizontal(),
        offset_vertical: outline.offset_vertical(),
        layout_max_width: outline.layout_max_width(),
        ..OutlineView::default()
    };
    let mut images = Vec::new();
    let mut walk = OutlineWalk {
        view: &mut view,
        images: &mut images,
        skipped: &mut page.skipped,
        limits,
        budget,
    };
    walk.items(outline.items())?;
    // Images inside an outline flow with its text; Mate places them at the outline's origin,
    // stacked downwards.
    let mut dy = 0.0f32;
    for mut img in images {
        img.offset_horizontal = view.offset_horizontal;
        img.offset_vertical = Some(view.offset_vertical.unwrap_or(0.0) + dy);
        dy += img
            .picture_height
            .unwrap_or((adapter::DEFAULT_IMAGE_SIZE_PX / adapter::HALF_INCH_TO_PX) as f32);
        page.images.push(img);
    }
    if view.paragraphs.iter().any(|p| !p.trim().is_empty())
        && budget.output.admit(0, &mut page.skipped)?
    {
        page.outlines.push(view);
    }
    Ok(())
}

struct OutlineWalk<'a> {
    view: &'a mut OutlineView,
    images: &'a mut Vec<ImageView>,
    skipped: &'a mut ImportSkipped,
    limits: &'a ImportLimits,
    budget: &'a mut Budget,
}

impl OutlineWalk<'_> {
    fn items(&mut self, items: &[OutlineItem]) -> Result<(), ImportError> {
        for item in items {
            match item {
                OutlineItem::Group(group) => self.items(group.outlines())?,
                OutlineItem::Element(element) => {
                    for content in element.contents() {
                        match content {
                            Content::RichText(text) => {
                                if self.view.font_size_half_points.is_none() {
                                    self.view.font_size_half_points =
                                        text.paragraph_style().font_size();
                                }
                                self.view.paragraphs.push(visible_text(text));
                            }
                            Content::Image(image) => {
                                if self.budget.output.page_full() {
                                    self.budget.output.skip(self.skipped)?;
                                    continue;
                                }
                                match extract_image(image, self.limits, self.budget)? {
                                    Some(img) => {
                                        if self.budget.output.admit(0, self.skipped)? {
                                            self.images.push(img);
                                        }
                                    }
                                    None => self.skipped.other += 1,
                                }
                            }
                            Content::Table(_) => self.skipped.tables += 1,
                            _ => self.skipped.other += 1,
                        }
                    }
                    self.items(element.children())?;
                }
            }
        }
        Ok(())
    }
}

/// The paragraph text without its hidden runs (hyperlink markers and the like). Run ends are
/// UTF-16 offsets (the last run may have none); malformed values are clamped, never trusted.
fn visible_text(rt: &RichText) -> String {
    let formatting = rt.text_run_formatting();
    if formatting.is_empty() {
        return rt.text().to_owned();
    }
    let utf16: Vec<u16> = rt.text().encode_utf16().collect();
    let ends = rt.text_run_indices();
    let mut out: Vec<u16> = Vec::with_capacity(utf16.len());
    let mut start = 0usize;
    for (i, style) in formatting.iter().enumerate() {
        let end = if i + 1 == formatting.len() {
            utf16.len()
        } else {
            ends.get(i)
                .map_or(utf16.len(), |&e| e as usize)
                .clamp(start, utf16.len())
        };
        if !style.hidden() {
            out.extend_from_slice(&utf16[start..end]);
        }
        start = end;
    }
    String::from_utf16_lossy(&out)
}

fn extract_image(
    image: &Image,
    limits: &ImportLimits,
    budget: &mut Budget,
) -> Result<Option<ImageView>, ImportError> {
    let Some(reader) = image.read() else {
        return Ok(None);
    };
    let cap = budget.left.min(limits.max_file_bytes);
    let mut bytes = Vec::new();
    reader
        .take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| crate_error("an image could not be read", &e))?;
    if bytes.len() as u64 > cap {
        return Err(ImportError::Limit(format!(
            "its images unpack to more than {} MiB",
            limits.max_unzipped_bytes / MIB
        )));
    }
    budget.left -= bytes.len() as u64;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(ImageView {
        offset_horizontal: image.offset_horizontal(),
        offset_vertical: image.offset_vertical(),
        picture_width: image.picture_width().or(image.layout_max_width()),
        picture_height: image.picture_height().or(image.layout_max_height()),
        bytes,
        extension: image.extension().map(str::to_owned),
        is_background: image.is_background(),
    }))
}

/// The mapping from raw OneNote values to Mate's import model, independent of `onenote_parser`.
pub mod adapter {
    use crate::import::{
        ImportDocument, ImportImage, ImportPage, ImportPoint, ImportSection, ImportSkipped,
        ImportSource, ImportStroke, ImportText,
    };
    use crate::model::{PageMode, PenStyle};

    /// HIMETRIC (0.01 mm ink units) → CSS px at 96 dpi.
    pub const HIMETRIC_TO_PX: f64 = 96.0 / 2540.0;
    /// OneNote layout half-inches → CSS px at 96 dpi.
    pub const HALF_INCH_TO_PX: f64 = 48.0;
    /// OneNote pages have no width; Mate uses its own sheet width (placer scale 1).
    pub const DEFAULT_PAGE_WIDTH_PX: f64 = 1080.0;
    /// Smallest page height when the page declares none.
    pub const MIN_PAGE_HEIGHT_PX: f64 = 1440.0;
    /// Image side used when the source gives no size.
    pub const DEFAULT_IMAGE_SIZE_PX: f64 = 300.0;
    /// Estimated height of one text line, used for the page extent only.
    pub const TEXT_LINE_HEIGHT_PX: f64 = 24.0;
    pub const PEN_OPACITY: f64 = 1.0;
    pub const HIGHLIGHTER_OPACITY: f64 = 0.5;
    const BLACK: &str = "#000000";

    /// A section with its pages, raw values as read from the file.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct SectionView {
        pub source_id: String,
        pub title: String,
        pub pages: Vec<PageView>,
    }

    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct PageView {
        pub source_id: String,
        pub title: Option<String>,
        /// Half-inches.
        pub height: Option<f32>,
        pub inks: Vec<InkView>,
        pub outlines: Vec<OutlineView>,
        pub images: Vec<ImageView>,
        pub skipped: ImportSkipped,
    }

    /// One ink container's strokes; offsets in half-inches from the page origin (already summed
    /// over nested containers).
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct InkView {
        pub offset_horizontal: f32,
        pub offset_vertical: f32,
        pub strokes: Vec<StrokeView>,
    }

    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct StrokeView {
        /// Absolute points in HIMETRIC ink units.
        pub points: Vec<(f32, f32)>,
        /// BGR (`0x00BBGGRR`).
        pub color: Option<u32>,
        pub transparency: Option<u8>,
        /// Pen weight in HIMETRIC.
        pub width: f32,
    }

    /// A text outline: offsets and width in half-inches, one string per paragraph.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct OutlineView {
        pub offset_horizontal: Option<f32>,
        pub offset_vertical: Option<f32>,
        pub layout_max_width: Option<f32>,
        pub paragraphs: Vec<String>,
        pub font_size_half_points: Option<u16>,
    }

    /// An image: offsets and size in half-inches.
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct ImageView {
        pub offset_horizontal: Option<f32>,
        pub offset_vertical: Option<f32>,
        pub picture_width: Option<f32>,
        pub picture_height: Option<f32>,
        pub bytes: Vec<u8>,
        pub extension: Option<String>,
        pub is_background: bool,
    }

    pub fn himetric_to_px(v: f64) -> f64 {
        v * 96.0 / 2540.0
    }

    pub fn half_inch_to_px(v: f64) -> f64 {
        v * HALF_INCH_TO_PX
    }

    /// A stroke point in page px: the ink point (HIMETRIC) plus its ink container's offset
    /// (half-inches). Whether OneNote's ink points already include that offset is undocumented;
    /// adding it is a medium-confidence reading of MS-ONE (`OffsetFromParentHoriz/Vert` place
    /// the container in its parent; the points are not in page units). This is the one place to
    /// change if real files show doubled offsets.
    pub fn ink_point_to_px(
        x: f64,
        y: f64,
        offset_horizontal: f64,
        offset_vertical: f64,
    ) -> (f64, f64) {
        (
            himetric_to_px(x) + half_inch_to_px(offset_horizontal),
            himetric_to_px(y) + half_inch_to_px(offset_vertical),
        )
    }

    /// A BGR colour int (`0x00BBGGRR`) as `#rrggbb`.
    pub fn bgr_to_hex(c: u32) -> String {
        format!(
            "#{:02x}{:02x}{:02x}",
            c & 0xff,
            (c >> 8) & 0xff,
            (c >> 16) & 0xff
        )
    }

    /// OneNote highlighters are translucent: a transparency below 128.
    pub fn is_highlighter(transparency: Option<u8>) -> bool {
        transparency.is_some_and(|t| t < 128)
    }

    /// Pen width in px from the HIMETRIC pen weight, at least 1.
    pub fn pen_width_px(weight: f64) -> f64 {
        let w = himetric_to_px(weight);
        if w.is_finite() { w.max(1.0) } else { 1.0 }
    }

    /// The mime type an image file extension (with or without the dot) names.
    pub fn mime_for_extension(ext: &str) -> Option<&'static str> {
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "png" => Some("image/png"),
            "jpg" | "jpeg" | "jpe" | "jfif" => Some("image/jpeg"),
            "gif" => Some("image/gif"),
            "bmp" | "dib" => Some("image/bmp"),
            "tif" | "tiff" => Some("image/tiff"),
            "webp" => Some("image/webp"),
            "emf" => Some("image/emf"),
            "wmf" => Some("image/wmf"),
            "svg" => Some("image/svg+xml"),
            _ => None,
        }
    }

    fn opt_px(v: Option<f32>) -> Option<f64> {
        v.map(|v| half_inch_to_px(f64::from(v)))
            .filter(|v| v.is_finite())
    }

    /// The import document for `sections`, keeping at most `max_pages` pages over all sections.
    pub fn from_sections(
        title: &str,
        sections: Vec<SectionView>,
        max_pages: usize,
    ) -> ImportDocument {
        let mut left = max_pages;
        let sections = sections
            .into_iter()
            .map(|s| {
                let take = left.min(s.pages.len());
                left -= take;
                ImportSection {
                    source_id: s.source_id,
                    title: s.title,
                    pages: s.pages.into_iter().take(take).map(page).collect(),
                }
            })
            .collect();
        ImportDocument {
            source: ImportSource::OneNote,
            title: title.to_owned(),
            default_page_mode: PageMode::Page,
            sections,
        }
    }

    /// Right and bottom edge of the page content.
    #[derive(Default)]
    struct Extent {
        right: f64,
        bottom: f64,
    }

    impl Extent {
        fn add(&mut self, x: f64, y: f64) {
            self.right = self.right.max(x);
            self.bottom = self.bottom.max(y);
        }
    }

    fn page(p: PageView) -> ImportPage {
        let mut extent = Extent::default();

        let mut images: Vec<(bool, ImportImage)> = p
            .images
            .into_iter()
            .map(|i| {
                let size = |v: Option<f32>| {
                    opt_px(v)
                        .filter(|v| *v > 0.0)
                        .unwrap_or(DEFAULT_IMAGE_SIZE_PX)
                };
                let img = ImportImage {
                    x: opt_px(i.offset_horizontal).unwrap_or(0.0),
                    y: opt_px(i.offset_vertical).unwrap_or(0.0),
                    width: size(i.picture_width),
                    height: size(i.picture_height),
                    mime: i
                        .extension
                        .as_deref()
                        .and_then(mime_for_extension)
                        .map(str::to_owned),
                    bytes: i.bytes,
                };
                (i.is_background, img)
            })
            .collect();
        // Background images first so they paint under the rest; otherwise source order.
        images.sort_by_key(|(background, _)| !*background);
        let images: Vec<ImportImage> = images.into_iter().map(|(_, i)| i).collect();
        for i in &images {
            extent.add(i.x + i.width, i.y + i.height);
        }

        let texts: Vec<ImportText> = p
            .outlines
            .into_iter()
            .map(|o| ImportText {
                x: opt_px(o.offset_horizontal).unwrap_or(0.0),
                y: opt_px(o.offset_vertical).unwrap_or(0.0),
                width: opt_px(o.layout_max_width).filter(|w| *w > 0.0),
                // Half-points → points → px.
                font_size: o
                    .font_size_half_points
                    .map(|hp| f64::from(hp) / 2.0 * 96.0 / 72.0),
                color: BLACK.into(),
                text: o.paragraphs.join("\n"),
            })
            .collect();
        for t in &texts {
            let lines = t.text.lines().count().max(1) as f64;
            extent.add(
                t.x + t.width.unwrap_or(0.0),
                t.y + lines * TEXT_LINE_HEIGHT_PX,
            );
        }

        let mut strokes = Vec::new();
        for ink in p.inks {
            let finite_or_zero = |v: f32| if v.is_finite() { f64::from(v) } else { 0.0 };
            let (oh, ov) = (
                finite_or_zero(ink.offset_horizontal),
                finite_or_zero(ink.offset_vertical),
            );
            for s in ink.strokes {
                let points: Vec<ImportPoint> = s
                    .points
                    .iter()
                    .map(|&(x, y)| ink_point_to_px(f64::from(x), f64::from(y), oh, ov))
                    .filter(|(x, y)| x.is_finite() && y.is_finite())
                    .map(|(x, y)| ImportPoint {
                        x,
                        y,
                        pressure: None,
                    })
                    .collect();
                if points.is_empty() {
                    continue;
                }
                let highlighter = is_highlighter(s.transparency);
                let width = pen_width_px(f64::from(s.width));
                for pt in &points {
                    extent.add(pt.x + width / 2.0, pt.y + width / 2.0);
                }
                strokes.push(ImportStroke {
                    points,
                    color: s.color.map_or_else(|| BLACK.into(), bgr_to_hex),
                    opacity: if highlighter {
                        HIGHLIGHTER_OPACITY
                    } else {
                        PEN_OPACITY
                    },
                    width,
                    is_highlighter: highlighter,
                    pen_style: if highlighter {
                        PenStyle::Highlighter
                    } else {
                        PenStyle::Pen
                    },
                    z_index: strokes.len() as i64,
                });
            }
        }

        let width = DEFAULT_PAGE_WIDTH_PX.max(extent.right.ceil());
        let height = match opt_px(p.height).filter(|h| *h > 0.0) {
            Some(h) => h.max(extent.bottom.ceil()),
            None => MIN_PAGE_HEIGHT_PX.max(extent.bottom.ceil()),
        };
        ImportPage {
            source_id: p.source_id,
            title: p.title,
            width,
            height,
            background: Default::default(),
            strokes,
            texts,
            images,
            skipped: p.skipped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onenote_document_point_budget_is_enforced() {
        let view = |n: &usize| StrokeView {
            points: vec![(0.0, 0.0); *n],
            color: None,
            transparency: None,
            width: 1.0,
        };
        let limits = ImportLimits { max_points: 10_000, ..ImportLimits::default() };
        let mut output = ImportBudget::new(&limits);
        let mut skipped = ImportSkipped::default();

        // A page past the element limit: the extra strokes are counted, never read.
        output.start_page();
        let read = std::cell::Cell::new(0usize);
        let counted = |n: &usize| {
            read.set(read.get() + 1);
            view(n)
        };
        let kept = admit_strokes(&[1usize; 5010], counted, &mut output, &mut skipped).unwrap();
        assert_eq!((kept.len(), read.get(), skipped.other), (5000, 5000, 10));

        // The next pages share the document's point budget.
        let mut result = Ok(Vec::new());
        for _ in 0..10 {
            output.start_page();
            result = admit_strokes(&[1000usize; 2], view, &mut output, &mut skipped);
            if result.is_err() {
                break;
            }
        }
        assert!(matches!(result, Err(ImportError::Limit(m)) if m.contains("points")));
        assert!(output.points() > 10_000 && output.points() <= 12_000, "{}", output.points());
    }
}
