//! OneNote importer: unit/colour conversion, detection, damaged files, and the view → model
//! mapping. There is no `.one` encoder, so the mapping is exercised with hand-built views
//! (`onenote_adapter::*View`); a real file can be checked with the ignored smoke test by dropping
//! it at `docs/import-samples/sample.one` (local only, never committed).

use mate_core::import::onenote_adapter::{
    ImageView, InkView, OutlineView, PageView, SectionView, StrokeView, bgr_to_hex, from_sections,
    half_inch_to_px, himetric_to_px, ink_point_to_px, is_highlighter, mime_for_extension,
    pen_width_px,
};
use mate_core::import::{
    CAB_MAGIC, ImportError, ImportLimits, ImportSkipped, ImportSource, ONE_MAGIC, parse, sniff,
};
use mate_core::model::{PageMode, PenStyle};

const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1,
];

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn onenote_himetric_and_colour_conversion() {
    assert!(close(himetric_to_px(2540.0), 96.0));
    assert!(close(himetric_to_px(5080.0), 192.0));
    assert!(close(half_inch_to_px(2.0), 96.0));

    assert_eq!(bgr_to_hex(0x00FF_0000), "#0000ff");
    assert_eq!(bgr_to_hex(0x0000_00FF), "#ff0000");
    assert_eq!(bgr_to_hex(0x0000_FFFF), "#ffff00");
    assert_eq!(bgr_to_hex(0x0012_3456), "#563412");

    assert!(is_highlighter(Some(127)));
    assert!(is_highlighter(Some(100)));
    assert!(!is_highlighter(Some(128)));
    assert!(!is_highlighter(Some(200)));
    assert!(!is_highlighter(None));

    assert!(close(pen_width_px(254.0), 9.6), "{}", pen_width_px(254.0));
    assert!(close(pen_width_px(10.0), 1.0));
    assert!(close(pen_width_px(f64::NAN), 1.0));

    // Ink points get their container's half-inch offset.
    let (x, y) = ink_point_to_px(2540.0, 5080.0, 1.0, 2.0);
    assert!(close(x, 96.0 + 48.0) && close(y, 192.0 + 96.0), "{x} {y}");

    assert_eq!(mime_for_extension(".png"), Some("image/png"));
    assert_eq!(mime_for_extension("JPG"), Some("image/jpeg"));
    assert_eq!(mime_for_extension(".xyz"), None);
}

#[test]
fn onenote_magic_detection_one_and_onepkg() {
    assert_eq!(
        ONE_MAGIC,
        [
            0xE4, 0x52, 0x5C, 0x7B, 0x8C, 0xD8, 0xA7, 0x4D, 0xAE, 0xB1, 0x53, 0x78, 0xD0, 0x29,
            0x96, 0xD3
        ]
    );
    assert_eq!(CAB_MAGIC, b"MSCF");

    let mut one = ONE_MAGIC.to_vec();
    one.extend_from_slice(&[0; 64]);
    // By content, whatever the name says.
    assert_eq!(sniff(&one, "Section.one"), Ok(ImportSource::OneNote));
    assert_eq!(sniff(&one, "renamed.bin"), Ok(ImportSource::OneNote));
    let mut pkg = b"MSCF".to_vec();
    pkg.extend_from_slice(&[0; 64]);
    assert_eq!(sniff(&pkg, "Notebook.onepkg"), Ok(ImportSource::OneNote));
    // The extension alone is not enough.
    assert!(matches!(
        sniff(b"hello world", "x.one"),
        Err(ImportError::Unsupported(_))
    ));
    assert!(matches!(
        sniff(b"hello world", "x.onepkg"),
        Err(ImportError::Unsupported(_))
    ));

    // Detected files reach the OneNote parser (no longer "not available yet").
    assert!(matches!(
        parse(&one, "Section.one", &ImportLimits::default()),
        Err(ImportError::Corrupt(_))
    ));
    assert!(matches!(
        parse(&pkg, "Notebook.onepkg", &ImportLimits::default()),
        Err(ImportError::Corrupt(_))
    ));
}

/// A small deterministic generator (xorshift64*), so failures reproduce.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

/// A plausible-looking `.one` header: the magic, then a header-sized body of mostly zeros with
/// some small integers, which drives the parser further than pure noise.
fn fake_section(rng: &mut Rng, len: usize) -> Vec<u8> {
    let mut v = ONE_MAGIC.to_vec();
    while v.len() < len {
        let r = rng.next();
        v.push(if r.is_multiple_of(4) { (r >> 8) as u8 } else { 0 });
    }
    v.truncate(len.max(ONE_MAGIC.len()));
    v
}

