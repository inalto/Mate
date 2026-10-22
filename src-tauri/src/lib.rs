mod commands;
mod state;

use commands::{archive, elements, export, lifecycle, notebook, settings, thumbnails};
use state::AppState;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        // Fail open: if the frontend never acknowledged the previous attempt, let the window close.
        if lifecycle::start_close_attempt(window) {
          api.prevent_close();
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let state = AppState::init(app.handle())?;
      app.manage(state);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      notebook::get_notebook_tree,
      notebook::upsert_bookshelf,
      notebook::upsert_unit,
      notebook::upsert_section,
      notebook::upsert_page,
      notebook::soft_delete_entity,
      notebook::restore_entity,
      notebook::list_trash,
      notebook::purge_entity,
      notebook::purge_trash_older_than,
      elements::load_elements,
      elements::upsert_elements,
      elements::delete_elements,
      settings::get_settings,
      settings::set_settings,
      thumbnails::save_thumbnail,
      export::write_export_file,
      archive::export_unit_archive,
      archive::import_unit_archive,
      lifecycle::close_attempt_started,
      lifecycle::cancel_close_attempt,
      lifecycle::complete_close_attempt,
      lifecycle::write_recovery_artifact,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // macOS: Cmd+Q, the app menu "Quit" and Dock "Quit" end the app without a window
      // `CloseRequested`, so they would skip the flush handshake. Route a user-initiated exit
      // (`code: None`; a programmatic `app.exit` carries a code) through the same close attempt on
      // the main window. On Windows/Linux this event fires after the last window was destroyed,
      // when there is no main window any more, so it passes through unchanged.
      if let RunEvent::ExitRequested { api, code: None, .. } = event
        && let Some(main) = app.get_webview_window("main")
        && lifecycle::start_exit_attempt(&main.as_ref().window())
      {
        api.prevent_exit();
      }
    });
}
