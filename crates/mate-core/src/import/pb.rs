//! Minimal, bounds-checked protobuf wire-format reader (no schema): GoodNotes and Freenotes
//! files are protobuf messages without published `.proto` files.
//!
//! Every length is checked against the slice before use; malformed input yields
//! [`ImportError::Corrupt`], never a panic. Nesting is limited to [`MAX_DEPTH`]: descend into a
//! sub-message with [`Reader::nested`], which fails past that depth. Groups (wire types 3/4,
//! deprecated) are skipped.

use super::ImportError;

/// Deepest sub-message nesting accepted.
pub const MAX_DEPTH: u32 = 64;

/// One decoded field value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Wire<'a> {
    Varint(u64),
    Fixed64(u64),
    Len(&'a [u8]),
    Fixed32(u32),
}

fn corrupt(msg: &str) -> ImportError {
    ImportError::Corrupt(format!("protobuf: {msg}"))
}

impl<'a> Wire<'a> {
    /// A varint (or fixed) as an unsigned integer.
    pub fn as_u64(&self) -> Option<u64> {
        match *self {
            Wire::Varint(v) | Wire::Fixed64(v) => Some(v),
            Wire::Fixed32(v) => Some(u64::from(v)),
            Wire::Len(_) => None,
        }
    }

    /// A varint as a (two's complement) `int64`/`int32`.
    pub fn as_i64(&self) -> Option<i64> {
        self.as_u64().map(|v| v as i64)
    }

    /// A `sint32`/`sint64` (zigzag) varint.
    pub fn as_sint(&self) -> Option<i64> {
        match *self {
            Wire::Varint(v) => Some(zigzag(v)),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match *self {
            Wire::Varint(v) => Some(v != 0),
            _ => None,
        }
    }

    /// A `float` (fixed32).
    pub fn as_f32(&self) -> Option<f32> {
        match *self {
            Wire::Fixed32(v) => Some(f32::from_bits(v)),
            _ => None,
        }
    }

    /// A `double` (fixed64), or a `float` widened.
    pub fn as_f64(&self) -> Option<f64> {
        match *self {
            Wire::Fixed64(v) => Some(f64::from_bits(v)),
            Wire::Fixed32(v) => Some(f64::from(f32::from_bits(v))),
            _ => None,
        }
    }

    /// Length-delimited payload.
    pub fn as_bytes(&self) -> Option<&'a [u8]> {
        match *self {
            Wire::Len(b) => Some(b),
            _ => None,
        }
    }

    /// Length-delimited payload as text (invalid UTF-8 replaced).
    pub fn as_string(&self) -> Option<String> {
        self.as_bytes().map(|b| String::from_utf8_lossy(b).into_owned())
    }

    /// `repeated float`: a packed payload (length a multiple of 4) or a single unpacked value.
    pub fn packed_f32(&self) -> Result<Vec<f32>, ImportError> {
        match *self {
            Wire::Fixed32(v) => Ok(vec![f32::from_bits(v)]),
            Wire::Len(b) if b.len() % 4 == 0 => Ok(b
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()),
            Wire::Len(_) => Err(corrupt("packed float length is not a multiple of 4")),
            _ => Err(corrupt("expected packed floats")),
        }
    }

    /// `repeated double`: a packed payload (length a multiple of 8) or a single unpacked value.
    pub fn packed_f64(&self) -> Result<Vec<f64>, ImportError> {
        match *self {
            Wire::Fixed64(v) => Ok(vec![f64::from_bits(v)]),
            Wire::Len(b) if b.len() % 8 == 0 => Ok(b
                .chunks_exact(8)
                .map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]))
                .collect()),
            Wire::Len(_) => Err(corrupt("packed double length is not a multiple of 8")),
            _ => Err(corrupt("expected packed doubles")),
        }
    }

    /// `repeated` varints: a packed payload or a single unpacked value.
    pub fn packed_varint(&self) -> Result<Vec<u64>, ImportError> {
        match *self {
            Wire::Varint(v) => Ok(vec![v]),
            Wire::Len(b) => {
                let mut out = Vec::new();
                let mut pos = 0;
                while pos < b.len() {
                    out.push(read_varint(b, &mut pos)?);
                }
                Ok(out)
            }
            _ => Err(corrupt("expected packed varints")),
        }
    }
}

