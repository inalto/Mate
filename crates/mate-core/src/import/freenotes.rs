//! Freenotes (`.freenotes`, `.freenotesv2`, `.freebackup`): a zip of protobuf records.
//!
//! The zip holds one or more note bundles: top-level directories named `*.frnote` (else every
//! top-level directory with a `document.dat`, else the zip root). A `.freebackup` has several; each
//! becomes one [`ImportSection`]. Inside a bundle `document.dat` lists the pages, `layout.dat`
//! gives their sizes, `layerInfo.dat` the layers and `FNPages/<contentId>` the strokes and objects.
//! Every record is protobuf, decoded schema-less with [`super::pb`].
//!
//! Page items (strokes, text, images) are ordered by `drawOrder {layer, at, id}`: the content
//! record's layer number, the creation time and the entry key. A stroke's `z_index` is its rank
//! minus the item count, so the topmost item is -1.

use std::collections::{HashMap, HashSet};

use super::pb::{self, Wire};
use super::{
    ImportBackground, ImportBudget, ImportDocument, ImportError, ImportImage, ImportLimits,
    ImportPage, ImportPoint, ImportSection, ImportSkipped, ImportSource, ImportStroke, ImportText,
    ZipSource, check_deadline,
};
use crate::model::{PageMode, PenStyle};

/// A decoded message: its fields and its nesting depth (0 for a top-level record), so that every
/// sub-message is read through [`pb::fields_at_depth`] and the nesting limit holds.
#[derive(Default)]
struct Fields<'a> {
    v: Vec<(u32, Wire<'a>)>,
    depth: u32,
}

impl<'a> Fields<'a> {
    fn top(bytes: &'a [u8]) -> Result<Self, ImportError> {
        Ok(Fields {
            v: pb::fields(bytes).collect_all()?,
            depth: 0,
        })
    }

    /// The sub-message `bytes` of this message.
    fn child(&self, bytes: &'a [u8]) -> Result<Fields<'a>, ImportError> {
        let r = pb::fields_at_depth(bytes, self.depth)?;
        let depth = r.depth();
        Ok(Fields {
            v: r.collect_all()?,
            depth,
        })
    }
}

const DEFAULT_PAGE: (f64, f64) = (540.0, 720.0);
/// Spacing table of the paper templates (index 1..=10).
const PAPER_SPACING: [f64; 10] = [14.2, 18.0, 28.5, 36.0, 42.5, 54.0, 56.5, 72.0, 85.0, 108.0];
const DEFAULT_NIB: f64 = 2.0;
const MISSING_AT: i64 = i64::MAX;

fn corrupt(msg: &str) -> ImportError {
    ImportError::Corrupt(format!("freenotes: {msg}"))
}

fn first<'a>(f: &Fields<'a>, n: u32) -> Option<Wire<'a>> {
    f.v.iter().find(|(k, _)| *k == n).map(|(_, w)| *w)
}

fn all<'a>(f: &Fields<'a>, n: u32) -> Vec<Wire<'a>> {
    f.v.iter()
        .filter(|(k, _)| *k == n)
        .map(|(_, w)| *w)
        .collect()
}

/// First LEN field `n` decoded as a message.
fn sub<'a>(f: &Fields<'a>, n: u32) -> Result<Option<Fields<'a>>, ImportError> {
    match first(f, n).and_then(|w| w.as_bytes()) {
        Some(b) => f.child(b).map(Some),
        None => Ok(None),
    }
}

fn string(f: &Fields<'_>, n: u32) -> Option<String> {
    first(f, n).and_then(|w| w.as_string())
}

fn num(f: &Fields<'_>, n: u32) -> Option<f64> {
    first(f, n)
        .and_then(|w| w.as_f64())
        .filter(|v| v.is_finite())
}

/// A `{1: x f64, 2: y f64}` pair stored in field `n`.
fn pair(f: &Fields<'_>, n: u32) -> Result<Option<(f64, f64)>, ImportError> {
    Ok(sub(f, n)?.and_then(|p| Some((num(&p, 1)?, num(&p, 2)?))))
}

