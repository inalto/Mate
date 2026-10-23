//! Page windows: a page opened in its own native window (label `page-<pageId>`, URL
//! `/edit/<pageId>?window=1`). The main window keeps its tabs; page windows show one page each.
//!
//! Each window runs the close handshake on its own (`commands::lifecycle`, gates keyed by label).
//! Closing the main window first closes every page window through *its* handshake; the main
//! window's own handshake starts only once all of them were destroyed. If one cannot flush, the
//! main close is cancelled and the main window says so.
//!
//! The registry and the close ordering are pure over two small host traits, so they are tested
//! with fakes; `TauriHost` is the real window system.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::lifecycle;

pub const MAIN_LABEL: &str = "main";
pub const PAGE_LABEL_PREFIX: &str = "page-";
const WIDTH: f64 = 1100.0;
const HEIGHT: f64 = 800.0;

/// The window label for `page_id`; rejects ids that are not safe in a label or a URL path.
pub fn label_for(page_id: &str) -> Result<String, String> {
    let ok = !page_id.is_empty()
        && page_id.len() <= 100
        && page_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
    if ok { Ok(format!("{PAGE_LABEL_PREFIX}{page_id}")) } else { Err("invalid page id".into()) }
}

pub fn page_url(page_id: &str) -> String {
    format!("/edit/{page_id}?window=1")
}

pub fn is_page_window(label: &str) -> bool {
    label.starts_with(PAGE_LABEL_PREFIX)
}

/// Creating and focusing native windows.
pub trait WindowHost {
    fn exists(&self, label: &str) -> bool;
    fn focus(&self, label: &str) -> Result<(), String>;
    fn create(&self, label: &str, url: &str, title: &str) -> Result<(), String>;
}

/// The close handshake and window teardown.
pub trait CloseHost {
    fn exists(&self, label: &str) -> bool;
    /// Starts `label`'s own close handshake. True = its frontend flushes first (and destroys the
    /// window when done); false = the window is unresponsive and should be destroyed now.
    fn start_close(&self, label: &str, exit: bool) -> bool;
    fn destroy(&self, label: &str);
    fn exit_app(&self);
    /// Tells the main window that its close was cancelled because a page window could not flush.
    fn notify_close_refused(&self);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageWindowInfo {
    pub page_id: String,
    pub label: String,
}

/// A main-window close (or app quit) waiting for page windows to flush and close.
struct MainClose {
    exit: bool,
    waiting: HashSet<String>,
}

#[derive(Default)]
struct Registry {
    /// page id -> window label (page windows only; the main window's tabs are not registered).
    pages: HashMap<String, String>,
    main_close: Option<MainClose>,
}

#[derive(Default)]
pub struct PageWindows(Mutex<Registry>);

impl PageWindows {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Opens `page_id` in its own window, or focuses the window already showing it. Returns the
    /// window label. The lock is never held while the window system runs (it may emit events).
    pub fn open(&self, host: &impl WindowHost, page_id: &str, title: &str) -> Result<String, String> {
        let label = label_for(page_id)?;
        let known = {
            let r = self.lock();
            if r.main_close.is_some() {
                return Err("Mate is closing".into());
            }
            r.pages.get(page_id).cloned()
        };
        if let Some(existing) = known.filter(|l| host.exists(l)) {
            host.focus(&existing)?;
            return Ok(existing);
        }
        if host.exists(&label) {
            host.focus(&label)?;
        } else {
            host.create(&label, &page_url(page_id), title)?;
        }
        self.lock().pages.insert(page_id.to_owned(), label.clone());
        Ok(label)
    }

    /// Focuses the window showing `page_id`; false if none is open.
    pub fn focus(&self, host: &impl WindowHost, page_id: &str) -> Result<bool, String> {
        let known = self.lock().pages.get(page_id).cloned();
        match known.filter(|l| host.exists(l)) {
            Some(label) => host.focus(&label).map(|_| true),
            None => Ok(false),
        }
    }

    pub fn list(&self) -> Vec<PageWindowInfo> {
        let mut out: Vec<_> = self
            .lock()
            .pages
            .iter()
            .map(|(page_id, label)| PageWindowInfo { page_id: page_id.clone(), label: label.clone() })
            .collect();
        out.sort_by(|a, b| a.page_id.cmp(&b.page_id));
        out
    }

    /// The main window asked to close (`exit`: an app quit). Returns true if the close must be
    /// prevented (a handshake is running). With no page window open this is exactly the
    /// single-window handshake on the main window.
    pub fn request_main_close(&self, host: &impl CloseHost, exit: bool) -> bool {
        let pending: Vec<String> = {
            let mut r = self.lock();
            r.pages.retain(|_, label| host.exists(label));
            let labels: Vec<String> = r.pages.values().cloned().collect();
            r.main_close = if labels.is_empty() {
                None
            } else {
                Some(MainClose { exit, waiting: labels.iter().cloned().collect() })
            };
            labels
        };
        if pending.is_empty() {
            return host.start_close(MAIN_LABEL, exit);
        }
        for label in &pending {
            // Fail open like a single window: an unresponsive page window is closed outright.
            if !host.start_close(label, false) {
                host.destroy(label);
            }
        }
        true
    }

