//! Freenotes importer: containers, layers and z order, ink rules, text and images, damaged files.
//! The fixtures are built in memory by `freenotes_fixture` (a tiny protobuf writer plus a zip).

use mate_core::import::{ImportDocument, ImportError, ImportLimits, ImportSource, parse};
use mate_core::model::{PageMode, PenStyle};

const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1,
];

mod freenotes_fixture {
    use std::io::{Cursor, Write};

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    // --- protobuf writer -------------------------------------------------------------------

    pub fn varint(mut v: u64, out: &mut Vec<u8>) {
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

    pub fn len(field: u32, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        varint(u64::from(field) << 3 | 2, &mut out);
        varint(payload.len() as u64, &mut out);
        out.extend_from_slice(payload);
        out
    }

    pub fn uint(field: u32, v: u64) -> Vec<u8> {
        let mut out = Vec::new();
        varint(u64::from(field) << 3, &mut out);
        varint(v, &mut out);
        out
    }

    pub fn f64f(field: u32, v: f64) -> Vec<u8> {
        let mut out = Vec::new();
        varint(u64::from(field) << 3 | 1, &mut out);
        out.extend_from_slice(&v.to_le_bytes());
        out
    }

    pub fn text(field: u32, s: &str) -> Vec<u8> {
        len(field, s.as_bytes())
    }

    pub fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }

    fn xy(field: u32, x: f64, y: f64) -> Vec<u8> {
        len(field, &cat(&[f64f(1, x), f64f(2, y)]))
    }

    fn ts(field: u32, secs: u64) -> Vec<u8> {
        len(field, &uint(1, secs))
    }

    // --- records ---------------------------------------------------------------------------

    /// A stroke entry of a content record (`field 3`): ink, a point list, and the time at `4.3`.
    pub fn stroke(
        key: &str,
        secs: u64,
        ink_type: u64,
        color: Option<u32>,
        nib: Option<f64>,
        pts: &[(f64, f64)],
    ) -> Vec<u8> {
        let mut ink = uint(1, ink_type);
        if let Some(c) = color {
            ink.extend(uint(2, u64::from(c)));
        }
        let mut path = Vec::new();
        for &(x, y) in pts {
            let mut p = xy(1, x, y);
            if let Some(n) = nib {
                p.extend(len(3, &f64f(1, n)));
            }
            path.extend(len(2, &p));
        }
        path.extend(ts(3, secs));
        let stroke = cat(&[len(2, &ink), len(4, &path)]);
        len(3, &cat(&[text(1, key), len(2, &len(1, &stroke))]))
    }

    /// A stroke entry built from ready-made point records (see [`point`]).
    pub fn stroke_points(key: &str, secs: u64, points: &[Vec<u8>]) -> Vec<u8> {
        let mut path = Vec::new();
        for p in points {
            path.extend(len(2, p));
        }
        path.extend(ts(3, secs));
        let stroke = cat(&[len(2, &uint(1, 1)), len(4, &path)]);
        len(3, &cat(&[text(1, key), len(2, &len(1, &stroke))]))
    }

    /// A point record with a nib and intermediate points (field 11).
    pub fn point(x: f64, y: f64, nib: f64, inter: &[(f64, f64)]) -> Vec<u8> {
        let mut p = cat(&[xy(1, x, y), len(3, &f64f(1, nib))]);
        for &(ix, iy) in inter {
            p.extend(len(11, &cat(&[f64f(1, ix), f64f(2, iy)])));
        }
        p
    }

    /// A stroke whose path is a shape record `{1: kind, 2: packed f64 coordinates, 3: nib}`.
    pub fn shape_stroke(key: &str, secs: u64, kind: u64, coords: &[f64]) -> Vec<u8> {
        let packed: Vec<u8> = coords.iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut path = len(4, &cat(&[uint(1, kind), len(2, &packed), f64f(3, 3.0)]));
        path.extend(ts(3, secs));
        let ink = cat(&[uint(1, 1), uint(2, 0x0000_00FF)]);
        let stroke = cat(&[len(2, &ink), len(4, &path)]);
        len(3, &cat(&[text(1, key), len(2, &len(1, &stroke))]))
    }

