//! GoodNotes import: fixtures built in memory by `goodnotes_fixture` (protobuf + LZ4 + zip).

use mate_core::import::{
    ImportBackground, ImportDocument, ImportError, ImportLimits, ImportPage, ImportSource,
    ImportStroke, parse, sniff,
};
use mate_core::model::PenStyle;

/// A tiny GoodNotes writer: protobuf messages, `bv41`/`bv4-` path blobs, zip.
mod goodnotes_fixture {
    use std::io::{Cursor, Write};

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    pub const IMAGE_UUID: &str = "11111111-2222-3333-4444-555555555555";
    pub const PAGE_IDS: [&str; 3] = [
        "AAAAAAAA-0000-0000-0000-000000000001",
        "AAAAAAAA-0000-0000-0000-000000000010",
        "AAAAAAAA-0000-0000-0000-000000000100",
    ];
    /// A 1×1 PNG (67 bytes).
    pub const PNG: [u8; 67] = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    // --- protobuf writer -------------------------------------------------------------------

    #[derive(Default, Clone)]
    pub struct Pb(pub Vec<u8>);

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

    impl Pb {
        pub fn new() -> Pb {
            Pb::default()
        }
        pub fn bytes(mut self, field: u32, b: &[u8]) -> Pb {
            varint(u64::from(field) << 3 | 2, &mut self.0);
            varint(b.len() as u64, &mut self.0);
            self.0.extend_from_slice(b);
            self
        }
        pub fn str(self, field: u32, s: &str) -> Pb {
            self.bytes(field, s.as_bytes())
        }
        pub fn msg(self, field: u32, m: Pb) -> Pb {
            self.bytes(field, &m.0)
        }
        pub fn f32(mut self, field: u32, v: f32) -> Pb {
            varint(u64::from(field) << 3 | 5, &mut self.0);
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        pub fn varint(mut self, field: u32, v: u64) -> Pb {
            varint(u64::from(field) << 3, &mut self.0);
            varint(v, &mut self.0);
            self
        }
    }

    pub fn xy(x: f32, y: f32) -> Pb {
        Pb::new().f32(1, x).f32(2, y)
    }

    /// A length-delimited list of messages.
    pub fn delimited(msgs: &[Pb]) -> Vec<u8> {
        let mut out = Vec::new();
        for m in msgs {
            varint(m.0.len() as u64, &mut out);
            out.extend_from_slice(&m.0);
        }
        out
    }

    // --- stroke blobs ----------------------------------------------------------------------

    /// Family-1 `tpl`: one moveTo `p0` and one quadratic (control = midpoint of p0..p1).
    pub fn tpl_line(p0: (f32, f32), p1: (f32, f32), width: f32) -> Vec<u8> {
        let mut t = b"tpl\0\0\0\0\0".to_vec();
        t.extend_from_slice(b"vuA(v)A(S(uu))A(S(uuuu))\0");
        t.extend_from_slice(&0u16.to_le_bytes());
        t.extend_from_slice(&width.to_le_bytes());
        t.extend_from_slice(&2u32.to_le_bytes());
        t.extend_from_slice(&0u16.to_le_bytes());
        t.extend_from_slice(&1u16.to_le_bytes());
        t.extend_from_slice(&1u32.to_le_bytes());
        for v in [p0.0, p0.1] {
            t.extend_from_slice(&v.to_le_bytes());
        }
        t.extend_from_slice(&1u32.to_le_bytes());
        let mid = ((p0.0 + p1.0) / 2.0, (p0.1 + p1.1) / 2.0);
        for v in [mid.0, mid.1, p1.0, p1.1] {
            t.extend_from_slice(&v.to_le_bytes());
        }
        t
    }

    /// `"bv4-" | u32 len | payload`.
    pub fn raw_blob(payload: &[u8]) -> Vec<u8> {
        let mut b = b"bv4-".to_vec();
        b.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        b.extend_from_slice(payload);
        b
    }

    /// One `"bv41"` LZ4 block (no terminator).
    pub fn lz4_block(payload: &[u8]) -> Vec<u8> {
        let c = lz4_flex::compress(payload);
        let mut b = b"bv41".to_vec();
        b.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        b.extend_from_slice(&(c.len() as u32).to_le_bytes());
        b.extend_from_slice(&c);
        b
    }

    /// One `"bv41"` LZ4 block followed by `"bv4$"`.
    pub fn lz4_blob(payload: &[u8]) -> Vec<u8> {
        let mut b = lz4_block(payload);
        b.extend_from_slice(b"bv4$");
        b
    }

    /// A `tpl` payload writer: the schema, then values appended in order.
    pub struct Tpl(pub Vec<u8>);

    impl Tpl {
        pub fn new(schema: &str) -> Tpl {
            let mut b = b"tpl\0\0\0\0\0".to_vec();
            b.extend_from_slice(schema.as_bytes());
            b.push(0);
            Tpl(b)
        }
        pub fn v(mut self, v: u16) -> Tpl {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        pub fn u(mut self, v: f32) -> Tpl {
            self.0.extend_from_slice(&v.to_le_bytes());
            self
        }
        /// `A(v)`.
        pub fn vs(mut self, vals: &[u16]) -> Tpl {
            self.0.extend_from_slice(&(vals.len() as u32).to_le_bytes());
            for v in vals {
                self.0.extend_from_slice(&v.to_le_bytes());
            }
            self
        }
        /// An array of `n` elements made of the f32 values `vals`.
        pub fn records(mut self, n: usize, vals: &[f32]) -> Tpl {
            self.0.extend_from_slice(&(n as u32).to_le_bytes());
            for v in vals {
                self.0.extend_from_slice(&v.to_le_bytes());
            }
            self
        }
        /// `A(u)`.
        pub fn us(self, vals: &[f32]) -> Tpl {
            self.records(vals.len(), vals)
        }
    }

