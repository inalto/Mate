//! A small TF-IDF model over page text: tokeniser, weighted vectors and cosine similarity.

use std::collections::HashMap;

/// Lowercases and splits on non-alphanumerics. LaTeX backslashes are dropped but command names
/// stay as tokens (`\frac{1}{2}` gives `frac`); one-character tokens (single letters, digits)
/// are dropped as noise.
pub fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() > 1)
        .map(str::to_string)
        .collect()
}

/// A sparse, L2-normalised TF-IDF vector.
pub type Vector = HashMap<String, f64>;

/// IDF weights learned from a corpus, used to vectorise its documents.
pub struct TfIdf {
    idf: HashMap<String, f64>,
}

impl TfIdf {
    /// Smoothed inverse document frequency: `ln((1 + N) / (1 + df)) + 1`, so a term in every
    /// document still counts a little and never gets zero or negative weight.
    pub fn fit(docs: &[Vec<String>]) -> TfIdf {
        let mut df: HashMap<&str, usize> = HashMap::new();
        for doc in docs {
            let mut seen: Vec<&str> = doc.iter().map(String::as_str).collect();
            seen.sort_unstable();
            seen.dedup();
            for t in seen {
                *df.entry(t).or_default() += 1;
            }
        }
        let n = docs.len() as f64;
        let idf = df
            .into_iter()
            .map(|(t, d)| (t.to_string(), ((1.0 + n) / (1.0 + d as f64)).ln() + 1.0))
            .collect();
        TfIdf { idf }
    }

    /// The document's vector: `(1 + ln tf) * idf`, normalised to unit length. Terms unseen in the
    /// corpus are ignored. An empty document gives an empty vector.
    pub fn vectorize(&self, tokens: &[String]) -> Vector {
        let mut tf: HashMap<&str, f64> = HashMap::new();
        for t in tokens {
            *tf.entry(t.as_str()).or_default() += 1.0;
        }
        let mut v: Vector = tf
            .into_iter()
            .filter_map(|(t, c)| self.idf.get(t).map(|w| (t.to_string(), (1.0 + c.ln()) * w)))
            .collect();
        let norm = v.values().map(|x| x * x).sum::<f64>().sqrt();
        if norm > 0.0 {
            for x in v.values_mut() {
                *x /= norm;
            }
        }
        v
    }
}

/// Cosine similarity of two unit vectors (their dot product), in `0..=1`.
pub fn cosine(a: &Vector, b: &Vector) -> f64 {
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    small.iter().filter_map(|(t, x)| large.get(t).map(|y| x * y)).sum::<f64>().min(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizer_keeps_latex_command_names_and_drops_single_chars() {
        assert_eq!(tokenize(r"\frac{x}{2} + sin(x)^2"), vec!["frac", "sin"]);
        assert_eq!(tokenize("Hello, World 42"), vec!["hello", "world", "42"]);
    }
}
