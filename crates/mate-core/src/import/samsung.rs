//! Samsung Notes (`.sdocx`): a zip with `note.note`, `pageIdInfo.dat`, one `<pageId>.page` per
//! page and optionally `media/mediaInfo.dat` plus the media files.
//!
//! Best effort: the layouts are reverse-engineered offsets of a proprietary format (see
//! `docs/analysis/05-import-formats.md` section 4). Strokes are decoded structurally (medium
//! confidence); image placements are found by a byte-pattern scan (low confidence). Typed text
//! boxes are not decoded. Every offset is bounds-checked, loop counts are capped by the declared
//! counts and by the buffer length, and a damaged stroke stops its page (earlier strokes stay).

use super::{
    ImportBackground, ImportDocument, ImportError, ImportImage, ImportLimits, ImportPage,
    ImportPoint, ImportSection, ImportSkipped, ImportSource, ImportStroke, ZipSource,
    check_deadline,
};
use crate::model::{PageMode, PenStyle};

const NOTE: &str = "note.note";
const PAGE_IDS: &str = "pageIdInfo.dat";
const MEDIA_INFO: &str = "media/mediaInfo.dat";
/// A delta is `mag / 32` source units.
const DELTA_DIV: f64 = 32.0;
/// Pressure samples accumulate to `sum / PRESSURE_DIV`.
const PRESSURE_DIV: f64 = 1400.0;
/// How far back from the end of a stroke's data the style block is searched.
const STYLE_WINDOW: usize = 512;
/// Smallest plausible stroke record, bounds the stroke count by the buffer length.
const MIN_STROKE_BYTES: usize = 100;
const MAX_IMAGE_PLACEMENTS: usize = 1000;
const MAX_COORD: f64 = 1.0e7;

fn corrupt(what: &str) -> ImportError {
    ImportError::Corrupt(format!("Samsung Notes: {what}"))
}

fn bytes_at<const N: usize>(buf: &[u8], off: usize) -> Result<[u8; N], ImportError> {
    let end = off.checked_add(N).ok_or_else(|| corrupt("offset overflow"))?;
    buf.get(off..end)
        .and_then(|s| <[u8; N]>::try_from(s).ok())
        .ok_or_else(|| corrupt("truncated data"))
}

fn u16_at(buf: &[u8], off: usize) -> Result<u16, ImportError> {
    Ok(u16::from_le_bytes(bytes_at(buf, off)?))
}

fn u32_at(buf: &[u8], off: usize) -> Result<u32, ImportError> {
    Ok(u32::from_le_bytes(bytes_at(buf, off)?))
}

fn f32_at(buf: &[u8], off: usize) -> Result<f32, ImportError> {
    Ok(f32::from_le_bytes(bytes_at(buf, off)?))
}

fn f64_at(buf: &[u8], off: usize) -> Result<f64, ImportError> {
    Ok(f64::from_le_bytes(bytes_at(buf, off)?))
}

fn byte_at(buf: &[u8], off: usize) -> Result<u8, ImportError> {
    buf.get(off).copied().ok_or_else(|| corrupt("truncated data"))
}

fn add(a: usize, b: usize) -> Result<usize, ImportError> {
    a.checked_add(b).ok_or_else(|| corrupt("offset overflow"))
}

fn usize_from(v: u32) -> usize {
    usize::try_from(v).unwrap_or(usize::MAX)
}

/// UTF-16LE text of `units` code units at `off` (lossy).
fn utf16_at(buf: &[u8], off: usize, units: usize) -> Result<String, ImportError> {
    let end = add(off, units.checked_mul(2).ok_or_else(|| corrupt("offset overflow"))?)?;
    let raw = buf.get(off..end).ok_or_else(|| corrupt("truncated data"))?;
    let words: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    Ok(String::from_utf16_lossy(&words))
}

/// The page ids of `pageIdInfo.dat`; a truncation after at least one id keeps the ids read.
fn page_ids(buf: &[u8]) -> Result<Vec<String>, ImportError> {
    if buf.len() < 34 {
        return Err(corrupt("pageIdInfo.dat is too short"));
    }
    let count = usize::from(u16_at(buf, 32)?);
    let mut ids = Vec::new();
    let mut off = 34usize;
    // Each record is at least 2 bytes, so the buffer length bounds the count too.
    for _ in 0..count.min(buf.len() / 2) {
        let Ok(len) = u16_at(buf, off) else { break };
        let Ok(id) = utf16_at(buf, add(off, 2)?, usize::from(len)) else { break };
        off = add(off, 2 + 2 * usize::from(len))?;
        ids.push(id);
    }
    if ids.is_empty() {
        return Err(corrupt("pageIdInfo.dat lists no pages"));
    }
    Ok(ids)
}

