//! API key storage. Keys live in the OS keychain (service [`SERVICE`], account = provider id)
//! and never leave Rust: they are not logged, serialised or written to `settings.json`.

use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "com.mate.notes";

pub trait KeyStore: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, key: &str) -> Result<(), String>;
    /// Removing a key that does not exist succeeds.
    fn delete(&self, provider: &str) -> Result<(), String>;
}

/// The OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret Service).
#[derive(Default)]
pub struct KeyringStore;

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider).map_err(|e| format!("keychain unavailable: {e}"))
}

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
