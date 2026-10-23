//! Notability (`.note`): a zip holding `<Note>/Session.plist`, an NSKeyedArchiver binary plist,
//! plus `<Note>/Images/*` for inserted pictures.
//!
//! Ink lives in every `$objects` dictionary that has a `curvespoints` key (raw little-endian
//! arrays: `curvesnumpoints` i32 per stroke, `curvespoints` f32 x/y pairs, `curveswidth` f32,
//! `curvescolors` u8 RGBA, optional `curvesfractionalwidths` f32 per cubic node). Text boxes and
//! images are the `richText.mediaObjects` of the session dictionary. A note is one tall canvas,
//! so it becomes one Mate page whose height is the lowest content.
//!
//! The plist is decoded through the `plist` crate's event reader into a small tree under an
//! event/byte budget and a nesting cap (binary plists may share objects, so a tiny file could
//! otherwise expand without bound). UID references are resolved by hand, refusing any reference
//! back to an object on the current walk path (a cycle) as `Corrupt`.

use std::io::Cursor;

use plist::stream::{BinaryReader, Event};

use super::zipsrc::is_safe_name;
use super::{
    ImportBackground, ImportDocument, ImportError, ImportImage, ImportLimits, ImportPage,
    ImportPoint, ImportSection, ImportSkipped, ImportSource, ImportStroke, ImportText, ZipSource,
    base_name, check_deadline,
};
use crate::model::{PageMode, PenStyle};

/// Deepest collection nesting accepted in the plist.
const MAX_NESTING: usize = 128;
/// Longest walk path / UID chain followed.
const MAX_PATH: usize = 64;
/// Page width when the note does not record one (Mate's sheet, scale 1).
const DEFAULT_WIDTH: f64 = 1080.0;
const DEFAULT_HEIGHT: f64 = 1440.0;
/// A stroke is a highlighter when its alpha is below this.
const HIGHLIGHTER_ALPHA: u8 = 200;
const HIGHLIGHTER_OPACITY: f64 = 0.5;
const SESSION_FILE: &str = "Session.plist";

fn corrupt(msg: impl Into<String>) -> ImportError {
    ImportError::Corrupt(msg.into())
}

/// Reads a zip entry; a password-protected entry is `Encrypted`.
fn read(src: &mut ZipSource, name: &str) -> Result<Option<Vec<u8>>, ImportError> {
    src.entry(name).map_err(|e| match &e {
        ImportError::Corrupt(m) if m.to_ascii_lowercase().contains("password") => {
            ImportError::Encrypted
        }
        _ => e,
    })
}

// ---------------------------------------------------------------------------------------------
// Binary plist → tree

#[derive(Debug)]
enum Node {
    Bool(bool),
    Num(f64),
    Str(String),
    Data(Vec<u8>),
    Uid(u64),
    Array(Vec<Node>),
    Dict(Vec<(String, Node)>),
    /// Dates and anything else Mate does not read.
    Other,
}

enum Frame {
    Array(Vec<Node>),
    Dict { items: Vec<(String, Node)>, key: Option<String> },
}