/// Note-level facts from `note.note`.
struct NoteHeader {
    dark: bool,
    width: f64,
    height: f64,
}

fn note_header(buf: &[u8]) -> Result<NoteHeader, ImportError> {
    Ok(NoteHeader {
        dark: u32_at(buf, 4)? & 0x800 != 0,
        width: f64::from(u32_at(buf, 40)?),
        height: f64::from(u32_at(buf, 44)?),
    })
}

fn hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

struct Style {
    highlighter: bool,
    color: Option<String>,
    width: f64,
}

/// Searches backwards from `g - 6` (not below `u`) for the style block
/// `[2|3, 0, 1|3, 0, 0, 0]`.
fn style_block(buf: &[u8], u: usize, g: usize) -> Option<Style> {
    let start = g.checked_sub(6)?;
    let lowest = u.max(start.saturating_sub(STYLE_WINDOW));
    let mut p = start;
    while p >= lowest {
        if let Some(win) = buf.get(p..p.checked_add(6)?)
            && matches!(win[0], 2 | 3)
            && win[1] == 0
            && matches!(win[2], 1 | 3)
            && win[3..] == [0, 0, 0]
        {
            return read_style(buf, p).ok();
        }
        p = p.checked_sub(1)?;
    }
    None
}

fn read_style(buf: &[u8], p: usize) -> Result<Style, ImportError> {
    let highlighter = byte_at(buf, add(p, 2)?)? == 3;
    let rgb = || -> Result<String, ImportError> {
        Ok(hex(byte_at(buf, add(p, 8)?)?, byte_at(buf, add(p, 7)?)?, byte_at(buf, add(p, 6)?)?))
    };
    if highlighter || byte_at(buf, add(p, 9)?)? == 0xFF {
        Ok(Style { highlighter, color: Some(rgb()?), width: f64::from(f32_at(buf, add(p, 10)?)?) })
    } else {
        Ok(Style { highlighter, color: None, width: f64::from(f32_at(buf, add(p, 6)?)?) })
    }
}

fn finite_positive(w: f64) -> bool {
    w.is_finite() && w > 0.0
}

struct DecodedPage {
    width: f64,
    height: f64,
    strokes: Vec<ImportStroke>,
    /// Declared strokes that could not be decoded.
    lost: u32,
}

/// One `.page` file.
fn decode_page(buf: &[u8], dark: bool) -> Result<DecodedPage, ImportError> {
    let header = usize_from(u32_at(buf, 0)?);
    let width = f64::from(u32_at(buf, 22)?);
    let height = f64::from(u32_at(buf, 26)?);
    let declared = u32_at(buf, add(header, 102)?)?;
    let cap = usize_from(declared).min(buf.len() / MIN_STROKE_BYTES + 1);
    let mut strokes = Vec::new();
    let mut h = add(header, 181)?;
    for _ in 0..cap {
        match decode_stroke(buf, h, dark, strokes.len()) {
            Ok((stroke, next)) => {
                strokes.push(stroke);
                h = next;
            }
            Err(_) => break,
        }
    }
    let lost = declared.saturating_sub(u32::try_from(strokes.len()).unwrap_or(u32::MAX));
    Ok(DecodedPage { width, height, strokes, lost })
}

fn signed(mag: u8, flags: u8) -> f64 {
    let v = f64::from(mag);
    if flags & 0x80 != 0 { -v } else { v }
}

