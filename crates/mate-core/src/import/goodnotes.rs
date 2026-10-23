//! GoodNotes (`.goodnotes`): a zip of protobuf records.
//!
//! Layout (all entries at the zip root):
//! - `index.notes.pb`: length-delimited page records `{1: id, 2: "notes/<id>", 3: width, 4:
//!   height}` (sizes are decimal strings) giving the page order;
//! - `notes/<pageId>`: the page's elements, a length-delimited list of messages (strokes at
//!   field 7, text objects at 21, images at 1, shapes at 21/22, version records with 1+2+8);
//! - `index.attachments.pb`: `{1: attachmentId, 2: zip path}`; `index.events.pb`: templates,
//!   deleted pages, canvas boards; `index.backgrounds.pb`: `{1: pageId, 2: kind}`.
//!
//! A stroke's path is a `bv41` (LZ4 blocks) or `bv4-` (raw) blob holding a `tpl` payload: a
//! schema string followed by the data it describes. The schema selects one of three families
//! (plain, wide, pressure); each is a list of path commands (move, quadratic curve) with
//! fixed-size records, flattened here into points. The pressure family also carries nib
//! records from which per-point widths are derived.
//!
//! Every source page becomes one Mate page. A stroke that cannot be read is skipped and counted
//! in [`ImportSkipped::other`]; shapes are counted in [`ImportSkipped::shapes`]. Coordinates stay
//! in GoodNotes page units (the placer scales by `1080 / width`).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet, VecDeque};

use super::pb::{self, Wire};
use super::zipsrc::is_safe_name;
use super::{
    ImportBackground, ImportDocument, ImportError, ImportImage, ImportLimits, ImportPage,
    ImportPoint, ImportSection, ImportSource, ImportStroke, ImportText, ZipSource,
    check_deadline,
};
use crate::model::{PageMode, PenStyle};

const NOTES_PREFIX: &str = "notes/";
/// Most LZ4 blocks in one `bv41` blob.
const MAX_BLOCKS: usize = 4096;
/// Most bytes one blob (all its blocks) may decompress to.
const MAX_BLOB_BYTES: u64 = 64 * 1024 * 1024;
/// LZ4 cannot expand its input by more than ~255×; larger declared sizes are rejected before
/// any buffer is allocated.
const LZ4_MAX_RATIO: u64 = 255;
/// GoodNotes units per PDF point for PDF-template page sizes.
#[allow(clippy::excessive_precision)]
const PDF_TEMPLATE_SCALE: f64 = 1.833_333_355_206_793_6;
/// Page size when the file gives none.
const DEFAULT_SIZE: (f64, f64) = (1080.0, 1440.0);
/// Deepest `A(`/`S(` nesting accepted in a stroke schema.
const MAX_SCHEMA_DEPTH: usize = 16;
/// Canvas boards: margin around the content, the side past which a board is degraded, and the
/// height of one text line.
const BOARD_MARGIN: f64 = 80.0;
const BOARD_MAX_SIDE: f64 = 50_000.0;
const BOARD_LINE_HEIGHT: f64 = 30.0;
/// Points one stroke may flatten to; a stroke past it is skipped and counted.
const MAX_POINTS_PER_STROKE: usize = 50_000;
/// Points one file may flatten to; past it the import fails with `Limit`.
const MAX_POINTS_PER_FILE: usize = 5_000_000;
/// The path builder checks the deadline once per this many curves.
const CURVES_PER_DEADLINE_CHECK: usize = 1024;
/// Per-point and family widths above this are dropped.
const MAX_WIDTH: f64 = 60.0;
/// Family widths below this are dropped.
const MIN_FAMILY_WIDTH: f64 = 0.2;
/// Stroke width when nothing else gives one.
const DEFAULT_WIDTH: f64 = 2.0;
/// Source alpha below which a stroke is a highlighter.
const HIGHLIGHTER_BELOW_ALPHA: f64 = 0.6;
/// Two nib ratios closer than this count as the same aspect.
const NIB_RATIO_TOLERANCE: f64 = 1e-5;

const MAGIC_BV41: u32 = u32::from_le_bytes(*b"bv41");
const MAGIC_BV4_END: u32 = u32::from_le_bytes(*b"bv4$");
const MAGIC_BV4_RAW: u32 = u32::from_le_bytes(*b"bv4-");

// ---------------------------------------------------------------------------------------------
// Protobuf access (first-occurrence semantics; a malformed sub-message reads as absent).
// Every sub-message is opened one level deeper than its parent, so `pb::MAX_DEPTH` holds.
// ---------------------------------------------------------------------------------------------

/// One decoded message: its fields in order, and its nesting depth.
#[derive(Debug, Clone, Default)]
struct Msg<'a> {
    fields: Vec<(u32, Wire<'a>)>,
    depth: u32,
}

impl<'a> Msg<'a> {
    /// A top-level message (a record of a length-delimited list).
    fn top(bytes: &'a [u8]) -> Option<Msg<'a>> {
        pb::fields(bytes).collect_all().ok().map(|fields| Msg { fields, depth: 0 })
    }

    /// `bytes` read as a message nested inside this one (`None` if malformed or too deep).
    fn child<'b>(&self, bytes: &'b [u8]) -> Option<Msg<'b>> {
        let reader = pb::fields_at_depth(bytes, self.depth).ok()?;
        let depth = reader.depth();
        reader.collect_all().ok().map(|fields| Msg { fields, depth })
    }

    /// First length-delimited field `n`.
    fn bytes(&self, n: u32) -> Option<&'a [u8]> {
        self.fields.iter().find_map(|(f, w)| if *f == n { w.as_bytes() } else { None })
    }

    /// First length-delimited field `n` as text (empty → `None`).
    fn string(&self, n: u32) -> Option<String> {
        self.bytes(n).map(|b| String::from_utf8_lossy(b).into_owned()).filter(|s| !s.is_empty())
    }

    /// First length-delimited field `n` decoded as a sub-message.
    fn sub(&self, n: u32) -> Option<Msg<'a>> {
        self.bytes(n).and_then(|b| self.child(b))
    }

    /// First fixed32 field `n` as a float.
    fn f32(&self, n: u32) -> Option<f64> {
        self.fields.iter().find_map(|(f, w)| match w {
            Wire::Fixed32(_) if *f == n => w.as_f64(),
            _ => None,
        })
    }

    /// First varint field `n`.
    fn varint(&self, n: u32) -> Option<u64> {
        self.fields.iter().find_map(|(f, w)| match w {
            Wire::Varint(v) if *f == n => Some(*v),
            _ => None,
        })
    }

    fn has_len(&self, n: u32) -> bool {
        self.fields.iter().any(|(f, w)| *f == n && matches!(w, Wire::Len(_)))
    }

    fn has_varint(&self, n: u32) -> bool {
        self.fields.iter().any(|(f, w)| *f == n && matches!(w, Wire::Varint(_)))
    }

    /// `{1: x f32, 2: y f32}`, both present.
    fn point(&self) -> Option<(f64, f64)> {
        Some((self.f32(1)?, self.f32(2)?))
    }
}

fn sub_of<'a>(m: Option<&Msg<'a>>, n: u32) -> Option<Msg<'a>> {
    m.and_then(|m| m.sub(n))
}

/// A length-delimited list: repeat { varint length; bytes }, stopping at the end, a zero
/// length, a truncated varint or a length that overruns.
fn delimited(buf: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let mut len: u64 = 0;
        let mut shift = 0u32;
        let mut done = false;
        while pos < buf.len() {
            let b = buf[pos];
            pos += 1;
            if shift < 64 {
                len |= u64::from(b & 0x7f) << shift;
            }
            shift = shift.saturating_add(7);
            if b & 0x80 == 0 {
                done = true;
                break;
            }
        }
        let remaining = (buf.len() - pos) as u64;
        if !done || len == 0 || len > remaining {
            break;
        }
        let end = pos + len as usize;
        out.push(&buf[pos..end]);
        pos = end;
    }
    out
}

/// JavaScript `parseFloat`: the longest leading decimal number (after whitespace).
fn parse_float_prefix(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0;
    let mut seen_digit = false;
    let mut seen_dot = false;
    if end < bytes.len() && (bytes[end] == b'+' || bytes[end] == b'-') {
        end += 1;
    }
    while end < bytes.len() {
        match bytes[end] {
            b'0'..=b'9' => seen_digit = true,
            b'.' if !seen_dot => seen_dot = true,
            _ => break,
        }
        end += 1;
    }
    if !seen_digit {
        return None;
    }
    // An exponent counts only if it has digits.
    if end < bytes.len() && (bytes[end] == b'e' || bytes[end] == b'E') {
        let mut e = end + 1;
        if e < bytes.len() && (bytes[e] == b'+' || bytes[e] == b'-') {
            e += 1;
        }
        let digits_start = e;
        while e < bytes.len() && bytes[e].is_ascii_digit() {
            e += 1;
        }
        if e > digits_start {
            end = e;
        }
    }
    s[..end].parse::<f64>().ok()
}

/// Attachment ids are 36-character uuids (hex digits and four dashes).
fn is_uuid(bytes: &[u8]) -> bool {
    bytes.len() == 36
        && bytes.iter().all(|b| b.is_ascii_hexdigit() || *b == b'-')
        && bytes.iter().filter(|b| **b == b'-').count() == 4
}

// ---------------------------------------------------------------------------------------------
// bv4 containers (LZ4 output is charged to the zip budget)
// ---------------------------------------------------------------------------------------------

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    let s = b.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// One LZ4 block that must decompress to exactly `size` bytes (≤ [`MAX_BLOB_BYTES`]), with the
/// safe decoder writing into a buffer of that size. `Ok(None)` if malformed; `Err` only once the
/// file's inflate budget is exhausted.
fn lz4_block(
    input: &[u8],
    size: u64,
    src: &mut ZipSource<'_>,
) -> Result<Option<Vec<u8>>, ImportError> {
    if size == 0
        || size > MAX_BLOB_BYTES
        || size > (input.len() as u64).saturating_mul(LZ4_MAX_RATIO).saturating_add(16)
    {
        return Ok(None);
    }
    src.charge(size)?;
    match lz4_flex::block::decompress(input, size as usize) {
        Ok(out) if out.len() as u64 == size => Ok(Some(out)),
        _ => Ok(None),
    }
}

/// True for the two stroke blob magics, `bv41` and `bv4-`.
fn is_path_blob(blob: &[u8]) -> bool {
    matches!(u32_at(blob, 0), Some(MAGIC_BV41 | MAGIC_BV4_RAW))
}

/// A stroke path blob → its payload: `bv41` blocks (`"bv41" | u32 size | u32 compressed | LZ4
/// block`, ≤ 4096 blocks, ≤ 64 MiB, ended by `bv4$` when there are several) or `bv4-` raw
/// (`"bv4-" | u32 size | bytes`).
fn unwrap_path_blob<'b>(
    blob: &'b [u8],
    src: &mut ZipSource<'_>,
) -> Result<Option<Cow<'b, [u8]>>, ImportError> {
    if blob.len() < 12 {
        return Ok(None);
    }
    match u32_at(blob, 0) {
        Some(MAGIC_BV41) => {
            let mut out: Vec<u8> = Vec::new();
            let mut blocks = 0usize;
            let mut pos = 0usize;
            while u32_at(blob, pos) == Some(MAGIC_BV41) {
                if blocks == MAX_BLOCKS || pos + 12 > blob.len() {
                    return Ok(None);
                }
                let raw = u64::from(u32_at(blob, pos + 4).unwrap_or(0));
                let comp = u32_at(blob, pos + 8).unwrap_or(0) as usize;
                let start = pos + 12;
                if comp == 0
                    || comp > blob.len() - start
                    || out.len() as u64 + raw > MAX_BLOB_BYTES
                {
                    return Ok(None);
                }
                match lz4_block(&blob[start..start + comp], raw, src)? {
                    Some(block) => out.extend_from_slice(&block),
                    None => return Ok(None),
                }
                blocks += 1;
                pos = start + comp;
            }
            if u32_at(blob, pos) != Some(MAGIC_BV4_END) && blocks > 1 {
                return Ok(None);
            }
            Ok(Some(Cow::Owned(out)))
        }
        Some(MAGIC_BV4_RAW) => {
            let n = u32_at(blob, 4).unwrap_or(0) as usize;
            if n == 0 || n > blob.len() - 8 {
                return Ok(None);
            }
            Ok(Some(Cow::Borrowed(&blob[8..8 + n])))
        }
        _ => Ok(None),
    }
}

