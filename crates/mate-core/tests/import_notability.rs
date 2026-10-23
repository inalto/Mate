//! Notability (`.note`) import: a zip holding `Session.plist`, an NSKeyedArchiver binary plist.
//! The fixtures are built in memory by `notability_fixture::build` (see
//! `tests/fixtures/import/README.md`).

use mate_core::import::{ImportBackground, ImportError, ImportLimits, ImportSource, parse, sniff};
use mate_core::model::PenStyle;

mod notability_fixture {
    use std::io::{Cursor, Write};

    use plist::{Dictionary, Uid, Value};
    use zip::write::SimpleFileOptions;

    /// 1x1 PNG, 67 bytes.
    pub const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    /// One source stroke: points, u8 RGBA colour, width.
    #[derive(Clone)]
    pub struct Stroke {
        pub points: Vec<(f32, f32)>,
        pub rgba: [u8; 4],
        pub width: f32,
    }

    #[derive(Clone)]
    pub struct Spec {
        pub page_width: Option<f64>,
        pub paper_line_style: Option<i64>,
        /// `None`: no curves dictionary at all.
        pub strokes: Option<Vec<Stroke>>,
        pub fractional: Option<Vec<f32>>,
        pub text: bool,
        pub image: bool,
        /// The media-object array lists itself.
        pub cycle: bool,
    }

    fn line(y: f32) -> Vec<(f32, f32)> {
        vec![(10.0, y), (20.0, y), (30.0, y), (40.0, y)]
    }

    /// The `notability_basic` fixture of §7.2.
    pub fn basic() -> Spec {
        Spec {
            page_width: Some(540.0),
            paper_line_style: Some(2),
            strokes: Some(vec![
                Stroke { points: line(20.0), rgba: [0, 0, 0xFF, 0xFF], width: 2.0 },
                Stroke { points: line(40.0), rgba: [0xFF, 0, 0, 0xFF], width: 3.0 },
                Stroke { points: line(60.0), rgba: [0xFF, 0xFF, 0, 0x80], width: 12.0 },
            ]),
            fractional: Some(vec![1.0, 1.0, 1.0, 2.0, 1.0, 1.0]),
            text: true,
            image: true,
            cycle: false,
        }
    }

    struct Archive {
        objects: Vec<Value>,
    }

    impl Archive {
        fn add(&mut self, v: Value) -> Value {
            self.objects.push(v);
            Value::Uid(Uid::new(self.objects.len() as u64 - 1))
        }
        fn class(&mut self, name: &str) -> Value {
            let mut d = Dictionary::new();
            d.insert("$classname".into(), Value::String(name.into()));
            d.insert(
                "$classes".into(),
                Value::Array(vec![Value::String(name.into()), Value::String("NSObject".into())]),
            );
            self.add(Value::Dictionary(d))
        }
        fn string(&mut self, s: &str) -> Value {
            self.add(Value::String(s.into()))
        }
        fn data(&mut self, bytes: Vec<u8>) -> Value {
            self.add(Value::Data(bytes))
        }
    }

    fn dict(pairs: Vec<(&str, Value)>) -> Value {
        let mut d = Dictionary::new();
        for (k, v) in pairs {
            d.insert(k.into(), v);
        }
        Value::Dictionary(d)
    }

    fn f32s(values: impl IntoIterator<Item = f32>) -> Vec<u8> {
        values.into_iter().flat_map(f32::to_le_bytes).collect()
    }