/// The stroke whose record starts at `h`, and the start of the next record.
fn decode_stroke(
    buf: &[u8],
    h: usize,
    dark: bool,
    index: usize,
) -> Result<(ImportStroke, usize), ImportError> {
    let t = add(h, 32)?;
    let data_len = usize_from(u32_at(buf, add(t, 21)?)?);
    let n = usize::from(u16_at(buf, add(t, 39)?)?);
    if n == 0 {
        return Err(corrupt("empty stroke"));
    }
    let x0 = f64_at(buf, add(t, 41)?)?;
    let y0 = f64_at(buf, add(t, 49)?)?;
    if !(x0.is_finite() && y0.is_finite() && x0.abs() < MAX_COORD && y0.abs() < MAX_COORD) {
        return Err(corrupt("stroke start out of range"));
    }
    let u = add(t, 57)?;
    let g = add(u, data_len)?;
    if g > buf.len() {
        return Err(corrupt("stroke data past the end"));
    }
    let delta_bytes = 4 * (n - 1);
    if add(add(delta_bytes, 4)?, 2 * n)? > data_len {
        return Err(corrupt("stroke data too short"));
    }
    let press_at = add(add(u, delta_bytes)?, 4)?;
    let (mut x, mut y, mut sum) = (x0, y0, 0.0f64);
    let mut points = Vec::with_capacity(n);
    for i in 0..n {
        if i > 0 {
            let d = add(u, 4 * (i - 1))?;
            x += signed(byte_at(buf, d)?, byte_at(buf, add(d, 1)?)?) / DELTA_DIV;
            y += signed(byte_at(buf, add(d, 2)?)?, byte_at(buf, add(d, 3)?)?) / DELTA_DIV;
        }
        let p = add(press_at, 2 * i)?;
        sum += signed(byte_at(buf, p)?, byte_at(buf, add(p, 1)?)?);
        points.push(ImportPoint { x, y, pressure: Some((sum / PRESSURE_DIV).clamp(0.0, 1.0)) });
    }
    let (highlighter, color, raw_width) = match style_block(buf, u, g) {
        Some(s) => (s.highlighter, s.color, s.width),
        None => (false, None, 0.0),
    };
    let color = color.unwrap_or_else(|| if dark { "#ffffff".into() } else { "#1a1a1a".into() });
    let width = if highlighter {
        if finite_positive(raw_width) { raw_width.clamp(1.0, 80.0) } else { 20.0 }
    } else if finite_positive(raw_width) {
        (0.5 * raw_width).clamp(1.0, 60.0)
    } else {
        4.0
    };
    let stroke = ImportStroke {
        points,
        color,
        opacity: if highlighter { 0.5 } else { 1.0 },
        width,
        is_highlighter: highlighter,
        pen_style: if highlighter { PenStyle::Highlighter } else { PenStyle::Pen },
        z_index: i64::try_from(index).unwrap_or(i64::MAX),
    };
    Ok((stroke, add(g, 71)?))
}

/// `media/mediaInfo.dat`: `(index, file name)` records.
fn media_index(buf: &[u8]) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let Ok(count) = u16_at(buf, 4) else { return out };
    let mut i = 6usize;
    for _ in 0..usize::from(count).min(buf.len() / 10) {
        let rec = (|| -> Result<(usize, u32, String), ImportError> {
            let len = usize_from(u32_at(buf, i)?);
            let index = u32_at(buf, add(i, 4)?)?;
            let name_len = usize::from(u16_at(buf, add(i, 8)?)?);
            let name = utf16_at(buf, add(i, 10)?, name_len)?;
            Ok((add(add(i, 4)?, len)?, index, name))
        })();
        let Ok((next, index, name)) = rec else { break };
        out.push((index, name));
        i = next;
    }
    out
}

type Placement = (f64, f64, f64, f64, u32);

/// Image placements in `note.note` (low confidence): `(left, top, right, bottom, media index)`.
fn image_placements(buf: &[u8]) -> Vec<Placement> {
    const PATTERN: [u8; 4] = [1, 0, 4, 32];
    let mut out = Vec::new();
    for t in 0..buf.len().saturating_sub(3) {
        if out.len() >= MAX_IMAGE_PLACEMENTS {
            break;
        }
        if buf[t..t + 4] != PATTERN {
            continue;
        }
        let rec = (|| -> Result<Placement, ImportError> {
            Ok((
                f64_at(buf, add(t, 11)?)?,
                f64_at(buf, add(t, 19)?)?,
                f64_at(buf, add(t, 27)?)?,
                f64_at(buf, add(t, 35)?)?,
                u32_at(buf, add(t, 131)?)?,
            ))
        })();
        if let Ok((l, tp, r, b, idx)) = rec {
            let sane =
                [l, tp, r, b].iter().all(|v| v.is_finite() && v.abs() < MAX_COORD) && r > l && b > tp;
            if sane {
                out.push((l, tp, r, b, idx));
            }
        }
    }
    out
}