/// Timestamp message `{1: seconds, 2: nanos}` in milliseconds.
fn timestamp(f: &Fields<'_>, n: u32) -> Result<Option<i64>, ImportError> {
    Ok(sub(f, n)?.map(|t| {
        let s = first(&t, 1).and_then(|w| w.as_i64()).unwrap_or(0);
        let ns = first(&t, 2).and_then(|w| w.as_i64()).unwrap_or(0);
        s.saturating_mul(1000).saturating_add(ns / 1_000_000)
    }))
}

/// uint32 `0xRRGGBBAA` as (`#rrggbb`, alpha 0..=255). Alpha 0 is treated as unset: black.
fn unpack_color(v: u64) -> (String, u8) {
    let v = v as u32;
    let alpha = (v & 0xff) as u8;
    if alpha == 0 {
        return ("#000000".into(), 0);
    }
    (
        format!(
            "#{:02x}{:02x}{:02x}",
            v >> 24,
            (v >> 16) & 0xff,
            (v >> 8) & 0xff
        ),
        alpha,
    )
}

/// `Encrypted` when the zip layer refused an entry for want of a password.
fn read_error(e: ImportError) -> ImportError {
    match &e {
        ImportError::Corrupt(m) if m.to_ascii_lowercase().contains("password") => {
            ImportError::Encrypted
        }
        _ => e,
    }
}

fn read(src: &mut ZipSource, name: &str) -> Result<Option<Vec<u8>>, ImportError> {
    src.entry(name).map_err(read_error)
}

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    if src.any_encrypted() {
        return Err(ImportError::Encrypted);
    }
    let bundles = find_bundles(src);
    if bundles.is_empty() {
        return Err(corrupt("no \"<id>.frnote\" bundle found"));
    }
    let mut sections = Vec::new();
    let mut page_mode = PageMode::Page;
    let mut remaining = limits.max_pages;
    let mut dropped = 0u32;
    let mut budget = ImportBudget::new(limits);
    for dir in &bundles {
        check_deadline(limits)?;
        let note = parse_note(src, limits, &mut budget, dir, &mut remaining)?;
        if note.canvas {
            page_mode = PageMode::Canvas;
        }
        dropped += note.dropped;
        sections.push(note.section);
    }
    if dropped > 0
        && let Some(page) = sections.iter_mut().rev().find_map(|s| s.pages.last_mut())
    {
        page.skipped.other = page.skipped.other.saturating_add(dropped);
    }
    let title = if sections.len() == 1 {
        sections[0].title.clone()
    } else {
        "Freenotes backup".to_string()
    };
    Ok(ImportDocument {
        source: ImportSource::Freenotes,
        title,
        default_page_mode: page_mode,
        sections,
    })
}

/// Note directory prefixes (`"dir/"`, or `""` for the zip root), sorted.
fn find_bundles(src: &ZipSource) -> Vec<String> {
    let names = src.names();
    let mut tops: Vec<String> = Vec::new();
    for n in &names {
        if let Some((top, _)) = n.split_once('/')
            && !top.is_empty()
            && !tops.iter().any(|t| t == top)
        {
            tops.push(top.to_string());
        }
    }
    tops.sort();
    let frnotes: Vec<String> = tops
        .iter()
        .filter(|t| t.ends_with(".frnote"))
        .map(|t| format!("{t}/"))
        .collect();
    if !frnotes.is_empty() {
        return frnotes;
    }
    let with_doc: Vec<String> = tops
        .iter()
        .filter(|t| src.has(&format!("{t}/document.dat")))
        .map(|t| format!("{t}/"))
        .collect();
    if !with_doc.is_empty() {
        return with_doc;
    }
    if src.has("document.dat") {
        vec![String::new()]
    } else {
        Vec::new()
    }
}

struct Note {
    section: ImportSection,
    canvas: bool,
    /// Pages left out because the page limit was reached.
    dropped: u32,
}