    /// The `Session.plist` bytes (binary keyed archive).
    pub fn session_plist(spec: &Spec) -> Vec<u8> {
        let mut a = Archive { objects: vec![Value::String("$null".into())] };
        // Reserve the session slot so it is object 1.
        a.objects.push(Value::Boolean(false));

        let mut media = Vec::new();
        if spec.text {
            let cls = a.class("TextBlockMediaObject");
            let key = a.string("stringKey");
            let hello = a.string("Hello");
            let dict_cls = a.class("NSDictionary");
            let attributed = a.add(dict(vec![
                ("NS.keys", Value::Array(vec![key])),
                ("NS.objects", Value::Array(vec![hello])),
                ("$class", dict_cls),
            ]));
            let store = a.add(dict(vec![("attributedString", attributed)]));
            let origin = a.string("{50, 100}");
            let size = a.string("{200, 40}");
            media.push(a.add(dict(vec![
                ("$class", cls),
                ("textStore", store),
                ("documentOrigin", origin),
                ("unscaledContentSize", size),
            ])));
        }
        if spec.image {
            let cls = a.class("ImageMediaObject");
            let path = a.string("Images/img1.png");
            let snap = a.add(dict(vec![("relativePath", path), ("imageIsMissing", Value::Boolean(false))]));
            let bg = a.add(dict(vec![("kImageObjectSnapshotKey", snap)]));
            let fig = a.add(dict(vec![("FigureBackgroundObjectKey", bg)]));
            let origin = a.string("{50, 300}");
            let size = a.string("{100, 50}");
            media.push(a.add(dict(vec![
                ("$class", cls),
                ("figure", fig),
                ("documentOrigin", origin),
                ("unscaledContentSize", size),
                ("rotationDegrees", Value::Real(0.0)),
            ])));
        }
        let array_cls = a.class("NSMutableArray");
        let array_index = a.objects.len() as u64;
        if spec.cycle {
            media.push(Value::Uid(Uid::new(array_index)));
        }
        let array = a.add(dict(vec![("NS.objects", Value::Array(media)), ("$class", array_cls)]));
        let rich = a.add(dict(vec![("mediaObjects", array)]));

        if let Some(strokes) = &spec.strokes {
            let counts: Vec<u8> =
                strokes.iter().flat_map(|s| (s.points.len() as i32).to_le_bytes()).collect();
            let points = f32s(strokes.iter().flat_map(|s| s.points.iter().flat_map(|&(x, y)| [x, y])));
            let widths = f32s(strokes.iter().map(|s| s.width));
            let colors: Vec<u8> = strokes.iter().flat_map(|s| s.rgba).collect();
            let mut pairs = vec![
                ("curvesnumpoints", a.data(counts)),
                ("curvespoints", a.data(points)),
                ("curveswidth", a.data(widths)),
                ("curvescolors", a.data(colors)),
            ];
            if let Some(frac) = &spec.fractional {
                pairs.push(("curvesfractionalwidths", a.data(f32s(frac.iter().copied()))));
            }
            a.add(dict(pairs));
        }

        let session_cls = a.class("NBNoteTakingSession");
        let mut session = vec![("$class", session_cls), ("richText", rich)];
        if let Some(w) = spec.page_width {
            session.push(("pageWidthInDocumentCoordsKey", Value::Real(w)));
        }
        if let Some(p) = spec.paper_line_style {
            session.push(("paperLineStyle", Value::Integer(p.into())));
        }
        a.objects[1] = dict(session);

        let root = dict(vec![
            ("$archiver", Value::String("NSKeyedArchiver".into())),
            ("$version", Value::Integer(100_000.into())),
            ("$top", dict(vec![("root", Value::Uid(Uid::new(1)))])),
            ("$objects", Value::Array(a.objects)),
        ]);
        let mut out = Vec::new();
        root.to_writer_binary(&mut out).expect("write bplist");
        out
    }

    /// A zip with `Fixture/Session.plist` = `plist` and `Fixture/Images/img1.png`.
    pub fn zip_with(plist: &[u8]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        w.start_file("Fixture/Session.plist", opts).unwrap();
        w.write_all(plist).unwrap();
        w.start_file("Fixture/Images/img1.png", opts).unwrap();
        w.write_all(PNG).unwrap();
        w.finish().unwrap().into_inner()
    }

    pub fn build(spec: &Spec) -> Vec<u8> {
        zip_with(&session_plist(spec))
    }
}

use notability_fixture::{Spec, Stroke, basic, build};

fn import(bytes: &[u8]) -> Result<mate_core::import::ImportDocument, ImportError> {
    parse(bytes, "Fixture.note", &ImportLimits::default())
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-4
}

#[test]
fn notability_sniff_by_content() {
    let bytes = build(&basic());
    assert_eq!(sniff(&bytes, "whatever.zip"), Ok(ImportSource::Notability));
}

