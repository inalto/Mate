mod commands;
mod state;
mod windows;

use commands::{
  ai, archive, ask, assets, elements, export, haptics, import, lifecycle, notebook, open_files, pdf, practice, recognition, recognize, settings,
  semantics, thumbnails, updater,
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
      open_files::args_opened(app, argv, std::path::Path::new(&cwd));
    }))
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
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
      let cwd = std::env::current_dir().unwrap_or_default();
      app.manage(open_files::PendingImportFiles::new(open_files::import_paths_from_args(std::env::args(), &cwd)));
      app.manage(import::ImportControl::default());
      app.manage(crate::windows::PageWindows::default());
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
      ask::tutor_ask,
      semantics::summarize_page,
      semantics::suggest_title,
      semantics::related_pages,
      semantics::page_graph,
      practice::practice_generate,
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
      open_files::take_pending_import_files,
      import::sniff_import_files,
      import::import_files,
      import::cancel_import,
      export::write_export_file,
      archive::export_unit_archive,
      archive::import_unit_archive,
      archive::export_backup,
      archive::reset_local_data,
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
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // macOS delivers "Open with Mate" (and double-clicked .pdf files) as an event, not argv.
      #[cfg(any(target_os = "macos", target_os = "ios"))]
      if let RunEvent::Opened { urls } = &event {
        for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
          open_files::file_opened(app, path.to_string_lossy().into_owned());
        }
      }
      // macOS: Cmd+Q, the app menu "Quit" and Dock "Quit" end the app without a window
      // `CloseRequested`, so they would skip the flush handshake. Route a user-initiated exit
      // (`code: None`; a programmatic `app.exit` carries a code) through the same close attempt on
      // the main window. On Windows/Linux this event fires after the last window was destroyed,
      // when there is no main window any more, so it passes through unchanged.
      if let RunEvent::ExitRequested { api, code: None, .. } = event
        && app.get_webview_window(crate::windows::MAIN_LABEL).is_some()
        && crate::windows::request_main_close(app, true)
      {
        api.prevent_exit();
      }
    });
}