/// A text blob: `bv4?` | u32 size | u32 compressed | LZ4 block.
fn unwrap_text_blob(blob: &[u8], src: &mut ZipSource<'_>) -> Result<Option<Vec<u8>>, ImportError> {
    if blob.len() < 12 {
        return Ok(None);
    }
    let raw = u64::from(u32_at(blob, 4).unwrap_or(0));
    let comp = u32_at(blob, 8).unwrap_or(0) as usize;
    if raw == 0 || comp == 0 || comp > blob.len() - 12 {
        return Ok(None);
    }
    lz4_block(&blob[12..12 + comp], raw, src)
}

fn starts_bv4(b: &[u8]) -> bool {
    b.starts_with(b"bv4")
}

// ---------------------------------------------------------------------------------------------
// The `tpl` payload: schema grammar and data groups (§1h.1)
// ---------------------------------------------------------------------------------------------

/// Why a stroke path could not be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unreadable {
    /// The payload, schema, data or path commands break a format rule.
    Invalid(&'static str),
    /// It would flatten to more than [`MAX_POINTS_PER_STROKE`] points.
    TooManyPoints,
}

/// The schema text and the data that follows it.
struct Payload<'p> {
    schema: &'p str,
    data: &'p [u8],
}

/// `t p l 00`, four ignored bytes, an ASCII schema ended by NUL, then the data.
fn split_payload(bytes: &[u8]) -> Result<Payload<'_>, Unreadable> {
    if bytes.len() < 10 || !bytes.starts_with(b"tpl\0") {
        return Err(Unreadable::Invalid("not a tpl payload"));
    }
    let nul = bytes[8..]
        .iter()
        .position(|b| *b == 0)
        .ok_or(Unreadable::Invalid("schema has no end"))?;
    let schema = std::str::from_utf8(&bytes[8..8 + nul])
        .ok()
        .filter(|s| s.is_ascii())
        .ok_or(Unreadable::Invalid("schema is not ASCII"))?;
    Ok(Payload { schema, data: &bytes[8 + nul + 1..] })
}

/// A schema leaf: `v` is a u16, `u` and `f` are f32 (all little-endian).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scalar {
    Half,
    Float,
}

impl Scalar {
    fn size(self) -> usize {
        match self {
            Scalar::Half => 2,
            Scalar::Float => 4,
        }
    }

    /// The value at the start of `b` (which holds at least `size()` bytes).
    fn decode(self, b: &[u8]) -> f64 {
        match self {
            Scalar::Half => f64::from(u16::from_le_bytes([b[0], b[1]])),
            Scalar::Float => f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        }
    }
}

/// One schema term.
#[derive(Debug, Clone, PartialEq)]
enum Term {
    Leaf(Scalar),
    /// `A(…)`: a u32 count, then that many elements; an element is the one inner term, or a
    /// struct of all of them.
    Array(Vec<Term>),
    /// `S(…)`: the inner terms in sequence (only inside an array).
    Struct(Vec<Term>),
}

impl Term {
    /// Fewest bytes this term can occupy.
    fn min_size(&self) -> usize {
        match self {
            Term::Leaf(s) => s.size(),
            Term::Array(_) => 4,
            Term::Struct(inner) => inner.iter().map(Term::min_size).sum(),
        }
    }
}

/// Appends the scalars of a fixed-size element to `out`; false if it holds an array.
fn fixed_layout(terms: &[Term], out: &mut Vec<Scalar>) -> bool {
    terms.iter().all(|t| match t {
        Term::Leaf(s) => {
            out.push(*s);
            true
        }
        Term::Struct(inner) => fixed_layout(inner, out),
        Term::Array(_) => false,
    })
}

/// A parsed schema: the top-level terms, one per data group.
#[derive(Debug, Clone, PartialEq)]
struct Schema {
    groups: Vec<Term>,
}

impl Schema {
    fn parse(text: &str) -> Result<Schema, Unreadable> {
        let mut scanner = SchemaScanner { text: text.as_bytes(), at: 0 };
        let mut groups = Vec::new();
        while scanner.at < scanner.text.len() {
            match scanner.term(0)? {
                Term::Struct(_) => return Err(Unreadable::Invalid("bare top-level struct")),
                term => groups.push(term),
            }
        }
        Ok(Schema { groups })
    }
}

struct SchemaScanner<'s> {
    text: &'s [u8],
    at: usize,
}

impl SchemaScanner<'_> {
    fn term(&mut self, depth: usize) -> Result<Term, Unreadable> {
        let Some(&c) = self.text.get(self.at) else {
            return Err(Unreadable::Invalid("unbalanced"));
        };
        self.at += 1;
        match c {
            b'v' => Ok(Term::Leaf(Scalar::Half)),
            b'u' | b'f' => Ok(Term::Leaf(Scalar::Float)),
            b'A' | b'S' => {
                if depth >= MAX_SCHEMA_DEPTH {
                    return Err(Unreadable::Invalid("schema nested too deeply"));
                }
                if self.text.get(self.at) != Some(&b'(') {
                    return Err(Unreadable::Invalid("bad schema char"));
                }
                self.at += 1;
                let mut inner = Vec::new();
                loop {
                    match self.text.get(self.at) {
                        None => return Err(Unreadable::Invalid("unbalanced")),
                        Some(b')') => {
                            self.at += 1;
                            break;
                        }
                        Some(_) => inner.push(self.term(depth + 1)?),
                    }
                }
                Ok(if c == b'A' { Term::Array(inner) } else { Term::Struct(inner) })
            }
            b')' => Err(Unreadable::Invalid("unbalanced")),
            _ => Err(Unreadable::Invalid("bad schema char")),
        }
    }
}

/// A flat number list backed by the payload bytes: `elements` fixed-size elements whose scalars
/// sit at the given offsets.
#[derive(Debug, Clone)]
struct Column<'d> {
    bytes: &'d [u8],
    scalars: Vec<(Scalar, usize)>,
    element_size: usize,
    elements: usize,
}

impl Column<'_> {
    /// Number of values (elements × scalars per element).
    fn len(&self) -> usize {
        self.elements * self.scalars.len()
    }

    fn get(&self, i: usize) -> f64 {
        let per = self.scalars.len();
        let (scalar, offset) = self.scalars[i % per];
        scalar.decode(&self.bytes[(i / per) * self.element_size + offset..])
    }
}

/// One top-level data group.
#[derive(Debug, Clone)]
enum Group<'d> {
    Value(f64),
    List(Column<'d>),
    /// An array whose elements hold arrays: checked for size, never read.
    Nested,
}

struct DataCursor<'d> {
    data: &'d [u8],
    at: usize,
}

impl<'d> DataCursor<'d> {
    fn take(&mut self, n: usize) -> Result<&'d [u8], Unreadable> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.data.len())
            .ok_or(Unreadable::Invalid("bad count"))?;
        let out = &self.data[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn remaining(&self) -> usize {
        self.data.len() - self.at
    }

    /// An `A(inner)` occurrence.
    fn array(&mut self, inner: &[Term]) -> Result<Group<'d>, Unreadable> {
        let count = u32::from_le_bytes(self.take(4)?.try_into().expect("4 bytes")) as usize;
        let min = inner.iter().map(Term::min_size).sum::<usize>();
        if min == 0 {
            return Err(Unreadable::Invalid("zero-size element"));
        }
        if count.checked_mul(min).is_none_or(|need| need > self.remaining()) {
            return Err(Unreadable::Invalid("bad count"));
        }
        let mut layout = Vec::new();
        if fixed_layout(inner, &mut layout) {
            let bytes = self.take(count * min)?;
            let mut offset = 0;
            let scalars = layout
                .into_iter()
                .map(|s| {
                    let at = offset;
                    offset += s.size();
                    (s, at)
                })
                .collect();
            return Ok(Group::List(Column { bytes, scalars, element_size: min, elements: count }));
        }
        for _ in 0..count {
            self.skip(inner)?;
        }
        Ok(Group::Nested)
    }

    /// Steps over one occurrence of each term (for elements that hold arrays).
    fn skip(&mut self, terms: &[Term]) -> Result<(), Unreadable> {
        for term in terms {
            match term {
                Term::Leaf(s) => {
                    self.take(s.size())?;
                }
                Term::Struct(inner) => self.skip(inner)?,
                Term::Array(inner) => {
                    self.array(inner)?;
                }
            }
        }
        Ok(())
    }
}

/// The data groups of `schema` read from `data`, which must be consumed exactly.
fn read_groups<'d>(schema: &Schema, data: &'d [u8]) -> Result<Vec<Group<'d>>, Unreadable> {
    let mut cursor = DataCursor { data, at: 0 };
    let mut groups = Vec::with_capacity(schema.groups.len());
    for term in &schema.groups {
        groups.push(match term {
            Term::Leaf(s) => Group::Value(s.decode(cursor.take(s.size())?)),
            Term::Array(inner) => cursor.array(inner)?,
            Term::Struct(_) => return Err(Unreadable::Invalid("bare top-level struct")),
        });
    }
    if cursor.at != data.len() {
        return Err(Unreadable::Invalid("data not consumed exactly"));
    }
    Ok(groups)
}

// ---------------------------------------------------------------------------------------------
// Families (§1h.3)
// ---------------------------------------------------------------------------------------------

const PLAIN_PREFIX: &str = "vuA(v)A(S(uu))A(S(uuuu))";
const WIDE_PREFIX: &str = "vuA(v)A(S(uuuuu))A(S(uuuuuuuuuuu))";
const PRESSURE_SCHEMA: &str = "vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)";

/// How a family's records are read and its flags interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Encoding {
    /// F1: move (x, y), curve (Cx, Cy, Ex, Ey).
    Plain,
    /// F2: move stride 5 (x, y first), curve stride 11 (C at 1–2, E at 6–7).
    Wide,
    /// F3a: move (x, y, force), curve (Cx, Cy, Cf, Ex, Ey, Ef).
    Force,
    /// F3b: move (x, y, force, angle), curve (Cx, Cy, Cf, Ex, Ey, Ef, Cθ, Eθ, aspect);
    /// flags are 4 (move) and 5 (curve).
    Aspect,
}

/// Positions of the values inside one move record (x and y are always first).
struct MoveFields {
    stride: usize,
    force: Option<usize>,
    angle: Option<usize>,
}

/// Positions of the values inside one curve record.
struct CurveFields {
    stride: usize,
    ctrl: usize,
    end: usize,
    ctrl_force: Option<usize>,
    end_force: Option<usize>,
    ctrl_angle: Option<usize>,
    end_angle: Option<usize>,
    aspect: Option<usize>,
}

impl Encoding {
    fn moves(self) -> MoveFields {
        match self {
            Encoding::Plain => MoveFields { stride: 2, force: None, angle: None },
            Encoding::Wide => MoveFields { stride: 5, force: None, angle: None },
            Encoding::Force => MoveFields { stride: 3, force: Some(2), angle: None },
            Encoding::Aspect => MoveFields { stride: 4, force: Some(2), angle: Some(3) },
        }
    }