    /// Family 1: `vuA(v)A(S(uu))A(S(uuuu))` with moves (x, y) and curves (Cx, Cy, Ex, Ey).
    pub fn plain(width: f32, flags: &[u16], moves: &[f32], curves: &[f32]) -> Tpl {
        Tpl::new("vuA(v)A(S(uu))A(S(uuuu))")
            .v(0)
            .u(width)
            .vs(flags)
            .records(moves.len() / 2, moves)
            .records(curves.len() / 4, curves)
    }

    /// Family 2: move stride 5, curve stride 11.
    pub fn wide(width: f32, flags: &[u16], moves: &[f32], curves: &[f32]) -> Tpl {
        Tpl::new("vuA(v)A(S(uuuuu))A(S(uuuuuuuuuuu))")
            .v(0)
            .u(width)
            .vs(flags)
            .records(moves.len() / 5, moves)
            .records(curves.len() / 11, curves)
    }

    /// The pressure family: groups 0 version, 1 flags, 2 moves, 3 curves, 9 nib records.
    pub fn pressure(
        version: u16,
        flags: &[u16],
        moves: &[f32],
        curves: &[f32],
        nibs: &[f32],
    ) -> Tpl {
        Tpl::new("vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)")
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

    /// An opaque blue stroke element `id` whose 7.2 blob is `blob`.
    pub fn blob_stroke(id: &str, blob: Vec<u8>) -> Pb {
        stroke_element(&StrokeSpec {
            id: Some(id.into()),
            p0: (0.0, 0.0),
            p1: (0.0, 0.0),
            rgba: [0.0, 0.0, 1.0, 1.0],
            width: 2.0,
            lz4: false,
            blob: Some(blob),
            fallback: None,
        })
    }

    // --- elements --------------------------------------------------------------------------

    pub struct StrokeSpec {
        pub id: Option<String>,
        pub p0: (f32, f32),
        pub p1: (f32, f32),
        pub rgba: [f32; 4],
        pub width: f32,
        pub lz4: bool,
        /// Replaces the generated path blob.
        pub blob: Option<Vec<u8>>,
        /// Fallback geometry (field 9): points and 9.15 width.
        pub fallback: Option<(Vec<(f32, f32)>, f32)>,
    }

    pub fn stroke_element(s: &StrokeSpec) -> Pb {
        let blob = s.blob.clone().unwrap_or_else(|| {
            let tpl = tpl_line(s.p0, s.p1, s.width);
            if s.lz4 { lz4_blob(&tpl) } else { raw_blob(&tpl) }
        });
        let [r, g, b, a] = s.rgba;
        let mut body = Pb::new();
        if let Some(id) = &s.id {
            body = body.str(1, id);
        }
        body = body.bytes(2, &blob).msg(4, Pb::new().f32(1, r).f32(2, g).f32(3, b).f32(4, a));
        if let Some((points, width)) = &s.fallback {
            let mut list = Pb::new();
            for &(x, y) in points {
                list = list.msg(1, xy(x, y));
            }
            body = body.msg(9, Pb::new().msg(1, list).f32(15, *width));
        }
        Pb::new().msg(7, body)
    }

    pub fn text_element(id: &str, text: &str, x: f32, y: f32, width: f32) -> Pb {
        let payload = Pb::new().msg(1, Pb::new().str(1, text));
        Pb::new().msg(
            21,
            Pb::new()
                .str(1, id)
                .msg(20, Pb::new().msg(1, xy(x, y)))
                .msg(21, Pb::new().msg(3, Pb::new().f32(2, width)))
                .msg(32, Pb::new().msg(1, Pb::new().bytes(2, &lz4_block(&payload.0)))),
        )
    }

    /// An image whose top-left is (x, y).
    pub fn image_element(id: &str, x: f32, y: f32, w: f32, h: f32) -> Pb {
        Pb::new().msg(
            1,
            Pb::new()
                .str(1, id)
                .str(4, IMAGE_UUID)
                .msg(3, Pb::new().msg(1, xy(x + w / 2.0, y + h / 2.0)).msg(2, xy(w, h))),
        )
    }

    /// A deletion record for `id`.
    pub fn tombstone(id: &str) -> Pb {
        Pb::new().str(1, id).str(2, "v").varint(3, 1).varint(8, 1)
    }

    // --- notebook --------------------------------------------------------------------------

    pub struct PageSpec {
        pub id: String,
        pub elements: Vec<Pb>,
    }

    pub struct Spec {
        pub pages: Vec<PageSpec>,
        pub width: String,
        pub height: String,
        /// Extra root entries (e.g. `index.events.pb`).
        pub extra: Vec<(String, Vec<u8>)>,
    }

    /// Strokes A (pen, blue, 2), B (pen, red, 3, LZ4) and C (highlighter, yellow, alpha 0.5, 12)
    /// on a page, shifted down by `dy`.
    pub fn abc(page: usize, dy: f32) -> Vec<StrokeSpec> {
        let line = |n: &str, y: f32, rgba: [f32; 4], width: f32, lz4: bool| StrokeSpec {
            id: Some(format!("stroke-{n}-{page}")),
            p0: (10.0, y + dy),
            p1: (40.0, y + dy),
            rgba,
            width,
            lz4,
            blob: None,
            fallback: None,
        };
        vec![
            line("A", 20.0, [0.0, 0.0, 1.0, 1.0], 2.0, false),
            line("B", 40.0, [1.0, 0.0, 0.0, 1.0], 3.0, true),
            line("C", 60.0, [1.0, 1.0, 0.0, 0.5], 12.0, false),
        ]
    }

    /// The §7.1 notebook: three 540 × 720 pages; pages 1–2 with strokes A, B, C, a text and an
    /// image; page 3 empty.
    pub fn basic() -> Spec {
        let mut pages = Vec::new();
        for (i, (text, dy)) in [("Hello", 0.0f32), ("World", 100.0)].into_iter().enumerate() {
            let mut elements: Vec<Pb> = abc(i + 1, dy).iter().map(stroke_element).collect();
            elements.push(text_element(&format!("text-{i}"), text, 50.0, 100.0 + dy, 200.0));
            elements.push(image_element(&format!("img-{i}"), 50.0, 300.0 + dy, 100.0, 50.0));
            pages.push(PageSpec { id: PAGE_IDS[i].into(), elements });
        }
        pages.push(PageSpec { id: PAGE_IDS[2].into(), elements: Vec::new() });
        Spec { pages, width: "540".into(), height: "720".into(), extra: Vec::new() }
    }

    /// The zip entries of `spec`.
    pub fn entries(spec: &Spec) -> Vec<(String, Vec<u8>)> {
        let records: Vec<Pb> = spec
            .pages
            .iter()
            .map(|p| {
                Pb::new()
                    .str(1, &p.id)
                    .str(2, &format!("notes/{}", p.id))
                    .str(3, &spec.width)
                    .str(4, &spec.height)
            })
            .collect();
        let mut out = vec![("index.notes.pb".to_owned(), delimited(&records))];
        for p in &spec.pages {
            out.push((format!("notes/{}", p.id), delimited(&p.elements)));
        }
        out.push((
            "index.attachments.pb".into(),
            delimited(&[Pb::new().str(1, IMAGE_UUID).str(2, "attachments/img1.png")]),
        ));
        out.push(("attachments/img1.png".into(), PNG.to_vec()));
        out.extend(spec.extra.iter().cloned());
        out
    }

    pub fn zip(entries: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            w.start_file(name.as_str(), opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    pub fn build(spec: &Spec) -> Vec<u8> {
        zip(&entries(spec))
    }
}

use goodnotes_fixture as fx;

fn import(bytes: &[u8]) -> Result<ImportDocument, ImportError> {
    parse(bytes, "notebook.goodnotes", &ImportLimits::for_source(ImportSource::GoodNotes))
}

fn pages(doc: &ImportDocument) -> &[ImportPage] {
    &doc.sections[0].pages
}

fn single_page(elements: Vec<fx::Pb>) -> ImportPage {
    let spec = fx::Spec {
        pages: vec![fx::PageSpec { id: fx::PAGE_IDS[0].into(), elements }],
        width: "540".into(),
        height: "720".into(),
        extra: Vec::new(),
    };
    let doc = import(&fx::build(&spec)).unwrap();
    assert_eq!(doc.page_count(), 1);
    pages(&doc)[0].clone()
}

#[test]
fn goodnotes_fixture_is_small() {
    assert!(fx::build(&fx::basic()).len() < 200 * 1024);
}

#[test]
fn goodnotes_fixture_parses_sections_pages_strokes() {
    let doc = import(&fx::build(&fx::basic())).unwrap();
    assert_eq!(doc.source, ImportSource::GoodNotes);
    assert_eq!(doc.sections.len(), 1);
    let ps = pages(&doc);
    assert_eq!(ps.len(), 3);
    let ids: Vec<&str> = ps.iter().map(|p| p.source_id.as_str()).collect();
    assert_eq!(ids, fx::PAGE_IDS);
    for p in ps {
        assert_eq!((p.width, p.height), (540.0, 720.0));
        // After the placer's scaling s = 1080 / width = 2: 1080 × 1440.
        let s = 1080.0 / p.width;
        assert_eq!((p.width * s, p.height * s), (1080.0, 1440.0));
        assert_eq!(p.background, ImportBackground::Plain);
    }
    let counts: Vec<(usize, usize, usize)> =
        ps.iter().map(|p| (p.strokes.len(), p.texts.len(), p.images.len())).collect();
    assert_eq!(counts, vec![(3, 1, 1), (3, 1, 1), (0, 0, 0)]);

    let p1 = &ps[0];
    let s = 1080.0 / p1.width;
    let a = &p1.strokes[0];
    // A straight quadratic flattens to 3 points: P0, midpoint, end.
    let scaled: Vec<(f64, f64)> = a.points.iter().take(3).map(|p| (p.x * s, p.y * s)).collect();
    assert_eq!(scaled, vec![(20.0, 40.0), (50.0, 40.0), (80.0, 40.0)]);
    assert_eq!(a.points.len(), 3);
    assert!(a.points.iter().all(|p| p.pressure.is_none()));
    assert_eq!(a.color, "#0000ff");
    assert_eq!(a.width * s, 4.0);
    assert_eq!(a.opacity, 1.0);
    assert!(!a.is_highlighter);
    assert_eq!(a.pen_style, PenStyle::Pen);

    // B came through an LZ4 block.
    let b = &p1.strokes[1];
    assert_eq!(b.color, "#ff0000");
    assert_eq!(b.width * s, 6.0);
    assert_eq!(b.opacity, 1.0);
    assert_eq!(b.points[0].y * s, 80.0);
    let z: Vec<i64> = p1.strokes.iter().map(|s| s.z_index).collect();
    assert_eq!(z, vec![0, 1, 2]);

    // Page 2 is the same geometry shifted down by 100.
    let a2 = &ps[1].strokes[0];
    assert_eq!((a2.points[0].x, a2.points[0].y), (10.0, 120.0));
    assert_eq!(ps.iter().map(|p| p.skipped.other).sum::<u32>(), 0);
}

#[test]
fn goodnotes_highlighter_and_text_and_image() {
    let doc = import(&fx::build(&fx::basic())).unwrap();
    let ps = pages(&doc);
    let s = 1080.0 / ps[0].width;

    let c = &ps[0].strokes[2];
    assert!(c.is_highlighter, "alpha 0.5 < 0.6 is a highlighter");
    assert_eq!(c.pen_style, PenStyle::Highlighter);
    assert_eq!(c.color, "#ffff00");
    assert_eq!(c.opacity, 0.5, "highlighter opacity is Mate's, not the source alpha");
    assert_eq!(c.width * s, 24.0);

    let t1 = &ps[0].texts[0];
    assert_eq!(t1.text, "Hello");
    assert_eq!((t1.x * s, t1.y * s), (100.0, 200.0));
    assert_eq!(t1.width.map(|w| w * s), Some(400.0));
    assert_eq!(t1.color, "#000000");
    let t2 = &ps[1].texts[0];
    assert_eq!((t2.text.as_str(), t2.x, t2.y), ("World", 50.0, 200.0));

    let img = &ps[0].images[0];
    assert_eq!((img.x * s, img.y * s, img.width * s, img.height * s), (100.0, 600.0, 200.0, 100.0));
    assert_eq!(img.mime.as_deref(), Some("image/png"));
    assert_eq!(img.bytes, fx::PNG);
    assert_eq!((ps[1].images[0].x, ps[1].images[0].y), (50.0, 400.0));
}

#[test]
fn goodnotes_out_of_range_width_falls_back_to_2() {
    let mut strokes = fx::abc(1, 0.0);
    strokes[0].width = 80.0;
    strokes[1].width = 0.1;
    strokes[2].width = 60.0;
    let page = single_page(strokes.iter().map(fx::stroke_element).collect());
    let widths: Vec<f64> = page.strokes.iter().map(|s| s.width).collect();
    // A range check (0.2..=60), not a clamp: 80 and 0.1 fall back to 2; 60 is kept.
    assert_eq!(widths, vec![2.0, 2.0, 60.0]);
}

#[test]
fn goodnotes_unreadable_stroke_is_skipped_and_counted() {
    let mut s = fx::abc(1, 0.0);
    // Garbage LZ4 behind a valid-looking header.
    let mut bad_lz4 = b"bv41".to_vec();
    bad_lz4.extend_from_slice(&64u32.to_le_bytes());
    bad_lz4.extend_from_slice(&4u32.to_le_bytes());
    bad_lz4.extend_from_slice(&[0xF0, 0xFF, 0xFF, 0xFF]);
    s[1].blob = Some(bad_lz4);
    // An unknown schema family.
    let mut tpl = b"tpl\0\0\0\0\0vA(u)\0".to_vec();
    tpl.extend_from_slice(&0u16.to_le_bytes());
    tpl.extend_from_slice(&0u32.to_le_bytes());
    s[2].blob = Some(fx::raw_blob(&tpl));
    // No 7.1 id.
    let mut no_id = fx::abc(1, 0.0).remove(0);
    no_id.id = None;
    // Unreadable blob with fallback geometry: the fallback (and its 9.15 width) is used.
    let mut with_fallback = fx::abc(1, 200.0).remove(0);
    with_fallback.id = Some("fallback".into());
    with_fallback.blob = Some(b"bv41 truncated".to_vec());
    with_fallback.fallback = Some((vec![(5.0, 5.0), (15.0, 5.0)], 7.0));

    let mut elements: Vec<fx::Pb> = s.iter().map(fx::stroke_element).collect();
    elements.push(fx::stroke_element(&no_id));
    elements.push(fx::stroke_element(&with_fallback));
    let page = single_page(elements);
    assert_eq!(page.strokes.len(), 2, "A and the fallback stroke");
    assert_eq!(page.strokes[0].color, "#0000ff");
    let fb = &page.strokes[1];
    assert_eq!(fb.width, 7.0);
    assert_eq!(fb.points.len(), 2);
    assert_eq!((fb.points[1].x, fb.points[1].y), (15.0, 5.0));
    assert_eq!(page.skipped.other, 3);
}

#[test]
fn goodnotes_tombstoned_stroke_is_hidden() {
    let strokes = fx::abc(1, 0.0);
    let mut elements: Vec<fx::Pb> = strokes.iter().map(fx::stroke_element).collect();
    elements.push(fx::tombstone("stroke-B-1"));
    // A version record with field 3 ≠ 1 does not delete.
    elements.push(fx::Pb::new().str(1, "stroke-C-1").str(2, "v").varint(3, 0).varint(8, 2));
    let page = single_page(elements);
    let colours: Vec<&str> = page.strokes.iter().map(|s| s.color.as_str()).collect();
    assert_eq!(colours, vec!["#0000ff", "#ffff00"]);
    assert_eq!(page.skipped.other, 0, "a deleted stroke is not counted as skipped");

    // Tombstones also hide texts (21.1) and images (1.1).
    let page = single_page(vec![
        fx::text_element("t", "Gone", 1.0, 1.0, 10.0),
        fx::image_element("i", 1.0, 1.0, 10.0, 10.0),
        fx::tombstone("t"),
        fx::tombstone("i"),
    ]);
    assert!(page.texts.is_empty() && page.images.is_empty());
}

#[test]
fn goodnotes_truncated_file_is_corrupt_not_panic() {
    let bytes = fx::build(&fx::basic());
    let n = bytes.len();
    // 60 truncation points spread over the whole file.
    for k in 0..60 {
        let cut = 4 + k * (n - 5) / 59;
        let r = import(&bytes[..cut]);
        assert!(matches!(r, Err(ImportError::Corrupt(_))), "cut at {cut}/{n}: {r:?}");
    }

    // Damage inside the entries (the zip stays valid, so the protobuf / LZ4 / tpl readers see
    // it): truncate and flip bytes with a fixed seed. Errors are fine; panics are not.
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let clean = fx::entries(&fx::basic());
    let targets: Vec<usize> = clean
        .iter()
        .enumerate()
        .filter(|(_, (name, _))| name.ends_with(".pb") || name.starts_with("notes/"))
        .map(|(i, _)| i)
        .collect();
    for round in 0..400 {
        let mut entries = clean.clone();
        let t = targets[rnd() as usize % targets.len()];
        let data = &mut entries[t].1;
        if data.is_empty() {
            continue;
        }
        if round % 4 == 0 {
            let cut = rnd() as usize % data.len();
            data.truncate(cut);
        } else {
            for _ in 0..1 + rnd() % 4 {
                let i = rnd() as usize % data.len();
                data[i] ^= (rnd() as u8) | 1;
            }
        }
        let _ = import(&fx::zip(&entries));
    }
}

#[test]
fn goodnotes_over_100mib_is_limit() {
    assert_eq!(ImportLimits::for_source(ImportSource::GoodNotes).max_file_bytes, 100 * 1024 * 1024);
    let bytes = fx::build(&fx::basic());
    let tiny = ImportLimits { max_file_bytes: bytes.len() as u64 - 1, ..ImportLimits::default() };
    assert!(matches!(parse(&bytes, "a.goodnotes", &tiny), Err(ImportError::Limit(_))));
    // The zip budget bounds what the parser inflates (entries and LZ4 blocks).
    let small = ImportLimits { max_unzipped_bytes: 64, ..ImportLimits::default() };
    assert!(matches!(parse(&bytes, "a.goodnotes", &small), Err(ImportError::Limit(_))));
}

#[test]
fn goodnotes_sniff_by_entries_not_extension() {
    let bytes = fx::build(&fx::basic());
    for name in ["notebook.goodnotes", "notebook.zip", "notebook", "notebook.freenotes"] {
        assert_eq!(sniff(&bytes, name), Ok(ImportSource::GoodNotes), "{name}");
    }
    let doc = parse(&bytes, "renamed.zip", &ImportLimits::default()).unwrap();
    assert_eq!(doc.page_count(), 3);
    // The extension alone does not make a GoodNotes notebook.
    let not_gn = fx::zip(&[("readme.txt".into(), b"hello".to_vec())]);
    assert!(matches!(
        parse(&not_gn, "fake.goodnotes", &ImportLimits::default()),
        Err(ImportError::Unsupported(_))
    ));
}

#[test]
fn goodnotes_events_order_backgrounds_and_deleted_pages() {
    let mut spec = fx::basic();
    // index.events.pb: page 2 deleted; page 1 uses a 600 × 800 template.
    let events = fx::delimited(&[
        fx::Pb::new().str(1, "tpl-1").msg(2, fx::Pb::new().msg(8, fx::xy(600.0, 800.0))),
        fx::Pb::new()
            .str(1, fx::PAGE_IDS[0])
            .msg(54, fx::Pb::new().msg(3, fx::Pb::new().str(1, "tpl-1"))),
        fx::Pb::new().str(1, fx::PAGE_IDS[1]).msg(56, fx::Pb::new().varint(1, 1)),
    ]);
    let backgrounds = fx::delimited(&[
        fx::Pb::new().str(1, fx::PAGE_IDS[0]).str(2, "grid"),
        fx::Pb::new().str(1, fx::PAGE_IDS[2]).str(2, "cornell"),
    ]);
    // A page that is not in index.notes.pb is appended.
    spec.extra = vec![
        ("index.events.pb".into(), events),
        ("index.backgrounds.pb".into(), backgrounds),
        ("notes/ZZZ-unlisted".into(), Vec::new()),
    ];
    let doc = import(&fx::build(&spec)).unwrap();
    let ps = pages(&doc);
    let ids: Vec<&str> = ps.iter().map(|p| p.source_id.as_str()).collect();
    assert_eq!(ids, vec![fx::PAGE_IDS[0], fx::PAGE_IDS[2], "ZZZ-unlisted"]);
    assert_eq!((ps[0].width, ps[0].height), (600.0, 800.0));
    assert_eq!((ps[1].width, ps[1].height), (540.0, 720.0));
    assert_eq!((ps[2].width, ps[2].height), (1080.0, 1440.0), "no size anywhere: default");
    assert!(matches!(ps[0].background, ImportBackground::Grid { .. }));
    assert!(matches!(ps[1].background, ImportBackground::Lined { .. }));
    assert_eq!(ps[2].background, ImportBackground::Plain);

    // Events keyed by the page uuid minus one also apply (observed GoodNotes behaviour).
    let mut spec = fx::basic();
    let minus_one = "AAAAAAAA-0000-0000-0000-00000000000F";
    spec.extra = vec![(
        "index.events.pb".into(),
        fx::delimited(&[fx::Pb::new().str(1, minus_one).msg(56, fx::Pb::new())]),
    )];
    let doc = import(&fx::build(&spec)).unwrap();
    let ids: Vec<&str> = pages(&doc).iter().map(|p| p.source_id.as_str()).collect();
    assert_eq!(ids, vec![fx::PAGE_IDS[0], fx::PAGE_IDS[2]]);
}

/// One page holding a single stroke whose path blob is the raw `tpl` payload `t`.
fn vector_page(t: fx::Tpl) -> ImportPage {
    single_page(vec![fx::blob_stroke("vector", fx::raw_blob(&t.0))])
}

fn xy(s: &ImportStroke) -> Vec<(f64, f64)> {
    s.points.iter().map(|p| (p.x, p.y)).collect()
}

/// §1h.8 through the whole parser: points, pressures and stroke widths (source units). The
/// per-point widths behind the stroke widths are checked by the unit test of the same name in
/// `goodnotes.rs`.
#[test]
fn goodnotes_f3_test_vectors() {
    let line = [5.0, 0.0, 10.0, 0.0];
    // 1. F1: one sub-path, width 2.5, no pressure.
    let p = vector_page(fx::plain(2.5, &[0, 1], &[0.0, 0.0], &line));
    assert_eq!(p.strokes.len(), 1);
    assert_eq!(xy(&p.strokes[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
    assert_eq!(p.strokes[0].width, 2.5);
    assert!(p.strokes[0].points.iter().all(|pt| pt.pressure.is_none()));
    // 2. Width 80 or 0.1 → 2.
    for w in [80.0, 0.1] {
        assert_eq!(vector_page(fx::plain(w, &[0, 1], &[0.0, 0.0], &line)).strokes[0].width, 2.0);
    }
    // 3. Two curves in one sub-path.
    let p = vector_page(fx::plain(
        2.0,
        &[0, 1, 1],
        &[0.0, 0.0],
        &[5.0, 0.0, 10.0, 0.0, 15.0, 0.0, 20.0, 0.0],
    ));
    assert_eq!(
        xy(&p.strokes[0]),
        vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0), (15.0, 0.0), (20.0, 0.0)]
    );
    // 4. Two sub-paths → two strokes of 3 points.
    let p = vector_page(fx::plain(
        2.0,
        &[0, 1, 0, 1],
        &[0.0, 0.0, 0.0, 10.0],
        &[5.0, 0.0, 10.0, 0.0, 5.0, 10.0, 10.0, 10.0],
    ));
    assert_eq!(p.strokes.len(), 2);
    assert_eq!(xy(&p.strokes[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
    assert_eq!(xy(&p.strokes[1]), vec![(0.0, 10.0), (5.0, 10.0), (10.0, 10.0)]);
    // 5. Unreadable: skipped and counted, never an error.
    let mut trailing = fx::plain(2.0, &[0, 1], &[0.0, 0.0], &line);
    trailing.0.push(0);
    let unreadable = [
        fx::plain(2.0, &[1], &[], &line),
        fx::plain(2.0, &[0, 1], &[0.0, 0.0], &[]),
        fx::plain(2.0, &[0], &[0.0, 0.0, 1.0, 1.0], &[]),
        fx::plain(2.0, &[0, 2], &[0.0, 0.0], &[]),
        fx::Tpl::new("vuA(v)A(S(uuu))").v(0).u(1.0).vs(&[]).records(0, &[]),
        trailing,
    ];
    for (i, t) in unreadable.into_iter().enumerate() {
        let p = vector_page(t);
        assert!(p.strokes.is_empty(), "case {i}");
        assert_eq!(p.skipped.other, 1, "case {i}");
    }
    // 6. A bent curve: 8 points after P0, t = ½ at (50, 25), the end exact.
    let p = vector_page(fx::plain(2.0, &[0, 1], &[0.0, 0.0], &[50.0, 50.0, 100.0, 0.0]));
    let pts = xy(&p.strokes[0]);
    assert_eq!(pts.len(), 9);
    assert_eq!((pts[4], pts[8]), ((50.0, 25.0), (100.0, 0.0)));
    // 7. F2.
    let p = vector_page(fx::wide(
        3.0,
        &[0, 1],
        &[1.0, 2.0, 9.0, 9.0, 9.0],
        &[9.0, 3.0, 2.0, 9.0, 9.0, 9.0, 5.0, 2.0, 9.0, 9.0, 9.0],
    ));
    assert_eq!(xy(&p.strokes[0]), vec![(1.0, 2.0), (3.0, 2.0), (5.0, 2.0)]);
    assert_eq!(p.strokes[0].width, 3.0);

    // F3a (version 1).
    let curve = [5.0, 0.0, 1.0, 10.0, 0.0, 1.0];
    let nib = |x: f32, p: f32| [x, 0.0, p, 1.0, 0.0, 0.0, 0.0];
    let nibs8: Vec<f32> = [nib(0.0, 0.5), nib(10.0, 1.0)].concat();
    // 8. Widths 1, none, 2 → 1.5; pressure 1/5 everywhere.
    let p = vector_page(fx::pressure(1, &[0, 1], &[0.0, 0.0, 1.0], &curve, &nibs8));
    assert_eq!(xy(&p.strokes[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
    assert!(p.strokes[0].points.iter().all(|pt| pt.pressure == Some(0.2)));
    assert_eq!(p.strokes[0].width, 1.5);
    // 9. Uniform ratio → widths 1, 1, 1.
    let nibs9: Vec<f32> = [nib(0.0, 0.5), nib(10.0, 0.5)].concat();
    let p = vector_page(fx::pressure(1, &[0, 1], &[0.0, 0.0, 1.0], &curve, &nibs9));
    assert_eq!(p.strokes[0].width, 1.0);
    // 10. 13 nib values → no widths → 2.
    let p = vector_page(fx::pressure(1, &[0, 1], &[0.0, 0.0, 1.0], &curve, &nibs8[..13]));
    assert_eq!(p.strokes[0].width, 2.0);
    // 11. Two records for one key, taken in point order across sub-paths.
    let nibs11: Vec<f32> = [nib(0.0, 0.5), nib(0.0, 0.75)].concat();
    let p = vector_page(fx::pressure(
        1,
        &[0, 1, 0, 1],
        &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        &[curve, curve].concat(),
        &nibs11,
    ));
    let w: Vec<f64> = p.strokes.iter().map(|s| s.width).collect();
    assert_eq!(w, vec![1.0, 1.5]);

    // F3b (version 2, flags 4/5).
    let move_b = [0.0, 0.0, 1.0, 0.0];
    let curve_b = [5.0, 0.0, 1.0, 10.0, 0.0, 1.0, 0.0, 0.0, 2.0];
    // 12. Geometric widths 2, 2, 2.
    let p = vector_page(fx::pressure(2, &[4, 5], &move_b, &curve_b, &[]));
    assert_eq!(xy(&p.strokes[0]), vec![(0.0, 0.0), (5.0, 0.0), (10.0, 0.0)]);
    assert_eq!(p.strokes[0].width, 2.0);
    // 13. The end point's record gives 1; the median stays 2.
    let rec = [10.0, 0.0, 0.5, 1.0, 0.0, 0.0, std::f32::consts::FRAC_PI_2];
    let p = vector_page(fx::pressure(2, &[4, 5], &move_b, &curve_b, &rec));
    assert_eq!(p.strokes[0].width, 2.0);
    // 14. Version 2 with flags from both sets → unreadable.
    let p = vector_page(fx::pressure(2, &[0, 5], &[0.0, 0.0, 1.0], &curve, &[]));
    assert!(p.strokes.is_empty());
    assert_eq!(p.skipped.other, 1);
}

/// Flags [0, 1 × n] with every curve bending 5000 units away (64 segments each).
fn amplifying_blob(curves: usize) -> Vec<u8> {
    let flags: Vec<u16> = std::iter::once(0).chain(std::iter::repeat_n(1, curves)).collect();
    let records: Vec<f32> = (0..curves).flat_map(|_| [5000.0, 5000.0, 0.0, 0.0]).collect();
    fx::raw_blob(&fx::plain(2.0, &flags, &[0.0, 0.0], &records).0)
}

fn one_page_spec(elements: Vec<fx::Pb>, extra: Vec<(String, Vec<u8>)>) -> fx::Spec {
    fx::Spec {
        pages: vec![fx::PageSpec { id: fx::PAGE_IDS[0].into(), elements }],
        width: "540".into(),
        height: "720".into(),
        extra,
    }
}

#[test]
fn goodnotes_point_budget_limits_amplification() {
    // 20 000 curves would flatten to 1 280 001 points: the stroke is skipped and counted as
    // soon as it passes 50 000, and the other stroke is kept.
    let elements = vec![
        fx::blob_stroke("huge", amplifying_blob(20_000)),
        fx::stroke_element(&fx::abc(1, 0.0).remove(0)),
    ];
    let bytes = fx::build(&one_page_spec(elements, Vec::new()));
    let started = std::time::Instant::now();
    let doc = import(&bytes).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(1), "{:?}", started.elapsed());
    let page = &pages(&doc)[0];
    assert_eq!(page.strokes.len(), 1);
    assert_eq!(page.strokes[0].color, "#0000ff");
    assert_eq!(page.skipped.other, 1);

    // Just under the stroke budget (780 · 64 + 1 = 49 921 points) but repeated over 110
    // strokes: the file budget (5 000 000 points) stops the import.
    let blob = amplifying_blob(780);
    let elements: Vec<fx::Pb> =
        (0..110).map(|i| fx::blob_stroke(&format!("s{i}"), blob.clone())).collect();
    match import(&fx::build(&one_page_spec(elements, Vec::new()))) {
        Err(ImportError::Limit(m)) => assert!(m.contains("points"), "{m}"),
        other => panic!("{:?}", other.map(|d| d.page_count())),
    }
}

#[test]
fn goodnotes_event_precedence() {
    let ids: Vec<String> =
        (1..=5).map(|k| format!("BBBBBBBB-0000-0000-0000-0000000000{k}0")).collect();
    let rec = |id: &str| fx::Pb::new().str(1, id);
    let binding = |t: &str| fx::Pb::new().msg(3, fx::Pb::new().str(1, t));
    let define = |id: &str, w: f32, h: f32| rec(id).msg(2, fx::Pb::new().msg(8, fx::xy(w, h)));
    let canvas =
        |id: &str, title: &str| rec(id).msg(64, fx::Pb::new().msg(3, fx::Pb::new().str(1, title)));
    let events = fx::delimited(&[
        define("T", 600.0, 800.0),
        // Page 1: deleted, then a record holding both 2 and 54 (only 2 acts: still deleted),
        // then bound to T: live again.
        rec(&ids[0]).msg(56, fx::Pb::new()),
        define(&ids[0], 1.0, 1.0).msg(54, binding("T")),
        rec(&ids[0]).msg(54, binding("T")),
        // Page 2: bound, then a canvas.
        rec(&ids[1]).msg(54, binding("T")),
        canvas(&ids[1], "Board"),
        // Page 3: a canvas, then bound: a normal page.
        canvas(&ids[2], "Gone"),
        rec(&ids[2]).msg(54, binding("T")),
        // Page 4: 56 and 64 in one record: 56 acts.
        rec(&ids[3]).msg(56, fx::Pb::new()).msg(64, fx::Pb::new()),
        // Page 5: 64 and 54 in one record: 64 acts.
        canvas(&ids[4], "B5").msg(54, binding("T")),
        // A later definition of T replaces the first.
        define("T", 700.0, 900.0),
    ]);
    let mut page_specs: Vec<fx::PageSpec> =
        ids.iter().map(|id| fx::PageSpec { id: id.clone(), elements: Vec::new() }).collect();
    // The canvas page holds the §7.1 page-1 content.
    let mut board: Vec<fx::Pb> = fx::abc(1, 0.0).iter().map(fx::stroke_element).collect();
    board.push(fx::text_element("text", "Hello", 50.0, 100.0, 200.0));
    board.push(fx::image_element("img", 50.0, 300.0, 100.0, 50.0));
    page_specs[1].elements = board;
    let spec = fx::Spec {
        pages: page_specs,
        width: "540".into(),
        height: "720".into(),
        extra: vec![("index.events.pb".into(), events)],
    };
    let doc = import(&fx::build(&spec)).unwrap();
    let ps = pages(&doc);
    let got: Vec<(&str, f64, f64, Option<&str>)> = ps
        .iter()
        .map(|p| (p.source_id.as_str(), p.width, p.height, p.title.as_deref()))
        .collect();
    assert_eq!(
        got,
        vec![
            (ids[0].as_str(), 700.0, 900.0, None),
            // Content extent (4, 19)..(250, 350) plus an 80-unit margin on each side.
            (ids[1].as_str(), 406.0, 491.0, Some("Board")),
            (ids[2].as_str(), 700.0, 900.0, None),
            // An empty board is a default page.
            (ids[4].as_str(), 1080.0, 1440.0, Some("B5")),
        ]
    );
    // Board content moved by (80 − 4, 80 − 19).
    let b = &ps[1];
    assert_eq!((b.strokes[0].points[0].x, b.strokes[0].points[0].y), (86.0, 81.0));
    assert_eq!((b.texts[0].x, b.texts[0].y), (126.0, 161.0));
    assert_eq!((b.images[0].x, b.images[0].y), (126.0, 361.0));
    assert_eq!(b.skipped.other, 0);
}

#[test]
fn goodnotes_unknown_blob_oversized_board_and_shared_images() {
    // A 7.2 blob with an unknown magic and no fallback is counted; a body without 7.2 (and no
    // fallback) is silent.
    let page = single_page(vec![
        fx::blob_stroke("odd", b"zzzz0000000000000000".to_vec()),
        fx::Pb::new().msg(7, fx::Pb::new().str(1, "empty")),
    ]);
    assert!(page.strokes.is_empty());
    assert_eq!(page.skipped.other, 1);

    // A board wider than 50 000 units keeps its fitted size and is counted; no Limit error.
    let far = |id: &str, x: f32| {
        fx::stroke_element(&fx::StrokeSpec {
            id: Some(id.into()),
            p0: (x, 0.0),
            p1: (x + 10.0, 0.0),
            rgba: [0.0, 0.0, 0.0, 1.0],
            width: 2.0,
            lz4: false,
            blob: None,
            fallback: None,
        })
    };
    let board = fx::delimited(&[fx::Pb::new().str(1, fx::PAGE_IDS[0]).msg(64, fx::Pb::new())]);
    let spec = one_page_spec(
        vec![far("a", 0.0), far("b", 60_000.0)],
        vec![("index.events.pb".into(), board)],
    );
    let doc = import(&fx::build(&spec)).unwrap();
    let p = &pages(&doc)[0];
    assert_eq!((p.width, p.height), (60_172.0, 162.0));
    assert_eq!(p.strokes.len(), 2);
    assert_eq!(p.skipped.other, 1);

    // Pages 1 and 2 of the §7.1 notebook share one attachment: both get its bytes.
    let doc = import(&fx::build(&fx::basic())).unwrap();
    assert_eq!(pages(&doc)[0].images[0].bytes, fx::PNG);
    assert_eq!(pages(&doc)[1].images[0].bytes, fx::PNG);
}