    /// A stroke entry with a junk sub-message nested `depth` levels deep inside its path.
    pub fn deep_stroke(key: &str, depth: usize) -> Vec<u8> {
        let mut junk = uint(1, 1);
        for _ in 0..depth {
            junk = len(1, &junk);
        }
        let path = cat(&[len(2, &xy(1, 1.0, 1.0)), len(9, &junk)]);
        let stroke = cat(&[len(2, &uint(1, 1)), len(4, &path)]);
        len(3, &cat(&[text(1, key), len(2, &len(1, &stroke))]))
    }

    /// Sets the encryption flag in the central-directory record of entry `name` only.
    pub fn flag_encrypted(bytes: &mut [u8], name: &str) {
        let mut i = 0;
        while i + 46 < bytes.len() {
            if bytes[i..i + 4] == *b"PK\x01\x02" {
                let n = u16::from_le_bytes([bytes[i + 28], bytes[i + 29]]) as usize;
                if bytes.get(i + 46..i + 46 + n) == Some(name.as_bytes()) {
                    bytes[i + 8] |= 1;
                }
            }
            i += 1;
        }
    }

    /// Optional extras for the first note: outline entries `(id, parent, page, title)` and a
    /// page size for `layout.dat`.
    #[derive(Default)]
    pub struct Extras {
        pub outline: Vec<(&'static str, &'static str, &'static str, &'static str)>,
        pub size: Option<(f64, f64)>,
    }

    pub fn files(spec: &Spec) -> Vec<(String, Vec<u8>)> {
        files_with(spec, &Extras::default())
    }

    fn frame(x: f64, y: f64, w: f64, h: f64) -> Vec<u8> {
        len(4, &cat(&[xy(1, x, y), xy(2, w, h)]))
    }

    /// A text object entry (`field 4`); `holder` is the field the text holder sits in (6 or 10).
    pub fn text_object(
        key: &str,
        secs: u64,
        holder: u32,
        s: &str,
        x: f64,
        y: f64,
        w: f64,
    ) -> Vec<u8> {
        let rich = text(1, s);
        let obj = cat(&[
            ts(3, secs),
            frame(x, y, w, 40.0),
            len(holder, &len(6, &rich)),
        ]);
        len(4, &cat(&[text(1, key), len(2, &len(1, &obj))]))
    }

    pub fn image_object(key: &str, secs: u64, id: &str, x: f64, y: f64, w: f64, h: f64) -> Vec<u8> {
        let obj = cat(&[ts(3, secs), frame(x, y, w, h), len(7, &text(1, id))]);
        len(4, &cat(&[text(1, key), len(2, &len(1, &obj))]))
    }

    pub struct Layer {
        pub id: &'static str,
        pub content_id: &'static str,
        pub position: u64,
        pub visible: bool,
        pub entries: Vec<Vec<u8>>,
    }

    pub struct Page {
        pub id: &'static str,
        pub content_id: &'static str,
        pub entries: Vec<Vec<u8>>,
        pub layers: Vec<Layer>,
    }

    pub struct Note {
        pub dir: &'static str,
        pub title: Option<&'static str>,
        pub sketch: bool,
        pub pages: Vec<Page>,
        pub images: Vec<(&'static str, Vec<u8>)>,
    }

    pub struct Spec {
        pub notes: Vec<Note>,
    }