    fn curves(self) -> CurveFields {
        let plain = CurveFields {
            stride: 4,
            ctrl: 0,
            end: 2,
            ctrl_force: None,
            end_force: None,
            ctrl_angle: None,
            end_angle: None,
            aspect: None,
        };
        match self {
            Encoding::Plain => plain,
            Encoding::Wide => CurveFields { stride: 11, ctrl: 1, end: 6, ..plain },
            Encoding::Force => CurveFields {
                stride: 6,
                end: 3,
                ctrl_force: Some(2),
                end_force: Some(5),
                ..plain
            },
            Encoding::Aspect => CurveFields {
                stride: 9,
                ctrl: 0,
                end: 3,
                ctrl_force: Some(2),
                end_force: Some(5),
                ctrl_angle: Some(6),
                end_angle: Some(7),
                aspect: Some(8),
            },
        }
    }

    /// The flag value of a move command (a curve is this + 1).
    fn move_flag(self) -> f64 {
        if self == Encoding::Aspect { 4.0 } else { 0.0 }
    }
}

/// Everything the path builder needs from one decoded payload.
struct PathSource<'d> {
    encoding: Encoding,
    flags: Column<'d>,
    moves: Column<'d>,
    curves: Column<'d>,
    nibs: Option<Column<'d>>,
    /// F1/F2 width (only inside 0.2..=60).
    family_width: Option<f64>,
}

fn list<'d>(groups: &[Group<'d>], at: usize) -> Result<Column<'d>, Unreadable> {
    match groups.get(at) {
        Some(Group::List(c)) => Ok(c.clone()),
        _ => Err(Unreadable::Invalid("unknown family")),
    }
}

fn value(groups: &[Group<'_>], at: usize) -> Result<f64, Unreadable> {
    match groups.get(at) {
        Some(Group::Value(v)) => Ok(*v),
        _ => Err(Unreadable::Invalid("unknown family")),
    }
}

/// Picks the family from the schema text and binds its groups.
fn path_source<'d>(schema: &str, groups: &[Group<'d>]) -> Result<PathSource<'d>, Unreadable> {
    let with_width = |encoding: Encoding| -> Result<PathSource<'d>, Unreadable> {
        let width = value(groups, 1)?;
        Ok(PathSource {
            encoding,
            flags: list(groups, 2)?,
            moves: list(groups, 3)?,
            curves: list(groups, 4)?,
            nibs: None,
            family_width: (MIN_FAMILY_WIDTH..=MAX_WIDTH).contains(&width).then_some(width),
        })
    };
    if schema.starts_with(PLAIN_PREFIX) {
        return with_width(Encoding::Plain);
    }
    if schema.starts_with(WIDE_PREFIX) {
        return with_width(Encoding::Wide);
    }
    if schema != PRESSURE_SCHEMA {
        return Err(Unreadable::Invalid("unknown family"));
    }
    let flags = list(groups, 1)?;
    let all_in = |set: [f64; 2]| (0..flags.len()).all(|i| set.contains(&flags.get(i)));
    let version = value(groups, 0)?;
    let encoding = if version == 1.0 || (version == 2.0 && all_in([0.0, 1.0])) {
        Encoding::Force
    } else if version == 2.0 && all_in([4.0, 5.0]) {
        Encoding::Aspect
    } else {
        return Err(Unreadable::Invalid("unknown pressure variant"));
    };
    Ok(PathSource {
        encoding,
        flags,
        moves: list(groups, 2)?,
        curves: list(groups, 3)?,
        nibs: Some(list(groups, 9)?),
        family_width: None,
    })
}

// ---------------------------------------------------------------------------------------------
// Path construction and flattening (§1h.1, §1h.2)
// ---------------------------------------------------------------------------------------------

/// One output point before it becomes an [`ImportPoint`].
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Sample {
    x: f64,
    y: f64,
    force: Option<f64>,
    /// Nib axis angle (F3b).
    angle: Option<f64>,
    width: Option<f64>,
    /// Unit normal of the path here (F3b), for nib-record widths.
    normal: Option<(f64, f64)>,
}

/// One quadratic curve command.
struct Quad {
    ctrl: (f64, f64),
    end: (f64, f64),
    ctrl_force: Option<f64>,
    end_force: Option<f64>,
    ctrl_angle: Option<f64>,
    end_angle: Option<f64>,
    aspect: Option<f64>,
}

/// Why building stopped early.
enum Stop {
    Unreadable(Unreadable),
    Fatal(ImportError),
}

impl From<Unreadable> for Stop {
    fn from(u: Unreadable) -> Stop {
        Stop::Unreadable(u)
    }
}

/// N for one curve: the flatness tolerance is one unit, with 2 to 64 segments.
fn segment_count(p0: (f64, f64), c: (f64, f64), p1: (f64, f64)) -> usize {
    let finite = [p0.0, p0.1, c.0, c.1, p1.0, p1.1].iter().all(|v| v.is_finite());
    if !finite {
        return 2;
    }
    let chord = (p1.0 - p0.0, p1.1 - p0.1);
    let to_ctrl = (c.0 - p0.0, c.1 - p0.1);
    let chord_len = chord.0.hypot(chord.1);
    let off_line = if chord_len == 0.0 {
        to_ctrl.0.hypot(to_ctrl.1)
    } else {
        (chord.0 * to_ctrl.1 - chord.1 * to_ctrl.0).abs() / chord_len
    };
    let bend = (p0.0 - 2.0 * c.0 + p1.0).hypot(p0.1 - 2.0 * c.1 + p1.1) / 2.0;
    let n = off_line.max(bend).sqrt().ceil();
    if n.is_nan() { 2 } else { n.clamp(2.0, 64.0) as usize }
}

/// The Bernstein weights of a quadratic at `t`.
fn weights(t: f64) -> [f64; 3] {
    let s = 1.0 - t;
    [s * s, 2.0 * t * s, t * t]
}

fn blend(w: [f64; 3], a: f64, b: f64, c: f64) -> f64 {
    w[0] * a + w[1] * b + w[2] * c
}

fn blend_opt(w: [f64; 3], a: Option<f64>, b: Option<f64>, c: Option<f64>) -> Option<f64> {
    Some(blend(w, a?, b?, c?))
}

/// Weighted mean of axis angles (angles mod π), undefined when the weighted vectors cancel.
fn blend_axis(w: [f64; 3], angles: [f64; 3]) -> Option<f64> {
    let (mut sin, mut cos) = (0.0, 0.0);
    for (wi, a) in w.iter().zip(angles) {
        sin += wi * (2.0 * a).sin();
        cos += wi * (2.0 * a).cos();
    }
    (sin != 0.0 || cos != 0.0).then(|| 0.5 * sin.atan2(cos))
}

/// The first usable direction among `candidates`, turned by +90° and normalised.
fn normal_from(candidates: [(f64, f64); 3]) -> Option<(f64, f64)> {
    candidates.into_iter().find_map(|(tx, ty)| {
        let len = tx.hypot(ty);
        (tx.is_finite() && ty.is_finite() && len > 0.0 && len.is_finite())
            .then(|| (-ty / len, tx / len))
    })
}

/// Width of an elliptical nib with half-axes `along` (direction θ) and `across`, measured
/// across the path whose unit normal is `n`.
fn nib_span(along: f64, across: f64, theta: f64, n: (f64, f64)) -> Option<f64> {
    if !(along.is_finite() && across.is_finite() && theta.is_finite()) {
        return None;
    }
    if along < 0.0 || across < 0.0 {
        return None;
    }
    let (sin, cos) = theta.sin_cos();
    let n_u = n.0 * cos + n.1 * sin;
    let n_v = n.1 * cos - n.0 * sin;
    Some(2.0 * ((along * n_u).powi(2) + (across * n_v).powi(2)).sqrt())
}

/// Collects sub-paths from move / curve commands, flattening curves as they arrive.
struct PathBuilder<'l> {
    done: Vec<Vec<Sample>>,
    open: Option<Vec<Sample>>,
    /// Points emitted so far (dropped sub-paths included).
    emitted: usize,
    curves: usize,
    /// F3b: give every flattened point a nib width from the interpolated nib.
    nib_geometry: bool,
    limits: &'l ImportLimits,
}

impl<'l> PathBuilder<'l> {
    fn new(nib_geometry: bool, limits: &'l ImportLimits) -> PathBuilder<'l> {
        PathBuilder { done: Vec::new(), open: None, emitted: 0, curves: 0, nib_geometry, limits }
    }

    fn reserve(&mut self, n: usize) -> Result<(), Stop> {
        self.emitted += n;
        if self.emitted > MAX_POINTS_PER_STROKE {
            return Err(Unreadable::TooManyPoints.into());
        }
        Ok(())
    }

    fn move_to(&mut self, start: Sample) -> Result<(), Stop> {
        self.reserve(1)?;
        if let Some(prev) = self.open.replace(vec![start]) {
            self.done.push(prev);
        }
        Ok(())
    }

    fn quad_to(&mut self, q: &Quad) -> Result<(), Stop> {
        self.curves += 1;
        if self.curves.is_multiple_of(CURVES_PER_DEADLINE_CHECK) {
            check_deadline(self.limits).map_err(Stop::Fatal)?;
        }
        let Some(start) = self.open.as_ref().and_then(|p| p.last()).copied() else {
            return Err(Unreadable::Invalid("curve before moveTo").into());
        };
        let p0 = (start.x, start.y);
        let (c, p1) = (q.ctrl, q.end);
        let n = segment_count(p0, c, p1);
        self.reserve(n)?;
        let geometry = self.nib_geometry;
        let path = self.open.as_mut().expect("checked above");

        let chord = (p1.0 - p0.0, p1.1 - p0.1);
        let bend = (p0.0 - 2.0 * c.0 + p1.0, p0.1 - 2.0 * c.1 + p1.1);
        let forces = (start.force, q.ctrl_force, q.end_force);
        let angles = match (start.angle, q.ctrl_angle, q.end_angle) {
            (Some(a), Some(b), Some(c)) => Some([a, b, c]),
            _ => None,
        };
        // The interpolated nib's width at parameter t, given the path normal there.
        let nib_at = |t: f64, normal: Option<(f64, f64)>| -> Option<f64> {
            let w = weights(t);
            let aspect = q.aspect?;
            let (f0, fc, fe) = (forces.0?, forces.1?, forces.2?);
            let along = blend(w, aspect * f0, aspect * fc, aspect * fe);
            let across = blend(w, f0, fc, fe);
            nib_span(along, across, blend_axis(w, angles?)?, normal?)
        };

        if geometry {
            let first = path.last_mut().expect("an open sub-path has a point");
            let normal = normal_from([(c.0 - p0.0, c.1 - p0.1), chord, bend]);
            if first.normal.is_none() {
                first.normal = normal;
            }
            if first.width.is_none() {
                first.width = nib_at(0.0, normal);
            }
        }
        for k in 1..=n {
            let t = k as f64 / n as f64;
            let w = weights(t);
            let mut sample = Sample {
                x: blend(w, p0.0, c.0, p1.0),
                y: blend(w, p0.1, c.1, p1.1),
                force: blend_opt(w, forces.0, forces.1, forces.2),
                angle: angles.and_then(|a| blend_axis(w, a)),
                width: None,
                normal: None,
            };
            if geometry {
                let s = 1.0 - t;
                let slope = (
                    2.0 * (s * (c.0 - p0.0) + t * (p1.0 - c.0)),
                    2.0 * (s * (c.1 - p0.1) + t * (p1.1 - c.1)),
                );
                sample.normal = normal_from([slope, chord, bend]);
                sample.width = nib_at(t, sample.normal);
            }
            path.push(sample);
        }
        Ok(())
    }

    fn finish(mut self) -> Vec<Vec<Sample>> {
        if let Some(open) = self.open.take() {
            self.done.push(open);
        }
        self.done
    }
}

/// Runs the commands of `src` through a [`PathBuilder`].
fn trace(src: &PathSource<'_>, limits: &ImportLimits) -> Result<Vec<Vec<Sample>>, Stop> {
    let mf = src.encoding.moves();
    let cf = src.encoding.curves();
    let base = src.encoding.move_flag();
    let mut builder = PathBuilder::new(src.encoding == Encoding::Aspect, limits);
    let (mut moves_used, mut curves_used) = (0usize, 0usize);
    for i in 0..src.flags.len() {
        let command = src.flags.get(i) - base;
        if command == 0.0 {
            let at = moves_used * mf.stride;
            if at + mf.stride > src.moves.len() {
                return Err(Unreadable::Invalid("moveTo underrun").into());
            }
            moves_used += 1;
            let field = |k: usize| src.moves.get(at + k);
            builder.move_to(Sample {
                x: field(0),
                y: field(1),
                force: mf.force.map(field),
                angle: mf.angle.map(field),
                ..Sample::default()
            })?;
        } else if command == 1.0 {
            let at = curves_used * cf.stride;
            if at + cf.stride > src.curves.len() {
                return Err(Unreadable::Invalid("curve underrun").into());
            }
            curves_used += 1;
            let field = |k: usize| src.curves.get(at + k);
            builder.quad_to(&Quad {
                ctrl: (field(cf.ctrl), field(cf.ctrl + 1)),
                end: (field(cf.end), field(cf.end + 1)),
                ctrl_force: cf.ctrl_force.map(field),
                end_force: cf.end_force.map(field),
                ctrl_angle: cf.ctrl_angle.map(field),
                end_angle: cf.end_angle.map(field),
                aspect: cf.aspect.map(field),
            })?;
        } else {
            return Err(Unreadable::Invalid("unknown path flag").into());
        }
    }
    if moves_used * mf.stride != src.moves.len() || curves_used * cf.stride != src.curves.len() {
        return Err(Unreadable::Invalid("unconsumed path records").into());
    }
    Ok(builder.finish())
}

// ---------------------------------------------------------------------------------------------
// Nib records and per-point widths (§1h.4)
// ---------------------------------------------------------------------------------------------

/// One nib record: half-extents along (`p`) and across (`q`, equal to the force) the direction
/// `theta`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Nib {
    p: f64,
    q: f64,
    theta: f64,
}

