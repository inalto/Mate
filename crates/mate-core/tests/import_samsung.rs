//! Samsung Notes importer (best effort): container detection, stroke decoding, page ids,
//! image placement and damaged files. Fixtures are built in memory by `samsung_fixture`,
//! following docs/analysis/05-import-formats.md section 7.4.

use mate_core::import::{ImportDocument, ImportError, ImportLimits, ImportSource, parse, sniff};
use mate_core::model::{PageMode, PenStyle};

const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1,
];

mod samsung_fixture {
    use std::io::{Cursor, Write};

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    pub enum Style {
        /// Pen: colour `[r, g, b]`, raw width (the importer halves it).
        Pen([u8; 3], f32),
        Highlighter([u8; 3], f32),
    }

    pub struct StrokeSpec {
        pub points: Vec<(f64, f64)>,
        /// Pressure magnitudes, one per point (each is added to the running sum).
        pub pressure: Vec<u8>,
        pub style: Style,
    }

    pub struct PageSpec {
        pub id: String,
        pub strokes: Vec<StrokeSpec>,
    }

    pub struct Spec {
        pub note_width: u32,
        pub note_height: u32,
        pub flags: u32,
        pub pages: Vec<PageSpec>,
        /// `(media index, file name, bytes, bbox)` of images placed in `note.note`.
        pub images: Vec<(u32, String, Vec<u8>, [f64; 4])>,
        /// A placement whose media index is not in `mediaInfo.dat`.
        pub dangling_placement: bool,
    }

    fn put_u32(buf: &mut [u8], off: usize, v: u32) {
        buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
    }

    fn delta(prev: f64, next: f64) -> [u8; 2] {
        let steps = ((next - prev) * 32.0).round();
        assert!(steps.abs() <= 255.0, "delta too large for one step");
        [steps.abs() as u8, if steps < 0.0 { 0x80 } else { 0 }]
    }

    fn stroke_record(s: &StrokeSpec) -> Vec<u8> {
        let n = s.points.len();
        assert_eq!(s.pressure.len(), n);
        let data_len = 4 * (n - 1) + 4 + 2 * n + 14;
        let mut rec = vec![0u8; 32 + 57];
        let t = 32;
        rec[t + 21..t + 25].copy_from_slice(&(data_len as u32).to_le_bytes());
        rec[t + 39..t + 41].copy_from_slice(&(n as u16).to_le_bytes());
        rec[t + 41..t + 49].copy_from_slice(&s.points[0].0.to_le_bytes());
        rec[t + 49..t + 57].copy_from_slice(&s.points[0].1.to_le_bytes());
        for w in s.points.windows(2) {
            let dx = delta(w[0].0, w[1].0);
            let dy = delta(w[0].1, w[1].1);
            rec.extend_from_slice(&[dx[0], dx[1], dy[0], dy[1]]);
        }
        rec.extend_from_slice(&[0; 4]);
        for &m in &s.pressure {
            rec.extend_from_slice(&[m, 0]);
        }
        let (kind, rgb, flag, width) = match s.style {
            Style::Pen(rgb, w) => (1u8, rgb, 0xFFu8, w),
            Style::Highlighter(rgb, w) => (3u8, rgb, 0x00u8, w),
        };
        // `[2|3, 0, 1|3, 0, 0, 0]`, then B, G, R, flag, f32 width.
        rec.extend_from_slice(&[if kind == 3 { 3 } else { 2 }, 0, kind, 0, 0, 0]);
        rec.extend_from_slice(&[rgb[2], rgb[1], rgb[0], flag]);
        rec.extend_from_slice(&width.to_le_bytes());
        rec.extend_from_slice(&[0; 71]);
        rec
    }

    pub fn page_bytes(spec: &Spec, page: &PageSpec) -> Vec<u8> {
        let mut buf = vec![0u8; 281];
        put_u32(&mut buf, 0, 100);
        put_u32(&mut buf, 22, spec.note_width);
        put_u32(&mut buf, 26, spec.note_height);
        put_u32(&mut buf, 202, page.strokes.len() as u32);
        for s in &page.strokes {
            buf.extend_from_slice(&stroke_record(s));
        }
        buf
    }

