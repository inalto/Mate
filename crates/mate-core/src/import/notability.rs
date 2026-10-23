//! Notability (`.note`): a zip holding `<Note>/Session.plist`, an NSKeyedArchiver binary plist,
//! plus `<Note>/Images/*` for inserted pictures.
//!
//! Ink lives in every `$objects` dictionary that has a `curvespoints` key (raw little-endian
//! arrays: `curvesnumpoints` i32 per stroke, `curvespoints` f32 x/y pairs, `curveswidth` f32,
//! `curvescolors` u8 RGBA, optional `curvesfractionalwidths` f32 per cubic node). Text boxes and
//! images are the `richText.mediaObjects` of the session dictionary. A note is one tall canvas,
//! so it becomes one Mate page whose height is the lowest content.
//!
//! The binary plist is read lazily by [`Bplist`]: objects are decoded by index on demand and
//! collections keep their children as object indices, so nothing is ever expanded and memory
//! stays proportional to the file however objects are shared. Every decode costs a step from a
//! budget proportional to the file (and checks the deadline); the bytes of every blob turned
//! into strokes or text are charged to a second budget. Keyed-archive UIDs and plist object
//! references are resolved through the same index space, and a reference back to an object on
//! the current walk path (a cycle) is `Corrupt`.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashSet;

use super::{
    ImportBackground, ImportBudget, ImportDocument, ImportError, ImportImage, ImportLimits,
    ImportPage, ImportPoint, ImportSection, ImportSkipped, ImportSource, ImportStroke, ImportText,
    ZipSource, base_name, check_deadline, zipsrc::is_safe_name,
};
use crate::model::{PageMode, PenStyle};

/// Longest walk path / UID chain followed.
const MAX_PATH: usize = 64;
/// Page width when the note does not record one (Mate's sheet, scale 1).
const DEFAULT_WIDTH: f64 = 1080.0;
const DEFAULT_HEIGHT: f64 = 1440.0;
/// A stroke is a highlighter when its alpha is below this.
const HIGHLIGHTER_ALPHA: u8 = 200;
const HIGHLIGHTER_OPACITY: f64 = 0.5;
const SESSION_FILE: &str = "Session.plist";
const CYCLE: &str = "keyed archive references itself (cycle)";
const BEHIND_TEXT_KEY: &str = "NBNoteTakingSessionIsHighlighterBehindTextKey";
/// Largest single data blob read (curve arrays, widths, colours, ...).
const MAX_BLOB_BYTES: usize = 64 * 1024 * 1024;

fn corrupt(msg: impl Into<String>) -> ImportError {
    ImportError::Corrupt(msg.into())
}

/// Errors that only spoil one media object (it is skipped and counted); a cycle, a budget or the
/// deadline still fail the import.
fn skippable(e: &ImportError) -> bool {
    matches!(e, ImportError::Corrupt(m) if m != CYCLE)
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
// Lazy binary plist

/// Big-endian unsigned integer of up to 8 bytes.
fn be(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b))
}

/// The object references of a collection, read on demand.
#[derive(Debug, Clone, Copy)]
struct Refs<'a> {
    bytes: &'a [u8],
    size: usize,
}

impl Refs<'_> {
    fn len(&self) -> usize {
        self.bytes.len() / self.size
    }

    /// Reference `i` (`i < len()`); an index the file cannot hold maps to `usize::MAX`, which
    /// [`Bplist::object`] rejects.
    fn get(&self, i: usize) -> usize {
        let raw = &self.bytes[i * self.size..(i + 1) * self.size];
        usize::try_from(be(raw)).unwrap_or(usize::MAX)
    }
}

