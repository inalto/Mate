//! User settings persisted as `settings.json` (spec: `01-data-model-and-sync.md` section 5).
//!
//! The struct is camelCase on the wire. Every field defaults individually, so partial or older
//! files load and unknown keys are ignored.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PenPreset {
    pub id: String,
    /// `"pen" | "fountain-pen" | "highlighter"`.
    pub r#type: String,
    pub color: String,
    pub width: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharpness: Option<f64>,
}

fn preset(id: &str, kind: &str, color: &str, width: f64) -> PenPreset {
    PenPreset {
        id: id.into(),
        r#type: kind.into(),
        color: color.into(),
        width,
        sharpness: None,
    }
}

fn default_toolbar_presets() -> Vec<PenPreset> {
    vec![
        preset("preset-1", "pen", "#000000", 4.11),
        preset("preset-2", "pen", "#C62828", 4.11),
        preset("preset-3", "pen", "#1565C0", 4.11),
        preset("preset-4", "highlighter", "#FDE047", 20.06),
        preset("preset-5", "fountain-pen", "#000000", 4.11),
    ]
}

/// A user override of one action's key binding (`keys` is a chord string such as `"Mod+Shift+K"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingOverride {
    pub action: String,
    pub keys: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub settings_version: u32,
    // Appearance
    /// `"light" | "dark" | "sepia" | "high-contrast"`.
    pub theme: String,
    pub handedness: String,
    pub library_view: String,
    pub sidebar_layout: String,
    pub shortcut_hint_mode: String,
    pub dismissed_hints: BTreeMap<String, bool>,
    pub invert_images_in_dark_mode: bool,
    pub static_snapshot_cache: bool,
    pub show_zoom_indicator: bool,
    // New page
    pub default_page_mode: String,
    pub default_background: String,
    pub align_text_to_lines: bool,
    pub default_page_aspect_ratio: String,
    pub default_page_orientation: String,
    // Pen
    pub default_pen_color: String,
    pub default_pen_width: f64,
    pub default_highlighter_color: String,
    pub default_highlighter_width: f64,
    // Text
    pub default_text_color: String,
    pub default_text_size: f64,
    // Shapes
    pub default_shape_type: String,
    pub default_shape_stroke_color: String,
    pub default_shape_fill_color: String,
    pub default_shape_stroke_width: f64,
    pub default_shape_fill_opacity: f64,
    // Eraser
    pub default_eraser_type: String,
    pub default_eraser_width: f64,
    pub eraser_erase_shapes: bool,
    pub eraser_erase_images: bool,
    // Ink
    pub ink_to_shape: bool,
    pub ink_to_shape_snaps_on_release: bool,
    pub ink_to_shape_dwell_ms: u32,
    pub scribble_to_erase: bool,
    pub scribble_erase_sensitivity: String,
    pub stroke_stabilization: f64,
    pub fountain_pen_nib_flatness: f64,
    // Input
    pub palm_rejection: String,
    pub snap_to_grid: bool,
    pub pen_barrel_button_action: String,
    pub pen_eraser_button_action: String,
    pub scroll_behavior: String,
    pub pinch_to_zoom: bool,
    pub draw_with_finger: bool,
    // Tutor
    pub conversion_enabled: bool,
    pub correctness_mode: bool,
    pub tutor_underline_errors: bool,
    pub tutor_show_checking: bool,
    pub tutor_enabled: bool,
    /// `"live"` (check each group as it settles) or `"onask"` (only groups the user asks about).
    pub tutor_mode: String,
    pub tutor_double_tap_ask: bool,
    pub tutor_hold_to_ask: bool,
    pub tutor_verdict_change_gate: String,
    // Misc
    pub ai_consent: Option<bool>,
    /// A catalog id (`ai::catalog`); unknown ids fall back to `"anthropic"`.
    pub ai_provider: String,
    /// Empty means the provider's default model (`ai::default_model`).
    pub ai_model: String,
    /// Overrides the provider's address (local and custom providers only). Empty = the default.
    pub ai_base_url: String,
    /// Wolfram|Alpha may be asked (the typed maths is sent to it). Off until the user turns it on.
    pub wolfram_consent: bool,
    pub trash_retention_days: u32,
    pub default_export_format: String,
    // Mate additions
    /// Most recent first, max 6 entries.
    pub recent_colors: Vec<String>,
    pub toolbar_presets: Vec<PenPreset>,
    // Phase 5
    /// Per-action key binding overrides (empty means all defaults).
    pub keybindings: Vec<KeybindingOverride>,
    pub onboarding_done: bool,
    /// App version whose release notes were last shown; empty before the first run.
    pub last_seen_version: String,
    /// The Playground page created by onboarding, if any.
    pub playground_page_id: Option<String>,
    pub pen_haptics: bool,
    pub check_updates_on_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let s = String::from;
        Self {
            settings_version: 1,
            theme: s("light"),
            handedness: s("right"),
            library_view: s("recent"),
            sidebar_layout: s("split"),
            shortcut_hint_mode: s("always"),
            dismissed_hints: BTreeMap::new(),
            invert_images_in_dark_mode: true,
            static_snapshot_cache: true,
            show_zoom_indicator: false,
            default_page_mode: s("canvas"),
            default_background: s("ruled"),
            align_text_to_lines: true,
            default_page_aspect_ratio: s("a4"),
            default_page_orientation: s("portrait"),
            default_pen_color: s("#000000"),
            default_pen_width: 4.11,
            default_highlighter_color: s("#FDE047"),
            default_highlighter_width: 20.06,
            default_text_color: s("#000000"),
            default_text_size: 21.77,
            default_shape_type: s("rectangle"),
            default_shape_stroke_color: s("#000000"),
            default_shape_fill_color: s("transparent"),
            default_shape_stroke_width: 2.0,
            default_shape_fill_opacity: 1.0,
            default_eraser_type: s("stroke"),
            default_eraser_width: 20.0,
            eraser_erase_shapes: true,
            eraser_erase_images: false,
            ink_to_shape: true,
            ink_to_shape_snaps_on_release: false,
            ink_to_shape_dwell_ms: 750,
            scribble_to_erase: true,
            scribble_erase_sensitivity: s("standard"),
            stroke_stabilization: 35.0,
            fountain_pen_nib_flatness: 35.0,
            palm_rejection: s("high"),
            snap_to_grid: false,
            pen_barrel_button_action: s("eraser"),
            pen_eraser_button_action: s("eraser"),
            scroll_behavior: s("pan"),
            pinch_to_zoom: true,
            draw_with_finger: false,
            conversion_enabled: true,
            correctness_mode: false,
            tutor_underline_errors: true,
            tutor_show_checking: true,
            tutor_enabled: true,
            tutor_mode: s("live"),
            tutor_double_tap_ask: true,
            tutor_hold_to_ask: true,
            tutor_verdict_change_gate: s("enforce"),
            ai_consent: None,
            ai_provider: s("anthropic"),
            ai_model: String::new(),
            ai_base_url: String::new(),
            wolfram_consent: false,
            trash_retention_days: 30,
            default_export_format: s("pdf"),
            recent_colors: Vec::new(),
            toolbar_presets: default_toolbar_presets(),
            keybindings: Vec::new(),
            onboarding_done: false,
            last_seen_version: String::new(),
            playground_page_id: None,
            pen_haptics: true,
            check_updates_on_startup: true,
        }
    }
}

