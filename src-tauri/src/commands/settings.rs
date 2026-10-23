use std::path::Path;
use std::sync::Mutex;

use mate_core::settings::Settings;
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, State, Window};

use crate::state::AppState;

/// Broadcast to every window after the settings file was written, so each window's settings
/// store reloads (theme, key bindings, haptics... stay in step across page windows).
pub const SETTINGS_CHANGED: &str = "settings://changed";

/// Payload of `settings://changed`: `source` is the label of the window that wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SettingsChange {
    pub source: String,
}

/// Where change notifications go (every window in the app; a recorder in tests).
pub trait SettingsSink {
    fn source(&self) -> String;
    fn settings_changed(&self, change: SettingsChange);
}

impl SettingsSink for Window {
    fn source(&self) -> String {
        self.label().to_owned()
    }
    fn settings_changed(&self, change: SettingsChange) {
        let _ = self.emit(SETTINGS_CHANGED, change);
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().map_err(|e| e.to_string())?.clone())
}

/// Merges the top-level keys of `patch` into the stored settings (under the settings lock),
/// writes the file and returns the merged document. Keys the patch does not name keep their
/// stored value, so windows writing different keys never revert each other. Unknown keys are
/// ignored; a wrong-typed value rejects the whole patch (nothing is written).
#[tauri::command]
pub fn patch_settings(window: Window, state: State<'_, AppState>, patch: Value) -> Result<Settings, String> {
    patch_op(&state.settings, &state.data_dir.join("settings.json"), &window, patch)
}

fn patch_op(settings: &Mutex<Settings>, path: &Path, sink: &impl SettingsSink, patch: Value) -> Result<Settings, String> {
    let Value::Object(patch) = patch else {
        return Err("a settings patch must be an object".into());
    };
    let merged = {
        let mut current = settings.lock().map_err(|e| e.to_string())?;
        let Value::Object(mut doc) = serde_json::to_value(&*current).map_err(|e| e.to_string())? else {
            return Err("settings did not serialise to an object".into());
        };
        for (key, value) in patch {
            if doc.contains_key(&key) {
                doc.insert(key, value);
            }
        }
        let next: Settings = serde_json::from_value(Value::Object(doc)).map_err(|e| e.to_string())?;
        next.save(path).map_err(|e| e.to_string())?;
        *current = next.clone();
        next
    };
    // Only after the file is written (and the lock released): listeners reload from disk.
    sink.settings_changed(SettingsChange { source: sink.source() });
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    /// Records each event with the settings file as it was on disk at emit time.
    struct Recorder {
        path: PathBuf,
        seen: RefCell<Vec<(SettingsChange, Option<Settings>)>>,
    }
    impl SettingsSink for Recorder {
        fn source(&self) -> String {
            "page-p1".into()
        }
        fn settings_changed(&self, change: SettingsChange) {
            let on_disk = std::fs::read_to_string(&self.path)
                .ok()
                .map(|t| Settings::from_json_lenient(&t).unwrap());
            self.seen.borrow_mut().push((change, on_disk));
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mate-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn patch_settings_merges_only_given_keys() {
        let path = temp_file("merge");
        let stored = Settings {
            theme: "dark".into(),
            recent_colors: vec!["#111111".into()],
            ..Settings::default()
        };
        stored.save(&path).unwrap();
        let settings = Mutex::new(stored);
        let sink = Recorder { path: path.clone(), seen: RefCell::new(Vec::new()) };

        // A page window writes only its recent colours (plus an unknown key, ignored).
        let patch = serde_json::json!({ "recentColors": ["#ff0000"], "notASetting": 1 });
        let merged = patch_op(&settings, &path, &sink, patch).unwrap();

        assert_eq!(merged.recent_colors, vec!["#ff0000".to_string()]);
        assert_eq!(merged.theme, "dark", "a key the patch does not name keeps its stored value");
        assert_eq!(*settings.lock().unwrap(), merged);
        assert_eq!(Settings::load(&path), merged);

        // A wrong-typed value or a non-object rejects the patch: nothing written, nothing emitted.
        let before = sink.seen.borrow().len();
        assert!(patch_op(&settings, &path, &sink, serde_json::json!({ "theme": 3 })).is_err());
        assert!(patch_op(&settings, &path, &sink, serde_json::json!([1])).is_err());
        assert_eq!(settings.lock().unwrap().theme, "dark");
        assert_eq!(Settings::load(&path).theme, "dark");
        assert_eq!(sink.seen.borrow().len(), before);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn emits_after_write_not_before() {
        let path = temp_file("emit");
        let settings = Mutex::new(Settings::default());
        let sink = Recorder { path: path.clone(), seen: RefCell::new(Vec::new()) };

        patch_op(&settings, &path, &sink, serde_json::json!({ "theme": "sepia" })).unwrap();

        {
            let seen = sink.seen.borrow();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].0, SettingsChange { source: "page-p1".into() });
            let on_disk = seen[0].1.as_ref().expect("the file exists when the event is emitted");
            assert_eq!(on_disk.theme, "sepia", "the event follows the write");
            assert_eq!(serde_json::to_value(&seen[0].0).unwrap(), serde_json::json!({ "source": "page-p1" }));
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
