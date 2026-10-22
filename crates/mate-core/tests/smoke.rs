#[test]
fn version_matches_package() {
    assert_eq!(mate_core::VERSION, env!("CARGO_PKG_VERSION"));
}
