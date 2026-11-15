mod common;

use common::{page, section, seeded, stroke, unit};
use mate_core::model::{Element, ElementType, PenStyle, ShapeType};
use mate_core::storage::{EntityKind, LearningEvent, RECALL_KIND, RecallAnswer, Storage};
use serde_json::json;

fn answer(page_id: &str, element: &str, knew: bool, run: &str) -> RecallAnswer {
    RecallAnswer { page_id: page_id.into(), element_id: element.into(), knew, run_id: run.into() }
}

fn event(page_id: &str, kind: &str, payload: serde_json::Value, at: &str) -> LearningEvent {
    LearningEvent {
        id: String::new(),
        page_id: page_id.into(),
        stroke_group_id: None,
        kind: kind.into(),
        payload,
        created_at: at.into(),
    }
}

/// A recall row stamped by hand, so tests can place answers at chosen times.
fn row_at(st: &mut Storage, page_id: &str, element: &str, knew: bool, run: &str, at: &str) {
    let payload = json!({ "elementId": element, "knew": knew, "runId": run });
    st.record_learning_event(&event(page_id, RECALL_KIND, payload, at)).unwrap();
}

fn cover_stroke(id: &str, page_id: &str) -> Element {
    Element { pen_style: Some(PenStyle::Cover), ..stroke(id, page_id, 3) }
}

fn box_cover(id: &str, page_id: &str, cover: bool) -> Element {
    Element {
        r#type: ElementType::Shape,
        pen_style: None,
        shape_type: Some(ShapeType::Rectangle),
        content: Some(json!({ "cover": cover })),
        ..stroke(id, page_id, 0)
    }
}

/// One run of `total` answers, the first `known` of them known, a second apart on `day`.
fn run(st: &mut Storage, page_id: &str, run_id: &str, known: u32, total: u32, day: &str) {
    for i in 0..total {
        row_at(st, page_id, &format!("e{i}"), i < known, run_id, &format!("{day}T10:00:{i:02}.000Z"));
    }
}

