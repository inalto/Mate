//! Practice questions generated from a book's recognised text: the prompt, the strict JSON
//! schema, the request builder and the reply parser. Text only: ink is never sent.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::provider::{AiError, Provider, TextRequest};

/// At most this many questions per request.
pub const MAX_QUESTIONS: usize = 20;
/// At most this many characters of the book's text are sent.
pub const MAX_INPUT_CHARS: usize = 8_000;
const TRUNCATED_NOTE: &str = "\n(truncated)";
const MAX_CUSTOM_PROMPT_CHARS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuestionType {
    MultipleChoice,
    MultiSelect,
    TrueFalse,
    FillInBlank,
    ShortAnswer,
}

impl QuestionType {
    pub const ALL: [QuestionType; 5] = [
        QuestionType::MultipleChoice,
        QuestionType::MultiSelect,
        QuestionType::TrueFalse,
        QuestionType::FillInBlank,
        QuestionType::ShortAnswer,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            QuestionType::MultipleChoice => "multiple-choice",
            QuestionType::MultiSelect => "multi-select",
            QuestionType::TrueFalse => "true-false",
            QuestionType::FillInBlank => "fill-in-blank",
            QuestionType::ShortAnswer => "short-answer",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PracticeQuestion {
    pub problem_text: String,
    pub problem_latex: String,
    pub question_type: QuestionType,
    pub expected_answer: String,
    pub solution_latex: String,
}

const SYSTEM: &str = "You write practice questions for a student, based only on the notes you are \
given (text recognised from their handwritten notebook, LaTeX for maths, in reading order). Write \
questions that test the ideas in the notes at a similar level; do not invent topics the notes do \
not cover. For each question give: problemText (the question in plain words, with any answer \
options written out for multiple-choice and multi-select), problemLatex (the maths of the question \
as LaTeX, or an empty string), questionType (one of the allowed types), expectedAnswer (a short \
final answer the student's work can be compared to) and solutionLatex (a worked solution as LaTeX, \
or an empty string). Reply with JSON only, matching the schema.";

/// The strict JSON schema of a reply: closed objects, every field required.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["questions"],
        "properties": {
            "questions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["problemText", "problemLatex", "questionType", "expectedAnswer", "solutionLatex"],
                    "properties": {
                        "problemText": {"type": "string"},
                        "problemLatex": {"type": "string"},
                        "questionType": {"type": "string", "enum": QuestionType::ALL.map(QuestionType::as_str)},
                        "expectedAnswer": {"type": "string"},
                        "solutionLatex": {"type": "string"}
                    }
                }
            }
        }
    })
}

/// Keeps the first [`MAX_INPUT_CHARS`] characters, appending "(truncated)" when it cut anything.
pub fn truncate_input(text: &str) -> String {
    match text.char_indices().nth(MAX_INPUT_CHARS) {
        None => text.to_string(),
        Some((end, _)) => format!("{}{TRUNCATED_NOTE}", &text[..end]),
    }
}

/// The provider request for `count` questions (clamped to 1..=20) of the given `types` (all five
/// when empty), from `book_text`, with an optional extra instruction from the student.
pub fn build_practice_request(
    book_text: &str,
    count: usize,
    types: &[QuestionType],
    custom_prompt: Option<&str>,
) -> TextRequest {
    let count = count.clamp(1, MAX_QUESTIONS);
    let mut chosen: Vec<QuestionType> = Vec::new();
    for t in if types.is_empty() { &QuestionType::ALL[..] } else { types } {
        if !chosen.contains(t) {
            chosen.push(*t);
        }
    }
    let type_list = chosen.iter().map(|t| t.as_str()).collect::<Vec<_>>().join(", ");
    let mut user = format!("Write exactly {count} questions. Allowed question types: {type_list}.\n");
    if let Some(p) = custom_prompt.map(str::trim).filter(|p| !p.is_empty()) {
        let p: String = p.chars().take(MAX_CUSTOM_PROMPT_CHARS).collect();
        user.push_str(&format!("The student also asks: {p}\n"));
    }
    user.push_str("\nNotes:\n");
    user.push_str(&truncate_input(book_text));
    TextRequest { system: SYSTEM.into(), user, max_tokens: 4096, json_schema: Some(schema()) }
}

/// The JSON object inside `text`, tolerating markdown fences and prose around it.
fn json_slice(text: &str) -> &str {
    let t = text.trim();
    match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if a < b => &t[a..=b],
        _ => t,
    }
}