/// Decodes a zigzag-encoded signed integer.
pub fn zigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, ImportError> {
    let mut value: u64 = 0;
    for i in 0..10 {
        let b = *buf.get(*pos).ok_or_else(|| corrupt("truncated varint"))?;
        *pos += 1;
        if i == 9 && b > 1 {
            return Err(corrupt("varint overflows 64 bits"));
        }
        value |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(corrupt("varint longer than 10 bytes"))
}

fn take<'a>(buf: &'a [u8], pos: &mut usize, n: usize) -> Result<&'a [u8], ImportError> {
    let end = pos
        .checked_add(n)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| corrupt("field length runs past the end of the message"))?;
    let out = &buf[*pos..end];
    *pos = end;
    Ok(out)
}

fn read_len<'a>(buf: &'a [u8], pos: &mut usize) -> Result<&'a [u8], ImportError> {
    let n = read_varint(buf, pos)?;
    let n = usize::try_from(n).map_err(|_| corrupt("field length too large"))?;
    take(buf, pos, n)
}

/// Iterates the fields of one message. Stops (returning `None`) after the first error.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    depth: u32,
    failed: bool,
}

impl<'a> Reader<'a> {
    /// A top-level message (depth 0).
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0, depth: 0, failed: false }
    }

    /// Nesting depth of this message (0 at the top level).
    pub fn depth(&self) -> u32 {
        self.depth
    }

    /// A reader over sub-message `bytes`, one level deeper; `Corrupt` past [`MAX_DEPTH`].
    pub fn nested(&self, bytes: &'a [u8]) -> Result<Reader<'a>, ImportError> {
        let depth = self.depth + 1;
        if depth > MAX_DEPTH {
            return Err(corrupt("messages nested too deeply"));
        }
        Ok(Reader { buf: bytes, pos: 0, depth, failed: false })
    }

    /// Collects every field, failing on the first malformed one.
    pub fn collect_all(self) -> Result<Vec<(u32, Wire<'a>)>, ImportError> {
        self.collect()
    }

    fn read_field(&mut self) -> Result<Option<(u32, Wire<'a>)>, ImportError> {
        loop {
            if self.pos >= self.buf.len() {
                return Ok(None);
            }
            let key = read_varint(self.buf, &mut self.pos)?;
            let field = key >> 3;
            if field == 0 || field > u64::from(u32::MAX >> 3) {
                return Err(corrupt("invalid field number"));
            }
            let field = field as u32;
            let wire = match key & 7 {
                0 => Wire::Varint(read_varint(self.buf, &mut self.pos)?),
                1 => {
                    let b = take(self.buf, &mut self.pos, 8)?;
                    Wire::Fixed64(u64::from_le_bytes(b.try_into().expect("8 bytes")))
                }
                2 => Wire::Len(read_len(self.buf, &mut self.pos)?),
                3 => {
                    self.skip_group(field)?;
                    continue;
                }
                4 => return Err(corrupt("unexpected end of group")),
                5 => {
                    let b = take(self.buf, &mut self.pos, 4)?;
                    Wire::Fixed32(u32::from_le_bytes(b.try_into().expect("4 bytes")))
                }
                _ => return Err(corrupt("unknown wire type")),
            };
            return Ok(Some((field, wire)));
        }
    }

    /// Skips a (deprecated) group started with `field`, nested groups included.
    fn skip_group(&mut self, field: u32) -> Result<(), ImportError> {
        let mut open: Vec<u64> = vec![u64::from(field)];
        while let Some(&current) = open.last() {
            let key = read_varint(self.buf, &mut self.pos)?;
            let f = key >> 3;
            match key & 7 {
                0 => {
                    read_varint(self.buf, &mut self.pos)?;
                }
                1 => {
                    take(self.buf, &mut self.pos, 8)?;
                }
                2 => {
                    read_len(self.buf, &mut self.pos)?;
                }
                3 => {
                    if self.depth as usize + open.len() >= MAX_DEPTH as usize {
                        return Err(corrupt("messages nested too deeply"));
                    }
                    open.push(f);
                }
                4 if f == current => {
                    open.pop();
                }
                5 => {
                    take(self.buf, &mut self.pos, 4)?;
                }
                _ => return Err(corrupt("malformed group")),
            }
        }
        Ok(())
    }
}