    pub fn note_bytes(spec: &Spec) -> Vec<u8> {
        let mut buf = vec![0u8; 48];
        put_u32(&mut buf, 4, spec.flags);
        put_u32(&mut buf, 40, spec.note_width);
        put_u32(&mut buf, 44, spec.note_height);
        let mut placements: Vec<(u32, [f64; 4])> =
            spec.images.iter().map(|(i, _, _, b)| (*i, *b)).collect();
        if spec.dangling_placement {
            placements.push((99, [1.0, 2.0, 11.0, 12.0]));
        }
        for (index, bbox) in placements {
            let t = buf.len();
            buf.resize(t + 140, 0);
            buf[t..t + 4].copy_from_slice(&[1, 0, 4, 32]);
            for (k, v) in bbox.iter().enumerate() {
                buf[t + 11 + 8 * k..t + 19 + 8 * k].copy_from_slice(&v.to_le_bytes());
            }
            buf[t + 131..t + 135].copy_from_slice(&index.to_le_bytes());
        }
        buf
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    pub fn page_id_bytes(spec: &Spec) -> Vec<u8> {
        let mut buf = vec![0u8; 32];
        buf.extend_from_slice(&(spec.pages.len() as u16).to_le_bytes());
        for p in &spec.pages {
            buf.extend_from_slice(&(p.id.encode_utf16().count() as u16).to_le_bytes());
            buf.extend_from_slice(&utf16(&p.id));
        }
        buf
    }

    pub fn media_info_bytes(spec: &Spec) -> Vec<u8> {
        let mut buf = vec![0u8; 4];
        buf.extend_from_slice(&(spec.images.len() as u16).to_le_bytes());
        for (index, name, _, _) in &spec.images {
            let n = utf16(name);
            buf.extend_from_slice(&((4 + 2 + n.len()) as u32).to_le_bytes());
            buf.extend_from_slice(&index.to_le_bytes());
            buf.extend_from_slice(&((n.len() / 2) as u16).to_le_bytes());
            buf.extend_from_slice(&n);
        }
        buf
    }

    /// The zip entries `(name, bytes)` of `spec`.
    pub fn parts(spec: &Spec) -> Vec<(String, Vec<u8>)> {
        let mut parts = vec![
            ("note.note".to_owned(), note_bytes(spec)),
            ("pageIdInfo.dat".to_owned(), page_id_bytes(spec)),
        ];
        for p in &spec.pages {
            parts.push((format!("{}.page", p.id), page_bytes(spec, p)));
        }
        if !spec.images.is_empty() {
            parts.push(("media/mediaInfo.dat".to_owned(), media_info_bytes(spec)));
            for (_, name, bytes, _) in &spec.images {
                parts.push((format!("media/{name}"), bytes.clone()));
            }
        }
        parts
    }

    pub fn zip_parts(parts: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut w = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, data) in parts {
            w.start_file(name.as_str(), opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    pub fn build(spec: &Spec) -> Vec<u8> {
        zip_parts(&parts(spec))
    }

    fn line(y: f64, rgb: [u8; 3], pen: bool, raw_width: f32) -> StrokeSpec {
        StrokeSpec {
            points: (0..4).map(|i| (10.0 + 5.0 * f64::from(i), y)).collect(),
            pressure: vec![175; 4],
            style: if pen { Style::Pen(rgb, raw_width) } else { Style::Highlighter(rgb, raw_width) },
        }
    }

    /// The `samsung_basic` fixture: three pages of 720 x 1018; pages 1 and 2 hold strokes A (pen,
    /// `#0000ff`, raw width 4), B (pen, `#ff0000`, raw width 6) and C (highlighter, `#ffff00`,
    /// width 12); page 3 is empty; one image placed on page 1.
    pub fn basic() -> Spec {
        let strokes = |dy: f64| {
            vec![
                line(20.0 + dy, [0, 0, 255], true, 4.0),
                line(40.0 + dy, [255, 0, 0], true, 6.0),
                line(60.0 + dy, [255, 255, 0], false, 12.0),
            ]
        };
        Spec {
            note_width: 720,
            note_height: 1018,
            flags: 0,
            pages: vec![
                PageSpec { id: "p1".into(), strokes: strokes(0.0) },
                PageSpec { id: "p2".into(), strokes: strokes(100.0) },
                PageSpec { id: "p3".into(), strokes: vec![] },
            ],
            images: vec![(1, "img1.png".into(), super::PNG.to_vec(), [50.0, 300.0, 150.0, 350.0])],
            dangling_placement: false,
        }
    }
}

fn limits() -> ImportLimits {
    ImportLimits::default()
}

fn import(spec: &samsung_fixture::Spec) -> ImportDocument {
    parse(&samsung_fixture::build(spec), "notes.sdocx", &limits()).expect("fixture parses")
}

#[test]
fn samsung_detects_container() {
    let bytes = samsung_fixture::build(&samsung_fixture::basic());
    assert!(bytes.len() < 200 * 1024);
    assert_eq!(sniff(&bytes, "notes.sdocx"), Ok(ImportSource::SamsungNotes));
    assert_eq!(sniff(&bytes, "whatever.zip"), Ok(ImportSource::SamsungNotes));
    assert_eq!(import(&samsung_fixture::basic()).source, ImportSource::SamsungNotes);
}

#[test]
fn samsung_fixture_parses_strokes() {
    let doc = import(&samsung_fixture::basic());
    assert_eq!(doc.default_page_mode, PageMode::Page);
    assert_eq!(doc.sections.len(), 1);
    let pages = &doc.sections[0].pages;
    assert_eq!(pages.len(), 3);
    assert_eq!(pages.iter().map(|p| p.strokes.len()).collect::<Vec<_>>(), vec![3, 3, 0]);
    for p in pages {
        assert_eq!((p.width, p.height), (720.0, 1018.0));
        assert!(p.texts.is_empty());
    }

    let a = &pages[0].strokes[0];
    let xy: Vec<(f64, f64)> = a.points.iter().map(|p| (p.x, p.y)).collect();
    assert_eq!(xy, vec![(10.0, 20.0), (15.0, 20.0), (20.0, 20.0), (25.0, 20.0)]);
    let pressures: Vec<f64> = a.points.iter().map(|p| p.pressure.unwrap()).collect();
    assert_eq!(pressures, vec![0.125, 0.25, 0.375, 0.5]);
    assert_eq!(a.color, "#0000ff");
    assert_eq!(a.width, 2.0);
    assert_eq!(a.opacity, 1.0);
    assert!(!a.is_highlighter);
    assert_eq!(a.pen_style, PenStyle::Pen);

    let b = &pages[0].strokes[1];
    assert_eq!((b.color.as_str(), b.width, b.opacity), ("#ff0000", 3.0, 1.0));
    assert_eq!(b.points[0].y, 40.0);

    let c = &pages[0].strokes[2];
    assert!(c.is_highlighter);
    assert_eq!(c.pen_style, PenStyle::Highlighter);
    assert_eq!((c.color.as_str(), c.width, c.opacity), ("#ffff00", 12.0, 0.5));

    // Page 2 is page 1 shifted down by 100.
    assert_eq!(pages[1].strokes[0].points[0].y, 120.0);
    // Paint order follows the source order.
    let z: Vec<i64> = pages[0].strokes.iter().map(|s| s.z_index).collect();
    assert_eq!(z, vec![0, 1, 2]);
}

#[test]
fn samsung_negative_deltas_dark_mode_and_missing_style() {
    let mut spec = samsung_fixture::basic();
    spec.flags = 0x800;
    spec.images.clear();
    spec.pages = vec![samsung_fixture::PageSpec {
        id: "only".into(),
        strokes: vec![samsung_fixture::StrokeSpec {
            points: vec![(100.0, 100.0), (95.0, 94.0), (96.0, 96.5)],
            pressure: vec![255, 255, 255],
            style: samsung_fixture::Style::Pen([1, 2, 3], 0.0),
        }],
    }];
    let doc = import(&spec);
    let s = &doc.sections[0].pages[0].strokes[0];
    let xy: Vec<(f64, f64)> = s.points.iter().map(|p| (p.x, p.y)).collect();
    assert_eq!(xy, vec![(100.0, 100.0), (95.0, 94.0), (96.0, 96.5)]);
    // A raw width of 0 falls back to the default pen width.
    assert_eq!(s.width, 4.0);

    // Damage the style block so the backward search fails: default colour (white in dark mode).
    let mut parts = samsung_fixture::parts(&spec);
    let page = &mut parts.iter_mut().find(|(n, _)| n == "only.page").unwrap().1;
    let len = page.len();
    // The style block starts 71 + 14 bytes before the end; break its leading pattern.
    page[len - 71 - 14] = 9;
    let doc = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits()).unwrap();
    let s = &doc.sections[0].pages[0].strokes[0];
    assert_eq!(s.color, "#ffffff");
}

#[test]
fn samsung_page_ids_from_pageidinfo() {
    let mut spec = samsung_fixture::basic();
    spec.images.clear();
    spec.pages = ["Seite-\u{e4}\u{f6}", "p2", "\u{65e5}\u{672c}"]
        .iter()
        .map(|id| samsung_fixture::PageSpec { id: (*id).to_owned(), strokes: vec![] })
        .collect();
    let doc = import(&spec);
    let pages = &doc.sections[0].pages;
    let ids: Vec<&str> = pages.iter().map(|p| p.source_id.as_str()).collect();
    assert_eq!(ids, vec!["Seite-\u{e4}\u{f6}", "p2", "\u{65e5}\u{672c}"]);
    let titles: Vec<Option<&str>> = pages.iter().map(|p| p.title.as_deref()).collect();
    assert_eq!(titles, vec![Some("Page 1"), Some("Page 2"), Some("Page 3")]);
    assert_eq!(doc.sections[0].source_id, "samsung-notes");
    assert!(!doc.sections[0].title.is_empty());
    assert_eq!(doc.page_count(), 3);

    // A page file that is listed but absent is left out; with none at all the file is corrupt.
    let mut parts = samsung_fixture::parts(&spec);
    parts.retain(|(n, _)| n != "p2.page");
    let doc = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits()).unwrap();
    assert_eq!(doc.page_count(), 2);
    parts.retain(|(n, _)| !n.ends_with(".page"));
    assert!(matches!(
        parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits()),
        Err(ImportError::Corrupt(_))
    ));
}

