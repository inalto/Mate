//! Practice questions from a book: the book's recognised text goes to the AI provider (text only,
//! never ink) and the parsed questions come back. Needs `aiConsent` and a stored key.

use mate_core::ai::practice::{self, PracticeQuestion, QuestionType};
use tauri::{AppHandle, Manager};

use super::recognize::RecognizeError;
use super::semantics::{gated_provider, internal_error};
use crate::state::AppState;

type Res<T> = Result<T, RecognizeError>;

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
        let settings = state.settings.lock().map_err(internal_error)?.clone();
        // Gate first: with AI off nothing is read or sent.
        let provider = gated_provider(&settings, state.keys.as_ref())?;
        let text = {
            let st = state.storage.lock().map_err(internal_error)?;
            st.unit_recognised_text(&unit_id).map_err(internal_error)?
        };
        if text.trim().is_empty() {
            return Err(internal_error(NOTHING_RECOGNISED));
        }
        Ok(practice::generate_questions(provider.as_ref(), &text, count, &types, custom_prompt.as_deref())?)
    })
    .await
    .map_err(internal_error)?
}