/// Exact-match key (x, y, force); `-0.0` and `0.0` are the same key.
type NibKey = [u64; 3];

fn nib_key(x: f64, y: f64, force: f64) -> NibKey {
    let bits = |v: f64| if v == 0.0 { 0f64.to_bits() } else { v.to_bits() };
    [bits(x), bits(y), bits(force)]
}

/// The stroke's nib records, handed out in order to the points they match.
struct NibTable {
    queues: HashMap<NibKey, VecDeque<Nib>>,
    /// The common `p / q` when every record with both axes > 0 shares it.
    uniform_ratio: Option<f64>,
}

impl NibTable {
    /// `None` unless the list is a positive multiple of 7 values and every record is valid.
    fn read(values: &Column<'_>, needs_angle: bool) -> Option<NibTable> {
        let n = values.len();
        if n == 0 || !n.is_multiple_of(7) {
            return None;
        }
        let mut queues: HashMap<NibKey, VecDeque<Nib>> = HashMap::new();
        let mut ratios: Vec<f64> = Vec::new();
        for r in 0..n / 7 {
            let v = |k: usize| values.get(r * 7 + k);
            let (x, y, p, q, theta) = (v(0), v(1), v(2), v(3), v(6));
            let ok = [x, y, p, q].iter().all(|a| a.is_finite())
                && p >= 0.0
                && q >= 0.0
                && (!needs_angle || theta.is_finite());
            if !ok {
                return None;
            }
            if p > 0.0 && q > 0.0 {
                ratios.push(p / q);
            }
            queues.entry(nib_key(x, y, q)).or_default().push_back(Nib { p, q, theta });
        }
        let uniform_ratio = ratios
            .first()
            .copied()
            .filter(|first| ratios.iter().all(|r| (r - first).abs() <= NIB_RATIO_TOLERANCE));
        Some(NibTable { queues, uniform_ratio })
    }

    /// The next unused record for a point at (x, y) with this force.
    fn claim(&mut self, x: f64, y: f64, force: f64) -> Option<Nib> {
        self.queues.get_mut(&nib_key(x, y, force))?.pop_front()
    }
}

/// Assigns the F3 per-point widths, visiting points in stroke order across sub-paths.
fn apply_nib_records(paths: &mut [Vec<Sample>], encoding: Encoding, nibs: Option<&Column<'_>>) {
    let table = nibs.and_then(|c| NibTable::read(c, encoding == Encoding::Aspect));
    let Some(mut table) = table else {
        return;
    };
    for sample in paths.iter_mut().flatten() {
        let Some(force) = sample.force else { continue };
        let nib = table.claim(sample.x, sample.y, force);
        match encoding {
            Encoding::Force => {
                sample.width = match nib {
                    Some(nib) => Some(2.0 * nib.p),
                    None => table.uniform_ratio.map(|r| 2.0 * force * r),
                };
            }
            Encoding::Aspect => {
                if let Some(nib) = nib {
                    sample.width = sample.normal.and_then(|n| nib_span(nib.p, nib.q, nib.theta, n));
                }
            }
            Encoding::Plain | Encoding::Wide => {}
        }
    }
}

/// A decoded stroke path: its sub-paths and the family width (F1/F2).
#[derive(Debug)]
struct DecodedPath {
    paths: Vec<Vec<Sample>>,
    family_width: Option<f64>,
}

/// Payload → family source, or why not.
fn prepare(payload: &[u8]) -> Result<(Encoding, PathSource<'_>), Unreadable> {
    let parts = split_payload(payload)?;
    let schema = Schema::parse(parts.schema)?;
    let groups = read_groups(&schema, parts.data)?;
    let source = path_source(parts.schema, &groups)?;
    Ok((source.encoding, source))
}

/// A `tpl` payload → sub-paths. `Ok(Err(..))` when the stroke cannot be used; `Err` only for a
/// file-level stop (the deadline).
fn decode_payload(
    payload: &[u8],
    limits: &ImportLimits,
) -> Result<Result<DecodedPath, Unreadable>, ImportError> {
    let (encoding, source) = match prepare(payload) {
        Ok(s) => s,
        Err(u) => return Ok(Err(u)),
    };
    let mut paths = match trace(&source, limits) {
        Ok(p) => p,
        Err(Stop::Unreadable(u)) => return Ok(Err(u)),
        Err(Stop::Fatal(e)) => return Err(e),
    };
    apply_nib_records(&mut paths, encoding, source.nibs.as_ref());
    for s in paths.iter_mut().flatten() {
        s.width = s.width.filter(|w| w.is_finite() && (0.0..=MAX_WIDTH).contains(w));
    }
    Ok(Ok(DecodedPath { paths, family_width: source.family_width }))
}

/// Median of the positive point widths, if any.
fn median_width(samples: &[Sample]) -> Option<f64> {
    let mut w: Vec<f64> = samples.iter().filter_map(|s| s.width).filter(|w| *w > 0.0).collect();
    if w.is_empty() {
        return None;
    }
    w.sort_by(f64::total_cmp);
    let mid = w.len() / 2;
    Some(if !w.len().is_multiple_of(2) { w[mid] } else { (w[mid - 1] + w[mid]) / 2.0 })
}

// ---------------------------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------------------------

fn channel(v: f64) -> u8 {
    if v.is_nan() { 0 } else { (255.0 * v.clamp(0.0, 1.0)).round() as u8 }
}

fn hex(r: f64, g: f64, b: f64) -> String {
    format!("#{:02x}{:02x}{:02x}", channel(r), channel(g), channel(b))
}

/// `{1: r, 2: g, 3: b, 4: a}` f32 in 0..1; missing channel 0, missing alpha 1, missing message
/// opaque black.
fn rgba(m: Option<&Msg<'_>>) -> [f64; 4] {
    match m {
        Some(m) => [
            m.f32(1).unwrap_or(0.0),
            m.f32(2).unwrap_or(0.0),
            m.f32(3).unwrap_or(0.0),
            m.f32(4).unwrap_or(1.0),
        ],
        None => [0.0, 0.0, 0.0, 1.0],
    }
}

// ---------------------------------------------------------------------------------------------
// index.events.pb (§1h.6)
// ---------------------------------------------------------------------------------------------

/// What the event log says about one page key.
#[derive(Debug, Clone, Default, PartialEq)]
struct PageState {
    deleted: bool,
    /// `Some(title)` for a canvas board.
    canvas: Option<Option<String>>,
    /// Template id the page is bound to.
    template: Option<String>,
}

/// A template definition's size (2.8.1 × 2.8.2).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct TemplateSize {
    width: Option<f64>,
    height: Option<f64>,
}

/// One event record's action: the first present of fields 56, 64, 2, 54.
#[derive(Debug, Clone, PartialEq)]
enum EventAction {
    Delete,
    Canvas(Option<String>),
    DefineTemplate(TemplateSize),
    UseTemplate(Option<String>),
    Ignore,
}

impl EventAction {
    fn of(m: &Msg<'_>) -> EventAction {
        if m.has_len(56) {
            EventAction::Delete
        } else if m.has_len(64) {
            EventAction::Canvas(m.sub(64).and_then(|c| c.sub(3)).and_then(|t| t.string(1)))
        } else if m.has_len(2) {
            let size = m.sub(2).and_then(|t| t.sub(8));
            EventAction::DefineTemplate(TemplateSize {
                width: size.as_ref().and_then(|s| s.f32(1)),
                height: size.as_ref().and_then(|s| s.f32(2)),
            })
        } else if m.has_len(54) {
            EventAction::UseTemplate(m.sub(54).and_then(|u| u.sub(3)).and_then(|t| t.string(1)))
        } else {
            EventAction::Ignore
        }
    }
}

/// A page's final event-derived settings.
#[derive(Debug, Clone, Default, PartialEq)]
struct PageEvents {
    /// `Some(title)` for a canvas board.
    canvas_title: Option<Option<String>>,
    size: Option<(f64, f64)>,
}

/// The replayed event log.
#[derive(Debug, Default)]
struct EventLog {
    pages: HashMap<String, PageState>,
    templates: HashMap<String, TemplateSize>,
}

impl EventLog {
    fn read(src: &mut ZipSource<'_>) -> Result<EventLog, ImportError> {
        let mut log = EventLog::default();
        if let Some(buf) = src.entry("index.events.pb")? {
            for record in delimited(&buf) {
                let Some(m) = Msg::top(record) else { continue };
                let Some(key) = m.string(1) else { continue };
                log.apply(key, EventAction::of(&m));
            }
        }
        Ok(log)
    }

    /// Applies one record; a later record for the same key supersedes earlier ones.
    fn apply(&mut self, key: String, action: EventAction) {
        match action {
            EventAction::Delete => self.pages.entry(key).or_default().deleted = true,
            EventAction::Canvas(title) => {
                let state = self.pages.entry(key).or_default();
                state.deleted = false;
                state.template = None;
                state.canvas = Some(title);
            }
            EventAction::DefineTemplate(size) => {
                self.templates.insert(key, size);
            }
            EventAction::UseTemplate(template) => {
                let state = self.pages.entry(key).or_default();
                state.deleted = false;
                state.canvas = None;
                if template.is_some() {
                    state.template = template;
                }
            }
            EventAction::Ignore => {}
        }
    }

    /// The state for a page id, looked up as-is, then as the id one less.
    fn state(&self, page_id: &str) -> Option<&PageState> {
        self.pages
            .get(page_id)
            .or_else(|| preceding_uuid(page_id).and_then(|alt| self.pages.get(&alt)))
    }

    fn is_deleted(&self, page_id: &str) -> bool {
        self.state(page_id).is_some_and(|s| s.deleted)
    }

    fn page(&self, page_id: &str) -> PageEvents {
        let Some(state) = self.state(page_id) else {
            return PageEvents::default();
        };
        let size = state
            .template
            .as_ref()
            .and_then(|t| self.templates.get(t))
            .and_then(|t| Some((t.width?, t.height?)));
        PageEvents { canvas_title: state.canvas.clone(), size }
    }
}

