mod common;

use std::sync::Mutex;

use common::{page, seeded, stroke};
use mate_core::ai::mock::MockProvider;
use mate_core::ai::provider::AiError;
use mate_core::ai::verdict::Verdict;
use mate_core::semantics::related::{PageDoc, related_pages as related_from_docs};
use mate_core::semantics::summary::{self, MAX_INPUT_CHARS, Task};
use mate_core::semantics::tfidf::{TfIdf, cosine, tokenize};
use mate_core::storage::{Bounds, Recognition, RecognitionSource, Storage};

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Writes one recognised group on `page` at (`x`, `y`) with the given latex.
fn recognise(st: &mut Storage, page: &str, group: &str, x: f64, y: f64, latex: &str) {
    let el = format!("el-{page}-{group}");
    st.upsert_elements(&[stroke(&el, page, 3)]).unwrap();
    st.upsert_recognition(&Recognition {
        page_id: page.into(),
        stroke_group_id: group.into(),
        element_ids: vec![el],
        bounds: Bounds { x, y, width: 100.0, height: 20.0 },
        verdict: Verdict { latex: latex.into(), ..Verdict::default() },
        captured_at: now_ms() + 5,
        source: RecognitionSource::Auto,
        user_override: false,
        provider: "mock".into(),
        model: "m".into(),
        created_at: String::new(),
        updated_at: String::new(),
    })
    .unwrap();
}

fn with_pages(ids: &[&str]) -> Storage {
    let mut st = seeded();
    for id in ids {
        st.upsert_page(&page(id, "sec1", None)).unwrap();
    }
    st
}

fn doc(id: &str, text: &str) -> PageDoc {
    PageDoc { page_id: id.into(), title: id.into(), text: text.into() }
}

#[test]
fn tfidf_cosine_related_pages() {
    // Tokeniser: lowercase, latex command names kept, one-character tokens dropped.
    assert_eq!(tokenize(r"\Frac{x}{2}+Quadratic"), vec!["frac", "quadratic"]);

    let docs = [
        vec!["quadratic", "formula", "discriminant", "roots"],
        vec!["quadratic", "roots", "factorise", "discriminant"],
        vec!["mitochondria", "cell", "membrane", "nucleus"],
    ]
    .map(|d| d.into_iter().map(String::from).collect::<Vec<_>>());
    let model = TfIdf::fit(&docs);
    let v: Vec<_> = docs.iter().map(|d| model.vectorize(d)).collect();
    assert!((cosine(&v[0], &v[0]) - 1.0).abs() < 1e-9);
    assert!(cosine(&v[0], &v[1]) > 0.4);
    assert_eq!(cosine(&v[0], &v[2]), 0.0);

    // Through the store: the near page ranks first, the unrelated one is absent.
    let mut st = with_pages(&["p2", "p3", "p4"]);
    recognise(&mut st, "p1", "g1", 0.0, 0.0, r"\text{quadratic formula discriminant roots}");
    recognise(&mut st, "p2", "g1", 0.0, 0.0, r"\text{quadratic roots factorise discriminant}");
    recognise(&mut st, "p3", "g1", 0.0, 0.0, r"\text{mitochondria cell membrane nucleus}");
    let related = st.related_pages("p1", 5).unwrap();
    assert_eq!(related.len(), 1, "{related:?}");
    assert_eq!(related[0].page_id, "p2");
    assert!(related[0].score > 0.2 && related[0].score <= 1.0);
    // Pages without recognitions never appear, and an unknown page has no relatives.
    assert!(st.related_pages("nope", 5).unwrap().is_empty());
}

#[test]
fn related_threshold_0_2() {
    // Shares one of eight terms with the target: below 0.2. Shares four: above.
    let target = doc("t", "alpha beta gamma delta epsilon zeta eta theta");
    let weak = doc("weak", "alpha kappa lambda sigma omega rho tau phi");
    let strong = doc("strong", "alpha beta gamma delta kappa lambda sigma omega");
    let docs = [target, weak, strong];
    let out = related_from_docs(&docs, "t", 10);
    let ids: Vec<_> = out.iter().map(|r| r.page_id.as_str()).collect();
    assert_eq!(ids, ["strong"], "{out:?}");
    assert!(out.iter().all(|r| r.score >= 0.2));
    // The limit applies after ranking.
    let many = [doc("t", "alpha beta gamma"), doc("a", "alpha beta gamma"), doc("b", "alpha beta gamma delta")];
    let top = related_from_docs(&many, "t", 1);
    assert_eq!(top.len(), 1);
    assert_eq!(top[0].page_id, "a");
}

#[test]
fn page_graph_nodes_and_edges() {
    let mut st = with_pages(&["p2", "p3", "p4"]);
    recognise(&mut st, "p1", "g1", 0.0, 0.0, "quadratic formula discriminant roots");
    recognise(&mut st, "p2", "g1", 0.0, 0.0, "quadratic roots factorise discriminant");
    recognise(&mut st, "p3", "g1", 0.0, 0.0, "mitochondria cell membrane nucleus");
    let g = st.page_graph(0.2).unwrap();
    let nodes: Vec<_> = g.nodes.iter().map(|n| n.page_id.as_str()).collect();
    assert_eq!(nodes, ["p1", "p2", "p3"], "pages without text are not nodes");
    assert_eq!(g.nodes[0].title, "Page p1");
    assert_eq!(g.edges.len(), 1);
    assert_eq!((g.edges[0].a.as_str(), g.edges[0].b.as_str()), ("p1", "p2"));
    // A higher cutoff drops the edge; a trashed page leaves the graph.
    assert!(st.page_graph(0.99).unwrap().edges.is_empty());
    st.soft_delete(mate_core::storage::EntityKind::Page, "p2").unwrap();
    let g = st.page_graph(0.2).unwrap();
    assert_eq!(g.nodes.len(), 2);
    assert!(g.edges.is_empty());
    assert!(st.related_pages("p1", 5).unwrap().is_empty());
}