/// Decodes a binary plist into a [`Node`] tree. `Corrupt` for anything malformed, `Limit` when
/// the decoded tree would be far larger than the file (shared-object expansion).
fn decode(bytes: &[u8], limits: &ImportLimits) -> Result<Node, ImportError> {
    let max_events = (bytes.len() as u64).saturating_mul(16).saturating_add(4096);
    let max_payload = (bytes.len() as u64).saturating_mul(8).saturating_add(1 << 20);
    let too_big = || ImportError::Limit("its note data expands to too much".into());
    let (mut events, mut payload) = (0u64, 0u64);
    let mut stack: Vec<Frame> = Vec::new();
    let mut root: Option<Node> = None;

    for event in BinaryReader::new(Cursor::new(bytes)) {
        let event = event.map_err(|e| corrupt(format!("Session.plist: {e}")))?;
        events += 1;
        if events > max_events {
            return Err(too_big());
        }
        if events.is_multiple_of(4096) {
            check_deadline(limits)?;
        }
        let node = match event {
            Event::StartArray(_) | Event::StartDictionary(_) => {
                if stack.len() >= MAX_NESTING {
                    return Err(corrupt("Session.plist is nested too deeply"));
                }
                stack.push(match event {
                    Event::StartArray(_) => Frame::Array(Vec::new()),
                    _ => Frame::Dict { items: Vec::new(), key: None },
                });
                continue;
            }
            Event::EndCollection => match stack.pop() {
                Some(Frame::Array(v)) => Node::Array(v),
                Some(Frame::Dict { items, key: None }) => Node::Dict(items),
                _ => return Err(corrupt("Session.plist has an unbalanced collection")),
            },
            Event::Boolean(b) => Node::Bool(b),
            Event::Integer(i) => Node::Num(
                i.as_signed().map(|v| v as f64).or(i.as_unsigned().map(|v| v as f64)).unwrap_or(0.0),
            ),
            Event::Real(r) => Node::Num(r),
            Event::String(s) => {
                payload = payload.saturating_add(s.len() as u64);
                Node::Str(s.into_owned())
            }
            Event::Data(d) => {
                payload = payload.saturating_add(d.len() as u64);
                Node::Data(d.into_owned())
            }
            Event::Uid(u) => Node::Uid(u.get()),
            _ => Node::Other,
        };
        if payload > max_payload {
            return Err(too_big());
        }
        match stack.last_mut() {
            None if root.is_none() => root = Some(node),
            None => return Err(corrupt("Session.plist has more than one root")),
            Some(Frame::Array(v)) => v.push(node),
            Some(Frame::Dict { items, key }) => match key.take() {
                Some(k) => items.push((k, node)),
                None => match node {
                    Node::Str(s) => *key = Some(s),
                    _ => return Err(corrupt("Session.plist has a non-string dictionary key")),
                },
            },
        }
    }
    if !stack.is_empty() {
        return Err(corrupt("Session.plist ends inside a collection"));
    }
    root.ok_or_else(|| corrupt("Session.plist is empty"))
}

fn direct<'a>(node: &'a Node, key: &str) -> Option<&'a Node> {
    match node {
        Node::Dict(items) => items.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Keyed archive

struct Archive {
    objects: Vec<Node>,
}

/// A node reached by a walk, with the `$objects` indices dereferenced on the way to it.
#[derive(Clone)]
struct Obj<'a> {
    node: &'a Node,
    path: Vec<usize>,
}

impl Archive {
    fn from_root(root: Node) -> Result<Archive, ImportError> {
        let Node::Dict(items) = root else {
            return Err(corrupt("not a keyed archive (no $objects)"));
        };
        let objects = items.into_iter().find(|(k, _)| k == "$objects").map(|(_, v)| v);
        match objects {
            Some(Node::Array(objects)) => Ok(Archive { objects }),
            _ => Err(corrupt("not a keyed archive (no $objects)")),
        }
    }

    /// The `$objects` entry `i` as the start of a walk.
    fn object(&self, i: usize) -> Obj<'_> {
        Obj { node: &self.objects[i], path: vec![i] }
    }

    /// Follows UID references from `node`; a reference to an object already on `path` is a
    /// cycle (`Corrupt`).
    fn deref<'a>(&'a self, node: &'a Node, path: &[usize]) -> Result<Obj<'a>, ImportError> {
        let mut node = node;
        let mut path = path.to_vec();
        while let Node::Uid(n) = node {
            let i = usize::try_from(*n).map_err(|_| corrupt("keyed archive UID out of range"))?;
            node = self.objects.get(i).ok_or_else(|| corrupt("keyed archive UID out of range"))?;
            if path.contains(&i) {
                return Err(corrupt("keyed archive references itself (cycle)"));
            }
            path.push(i);
            if path.len() > MAX_PATH {
                return Err(corrupt("keyed archive references nest too deeply"));
            }
        }
        Ok(Obj { node, path })
    }
}