impl<'a> Iterator for Reader<'a> {
    type Item = Result<(u32, Wire<'a>), ImportError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed {
            return None;
        }
        match self.read_field() {
            Ok(Some(f)) => Some(Ok(f)),
            Ok(None) => None,
            Err(e) => {
                self.failed = true;
                Some(Err(e))
            }
        }
    }
}

/// The fields of a top-level message, in order.
///
/// To read a sub-message (a `Wire::Len` field), use [`Reader::nested`] on the parent reader, or
/// [`fields_at_depth`] with the parent's depth, never a fresh `fields(...)`: only then does the
/// [`MAX_DEPTH`] limit hold for crafted, deeply nested input.
pub fn fields(bytes: &[u8]) -> Reader<'_> {
    Reader::new(bytes)
}

/// The fields of a sub-message whose parent is at `parent_depth` (0 for a top-level message);
/// `Corrupt` past [`MAX_DEPTH`]. Equivalent to `parent.nested(bytes)` for code that passes depths
/// rather than readers through recursive decoders.
pub fn fields_at_depth(bytes: &[u8], parent_depth: u32) -> Result<Reader<'_>, ImportError> {
    let depth = parent_depth.saturating_add(1);
    if depth > MAX_DEPTH {
        return Err(corrupt("messages nested too deeply"));
    }
    Ok(Reader { buf: bytes, pos: 0, depth, failed: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }

    fn key(field: u32, wire: u8, out: &mut Vec<u8>) {
        varint((u64::from(field) << 3) | u64::from(wire), out);
    }

    fn len_field(field: u32, payload: &[u8], out: &mut Vec<u8>) {
        key(field, 2, out);
        varint(payload.len() as u64, out);
        out.extend_from_slice(payload);
    }

    fn nest(levels: usize) -> Vec<u8> {
        let mut m: Vec<u8> = Vec::new();
        key(2, 0, &mut m);
        varint(1, &mut m);
        for _ in 0..levels {
            let mut outer = Vec::new();
            len_field(1, &m, &mut outer);
            m = outer;
        }
        m
    }

    /// Deepest level reached descending every field-1 sub-message.
    fn walk(r: Reader<'_>) -> Result<u32, ImportError> {
        let mut deepest = r.depth();
        let parent = r.clone();
        for f in r {
            if let (1, Wire::Len(b)) = f? {
                deepest = deepest.max(walk(parent.nested(b)?)?);
            }
        }
        Ok(deepest)
    }

    #[test]
    fn decodes_varint_len_and_fixed() {
        let mut m = Vec::new();
        key(1, 0, &mut m);
        varint(300, &mut m);
        len_field(2, b"hello", &mut m);
        key(3, 5, &mut m);
        m.extend_from_slice(&1.5f32.to_le_bytes());
        key(4, 1, &mut m);
        m.extend_from_slice(&(-2.25f64).to_le_bytes());
        key(5, 0, &mut m);
        varint(u64::MAX, &mut m);
        key(6, 0, &mut m);
        varint(3, &mut m); // zigzag(3) = -2

        let f = fields(&m).collect_all().unwrap();
        assert_eq!(f.len(), 6);
        assert_eq!(f[0], (1, Wire::Varint(300)));
        assert_eq!(f[1].0, 2);
        assert_eq!(f[1].1.as_string().as_deref(), Some("hello"));
        assert_eq!(f[2].1.as_f32(), Some(1.5));
        assert_eq!(f[2].1.as_f64(), Some(1.5));
        assert_eq!(f[3].1.as_f64(), Some(-2.25));
        assert_eq!(f[4].1.as_i64(), Some(-1));
        assert_eq!(f[5].1.as_sint(), Some(-2));
        assert_eq!(f[0].1.as_string(), None);
    }

    #[test]
    fn decodes_packed_values() {
        let floats: Vec<u8> = [1.0f32, -0.5, 3.25].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut m = Vec::new();
        len_field(1, &floats, &mut m);
        let mut vs = Vec::new();
        for v in [1u64, 150, 1 << 40] {
            varint(v, &mut vs);
        }
        len_field(2, &vs, &mut m);
        let f = fields(&m).collect_all().unwrap();
        assert_eq!(f[0].1.packed_f32().unwrap(), vec![1.0, -0.5, 3.25]);
        assert_eq!(f[1].1.packed_varint().unwrap(), vec![1, 150, 1 << 40]);
        assert_eq!(Wire::Fixed32(2.0f32.to_bits()).packed_f32().unwrap(), vec![2.0]);
        assert_eq!(Wire::Varint(7).packed_varint().unwrap(), vec![7]);
        assert!(matches!(Wire::Len(&[0, 0, 0]).packed_f32(), Err(ImportError::Corrupt(_))));
        assert!(matches!(Wire::Len(&[0x80]).packed_varint(), Err(ImportError::Corrupt(_))));
    }

    #[test]
    fn truncated_length_is_corrupt() {
        let mut m = Vec::new();
        key(1, 2, &mut m);
        varint(100, &mut m);
        m.extend_from_slice(b"short");
        let mut it = fields(&m);
        assert!(matches!(it.next(), Some(Err(ImportError::Corrupt(_)))));
        assert!(it.next().is_none(), "the reader stops after an error");

        // Truncated fixed values and varints, a huge length, field 0 and bad wire types.
        let cases: [&[u8]; 7] = [
            &[(1 << 3) | 5, 0, 0],
            &[(1 << 3) | 1, 0],
            &[1 << 3, 0x80],
            &[(1 << 3) | 2, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
            &[0, 0],
            &[(1 << 3) | 6],
            &[(1 << 3) | 4],
        ];
        for bad in cases {
            assert!(matches!(fields(bad).collect_all(), Err(ImportError::Corrupt(_))), "{bad:?}");
        }
    }

    #[test]
    fn nesting_deeper_than_64_is_corrupt() {
        assert!(matches!(walk(fields(&nest(70))), Err(ImportError::Corrupt(_))));
        assert_eq!(walk(fields(&nest(64))).unwrap(), 64);
        assert!(matches!(walk(fields(&nest(65))), Err(ImportError::Corrupt(_))));
    }

    #[test]
    fn fields_at_depth_enforces_the_limit() {
        fn walk_depths(bytes: &[u8], parent_depth: u32) -> Result<u32, ImportError> {
            let r = fields_at_depth(bytes, parent_depth)?;
            let me = r.depth();
            let mut deepest = me;
            for f in r {
                if let (1, Wire::Len(b)) = f? {
                    deepest = deepest.max(walk_depths(b, me)?);
                }
            }
            Ok(deepest)
        }
        let top = |m: &[u8]| -> Result<u32, ImportError> {
            let mut deepest = 0;
            for f in fields(m) {
                if let (1, Wire::Len(b)) = f? {
                    deepest = deepest.max(walk_depths(b, 0)?);
                }
            }
            Ok(deepest)
        };
        assert_eq!(top(&nest(64)).unwrap(), 64);
        assert!(matches!(top(&nest(65)), Err(ImportError::Corrupt(_))));
        assert!(matches!(fields_at_depth(&[], MAX_DEPTH), Err(ImportError::Corrupt(_))));
        assert_eq!(fields_at_depth(&[], 0).unwrap().depth(), 1);
    }

    #[test]
    fn skips_groups() {
        let mut m = Vec::new();
        key(1, 3, &mut m);
        key(2, 0, &mut m);
        varint(5, &mut m);
        key(3, 3, &mut m);
        key(3, 4, &mut m);
        key(1, 4, &mut m);
        key(4, 0, &mut m);
        varint(9, &mut m);
        assert_eq!(fields(&m).collect_all().unwrap(), vec![(4, Wire::Varint(9))]);
        // An unterminated group is corrupt.
        let mut bad = Vec::new();
        key(1, 3, &mut bad);
        assert!(matches!(fields(&bad).collect_all(), Err(ImportError::Corrupt(_))));
    }
}