/// One decoded object; strings and data borrow the file, collections hold references.
#[derive(Debug, Clone, Copy)]
enum Val<'a> {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Ascii(&'a [u8]),
    /// Big-endian UTF-16 code units.
    Utf16(&'a [u8]),
    Data(&'a [u8]),
    Uid(u64),
    Array(Refs<'a>),
    Dict(Refs<'a>, Refs<'a>),
    /// Dates, fill bytes and unknown markers.
    Other,
}

impl<'a> Val<'a> {
    fn text(&self) -> Option<Cow<'a, str>> {
        match *self {
            Val::Ascii(b) => Some(String::from_utf8_lossy(b)),
            Val::Utf16(b) => {
                let units: Vec<u16> =
                    b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                Some(Cow::Owned(String::from_utf16_lossy(&units)))
            }
            _ => None,
        }
    }

    /// Whether this string equals `s`, in time bounded by `s` (lengths first, no allocation).
    fn is_str(&self, s: &str) -> bool {
        match *self {
            Val::Ascii(b) => b == s.as_bytes(),
            Val::Utf16(b) => {
                b.len() / 2 == s.encode_utf16().count()
                    && b.chunks_exact(2)
                        .map(|c| u16::from_be_bytes([c[0], c[1]]))
                        .eq(s.encode_utf16())
            }
            _ => false,
        }
    }

    /// The rest of this string after `prefix` (ASCII), when that rest is at most `max` units
    /// long; the work is bounded by `prefix.len() + max`.
    fn suffix_after(&self, prefix: &str, max: usize) -> Option<String> {
        let p = prefix.as_bytes();
        match *self {
            Val::Ascii(b) if b.len() <= p.len() + max => {
                b.strip_prefix(p).map(|rest| String::from_utf8_lossy(rest).into_owned())
            }
            Val::Utf16(b) if b.len() / 2 <= p.len() + max => {
                let units: Vec<u16> =
                    b.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                let rest = units.strip_prefix(&p.iter().map(|&c| u16::from(c)).collect::<Vec<_>>()[..])?;
                Some(String::from_utf16_lossy(rest))
            }
            _ => None,
        }
    }

    fn number(&self) -> Option<f64> {
        match *self {
            Val::Int(i) => Some(i as f64),
            Val::Real(r) if r.is_finite() => Some(r),
            Val::Bool(b) => Some(f64::from(u8::from(b))),
            _ => None,
        }
    }

    fn boolean(&self) -> Option<bool> {
        match *self {
            Val::Bool(b) => Some(b),
            Val::Int(i) => Some(i != 0),
            Val::Real(r) => Some(r != 0.0),
            _ => None,
        }
    }
}

/// A `bplist00` file read lazily: only the trailer is parsed up front.
struct Bplist<'a> {
    bytes: &'a [u8],
    offset_size: usize,
    ref_size: usize,
    count: usize,
    top: usize,
    table: usize,
    /// Start of the trailer; no object byte lies at or after it.
    end: usize,
    steps: Cell<u64>,
    max_steps: u64,
    limits: &'a ImportLimits,
}