#[test]
fn an_answer_is_stored_as_a_recall_learning_event() {
    let mut st = seeded();
    st.record_recall(&answer("p1", "c1", true, "r1")).unwrap();
    let rows = st.learning_events("p1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, "recall");
    assert_eq!(rows[0].page_id, "p1");
    assert_eq!(rows[0].payload, json!({ "elementId": "c1", "knew": true, "runId": "r1" }));
    assert!(st.record_recall(&answer("p1", "", true, "r1")).is_err());
    assert!(st.record_recall(&answer("p1", "c1", true, "")).is_err());
}

#[test]
fn page_stats_count_runs_and_the_last_score() {
    let mut st = seeded();
    run(&mut st, "p1", "A", 3, 4, "2026-11-01");
    run(&mut st, "p1", "B", 1, 2, "2026-11-02");
    let s = st.recall_page("p1").unwrap();
    assert_eq!((s.answers, s.known, s.runs), (6, 4, 2));
    let last = s.last.unwrap();
    assert_eq!((last.run_id.as_str(), last.known, last.total), ("B", 1, 2));
    assert_eq!(last.at, "2026-11-02T10:00:01.000Z");
    assert_eq!(s.trend, vec![0.75, 0.5]);
}

#[test]
fn the_trend_keeps_the_last_eight_runs() {
    let mut st = seeded();
    for d in 1..=10u32 {
        // Run `d` knows `d % 2` of its 2 answers, so the rates alternate 0.5, 0.0.
        run(&mut st, "p1", &format!("r{d}"), d % 2, 2, &format!("2026-11-{d:02}"));
    }
    let s = st.recall_page("p1").unwrap();
    assert_eq!(s.runs, 10);
    assert_eq!(s.trend, vec![0.5, 0.0, 0.5, 0.0, 0.5, 0.0, 0.5, 0.0]);
    assert_eq!(s.last.unwrap().run_id, "r10");
}

#[test]
fn covers_count_live_stroke_and_box_covers_only() {
    let mut st = seeded();
    st.upsert_elements(&[
        cover_stroke("c1", "p1"),
        cover_stroke("c2", "p1"),
        box_cover("b1", "p1", true),
        box_cover("plain", "p1", false),
        stroke("ink", "p1", 3),
    ])
    .unwrap();
    assert_eq!(st.recall_page("p1").unwrap().covers, 3);
    st.delete_elements(&["c2".to_string()]).unwrap();
    assert_eq!(st.recall_page("p1").unwrap().covers, 2);
}

#[test]
fn rows_of_a_deleted_cover_still_count() {
    let mut st = seeded();
    st.upsert_elements(&[cover_stroke("c1", "p1")]).unwrap();
    st.record_recall(&answer("p1", "c1", true, "r1")).unwrap();
    st.delete_elements(&["c1".to_string()]).unwrap();
    let s = st.recall_page("p1").unwrap();
    assert_eq!((s.covers, s.answers, s.known), (0, 1, 1));
    // The page is still listed in the unit because it has a recall row.
    let u = st.recall_unit("u1", "2030-01-01T00:00:00.000Z").unwrap();
    assert_eq!(u.pages.len(), 1);
}

#[test]
fn unit_stats_window_by_days() {
    let mut st = seeded();
    st.upsert_elements(&[cover_stroke("c1", "p1")]).unwrap();
    let now = "2026-11-15T12:00:00.000Z";
    row_at(&mut st, "p1", "c1", true, "r1", "2026-11-12T12:00:00.000Z"); // 3 days
    row_at(&mut st, "p1", "c1", false, "r2", "2026-11-05T12:00:00.000Z"); // 10 days
    row_at(&mut st, "p1", "c1", true, "r3", "2026-10-06T12:00:00.000Z"); // 40 days
    let u = st.recall_unit("u1", now).unwrap();
    assert_eq!(u.covers, 1);
    assert_eq!((u.all.answers, u.all.known), (3, 2));
    assert_eq!((u.last7.answers, u.last7.known), (1, 1));
    assert_eq!((u.last30.answers, u.last30.known), (2, 1));
    assert!(st.recall_unit("u1", "not a time").is_err());
}

#[test]
fn unit_stats_skip_trashed_pages_and_other_units() {
    let mut st = seeded();
    st.upsert_page(&page("p2", "sec1", None)).unwrap();
    st.upsert_unit(&unit("u2", None)).unwrap();
    st.upsert_section(&section("sec2", "u2")).unwrap();
    st.upsert_page(&page("other", "sec2", None)).unwrap();
    st.record_recall(&answer("p1", "a", true, "r1")).unwrap();
    st.record_recall(&answer("p2", "b", true, "r1")).unwrap();
    st.record_recall(&answer("other", "c", true, "r1")).unwrap();
    let now = "2030-01-01T00:00:00.000Z";
    assert_eq!(st.recall_unit("u1", now).unwrap().all.answers, 2);
    st.soft_delete(EntityKind::Page, "p2").unwrap();
    let u = st.recall_unit("u1", now).unwrap();
    assert_eq!(u.all.answers, 1);
    assert_eq!(u.pages.iter().map(|p| p.page_id.as_str()).collect::<Vec<_>>(), ["p1"]);
}

#[test]
fn element_history_returns_the_last_five_oldest_first() {
    let mut st = seeded();
    for i in 0..7u32 {
        row_at(&mut st, "p1", "c1", i % 2 == 0, &format!("r{i}"), &format!("2026-11-0{}T10:00:00.000Z", i + 1));
    }
    row_at(&mut st, "p1", "c10", false, "x", "2026-11-09T10:00:00.000Z");
    // Answers 0..=6 alternate true/false from true; the last five are 2..=6.
    assert_eq!(st.recall_element("c1", 5).unwrap(), vec![true, false, true, false, true]);
    assert!(st.recall_element("nope", 5).unwrap().is_empty());
}

#[test]
fn a_malformed_payload_is_ignored() {
    let mut st = seeded();
    let at = "2026-11-01T10:00:00.000Z";
    for payload in [
        json!("text"),
        json!({ "elementId": "c1" }),
        json!({ "elementId": "c1", "knew": "yes", "runId": "r" }),
    ] {
        st.record_learning_event(&event("p1", RECALL_KIND, payload, at)).unwrap();
    }
    st.record_recall(&answer("p1", "c1", true, "r1")).unwrap();
    let s = st.recall_page("p1").unwrap();
    assert_eq!((s.answers, s.known, s.runs), (1, 1, 1));
    assert_eq!(st.recall_element("c1", 5).unwrap(), vec![true]);
}

#[test]
fn tutor_events_are_not_recall() {
    let mut st = seeded();
    let payload = json!({ "elementId": "c1", "knew": true, "runId": "r1" });
    st.record_learning_event(&event("p1", "attempt", payload, "")).unwrap();
    let s = st.recall_page("p1").unwrap();
    assert_eq!((s.answers, s.runs), (0, 0));
    assert!(s.last.is_none());
    assert!(st.recall_unit("u1", "2030-01-01T00:00:00.000Z").unwrap().pages.is_empty());
    assert!(st.recall_element("c1", 5).unwrap().is_empty());
}

#[test]
fn recall_rows_returns_only_the_units_recall_rows() {
    let mut st = seeded();
    st.upsert_unit(&unit("u2", None)).unwrap();
    st.upsert_section(&section("sec2", "u2")).unwrap();
    st.upsert_page(&page("other", "sec2", None)).unwrap();
    st.record_recall(&answer("p1", "c1", true, "r1")).unwrap();
    st.record_recall(&answer("other", "c2", true, "r1")).unwrap();
    st.record_learning_event(&event("p1", "attempt", json!({}), "")).unwrap();
    let rows = st.recall_rows("u1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].kind.as_str(), rows[0].page_id.as_str()), ("recall", "p1"));
}
