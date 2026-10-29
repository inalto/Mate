mod commands;
mod state;
// The page-window registry and close ordering; on mobile only the close handshake helpers are used.
#[cfg_attr(mobile, allow(dead_code))]
mod windows;

use commands::{
  ai, archive, ask, assets, elements, export, haptics, import, lifecycle, math, notebook, open_files, pdf, platform, practice, recognition, recognize,
  settings, semantics, thumbnails, updater,
};
use state::AppState;
use tauri::{Manager, RunEvent};
#[cfg(desktop)]
use tauri::WindowEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();
  // Desktop only: single instance, window geometry, in-app updates, and the close handshake on
  // window close. A mobile app is never closed by the user the way a desktop window is.
  #[cfg(desktop)]
  let builder = builder
    // Must be registered first. "Open with Mate" while Mate runs starts a second process (Windows,
    // Linux): it exits at once and its argv/cwd arrive here, so one process owns the database.
    // macOS never starts a second instance; opens arrive as `RunEvent::Opened` (see below).
    .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
      if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
      }
      open_files::args_opened(app, argv, std::path::Path::new(&cwd));
    }))
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .on_window_event(|window, event| match event {
      WindowEvent::CloseRequested { api, .. } => {
        // Fail open: if the frontend never acknowledged the previous attempt, let the window close.
        // The main window first closes every page window through its own handshake.
        let prevent = if window.label() == crate::windows::MAIN_LABEL {
          crate::windows::request_main_close(window.app_handle(), false)
        } else {
          lifecycle::start_close_attempt(window)
        };
        if prevent {
          api.prevent_close();
        }
      }
      WindowEvent::Destroyed => crate::windows::window_destroyed(window.app_handle(), window.label()),
      _ => {}
    });
  // Mobile only: reads the `content://` URIs other apps hand to Mate, from Rust (commands/incoming.rs).
  // Exports go to the share sheet, from Rust (commands/export.rs).
  #[cfg(mobile)]
  let builder = builder.plugin(tauri_plugin_fs::init()).plugin(tauri_plugin_sharekit::init());
  builder
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_clipboard_manager::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      let state = AppState::init(app.handle())?;
      // The asset protocol scope in tauri.conf.json covers the normal app-data folder only; a
      // `MATE_DATA_DIR` profile needs its thumbnails and assets allowed at runtime.
      if std::env::var_os("MATE_DATA_DIR").is_some_and(|v| !v.is_empty()) {
        for sub in ["thumbnails", "assets"] {
          let dir = state.data_dir.join(sub);
          let _ = std::fs::create_dir_all(&dir);
          app.asset_protocol_scope().allow_directory(&dir, true)?;
        }
      }
      // Old recovery files are not kept forever.
      commands::lifecycle::prune_recovery_files(&state.data_dir, commands::lifecycle::KEEP_RECOVERY_FILES);
      // Files received from other apps (Android) are copies; drop the ones a day old.
      commands::incoming::prune_incoming(&state.data_dir.join(commands::incoming::INCOMING_DIR), commands::incoming::KEEP_INCOMING);
      // Exports (mobile) wait in `exports/` for the share target; drop the ones a week old.
      commands::incoming::prune_incoming(&state.data_dir.join(export::EXPORTS_DIR), export::KEEP_EXPORTS);
      app.manage(state);
      app.manage(pdf::PendingOpenFile::new(pdf::pdf_from_args(
        std::env::args(),
        &std::env::current_dir().unwrap_or_default(),
      )));
      let cwd = std::env::current_dir().unwrap_or_default();
      app.manage(open_files::PendingImportFiles::new(open_files::import_paths_from_args(std::env::args(), &cwd)));
      app.manage(import::ImportControl::default());
      app.manage(crate::windows::PageWindows::default());
      app.manage(commands::share::ShareState::default());
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      notebook::get_notebook_tree,
      notebook::upsert_bookshelf,
      notebook::move_bookshelf,
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
      ask::tutor_ask,
      semantics::summarize_page,
      semantics::suggest_title,
      semantics::related_pages,
      semantics::page_graph,
      practice::practice_generate,
      settings::get_settings,
      settings::patch_settings,
      ai::set_ai_key,
      ai::clear_ai_key,
      ai::get_ai_status,
      ai::test_ai_key,
      ai::list_ai_providers,
      ai::list_ai_models,
      commands::speech::list_speech_providers,
      commands::speech::get_speech_status,
      commands::speech::set_speech_key,
      commands::speech::clear_speech_key,
      commands::speech::transcribe_audio,
      commands::speech::test_speech_key,
      commands::speech::tidy_dictation,
      math::set_wolfram_appid,
      math::clear_wolfram_appid,
      math::wolfram_status,
      math::test_wolfram_appid,
      math::wolfram_short_answer,
      thumbnails::save_thumbnail,
      thumbnails::thumbnails_dir,
      assets::save_asset,
      assets::save_asset_from_path,
      assets::asset_info,
      assets::delete_asset,
      assets::read_asset,
      assets::gc_assets,
      pdf::read_shared_pdf,
      pdf::take_pending_open_file,
      open_files::take_pending_import_files,
      import::sniff_import_files,
      import::import_files,
      import::cancel_import,
      export::write_export_file,
      archive::export_unit_archive,
      archive::import_unit_archive,
      archive::export_backup,
      archive::reset_local_data,
      archive::take_reset_incomplete,
      commands::share::detect_sync_folders,
      commands::share::save_archive_to,
      commands::share::pick_folder,
      commands::share::nextcloud_status,
      commands::share::nextcloud_login_start,
      commands::share::nextcloud_login_poll,
      commands::share::nextcloud_logout,
      commands::share::nextcloud_share,
      lifecycle::close_attempt_started,
      lifecycle::cancel_close_attempt,
      lifecycle::complete_close_attempt,
      lifecycle::write_recovery_artifact,
      commands::windows::open_page_window,
      commands::windows::focus_page_window,
      commands::windows::list_page_windows,
      haptics::pen_haptics_pulse,
      updater::check_for_update,
      updater::install_update,
      updater::relaunch,
      updater::report_flush,
      platform::platform_info,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // macOS delivers "Open with Mate" (and double-clicked .pdf files) as an event, not argv.
      // Android delivers the intent's data URI the same way: a `file://` URI maps to a path, a
      // `content://` URI from another app is copied into `incoming/` first (commands/incoming.rs).
      #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
      if let RunEvent::Opened { urls } = &event {
        for url in urls {
          #[cfg(target_os = "android")]
          if url.scheme() == "content" {
            commands::incoming::content_uri_opened(app, url.clone());
            continue;
          }
          if let Ok(path) = url.to_file_path() {
            open_files::file_opened(app, path.to_string_lossy().into_owned());
          }
        }
      }
      // macOS: Cmd+Q, the app menu "Quit" and Dock "Quit" end the app without a window
      // `CloseRequested`, so they would skip the flush handshake. Route a user-initiated exit
      // (`code: None`; a programmatic `app.exit` carries a code) through the same close attempt on
      // the main window. On Windows/Linux this event fires after the last window was destroyed,
      // when there is no main window any more, so it passes through unchanged.
      #[cfg(desktop)]
      if let RunEvent::ExitRequested { api, code: None, .. } = event
        && app.get_webview_window(crate::windows::MAIN_LABEL).is_some()
        && crate::windows::request_main_close(app, true)
      {
        api.prevent_exit();
      }
    });
}