/// The uuid numerically one below `id` (128-bit, wrapping), upper-case and dashed 8-4-4-4-12;
/// `None` unless `id` holds exactly 32 hex digits.
fn preceding_uuid(id: &str) -> Option<String> {
    let digits: String = id.chars().filter(|c| *c != '-').collect();
    if digits.len() != 32 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let prev = u128::from_str_radix(&digits, 16).ok()?.wrapping_sub(1);
    let h = format!("{prev:032X}");
    Some([&h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]].join("-"))
}

// ---------------------------------------------------------------------------------------------
// Other index files
// ---------------------------------------------------------------------------------------------

/// A `{1: key, 2: value}` string index (`index.attachments.pb`, `index.backgrounds.pb`).
fn read_string_index(
    src: &mut ZipSource<'_>,
    name: &str,
) -> Result<HashMap<String, String>, ImportError> {
    let mut map = HashMap::new();
    if let Some(buf) = src.entry(name)? {
        for rec in delimited(&buf) {
            let Some(m) = Msg::top(rec) else { continue };
            if let (Some(k), Some(v)) = (m.string(1), m.string(2)) {
                map.insert(k, v);
            }
        }
    }
    Ok(map)
}

/// `index.notes.pb`: the listed page paths (in order, existing, unique) and page sizes by id.
type NotesIndex = (Vec<String>, HashMap<String, (f64, f64)>);

fn read_notes_index(src: &mut ZipSource<'_>) -> Result<NotesIndex, ImportError> {
    let mut order = Vec::new();
    let mut seen = HashSet::new();
    let mut sizes = HashMap::new();
    let Some(buf) = src.entry("index.notes.pb")? else {
        return Ok((order, sizes));
    };
    for rec in delimited(&buf) {
        let Some(m) = Msg::top(rec) else { continue };
        let id = m.string(1);
        let path = m.string(2).or_else(|| id.as_ref().map(|id| format!("{NOTES_PREFIX}{id}")));
        if let Some(path) = path
            && path.starts_with(NOTES_PREFIX)
            && src.has(&path)
            && seen.insert(path.clone())
        {
            order.push(path);
        }
        let size = |n: u32| m.string(n).and_then(|s| parse_float_prefix(&s));
        if let (Some(id), Some(w), Some(h)) = (id, size(3), size(4))
            && valid_size(w, h)
        {
            sizes.insert(id, (w, h));
        }
    }
    Ok((order, sizes))
}

fn valid_size(w: f64, h: f64) -> bool {
    w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0
}

/// The first `/MediaBox [x0 y0 x1 y1]` of a PDF → (|x1 − x0|, |y1 − y0|), both > 0.
fn pdf_media_box(pdf: &[u8]) -> Option<(f64, f64)> {
    const KEY: &[u8] = b"/MediaBox";
    let skip_ws = |pos: &mut usize| {
        while *pos < pdf.len() && pdf[*pos].is_ascii_whitespace() {
            *pos += 1;
        }
    };
    let mut from = 0;
    while let Some(i) = pdf[from..].windows(KEY.len()).position(|w| w == KEY) {
        let mut pos = from + i + KEY.len();
        from = pos;
        skip_ws(&mut pos);
        if pdf.get(pos) != Some(&b'[') {
            continue;
        }
        pos += 1;
        let mut nums = [0f64; 4];
        let mut ok = true;
        for (k, n) in nums.iter_mut().enumerate() {
            skip_ws(&mut pos);
            let s = pos;
            if pdf.get(pos) == Some(&b'-') {
                pos += 1;
            }
            let digits = pos;
            while pos < pdf.len() && (pdf[pos].is_ascii_digit() || pdf[pos] == b'.') {
                pos += 1;
            }
            let parsed = if pos > digits {
                std::str::from_utf8(&pdf[s..pos]).ok().and_then(parse_float_prefix)
            } else {
                None
            };
            // Numbers are separated by whitespace; the last may be followed by `]`.
            let separated = k == 3 || pdf.get(pos).is_some_and(u8::is_ascii_whitespace);
            match parsed {
                Some(v) if separated => *n = v,
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        skip_ws(&mut pos);
        if pdf.get(pos) != Some(&b']') {
            continue;
        }
        let (w, h) = ((nums[2] - nums[0]).abs(), (nums[3] - nums[1]).abs());
        return (w > 0.0 && h > 0.0).then_some((w, h));
    }
    None
}

/// The page size of the one PDF template shared by every PDF attachment (MediaBox ×
/// [`PDF_TEMPLATE_SCALE`]), if they all have the same size.
fn shared_pdf_template(src: &mut ZipSource<'_>) -> Result<Option<(f64, f64)>, ImportError> {
    let mut names: Vec<String> =
        src.names().into_iter().filter(|n| n.starts_with("attachments/")).collect();
    names.sort();
    let mut sizes: Vec<(f64, f64)> = Vec::new();
    for name in names {
        if src.head(&name, 4)?.as_deref() != Some(b"%PDF") {
            continue;
        }
        if let Some(size) = src.entry(&name)?.as_deref().and_then(pdf_media_box) {
            sizes.push(size);
        }
    }
    let Some(&first) = sizes.first() else {
        return Ok(None);
    };
    let label = |(w, h): (f64, f64)| format!("{w:.1}x{h:.1}");
    if sizes.iter().any(|s| label(*s) != label(first)) {
        return Ok(None);
    }
    Ok(Some((first.0 * PDF_TEMPLATE_SCALE, first.1 * PDF_TEMPLATE_SCALE)))
}

// ---------------------------------------------------------------------------------------------
// Page elements
// ---------------------------------------------------------------------------------------------

fn sniff_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else if b.starts_with(b"BM") {
        Some("image/bmp")
    } else if b.starts_with(b"II*\0") || b.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if b.len() >= 12 && &b[4..8] == b"ftyp" {
        Some("image/heic")
    } else if b.starts_with(b"%PDF") {
        Some("application/pdf")
    } else {
        None
    }
}

/// Field 9 of a stroke body: polyline points (9.1/9.2 lists of `{1: x, 2: y}`), the 9.15
/// width, and whether it describes a rectangle (9.3) or ellipse (9.4) shape.
#[derive(Debug, Default)]
struct Fallback {
    points: Vec<(f64, f64)>,
    width: Option<f64>,
    shape: bool,
}

impl Fallback {
    fn read(body: &Msg<'_>) -> Fallback {
        let Some(g) = body.sub(9) else {
            return Fallback::default();
        };
        let mut points = Vec::new();
        for (f, w) in &g.fields {
            let (1 | 2, Wire::Len(b)) = (*f, w) else {
                continue;
            };
            let Some(list) = g.child(b) else { continue };
            for (_, w) in &list.fields {
                if let Some(p) = w.as_bytes().and_then(|b| list.child(b)).and_then(|m| m.point()) {
                    points.push(p);
                }
            }
        }
        let finite = |m: Option<Msg<'_>>| {
            m.and_then(|m| m.point()).filter(|(x, y)| x.is_finite() && y.is_finite())
        };
        let positive = |m: Option<Msg<'_>>| finite(m).is_some_and(|(w, h)| w > 0.0 && h > 0.0);
        let rect = g.sub(3).is_some_and(|r| finite(r.sub(1)).is_some() && positive(r.sub(2)));
        let ellipse = g.sub(4).is_some_and(|e| {
            finite(e.sub(1)).is_some() && positive(e.sub(2)) && e.f32(3).is_none_or(f64::is_finite)
        });
        Fallback { points, width: g.f32(15), shape: rect || ellipse }
    }

    /// Exactly 5 points that close (within 0.001) around a non-zero area: a rectangle.
    fn is_rectangle(&self) -> bool {
        let p = &self.points;
        if p.len() != 5 {
            return false;
        }
        let closes = (p[0].0 - p[4].0).abs() <= 0.001 && (p[0].1 - p[4].1).abs() <= 0.001;
        let twice_area: f64 = (0..4).map(|i| p[i].0 * p[i + 1].1 - p[i + 1].0 * p[i].1).sum();
        closes && twice_area != 0.0 && twice_area.is_finite()
    }
}

/// One stroke element as collected before decoding.
struct StrokeElement<'a> {
    id: String,
    blob: Option<&'a [u8]>,
    color: [f64; 4],
    fallback: Fallback,
    offset: (f64, f64),
}

/// `{1: x, 2: y}` where present fields must be fixed32 (missing = 0).
fn strict_point(m: Option<Msg<'_>>) -> Option<(f64, f64)> {
    let m = m?;
    let get = |n: u32| match m.fields.iter().find(|(f, _)| *f == n) {
        None => Some(0.0),
        Some((_, Wire::Fixed32(_))) => m.f32(n),
        Some(_) => None,
    };
    Some((get(1)?, get(2)?))
}

/// A text object (field 21) → text, or `None` if it carries no decodable text. The blob at
/// 32.1.2 (or its field 12) is LZ4; its payload is runs `{1: {1: text, 2: attributes}}`.
fn read_text(t: &Msg<'_>, src: &mut ZipSource<'_>) -> Result<Option<ImportText>, ImportError> {
    let s32 = t.sub(32);
    let Some(holder) = sub_of(s32.as_ref(), 1) else {
        return Ok(None);
    };
    let Some(raw) = holder.bytes(2) else {
        return Ok(None);
    };
    let blob = if starts_bv4(raw) {
        raw
    } else {
        match holder.child(raw).and_then(|m| m.bytes(12)).filter(|b| starts_bv4(b)) {
            Some(b) => b,
            None => return Ok(None),
        }
    };
    let Some(payload) = unwrap_text_blob(blob, src)? else {
        return Ok(None);
    };
    let Some(runs) = holder.child(&payload) else {
        return Ok(None);
    };
    let mut content = String::new();
    let mut run_size: Option<f64> = None;
    let mut run_color: Option<String> = None;
    let mut first = true;
    for (f, w) in &runs.fields {
        let (1, Wire::Len(b)) = (*f, w) else { continue };
        let Some(run) = runs.child(b) else { continue };
        let Some(text) = run.bytes(1) else { continue };
        content.push_str(&String::from_utf8_lossy(text));
        if !std::mem::take(&mut first) {
            continue;
        }
        let Some(attrs) = run.sub(2) else { continue };
        run_size = attrs.f32(40).filter(|s| s.is_finite() && *s > 0.0);
        if let Some(c) = attrs.sub(3) {
            let ch = [c.f32(1), c.f32(2), c.f32(3)];
            if ch.iter().any(Option::is_some) && ch.iter().all(|v| v.is_none_or(f64::is_finite)) {
                run_color =
                    Some(hex(ch[0].unwrap_or(0.0), ch[1].unwrap_or(0.0), ch[2].unwrap_or(0.0)));
            }
        }
    }
    if content.trim().is_empty() {
        return Ok(None);
    }
    let s21 = t.sub(21);
    let width = sub_of(s21.as_ref(), 3)
        .and_then(|m| m.f32(2))
        .or_else(|| sub_of(s21.as_ref(), 2).and_then(|m| m.f32(1)))
        .filter(|w| w.is_finite() && *w > 0.0);
    let origin = sub_of(t.sub(20).as_ref(), 1)
        .and_then(|m| m.point())
        .or_else(|| sub_of(s32.as_ref(), 2).and_then(|m| m.point()))
        .unwrap_or((0.0, 0.0));
    let doc_size = sub_of(sub_of(s32.as_ref(), 5).as_ref(), 1)
        .and_then(|m| m.f32(40))
        .filter(|s| s.is_finite() && *s > 0.0);
    Ok(Some(ImportText {
        x: origin.0,
        y: origin.1,
        width,
        text: content,
        font_size: run_size.or(doc_size),
        color: run_color.unwrap_or_else(|| "#000000".into()),
    }))
}

/// A text object without text is a shape when it has an origin and a positive size.
fn is_box_shape(t: &Msg<'_>) -> bool {
    let origin = sub_of(t.sub(20).as_ref(), 1).and_then(|m| m.point()).is_some();
    let s21 = t.sub(21);
    let size = [2, 3].iter().any(|n| {
        sub_of(s21.as_ref(), *n)
            .and_then(|m| m.point())
            .is_some_and(|(w, h)| w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0)
    });
    origin && size
}

