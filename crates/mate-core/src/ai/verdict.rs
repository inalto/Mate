//! The tutor's verdict on one handwritten line, as returned by an AI provider.
//!
//! The wire format is camelCase (for TS and for the providers' structured-output schema). Parsing
//! is lenient: unknown enum strings fall back instead of failing, and missing optional fields
//! default. Call [`Verdict::validate`] after parsing; it applies the cross-field rules and fills
//! the derived `code` and `kind`.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Domain {
    Arithmetic,
    Algebra,
    Calculus,
    Geometry,
    Trigonometry,
    Physics,
    #[default]
    #[serde(other)]
    Other,
}

impl Domain {
    pub const ALL: [&'static str; 7] = [
        "arithmetic",
        "algebra",
        "calculus",
        "geometry",
        "trigonometry",
        "physics",
        "other",
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorNature {
    Slip,
    Procedural,
    Conceptual,
}

impl ErrorNature {
    pub const ALL: [&'static str; 3] = ["slip", "procedural", "conceptual"];

    fn parse(s: &str) -> Option<ErrorNature> {
        match s {
            "slip" => Some(ErrorNature::Slip),
            "procedural" => Some(ErrorNature::Procedural),
            "conceptual" => Some(ErrorNature::Conceptual),
            _ => None,
        }
    }
}

/// An unknown error nature reads as "not given" rather than failing the whole verdict.
fn lenient_error_nature<'de, D: Deserializer<'de>>(d: D) -> Result<Option<ErrorNature>, D::Error> {
    let raw: Option<String> = Option::deserialize(d)?;
    Ok(raw.as_deref().and_then(ErrorNature::parse))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionKind {
    Code,
    #[default]
    #[serde(other)]
    Text,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transcription {
    pub kind: TranscriptionKind,
    pub text: String,
}

/// The overlay's summary code, derived from the verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerdictCode {
    #[default]
    Incomplete,
    Ok,
    Conceptual,
    Arithmetic,
    Algebra,
    Calculus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VerdictKind {
    #[default]
    Math,
    Diagram,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Verdict {
    pub description: String,
    pub latex: String,
    pub correct: Option<bool>,
    pub domain: Domain,
    #[serde(deserialize_with = "lenient_error_nature")]
    pub error_nature: Option<ErrorNature>,
    pub hint: Option<String>,
    pub explanation: Option<String>,
    pub next_steps: Option<String>,
    pub focus_span: Option<String>,
    pub illegible: bool,
    pub transcription: Option<Transcription>,
    /// Derived by [`Verdict::validate`]; never read from a provider.
    #[serde(skip_deserializing)]
    pub code: VerdictCode,
    /// Derived by [`Verdict::validate`]; never read from a provider.
    #[serde(skip_deserializing)]
    pub kind: VerdictKind,
}

impl Verdict {
    /// Applies the cross-field rules and fills `code` and `kind`.
    pub fn validate(&mut self) {
        if self.correct != Some(false) {
            self.error_nature = None;
        }
        self.code = self.derived_code();
        self.kind = if self.latex.trim().is_empty() {
            VerdictKind::Diagram
        } else {
            VerdictKind::Math
        };
    }

    fn derived_code(&self) -> VerdictCode {
        match self.correct {
            None => VerdictCode::Incomplete,
            Some(true) => VerdictCode::Ok,
            Some(false) if self.error_nature == Some(ErrorNature::Conceptual) => VerdictCode::Conceptual,
            Some(false) => match self.domain {
                Domain::Arithmetic => VerdictCode::Arithmetic,
                Domain::Algebra => VerdictCode::Algebra,
                Domain::Calculus => VerdictCode::Calculus,
                _ => VerdictCode::Conceptual,
            },
        }
    }

    /// Strict JSON schema for structured output: every object closes `additionalProperties`,
    /// lists every property as required, and expresses optionality as `anyOf [T, null]`.
    pub fn json_schema() -> Value {
        let nullable = |t: Value| json!({ "anyOf": [t, { "type": "null" }] });
        let string = || json!({ "type": "string" });
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": [
                "description", "latex", "correct", "domain", "errorNature", "hint",
                "explanation", "nextSteps", "focusSpan", "illegible", "transcription"
            ],
            "properties": {
                "description": string(),
                "latex": string(),
                "correct": nullable(json!({ "type": "boolean" })),
                "domain": { "type": "string", "enum": Domain::ALL },
                "errorNature": nullable(json!({ "type": "string", "enum": ErrorNature::ALL })),
                "hint": nullable(string()),
                "explanation": nullable(string()),
                "nextSteps": nullable(string()),
                "focusSpan": nullable(string()),
                "illegible": { "type": "boolean" },
                "transcription": nullable(json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["kind", "text"],
                    "properties": {
                        "kind": { "type": "string", "enum": ["text", "code"] },
                        "text": string()
                    }
                }))
            }
        })
    }
}
