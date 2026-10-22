mod commands;
mod state;

use commands::{elements, notebook, settings, thumbnails};
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_window_state::Builder::default().build())
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
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