#[test]
fn samsung_image_placement_best_effort() {
    let doc = import(&samsung_fixture::basic());
    let pages = &doc.sections[0].pages;
    // The image lands on the first page with strokes; note and page sizes agree, so no rescale.
    assert_eq!(pages[0].images.len(), 1);
    assert!(pages[1].images.is_empty() && pages[2].images.is_empty());
    let img = &pages[0].images[0];
    assert_eq!((img.x, img.y, img.width, img.height), (50.0, 300.0, 100.0, 50.0));
    assert_eq!(img.bytes, PNG);
    assert_eq!(img.mime.as_deref(), Some("image/png"));
    assert_eq!(pages[0].skipped.other, 0);

    // A placement that names no media file is counted as skipped, not guessed.
    let mut spec = samsung_fixture::basic();
    spec.dangling_placement = true;
    let doc = import(&spec);
    assert_eq!(doc.sections[0].pages[0].images.len(), 1);
    assert_eq!(doc.sections[0].pages[0].skipped.other, 1);
}

#[test]
fn samsung_undecodable_strokes_are_counted() {
    let mut spec = samsung_fixture::basic();
    spec.images.clear();
    let mut parts = samsung_fixture::parts(&spec);
    let page = &mut parts.iter_mut().find(|(n, _)| n == "p1.page").unwrap().1;
    // Declare 5 strokes while only 3 exist: the 4th record runs past the end.
    page[202..206].copy_from_slice(&5u32.to_le_bytes());
    let doc = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits()).unwrap();
    let p = &doc.sections[0].pages[0];
    assert_eq!(p.strokes.len(), 3);
    assert_eq!(p.skipped.other, 2);
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