impl<'a> Bplist<'a> {
    fn new(bytes: &'a [u8], limits: &'a ImportLimits) -> Result<Bplist<'a>, ImportError> {
        let bad = |what: &str| corrupt(format!("Session.plist: {what}"));
        if bytes.len() < 8 + 32 || !bytes.starts_with(b"bplist00") {
            return Err(bad("not a binary plist"));
        }
        let end = bytes.len() - 32;
        let t = &bytes[end..];
        let (offset_size, ref_size) = (usize::from(t[6]), usize::from(t[7]));
        if !(1..=8).contains(&offset_size) || !(1..=8).contains(&ref_size) {
            return Err(bad("bad trailer sizes"));
        }
        let to_usize = |v: u64| usize::try_from(v).map_err(|_| bad("bad trailer"));
        let count = to_usize(be(&t[8..16]))?;
        let top = to_usize(be(&t[16..24]))?;
        let table = to_usize(be(&t[24..32]))?;
        let table_end = count.checked_mul(offset_size).and_then(|n| n.checked_add(table));
        if count == 0 || top >= count || table < 8 || table_end.is_none_or(|e| e > end) {
            return Err(bad("bad trailer"));
        }
        Ok(Bplist {
            bytes,
            offset_size,
            ref_size,
            count,
            top,
            table,
            end,
            steps: Cell::new(0),
            max_steps: (bytes.len() as u64).saturating_mul(32).saturating_add(1 << 20),
            limits,
        })
    }

    #[cfg(test)]
    fn steps(&self) -> u64 {
        self.steps.get()
    }

    fn step(&self) -> Result<(), ImportError> {
        self.steps_n(1)
    }

    /// Charges `n` steps; checks the deadline each time the count crosses a multiple of 4096.
    fn steps_n(&self, n: u64) -> Result<(), ImportError> {
        let before = self.steps.get();
        let s = before.saturating_add(n);
        self.steps.set(s);
        if s > self.max_steps {
            return Err(ImportError::Limit("its note data is too complex: reading it would take longer than Mate allows (the time budget)".into()));
        }
        if s / 4096 != before / 4096 {
            check_deadline(self.limits)?;
        }
        Ok(())
    }

    /// `len` bytes at `start`, all before the trailer.
    fn slice(&self, start: usize, len: usize) -> Result<&'a [u8], ImportError> {
        match start.checked_add(len) {
            Some(stop) if stop <= self.end => Ok(&self.bytes[start..stop]),
            _ => Err(corrupt("Session.plist: object runs past the end")),
        }
    }

    /// Length of a variable-size object with marker low nibble `low` at `at`, and where its
    /// payload starts.
    fn length(&self, at: usize, low: u8) -> Result<(usize, usize), ImportError> {
        if low != 0x0F {
            return Ok((usize::from(low), at + 1));
        }
        let marker = self.slice(at + 1, 1)?[0];
        if marker >> 4 != 1 || marker & 0x0F > 3 {
            return Err(corrupt("Session.plist: bad object length"));
        }
        let n = 1usize << (marker & 0x0F);
        let len = usize::try_from(be(self.slice(at + 2, n)?))
            .map_err(|_| corrupt("Session.plist: bad object length"))?;
        Ok((len, at + 2 + n))
    }

    fn refs(&self, start: usize, len: usize) -> Result<Refs<'a>, ImportError> {
        let n = len
            .checked_mul(self.ref_size)
            .ok_or_else(|| corrupt("Session.plist: bad collection length"))?;
        Ok(Refs { bytes: self.slice(start, n)?, size: self.ref_size })
    }

    /// Decodes object `i`.
    fn object(&self, i: usize) -> Result<Val<'a>, ImportError> {
        self.step()?;
        if i >= self.count {
            return Err(corrupt("Session.plist: object reference out of range"));
        }
        let at = self.table + i * self.offset_size;
        let offset = usize::try_from(be(&self.bytes[at..at + self.offset_size]))
            .map_err(|_| corrupt("Session.plist: bad object offset"))?;
        if offset < 8 || offset >= self.end {
            return Err(corrupt("Session.plist: bad object offset"));
        }
        let marker = self.bytes[offset];
        let low = marker & 0x0F;
        Ok(match marker >> 4 {
            0x0 => match low {
                0x0 => Val::Null,
                0x8 => Val::Bool(false),
                0x9 => Val::Bool(true),
                _ => Val::Other,
            },
            0x1 => {
                if low > 4 {
                    return Err(corrupt("Session.plist: bad integer"));
                }
                let n = 1usize << low;
                let b = self.slice(offset + 1, n)?;
                // 8-byte integers are signed; 16-byte ones keep their low 64 bits.
                Val::Int(be(&b[n.saturating_sub(8)..]) as i64)
            }
            0x2 => match low {
                2 => {
                    let b = self.slice(offset + 1, 4)?;
                    Val::Real(f64::from(f32::from_be_bytes([b[0], b[1], b[2], b[3]])))
                }
                3 => Val::Real(f64::from_bits(be(self.slice(offset + 1, 8)?))),
                _ => return Err(corrupt("Session.plist: bad real")),
            },
            0x3 => {
                self.slice(offset + 1, 8)?;
                Val::Other
            }
            kind @ 0x4..=0x6 => {
                let (len, start) = self.length(offset, low)?;
                let n = if kind == 0x6 { len.checked_mul(2) } else { Some(len) }
                    .ok_or_else(|| corrupt("Session.plist: bad string length"))?;
                let b = self.slice(start, n)?;
                // Long strings and blobs cost in proportion to their length.
                self.steps_n((n / 4096) as u64)?;
                match kind {
                    0x4 => Val::Data(b),
                    0x5 => Val::Ascii(b),
                    _ => Val::Utf16(b),
                }
            }
            0x8 if low <= 7 => Val::Uid(be(self.slice(offset + 1, usize::from(low) + 1)?)),
            0x8 => return Err(corrupt("Session.plist: bad UID")),
            0xA | 0xC => {
                let (len, start) = self.length(offset, low)?;
                Val::Array(self.refs(start, len)?)
            }
            0xD => {
                let (len, start) = self.length(offset, low)?;
                let keys = self.refs(start, len)?;
                let values = self.refs(start + keys.bytes.len(), len)?;
                Val::Dict(keys, values)
            }
            _ => Val::Other,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Keyed archive

/// An object reached by a walk, with the object indices visited on the way to it.
#[derive(Debug, Clone)]
struct Obj<'a> {
    val: Val<'a>,
    idx: usize,
    path: Vec<usize>,
}

struct Archive<'a> {
    p: Bplist<'a>,
    /// The `$objects` array: UID `n` is object `objects.get(n)`.
    objects: Refs<'a>,
    blob_bytes: Cell<u64>,
    max_blob_bytes: u64,
}

impl<'a> Archive<'a> {
    fn new(p: Bplist<'a>) -> Result<Archive<'a>, ImportError> {
        let no_objects = || corrupt("not a keyed archive (no $objects)");
        let Val::Dict(keys, values) = p.object(p.top)? else { return Err(no_objects()) };
        for i in 0..keys.len() {
            if p.object(keys.get(i))?.is_str("$objects") {
                let Val::Array(objects) = p.object(values.get(i))? else { break };
                let max_blob_bytes =
                    (p.bytes.len() as u64).saturating_mul(2).saturating_add(1 << 20);
                return Ok(Archive { p, objects, blob_bytes: Cell::new(0), max_blob_bytes });
            }
        }
        Err(no_objects())
    }

    /// Charges `n` bytes of blob conversion (strokes, text) to the budget.
    fn charge(&self, n: usize) -> Result<(), ImportError> {
        let total = self.blob_bytes.get().saturating_add(n as u64);
        self.blob_bytes.set(total);
        if total > self.max_blob_bytes {
            return Err(ImportError::Limit("its note data reuses the same large blocks too many times (the size budget for repeated data)".into()));
        }
        Ok(())
    }

    /// Follows object reference `raw` (and any UIDs) from an object whose path is `from`.
    fn child(&self, from: &[usize], raw: usize) -> Result<Obj<'a>, ImportError> {
        let mut idx = raw;
        let mut path = from.to_vec();
        loop {
            if path.contains(&idx) {
                return Err(corrupt(CYCLE));
            }
            path.push(idx);
            if path.len() > MAX_PATH {
                return Err(corrupt("keyed archive references nest too deeply"));
            }
            match self.p.object(idx)? {
                Val::Uid(n) => {
                    let n = usize::try_from(n).unwrap_or(usize::MAX);
                    if n >= self.objects.len() {
                        return Err(corrupt("keyed archive UID out of range"));
                    }
                    idx = self.objects.get(n);
                }
                val => return Ok(Obj { val, idx, path }),
            }
        }
    }

