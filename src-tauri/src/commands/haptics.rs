//! Pen haptics (Windows only): a short buzz-while-inking and a click, sent to a haptic pen through
//! WinRT `Windows.Devices.Input.PenDevice` → `SimpleHapticsController`.
//!
//! The frontend calls `pen_haptics_pulse` fire-and-forget (it never awaits the result). The command
//! only queues the request: the WinRT calls run on one background worker thread, so they never block
//! the UI or the IPC thread, and an `inkStart` is always handled before the `inkStop` that follows it
//! (separate blocking tasks could run out of order and leave the pen buzzing). Every failure (no pen
//! device, a pen without haptics, an API error) is a silent no-op; other platforms do nothing.

use serde::Deserialize;

/// What the frontend asks for: the start or end of an ink contact, or a one-shot click.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HapticKind {
    InkStart,
    InkStop,
    Click,
}

/// The `KnownSimpleHapticsControllerWaveforms` a kind plays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waveform {
    InkContinuous,
    Click,
}

/// The waveform `kind` starts, or `None` for `inkStop` (which stops the running feedback instead).
pub fn waveform_for(kind: HapticKind) -> Option<Waveform> {
    match kind {
        HapticKind::InkStart => Some(Waveform::InkContinuous),
        HapticKind::Click => Some(Waveform::Click),
        HapticKind::InkStop => None,
    }
}

/// Plays haptic feedback on the pen behind `pointer_id` (the DOM `PointerEvent.pointerId`).
/// Returns at once and always succeeds; the work happens on the haptics worker thread. `async` so
/// Tauri runs it off the main thread.
#[tauri::command]
pub async fn pen_haptics_pulse(pointer_id: u32, kind: HapticKind) -> Result<(), String> {
    imp::enqueue(pointer_id, kind);
    Ok(())
}

#[cfg(not(windows))]
mod imp {
    use super::HapticKind;

    /// No pen haptics outside Windows.
    pub fn enqueue(_pointer_id: u32, _kind: HapticKind) {}
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use std::sync::mpsc::{Sender, channel};

    use ::windows::Devices::Haptics::{
        KnownSimpleHapticsControllerWaveforms, SimpleHapticsController, SimpleHapticsControllerFeedback,
    };
    use ::windows::Devices::Input::PenDevice;

    use super::{HapticKind, Waveform, waveform_for};

    /// Highest Windows pointer id tried when the DOM pointer id is not a Windows pen pointer id.
    const MAX_SCANNED_POINTER_ID: u32 = 64;

    static WORKER: OnceLock<Option<Sender<(u32, HapticKind)>>> = OnceLock::new();

    /// Queues a request for the worker thread (started on first use). Never blocks, never fails.
    pub fn enqueue(pointer_id: u32, kind: HapticKind) {
        let worker = WORKER.get_or_init(|| {
            let (tx, rx) = channel::<(u32, HapticKind)>();
            std::thread::Builder::new()
                .name("pen-haptics".into())
                .spawn(move || {
                    let mut haptics = Haptics::default();
                    for (id, kind) in rx {
                        haptics.pulse(id, kind);
                    }
                })
                .ok()
                .map(|_| tx)
        });
        if let Some(tx) = worker {
            let _ = tx.send((pointer_id, kind));
        }
    }

    /// The controller of the pen in contact, cached per DOM pointer id from `inkStart` to `inkStop`.
    #[derive(Default)]
    pub struct Haptics {
        controllers: HashMap<u32, SimpleHapticsController>,
        /// The Windows pointer id that last resolved to a haptic pen (tried first next time).
        last_pen_id: Option<u32>,
    }

    impl Haptics {
        /// Handles one request; every error is swallowed.
        pub fn pulse(&mut self, pointer_id: u32, kind: HapticKind) {
            let _ = self.try_pulse(pointer_id, kind);
        }

        fn try_pulse(&mut self, pointer_id: u32, kind: HapticKind) -> ::windows::core::Result<()> {
            let Some(waveform) = waveform_for(kind) else {
                // inkStop: stop and forget this contact's controller.
                if let Some(controller) = self.controllers.remove(&pointer_id) {
                    controller.StopFeedback()?;
                }
                return Ok(());
            };
            let controller = match self.controllers.get(&pointer_id) {
                Some(c) => c.clone(),
                None => {
                    let Some(c) = self.resolve(pointer_id) else { return Ok(()) };
                    // Only an ink contact is cached; a click outside a contact keeps nothing alive.
                    if kind == HapticKind::InkStart {
                        self.controllers.insert(pointer_id, c.clone());
                    }
                    c
                }
            };
            let Some(feedback) = find_feedback(&controller, waveform)? else { return Ok(()) };
            controller.SendHapticFeedback(&feedback)
        }