    /// The raw (name, bytes) entries of the zip.
    pub fn files_with(spec: &Spec, extras: &Extras) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for (ni, n) in spec.notes.iter().enumerate() {
            let d = n.dir;
            let mut body = Vec::new();
            let mut layout = Vec::new();
            let mut layer_info = Vec::new();
            let (w, h) = extras.size.filter(|_| ni == 0).unwrap_or((540.0, 720.0));
            for (i, p) in n.pages.iter().enumerate() {
                let mut page = cat(&[text(1, p.id), uint(3, i as u64), text(6, p.content_id)]);
                for l in &p.layers {
                    page.extend(len(10, &cat(&[text(1, l.id), text(2, l.content_id)])));
                    layer_info.extend(len(
                        3,
                        &cat(&[
                            text(1, l.id),
                            uint(5, u64::from(l.visible)),
                            uint(6, l.position),
                        ]),
                    ));
                }
                body.extend(len(1, &page));
                layout.extend(len(
                    3,
                    &cat(&[text(5, p.id), len(1, &cat(&[f64f(1, w), f64f(2, h)]))]),
                ));
                out.push((
                    format!("{d}/FNPages/{}", p.content_id),
                    p.entries.iter().flatten().copied().collect(),
                ));
                for l in &p.layers {
                    out.push((
                        format!("{d}/FNPages/{}", l.content_id),
                        l.entries.iter().flatten().copied().collect(),
                    ));
                }
            }
            if ni == 0 {
                for (id, parent, page, title) in &extras.outline {
                    body.extend(len(
                        4,
                        &cat(&[text(1, id), text(2, parent), text(3, page), text(4, title)]),
                    ));
                }
            }
            let mut doc = text(2, "doc");
            if n.sketch {
                doc.extend(uint(3, 1));
            }
            doc.extend(len(4, &body));
            out.push((format!("{d}/document.dat"), doc));
            out.push((format!("{d}/layout.dat"), layout));
            out.push((format!("{d}/layerInfo.dat"), layer_info));
            if let Some(t) = n.title {
                out.push((
                    format!("{d}/metadata.dat"),
                    cat(&[text(1, "id"), text(3, t)]),
                ));
            }
            for (name, bytes) in &n.images {
                out.push((format!("{d}/Images/{name}"), bytes.clone()));
            }
        }
        out
    }