/// A freehand shape (field 22) has at least two points in 22.21 (or 22.20).
fn is_polyline_shape(s: &Msg<'_>) -> bool {
    let Some(pts) = s.sub(21).or_else(|| s.sub(20)) else {
        return false;
    };
    pts.fields
        .iter()
        .filter(|(f, _)| matches!(f, 1..=3))
        .filter_map(|(_, w)| pts.child(w.as_bytes()?))
        .filter(|m| m.point().or_else(|| m.sub(1).and_then(|p| p.point())).is_some())
        .count()
        >= 2
}

/// An image whose bytes are attached once every page has been read.
struct PendingImage {
    page: usize,
    image: usize,
    path: String,
}

/// The ids hidden by version records (fields 1 + 2 + 8; the last record for an id decides,
/// field 3 == 1 deletes).
struct Hidden(HashMap<String, bool>);

impl Hidden {
    fn read(elements: &[Option<Msg<'_>>]) -> Hidden {
        let mut versions = HashMap::new();
        for e in elements.iter().flatten() {
            if let Some(id) = e.string(1)
                && e.has_len(2)
                && e.has_varint(8)
            {
                versions.insert(id, e.varint(3) == Some(1));
            }
        }
        Hidden(versions)
    }

    fn contains(&self, id: &str) -> bool {
        self.0.get(id) == Some(&true)
    }
}

struct Importer<'s, 'z> {
    src: &'s mut ZipSource<'z>,
    limits: ImportLimits,
    attachments: HashMap<String, String>,
    /// Attachment bytes by zip path (read once).
    files: HashMap<String, Option<Vec<u8>>>,
    pending_images: Vec<PendingImage>,
    /// Points emitted over the whole file.
    points: usize,
}

impl Importer<'_, '_> {
    /// One `notes/<id>` entry → the page's strokes, texts and images.
    fn read_page(
        &mut self,
        buf: &[u8],
        page_index: usize,
        page: &mut ImportPage,
    ) -> Result<(), ImportError> {
        let mut elements: Vec<Option<Msg<'_>>> = Vec::new();
        for r in delimited(buf) {
            let m = Msg::top(r);
            if m.is_none() {
                page.skipped.other += 1;
            }
            elements.push(m);
        }
        let hidden = Hidden::read(&elements);
        self.read_strokes(&elements, &hidden, page)?;
        self.read_texts(&elements, &hidden, page)?;
        self.read_images(&elements, &hidden, page_index, page)?;
        Ok(())
    }