        /// The haptics controller of the pen behind the DOM pointer id `dom_id`, if any.
        fn resolve(&mut self, dom_id: u32) -> Option<SimpleHapticsController> {
            for id in windows_pointer_id_candidates(dom_id, self.last_pen_id) {
                if let Some(c) = controller_for(id) {
                    self.last_pen_id = Some(id);
                    return Some(c);
                }
            }
            None
        }
    }

    /// Windows pointer ids that may belong to the pen behind the DOM pointer id `dom_id`, most likely
    /// first. This is the single place mapping DOM ids to Windows ids.
    ///
    /// Chromium (and so WebView2) does not expose the platform pointer id: Blink's
    /// `PointerEventFactory` gives every new (type, platform id) pair the next value of a counter
    /// (mouse is 1, others start at 2). So the DOM id is only tried first; then the id that resolved
    /// last time, then the small ids Windows hands out to active pointers. `PenDevice` only resolves
    /// an id that is a pen in contact or in range, so a wrong id fails and the next is tried.
    pub fn windows_pointer_id_candidates(dom_id: u32, last_pen_id: Option<u32>) -> Vec<u32> {
        let mut ids = vec![dom_id];
        if let Some(last) = last_pen_id
            && last != dom_id
        {
            ids.push(last);
        }
        ids.extend((1..=MAX_SCANNED_POINTER_ID).filter(|i| *i != dom_id && Some(*i) != last_pen_id));
        ids
    }

    fn controller_for(windows_pointer_id: u32) -> Option<SimpleHapticsController> {
        let pen = PenDevice::GetFromPointerId(windows_pointer_id).ok()?;
        pen.SimpleHapticsController().ok()
    }

    fn find_feedback(
        controller: &SimpleHapticsController,
        waveform: Waveform,
    ) -> ::windows::core::Result<Option<SimpleHapticsControllerFeedback>> {
        let wanted = match waveform {
            Waveform::InkContinuous => KnownSimpleHapticsControllerWaveforms::InkContinuous()?,
            Waveform::Click => KnownSimpleHapticsControllerWaveforms::Click()?,
        };
        let supported = controller.SupportedFeedback()?;
        for i in 0..supported.Size()? {
            let feedback = supported.GetAt(i)?;
            if feedback.Waveform()? == wanted {
                return Ok(Some(feedback));
            }
        }
        Ok(None)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn bogus_pointer_id_is_a_silent_noop() {
            let mut h = Haptics::default();
            for kind in [HapticKind::InkStart, HapticKind::Click, HapticKind::InkStop] {
                h.pulse(u32::MAX - 7, kind);
            }
            assert!(h.controllers.is_empty());
        }

        #[test]
        fn candidates_try_dom_id_then_last_then_scan_without_duplicates() {
            let ids = windows_pointer_id_candidates(3, Some(5));
            assert_eq!(&ids[..3], &[3, 5, 1]);
            let mut sorted = ids.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), ids.len());
            assert_eq!(ids.len() as u32, MAX_SCANNED_POINTER_ID);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_maps_to_waveform() {
        assert_eq!(waveform_for(HapticKind::InkStart), Some(Waveform::InkContinuous));
        assert_eq!(waveform_for(HapticKind::Click), Some(Waveform::Click));
        assert_eq!(waveform_for(HapticKind::InkStop), None);
    }

    #[test]
    fn kind_deserializes_from_camel_case() {
        let k: Vec<HapticKind> = serde_json::from_str(r#"["inkStart","inkStop","click"]"#).unwrap();
        assert_eq!(k, vec![HapticKind::InkStart, HapticKind::InkStop, HapticKind::Click]);
    }

    #[test]
    fn bogus_pointer_id_returns_ok() {
        for kind in [HapticKind::InkStart, HapticKind::Click, HapticKind::InkStop] {
            assert_eq!(tauri::async_runtime::block_on(pen_haptics_pulse(u32::MAX - 7, kind)), Ok(()));
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_is_noop() {
        use tauri::async_runtime::block_on;
        assert_eq!(block_on(pen_haptics_pulse(2, HapticKind::InkStart)), Ok(()));
        assert_eq!(block_on(pen_haptics_pulse(2, HapticKind::InkStop)), Ok(()));
    }
}