    /// A window was destroyed: forget it, and start the main window's own handshake once the last
    /// page window a main close was waiting for is gone.
    pub fn window_destroyed(&self, host: &impl CloseHost, label: &str) {
        let close_main = {
            let mut r = self.lock();
            r.pages.retain(|_, l| l != label);
            if label == MAIN_LABEL {
                r.main_close = None;
                None
            } else {
                let done = r.main_close.as_mut().is_some_and(|mc| mc.waiting.remove(label) && mc.waiting.is_empty());
                if done { r.main_close.take().map(|mc| mc.exit) } else { None }
            }
        };
        if let Some(exit) = close_main
            && !host.start_close(MAIN_LABEL, exit)
        {
            host.destroy(MAIN_LABEL);
            if exit {
                host.exit_app();
            }
        }
    }

    /// A page window could not flush (it shows why): a main close waiting for it is cancelled.
    pub fn secondary_refused(&self, host: &impl CloseHost, label: &str) {
        let cancelled = {
            let mut r = self.lock();
            let waiting = r.main_close.as_ref().is_some_and(|mc| mc.waiting.contains(label));
            if waiting {
                r.main_close = None;
            }
            waiting
        };
        if cancelled {
            host.notify_close_refused();
        }
    }
}

/// The real window system.
pub struct TauriHost<'a>(pub &'a AppHandle);

impl WindowHost for TauriHost<'_> {
    fn exists(&self, label: &str) -> bool {
        self.0.get_webview_window(label).is_some()
    }

    fn focus(&self, label: &str) -> Result<(), String> {
        let w = self.0.get_webview_window(label).ok_or("window not found")?;
        let _ = w.unminimize();
        let _ = w.show();
        w.set_focus().map_err(|e| e.to_string())
    }

    fn create(&self, label: &str, url: &str, title: &str) -> Result<(), String> {
        // Native decorations; tauri-plugin-window-state restores size/position per label.
        WebviewWindowBuilder::new(self.0, label, WebviewUrl::App(url.into()))
            .title(title)
            .inner_size(WIDTH, HEIGHT)
            .min_inner_size(600.0, 400.0)
            .resizable(true)
            .build()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

impl CloseHost for TauriHost<'_> {
    fn exists(&self, label: &str) -> bool {
        self.0.get_webview_window(label).is_some()
    }

    fn start_close(&self, label: &str, exit: bool) -> bool {
        match self.0.get_webview_window(label) {
            Some(w) => lifecycle::start_attempt(&w.as_ref().window(), exit),
            None => false,
        }
    }

    fn destroy(&self, label: &str) {
        if let Some(w) = self.0.get_webview_window(label) {
            let _ = w.destroy();
        }
    }

    fn exit_app(&self) {
        self.0.exit(0);
    }

    fn notify_close_refused(&self) {
        if let Some(main) = self.0.get_webview_window(MAIN_LABEL) {
            let _ = main.eval("window.__mateCloseRefused && window.__mateCloseRefused()");
        }
    }
}

fn registry(app: &AppHandle) -> Option<tauri::State<'_, PageWindows>> {
    app.try_state::<PageWindows>()
}

/// `CloseRequested` / quit on the main window. True = prevent the close.
pub fn request_main_close(app: &AppHandle, exit: bool) -> bool {
    match registry(app) {
        Some(reg) => reg.request_main_close(&TauriHost(app), exit),
        None => TauriHost(app).start_close(MAIN_LABEL, exit),
    }
}

pub fn window_destroyed(app: &AppHandle, label: &str) {
    if let Some(reg) = registry(app) {
        reg.window_destroyed(&TauriHost(app), label);
    }
}

