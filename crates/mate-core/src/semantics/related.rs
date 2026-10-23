//! Related pages and the page-similarity graph, from local TF-IDF over recognised text.

use serde::Serialize;

use super::tfidf::{TfIdf, Vector, cosine, tokenize};

/// Pages scoring below this are not related.
pub const MIN_RELATED_SCORE: f64 = 0.2;
/// The graph keeps at most this many pages (those with the most recognised text) ...
pub const MAX_GRAPH_NODES: usize = 500;
/// ... and at most this many edges (the strongest).
pub const MAX_GRAPH_EDGES: usize = 5000;

/// One live page and all its recognised text.
#[derive(Debug, Clone)]
pub struct PageDoc {
    pub page_id: String,
    pub title: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedPage {
    pub page_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub page_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GraphEdge {
    pub a: String,
    pub b: String,
    pub score: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

fn vectors(docs: &[PageDoc]) -> Vec<Vector> {
    let tokens: Vec<Vec<String>> = docs.iter().map(|d| tokenize(&d.text)).collect();
    let model = TfIdf::fit(&tokens);
    tokens.iter().map(|t| model.vectorize(t)).collect()
}

/// Pages most similar to `page_id`, best first, scoring at least [`MIN_RELATED_SCORE`].
/// Empty when the page has no recognised text.
pub fn related_pages(docs: &[PageDoc], page_id: &str, limit: usize) -> Vec<RelatedPage> {
    let Some(me) = docs.iter().position(|d| d.page_id == page_id) else {
        return Vec::new();
    };
    let vecs = vectors(docs);
    let mut out: Vec<RelatedPage> = docs
        .iter()
        .zip(&vecs)
        .enumerate()
        .filter(|(i, _)| *i != me)
        .map(|(_, (d, v))| RelatedPage { page_id: d.page_id.clone(), score: cosine(&vecs[me], v) })
        .filter(|r| r.score >= MIN_RELATED_SCORE)
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.page_id.cmp(&b.page_id)));
    out.truncate(limit);
    out
}

/// Nodes are pages with recognised text; edges join pages whose similarity is at least
/// `min_score`. Capped at [`MAX_GRAPH_NODES`] / [`MAX_GRAPH_EDGES`].
pub fn page_graph(docs: &[PageDoc], min_score: f64) -> PageGraph {
    let mut docs: Vec<PageDoc> = docs.iter().filter(|d| !tokenize(&d.text).is_empty()).cloned().collect();
    if docs.len() > MAX_GRAPH_NODES {
        docs.sort_by(|a, b| b.text.len().cmp(&a.text.len()).then_with(|| a.page_id.cmp(&b.page_id)));
        docs.truncate(MAX_GRAPH_NODES);
    }
    docs.sort_by(|a, b| a.page_id.cmp(&b.page_id));
    let vecs = vectors(&docs);
    let mut edges = Vec::new();
    for i in 0..docs.len() {
        for j in (i + 1)..docs.len() {
            let score = cosine(&vecs[i], &vecs[j]);
            if score >= min_score && score > 0.0 {
                edges.push(GraphEdge { a: docs[i].page_id.clone(), b: docs[j].page_id.clone(), score });
            }
        }
    }
    edges.sort_by(|x, y| y.score.total_cmp(&x.score));
    edges.truncate(MAX_GRAPH_EDGES);
    PageGraph {
        nodes: docs.into_iter().map(|d| GraphNode { page_id: d.page_id, title: d.title }).collect(),
        edges,
    }
}