struct PageRec {
    id: String,
    index: i64,
    content_id: Option<String>,
    layers: Vec<(String, String)>,
    /// Template bytes and the depth of the page message that holds them.
    template: Option<(Vec<u8>, u32)>,
}

struct Layer {
    visible: bool,
    position: i64,
}

fn base_of(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

fn stem_of(base: &str) -> &str {
    base.rsplit_once('.')
        .map(|(s, _)| s)
        .filter(|s| !s.is_empty())
        .unwrap_or(base)
}

fn parse_note(
    src: &mut ZipSource,
    limits: &ImportLimits,
    budget: &mut ImportBudget,
    dir: &str,
    remaining: &mut usize,
) -> Result<Note, ImportError> {
    let doc_bytes = read(src, &format!("{dir}document.dat"))?
        .ok_or_else(|| corrupt("a note has no document.dat"))?;
    let doc = Fields::top(&doc_bytes)?;
    let canvas = first(&doc, 3).and_then(|w| w.as_u64()) == Some(1);
    let body = match first(&doc, 4).and_then(|w| w.as_bytes()) {
        Some(b) => doc.child(b)?,
        None => Fields::default(),
    };

    let mut pages = Vec::new();
    for (pos, w) in all(&body, 1).into_iter().enumerate() {
        let b = w
            .as_bytes()
            .ok_or_else(|| corrupt("page record is not a message"))?;
        let p = body.child(b)?;
        let mut layers = Vec::new();
        for l in all(&p, 10) {
            if let Some(b) = l.as_bytes() {
                let l = p.child(b)?;
                if let (Some(layer), Some(content)) = (string(&l, 1), string(&l, 2)) {
                    layers.push((layer, content));
                }
            }
        }
        pages.push(PageRec {
            id: string(&p, 1).unwrap_or_else(|| format!("page-{}", pos + 1)),
            index: first(&p, 3).and_then(|w| w.as_i64()).unwrap_or(pos as i64),
            content_id: string(&p, 6).filter(|s| !s.is_empty()),
            layers,
            template: first(&p, 5)
                .and_then(|w| w.as_bytes())
                .map(|t| (t.to_vec(), p.depth)),
        });
    }
    pages.sort_by_key(|p| p.index);

    let titles = outline_titles(&body)?;
    let sizes = match read(src, &format!("{dir}layout.dat"))? {
        Some(b) => layout_sizes(&b)?,
        None => HashMap::new(),
    };
    let layers = match read(src, &format!("{dir}layerInfo.dat"))? {
        Some(b) => layer_info(&b)?,
        None => HashMap::new(),
    };
    let meta_title = match read(src, &format!("{dir}metadata.dat"))? {
        Some(b) => string(&Fields::top(&b)?, 3).filter(|t| !t.trim().is_empty()),
        None => None,
    };
    let dir_name = dir.trim_end_matches('/');
    let title = meta_title
        .or_else(|| {
            Some(
                dir_name
                    .strip_suffix(".frnote")
                    .unwrap_or(dir_name)
                    .to_string(),
            )
            .filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "Freenotes note".into());

    // Asset lookup: entries of this note by directory and base name / stem.
    let mut content_names: HashMap<String, Vec<String>> = HashMap::new();
    let mut asset_names: HashMap<String, String> = HashMap::new();
    for n in src.names() {
        let Some(rel) = n.strip_prefix(dir) else {
            continue;
        };
        if rel.ends_with('/') {
            continue;
        }
        let (top, rest) = rel.split_once('/').unwrap_or(("", rel));
        let base = base_of(rest).to_string();
        if top == "FNPages" || top == "FNPagesObject" {
            for key in [base.clone(), stem_of(&base).to_string()] {
                let v = content_names.entry(format!("{top}/{key}")).or_default();
                if !v.contains(&n) {
                    v.push(n.clone());
                }
            }
        }
        if matches!(
            top,
            "Images" | "Objects" | "FNPages" | "FNPagesObject" | "FNPagesFullScreenText"
        ) {
            asset_names.entry(base.clone()).or_insert_with(|| n.clone());
            asset_names
                .entry(stem_of(&base).to_string())
                .or_insert_with(|| n.clone());
        }
    }

    let mut out = Vec::new();
    let mut dropped = 0u32;
    // Asset bytes by entry name, read once; every copy handed to a page is charged to the zip
    // budget, and a page shows each asset at most once.
    let mut asset_cache: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    for (i, rec) in pages.iter().enumerate() {
        if *remaining == 0 {
            dropped += 1;
            continue;
        }
        *remaining -= 1;
        check_deadline(limits)?;
        budget.start_page();
        let (w, h) = sizes.get(&rec.id).copied().unwrap_or(DEFAULT_PAGE);
        let mut page = ImportPage {
            source_id: rec.id.clone(),
            title: Some(
                titles
                    .get(&rec.id)
                    .cloned()
                    .unwrap_or_else(|| format!("Page {}", i + 1)),
            ),
            width: w,
            height: h,
            background: rec
                .template
                .as_ref()
                .map(|(t, d)| background_of(t, *d))
                .transpose()?
                .unwrap_or_default(),
            ..ImportPage::default()
        };
        let contents = content_ids(rec, &layers);
        let mut items: Vec<Item> = Vec::new();
        let mut seq = 0usize;
        for (layer_no, content_id) in contents.iter().enumerate() {
            for key in ["FNPages", "FNPagesObject"] {
                let Some(names) = content_names.get(&format!("{key}/{content_id}")) else {
                    continue;
                };
                for name in names {
                    let Some(bytes) = read(src, name)? else {
                        continue;
                    };
                    read_content(&bytes, layer_no, &mut seq, &mut items, &mut page.skipped, budget)?;
                }
            }
        }
        items.sort_by(|a, b| (a.layer, a.at, &a.key, a.seq).cmp(&(b.layer, b.at, &b.key, b.seq)));
        let count = items.len() as i64;
        let mut placed_assets: HashSet<String> = HashSet::new();
        for (rank, item) in items.into_iter().enumerate() {
            let z = rank as i64 - count;
            match item.kind {
                Kind::Stroke(mut s) => {
                    s.z_index = z;
                    page.strokes.push(s);
                }
                Kind::Text(t) => page.texts.push(t),
                Kind::Image(id, frame) => {
                    let Some(name) = asset_names.get(&id) else {
                        page.skipped.other = page.skipped.other.saturating_add(1);
                        continue;
                    };
                    if !placed_assets.insert(name.clone()) {
                        // The same picture again on this page.
                        page.skipped.other = page.skipped.other.saturating_add(1);
                        continue;
                    }
                    if !asset_cache.contains_key(name) {
                        let b = read(src, name)?;
                        asset_cache.insert(name.clone(), b);
                    }
                    let bytes = asset_cache.get(name).cloned().flatten();
                    if let Some(b) = &bytes {
                        src.charge(b.len() as u64)?;
                    }
                    match bytes {
                        Some(bytes) => page.images.push(ImportImage {
                            x: frame.0,
                            y: frame.1,
                            width: frame.2,
                            height: frame.3,
                            mime: sniff_image(&bytes),
                            bytes,
                        }),
                        None => page.skipped.other = page.skipped.other.saturating_add(1),
                    }
                }
            }
        }
        out.push(page);
    }

    Ok(Note {
        section: ImportSection {
            source_id: dir_name.to_string(),
            title,
            pages: out,
        },
        canvas,
        dropped,
    })
}

/// Outline `4.4` entries `{1 id, 2 parent, 3 pageId, 4 title}` → page id → title (shallowest wins).
fn outline_titles(body: &Fields<'_>) -> Result<HashMap<String, String>, ImportError> {
    struct O {
        parent: Option<String>,
        page: String,
        title: String,
    }
    let mut by_id: HashMap<String, O> = HashMap::new();
    for w in all(body, 4) {
        let Some(b) = w.as_bytes() else { continue };
        let o = body.child(b)?;
        let (Some(id), Some(page)) = (string(&o, 1), string(&o, 3)) else {
            continue;
        };
        let title = string(&o, 4).unwrap_or_default();
        by_id.insert(
            id,
            O {
                parent: string(&o, 2).filter(|p| !p.is_empty()),
                page,
                title,
            },
        );
    }
    let depth = |start: &str| {
        let mut d = 0usize;
        let mut cur = by_id.get(start).and_then(|o| o.parent.as_deref());
        while let Some(p) = cur {
            d += 1;
            if d > 64 {
                break;
            }
            cur = by_id.get(p).and_then(|o| o.parent.as_deref());
        }
        d
    };
    let mut best: HashMap<String, (usize, String, String)> = HashMap::new();
    for (id, o) in &by_id {
        if o.title.trim().is_empty() {
            continue;
        }
        let d = depth(id);
        let better = match best.get(&o.page) {
            Some((bd, bid, _)) => (d, id) < (*bd, bid),
            None => true,
        };
        if better {
            best.insert(o.page.clone(), (d, id.clone(), o.title.clone()));
        }
    }
    Ok(best.into_iter().map(|(k, (_, _, t))| (k, t)).collect())
}

fn layout_sizes(bytes: &[u8]) -> Result<HashMap<String, (f64, f64)>, ImportError> {
    let mut out = HashMap::new();
    let top = Fields::top(bytes)?;
    for w in all(&top, 3) {
        let Some(b) = w.as_bytes() else { continue };
        let rec = top.child(b)?;
        let Some(id) = string(&rec, 5) else { continue };
        if let Some((w, h)) = pair(&rec, 1)?
            && w > 0.0
            && h > 0.0
        {
            out.insert(id, (w, h));
        }
    }
    Ok(out)
}

fn layer_info(bytes: &[u8]) -> Result<HashMap<String, Layer>, ImportError> {
    let mut out = HashMap::new();
    let top = Fields::top(bytes)?;
    for (i, w) in all(&top, 3).into_iter().enumerate() {
        let Some(b) = w.as_bytes() else { continue };
        let l = top.child(b)?;
        let Some(id) = string(&l, 1) else { continue };
        out.insert(
            id,
            Layer {
                visible: first(&l, 5).and_then(|w| w.as_bool()).unwrap_or(true),
                position: first(&l, 6).and_then(|w| w.as_i64()).unwrap_or(i as i64),
            },
        );
    }
    Ok(out)
}

/// The page's content ids in layer order: its own content first, then the visible layer mappings
/// sorted by layer position, duplicates dropped. The index in this list is the `layer` number.
fn content_ids(rec: &PageRec, layers: &HashMap<String, Layer>) -> Vec<String> {
    let mut out: Vec<String> = rec.content_id.iter().cloned().collect();
    let mut seen: HashSet<String> = out.iter().cloned().collect();
    let mut mapped: Vec<(i64, &String)> = Vec::new();
    for (layer, content) in &rec.layers {
        let l = layers.get(layer);
        if l.is_some_and(|l| !l.visible) {
            continue;
        }
        mapped.push((l.map_or(i64::MAX, |l| l.position), content));
    }
    mapped.sort_by_key(|(p, _)| *p);
    for (_, c) in mapped {
        if seen.insert(c.clone()) {
            out.push(c.clone());
        }
    }
    out
}

fn background_of(
    template: &[u8],
    template_parent_depth: u32,
) -> Result<ImportBackground, ImportError> {
    let t = Fields {
        v: pb::fields_at_depth(template, template_parent_depth)?.collect_all()?,
        depth: template_parent_depth + 1,
    };
    if first(&t, 2).and_then(|w| w.as_u64()).unwrap_or(0) != 0 {
        return Ok(ImportBackground::Plain);
    }
    let Some(paper) = sub(&t, 3)? else {
        return Ok(ImportBackground::Plain);
    };
    let idx = first(&paper, 2).and_then(|w| w.as_u64()).unwrap_or(0) as usize;
    let spacing = if (1..=PAPER_SPACING.len()).contains(&idx) {
        PAPER_SPACING[idx - 1]
    } else {
        42.5
    };
    Ok(match first(&paper, 1).and_then(|w| w.as_u64()) {
        Some(1) => ImportBackground::Lined { spacing },
        Some(2) => ImportBackground::Grid { spacing },
        Some(3) => ImportBackground::Dotted { spacing },
        _ => ImportBackground::Plain,
    })
}

fn sniff_image(b: &[u8]) -> Option<String> {
    let m = if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return None;
    };
    Some(m.into())
}

struct Item {
    layer: usize,
    at: i64,
    key: String,
    seq: usize,
    kind: Kind,
}

enum Kind {
    Stroke(ImportStroke),
    Text(ImportText),
    /// Asset id and frame (x, y, w, h).
    Image(String, (f64, f64, f64, f64)),
}

fn read_content(
    bytes: &[u8],
    layer: usize,
    seq: &mut usize,
    items: &mut Vec<Item>,
    skipped: &mut ImportSkipped,
    budget: &mut ImportBudget,
) -> Result<(), ImportError> {
    let rec = Fields::top(bytes)?;
    for w in all(&rec, 3) {
        let Some(b) = w.as_bytes() else { continue };
        if budget.page_full() {
            budget.skip(skipped)?;
            continue;
        }
        let entry = rec.child(b)?;
        let key = string(&entry, 1).unwrap_or_default();
        let Some(value) = sub(&entry, 2)? else {
            continue;
        };
        if first(&value, 5).is_some() {
            skipped.other += 1;
        }
        let Some(stroke) = sub(&value, 1)? else {
            continue;
        };
        let at = match sub(&stroke, 4)? {
            Some(path) => timestamp(&path, 3)?.unwrap_or(MISSING_AT),
            None => MISSING_AT,
        };
        if let Some(s) = read_stroke(&stroke, skipped)?
            && budget.admit(s.points.len(), skipped)?
        {
            *seq += 1;
            items.push(Item {
                layer,
                at,
                key,
                seq: *seq,
                kind: Kind::Stroke(s),
            });
        }
    }
    for w in all(&rec, 4) {
        let Some(b) = w.as_bytes() else { continue };
        if budget.page_full() {
            budget.skip(skipped)?;
            continue;
        }
        let entry = rec.child(b)?;
        let key = string(&entry, 1).unwrap_or_default();
        let Some(value) = sub(&entry, 2)? else {
            continue;
        };
        let Some(obj) = sub(&value, 1)? else { continue };
        let at = timestamp(&obj, 3)?.unwrap_or(MISSING_AT);
        let frame = match sub(&obj, 4)? {
            Some(f) => match (pair(&f, 1)?, pair(&f, 2)?) {
                (Some((x, y)), Some((w, h))) => Some((x, y, w, h)),
                _ => None,
            },
            None => None,
        };
        let kind = if let Some(img) = sub(&obj, 7)? {
            let mut ids = Vec::new();
            ids.extend(string(&img, 1));
            if let Some(inner) = sub(&img, 2)? {
                ids.extend(string(&inner, 2));
                ids.extend(string(&inner, 1));
            }
            match (frame, ids.into_iter().find(|i| !i.is_empty())) {
                (Some(f), Some(id)) => Some(Kind::Image(id, f)),
                _ => None,
            }
        } else {
            read_text(&obj, frame)?.map(Kind::Text)
        };
        match kind {
            Some(kind) => {
                if !budget.admit(0, skipped)? {
                    continue;
                }
                *seq += 1;
                items.push(Item {
                    layer,
                    at,
                    key,
                    seq: *seq,
                    kind,
                });
            }
            None => skipped.other += 1,
        }
    }
    Ok(())
}

/// Text at `object.6` (or `.10`) → `.6` → `.1`.
fn read_text(
    obj: &Fields<'_>,
    frame: Option<(f64, f64, f64, f64)>,
) -> Result<Option<ImportText>, ImportError> {
    let holder = match sub(obj, 6)? {
        Some(h) => Some(h),
        None => sub(obj, 10)?,
    };
    let Some(rich) = holder.map(|h| sub(&h, 6)).transpose()?.flatten() else {
        return Ok(None);
    };
    let Some(text) = string(&rich, 1).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let Some((x, y, w, _)) = frame else {
        return Ok(None);
    };
    let mut font_size = None;
    let mut color = "#000000".to_string();
    if let Some(run) = all(&rich, 2).first().and_then(|r| r.as_bytes()) {
        let run = rich.child(run)?;
        font_size = sub(&run, 1)?.and_then(|f| num(&f, 1)).filter(|s| *s > 0.0);
        if let Some(c) = sub(&run, 5)?
            .and_then(|c| first(&c, 1))
            .and_then(|c| c.as_u64())
        {
            color = unpack_color(c).0;
        }
    }
    Ok(Some(ImportText {
        x,
        y,
        width: Some(w).filter(|w| *w > 0.0),
        text,
        font_size,
        color,
    }))
}

struct Pt {
    x: f64,
    y: f64,
    nib: Option<f64>,
    muted: bool,
    power: Option<f64>,
}

fn read_stroke(
    stroke: &Fields<'_>,
    skipped: &mut ImportSkipped,
) -> Result<Option<ImportStroke>, ImportError> {
    let ink = sub(stroke, 2)?.unwrap_or_default();
    let ink_type = first(&ink, 1).and_then(|w| w.as_u64());
    if ink_type == Some(101) {
        skipped.other += 1;
        return Ok(None);
    }
    let (color, alpha) = unpack_color(first(&ink, 2).and_then(|w| w.as_u64()).unwrap_or(0));
    let highlighter =
        matches!(ink_type, Some(2 | 4)) || (alpha > 0 && f64::from(alpha) / 255.0 < 0.6);
    let pencil = !highlighter && ink_type == Some(3);

    let Some(path) = sub(stroke, 4)? else {
        skipped.other += 1;
        return Ok(None);
    };
    let mut pts: Vec<Pt> = Vec::new();
    for w in all(&path, 2) {
        let Some(b) = w.as_bytes() else { continue };
        let p = path.child(b)?;
        let Some((x, y)) = pair(&p, 1)? else { continue };
        let nib = sub(&p, 3)?.and_then(|n| num(&n, 1));
        let muted = num(&p, 5).is_some_and(|v| v <= 0.0);
        let power = num(&p, 10);
        // Intermediate points come before the point itself.
        for im in all(&p, 11) {
            if let Some(b) = im.as_bytes() {
                let q = p.child(b)?;
                if let (Some(ix), Some(iy)) = (num(&q, 1), num(&q, 2))
                    && (ix, iy) != (x, y)
                {
                    pts.push(Pt {
                        x: ix,
                        y: iy,
                        nib,
                        muted,
                        power,
                    });
                }
            }
        }
        pts.push(Pt {
            x,
            y,
            nib,
            muted,
            power,
        });
    }
    let mut shape_points: Option<Vec<ImportPoint>> = None;
    let mut shape_nib = None;
    if let Some(shape) = sub(&path, 4)? {
        shape_nib = num(&shape, 3).filter(|n| *n > 0.0);
        let kind = first(&shape, 1).and_then(|w| w.as_u64());
        if matches!(kind, Some(1001 | 1002 | 2001..=2004)) {
            let c = match first(&shape, 2) {
                Some(w) => w.packed_f64()?,
                None => Vec::new(),
            };
            match shape_outline(kind.unwrap_or(0), &c) {
                Some(poly) => {
                    shape_points = Some(
                        poly.into_iter()
                            .map(|(x, y)| ImportPoint {
                                x,
                                y,
                                pressure: Some(1.0),
                            })
                            .collect(),
                    );
                }
                None => {
                    skipped.shapes += 1;
                    return Ok(None);
                }
            }
        }
    }

    let max_nib = pts
        .iter()
        .filter_map(|p| p.nib)
        .chain(shape_nib)
        .fold(0.0_f64, f64::max);
    let nib_w = if max_nib > 0.0 { max_nib } else { DEFAULT_NIB };
    let width = (2.0 * nib_w - 4.0).max(1.0);

    let affine = sub(stroke, 3)?;
    let a = |n: u32, d: f64| affine.as_ref().and_then(|f| num(f, n)).unwrap_or(d);
    let (ma, mb, mc, md, tx, ty) = (
        a(1, 1.0),
        a(2, 0.0),
        a(3, 0.0),
        a(4, 1.0),
        a(5, 0.0),
        a(6, 0.0),
    );
    let map = |x: f64, y: f64| (ma * x + mc * y + tx, mb * x + md * y + ty);

    let points: Vec<ImportPoint> = match shape_points {
        Some(sp) => sp
            .into_iter()
            .map(|p| {
                let (x, y) = map(p.x, p.y);
                ImportPoint {
                    x,
                    y,
                    pressure: p.pressure,
                }
            })
            .collect(),
        None => pts
            .iter()
            .map(|p| {
                let pressure = if p.muted {
                    Some(0.01)
                } else if pencil && p.power.is_some() {
                    p.power.map(|v| v.clamp(0.01, 1.0))
                } else {
                    match (p.nib, max_nib > 0.0) {
                        (Some(n), true) => Some((n / max_nib).clamp(0.01, 1.0)),
                        _ => None,
                    }
                };
                let (x, y) = map(p.x, p.y);
                ImportPoint { x, y, pressure }
            })
            .collect(),
    };
    if points.is_empty() {
        skipped.other += 1;
        return Ok(None);
    }
    Ok(Some(ImportStroke {
        points,
        color,
        opacity: if highlighter {
            0.5
        } else if pencil {
            0.39
        } else {
            1.0
        },
        width,
        is_highlighter: highlighter,
        pen_style: if highlighter {
            PenStyle::Highlighter
        } else if pencil {
            PenStyle::Pencil
        } else {
            PenStyle::Pen
        },
        z_index: 0,
    }))
}

/// Number of points of an approximated ellipse (the last one repeats the first).
const ELLIPSE_POINTS: usize = 36;

/// The polyline of a shape record from its packed coordinates.
///
/// 1001/1002: the coordinate pairs as they are. 2001 rectangle: four corners (8 values) or
/// `x, y, w, h` (4 values), closed. 2004 triangle: three corners (6 values), closed. 2002 ellipse
/// and 2003 circle: [`ELLIPSE_POINTS`] points on the bounding box `x, y, w, h` (4 values; a circle
/// may also give `cx, cy, r`). Anything else is `None`.
fn shape_outline(kind: u64, c: &[f64]) -> Option<Vec<(f64, f64)>> {
    if c.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let closed = |mut v: Vec<(f64, f64)>| {
        if let Some(&f) = v.first() {
            v.push(f);
        }
        v
    };
    let pairs =
        |c: &[f64]| -> Vec<(f64, f64)> { c.chunks_exact(2).map(|p| (p[0], p[1])).collect() };
    match (kind, c.len()) {
        (1001 | 1002, n) if n >= 2 => Some(pairs(c)),
        (2001, 8) | (2004, 6) => Some(closed(pairs(c))),
        (2001, 4) => Some(closed(vec![
            (c[0], c[1]),
            (c[0] + c[2], c[1]),
            (c[0] + c[2], c[1] + c[3]),
            (c[0], c[1] + c[3]),
        ])),
        (2002 | 2003, 4) | (2003, 3) => {
            let (cx, cy, rx, ry) = if c.len() == 3 {
                (c[0], c[1], c[2], c[2])
            } else {
                (c[0] + c[2] / 2.0, c[1] + c[3] / 2.0, c[2] / 2.0, c[3] / 2.0)
            };
            Some(
                (0..ELLIPSE_POINTS)
                    .map(|i| {
                        let a = std::f64::consts::TAU * i as f64 / (ELLIPSE_POINTS - 1) as f64;
                        (cx + rx * a.cos(), cy + ry * a.sin())
                    })
                    .collect(),
            )
        }
        _ => None,
    }
}
