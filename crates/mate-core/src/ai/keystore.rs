//! API key storage. Keys live in the OS keychain (service [`SERVICE`], account = provider id)
//! and never leave Rust: they are not logged, serialised or written to `settings.json`.
//!
//! Mobile has no keyring backend, so [`FileKeyStore`] keeps a JSON file in the app-private data
//! dir, which Android isolates per app and encrypts at rest. The Android Keystore is a later
//! improvement.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub const SERVICE: &str = "com.mate.notes";

pub trait KeyStore: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, key: &str) -> Result<(), String>;
    /// Removing a key that does not exist succeeds.
    fn delete(&self, provider: &str) -> Result<(), String>;
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// The OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service).
#[derive(Default)]
pub struct KeyringStore;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider).map_err(|e| format!("keychain unavailable: {e}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl KeyStore for KeyringStore {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        match entry(provider)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("could not read the key from the keychain: {e}")),
        }
    }

    fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        entry(provider)?
            .set_password(key)
            .map_err(|e| format!("could not save the key to the keychain: {e}"))
    }

    fn delete(&self, provider: &str) -> Result<(), String> {
        match entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("could not remove the key from the keychain: {e}")),
        }
    }
}

/// File-backed store for mobile: a JSON object `{ "<provider>": "<key>" }`, written atomically.
pub struct FileKeyStore {
    path: PathBuf,
}

impl FileKeyStore {
    pub fn new(path: PathBuf) -> FileKeyStore {
        FileKeyStore { path }
    }

    /// A missing or corrupt file reads as empty.
    fn load(&self) -> HashMap<String, String> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, map: &HashMap<String, String>) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create the key store folder: {e}"))?;
        }
        let json = serde_json::to_string(map).map_err(|e| format!("could not encode the key store: {e}"))?;
        let mut tmp = self.path.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        std::fs::write(&tmp, json).map_err(|e| format!("could not write the key store: {e}"))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("could not save the key store: {e}"))
    }
}

impl KeyStore for FileKeyStore {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        Ok(self.load().get(provider).cloned())
    }

    fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        let mut map = self.load();
        map.insert(provider.into(), key.into());
        self.save(&map)
    }

    fn delete(&self, provider: &str) -> Result<(), String> {
        let mut map = self.load();
        if map.remove(provider).is_some() {
            self.save(&map)?;
        }
        Ok(())
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl KeyStore for MemoryStore {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|e| e.to_string())?.get(provider).cloned())
    }

    fn set(&self, provider: &str, key: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.insert(provider.into(), key.into());
        Ok(())
    }

    fn delete(&self, provider: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(provider);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("mate-keys-{}", uuid::Uuid::new_v4())).join("keys.json")
    }

    #[test]
    fn file_store_round_trips_and_persists_across_instances() {
        let path = temp_path();
        let a = FileKeyStore::new(path.clone());
        assert_eq!(a.get("anthropic").unwrap(), None);
        a.set("anthropic", "sk-1").unwrap();
        let b = FileKeyStore::new(path.clone());
        assert_eq!(b.get("anthropic").unwrap(), Some("sk-1".into()));
        b.delete("anthropic").unwrap();
        b.delete("anthropic").unwrap(); // deleting a missing key succeeds
        assert_eq!(FileKeyStore::new(path).get("anthropic").unwrap(), None);
    }

    #[test]
    fn file_store_tolerates_a_corrupt_file() {
        let path = temp_path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json").unwrap();
        let s = FileKeyStore::new(path.clone());
        assert_eq!(s.get("anthropic").unwrap(), None);
        s.set("anthropic", "sk-2").unwrap();
        assert_eq!(FileKeyStore::new(path).get("anthropic").unwrap(), Some("sk-2".into()));
    }
}