fn assert_err_not_panic(bytes: &[u8], name: &str) {
    match parse(bytes, name, &ImportLimits::default()) {
        Err(ImportError::Corrupt(msg)) => assert!(!msg.is_empty()),
        Err(ImportError::Limit(_)) => {}
        Err(other) => panic!("{name} ({} bytes): unexpected error {other:?}", bytes.len()),
        Ok(doc) => {
            // Noise that happens to parse must still be a well-formed (empty) document.
            assert_eq!(doc.source, ImportSource::OneNote);
        }
    }
}

#[test]
fn onenote_truncated_file_is_corrupt_not_panic() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);

    // The bare magic, cut and extended at 60 lengths.
    let mut lengths: Vec<usize> = (16..=40).collect();
    lengths.extend([
        48, 64, 96, 128, 200, 256, 300, 400, 512, 600, 700, 768, 1000, 1024,
    ]);
    lengths.extend([
        1100, 1500, 2048, 3000, 4096, 5000, 8192, 10_000, 16_384, 20_000, 32_768,
    ]);
    lengths.extend([50_000, 65_536, 100_000, 131_072]);
    assert!(lengths.len() >= 50);
    for &len in &lengths {
        let section = fake_section(&mut rng, len);
        assert_err_not_panic(&section, "damaged.one");
        let mut noise = ONE_MAGIC.to_vec();
        noise.extend(rng.bytes(len.saturating_sub(16)));
        assert_err_not_panic(&noise, "noise.one");
    }

    // Seeded corruptions: flip bytes in a header-like buffer.
    let base = fake_section(&mut rng, 4096);
    for _ in 0..60 {
        let mut b = base.clone();
        for _ in 0..(rng.next() % 16 + 1) {
            let i = 16 + (rng.next() as usize) % (b.len() - 16);
            b[i] = rng.next() as u8;
        }
        assert_err_not_panic(&b, "flipped.one");
    }

    // `.onepkg`: noise behind the cabinet magic, and a real cabinet without a notebook inside.
    for &len in &lengths[..30] {
        let mut cab = b"MSCF".to_vec();
        cab.extend(rng.bytes(len));
        assert_err_not_panic(&cab, "noise.onepkg");
    }
    let cab = build_cab(&[("readme.txt", b"no notebook here")]);
    assert!(matches!(
        parse(&cab, "x.onepkg", &ImportLimits::default()),
        Err(ImportError::Corrupt(_))
    ));
    for cut in (4..cab.len()).step_by(7) {
        assert_err_not_panic(&cab[..cut], "cut.onepkg");
    }
}

#[test]
fn onenote_onepkg_declared_size_is_bounded() {
    let cab = build_cab(&[
        ("Notebook.onetoc2", &[0u8; 4096]),
        ("Section.one", &[0u8; 4096]),
    ]);
    let tight = ImportLimits {
        max_unzipped_bytes: 1024,
        ..ImportLimits::default()
    };
    assert!(matches!(
        parse(&cab, "x.onepkg", &tight),
        Err(ImportError::Limit(_))
    ));
    let few = ImportLimits {
        max_zip_entries: 1,
        ..ImportLimits::default()
    };
    assert!(matches!(
        parse(&cab, "x.onepkg", &few),
        Err(ImportError::Limit(_))
    ));
    // Within limits the zero-filled "notebook" is simply damaged.
    assert!(matches!(
        parse(&cab, "x.onepkg", &ImportLimits::default()),
        Err(ImportError::Corrupt(_))
    ));
}

fn build_cab(files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::{Cursor, Write};
    let mut builder = cab::CabinetBuilder::new();
    {
        let folder = builder.add_folder(cab::CompressionType::MsZip);
        for (name, _) in files {
            folder.add_file(*name);
        }
    }
    let mut writer = builder.build(Cursor::new(Vec::new())).unwrap();
    let mut i = 0;
    while let Some(mut file) = writer.next_file().unwrap() {
        file.write_all(files[i].1).unwrap();
        i += 1;
    }
    writer.finish().unwrap().into_inner()
}

fn stroke(points: &[(f32, f32)], color: u32, transparency: Option<u8>, width: f32) -> StrokeView {
    StrokeView {
        points: points.to_vec(),
        color: Some(color),
        transparency,
        width,
    }
}

