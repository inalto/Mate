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
    assert_eq!(s.ai_consent, None);
    assert_eq!(s.ai_provider, "anthropic");
    assert_eq!(s.ai_model, "");
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
fn one_wrong_typed_field_keeps_the_rest() {
    let dir = tempdir();
    let p = dir.join("settings.json");
    std::fs::write(
        &p,
        r#"{"theme":"dark","defaultPenWidth":"wide","pinchToZoom":false,"keybindings":[{"action":"a","keys":"Mod+K"}]}"#,
    )
    .unwrap();
    let s = Settings::load(&p);
    assert_eq!(s.theme, "dark");
    assert_eq!(s.default_pen_width, 4.11);
    assert!(!s.pinch_to_zoom);
    assert_eq!(s.keybindings.len(), 1);
}

#[test]
fn phase5_defaults() {
    let s = Settings::default();
    assert!(s.keybindings.is_empty());
    assert!(!s.onboarding_done);
    assert_eq!(s.last_seen_version, "");
    assert_eq!(s.playground_page_id, None);
    assert!(s.pen_haptics);
    assert!(s.check_updates_on_startup);
}

/// The TS defaults (`npm run dump:settings-defaults`) must equal the Rust defaults.
#[test]
fn settings_defaults_match_between_rust_and_ts() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/settings-defaults.json");
    let ts: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let rust = serde_json::to_value(Settings::default()).unwrap();
    // JSON has no int/float split: `20` (TS) and `20.0` (Rust) are the same default.
    fn norm(v: serde_json::Value) -> serde_json::Value {
        use serde_json::Value;
        match v {
            Value::Number(n) => serde_json::json!(n.as_f64()),
            Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
            Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
            other => other,
        }
    }
    assert_eq!(norm(rust), norm(ts), "regenerate with `npm run dump:settings-defaults` after changing defaults");
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

#[test]
fn finger_action_defaults_to_auto() {
    assert_eq!(Settings::default().finger_action, "auto");
}

#[test]
fn legacy_draw_with_finger_maps_to_finger_action() {
    let dir = tempdir();
    let p = dir.join("settings.json");
    std::fs::write(&p, r#"{"drawWithFinger":true}"#).unwrap();
    assert_eq!(Settings::load(&p).finger_action, "draw");
    std::fs::write(&p, r#"{"drawWithFinger":false}"#).unwrap();
    assert_eq!(Settings::load(&p).finger_action, "auto");
    // An explicit fingerAction wins over the legacy key.
    std::fs::write(&p, r#"{"drawWithFinger":true,"fingerAction":"pan"}"#).unwrap();
    let s = Settings::load(&p);
    assert_eq!(s.finger_action, "pan");
    // The legacy key is dropped on save.
    s.save(&p).unwrap();
    let text = std::fs::read_to_string(&p).unwrap();
    assert!(!text.contains("drawWithFinger"));
    assert!(text.contains("\"fingerAction\": \"pan\""));
}

#[test]
fn unknown_finger_action_loads_as_auto() {
    let dir = tempdir();
    let p = dir.join("settings.json");
    for bad in [r#""sideways""#, "3", "null"] {
        std::fs::write(&p, format!(r#"{{"fingerAction":{bad},"theme":"dark"}}"#)).unwrap();
        let s = Settings::load(&p);
        assert_eq!(s.finger_action, "auto", "{bad}");
        assert_eq!(s.theme, "dark");
    }
}
