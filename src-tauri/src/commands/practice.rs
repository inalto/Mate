//! Practice questions from a book: the book's recognised text goes to the AI provider (text only,
//! never ink) and the parsed questions come back. Needs `aiConsent` and a stored key.

use mate_core::ai::practice::{self, PracticeQuestion, QuestionType};
use tauri::{AppHandle, Manager};

use super::semantics::gated_provider;
use crate::state::AppState;

type Res<T> = Result<T, String>;

const NOTHING_RECOGNISED: &str =
    "Nothing in this book has been recognised yet. Write some notes and let the tutor read them first.";

#[tauri::command]
pub async fn practice_generate(
    app: AppHandle,
    unit_id: String,
    count: usize,
    types: Vec<QuestionType>,
    custom_prompt: Option<String>,
) -> Res<Vec<PracticeQuestion>> {
    // Keychain access can block on an OS prompt, so everything runs off the async runtime. The
    // storage lock is held only while reading the text, never during the provider call.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().map_err(|e| e.to_string())?.clone();
        // Gate first: with AI off nothing is read or sent.
        let provider = gated_provider(&settings, state.keys.as_ref()).map_err(|e| e.to_string())?;
        let text = {
            let st = state.storage.lock().map_err(|e| e.to_string())?;
            st.unit_recognised_text(&unit_id).map_err(|e| e.to_string())?
        };
        if text.trim().is_empty() {
            return Err(NOTHING_RECOGNISED.to_string());
        }
        practice::generate_questions(provider.as_ref(), &text, count, &types, custom_prompt.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