#[test]
fn notability_fixture_parses_curves() {
    let bytes = build(&basic());
    assert!(bytes.len() < 200 * 1024);
    let doc = import(&bytes).expect("parse");
    assert_eq!(doc.source, ImportSource::Notability);
    assert_eq!(doc.sections.len(), 1);
    assert_eq!(doc.page_count(), 1);
    let page = &doc.sections[0].pages[0];
    assert_eq!(page.width, 540.0);
    let s = 1080.0 / page.width;
    assert_eq!(s, 2.0);

    assert_eq!(page.strokes.len(), 3);
    let (a, b, c) = (&page.strokes[0], &page.strokes[1], &page.strokes[2]);

    let scaled: Vec<(f64, f64)> = a.points.iter().map(|p| (p.x * s, p.y * s)).collect();
    assert_eq!(scaled, vec![(20.0, 40.0), (40.0, 40.0), (60.0, 40.0), (80.0, 40.0)]);
    assert!(a.points.iter().all(|p| p.pressure.is_none()));
    assert_eq!(a.color, "#0000ff");
    assert!(close(a.width * s, 4.0), "A width {}", a.width);
    assert_eq!((a.opacity, a.is_highlighter, a.pen_style.clone()), (1.0, false, PenStyle::Pen));

    let scaled: Vec<(f64, f64)> = b.points.iter().map(|p| (p.x * s, p.y * s)).collect();
    assert_eq!(scaled, vec![(20.0, 80.0), (40.0, 80.0), (60.0, 80.0), (80.0, 80.0)]);
    assert_eq!(b.color, "#ff0000");
    // Per-point widths 3, 4, 5, 6 (fractional 1 → 2 over the cubic segment): median 4.5.
    assert!(close(b.width, 4.5), "B width {}", b.width);
    assert!(close(b.width * s, 9.0));
    assert_eq!((b.opacity, b.is_highlighter), (1.0, false));

    assert_eq!(c.color, "#ffff00");
    assert!(c.is_highlighter, "alpha 128 < 200");
    assert_eq!(c.pen_style, PenStyle::Highlighter);
    assert_eq!(c.opacity, 0.5);
    assert!(close(c.width * s, 24.0), "C width {} (fractional widths ignored)", c.width);
    assert_eq!(c.points.len(), 4);
    assert!(close(c.points[0].y * s, 120.0));

    let z: Vec<i64> = page.strokes.iter().map(|s| s.z_index).collect();
    assert!(z.windows(2).all(|w| w[0] < w[1]));

    assert_eq!(page.texts.len(), 1);
    let t = &page.texts[0];
    assert_eq!(t.text, "Hello");
    assert_eq!((t.x * s, t.y * s), (100.0, 200.0));
    assert_eq!(t.width.map(|w| w * s), Some(400.0));

    assert_eq!(page.images.len(), 1);
    let img = &page.images[0];
    assert_eq!((img.x * s, img.y * s, img.width * s, img.height * s), (100.0, 600.0, 200.0, 100.0));
    assert_eq!(img.mime.as_deref(), Some("image/png"));
    assert_eq!(img.bytes, notability_fixture::PNG);

    assert_eq!(page.background, ImportBackground::Lined { spacing: 32.0 });
}

#[test]
fn notability_note_is_one_page_sized_by_content() {
    // Basic: height = ceil(max(60, 100 + 40, 300 + 50)) = 350 source → 700 after s = 2.
    let doc = import(&build(&basic())).unwrap();
    let page = &doc.sections[0].pages[0];
    assert_eq!((page.width, page.height), (540.0, 350.0));
    assert_eq!(page.height * 1080.0 / page.width, 700.0);

    // A long canvas stays one page; the height follows the lowest stroke point (ceil).
    let mut long = basic();
    let mut strokes = long.strokes.take().unwrap();
    strokes.push(Stroke { points: vec![(10.0, 100.0), (20.0, 2500.25)], rgba: [0, 0, 0, 255], width: 2.0 });
    long.strokes = Some(strokes);
    long.fractional = None;
    let doc = import(&build(&long)).unwrap();
    assert_eq!(doc.page_count(), 1);
    let page = &doc.sections[0].pages[0];
    assert_eq!(page.strokes.len(), 4);
    assert_eq!(page.height, 2501.0);
    // Without fractional widths B keeps its width.
    assert!(close(page.strokes[1].width, 3.0));

    // No page width key: Mate's 1080 sheet (s = 1).
    let mut no_width = basic();
    no_width.page_width = None;
    let page = import(&build(&no_width)).unwrap().sections[0].pages[0].clone();
    assert_eq!(page.width, 1080.0);
    assert!(page.height >= 350.0);

    // Empty curve data: one page without strokes, not an error.
    let mut empty = basic();
    empty.strokes = Some(Vec::new());
    empty.fractional = Some(Vec::new());
    empty.text = false;
    empty.image = false;
    let doc = import(&build(&empty)).unwrap();
    assert_eq!(doc.page_count(), 1);
    let page = &doc.sections[0].pages[0];
    assert!(page.strokes.is_empty() && page.texts.is_empty() && page.images.is_empty());
    assert_eq!(page.width, 540.0);

    // No curves dictionary at all: Corrupt (as in Derive).
    let mut none = basic();
    none.strokes = None;
    assert!(matches!(import(&build(&none)), Err(ImportError::Corrupt(_))));
}

