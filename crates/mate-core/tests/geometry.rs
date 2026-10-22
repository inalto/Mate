use mate_core::geometry::{
    AspectPreset, PAGE_HEIGHT, PAGE_WIDTH, is_point_inside_page, page_index_at, page_stride,
    page_top_at_index, preset_size,
};

#[test]
fn preset_sizes() {
    assert_eq!(preset_size(AspectPreset::A4, false), (1080.0, 1528.0));
    assert_eq!(preset_size(AspectPreset::Letter, false), (1080.0, 1397.0));
    assert_eq!(preset_size(AspectPreset::Wide16x9, false), (1080.0, 1920.0));
    assert_eq!(
        preset_size(AspectPreset::Standard4x3, false),
        (1080.0, 1440.0)
    );
    assert_eq!(preset_size(AspectPreset::Square, false), (1080.0, 1080.0));
    assert_eq!(preset_size(AspectPreset::A4, true), (1528.0, 1080.0));
}

#[test]
fn page_index_math() {
    assert_eq!(page_stride(1440.0), 1464.0);
    assert_eq!(page_index_at(0.0, 1440.0), 0);
    assert_eq!(page_index_at(1464.0, 1440.0), 1);
    assert_eq!(page_top_at_index(2, 1440.0), 2928.0);
}

#[test]
fn inside_page() {
    assert!(is_point_inside_page(500.0, 100.0, PAGE_WIDTH, PAGE_HEIGHT));
    assert!(!is_point_inside_page(-1.0, 100.0, PAGE_WIDTH, PAGE_HEIGHT));
    assert!(!is_point_inside_page(
        500.0,
        1450.0,
        PAGE_WIDTH,
        PAGE_HEIGHT
    ));
}