#[test]
fn samsung_truncated_file_is_corrupt_not_panic() {
    let spec = samsung_fixture::basic();
    let full = samsung_fixture::build(&spec);
    let total: usize = import(&spec).sections[0].pages.iter().map(|p| p.strokes.len()).sum();

    // Truncated zips.
    for i in 0..60 {
        let cut = full.len() * i / 60;
        if let Ok(doc) = parse(&full[..cut], "x.sdocx", &limits()) {
            let n: usize = doc.sections[0].pages.iter().map(|p| p.strokes.len()).sum();
            assert!(n <= total);
        }
    }

    // Truncated inner files, rezipped so the zip itself stays valid.
    let parts = samsung_fixture::parts(&spec);
    for (k, (name, data)) in parts.iter().enumerate() {
        if name.starts_with("media/img") {
            continue;
        }
        for i in 0..=50 {
            let mut damaged = parts.clone();
            damaged[k].1 = data[..data.len() * i / 50].to_vec();
            match parse(&samsung_fixture::zip_parts(&damaged), "x.sdocx", &limits()) {
                Ok(doc) => {
                    let n: usize = doc.sections[0].pages.iter().map(|p| p.strokes.len()).sum();
                    assert!(n <= total, "{name} cut at {i}/50");
                }
                Err(ImportError::Corrupt(_)) => {}
                Err(e) => panic!("{name} cut at {i}/50: {e:?}"),
            }
        }
    }

    // Corrupted inner bytes (fixed seed).
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for round in 0..400 {
        let mut damaged = parts.clone();
        for _ in 0..1 + rng.next() % 8 {
            let k = (rng.next() % damaged.len() as u64) as usize;
            let len = damaged[k].1.len();
            if len == 0 {
                continue;
            }
            let at = (rng.next() % len as u64) as usize;
            // Half the time hit the structural area near the front of the file.
            let at = if rng.next().is_multiple_of(2) { at % 400.min(len) } else { at };
            damaged[k].1[at] = rng.next() as u8;
        }
        match parse(&samsung_fixture::zip_parts(&damaged), "x.sdocx", &limits()) {
            Ok(doc) => {
                let n: usize = doc.sections[0].pages.iter().map(|p| p.strokes.len()).sum();
                assert!(n <= total + 8, "round {round}");
            }
            Err(ImportError::Corrupt(_) | ImportError::Limit(_)) => {}
            Err(e) => panic!("round {round}: {e:?}"),
        }
    }
}