/// One page: two strokes in an offset ink container (one pen, one highlighter), a nested
/// container, one outline with two paragraphs, one floating image and a background image.
fn sample_section() -> SectionView {
    let page = PageView {
        source_id: "page-1".into(),
        title: Some("Lecture 1".into()),
        height: Some(40.0), // 1920 px
        inks: vec![
            InkView {
                offset_horizontal: 1.0, // +48 px
                offset_vertical: 2.0,   // +96 px
                strokes: vec![
                    stroke(
                        &[(2540.0, 2540.0), (5080.0, 2540.0)],
                        0x00FF_0000,
                        None,
                        254.0,
                    ),
                    stroke(&[(0.0, 0.0), (2540.0, 0.0)], 0x0000_FFFF, Some(100), 10.0),
                ],
            },
            InkView {
                offset_horizontal: 0.0,
                offset_vertical: 0.0,
                strokes: vec![StrokeView {
                    points: vec![(f32::NAN, 0.0), (254.0, 254.0)],
                    color: None,
                    transparency: Some(255),
                    width: 52.9,
                }],
            },
        ],
        outlines: vec![OutlineView {
            offset_horizontal: Some(1.0),
            offset_vertical: Some(3.0),
            layout_max_width: Some(5.0),
            paragraphs: vec!["Hello".into(), "World".into()],
            font_size_half_points: Some(22),
        }],
        images: vec![
            ImageView {
                offset_horizontal: Some(2.0),
                offset_vertical: Some(10.0),
                picture_width: Some(4.0),
                picture_height: None,
                bytes: PNG.to_vec(),
                extension: Some(".png".into()),
                is_background: false,
            },
            ImageView {
                offset_horizontal: None,
                offset_vertical: None,
                picture_width: Some(30.0), // 1440 px: widens the page
                picture_height: Some(2.0),
                bytes: PNG.to_vec(),
                extension: Some(".xyz".into()),
                is_background: true,
            },
        ],
        skipped: ImportSkipped {
            tables: 1,
            shapes: 0,
            other: 2,
        },
    };
    let empty = PageView {
        source_id: "page-2".into(),
        ..PageView::default()
    };
    SectionView {
        source_id: "{guid}".into(),
        title: "Physics".into(),
        pages: vec![page, empty],
    }
}

#[test]
fn onenote_views_map_to_import_document() {
    let doc = from_sections("Physics", vec![sample_section()], 2000);
    assert_eq!(doc.source, ImportSource::OneNote);
    assert_eq!(doc.title, "Physics");
    assert_eq!(doc.default_page_mode, PageMode::Page);
    assert_eq!(doc.sections.len(), 1);
    let section = &doc.sections[0];
    assert_eq!(
        (section.source_id.as_str(), section.title.as_str()),
        ("{guid}", "Physics")
    );
    assert_eq!(section.pages.len(), 2);

    let p = &section.pages[0];
    assert_eq!(p.source_id, "page-1");
    assert_eq!(p.title.as_deref(), Some("Lecture 1"));
    // The background image reaches 1440 px, so the page widens; height from page.height.
    assert!(close(p.width, 1440.0), "{}", p.width);
    assert!(close(p.height, 1920.0), "{}", p.height);
    assert_eq!(
        p.skipped,
        ImportSkipped {
            tables: 1,
            shapes: 0,
            other: 2
        }
    );

    assert_eq!(p.strokes.len(), 3);
    let a = &p.strokes[0];
    let pts: Vec<(f64, f64)> = a.points.iter().map(|q| (q.x, q.y)).collect();
    assert!(
        close(pts[0].0, 96.0 + 48.0) && close(pts[0].1, 96.0 + 96.0),
        "{pts:?}"
    );
    assert!(
        close(pts[1].0, 192.0 + 48.0) && close(pts[1].1, 96.0 + 96.0),
        "{pts:?}"
    );
    assert!(a.points.iter().all(|q| q.pressure.is_none()));
    assert_eq!(a.color, "#0000ff");
    assert!(close(a.width, 9.6));
    assert!(!a.is_highlighter);
    assert_eq!(a.pen_style, PenStyle::Pen);
    assert!(close(a.opacity, 1.0));

    let h = &p.strokes[1];
    assert_eq!(h.color, "#ffff00");
    assert!(h.is_highlighter);
    assert_eq!(h.pen_style, PenStyle::Highlighter);
    assert!(close(h.opacity, 0.5));
    assert!(close(h.width, 1.0));
    assert!(close(h.points[0].x, 48.0) && close(h.points[0].y, 96.0));

    // Non-finite points are dropped; a missing colour is black; opaque is not a highlighter.
    let c = &p.strokes[2];
    assert_eq!(c.points.len(), 1);
    assert!(close(c.points[0].x, 9.6) && close(c.points[0].y, 9.6));
    assert_eq!(c.color, "#000000");
    assert!(!c.is_highlighter);
    assert!(close(c.width, f64::from(52.9f32) * 96.0 / 2540.0));
    let z: Vec<i64> = p.strokes.iter().map(|s| s.z_index).collect();
    assert_eq!(z, [0, 1, 2]);

    assert_eq!(p.texts.len(), 1);
    let t = &p.texts[0];
    assert_eq!(t.text, "Hello\nWorld");
    assert!(close(t.x, 48.0) && close(t.y, 144.0));
    assert_eq!(t.width, Some(240.0));
    assert_eq!(t.font_size, Some(11.0 * 96.0 / 72.0));
    assert_eq!(t.color, "#000000");

    // Background first; missing size → 300; unknown extension → no mime.
    assert_eq!(p.images.len(), 2);
    let bg = &p.images[0];
    assert!(
        close(bg.x, 0.0) && close(bg.y, 0.0) && close(bg.width, 1440.0) && close(bg.height, 96.0)
    );
    assert_eq!(bg.mime, None);
    let img = &p.images[1];
    assert!(close(img.x, 96.0) && close(img.y, 480.0));
    assert!(close(img.width, 192.0) && close(img.height, 300.0));
    assert_eq!(img.mime.as_deref(), Some("image/png"));
    assert_eq!(img.bytes, PNG);

    // An empty page: Mate's sheet width, minimum height.
    let e = &section.pages[1];
    assert!(close(e.width, 1080.0) && close(e.height, 1440.0));
    assert!(e.strokes.is_empty() && e.texts.is_empty() && e.images.is_empty());
}