/// Parses a reply into questions. Lenient about wrapping (fences, surrounding prose, enum case),
/// strict about shape: every field present, no unknown fields, a known question type, at least
/// one question.
pub fn parse_questions(text: &str) -> Result<Vec<PracticeQuestion>, AiError> {
    let bad = |m: &str| AiError::InvalidResponse(m.to_string());
    let mut v: Value = serde_json::from_str(json_slice(text)).map_err(|_| bad("the answer was not JSON"))?;
    let list = v
        .get_mut("questions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| bad("no questions in the answer"))?;
    for q in list.iter_mut() {
        if let Some(s) = q["questionType"].as_str() {
            q["questionType"] = Value::String(s.trim().to_lowercase().replace(['_', ' '], "-"));
        }
    }
    let questions: Vec<PracticeQuestion> = serde_json::from_value(v["questions"].take())
        .map_err(|e| AiError::InvalidResponse(format!("unexpected fields: {e}")))?;
    if questions.is_empty() {
        return Err(bad("the answer had no questions"));
    }
    if questions.iter().any(|q| q.problem_text.trim().is_empty() && q.problem_latex.trim().is_empty()) {
        return Err(bad("a question was empty"));
    }
    Ok(questions)
}

/// One provider call and the parsed questions (at most `count`).
pub fn generate_questions(
    provider: &dyn Provider,
    book_text: &str,
    count: usize,
    types: &[QuestionType],
    custom_prompt: Option<&str>,
) -> Result<Vec<PracticeQuestion>, AiError> {
    let count = count.clamp(1, MAX_QUESTIONS);
    let reply = provider.complete(&build_practice_request(book_text, count, types, custom_prompt))?;
    let mut qs = parse_questions(&reply)?;
    // A model may write more than asked; extra questions are silently dropped.
    qs.truncate(count);
    Ok(qs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::mock::MockProvider;

    const REPLY: &str = r#"{"questions":[{"problemText":"Differentiate x^2.","problemLatex":"\\frac{d}{dx}x^2","questionType":"short-answer","expectedAnswer":"2x","solutionLatex":"2x"},{"problemText":"True or false: 1+1=2","problemLatex":"","questionType":"true-false","expectedAnswer":"true","solutionLatex":""}]}"#;

    #[test]
    fn practice_parses_questions() {
        let qs = parse_questions(REPLY).unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].question_type, QuestionType::ShortAnswer);
        assert_eq!(qs[0].expected_answer, "2x");
        assert_eq!(qs[1].question_type, QuestionType::TrueFalse);
        // fences and prose around the JSON, and a differently written type
        let fenced = format!("Here you go:\n```json\n{}\n```", REPLY.replace("true-false", "True_False"));
        assert_eq!(parse_questions(&fenced).unwrap(), qs);
        // strict shape
        let extra = REPLY.replace("\"solutionLatex\":\"2x\"", "\"solutionLatex\":\"2x\",\"extra\":1");
        let essay = REPLY.replace("short-answer", "essay");
        for bad in [
            "not json",
            r#"{"questions":[]}"#,
            r#"{"items":[]}"#,
            r#"{"questions":[{"problemText":"a"}]}"#,
            essay.as_str(),
            extra.as_str(),
        ] {
            assert!(matches!(parse_questions(bad), Err(AiError::InvalidResponse(_))), "{bad}");
        }
    }

    #[test]
    fn request_clamps_count_and_truncates_input() {
        let long = "Q".repeat(MAX_INPUT_CHARS + 50);
        let r = build_practice_request(&long, 99, &[QuestionType::TrueFalse, QuestionType::TrueFalse], Some("  focus on limits "));
        assert!(r.user.contains("exactly 20 questions"));
        assert!(r.user.contains("Allowed question types: true-false."));
        assert!(r.user.contains("focus on limits"));
        assert!(r.user.ends_with("(truncated)"));
        assert_eq!(r.user.matches('Q').count(), MAX_INPUT_CHARS);
        assert!(build_practice_request("a", 0, &[], None).user.contains("exactly 1 questions"));
        assert!(build_practice_request("a", 3, &[], None).user.contains("multiple-choice, multi-select"));
        let s = r.json_schema.unwrap();
        assert_eq!(s["additionalProperties"], false);
        assert_eq!(s["properties"]["questions"]["items"]["required"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn generate_uses_provider_and_caps_count() {
        let p = MockProvider::new(vec![]).with_text(vec![Ok(REPLY.into())]);
        let qs = generate_questions(&p, "notes", 1, &[], None).unwrap();
        assert_eq!(qs.len(), 1);
        assert_eq!(p.text_requests().len(), 1);
    }
}