    fn read_strokes(
        &mut self,
        elements: &[Option<Msg<'_>>],
        hidden: &Hidden,
        page: &mut ImportPage,
    ) -> Result<(), ImportError> {
        // Group origins (21|22 → 20.1, last wins) and element → parent group (1 + 20).
        let mut origins: HashMap<String, (f64, f64)> = HashMap::new();
        let mut parents: HashMap<String, String> = HashMap::new();
        for e in elements.iter().flatten() {
            for n in [21, 22] {
                let Some(o) = e.sub(n) else { continue };
                let Some(id) = o.string(1) else { continue };
                let Some(p) = o.sub(20).and_then(|m| m.sub(1)) else {
                    continue;
                };
                let (x, y) = (p.f32(1).unwrap_or(0.0), p.f32(2).unwrap_or(0.0));
                if x.is_finite() && y.is_finite() {
                    origins.insert(id, (x, y));
                }
            }
            if let (Some(id), Some(parent)) = (e.string(1), e.string(20)) {
                parents.insert(id, parent);
            }
        }

        // One entry per 7.1 id, kept at its first position with the last element's content.
        let mut found: Vec<StrokeElement<'_>> = Vec::new();
        let mut slot: HashMap<String, usize> = HashMap::new();
        for e in elements.iter().flatten() {
            if !e.has_len(7) {
                continue;
            }
            let Some(body) = e.sub(7) else {
                page.skipped.other += 1;
                continue;
            };
            let Some(id) = body.string(1) else {
                page.skipped.other += 1;
                continue;
            };
            if hidden.contains(&id) {
                continue;
            }
            let offset = body
                .sub(6)
                .map(|o| (o.f32(1).unwrap_or(0.0), o.f32(2).unwrap_or(0.0)))
                .unwrap_or((0.0, 0.0));
            let element = StrokeElement {
                id: id.clone(),
                blob: body.bytes(2),
                color: rgba(body.sub(4).as_ref()),
                fallback: Fallback::read(&body),
                offset,
            };
            match slot.get(&id) {
                Some(&i) => found[i] = element,
                None => {
                    slot.insert(id, found.len());
                    found.push(element);
                }
            }
        }

        for (i, element) in found.into_iter().enumerate() {
            if i.is_multiple_of(256) {
                check_deadline(&self.limits)?;
            }
            let decoded = match element.blob.filter(|b| is_path_blob(b)) {
                Some(blob) => match unwrap_path_blob(blob, self.src)? {
                    Some(payload) => decode_payload(&payload, &self.limits)?,
                    None => Err(Unreadable::Invalid("bad bv4 container")),
                },
                None => Err(Unreadable::Invalid("no path blob")),
            };
            let (paths, family_width) = match decoded {
                Ok(d) => (d.paths, d.family_width),
                Err(Unreadable::TooManyPoints) => {
                    page.skipped.other += 1;
                    continue;
                }
                Err(Unreadable::Invalid(_)) => {
                    let fb = &element.fallback;
                    if fb.points.is_empty() {
                        if fb.shape {
                            page.skipped.shapes += 1;
                        } else if element.blob.is_some() {
                            page.skipped.other += 1;
                        }
                        continue;
                    }
                    if fb.is_rectangle() {
                        page.skipped.shapes += 1;
                        continue;
                    }
                    let path = fb.points.iter().map(|&(x, y)| Sample { x, y, ..Sample::default() });
                    let width = fb.width.filter(|w| w.is_finite() && *w > 0.0);
                    (vec![path.collect()], width)
                }
            };
            let origin = match parents.get(&element.id) {
                Some(parent) => match origins.get(parent) {
                    Some(o) => *o,
                    None => {
                        // The group it belongs to cannot be read.
                        page.skipped.other += 1;
                        continue;
                    }
                },
                None => (0.0, 0.0),
            };
            let (dx, dy) = (element.offset.0 + origin.0, element.offset.1 + origin.1);
            let [r, g, b, a] = element.color;
            let highlighter = a < HIGHLIGHTER_BELOW_ALPHA;
            for path in paths {
                let width = median_width(&path).or(family_width).unwrap_or(DEFAULT_WIDTH);
                let points: Vec<ImportPoint> = path
                    .iter()
                    .map(|s| ImportPoint {
                        x: s.x + dx,
                        y: s.y + dy,
                        pressure: s
                            .force
                            .filter(|f| f.is_finite())
                            .map(|f| (f / 5.0).clamp(0.01, 1.0)),
                    })
                    .filter(|p| p.x.is_finite() && p.y.is_finite())
                    .collect();
                if points.len() < 2 {
                    continue;
                }
                self.points += points.len();
                if self.points > MAX_POINTS_PER_FILE {
                    return Err(ImportError::Limit(format!(
                        "its strokes have more than {MAX_POINTS_PER_FILE} points"
                    )));
                }
                page.strokes.push(ImportStroke {
                    points,
                    color: hex(r, g, b),
                    opacity: if highlighter { 0.5 } else { 1.0 },
                    width,
                    is_highlighter: highlighter,
                    pen_style: if highlighter { PenStyle::Highlighter } else { PenStyle::Pen },
                    z_index: page.strokes.len() as i64,
                });
            }
        }
        Ok(())
    }

    fn read_texts(
        &mut self,
        elements: &[Option<Msg<'_>>],
        hidden: &Hidden,
        page: &mut ImportPage,
    ) -> Result<(), ImportError> {
        // The last element carrying a text id is the one used.
        let mut last: HashMap<String, usize> = HashMap::new();
        for (i, e) in elements.iter().enumerate() {
            if let Some(id) = e.as_ref().and_then(|e| e.sub(21)).and_then(|t| t.string(1)) {
                last.insert(id, i);
            }
        }
        for (i, e) in elements.iter().enumerate() {
            let Some(e) = e else { continue };
            if let Some(s) = e.sub(22) {
                if !s.string(1).is_some_and(|id| hidden.contains(&id)) && is_polyline_shape(&s) {
                    page.skipped.shapes += 1;
                }
                continue;
            }
            let Some(t) = e.sub(21) else { continue };
            if let Some(id) = t.string(1)
                && (hidden.contains(&id) || last.get(&id) != Some(&i))
            {
                continue;
            }
            if t.varint(4) == Some(1) {
                continue;
            }
            match read_text(&t, self.src)? {
                Some(text) if text.x.is_finite() && text.y.is_finite() => page.texts.push(text),
                Some(_) => page.skipped.other += 1,
                None if is_box_shape(&t) => page.skipped.shapes += 1,
                None => {}
            }
        }
        Ok(())
    }

    fn read_images(
        &mut self,
        elements: &[Option<Msg<'_>>],
        hidden: &Hidden,
        page_index: usize,
        page: &mut ImportPage,
    ) -> Result<(), ImportError> {
        // {1: {1: id, 4: attachment uuid, 3: {1: centre, 2: size}}}.
        for e in elements.iter().flatten() {
            let Some(o) = e.sub(1) else { continue };
            if o.string(1).is_some_and(|id| hidden.contains(&id)) {
                continue;
            }
            let Some(att) = o.bytes(4).filter(|b| is_uuid(b)) else {
                continue;
            };
            let Some(geo) = o.sub(3) else { continue };
            let (Some(c), Some(s)) = (strict_point(geo.sub(1)), strict_point(geo.sub(2))) else {
                continue;
            };
            let att = String::from_utf8_lossy(att).into_owned();
            let Some(path) = self.attachments.get(&att).cloned() else {
                continue;
            };
            let (w, h) = (s.0.abs(), s.1.abs());
            if !(w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite()) {
                continue;
            }
            let (x, y) = (c.0 - w / 2.0, c.1 - h / 2.0);
            if !x.is_finite() || !y.is_finite() {
                page.skipped.other += 1;
                continue;
            }
            let Some(bytes) = self.load_attachment(&path)? else {
                continue;
            };
            let mime = sniff_mime(bytes);
            if mime == Some("application/pdf") {
                // PDF stickers are not imported.
                page.skipped.other += 1;
                continue;
            }
            self.pending_images.push(PendingImage {
                page: page_index,
                image: page.images.len(),
                path,
            });
            page.images.push(ImportImage {
                x,
                y,
                width: w,
                height: h,
                bytes: Vec::new(),
                mime: mime.map(str::to_owned),
            });
        }
        Ok(())
    }

    /// Reads an attachment once; later calls return the cached result.
    fn load_attachment(&mut self, path: &str) -> Result<Option<&[u8]>, ImportError> {
        if !self.files.contains_key(path) {
            let b = if is_safe_name(path) { self.src.entry(path)? } else { None };
            self.files.insert(path.to_owned(), b);
        }
        Ok(self.files.get(path).and_then(|b| b.as_deref()))
    }

    /// Gives every pending image its bytes: the last image using an attachment takes the cached
    /// buffer, earlier ones get copies charged to the zip budget.
    fn attach_images(&mut self, pages: &mut [ImportPage]) -> Result<(), ImportError> {
        let mut uses: HashMap<String, usize> = HashMap::new();
        for p in &self.pending_images {
            *uses.entry(p.path.clone()).or_default() += 1;
        }
        for p in std::mem::take(&mut self.pending_images) {
            let left = uses.get_mut(&p.path).expect("counted above");
            *left -= 1;
            let bytes = if *left == 0 {
                self.files.remove(&p.path).flatten().unwrap_or_default()
            } else {
                let copy = self.files.get(&p.path).cloned().flatten().unwrap_or_default();
                self.src.charge(copy.len() as u64)?;
                copy
            };
            pages[p.page].images[p.image].bytes = bytes;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Canvas boards (§1h.7)
// ---------------------------------------------------------------------------------------------

/// An axis-aligned box grown point by point.
struct Extent {
    min: (f64, f64),
    max: (f64, f64),
}

impl Extent {
    fn of(page: &ImportPage) -> Extent {
        let mut e = Extent {
            min: (f64::INFINITY, f64::INFINITY),
            max: (f64::NEG_INFINITY, f64::NEG_INFINITY),
        };
        for s in &page.strokes {
            let half = s.width / 2.0;
            for p in &s.points {
                e.cover(p.x - half, p.y - half);
                e.cover(p.x + half, p.y + half);
            }
        }
        for t in &page.texts {
            let lines = t.text.split('\n').count() as f64;
            e.cover(t.x, t.y);
            e.cover(t.x + t.width.unwrap_or(0.0), t.y + BOARD_LINE_HEIGHT * lines);
        }
        // Mate places images unrotated, so their unrotated boxes bound them.
        for i in &page.images {
            e.cover(i.x, i.y);
            e.cover(i.x + i.width, i.y + i.height);
        }
        e
    }

    fn cover(&mut self, x: f64, y: f64) {
        self.min = (self.min.0.min(x), self.min.1.min(y));
        self.max = (self.max.0.max(x), self.max.1.max(y));
    }

    fn is_empty(&self) -> bool {
        self.min.0 > self.max.0
    }
}

/// A canvas board has no page size: the page becomes the content's extent plus a margin on
/// every side, and the content moves so the extent starts at the margin. Returns false when the
/// board is degraded: wider or taller than [`BOARD_MAX_SIDE`] (kept at its fitted size), or
/// without a finite extent (left as it is).
fn fit_canvas(page: &mut ImportPage) -> bool {
    let extent = Extent::of(page);
    if extent.is_empty() {
        (page.width, page.height) = DEFAULT_SIZE;
        return true;
    }
    let width = (extent.max.0 - extent.min.0 + 2.0 * BOARD_MARGIN).ceil();
    let height = (extent.max.1 - extent.min.1 + 2.0 * BOARD_MARGIN).ceil();
    let (dx, dy) = (BOARD_MARGIN - extent.min.0, BOARD_MARGIN - extent.min.1);
    if ![width, height, dx, dy].iter().all(|v| v.is_finite()) {
        return false;
    }
    for p in page.strokes.iter_mut().flat_map(|s| s.points.iter_mut()) {
        p.x += dx;
        p.y += dy;
    }
    for t in &mut page.texts {
        t.x += dx;
        t.y += dy;
    }
    for i in &mut page.images {
        i.x += dx;
        i.y += dy;
    }
    (page.width, page.height) = (width, height);
    width <= BOARD_MAX_SIDE && height <= BOARD_MAX_SIDE
}

fn background(kind: Option<&str>) -> ImportBackground {
    // GoodNotes stores no line spacing here; 0 makes the placer use Mate's default spacing.
    match kind {
        Some("ruled" | "cornell") => ImportBackground::Lined { spacing: 0.0 },
        Some("grid") => ImportBackground::Grid { spacing: 0.0 },
        Some("dotted") => ImportBackground::Dotted { spacing: 0.0 },
        _ => ImportBackground::Plain,
    }
}

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    check_deadline(limits)?;
    let mut note_entries: Vec<String> = src
        .names()
        .into_iter()
        .filter(|n| {
            n.len() > NOTES_PREFIX.len() && n.starts_with(NOTES_PREFIX) && !n.ends_with('/')
        })
        .collect();
    note_entries.sort();
    if note_entries.is_empty() && !src.has("index.notes.pb") {
        return Err(ImportError::Unsupported("not a GoodNotes notebook: it has no pages".into()));
    }

    let attachments = read_string_index(src, "index.attachments.pb")?;
    let events = EventLog::read(src)?;
    let backgrounds = read_string_index(src, "index.backgrounds.pb")?;
    let (listed, sizes) = read_notes_index(src)?;

    // Listed pages first, then the others in name order; deleted pages are left out.
    let listed_set: HashSet<&String> = listed.iter().collect();
    let order: Vec<String> = listed
        .iter()
        .chain(note_entries.iter().filter(|n| !listed_set.contains(n)))
        .filter(|path| !events.is_deleted(&path[NOTES_PREFIX.len()..]))
        .cloned()
        .collect();

    // Size: event-log template, then index.notes.pb, then the shared PDF template (read only
    // when some page needs it).
    let own_size = |id: &str| -> Option<(f64, f64)> {
        [events.page(id).size, sizes.get(id).copied()]
            .into_iter()
            .flatten()
            .find(|&(w, h)| valid_size(w, h))
    };
    let needs_template = order
        .iter()
        .take(limits.max_pages)
        .any(|path| own_size(&path[NOTES_PREFIX.len()..]).is_none());
    let template = if needs_template { shared_pdf_template(src)? } else { None };

    let mut importer = Importer {
        src,
        limits: limits.clone(),
        attachments,
        files: HashMap::new(),
        pending_images: Vec::new(),
        points: 0,
    };
    let mut pages: Vec<ImportPage> = Vec::with_capacity(order.len());
    for (i, path) in order.iter().enumerate() {
        check_deadline(limits)?;
        let id = path[NOTES_PREFIX.len()..].to_owned();
        if i >= limits.max_pages {
            // Past the page cap: listed (so the placer reports them as left out) but not read.
            pages.push(ImportPage {
                source_id: id,
                width: DEFAULT_SIZE.0,
                height: DEFAULT_SIZE.1,
                ..ImportPage::default()
            });
            continue;
        }
        let event = events.page(&id);
        let (width, height) = own_size(&id)
            .or(template.filter(|&(w, h)| valid_size(w, h)))
            .unwrap_or(DEFAULT_SIZE);
        let mut page = ImportPage {
            source_id: id.clone(),
            title: event.canvas_title.clone().flatten(),
            width,
            height,
            background: background(backgrounds.get(&id).map(String::as_str)),
            ..ImportPage::default()
        };
        let buf = importer.src.entry(path)?.unwrap_or_default();
        importer.read_page(&buf, i, &mut page)?;
        if event.canvas_title.is_some() && !fit_canvas(&mut page) {
            page.skipped.other += 1;
        }
        pages.push(page);
    }
    importer.attach_images(&mut pages)?;

    Ok(ImportDocument {
        source: ImportSource::GoodNotes,
        title: String::new(),
        default_page_mode: PageMode::Page,
        sections: vec![ImportSection { source_id: String::new(), title: String::new(), pages }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a `tpl` payload: the schema, then values appended in order.
    struct Tpl(Vec<u8>);

    impl Tpl {
        fn new(schema: &str) -> Tpl {
            let mut b = b"tpl\0\0\0\0\0".to_vec();
            b.extend_from_slice(schema.as_bytes());
            b.push(0);
            Tpl(b)
        }
        fn v(mut self, v: u16) -> Tpl {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn u(mut self, v: f32) -> Tpl {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        /// `A(v)`.
        fn vs(mut self, vals: &[u16]) -> Tpl {
            self.0.extend_from_slice(&(vals.len() as u32).to_le_bytes());
            for v in vals {
                self.0.extend_from_slice(&v.to_le_bytes());
            }
            self
        }
        /// An array of `n` elements made of the f32 values `vals`.
        fn records(mut self, n: usize, vals: &[f32]) -> Tpl {
            self.0.extend_from_slice(&(n as u32).to_le_bytes());
            for v in vals {
                self.0.extend_from_slice(&v.to_le_bytes());
            }
            self
        }
        /// `A(u)`.
        fn us(self, vals: &[f32]) -> Tpl {
            self.records(vals.len(), vals)
        }
    }

    fn plain(width: f32, flags: &[u16], moves: &[f32], curves: &[f32]) -> Tpl {
        Tpl::new(PLAIN_PREFIX)
            .v(0)
            .u(width)
            .vs(flags)
            .records(moves.len() / 2, moves)
            .records(curves.len() / 4, curves)
    }

    fn pressure(version: u16, flags: &[u16], moves: &[f32], curves: &[f32], nibs: &[f32]) -> Tpl {
        Tpl::new(PRESSURE_SCHEMA)
            .v(version)
            .vs(flags)
            .us(moves)
            .us(curves)
            .vs(&[])
            .vs(&[])
            .us(&[])
            .us(&[])
            .us(&[])
            .us(nibs)
            .vs(&[])
    }

    fn decode(t: &Tpl) -> Result<DecodedPath, Unreadable> {
        decode_payload(&t.0, &ImportLimits::default()).unwrap()
    }

    fn xy(path: &[Sample]) -> Vec<(f64, f64)> {
        path.iter().map(|s| (s.x, s.y)).collect()
    }

    fn widths(path: &[Sample]) -> Vec<Option<f64>> {
        path.iter().map(|s| s.width).collect()
    }

    fn stroke_width(d: &DecodedPath, i: usize) -> f64 {
        median_width(&d.paths[i]).or(d.family_width).unwrap_or(DEFAULT_WIDTH)
    }

    #[test]
    fn parses_float_prefixes_like_javascript() {
        assert_eq!(parse_float_prefix("540"), Some(540.0));
        assert_eq!(parse_float_prefix("  12.5px"), Some(12.5));
        assert_eq!(parse_float_prefix("1e3x"), Some(1000.0));
        assert_eq!(parse_float_prefix("2e"), Some(2.0));
        assert_eq!(parse_float_prefix("abc"), None);
    }

    #[test]
    fn preceding_uuid_wraps_and_upper_cases() {
        assert_eq!(
            preceding_uuid("aaaaaaaa-0000-0000-0000-000000000010").as_deref(),
            Some("AAAAAAAA-0000-0000-0000-00000000000F")
        );
        assert_eq!(
            preceding_uuid("00000000-0000-0000-0000-000000000000").as_deref(),
            Some("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")
        );
        assert_eq!(preceding_uuid("not-a-uuid"), None);
    }

    #[test]
    fn schema_grammar() {
        let s = Schema::parse("vuA(v)A(S(uu))").unwrap();
        assert_eq!(
            s.groups,
            vec![
                Term::Leaf(Scalar::Half),
                Term::Leaf(Scalar::Float),
                Term::Array(vec![Term::Leaf(Scalar::Half)]),
                Term::Array(vec![Term::Struct(vec![Term::Leaf(Scalar::Float); 2])]),
            ]
        );
        assert_eq!(Schema::parse("S(u)"), Err(Unreadable::Invalid("bare top-level struct")));
        assert_eq!(Schema::parse("A(u"), Err(Unreadable::Invalid("unbalanced")));
        assert_eq!(Schema::parse("u)"), Err(Unreadable::Invalid("unbalanced")));
        assert_eq!(Schema::parse("x"), Err(Unreadable::Invalid("bad schema char")));
        assert_eq!(Schema::parse("Au"), Err(Unreadable::Invalid("bad schema char")));
        let deep = format!("{}u{}", "A(".repeat(17), ")".repeat(17));
        assert!(Schema::parse(&deep).is_err());
        let ok = format!("{}u{}", "A(".repeat(16), ")".repeat(16));
        assert!(Schema::parse(&ok).is_ok());
    }

    #[test]
    fn data_groups_are_consumed_exactly() {
        let schema = Schema::parse("vA(S(uv))A(A(v))").unwrap();
        let mut data = 7u16.to_le_bytes().to_vec();
        data.extend_from_slice(&2u32.to_le_bytes());
        for (f, h) in [(1.5f32, 3u16), (2.5, 4)] {
            data.extend_from_slice(&f.to_le_bytes());
            data.extend_from_slice(&h.to_le_bytes());
        }
        data.extend_from_slice(&1u32.to_le_bytes());
        data.extend_from_slice(&2u32.to_le_bytes());
        data.extend_from_slice(&[9, 0, 8, 0]);
        let groups = read_groups(&schema, &data).unwrap();
        assert!(matches!(groups[0], Group::Value(v) if v == 7.0));
        let Group::List(col) = &groups[1] else { panic!("{:?}", groups[1]) };
        let vals: Vec<f64> = (0..col.len()).map(|i| col.get(i)).collect();
        assert_eq!(vals, vec![1.5, 3.0, 2.5, 4.0]);
        assert!(matches!(groups[2], Group::Nested));

        let mut extra = data.clone();
        extra.push(0);
        assert!(read_groups(&schema, &extra).is_err(), "leftover byte");
        assert!(read_groups(&schema, &data[..data.len() - 1]).is_err(), "short data");
        // A count larger than the remaining bytes, and a zero-size element.
        let big = Schema::parse("A(u)").unwrap();
        assert_eq!(
            read_groups(&big, &u32::MAX.to_le_bytes()).err(),
            Some(Unreadable::Invalid("bad count"))
        );
        let empty = Schema::parse("A(S())").unwrap();
        assert_eq!(
            read_groups(&empty, &1u32.to_le_bytes()).err(),
            Some(Unreadable::Invalid("zero-size element"))
        );
    }

    #[test]
    fn flattening_segment_counts() {
        assert_eq!(segment_count((0.0, 0.0), (5.0, 0.0), (10.0, 0.0)), 2);
        assert_eq!(segment_count((0.0, 0.0), (50.0, 50.0), (100.0, 0.0)), 8);
        assert_eq!(segment_count((0.0, 0.0), (0.0, 8.0), (0.0, 0.0)), 3);
        assert_eq!(segment_count((0.0, 0.0), (1e9, 1e9), (0.0, 1.0)), 64);
        assert_eq!(segment_count((f64::NAN, 0.0), (1.0, 1.0), (2.0, 0.0)), 2);
        // A zero-length curve: the point repeated (a dot is a valid stroke).
        let d = decode(&plain(1.0, &[0, 1], &[3.0, 4.0], &[3.0, 4.0, 3.0, 4.0])).unwrap();
        assert_eq!(xy(&d.paths[0]), vec![(3.0, 4.0); 3]);
    }

    /// §1h.8: the 14 decoder vectors, with per-point widths (source units).
    #[test]
    fn goodnotes_f3_test_vectors() {
        // 1. F1 basic.
        let d = decode(&plain(2.5, &[0, 1], &[0.0, 0.0], &[5.0, 0.0, 10.0, 0.0])).unwrap();
        assert_eq!(d.paths.len(), 1);
        assert_eq!(xy(&d.paths[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
        assert_eq!(stroke_width(&d, 0), 2.5);
        assert!(d.paths[0].iter().all(|s| s.force.is_none()));
        // 2. Width out of range → 2.
        for w in [80.0, 0.1] {
            let d = decode(&plain(w, &[0, 1], &[0.0, 0.0], &[5.0, 0.0, 10.0, 0.0])).unwrap();
            assert_eq!(stroke_width(&d, 0), 2.0, "width {w}");
        }
        // 3. Two curves continue one sub-path.
        let d = decode(&plain(
            2.0,
            &[0, 1, 1],
            &[0.0, 0.0],
            &[5.0, 0.0, 10.0, 0.0, 15.0, 0.0, 20.0, 0.0],
        ))
        .unwrap();
        assert_eq!(
            xy(&d.paths[0]),
            vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (15.0, 0.0), (20.0, 0.0)]
        );
        // 4. Two moves → two sub-paths of 3 points.
        let d = decode(&plain(
            2.0,
            &[0, 1, 0, 1],
            &[0.0, 0.0, 0.0, 10.0],
            &[5.0, 0.0, 10.0, 0.0, 5.0, 10.0, 10.0, 10.0],
        ))
        .unwrap();
        assert_eq!(d.paths.len(), 2);
        assert_eq!(xy(&d.paths[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
        assert_eq!(xy(&d.paths[1]), vec![(0.0, 10.0), (5.0, 10.0), (10.0, 10.0)]);
        // 5. Unreadable cases.
        let bad = [
            (plain(2.0, &[1], &[], &[5.0, 0.0, 10.0, 0.0]), "curve before moveTo"),
            (plain(2.0, &[0, 1], &[0.0, 0.0], &[]), "curve underrun"),
            (plain(2.0, &[0], &[0.0, 0.0, 1.0, 1.0], &[]), "unconsumed path records"),
            (plain(2.0, &[0, 2], &[0.0, 0.0], &[]), "unknown path flag"),
        ];
        for (t, why) in bad {
            assert_eq!(decode(&t).err(), Some(Unreadable::Invalid(why)));
        }
        let other = Tpl::new("vuA(v)A(S(uuu))").v(0).u(1.0).vs(&[]).records(0, &[]);
        assert_eq!(decode(&other).err(), Some(Unreadable::Invalid("unknown family")));
        let mut trailing = plain(2.0, &[0, 1], &[0.0, 0.0], &[5.0, 0.0, 10.0, 0.0]);
        trailing.0.push(0);
        assert!(decode(&trailing).is_err());
        // 6. A bent curve: 8 points after P0.
        let d = decode(&plain(2.0, &[0, 1], &[0.0, 0.0], &[50.0, 50.0, 100.0, 0.0])).unwrap();
        let p = &d.paths[0];
        assert_eq!(p.len(), 9);
        assert_eq!((p[4].x, p[4].y), (50.0, 25.0));
        assert_eq!((p[8].x, p[8].y), (100.0, 0.0));

        // 7. F2.
        let wide = Tpl::new(WIDE_PREFIX)
            .v(0)
            .u(3.0)
            .vs(&[0, 1])
            .records(1, &[1.0, 2.0, 9.0, 9.0, 9.0])
            .records(1, &[9.0, 3.0, 2.0, 9.0, 9.0, 9.0, 5.0, 2.0, 9.0, 9.0, 9.0]);
        let d = decode(&wide).unwrap();
        assert_eq!(xy(&d.paths[0]), vec![(1.0, 2.0), (3.0, 2.0), (5.0, 2.0)]);
        assert_eq!(stroke_width(&d, 0), 3.0);

        // 8. F3a, two different ratios: not uniform.
        let curve = [5.0, 0.0, 1.0, 10.0, 0.0, 1.0];
        let nib = |x: f32, p: f32| [x, 0.0, p, 1.0, 0.0, 0.0, 0.0];
        let nibs8: Vec<f32> = [nib(0.0, 0.5), nib(10.0, 1.0)].concat();
        let d = decode(&pressure(1, &[0, 1], &[0.0, 0.0, 1.0], &curve, &nibs8)).unwrap();
        assert_eq!(xy(&d.paths[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
        assert!(d.paths[0].iter().all(|s| s.force == Some(1.0)));
        assert_eq!(widths(&d.paths[0]), vec![Some(1.0), None, Some(2.0)]);
        assert_eq!(stroke_width(&d, 0), 1.5);
        // 9. Uniform ratio 0.5.
        let nibs9: Vec<f32> = [nib(0.0, 0.5), nib(10.0, 0.5)].concat();
        let d = decode(&pressure(1, &[0, 1], &[0.0, 0.0, 1.0], &curve, &nibs9)).unwrap();
        assert_eq!(widths(&d.paths[0]), vec![Some(1.0); 3]);
        assert_eq!(stroke_width(&d, 0), 1.0);
        // 10. A nib list that is not a multiple of 7: no widths.
        let d = decode(&pressure(1, &[0, 1], &[0.0, 0.0, 1.0], &curve, &nibs8[..13])).unwrap();
        assert_eq!(widths(&d.paths[0]), vec![None; 3]);
        assert_eq!(stroke_width(&d, 0), 2.0);
        // 11. Two records with one key go to the matching points in order.
        let nibs11: Vec<f32> = [nib(0.0, 0.5), nib(0.0, 0.75)].concat();
        let d = decode(&pressure(
            1,
            &[0, 1, 0, 1],
            &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            &[curve, curve].concat(),
            &nibs11,
        ))
        .unwrap();
        assert_eq!(widths(&d.paths[0]), vec![Some(1.0), None, None]);
        assert_eq!(widths(&d.paths[1]), vec![Some(1.5), None, None]);
        assert_eq!((stroke_width(&d, 0), stroke_width(&d, 1)), (1.0, 1.5));

        // 12. F3b: geometric widths from the interpolated nib.
        let move_b = [0.0, 0.0, 1.0, 0.0];
        let curve_b = [5.0, 0.0, 1.0, 10.0, 0.0, 1.0, 0.0, 0.0, 2.0];
        let d = decode(&pressure(2, &[4, 5], &move_b, &curve_b, &[])).unwrap();
        assert_eq!(xy(&d.paths[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
        assert_eq!(widths(&d.paths[0]), vec![Some(2.0); 3]);
        assert_eq!(stroke_width(&d, 0), 2.0);
        // 13. A record on the end point overrides with W(0.5, 1, π/2) = 1.
        let rec = [10.0, 0.0, 0.5, 1.0, 0.0, 0.0, std::f32::consts::FRAC_PI_2];
        let d = decode(&pressure(2, &[4, 5], &move_b, &curve_b, &rec)).unwrap();
        let w = widths(&d.paths[0]);
        assert_eq!(&w[..2], &[Some(2.0), Some(2.0)]);
        assert!((w[2].unwrap() - 1.0).abs() < 1e-6, "{w:?}");
        assert_eq!(stroke_width(&d, 0), 2.0);
        // 14. Version 2 with mixed flag sets is unreadable.
        let bad = pressure(2, &[0, 5], &[0.0, 0.0, 1.0], &[5.0, 0.0, 1.0, 10.0, 0.0, 1.0], &[]);
        assert_eq!(decode(&bad).err(), Some(Unreadable::Invalid("unknown pressure variant")));
    }

    #[test]
    fn point_budget_per_stroke() {
        // Each curve bends far away (64 segments); 1000 curves would be 64 001 points.
        let n = 1000;
        let flags: Vec<u16> = std::iter::once(0).chain(std::iter::repeat_n(1, n)).collect();
        let curves: Vec<f32> = (0..n).flat_map(|_| [5000.0, 5000.0, 0.0, 0.0]).collect();
        let t = plain(2.0, &flags, &[0.0, 0.0], &curves);
        assert_eq!(decode(&t).err(), Some(Unreadable::TooManyPoints));
        let ok = plain(2.0, &flags[..700], &[0.0, 0.0], &curves[..699 * 4]);
        assert_eq!(decode(&ok).unwrap().paths[0].len(), 1 + 699 * 64);
    }

    #[test]
    fn pdf_media_box_is_found() {
        assert_eq!(pdf_media_box(b"%PDF-1.4 /MediaBox [0 0 612 792] x"), Some((612.0, 792.0)));
        assert_eq!(
            pdf_media_box(b"%PDF /MediaBox [a] /MediaBox[ -1 0 99 50 ]"),
            Some((100.0, 50.0))
        );
        assert_eq!(pdf_media_box(b"%PDF nothing"), None);
    }

    #[test]
    fn events_replay_in_order() {
        let mut log = EventLog::default();
        let size = TemplateSize { width: Some(10.0), height: Some(20.0) };
        log.apply("t".into(), EventAction::DefineTemplate(size));
        log.apply("a".into(), EventAction::Delete);
        log.apply("a".into(), EventAction::UseTemplate(Some("t".into())));
        log.apply("b".into(), EventAction::UseTemplate(Some("t".into())));
        log.apply("b".into(), EventAction::Canvas(Some("Board".into())));
        log.apply("c".into(), EventAction::Canvas(None));
        log.apply("c".into(), EventAction::UseTemplate(Some("missing".into())));
        assert!(!log.is_deleted("a"));
        assert_eq!(log.page("a").size, Some((10.0, 20.0)));
        assert_eq!(
            log.page("b"),
            PageEvents { canvas_title: Some(Some("Board".into())), size: None }
        );
        assert_eq!(log.page("c"), PageEvents::default());
    }
}