pub fn secondary_refused(app: &AppHandle, label: &str) {
    if is_page_window(label)
        && let Some(reg) = registry(app)
    {
        reg.secondary_refused(&TauriHost(app), label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Records calls; `alive` is the set of existing windows.
    #[derive(Default)]
    struct Fake {
        alive: RefCell<HashSet<String>>,
        unresponsive: RefCell<HashSet<String>>,
        log: RefCell<Vec<String>>,
    }

    impl Fake {
        fn with(labels: &[&str]) -> Fake {
            let f = Fake::default();
            f.alive.borrow_mut().extend(labels.iter().map(|l| l.to_string()));
            f
        }
        fn log(&self) -> Vec<String> {
            self.log.borrow().clone()
        }
        fn push(&self, s: String) {
            self.log.borrow_mut().push(s);
        }
    }

    impl WindowHost for Fake {
        fn exists(&self, label: &str) -> bool {
            self.alive.borrow().contains(label)
        }
        fn focus(&self, label: &str) -> Result<(), String> {
            self.push(format!("focus {label}"));
            Ok(())
        }
        fn create(&self, label: &str, url: &str, title: &str) -> Result<(), String> {
            self.push(format!("create {label} {url} {title}"));
            self.alive.borrow_mut().insert(label.to_owned());
            Ok(())
        }
    }

    impl CloseHost for Fake {
        fn exists(&self, label: &str) -> bool {
            self.alive.borrow().contains(label)
        }
        fn start_close(&self, label: &str, exit: bool) -> bool {
            self.push(format!("start {label} exit={exit}"));
            !self.unresponsive.borrow().contains(label)
        }
        fn destroy(&self, label: &str) {
            self.push(format!("destroy {label}"));
            self.alive.borrow_mut().remove(label);
        }
        fn exit_app(&self) {
            self.push("exit".into());
        }
        fn notify_close_refused(&self) {
            self.push("refused".into());
        }
    }

    /// The frontend of `label` flushed and destroyed its window.
    fn flushed(reg: &PageWindows, host: &Fake, label: &str) {
        host.alive.borrow_mut().remove(label);
        reg.window_destroyed(host, label);
    }

    #[test]
    fn second_open_focuses_existing_window() {
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        assert_eq!(reg.open(&host, "p1", "Algebra").unwrap(), "page-p1");
        assert_eq!(reg.open(&host, "p1", "Algebra").unwrap(), "page-p1");
        assert_eq!(host.log(), vec!["create page-p1 /edit/p1?window=1 Algebra", "focus page-p1"]);
        assert!(reg.focus(&host, "p1").unwrap());
        assert!(!reg.focus(&host, "p2").unwrap());
        assert_eq!(reg.list(), vec![PageWindowInfo { page_id: "p1".into(), label: "page-p1".into() }]);
        assert!(reg.open(&host, "../x", "x").is_err());
        assert!(reg.open(&host, "", "x").is_err());
    }

    #[test]
    fn destroyed_window_clears_registry() {
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        reg.open(&host, "p1", "A").unwrap();
        reg.open(&host, "p2", "B").unwrap();
        flushed(&reg, &host, "page-p1");
        assert_eq!(reg.list(), vec![PageWindowInfo { page_id: "p2".into(), label: "page-p2".into() }]);
        // Opening it again creates a fresh window.
        reg.open(&host, "p1", "A").unwrap();
        assert_eq!(host.log().iter().filter(|l| l.starts_with("create page-p1")).count(), 2);
    }

    #[test]
    fn close_main_waits_for_secondary_flush() {
        // No page window: the single-window handshake on main, unchanged.
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        assert!(reg.request_main_close(&host, false));
        assert_eq!(host.log(), vec!["start main exit=false"]);
        host.unresponsive.borrow_mut().insert("main".into());
        assert!(!reg.request_main_close(&host, false), "unresponsive main closes at once");

        // Two page windows: both flush first, main's own handshake starts after the last one.
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        reg.open(&host, "p1", "A").unwrap();
        reg.open(&host, "p2", "B").unwrap();
        host.log.borrow_mut().clear();
        assert!(reg.request_main_close(&host, true));
        let mut started = host.log();
        started.sort();
        assert_eq!(started, vec!["start page-p1 exit=false", "start page-p2 exit=false"]);
        flushed(&reg, &host, "page-p1");
        assert!(!host.log().iter().any(|l| l.starts_with("start main")), "main waits for p2");
        flushed(&reg, &host, "page-p2");
        assert_eq!(host.log().last().unwrap(), "start main exit=true");
        assert!(reg.list().is_empty());

        // A page window that cannot flush cancels the main close; main is never started.
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        reg.open(&host, "p1", "A").unwrap();
        reg.open(&host, "p2", "B").unwrap();
        host.log.borrow_mut().clear();
        assert!(reg.request_main_close(&host, false));
        reg.secondary_refused(&host, "page-p1");
        assert!(host.log().contains(&"refused".to_owned()));
        flushed(&reg, &host, "page-p2");
        assert!(!host.log().iter().any(|l| l.starts_with("start main") || l == "destroy main"));
        // A later refusal or destroy outside a main close does nothing.
        reg.secondary_refused(&host, "page-p1");
        assert_eq!(host.log().iter().filter(|l| *l == "refused").count(), 1);

        // An unresponsive page window is destroyed (fail open); an unresponsive main then too.
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        reg.open(&host, "p1", "A").unwrap();
        host.unresponsive.borrow_mut().extend(["page-p1".to_owned(), "main".to_owned()]);
        host.log.borrow_mut().clear();
        assert!(reg.request_main_close(&host, true));
        assert_eq!(host.log(), vec!["start page-p1 exit=false", "destroy page-p1"]);
        reg.window_destroyed(&host, "page-p1");
        assert_eq!(&host.log()[2..], ["start main exit=true", "destroy main", "exit"]);
    }

    #[test]
    fn opening_is_refused_while_main_is_closing() {
        let reg = PageWindows::default();
        let host = Fake::with(&["main"]);
        reg.open(&host, "p1", "A").unwrap();
        assert!(reg.request_main_close(&host, false));
        assert!(reg.open(&host, "p2", "B").is_err());
    }
}