    /// Reference of the plain dictionary field `key`.
    fn direct(&self, o: &Obj<'a>, key: &str) -> Result<Option<usize>, ImportError> {
        let Val::Dict(keys, values) = o.val else { return Ok(None) };
        for i in 0..keys.len() {
            if self.p.object(keys.get(i))?.is_str(key) {
                return Ok(Some(values.get(i)));
            }
        }
        Ok(None)
    }

    /// Value of `key`: a plain keyed-object field, an `NS.keys`/`NS.objects` dictionary entry,
    /// or an `NS.key.<i>`/`NS.object.<i>` pair. Linear in the dictionary size.
    fn get(&self, o: &Obj<'a>, key: &str) -> Result<Option<Obj<'a>>, ImportError> {
        let Val::Dict(keys, values) = o.val else { return Ok(None) };
        let (mut ns_keys, mut ns_objects, mut pairs) = (None, None, false);
        for i in 0..keys.len() {
            let k = self.p.object(keys.get(i))?;
            if k.is_str(key) {
                return self.child(&o.path, values.get(i)).map(Some);
            } else if k.is_str("NS.keys") {
                ns_keys = Some(values.get(i));
            } else if k.is_str("NS.objects") {
                ns_objects = Some(values.get(i));
            } else if let Val::Ascii(name) = k {
                pairs |= name.starts_with(b"NS.key.");
            }
        }
        if let (Some(ks), Some(vs)) = (ns_keys, ns_objects) {
            let (ks, vs) = (self.child(&o.path, ks)?, self.child(&o.path, vs)?);
            let (Val::Array(kr), Val::Array(vr)) = (ks.val, vs.val) else {
                return Err(corrupt("keyed archive dictionary is malformed"));
            };
            for i in 0..kr.len() {
                let k = self.child(&ks.path, kr.get(i))?;
                if k.val.is_str(key) || self.string(&k)?.as_deref() == Some(key) {
                    if i >= vr.len() {
                        return Err(corrupt("keyed archive dictionary is malformed"));
                    }
                    return self.child(&vs.path, vr.get(i)).map(Some);
                }
            }
            return Ok(None);
        }
        if !pairs {
            return Ok(None);
        }
        for i in 0..keys.len() {
            let name = self.p.object(keys.get(i))?;
            let Some(suffix) = name.suffix_after("NS.key.", 20) else { continue };
            let k = self.child(&o.path, values.get(i))?;
            if k.val.is_str(key) || self.string(&k)?.as_deref() == Some(key) {
                return match self.direct(o, &format!("NS.object.{suffix}"))? {
                    Some(v) => self.child(&o.path, v).map(Some),
                    None => Ok(None),
                };
            }
        }
        Ok(None)
    }

    /// Elements of an array (a plain array, `NS.objects`, or `NS.object.<i>` keys) as the
    /// container to resolve them from and their references. Linear in the entry count.
    fn items(&self, o: &Obj<'a>) -> Result<(Obj<'a>, Vec<usize>), ImportError> {
        let all = |r: Refs<'a>| (0..r.len()).map(|i| r.get(i)).collect::<Vec<_>>();
        match o.val {
            Val::Array(r) => Ok((o.clone(), all(r))),
            Val::Dict(keys, values) => {
                if let Some(raw) = self.direct(o, "NS.objects")? {
                    let list = self.child(&o.path, raw)?;
                    return match list.val {
                        Val::Array(r) => Ok((list, all(r))),
                        _ => Err(corrupt("keyed archive array is malformed")),
                    };
                }
                // One pass: place each `NS.object.<i>` by its index, then take 0, 1, 2, ...
                let n = keys.len();
                let mut slots: Vec<Option<usize>> = vec![None; n];
                for i in 0..n {
                    let name = self.p.object(keys.get(i))?;
                    let index = name.suffix_after("NS.object.", 20).and_then(|s| s.parse::<usize>().ok());
                    if let Some(index) = index.filter(|x| *x < n) {
                        slots[index] = Some(values.get(i));
                    }
                }
                Ok((o.clone(), slots.into_iter().map_while(|s| s).collect()))
            }
            _ => Ok((o.clone(), Vec::new())),
        }
    }

    /// The first element of an array (as [`Archive::items`]) without collecting the others.
    fn first_item(&self, o: &Obj<'a>) -> Result<Option<(Obj<'a>, usize)>, ImportError> {
        match o.val {
            Val::Array(r) => Ok((r.len() > 0).then(|| (o.clone(), r.get(0)))),
            Val::Dict(keys, values) => {
                if let Some(raw) = self.direct(o, "NS.objects")? {
                    let list = self.child(&o.path, raw)?;
                    return match list.val {
                        Val::Array(r) => Ok((r.len() > 0).then(|| (list.clone(), r.get(0)))),
                        _ => Err(corrupt("keyed archive array is malformed")),
                    };
                }
                for i in 0..keys.len() {
                    if self.p.object(keys.get(i))?.is_str("NS.object.0") {
                        return Ok(Some((o.clone(), values.get(i))));
                    }
                }
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    /// A string: plain, `NS.string`, or UTF-8 `NS.bytes`.
    fn string(&self, o: &Obj<'a>) -> Result<Option<String>, ImportError> {
        if let Some(t) = o.val.text() {
            self.charge(t.len())?;
            return Ok(Some(t.into_owned()));
        }
        if let Some(raw) = self.direct(o, "NS.string")? {
            return match self.child(&o.path, raw)?.val.text() {
                Some(t) => {
                    self.charge(t.len())?;
                    Ok(Some(t.into_owned()))
                }
                None => Ok(None),
            };
        }
        if let Some(raw) = self.direct(o, "NS.bytes")?
            && let Val::Data(d) = self.child(&o.path, raw)?.val
        {
            self.charge(d.len())?;
            return Ok(Some(String::from_utf8_lossy(d).into_owned()));
        }
        Ok(None)
    }

    /// Raw bytes: a plist `<data>` or an `NS.data` wrapper; `Limit` past [`MAX_BLOB_BYTES`].
    fn data(&self, o: &Obj<'a>) -> Result<Option<&'a [u8]>, ImportError> {
        let d = match o.val {
            Val::Data(d) => Some(d),
            Val::Dict(..) => match self.direct(o, "NS.data")? {
                Some(raw) => match self.child(&o.path, raw)?.val {
                    Val::Data(d) => Some(d),
                    _ => None,
                },
                None => None,
            },
            _ => None,
        };
        if d.is_some_and(|d| d.len() > MAX_BLOB_BYTES) {
            return Err(ImportError::Limit(format!(
                "one of its data blocks is larger than {} MiB",
                MAX_BLOB_BYTES >> 20
            )));
        }
        Ok(d)
    }

    fn class_name(&self, o: &Obj<'a>) -> Result<Option<String>, ImportError> {
        match self.get(o, "$class")? {
            Some(class) => match self.get(&class, "$classname")? {
                Some(name) => self.string(&name),
                None => Ok(None),
            },
            None => Ok(None),
        }
    }

    /// `get` along a chain of keys.
    fn at(&self, o: &Obj<'a>, keys: &[&str]) -> Result<Option<Obj<'a>>, ImportError> {
        let mut cur = o.clone();
        for k in keys {
            match self.get(&cur, k)? {
                Some(next) => cur = next,
                None => return Ok(None),
            }
        }
        Ok(Some(cur))
    }

    fn string_at(&self, o: &Obj<'a>, keys: &[&str]) -> Result<Option<String>, ImportError> {
        match self.at(o, keys)? {
            Some(v) => self.string(&v),
            None => Ok(None),
        }
    }
}

/// What the flat scan of `$objects` finds.
struct Scan<'a> {
    session: Option<Obj<'a>>,
    page_width: Option<f64>,
    highlighter_behind_text: bool,
    curves: Vec<Obj<'a>>,
}

/// One pass over `$objects` (each distinct object once), one pass over each dictionary's keys.
fn scan<'a>(a: &Archive<'a>) -> Result<Scan<'a>, ImportError> {
    let mut out =
        Scan { session: None, page_width: None, highlighter_behind_text: false, curves: Vec::new() };
    let mut seen = HashSet::new();
    for n in 0..a.objects.len() {
        let idx = a.objects.get(n);
        if !seen.insert(idx) {
            continue;
        }
        let val = a.p.object(idx)?;
        let Val::Dict(keys, values) = val else { continue };
        let obj = Obj { val, idx, path: vec![idx] };
        for i in 0..keys.len() {
            let k = a.p.object(keys.get(i))?;
            if k.is_str("richText") {
                if out.session.is_none() {
                    out.session = Some(obj.clone());
                }
            } else if k.is_str("pageWidthInDocumentCoordsKey") {
                if out.page_width.is_none()
                    && let Some(w) = a.child(&obj.path, values.get(i))?.val.number()
                    && w > 0.0
                {
                    out.page_width = Some(w);
                }
            } else if k.is_str(BEHIND_TEXT_KEY) {
                out.highlighter_behind_text |=
                    a.child(&obj.path, values.get(i))?.val.boolean().unwrap_or(false);
            } else if k.is_str("curvespoints") {
                out.curves.push(obj.clone());
            }
        }
    }
    Ok(out)
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
    /// Strokes past the page limit.
    skipped: ImportSkipped,
}

/// Appends the strokes of one curves dictionary.
fn read_curves<'a>(
    a: &Archive<'a>,
    curves: &Obj<'a>,
    highlighter_behind_text: bool,
    ink: &mut Ink,
    budget: &mut ImportBudget,
) -> Result<(), ImportError> {
    let field = |key: &str| -> Result<&'a [u8], ImportError> {
        let d = match a.get(curves, key)? {
            Some(o) => a.data(&o)?.ok_or_else(|| corrupt(format!("{key} is not data")))?,
            None => return Err(corrupt(format!("missing {key}"))),
        };
        a.charge(d.len())?;
        Ok(d)
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
    let fractional = match a.get(curves, "curvesfractionalwidths")? {
        Some(o) => match a.data(&o)? {
            Some(d) if d.len().is_multiple_of(4) => {
                a.charge(d.len())?;
                Some(le_f32s(d, "curvesfractionalwidths")?)
            }
            _ => None,
        },
        None => None,
    }
    .filter(|f| cubic && f.len() as u64 == nodes);
    if let Some(shapes) = a.get(curves, "shapes")?
        && a.data(&shapes)?.is_some_and(|d| !d.is_empty())
    {
        ink.shapes += 1;
    }

    let (mut point_at, mut node_at) = (0usize, 0usize);
    for (i, &n) in counts.iter().enumerate() {
        if i % 1024 == 0 {
            check_deadline(a.p.limits)?;
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
        if budget.page_full() {
            budget.skip(&mut ink.skipped)?;
            continue;
        }

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
        if pts.is_empty() || !budget.admit(pts.len(), &mut ink.skipped)? {
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
    /// Items past the page limit.
    skipped: ImportSkipped,
}

/// A text box. One without text is dropped silently; one without a position is skipped and
/// counted (as images are).
fn read_text<'a>(
    a: &Archive<'a>,
    obj: &Obj<'a>,
    media: &mut Media,
    budget: &mut ImportBudget,
) -> Result<(), ImportError> {
    let Some(attributed) = a.at(obj, &["textStore", "attributedString"])? else {
        return Ok(());
    };
    let Some(text) = a.string_at(&attributed, &["stringKey"])? else { return Ok(()) };
    if text.trim().is_empty() {
        return Ok(());
    }
    let Some((x, y)) = a.string_at(obj, &["documentOrigin"])?.as_deref().and_then(pair) else {
        media.other += 1;
        return Ok(());
    };
    let size = a.string_at(obj, &["unscaledContentSize"])?.as_deref().and_then(pair);
    let (mut font_size, mut color) = (None, None);
    if let Some(ranges) = a.get(&attributed, "subRangesKey")?
        && let Some((list, first)) = a.first_item(&ranges)?
    {
        let first = a.child(&list.path, first)?;
        font_size = a
            .at(&first, &["subRangeFontKey", "NSFontSizeAttribute"])?
            .and_then(|o| o.val.number())
            .filter(|s| *s > 0.0);
        color = a
            .string_at(&first, &["subRangeColorCrossPlatformKey"])?
            .as_deref()
            .and_then(cross_platform_color);
    }
    let width = size.map(|(w, _)| w).filter(|w| *w > 0.0);
    if !budget.admit(0, &mut media.skipped)? {
        return Ok(());
    }
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

fn read_image<'a>(
    a: &Archive<'a>,
    obj: &Obj<'a>,
    dir: &str,
    src: &mut ZipSource,
    media: &mut Media,
    budget: &mut ImportBudget,
) -> Result<(), ImportError> {
    let Some(snapshot) =
        a.at(obj, &["figure", "FigureBackgroundObjectKey", "kImageObjectSnapshotKey"])?
    else {
        media.other += 1;
        return Ok(());
    };
    let missing =
        a.get(&snapshot, "imageIsMissing")?.and_then(|o| o.val.boolean()).unwrap_or(false);
    let rel = a.string_at(&snapshot, &["relativePath"])?;
    let origin = a.string_at(obj, &["documentOrigin"])?.as_deref().and_then(pair);
    let size = a.string_at(obj, &["unscaledContentSize"])?.as_deref().and_then(pair);
    let (Some(rel), Some((x, y)), Some((w, h)), false) = (rel, origin, size, missing) else {
        media.other += 1;
        return Ok(());
    };
    let path = if dir.is_empty() { rel } else { format!("{dir}/{rel}") };
    if budget.page_full() {
        return budget.skip(&mut media.skipped);
    }
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
    if !budget.admit(0, &mut media.skipped)? {
        return Ok(());
    }
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

/// One media object; errors that only spoil it are counted by the caller.
fn read_media<'a>(
    a: &Archive<'a>,
    item: &Obj<'a>,
    dir: &str,
    src: &mut ZipSource,
    media: &mut Media,
    budget: &mut ImportBudget,
) -> Result<(), ImportError> {
    if !matches!(item.val, Val::Dict(..)) {
        return Ok(()); // `$null` and other placeholders
    }
    match a.class_name(item)?.as_deref() {
        Some("TextBlockMediaObject") => read_text(a, item, media, budget),
        Some("ImageMediaObject") => read_image(a, item, dir, src, media, budget),
        _ => {
            media.other += 1;
            Ok(())
        }
    }
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

fn paper<'a>(a: &Archive<'a>, session: &Obj<'a>) -> Result<ImportBackground, ImportError> {
    let style = a.string_at(
        session,
        &["NBNoteTakingSessionDocumentPaperLayoutModelKey", "documentPaperAttributes", "lineStyle2"],
    )?;
    if let Some(bg) = style.as_deref().and_then(line_style) {
        return Ok(bg);
    }
    Ok(match a.get(session, "paperLineStyle")?.and_then(|o| o.val.number()) {
        Some(5.0) => ImportBackground::Grid { spacing: 24.0 },
        Some(2.0) => ImportBackground::Lined { spacing: 32.0 },
        _ => ImportBackground::Plain,
    })
}

/// Embedded PDFs: entries matching `/PDFs/[^/]+\.pdf$` (case-insensitive).
fn is_pdf_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some((parent, file)) = lower.rsplit_once('/') else { return false };
    parent.ends_with("/pdfs") && file.len() > 4 && file.ends_with(".pdf")
}

// ---------------------------------------------------------------------------------------------

pub fn parse(src: &mut ZipSource, limits: &ImportLimits) -> Result<ImportDocument, ImportError> {
    check_deadline(limits)?;
    if src.any_encrypted() {
        return Err(ImportError::Encrypted);
    }
    let names = src.names();
    let session_name = names
        .iter()
        .filter(|n| base_name(n) == SESSION_FILE)
        .min_by_key(|n| (n.matches('/').count(), n.as_str()))
        .cloned()
        .ok_or_else(|| corrupt("no Session.plist in the .note package"))?;
    let dir = session_name.rsplit_once('/').map_or("", |(d, _)| d).to_owned();
    let pdfs = names.iter().filter(|n| is_pdf_entry(n)).count();

    let bytes = read(src, &session_name)?.ok_or_else(|| corrupt("Session.plist is missing"))?;
    let a = Archive::new(Bplist::new(&bytes, limits)?)?;
    let found = scan(&a)?;
    if found.curves.is_empty() {
        return Err(corrupt("missing curvespoints"));
    }

    let mut budget = ImportBudget::new(limits);
    budget.start_page();
    let mut ink =
        Ink { strokes: Vec::new(), max_y: 0.0, shapes: 0, skipped: ImportSkipped::default() };
    for c in &found.curves {
        read_curves(&a, c, found.highlighter_behind_text, &mut ink, &mut budget)?;
    }

    let mut media = Media {
        texts: Vec::new(),
        images: Vec::new(),
        max_y: 0.0,
        other: 0,
        skipped: ImportSkipped::default(),
    };
    let mut background = ImportBackground::Plain;
    if let Some(session) = &found.session {
        background = paper(&a, session)?;
        if let Some(list) = a.at(session, &["richText", "mediaObjects"])? {
            let (list, raws) = a.items(&list)?;
            let mut seen = HashSet::new();
            for raw in raws {
                let result = a.child(&list.path, raw).and_then(|item| {
                    if seen.insert(item.idx) {
                        read_media(&a, &item, &dir, src, &mut media, &mut budget)
                    } else {
                        Ok(()) // the same object listed twice
                    }
                });
                match result {
                    Ok(()) => {}
                    Err(e) if skippable(&e) => media.other += 1,
                    Err(e) => return Err(e),
                }
            }
        }
    }

    let content_bottom = ink.max_y.max(media.max_y).ceil();
    let (width, height) = match found.page_width {
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
            other: media
                .other
                .saturating_add(ink.skipped.other)
                .saturating_add(media.skipped.other)
                .saturating_add(u32::try_from(pdfs).unwrap_or(u32::MAX)),
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
    fn line_styles_colours_and_pdf_names() {
        assert_eq!(line_style("Grid:0.25"), Some(ImportBackground::Grid { spacing: 24.0 }));
        assert_eq!(line_style("Lines:x"), Some(ImportBackground::Lined { spacing: 32.0 }));
        assert_eq!(line_style("Dots:0.5"), Some(ImportBackground::Dotted { spacing: 48.0 }));
        assert_eq!(line_style("Plain"), None);
        assert_eq!(cross_platform_color("1,0,0.5").as_deref(), Some("#ff0080"));
        assert_eq!(cross_platform_color("0,128,255,1").as_deref(), Some("#0080ff"));
        assert_eq!(pair("{50, 100}"), Some((50.0, 100.0)));
        assert_eq!(pair("50, 100"), None);
        assert!(is_pdf_entry("N/PDFs/a.pdf") && is_pdf_entry("N/pdfs/B.PDF"));
        assert!(!is_pdf_entry("N/PDFs/sub/a.pdf") && !is_pdf_entry("N/PDFs/.pdf"));
        assert!(!is_pdf_entry("PDFs/a.pdf") && !is_pdf_entry("N/XPDFs/a.pdf"));
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

    /// Hand-assembles a bplist with 4-byte offsets.
    fn assemble(objects: &[Vec<u8>], top: u64, ref_size: u8) -> Vec<u8> {
        let mut out = b"bplist00".to_vec();
        let mut offsets = Vec::new();
        for o in objects {
            offsets.push(out.len() as u32);
            out.extend_from_slice(o);
        }
        let table = out.len() as u64;
        for o in offsets {
            out.extend_from_slice(&o.to_be_bytes());
        }
        out.extend_from_slice(&[0; 6]);
        out.extend_from_slice(&[4, ref_size]);
        out.extend_from_slice(&(objects.len() as u64).to_be_bytes());
        out.extend_from_slice(&top.to_be_bytes());
        out.extend_from_slice(&table.to_be_bytes());
        out
    }

    fn ascii(s: &str) -> Vec<u8> {
        let mut v = vec![0x50 | s.len() as u8];
        v.extend_from_slice(s.as_bytes());
        v
    }

    #[test]
    fn shared_object_bomb_is_bounded_by_steps() {
        // root {"$objects": A}; A = 1 M references to the same dictionary D {"k": "v"}.
        const N: u32 = 1_000_000;
        let mut array = vec![0xAF, 0x12];
        array.extend_from_slice(&N.to_be_bytes());
        array.extend(std::iter::repeat_n(3u8, N as usize));
        let objects =
            vec![vec![0xD1, 1, 2], ascii("$objects"), array, vec![0xD1, 4, 5], ascii("k"), ascii("v")];
        let bytes = assemble(&objects, 0, 1);
        assert!(bytes.len() < 1_100_000);
        let limits = ImportLimits::default();
        let a = Archive::new(Bplist::new(&bytes, &limits).unwrap()).unwrap();
        let found = scan(&a).unwrap();
        assert!(found.curves.is_empty() && found.session.is_none());
        // The shared dictionary is decoded once; nothing is expanded.
        assert!(a.p.steps() < 100, "steps {}", a.p.steps());
    }

    /// Visits what is reachable from the top object (bounded fan-out and depth).
    fn walk(p: &Bplist<'_>) -> Result<(), ImportError> {
        let mut stack = vec![(p.top, 0usize)];
        while let Some((i, depth)) = stack.pop() {
            match p.object(i)? {
                Val::Array(r) if depth < 8 => {
                    stack.extend((0..r.len().min(16)).map(|k| (r.get(k), depth + 1)));
                }
                Val::Dict(k, v) if depth < 8 => {
                    for j in 0..k.len().min(16) {
                        stack.push((k.get(j), depth + 1));
                        stack.push((v.get(j), depth + 1));
                    }
                }
                v => {
                    let _ = v.text();
                }
            }
        }
        Ok(())
    }

    #[test]
    fn reader_survives_random_bytes() {
        let limits = ImportLimits::default();
        let mut seed: u64 = 0x0bad_5eed;
        let mut next = move || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        let mut opened = 0;
        for _ in 0..1000 {
            let len = 40 + next() % 400;
            let mut bytes: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            bytes[..8].copy_from_slice(b"bplist00");
            // A plausible trailer most of the time, so decoding gets past it.
            if next() % 4 != 0 {
                let end = len - 32;
                let count = 1 + next() % 24;
                let off = 1 + next() % 2;
                let table = 8 + next() % end.saturating_sub(8 + count * off).max(1);
                let ref_size = 1 + next() % 2;
                let top = next() % count;
                let t = &mut bytes[end..];
                t[..6].fill(0);
                t[6] = off as u8;
                t[7] = ref_size as u8;
                t[8..16].copy_from_slice(&(count as u64).to_be_bytes());
                t[16..24].copy_from_slice(&(top as u64).to_be_bytes());
                t[24..32].copy_from_slice(&(table as u64).to_be_bytes());
            }
            if let Ok(p) = Bplist::new(&bytes, &limits) {
                opened += 1;
                let _ = walk(&p);
                if let Ok(a) = Archive::new(p) {
                    let _ = scan(&a);
                }
            }
        }
        assert!(opened > 100, "only {opened} trailers accepted");
    }
}