fn image_mime(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    match lower.rsplit('.').next()? {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The entry called `base` at the root or in any folder.
fn find_entry(src: &ZipSource, base: &str) -> Option<String> {
    if src.has(base) {
        return Some(base.to_owned());
    }
    src.names().into_iter().find(|n| n.rsplit('/').next() == Some(base))
}

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    let note_name = find_entry(src, NOTE).ok_or_else(|| corrupt("note.note is missing"))?;
    let ids_name = find_entry(src, PAGE_IDS).ok_or_else(|| corrupt("pageIdInfo.dat is missing"))?;
    let note = src.entry(&note_name)?.ok_or_else(|| corrupt("note.note is missing"))?;
    let header = note_header(&note)?;
    let ids_buf = src.entry(&ids_name)?.ok_or_else(|| corrupt("pageIdInfo.dat is missing"))?;
    let ids = page_ids(&ids_buf)?;

    let mut pages: Vec<ImportPage> = Vec::new();
    for (n, id) in ids.iter().enumerate().take(limits.max_pages) {
        check_deadline(limits)?;
        let Some(entry) = find_entry(src, &format!("{id}.page")) else { continue };
        let Some(buf) = src.entry(&entry)? else { continue };
        let page = decode_page(&buf, header.dark)?;
        let width = if page.width > 0.0 { page.width } else { header.width };
        let height = if page.height > 0.0 { page.height } else { header.height };
        if !(width > 0.0 && height > 0.0) {
            return Err(corrupt("a page has no size"));
        }
        pages.push(ImportPage {
            source_id: id.clone(),
            title: Some(format!("Page {}", n + 1)),
            width,
            height,
            background: ImportBackground::Plain,
            strokes: page.strokes,
            texts: Vec::new(),
            images: Vec::new(),
            skipped: ImportSkipped { other: page.lost, ..ImportSkipped::default() },
        });
    }
    if pages.is_empty() {
        return Err(corrupt("none of the listed pages could be read"));
    }

    place_images(src, &note, &header, &mut pages)?;

    Ok(ImportDocument {
        source: ImportSource::SamsungNotes,
        title: "Samsung Notes".into(),
        default_page_mode: PageMode::Page,
        sections: vec![ImportSection {
            source_id: "samsung-notes".into(),
            title: "Samsung Notes".into(),
            pages,
        }],
    })
}

/// Images go on the first page that has strokes (else the first page); placements that cannot
/// be resolved to a media file are counted as skipped.
fn place_images(
    src: &mut ZipSource,
    note: &[u8],
    header: &NoteHeader,
    pages: &mut [ImportPage],
) -> Result<(), ImportError> {
    let placements = image_placements(note);
    if placements.is_empty() {
        return Ok(());
    }
    let index = match src.entry(MEDIA_INFO)? {
        Some(buf) => media_index(&buf),
        None => Vec::new(),
    };
    let target = pages.iter().position(|p| !p.strokes.is_empty()).unwrap_or(0);
    let (pw, ph) = (pages[target].width, pages[target].height);
    let sx = if header.width > 0.0 { pw / header.width } else { 1.0 };
    let sy = if header.height > 0.0 { ph / header.height } else { 1.0 };
    let mut seen: Vec<(u32, [u64; 4])> = Vec::new();
    for (l, t, r, b, idx) in placements {
        let key = (idx, [l.to_bits(), t.to_bits(), r.to_bits(), b.to_bits()]);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let resolved = index
            .iter()
            .find(|(i, _)| *i == idx)
            .and_then(|(_, name)| image_mime(name).map(|m| (name.clone(), m)));
        let bytes = match &resolved {
            Some((name, _)) => src.entry(&format!("media/{name}"))?,
            None => None,
        };
        match (resolved, bytes) {
            (Some((_, mime)), Some(bytes)) if !bytes.is_empty() => {
                pages[target].images.push(ImportImage {
                    x: l * sx,
                    y: t * sy,
                    width: (r - l) * sx,
                    height: (b - t) * sy,
                    bytes,
                    mime: Some(mime.into()),
                });
            }
            _ => pages[target].skipped.other += 1,
        }
    }
    Ok(())
}
