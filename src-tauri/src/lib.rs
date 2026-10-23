mod commands;
mod state;

use commands::{
  ai, archive, assets, elements, export, lifecycle, notebook, pdf, recognition, recognize, settings,
  thumbnails,
};
use state::AppState;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // Must be registered first. "Open with Mate" while Mate runs starts a second process (Windows,
    // Linux): it exits at once and its argv/cwd arrive here, so one process owns the database.
    // macOS never starts a second instance; opens arrive as `RunEvent::Opened` (see below).
    .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
      if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
      }
      if let Some(path) = pdf::pdf_from_args(argv, std::path::Path::new(&cwd))
        && std::path::Path::new(&path).is_file()
      {
        pdf::file_opened(app, path);
      }
    }))
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
      app.manage(pdf::PendingOpenFile::new(pdf::pdf_from_args(
        std::env::args(),
        &std::env::current_dir().unwrap_or_default(),
      )));
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
      recognition::get_recognitions,
      recognition::upsert_recognition,
      recognition::set_user_override,
      recognition::search_recognition,
      recognition::record_learning_event,
      recognize::recognize_group,
      settings::get_settings,
      settings::set_settings,
      ai::set_ai_key,
      ai::clear_ai_key,
      ai::get_ai_status,
      ai::test_ai_key,
      thumbnails::save_thumbnail,
      assets::save_asset,
      assets::save_asset_from_path,
      assets::asset_info,
      assets::delete_asset,
      assets::read_asset,
      assets::gc_assets,
      pdf::read_shared_pdf,
      pdf::take_pending_open_file,
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
      // macOS delivers "Open with Mate" (and double-clicked .pdf files) as an event, not argv.
      #[cfg(any(target_os = "macos", target_os = "ios"))]
      if let RunEvent::Opened { urls } = &event {
        for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
          pdf::file_opened(app, path.to_string_lossy().into_owned());
        }
      }
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