impl<'a> Obj<'a> {
    fn deref(&self, a: &'a Archive, node: &'a Node) -> Result<Obj<'a>, ImportError> {
        a.deref(node, &self.path)
    }

    fn direct(&self, key: &str) -> Option<&'a Node> {
        direct(self.node, key)
    }

    /// Value of `key`: a plain keyed-object field, an `NS.keys`/`NS.objects` dictionary entry,
    /// or an `NS.key.<i>`/`NS.object.<i>` pair.
    fn get(&self, a: &'a Archive, key: &str) -> Result<Option<Obj<'a>>, ImportError> {
        let Node::Dict(items) = self.node else { return Ok(None) };
        if let Some(v) = self.direct(key) {
            return self.deref(a, v).map(Some);
        }
        if let (Some(keys), Some(values)) = (self.direct("NS.keys"), self.direct("NS.objects")) {
            let keys = self.deref(a, keys)?;
            let values = self.deref(a, values)?;
            let (Node::Array(keys_v), Node::Array(values_v)) = (keys.node, values.node) else {
                return Err(corrupt("keyed archive dictionary is malformed"));
            };
            for (i, k) in keys_v.iter().enumerate() {
                if keys.deref(a, k)?.string(a)?.as_deref() == Some(key) {
                    let v = values_v
                        .get(i)
                        .ok_or_else(|| corrupt("keyed archive dictionary is malformed"))?;
                    return values.deref(a, v).map(Some);
                }
            }
            return Ok(None);
        }
        for (name, k) in items {
            let Some(index) = name.strip_prefix("NS.key.") else { continue };
            if self.deref(a, k)?.string(a)?.as_deref() == Some(key) {
                return match self.direct(&format!("NS.object.{index}")) {
                    Some(v) => self.deref(a, v).map(Some),
                    None => Ok(None),
                };
            }
        }
        Ok(None)
    }

    /// Elements of an array: a plain array, `NS.objects`, or `NS.object.<i>` keys.
    fn items(&self, a: &'a Archive) -> Result<Vec<Obj<'a>>, ImportError> {
        match self.node {
            Node::Array(v) => v.iter().map(|n| self.deref(a, n)).collect(),
            Node::Dict(items) => {
                if let Some(objs) = self.direct("NS.objects") {
                    let list = self.deref(a, objs)?;
                    return match list.node {
                        Node::Array(v) => v.iter().map(|n| list.deref(a, n)).collect(),
                        _ => Err(corrupt("keyed archive array is malformed")),
                    };
                }
                let mut out = Vec::new();
                for i in 0..items.len() {
                    match self.direct(&format!("NS.object.{i}")) {
                        Some(n) => out.push(self.deref(a, n)?),
                        None => break,
                    }
                }
                Ok(out)
            }
            _ => Ok(Vec::new()),
        }
    }

    /// A string: plain, `NS.string`, or UTF-8 `NS.bytes`.
    fn string(&self, a: &'a Archive) -> Result<Option<String>, ImportError> {
        match self.node {
            Node::Str(s) => Ok(Some(s.clone())),
            Node::Dict(_) => {
                if let Some(s) = self.direct("NS.string") {
                    return self.deref(a, s)?.string(a);
                }
                if let Some(b) = self.direct("NS.bytes") {
                    return Ok(self
                        .deref(a, b)?
                        .data(a)?
                        .map(|d| String::from_utf8_lossy(d).into_owned()));
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// Raw bytes: a plist `<data>` or an `NS.data` wrapper.
    fn data(&self, a: &'a Archive) -> Result<Option<&'a [u8]>, ImportError> {
        match self.node {
            Node::Data(d) => Ok(Some(d)),
            Node::Dict(_) => match self.direct("NS.data") {
                Some(d) => match self.deref(a, d)?.node {
                    Node::Data(d) => Ok(Some(d)),
                    _ => Ok(None),
                },
                None => Ok(None),
            },
            _ => Ok(None),
        }
    }

    fn number(&self) -> Option<f64> {
        match self.node {
            Node::Num(n) if n.is_finite() => Some(*n),
            Node::Bool(b) => Some(f64::from(u8::from(*b))),
            _ => None,
        }
    }

    fn boolean(&self) -> Option<bool> {
        match self.node {
            Node::Bool(b) => Some(*b),
            Node::Num(n) => Some(*n != 0.0),
            _ => None,
        }
    }

    fn class_name(&self, a: &'a Archive) -> Result<Option<String>, ImportError> {
        match self.get(a, "$class")? {
            Some(class) => match class.get(a, "$classname")? {
                Some(name) => name.string(a),
                None => Ok(None),
            },
            None => Ok(None),
        }
    }

    /// `get` along a chain of keys.
    fn at(&self, a: &'a Archive, keys: &[&str]) -> Result<Option<Obj<'a>>, ImportError> {
        let mut cur = self.clone();
        for k in keys {
            match cur.get(a, k)? {
                Some(next) => cur = next,
                None => return Ok(None),
            }
        }
        Ok(Some(cur))
    }

    fn string_at(&self, a: &'a Archive, keys: &[&str]) -> Result<Option<String>, ImportError> {
        match self.at(a, keys)? {
            Some(o) => o.string(a),
            None => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Little-endian arrays

fn le_f32s(bytes: &[u8], what: &str) -> Result<Vec<f32>, ImportError> {
    if !bytes.len().is_multiple_of(4) {
        return Err(corrupt(format!("{what} has a partial value")));
    }
    Ok(bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

fn le_i32s(bytes: &[u8], what: &str) -> Result<Vec<i32>, ImportError> {
    if !bytes.len().is_multiple_of(4) {
        return Err(corrupt(format!("{what} has a partial value")));
    }
    Ok(bytes.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

// ---------------------------------------------------------------------------------------------
// Strokes

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let n = values.len();
    Some(if n % 2 == 1 { values[n / 2] } else { (values[n / 2 - 1] + values[n / 2]) / 2.0 })
}

/// Width of point `r` of a stroke with fractional node widths `frac` (one per cubic node).
fn fractional_width(width: f64, frac: &[f32], r: usize) -> f64 {
    let o = r / 3;
    let f = if o + 1 >= frac.len() {
        f64::from(frac[frac.len() - 1])
    } else {
        let (f0, f1) = (f64::from(frac[o]), f64::from(frac[o + 1]));
        f0 + (f1 - f0) * ((r - 3 * o) as f64 / 3.0)
    };
    let f = if f.is_finite() { f } else { 1.0 };
    width * f.clamp(0.2, 3.0)
}

fn is_highlighter(rgba: [u8; 4], highlighter_behind_text: bool) -> bool {
    let [r, g, b, alpha] = rgba;
    if alpha < HIGHLIGHTER_ALPHA {
        return true;
    }
    if !highlighter_behind_text {
        return false;
    }
    let luma = (0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b)) / 255.0;
    let spread = r.max(g).max(b) - r.min(g).min(b);
    luma > 0.55 && spread > 40
}

struct Ink {
    strokes: Vec<ImportStroke>,
    max_y: f64,
    shapes: u32,
}

/// Appends the strokes of one curves dictionary.
fn read_curves(
    a: &Archive,
    curves: &Obj<'_>,
    highlighter_behind_text: bool,
    ink: &mut Ink,
    limits: &ImportLimits,
) -> Result<(), ImportError> {
    let field = |key: &str| -> Result<&[u8], ImportError> {
        match curves.get(a, key)? {
            Some(o) => o.data(a)?.ok_or_else(|| corrupt(format!("{key} is not data"))),
            None => Err(corrupt(format!("missing {key}"))),
        }
    };
    let counts = le_i32s(field("curvesnumpoints")?, "curvesnumpoints")?;
    let points = le_f32s(field("curvespoints")?, "curvespoints")?;
    let widths = le_f32s(field("curveswidth")?, "curveswidth")?;
    let colors = field("curvescolors")?;
    let strokes = counts.len();

    let mut total: u64 = 0;
    let mut nodes: u64 = 0;
    let mut cubic = true;
    for &n in &counts {
        let n = u64::try_from(n).map_err(|_| corrupt("negative point count in curvesnumpoints"))?;
        total += n;
        cubic &= n > 0 && (n - 1) % 3 == 0;
        nodes += if n > 0 { (n - 1) / 3 + 1 } else { 0 };
    }
    if points.len() as u64 != total.saturating_mul(2) {
        return Err(corrupt("curvespoints does not match curvesnumpoints"));
    }
    if widths.len() != strokes {
        return Err(corrupt("curveswidth does not match curvesnumpoints"));
    }
    if colors.len() != strokes.saturating_mul(4) {
        return Err(corrupt("curvescolors does not match curvesnumpoints"));
    }
    let fractional = match curves.get(a, "curvesfractionalwidths")? {
        Some(o) => match o.data(a)? {
            Some(d) if d.len().is_multiple_of(4) => Some(le_f32s(d, "curvesfractionalwidths")?),
            _ => None,
        },
        None => None,
    }
    .filter(|f| cubic && f.len() as u64 == nodes);
    if let Some(shapes) = curves.get(a, "shapes")?
        && shapes.data(a)?.is_some_and(|d| !d.is_empty())
    {
        ink.shapes += 1;
    }

    let (mut point_at, mut node_at) = (0usize, 0usize);
    for (i, &n) in counts.iter().enumerate() {
        if i % 1024 == 0 {
            check_deadline(limits)?;
        }
        let n = n as usize; // non-negative, checked above
        let xy = &points[point_at * 2..(point_at + n) * 2];
        point_at += n;
        let frac = fractional.as_ref().map(|f| {
            let k = (n - 1) / 3 + 1;
            let s = &f[node_at..node_at + k];
            node_at += k;
            s
        });

        let rgba = [colors[4 * i], colors[4 * i + 1], colors[4 * i + 2], colors[4 * i + 3]];
        let highlighter = is_highlighter(rgba, highlighter_behind_text);
        let base = f64::from(widths[i]);
        let base = if base.is_finite() { base } else { 1.0 };
        let width = match frac {
            Some(frac) if !highlighter => {
                let mut per_point: Vec<f64> =
                    (0..n).map(|r| fractional_width(base, frac, r)).collect();
                median(&mut per_point).unwrap_or(base).max(1.0)
            }
            _ => base.max(1.0),
        };

        let pts: Vec<ImportPoint> = xy
            .chunks_exact(2)
            .map(|p| (f64::from(p[0]), f64::from(p[1])))
            .filter(|(x, y)| x.is_finite() && y.is_finite())
            .map(|(x, y)| ImportPoint { x, y, pressure: None })
            .collect();
        if pts.is_empty() {
            continue;
        }
        for p in &pts {
            ink.max_y = ink.max_y.max(p.y);
        }
        let z_index = ink.strokes.len() as i64;
        ink.strokes.push(ImportStroke {
            points: pts,
            color: format!("#{:02x}{:02x}{:02x}", rgba[0], rgba[1], rgba[2]),
            opacity: if highlighter { HIGHLIGHTER_OPACITY } else { 1.0 },
            width,
            is_highlighter: highlighter,
            pen_style: if highlighter { PenStyle::Highlighter } else { PenStyle::Pen },
            z_index,
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Media objects, paper

/// `"{a, b}"` → `(a, b)`.
fn pair(s: &str) -> Option<(f64, f64)> {
    let inner = s.trim().strip_prefix('{')?.strip_suffix('}')?;
    let (x, y) = inner.split_once(',')?;
    let (x, y) = (x.trim().parse::<f64>().ok()?, y.trim().parse::<f64>().ok()?);
    (x.is_finite() && y.is_finite()).then_some((x, y))
}

/// `"r,g,b[,a]"` floats (0..1, or 0..255 when any channel exceeds 1) → `#rrggbb`.
fn cross_platform_color(s: &str) -> Option<String> {
    let v: Vec<f64> = s.split(',').map(|c| c.trim().parse::<f64>()).collect::<Result<_, _>>().ok()?;
    if v.len() < 3 || v.iter().any(|c| !c.is_finite()) {
        return None;
    }
    let scale = if v[..3].iter().all(|c| *c <= 1.0) { 255.0 } else { 1.0 };
    let ch = |c: f64| (c * scale).round().clamp(0.0, 255.0) as u8;
    Some(format!("#{:02x}{:02x}{:02x}", ch(v[0]), ch(v[1]), ch(v[2])))
}

struct Media {
    texts: Vec<ImportText>,
    images: Vec<ImportImage>,
    max_y: f64,
    other: u32,
}

fn read_text(a: &Archive, obj: &Obj<'_>, media: &mut Media) -> Result<(), ImportError> {
    let Some(attributed) = obj.at(a, &["textStore", "attributedString"])? else {
        return Ok(());
    };
    let Some(text) = attributed.string_at(a, &["stringKey"])? else { return Ok(()) };
    if text.trim().is_empty() {
        return Ok(());
    }
    let (x, y) = obj.string_at(a, &["documentOrigin"])?.as_deref().and_then(pair).unwrap_or((0.0, 0.0));
    let size = obj.string_at(a, &["unscaledContentSize"])?.as_deref().and_then(pair);
    let (mut font_size, mut color) = (None, None);
    if let Some(ranges) = attributed.get(a, "subRangesKey")?
        && let Some(first) = ranges.items(a)?.into_iter().next()
    {
        font_size = first
            .at(a, &["subRangeFontKey", "NSFontSizeAttribute"])?
            .and_then(|o| o.number())
            .filter(|s| *s > 0.0);
        color = first
            .string_at(a, &["subRangeColorCrossPlatformKey"])?
            .as_deref()
            .and_then(cross_platform_color);
    }
    let width = size.map(|(w, _)| w).filter(|w| *w > 0.0);
    media.max_y = media.max_y.max(y + size.map_or(0.0, |(_, h)| h.max(0.0)));
    media.texts.push(ImportText {
        x,
        y,
        width,
        text,
        font_size,
        color: color.unwrap_or_else(|| "#000000".into()),
    });
    Ok(())
}

fn read_image(
    a: &Archive,
    obj: &Obj<'_>,
    dir: &str,
    src: &mut ZipSource,
    media: &mut Media,
) -> Result<(), ImportError> {
    let Some(snapshot) =
        obj.at(a, &["figure", "FigureBackgroundObjectKey", "kImageObjectSnapshotKey"])?
    else {
        media.other += 1;
        return Ok(());
    };
    let missing = snapshot.get(a, "imageIsMissing")?.and_then(|o| o.boolean()).unwrap_or(false);
    let rel = snapshot.string_at(a, &["relativePath"])?;
    let origin = obj.string_at(a, &["documentOrigin"])?.as_deref().and_then(pair);
    let size = obj.string_at(a, &["unscaledContentSize"])?.as_deref().and_then(pair);
    let (Some(rel), Some((x, y)), Some((w, h)), false) = (rel, origin, size, missing) else {
        media.other += 1;
        return Ok(());
    };
    let path = if dir.is_empty() { rel } else { format!("{dir}/{rel}") };
    let bytes = if w > 0.0 && h > 0.0 && is_safe_name(&path) { read(src, &path)? } else { None };
    let Some(bytes) = bytes else {
        media.other += 1;
        return Ok(());
    };
    let Some(kind) = infer::get(&bytes).filter(|t| t.matcher_type() == infer::MatcherType::Image)
    else {
        media.other += 1;
        return Ok(());
    };
    media.max_y = media.max_y.max(y + h);
    media.images.push(ImportImage {
        x,
        y,
        width: w,
        height: h,
        mime: Some(kind.mime_type().to_owned()),
        bytes,
    });
    Ok(())
}

/// `"<Dots|Grid|Lines>:<inches>"` → background, spacing `round(96 · inches)`.
fn line_style(s: &str) -> Option<ImportBackground> {
    let (kind, inches) = s.split_once(':').unwrap_or((s, ""));
    let spacing = inches.trim().parse::<f64>().ok().filter(|i| i.is_finite() && *i > 0.0);
    let spacing = |default: f64| spacing.map_or(default, |i| (96.0 * i).round());
    match kind.trim() {
        "Dots" => Some(ImportBackground::Dotted { spacing: spacing(24.0) }),
        "Grid" => Some(ImportBackground::Grid { spacing: spacing(24.0) }),
        "Lines" => Some(ImportBackground::Lined { spacing: spacing(32.0) }),
        _ => None,
    }
}

fn paper(a: &Archive, session: &Obj<'_>) -> Result<ImportBackground, ImportError> {
    let style = session.string_at(
        a,
        &["NBNoteTakingSessionDocumentPaperLayoutModelKey", "documentPaperAttributes", "lineStyle2"],
    )?;
    if let Some(bg) = style.as_deref().and_then(line_style) {
        return Ok(bg);
    }
    Ok(match session.get(a, "paperLineStyle")?.and_then(|o| o.number()) {
        Some(5.0) => ImportBackground::Grid { spacing: 24.0 },
        Some(2.0) => ImportBackground::Lined { spacing: 32.0 },
        _ => ImportBackground::Plain,
    })
}

// ---------------------------------------------------------------------------------------------

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    check_deadline(limits)?;
    let names = src.names();
    let session_name = names
        .iter()
        .filter(|n| base_name(n) == SESSION_FILE)
        .min_by_key(|n| (n.matches('/').count(), n.as_str()))
        .cloned()
        .ok_or_else(|| corrupt("no Session.plist in the .note package"))?;
    let dir = session_name.rsplit_once('/').map_or("", |(d, _)| d).to_owned();
    let pdfs = names
        .iter()
        .filter(|n| {
            let lower = n.to_ascii_lowercase();
            lower.contains("/pdfs/") && lower.ends_with(".pdf")
        })
        .count();

    let bytes = read(src, &session_name)?.ok_or_else(|| corrupt("Session.plist is missing"))?;
    if !bytes.starts_with(b"bplist00") {
        return Err(corrupt("Session.plist is not a binary plist"));
    }
    let archive = Archive::from_root(decode(&bytes, limits)?)?;
    drop(bytes);
    let a = &archive;
    check_deadline(limits)?;

    // Flat scans of `$objects`, as Derive does.
    let mut session = None;
    let mut page_width = None;
    let mut highlighter_behind_text = false;
    let mut curves = Vec::new();
    for i in 0..a.objects.len() {
        let obj = a.object(i);
        if !matches!(obj.node, Node::Dict(_)) {
            continue;
        }
        if session.is_none() && obj.direct("richText").is_some() {
            session = Some(obj.clone());
        }
        if page_width.is_none()
            && obj.direct("pageWidthInDocumentCoordsKey").is_some()
            && let Some(w) = obj.get(a, "pageWidthInDocumentCoordsKey")?.and_then(|o| o.number())
            && w > 0.0
        {
            page_width = Some(w);
        }
        if obj.direct("NBNoteTakingSessionIsHighlighterBehindTextKey").is_some() {
            highlighter_behind_text |= obj
                .get(a, "NBNoteTakingSessionIsHighlighterBehindTextKey")?
                .and_then(|o| o.boolean())
                .unwrap_or(false);
        }
        if obj.direct("curvespoints").is_some() {
            curves.push(obj);
        }
    }
    if curves.is_empty() {
        return Err(corrupt("missing curvespoints"));
    }

    let mut ink = Ink { strokes: Vec::new(), max_y: 0.0, shapes: 0 };
    for c in &curves {
        read_curves(a, c, highlighter_behind_text, &mut ink, limits)?;
    }

    let mut media = Media { texts: Vec::new(), images: Vec::new(), max_y: 0.0, other: 0 };
    let mut background = ImportBackground::Plain;
    if let Some(session) = &session {
        background = paper(a, session)?;
        if let Some(list) = session.at(a, &["richText", "mediaObjects"])? {
            for (i, item) in list.items(a)?.into_iter().enumerate() {
                if i % 256 == 0 {
                    check_deadline(limits)?;
                }
                if !matches!(item.node, Node::Dict(_)) {
                    continue;
                }
                match item.class_name(a)?.as_deref() {
                    Some("TextBlockMediaObject") => read_text(a, &item, &mut media)?,
                    Some("ImageMediaObject") => read_image(a, &item, &dir, src, &mut media)?,
                    _ => media.other += 1,
                }
            }
        }
    }

    let content_bottom = ink.max_y.max(media.max_y).ceil();
    let (width, height) = match page_width {
        Some(w) => (w, content_bottom),
        None => (DEFAULT_WIDTH, content_bottom.max(DEFAULT_HEIGHT)),
    };
    let title = base_name(&dir).trim().to_owned();
    let title = if title.is_empty() { "Notability note".to_owned() } else { title };
    let page = ImportPage {
        source_id: session_name.clone(),
        title: Some(title.clone()),
        width,
        height,
        background,
        strokes: ink.strokes,
        texts: media.texts,
        images: media.images,
        skipped: ImportSkipped {
            tables: 0,
            shapes: ink.shapes,
            other: media.other.saturating_add(u32::try_from(pdfs).unwrap_or(u32::MAX)),
        },
    };
    Ok(ImportDocument {
        source: ImportSource::Notability,
        title: title.clone(),
        default_page_mode: PageMode::Page,
        sections: vec![ImportSection { source_id: dir, title, pages: vec![page] }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fractional_width_interpolates_per_cubic_node() {
        let frac = [1.0f32, 2.0];
        let w: Vec<f64> = (0..4).map(|r| fractional_width(3.0, &frac, r)).collect();
        assert!((w[0] - 3.0).abs() < 1e-9 && (w[1] - 4.0).abs() < 1e-9);
        assert!((w[2] - 5.0).abs() < 1e-9 && (w[3] - 6.0).abs() < 1e-9);
        // Clamped to 0.2..3.
        assert_eq!(fractional_width(10.0, &[0.0], 0), 2.0);
        assert_eq!(fractional_width(10.0, &[9.0], 0), 30.0);
    }

    #[test]
    fn line_styles_and_colours() {
        assert_eq!(line_style("Grid:0.25"), Some(ImportBackground::Grid { spacing: 24.0 }));
        assert_eq!(line_style("Lines:x"), Some(ImportBackground::Lined { spacing: 32.0 }));
        assert_eq!(line_style("Dots:0.5"), Some(ImportBackground::Dotted { spacing: 48.0 }));
        assert_eq!(line_style("Plain"), None);
        assert_eq!(cross_platform_color("1,0,0.5").as_deref(), Some("#ff0080"));
        assert_eq!(cross_platform_color("0,128,255,1").as_deref(), Some("#0080ff"));
        assert_eq!(pair("{50, 100}"), Some((50.0, 100.0)));
        assert_eq!(pair("50, 100"), None);
    }

    #[test]
    fn highlighter_rules() {
        assert!(is_highlighter([255, 255, 0, 128], false));
        assert!(!is_highlighter([255, 255, 0, 255], false));
        // Behind-text rule: bright, saturated, opaque.
        assert!(is_highlighter([255, 255, 0, 255], true));
        assert!(!is_highlighter([200, 200, 200, 255], true));
        assert!(!is_highlighter([0, 0, 255, 255], true));
    }
}