#[test]
fn notability_truncated_file_is_corrupt_not_panic() {
    let bytes = build(&basic());
    let n = bytes.len();
    let mut tried = 0;
    // The whole zip cut short: never parses.
    for i in 0..60 {
        let cut = 1 + i * (n - 2) / 60;
        assert!(import(&bytes[..cut]).is_err(), "zip cut at {cut}");
        tried += 1;
    }
    // The inner plist cut short (the zip itself intact).
    let plist = notability_fixture::session_plist(&basic());
    let m = plist.len();
    for i in 0..60 {
        let cut = i * (m - 1) / 60;
        let r = import(&notability_fixture::zip_with(&plist[..cut]));
        assert!(r.is_err(), "plist cut at {cut}");
        tried += 1;
    }
    assert!(tried >= 50);
    // Random byte damage inside the plist (fixed seed): any result but a panic.
    let mut seed: u64 = 0x5eed_1234_abcd_0001;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    for _ in 0..400 {
        let mut damaged = plist.clone();
        for _ in 0..1 + next() % 4 {
            let at = 8 + next() % (m - 8);
            damaged[at] = next() as u8;
        }
        let r = import(&notability_fixture::zip_with(&damaged));
        if let Err(e) = r {
            assert!(
                matches!(e, ImportError::Corrupt(_) | ImportError::Limit(_)),
                "unexpected error {e:?}"
            );
        }
    }
}

#[test]
fn notability_keyed_archive_cycle_does_not_hang() {
    let spec = Spec { cycle: true, ..basic() };
    let started = std::time::Instant::now();
    let r = import(&build(&spec));
    assert!(matches!(&r, Err(ImportError::Corrupt(m)) if m.contains("cycle")), "{r:?}");
    assert!(started.elapsed().as_secs() < 5);
}

#[test]
fn notability_shared_object_expansion_is_bounded() {
    // A hand-made bplist whose arrays each reference the next one twice: a few hundred bytes
    // that expand to 2^60 values if decoded naively.
    const N: usize = 60;
    let mut bytes = b"bplist00".to_vec();
    let mut offsets = Vec::new();
    for i in 0..N {
        offsets.push(bytes.len() as u8);
        bytes.extend_from_slice(&[0xA2, (i + 1) as u8, (i + 1) as u8]);
    }
    offsets.push(bytes.len() as u8);
    bytes.extend_from_slice(&[0x51, b'x']);
    let table = bytes.len() as u64;
    bytes.extend_from_slice(&offsets);
    bytes.extend_from_slice(&[0; 6]);
    bytes.extend_from_slice(&[1, 1]);
    bytes.extend_from_slice(&((N + 1) as u64).to_be_bytes());
    bytes.extend_from_slice(&0u64.to_be_bytes());
    bytes.extend_from_slice(&table.to_be_bytes());
    let started = std::time::Instant::now();
    let r = import(&notability_fixture::zip_with(&bytes));
    assert!(matches!(r, Err(ImportError::Limit(_))), "{r:?}");
    assert!(started.elapsed().as_secs() < 5);
}

#[test]
fn notability_encrypted_entry_is_reported() {
    let mut bytes = build(&basic());
    // Set general-purpose bit 0 (encrypted) on every local and central-directory header.
    let mut i = 0;
    while i + 4 <= bytes.len() {
        match bytes[i..i + 4] {
            [0x50, 0x4B, 0x03, 0x04] => bytes[i + 6] |= 1,
            [0x50, 0x4B, 0x01, 0x02] => bytes[i + 8] |= 1,
            _ => {}
        }
        i += 1;
    }
    let r = import(&bytes);
    assert!(matches!(r, Err(ImportError::Encrypted)), "{r:?}");
}
