//! Page summaries and title suggestions: text-only provider calls, cached per page text.

use std::sync::Mutex;

use serde::Serialize;

use super::PageSemantics;
use crate::ai::provider::{AiError, Provider, TextRequest};
use crate::storage::Storage;

/// At most this many characters of page text are sent to the provider.
pub const MAX_INPUT_CHARS: usize = 8_000;
const TRUNCATED_NOTE: &str = "\n(truncated)";

const SUMMARY_SYSTEM: &str = "You help a student review their handwritten notes. You are given \
the text recognised from one notebook page, in reading order (LaTeX for maths). Write a short \
summary: at most five sentences or bullet points, plain language, no preamble. Do not invent \
content that is not on the page.";

const TITLE_SYSTEM: &str = "You name pages in a student's notebook. You are given the text \
recognised from one page, in reading order (LaTeX for maths). Reply with one short, specific \
title of at most six words. Reply with the title only: no quotes, no trailing full stop.";

/// Why a summary or title could not be made: the provider's own failure (kept typed, so the app
/// can tell a rejected key from a busy service) or anything else, already worded for the user.
#[derive(Debug, thiserror::Error)]
pub enum SummaryError {
    #[error("{0}")]
    Ai(#[from] AiError),
    #[error("{0}")]
    Other(String),
}

impl From<String> for SummaryError {
    fn from(s: String) -> Self {
        SummaryError::Other(s)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    Summary,
    Title,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Generated {
    /// The summary or the suggested title.
    pub text: String,
    /// True when it came from the cache and nothing was sent anywhere.
    pub cached: bool,
}

/// Keeps the first [`MAX_INPUT_CHARS`] characters and appends "(truncated)" when it cut anything.
pub fn truncate_input(text: &str) -> String {
    match text.char_indices().nth(MAX_INPUT_CHARS) {
        None => text.to_string(),
        Some((end, _)) => format!("{}{TRUNCATED_NOTE}", &text[..end]),
    }
}

fn clean_title(raw: &str) -> String {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let t = line
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '\u{201c}' | '\u{201d}'))
        .trim_end_matches('.');
    t.chars().take(80).collect::<String>().trim().to_string()
}

/// One provider call for `text` (already non-empty). Input is truncated before sending.
pub fn generate(provider: &dyn Provider, task: Task, text: &str) -> Result<String, AiError> {
    let (system, max_tokens) = match task {
        Task::Summary => (SUMMARY_SYSTEM, 600),
        Task::Title => (TITLE_SYSTEM, 60),
    };
    let reply = provider.complete(&TextRequest {
        system: system.into(),
        user: truncate_input(text),
        max_tokens,
        json_schema: None,
    })?;
    let out = match task {
        Task::Summary => reply.trim().to_string(),
        Task::Title => clean_title(&reply),
    };
    if out.is_empty() {
        return Err(AiError::InvalidResponse("the reply was empty".into()));
    }
    Ok(out)
}

/// Summary or title for a page, reusing the stored one while the page text is unchanged. The
/// storage lock is not held during the provider call. The caller has already checked consent
/// and the key (see the Tauri command); `provider` is the gated provider.
pub fn generate_for_page(
    storage: &Mutex<Storage>,
    provider: &dyn Provider,
    page_id: &str,
    task: Task,
) -> Result<Generated, SummaryError> {
    let (text, hash, existing) = {
        let st = storage.lock().map_err(|e| e.to_string())?;
        let text = st.page_recognised_text(page_id).map_err(|e| e.to_string())?;
        let hash = super::content_hash(&text);
        (text, hash, st.get_page_semantics(page_id).map_err(|e| e.to_string())?)
    };
    if text.trim().is_empty() {
        return Err(SummaryError::Other(
            "Nothing on this page has been recognised yet. Write something and let the tutor read it first.".into(),
        ));
    }
    let fresh = existing.filter(|s| s.content_hash.as_deref() == Some(hash.as_str()));
    let cached = fresh.as_ref().and_then(|s| match task {
        Task::Summary => s.summary.clone(),
        Task::Title => s.suggested_title.clone(),
    });
    if let Some(text) = cached {
        return Ok(Generated { text, cached: true });
    }
    let out = generate(provider, task, &text)?;
    let mut sem = fresh.unwrap_or_else(|| PageSemantics {
        page_id: page_id.to_string(),
        summary: None,
        suggested_title: None,
        topics: Vec::new(),
        content_hash: Some(hash),
        updated_at: String::new(),
    });
    match task {
        Task::Summary => sem.summary = Some(out.clone()),
        Task::Title => sem.suggested_title = Some(out.clone()),
    }
    storage
        .lock()
        .map_err(|e| e.to_string())?
        .upsert_page_semantics(&sem)
        .map_err(|e| e.to_string())?;
    Ok(Generated { text: out, cached: false })
}
