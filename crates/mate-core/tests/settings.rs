use mate_core::settings::Settings;

#[test]
fn defaults_match_spec() {
    let s = Settings::default();
    assert_eq!(s.default_pen_width, 4.11);
    assert_eq!(s.default_highlighter_color, "#FDE047");
    assert_eq!(s.theme, "light");
    assert_eq!(s.trash_retention_days, 30);
    assert_eq!(s.stroke_stabilization, 35.0);
    assert_eq!(s.settings_version, 1);
    assert_eq!(s.toolbar_presets.len(), 5);
}

#[test]
fn load_missing_file_gives_defaults() {
    let dir = tempdir();
    let s = Settings::load(&dir.join("nope.json"));
    assert_eq!(s, Settings::default());
}

#[test]
fn load_corrupt_or_partial_file() {
    let dir = tempdir();
    let p = dir.join("settings.json");
    std::fs::write(&p, "{ not json").unwrap();
    assert_eq!(Settings::load(&p), Settings::default());
    std::fs::write(&p, r#"{"theme":"dark","unknownKey":1}"#).unwrap();
    let s = Settings::load(&p);
    assert_eq!(s.theme, "dark");
    assert_eq!(s.default_pen_width, 4.11);
}

#[test]
fn save_then_load_round_trips() {
    let dir = tempdir();
    let p = dir.join("settings.json");
    let mut s = Settings {
        theme: "sepia".into(),
        recent_colors: vec!["#112233".into()],
        ai_consent: Some(true),
        ..Settings::default()
    };
    s.save(&p).unwrap();
    s.theme = "dark".into();
    s.save(&p).unwrap(); // overwrite existing
    assert!(!p.with_extension("json.tmp").exists());
    let loaded = Settings::load(&p);
    assert_eq!(loaded.theme, "dark");
    assert_eq!(loaded, s);
}

fn tempdir() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("mate-settings-{}", mate_core::model::new_id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}