#[test]
fn page_text_is_in_reading_order_and_semantics_round_trip() {
    let mut st = seeded();
    recognise(&mut st, "p1", "c", 200.0, 100.0, "right");
    recognise(&mut st, "p1", "b", 10.0, 100.0, "left");
    recognise(&mut st, "p1", "a", 500.0, 10.0, "top");
    assert_eq!(st.page_recognised_text("p1").unwrap(), "top\nleft\nright");

    assert!(st.get_page_semantics("p1").unwrap().is_none());
    let sem = mate_core::semantics::PageSemantics {
        page_id: "p1".into(),
        summary: Some("s".into()),
        suggested_title: None,
        topics: vec!["algebra".into()],
        content_hash: Some(mate_core::semantics::content_hash("top\nleft\nright")),
        updated_at: String::new(),
    };
    st.upsert_page_semantics(&sem).unwrap();
    let got = st.get_page_semantics("p1").unwrap().unwrap();
    assert_eq!(got.summary.as_deref(), Some("s"));
    assert_eq!(got.topics, ["algebra"]);
    assert!(!got.updated_at.is_empty());
}

#[test]
fn summary_truncates_at_8000_chars() {
    let long = "é".repeat(MAX_INPUT_CHARS + 500);
    let cut = summary::truncate_input(&long);
    assert!(cut.ends_with("(truncated)"));
    assert_eq!(cut.chars().count(), MAX_INPUT_CHARS + "\n(truncated)".chars().count());
    // Exactly at the limit nothing is cut.
    let exact = "a".repeat(MAX_INPUT_CHARS);
    assert_eq!(summary::truncate_input(&exact), exact);

    // The provider request carries the truncated text.
    let mock = MockProvider::new(vec![]).with_text(vec![Ok("A summary.".into())]);
    let out = summary::generate(&mock, Task::Summary, &long).unwrap();
    assert_eq!(out, "A summary.");
    let sent = &mock.text_requests()[0];
    assert!(sent.user.ends_with("(truncated)"));
    assert!(sent.user.chars().count() <= MAX_INPUT_CHARS + 20);
    assert!(sent.json_schema.is_none());
}

#[test]
fn summaries_and_titles_are_cached_by_content_hash() {
    let mut st = seeded();
    recognise(&mut st, "p1", "g1", 0.0, 0.0, "x^2 + 1");
    let storage = Mutex::new(st);
    let mock = MockProvider::new(vec![]).with_text(vec![
        Ok("  Quadratics practice  ".into()),
        Ok("\"Solving quadratics.\"".into()),
        Ok("Second summary".into()),
    ]);

    let s = summary::generate_for_page(&storage, &mock, "p1", Task::Summary).unwrap();
    assert_eq!((s.text.as_str(), s.cached), ("Quadratics practice", false));
    let s = summary::generate_for_page(&storage, &mock, "p1", Task::Summary).unwrap();
    assert!(s.cached);
    assert_eq!(mock.text_requests().len(), 1, "the cached summary costs no request");

    // The title is its own cache slot under the same hash, cleaned of quotes and full stop.
    let t = summary::generate_for_page(&storage, &mock, "p1", Task::Title).unwrap();
    assert_eq!((t.text.as_str(), t.cached), ("Solving quadratics", false));

    // Changing the page text invalidates both.
    recognise(&mut storage.lock().unwrap(), "p1", "g2", 0.0, 50.0, "more ink");
    let s = summary::generate_for_page(&storage, &mock, "p1", Task::Summary).unwrap();
    assert_eq!((s.text.as_str(), s.cached), ("Second summary", false));
    let sem = storage.lock().unwrap().get_page_semantics("p1").unwrap().unwrap();
    assert!(sem.suggested_title.is_none(), "the old title belonged to the old text");
}

#[test]
fn empty_page_and_provider_errors_are_readable() {
    let storage = Mutex::new(seeded());
    let mock = MockProvider::new(vec![]);
    let err = summary::generate_for_page(&storage, &mock, "p1", Task::Summary).unwrap_err();
    assert!(err.contains("recognised"), "{err}");
    assert!(mock.text_requests().is_empty());

    recognise(&mut storage.lock().unwrap(), "p1", "g1", 0.0, 0.0, "hello");
    let failing = MockProvider::new(vec![]).with_text(vec![Err(AiError::Disabled)]);
    let err = summary::generate_for_page(&storage, &failing, "p1", Task::Title).unwrap_err();
    assert_eq!(err, AiError::Disabled.to_string());
    assert!(storage.lock().unwrap().get_page_semantics("p1").unwrap().is_none());
}

#[test]
fn unit_text_joins_pages_in_book_order_and_skips_empty_and_trashed() {
    let mut st = with_pages(&["p2", "p3", "p4"]);
    recognise(&mut st, "p1", "a", 0.0, 0.0, "first page");
    recognise(&mut st, "p3", "a", 0.0, 0.0, "third page");
    recognise(&mut st, "p4", "a", 0.0, 0.0, "trashed page");
    st.soft_delete(mate_core::storage::EntityKind::Page, "p4").unwrap();
    let unit_id = st.list_tree().unwrap().sections.iter().find(|s| s.id == "sec1").unwrap().unit_id.clone();
    assert_eq!(st.unit_recognised_text(&unit_id).unwrap(), "first page

third page");
    assert_eq!(st.unit_recognised_text("nope").unwrap(), "");
}