#[test]
fn onenote_page_extent_and_page_cap() {
    // No page height: content extent, at least 1440.
    let tall = PageView {
        inks: vec![InkView {
            offset_horizontal: 0.0,
            offset_vertical: 0.0,
            strokes: vec![stroke(&[(0.0, 0.0), (0.0, 100_000.0)], 0, None, 0.0)],
        }],
        ..PageView::default()
    };
    // A declared height smaller than the content grows to fit it.
    let short = PageView {
        height: Some(1.0),
        images: vec![ImageView {
            offset_vertical: Some(10.0),
            picture_height: Some(10.0),
            bytes: PNG.to_vec(),
            ..ImageView::default()
        }],
        ..PageView::default()
    };
    let sections = vec![
        SectionView {
            pages: vec![tall, short],
            ..SectionView::default()
        },
        SectionView {
            pages: vec![PageView::default(); 3],
            ..SectionView::default()
        },
    ];
    let doc = from_sections("t", sections, 3);
    let p = &doc.sections[0].pages;
    // 100 000 HIMETRIC = 3779.53 px, plus half the 1 px width, rounded up.
    assert!(close(p[0].height, 3781.0), "{}", p[0].height);
    assert!(close(p[1].height, 960.0), "{}", p[1].height);
    // At most `max_pages` pages over all sections.
    assert_eq!(doc.page_count(), 3);
    assert_eq!(doc.sections[1].pages.len(), 1);
}

/// Manual check against a real section: drop a `.one` at `docs/import-samples/sample.one`
/// (local only) and run `cargo test -p mate-core --test import_onenote -- --ignored`.
#[test]
#[ignore]
fn onenote_real_file_smoke() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/import-samples/sample.one");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("no sample at {}; skipping", path.display());
        return;
    };
    let doc = parse(&bytes, "sample.one", &ImportLimits::default()).expect("sample parses");
    assert_eq!(doc.source, ImportSource::OneNote);
    assert!(!doc.sections.is_empty());
    let strokes: usize = doc
        .sections
        .iter()
        .flat_map(|s| &s.pages)
        .map(|p| p.strokes.len())
        .sum();
    eprintln!(
        "{}: {} section(s), {} page(s), {} stroke(s)",
        doc.title,
        doc.sections.len(),
        doc.page_count(),
        strokes
    );
    assert!(doc.page_count() > 0);
}