#[test]
fn samsung_hostile_lengths_do_not_allocate_or_loop() {
    let mut spec = samsung_fixture::basic();
    spec.images.clear();
    let mut parts = samsung_fixture::parts(&spec);
    {
        let page = &mut parts.iter_mut().find(|(n, _)| n == "p1.page").unwrap().1;
        // Huge stroke count, huge dataLen and point count on the first stroke.
        page[202..206].copy_from_slice(&u32::MAX.to_le_bytes());
        let t = 281 + 32;
        page[t + 21..t + 25].copy_from_slice(&u32::MAX.to_le_bytes());
        page[t + 39..t + 41].copy_from_slice(&u16::MAX.to_le_bytes());
        // Header length near usize::MAX / 2^32.
        page[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
    }
    let r = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits());
    assert!(matches!(r, Err(ImportError::Corrupt(_))), "{r:?}");
}

#[test]
fn samsung_hostile_stroke_count_does_not_overflow() {
    let mut spec = samsung_fixture::basic();
    spec.dangling_placement = true;
    let mut parts = samsung_fixture::parts(&spec);
    let page = &mut parts.iter_mut().find(|(n, _)| n == "p1.page").unwrap().1;
    page[202..206].copy_from_slice(&u32::MAX.to_le_bytes());
    let doc = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits()).unwrap();
    let p = &doc.sections[0].pages[0];
    assert_eq!(p.strokes.len(), 3);
    // Bounded by what the buffer could hold, plus the one dangling placement.
    assert!(p.skipped.other >= 1 && p.skipped.other < 100, "{}", p.skipped.other);

    // No decodable stroke at all, count u32::MAX, plus an unresolvable placement.
    let page = &mut parts.iter_mut().find(|(n, _)| n == "p1.page").unwrap().1;
    page.truncate(281);
    let doc = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &limits()).unwrap();
    assert!(doc.sections[0].pages.iter().all(|p| p.skipped.other < 100));
}

#[test]
fn samsung_repeated_media_index_is_read_once() {
    let mut spec = samsung_fixture::basic();
    spec.images = vec![(1, "img1.png".into(), vec![7u8; 1 << 20], [50.0, 300.0, 150.0, 350.0])];
    let mut parts = samsung_fixture::parts(&spec);
    let note = &mut parts.iter_mut().find(|(n, _)| n == "note.note").unwrap().1;
    let first = note[48..48 + 140].to_vec();
    for k in 0..1000u32 {
        let mut rec = first.clone();
        // A distinct bbox per placement, same media index.
        rec[11 + 24..11 + 32].copy_from_slice(&(400.0 + f64::from(k)).to_le_bytes());
        note.extend_from_slice(&rec);
    }
    // 1 MiB x 1001 would need ~1 GiB; a budget of 8 MiB only passes if the file is read once.
    let lim = ImportLimits { max_unzipped_bytes: 8 << 20, ..limits() };
    let doc = parse(&samsung_fixture::zip_parts(&parts), "x.sdocx", &lim).unwrap();
    let p = &doc.sections[0].pages[0];
    assert_eq!(p.images.len(), 500);
    assert_eq!(p.skipped.other, 500);
}