impl Settings {
    /// Parses a settings file. A field with the wrong type falls back to its default instead of
    /// discarding the whole file; only non-JSON or non-object input is an error.
    pub fn from_json_lenient(text: &str) -> Result<Settings, serde_json::Error> {
        let value: serde_json::Value = serde_json::from_str(text)?;
        if let Ok(s) = serde_json::from_value::<Settings>(value.clone()) {
            return Ok(s);
        }
        let serde_json::Value::Object(file) = value else {
            return serde_json::from_value(value); // error: not an object
        };
        let defaults = serde_json::to_value(Settings::default())?;
        let serde_json::Value::Object(mut merged) = defaults else {
            return Ok(Settings::default());
        };
        for (key, val) in file {
            let Some(old) = merged.get(&key).cloned() else {
                continue; // unknown key
            };
            merged.insert(key.clone(), val);
            if serde_json::from_value::<Settings>(serde_json::Value::Object(merged.clone()))
                .is_err()
            {
                eprintln!("settings: ignoring wrong-typed value for \"{key}\"; using its default");
                merged.insert(key, old); // wrong type: keep the default
            }
        }
        serde_json::from_value(serde_json::Value::Object(merged))
    }

    /// Reads settings from `path`; a missing or unparsable file yields the defaults.
    pub fn load(path: &Path) -> Settings {
        match fs::read_to_string(path) {
            Ok(text) => Self::from_json_lenient(&text).unwrap_or_else(|e| {
                eprintln!(
                    "settings: could not parse {}: {e}; using defaults",
                    path.display()
                );
                Settings::default()
            }),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(e) => {
                eprintln!(
                    "settings: could not read {}: {e}; using defaults",
                    path.display()
                );
                Settings::default()
            }
        }
    }

    /// Atomically writes settings: `<path>.tmp` first, then a rename over the destination.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let mut tmp = path.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let json = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        fs::write(&tmp, json)?;
        if fs::rename(&tmp, path).is_err() {
            // Windows may refuse to rename over an existing file.
            let _ = fs::remove_file(path);
            fs::rename(&tmp, path)?;
        }
        Ok(())
    }
}