    pub fn zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in files {
            w.start_file(name.as_str(), opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    pub fn build(spec: &Spec) -> Vec<u8> {
        zip(&files(spec))
    }
}

use freenotes_fixture as fx;

const BLUE: u32 = 0x0000_FFFF;
const RED: u32 = 0xFF00_00FF;
const YELLOW_HALF: u32 = 0xFFFF_0080;

fn line(y: f64) -> Vec<(f64, f64)> {
    vec![(10.0, y), (30.0, y), (50.0, y), (70.0, y)]
}

fn simple_page(id: &'static str, content: &'static str, dy: f64) -> fx::Page {
    fx::Page {
        id,
        content_id: content,
        entries: vec![
            fx::stroke("s1", 1, 1, Some(BLUE), Some(3.0), &line(20.0 + dy)),
            fx::stroke("s2", 2, 1, Some(RED), Some(3.5), &line(40.0 + dy)),
            fx::stroke("s3", 3, 2, Some(YELLOW_HALF), Some(8.0), &line(60.0 + dy)),
            fx::text_object("o1", 4, 6, "Hello", 50.0, 100.0 + dy, 200.0),
            fx::image_object("o2", 5, "img1", 50.0, 300.0 + dy, 100.0, 50.0),
        ],
        layers: vec![],
    }
}

fn basic_spec() -> fx::Spec {
    fx::Spec {
        notes: vec![fx::Note {
            dir: "Fixture.frnote",
            title: Some("Fixture"),
            sketch: false,
            pages: vec![
                simple_page("P1", "C1", 0.0),
                simple_page("P2", "C2", 100.0),
                fx::Page {
                    id: "P3",
                    content_id: "C3",
                    entries: vec![],
                    layers: vec![],
                },
            ],
            images: vec![("img1.png", PNG.to_vec())],
        }],
    }
}

fn run(bytes: &[u8]) -> Result<ImportDocument, ImportError> {
    parse(bytes, "x.freenotes", &ImportLimits::default())
}

#[test]
fn freenotes_basic_content() {
    let doc = run(&fx::build(&basic_spec())).unwrap();
    assert_eq!(doc.source, ImportSource::Freenotes);
    assert_eq!(doc.title, "Fixture");
    assert_eq!(doc.default_page_mode, PageMode::Page);
    assert_eq!(doc.sections.len(), 1);
    let pages = &doc.sections[0].pages;
    assert_eq!(pages.len(), 3);
    assert!(pages.iter().all(|p| p.width == 540.0 && p.height == 720.0));
    assert_eq!(
        pages
            .iter()
            .map(|p| p.source_id.as_str())
            .collect::<Vec<_>>(),
        ["P1", "P2", "P3"]
    );

    let p = &pages[0];
    let colors: Vec<&str> = p.strokes.iter().map(|s| s.color.as_str()).collect();
    assert_eq!(colors, ["#0000ff", "#ff0000", "#ffff00"]);
    let widths: Vec<f64> = p.strokes.iter().map(|s| s.width).collect();
    assert_eq!(widths, [2.0, 3.0, 12.0]);
    let opacity: Vec<f64> = p.strokes.iter().map(|s| s.opacity).collect();
    assert_eq!(opacity, [1.0, 1.0, 0.5]);
    assert_eq!(
        p.strokes
            .iter()
            .map(|s| s.is_highlighter)
            .collect::<Vec<_>>(),
        [false, false, true]
    );
    assert_eq!(p.strokes[0].pen_style, PenStyle::Pen);
    assert_eq!(p.strokes[2].pen_style, PenStyle::Highlighter);
    assert_eq!(p.strokes[0].points.len(), 4);
    assert_eq!(
        (p.strokes[0].points[0].x, p.strokes[0].points[0].y),
        (10.0, 20.0)
    );
    assert!(
        p.strokes[0]
            .points
            .iter()
            .all(|pt| pt.pressure == Some(1.0))
    );
    // s1 < s2 < s3 < o1 < o2 over five items: -5 .. -1.
    assert_eq!(
        p.strokes.iter().map(|s| s.z_index).collect::<Vec<_>>(),
        [-5, -4, -3]
    );

    assert_eq!(p.texts.len(), 1);
    assert_eq!(p.texts[0].text, "Hello");
    assert_eq!(
        (p.texts[0].x, p.texts[0].y, p.texts[0].width),
        (50.0, 100.0, Some(200.0))
    );
    assert_eq!(p.images.len(), 1);
    let im = &p.images[0];
    assert_eq!(
        (im.x, im.y, im.width, im.height),
        (50.0, 300.0, 100.0, 50.0)
    );
    assert_eq!(im.bytes, PNG);
    assert_eq!(im.mime.as_deref(), Some("image/png"));

    let p2 = &pages[1];
    assert_eq!(p2.strokes[0].points[0].y, 120.0);
    assert_eq!((p2.texts.len(), p2.images.len()), (1, 1));
    assert!(pages[2].strokes.is_empty() && pages[2].texts.is_empty() && pages[2].images.is_empty());
}

#[test]
fn freenotes_layers_order_and_pencil_alpha() {
    let page = fx::Page {
        id: "P1",
        content_id: "C1",
        entries: vec![
            // Written last (t = 10) but on the page's own content, so layer 0.
            fx::stroke("a", 10, 1, Some(BLUE), Some(3.0), &line(20.0)),
            // Pencil: ink type 3, no colour; nib 2 gives a drawn width below 1, clamped to 1.
            fx::stroke("p", 11, 3, None, Some(2.0), &line(30.0)),
        ],
        layers: vec![
            fx::Layer {
                id: "L2",
                content_id: "X2",
                position: 5,
                visible: true,
                entries: vec![fx::stroke("d", 1, 1, Some(RED), Some(3.0), &line(50.0))],
            },
            fx::Layer {
                id: "L1",
                content_id: "X1",
                position: 1,
                visible: true,
                entries: vec![
                    fx::stroke("c", 9, 1, Some(RED), Some(3.0), &line(40.0)),
                    fx::stroke("b", 2, 1, Some(RED), Some(3.0), &line(45.0)),
                ],
            },
            fx::Layer {
                id: "L3",
                content_id: "X3",
                position: 3,
                visible: false,
                entries: vec![fx::stroke("h", 1, 1, Some(RED), Some(3.0), &line(55.0))],
            },
        ],
    };
    let spec = fx::Spec {
        notes: vec![fx::Note {
            dir: "N.frnote",
            title: None,
            sketch: true,
            pages: vec![page],
            images: vec![],
        }],
    };
    let doc = run(&fx::build(&spec)).unwrap();
    assert_eq!(doc.default_page_mode, PageMode::Canvas);
    // No metadata: the title falls back to the directory name.
    assert_eq!(doc.title, "N");
    let strokes = &doc.sections[0].pages[0].strokes;
    // Layer 0 (a, p by time), layer 1 = position 1 (b, c by time), layer 2 = position 5 (d);
    // the hidden layer's stroke is dropped.
    let ys: Vec<f64> = strokes.iter().map(|s| s.points[0].y).collect();
    assert_eq!(ys, [20.0, 30.0, 45.0, 40.0, 50.0]);
    assert_eq!(
        strokes.iter().map(|s| s.z_index).collect::<Vec<_>>(),
        [-5, -4, -3, -2, -1]
    );

    let pencil = &strokes[1];
    assert_eq!(pencil.pen_style, PenStyle::Pencil);
    assert_eq!(pencil.opacity, 0.39);
    assert!(!pencil.is_highlighter);
    assert_eq!(pencil.color, "#000000");
    // Drawn width = max(1, 2 * nib - 4): nib 2 would give 0, clamped to 1.
    assert_eq!(pencil.width, 1.0);
    assert_eq!(strokes[0].opacity, 1.0);
    assert_eq!(strokes[0].width, 2.0);
}

#[test]
fn freenotes_highlighter_rule_and_eraser() {
    let page = fx::Page {
        id: "P1",
        content_id: "C1",
        entries: vec![
            // Type 4 (tape) is a highlighter whatever the alpha.
            fx::stroke("a", 1, 4, Some(0x00FF_00FF), Some(5.0), &line(10.0)),
            // No type match, alpha 0x40 / 255 < 0.6: highlighter.
            fx::stroke("b", 2, 1, Some(0xFF00_0040), Some(5.0), &line(20.0)),
            // Alpha 0x99 / 255 = 0.6: a plain pen.
            fx::stroke("c", 3, 1, Some(0xFF00_0099), Some(5.0), &line(30.0)),
            // Eraser: dropped and counted.
            fx::stroke("e", 4, 101, Some(BLUE), Some(5.0), &line(40.0)),
            // A text in the `.10` holder and an image with no asset.
            fx::text_object("t", 5, 10, "World", 50.0, 200.0, 0.0),
            fx::image_object("i", 6, "missing", 0.0, 0.0, 10.0, 10.0),
        ],
        layers: vec![],
    };
    let spec = fx::Spec {
        notes: vec![fx::Note {
            dir: "N.frnote",
            title: Some("T"),
            sketch: false,
            pages: vec![page],
            images: vec![],
        }],
    };
    let doc = run(&fx::build(&spec)).unwrap();
    let p = &doc.sections[0].pages[0];
    assert_eq!(p.strokes.len(), 3);
    assert_eq!(
        p.strokes
            .iter()
            .map(|s| (s.is_highlighter, s.opacity))
            .collect::<Vec<_>>(),
        [(true, 0.5), (true, 0.5), (false, 1.0)]
    );
    assert_eq!(p.strokes[1].color, "#ff0000");
    assert_eq!(p.texts.len(), 1);
    assert_eq!(p.texts[0].text, "World");
    assert_eq!(p.texts[0].width, None);
    assert!(p.images.is_empty());
    assert_eq!(p.skipped.other, 2);
}

#[test]
fn freenotes_encrypted_is_refused_readably() {
    let mut bytes = fx::build(&basic_spec());
    // Set general-purpose flag bit 0 (encrypted) in every local and central header.
    let mut i = 0;
    while i + 10 < bytes.len() {
        if bytes[i..i + 4] == *b"PK\x03\x04" {
            bytes[i + 6] |= 1;
        } else if bytes[i..i + 4] == *b"PK\x01\x02" {
            bytes[i + 8] |= 1;
        }
        i += 1;
    }
    let err = run(&bytes).unwrap_err();
    assert_eq!(err, ImportError::Encrypted);
    let msg = err.to_string();
    assert!(
        msg.contains("password-protected or encrypted") && msg.ends_with('.'),
        "{msg}"
    );
}

#[test]
fn freenotes_backup_container_lists_notes() {
    let note = |dir: &'static str, title: &'static str, id: &'static str| fx::Note {
        dir,
        title: Some(title),
        sketch: false,
        pages: vec![fx::Page {
            id,
            content_id: "C",
            entries: vec![fx::stroke("s", 1, 1, Some(BLUE), Some(3.0), &line(20.0))],
            layers: vec![],
        }],
        images: vec![],
    };
    // Listed out of order: the notes are sorted by directory name.
    let spec = fx::Spec {
        notes: vec![
            note("b.frnote", "Second", "PB"),
            note("a.frnote", "First", "PA"),
        ],
    };
    let doc = run(&fx::build(&spec)).unwrap();
    // One document, one section per note.
    assert_eq!(doc.sections.len(), 2);
    assert_eq!(doc.title, "Freenotes backup");
    assert_eq!(doc.sections[0].title, "First");
    assert_eq!(doc.sections[1].title, "Second");
    assert_eq!(doc.sections[0].pages[0].source_id, "PA");
    assert_eq!(doc.sections[1].pages[0].strokes.len(), 1);
    assert_eq!(doc.page_count(), 2);
}

#[test]
fn freenotes_without_a_note_bundle_is_corrupt() {
    let z = fx::zip(&[("page1.pb".to_string(), vec![])]);
    assert!(matches!(run(&z), Err(ImportError::Corrupt(_))));
}

#[test]
fn freenotes_truncated_file_is_corrupt_not_panic() {
    let bytes = fx::build(&basic_spec());
    assert!(run(&bytes).is_ok());
    for k in 0..60usize {
        let cut = 50 + k * (bytes.len() - 51) / 59;
        let r = run(&bytes[..cut]);
        assert!(r.is_err(), "cut at {cut} of {} parsed", bytes.len());
    }
    assert!(bytes.len() < 200 * 1024);

    // Damaged inner records (a valid zip around them): never a panic.
    let files = fx::files(&basic_spec());
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let (mut ok, mut err) = (0, 0);
    for _ in 0..300 {
        let mut f = files.clone();
        let target = (next() % f.len() as u64) as usize;
        let data = &mut f[target].1;
        if data.is_empty() {
            continue;
        }
        for _ in 0..(1 + next() % 3) {
            let at = (next() % data.len() as u64) as usize;
            data[at] = next() as u8;
        }
        if next() % 4 == 0 {
            let keep = (next() % data.len() as u64) as usize;
            data.truncate(keep);
        }
        match run(&fx::zip(&f)) {
            Ok(_) => ok += 1,
            Err(_) => err += 1,
        }
    }
    assert!(ok + err > 0 && err > 0, "ok {ok}, err {err}");
}

fn one_page_spec(entries: Vec<Vec<u8>>) -> fx::Spec {
    fx::Spec {
        notes: vec![fx::Note {
            dir: "N.frnote",
            title: Some("T"),
            sketch: false,
            pages: vec![fx::Page {
                id: "P1",
                content_id: "C1",
                entries,
                layers: vec![],
            }],
            images: vec![],
        }],
    }
}

#[test]
fn freenotes_deep_nesting_is_not_followed() {
    // The schema never descends 70 levels, so a junk sub-message that deep is never decoded:
    // no recursion, no stack overflow, the stroke is still imported.
    let spec = one_page_spec(vec![fx::deep_stroke("d", 70)]);
    let doc = run(&fx::build(&spec)).unwrap();
    assert_eq!(doc.sections[0].pages[0].strokes.len(), 1);
}

#[test]
fn freenotes_encryption_flag_is_checked_before_reading() {
    let mut files = fx::files(&basic_spec());
    files.push(("Fixture.frnote/Records/a.m4a".into(), vec![1, 2, 3]));
    let mut bytes = fx::zip(&files);
    assert!(run(&bytes).is_ok());
    fx::flag_encrypted(&mut bytes, "Fixture.frnote/Records/a.m4a");
    assert_eq!(run(&bytes).unwrap_err(), ImportError::Encrypted);
}

#[test]
fn freenotes_shapes_become_closed_polylines() {
    let spec = one_page_spec(vec![
        fx::shape_stroke("a", 1, 1001, &[0.0, 0.0, 10.0, 0.0, 10.0, 10.0]),
        fx::shape_stroke("b", 2, 2001, &[0.0, 0.0, 10.0, 0.0, 10.0, 5.0, 0.0, 5.0]),
        fx::shape_stroke("c", 3, 2004, &[0.0, 0.0, 10.0, 0.0, 5.0, 8.0]),
        fx::shape_stroke("d", 4, 2002, &[0.0, 0.0, 100.0, 50.0]),
        fx::shape_stroke("e", 5, 2003, &[10.0, 10.0, 5.0]),
        fx::shape_stroke("f", 6, 2002, &[1.0]),
    ]);
    let doc = run(&fx::build(&spec)).unwrap();
    let p = &doc.sections[0].pages[0];
    assert_eq!(p.strokes.len(), 5);
    assert_eq!(p.skipped.shapes, 1);
    let n: Vec<usize> = p.strokes.iter().map(|s| s.points.len()).collect();
    assert_eq!(n, [3, 5, 4, 36, 36]);
    for s in &p.strokes[1..] {
        let (a, b) = (s.points.first().unwrap(), s.points.last().unwrap());
        assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9);
    }
    // Ellipse inside its bounding box (0, 0, 100, 50).
    for pt in &p.strokes[3].points {
        assert!(pt.x >= -1e-9 && pt.x <= 100.0 + 1e-9 && pt.y >= -1e-9 && pt.y <= 50.0 + 1e-9);
    }
    // Shape nib 3 gives the drawn width 2.
    assert_eq!(p.strokes[0].width, 2.0);
}

#[test]
fn freenotes_layout_sizes_intermediate_points_and_outline_titles() {
    let spec = fx::Spec {
        notes: vec![fx::Note {
            dir: "N.frnote",
            title: Some("T"),
            sketch: false,
            pages: vec![
                fx::Page {
                    id: "P1",
                    content_id: "C1",
                    entries: vec![fx::stroke_points(
                        "s",
                        1,
                        &[
                            fx::point(10.0, 10.0, 3.0, &[(5.0, 5.0), (10.0, 10.0)]),
                            fx::point(20.0, 20.0, 3.0, &[(15.0, 15.0)]),
                        ],
                    )],
                    layers: vec![],
                },
                fx::Page {
                    id: "P2",
                    content_id: "C2",
                    entries: vec![],
                    layers: vec![],
                },
            ],
            images: vec![],
        }],
    };
    let extras = fx::Extras {
        outline: vec![("o1", "", "P1", "Chapter"), ("o2", "o1", "P1", "Sub")],
        size: Some((1000.0, 500.0)),
    };
    let doc = run(&fx::zip(&fx::files_with(&spec, &extras))).unwrap();
    let pages = &doc.sections[0].pages;
    assert!(pages.iter().all(|p| p.width == 1000.0 && p.height == 500.0));
    // Shallowest outline entry wins; a page without one is "Page n".
    assert_eq!(pages[0].title.as_deref(), Some("Chapter"));
    assert_eq!(pages[1].title.as_deref(), Some("Page 2"));
    // Intermediate points come before their point; the one equal to the point is dropped.
    let xs: Vec<f64> = pages[0].strokes[0].points.iter().map(|p| p.x).collect();
    assert_eq!(xs, [5.0, 10.0, 15.0, 20.0]);
}

#[test]
fn freenotes_pages_over_the_limit_are_counted() {
    let limits = ImportLimits {
        max_pages: 2,
        ..ImportLimits::default()
    };
    let doc = parse(&fx::build(&basic_spec()), "x.freenotes", &limits).unwrap();
    assert_eq!(doc.page_count(), 2);
    assert_eq!(doc.sections[0].pages[1].skipped.other, 1);
}

#[test]
fn freenotes_unusable_strokes_are_counted() {
    let spec = one_page_spec(vec![
        fx::stroke("empty", 1, 1, Some(BLUE), Some(3.0), &[]),
        fx::stroke("ok", 2, 1, Some(BLUE), Some(3.0), &line(10.0)),
    ]);
    let doc = run(&fx::build(&spec)).unwrap();
    let p = &doc.sections[0].pages[0];
    assert_eq!(p.strokes.len(), 1);
    assert_eq!(p.skipped.other, 1);
}
