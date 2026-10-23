mod common;

use common::{seeded, stroke};
use mate_core::ai::verdict::{Domain, ErrorNature, Transcription, TranscriptionKind, Verdict, VerdictCode};
use mate_core::model::{BackgroundConfig, PageMode};
use mate_core::storage::{
    Bounds, LearningEvent, Recognition, RecognitionSource, SNIPPET_CLOSE, SNIPPET_OPEN, Storage,
    UpsertOutcome,
};

fn verdict(latex: &str, description: &str, correct: Option<bool>) -> Verdict {
    Verdict {
        description: description.into(),
        latex: latex.into(),
        correct,
        domain: Domain::Algebra,
        error_nature: if correct == Some(false) { Some(ErrorNature::Slip) } else { None },
        hint: Some("Check the sign".into()),
        ..Verdict::default()
    }
}

fn rec(page_id: &str, group: &str, element_ids: &[&str], v: Verdict) -> Recognition {
    Recognition {
        page_id: page_id.into(),
        stroke_group_id: group.into(),
        element_ids: element_ids.iter().map(|s| s.to_string()).collect(),
        bounds: Bounds { x: 10.0, y: 20.0, width: 300.0, height: 40.0 },
        verdict: v,
        source: RecognitionSource::Auto,
        user_override: false,
        provider: "anthropic".into(),
        model: "claude-opus-5-5".into(),
        captured_at: now_ms(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Lets the wall clock move past the last element write, so "before"/"after" are unambiguous.
fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(5));
}

/// Writes strokes `ids` on page `p1`.
fn ink(st: &mut Storage, ids: &[&str]) {
    let strokes: Vec<_> = ids.iter().map(|id| stroke(id, "p1", 3)).collect();
    st.upsert_elements(&strokes).unwrap();
}

fn temp_db() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("mate-v1-{}.db", uuid::Uuid::new_v4()))
}

#[test]
fn migrates_v1_to_v2_keeping_data() {
    let path = temp_db();
    {
        // A database exactly as Phase 1/2 left it: schema v1 with a page and a stroke.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(include_str!("../src/storage/schema.sql")).unwrap();
        conn.execute("INSERT INTO schema_version (version) VALUES (1)", []).unwrap();
        let now = "2026-01-01T00:00:00.000Z";
        conn.execute(
            "INSERT INTO units (id, title, created_at, updated_at) VALUES ('u1', 'Maths', ?1, ?1)",
            [now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections (id, unit_id, title, color, created_at, updated_at) \
             VALUES ('sec1', 'u1', 'Algebra', '#ff8800', ?1, ?1)",
            [now],
        )
        .unwrap();
        let mode = serde_json::to_value(PageMode::Canvas).unwrap();
        let bg = serde_json::to_string(&BackgroundConfig::default()).unwrap();
        conn.execute(
            "INSERT INTO pages (id, section_id, title, mode, background_config, created_at, updated_at) \
             VALUES ('p1', 'sec1', 'Equations', ?1, ?2, ?3, ?3)",
            rusqlite::params![mode.as_str().unwrap(), bg, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO elements (id, page_id, type, points, color, width, created_at, updated_at) \
             VALUES ('e1', 'p1', 'stroke', '[{\"x\":1,\"y\":2,\"pressure\":0.5,\"timestamp\":0}]', \
                     '#000000', 3, ?1, ?1)",
            [now],
        )
        .unwrap();
    }

    let mut st = Storage::open(&path).unwrap();
    let tree = st.list_tree().unwrap();
    assert_eq!(tree.units.len(), 1);
    assert_eq!(tree.units[0].title, "Maths");
    assert_eq!(tree.pages.len(), 1);
    assert_eq!(tree.pages[0].title, "Equations");
    let els = st.load_elements("p1").unwrap();
    assert_eq!(els.len(), 1);
    assert_eq!(els[0].points[0].x, 1.0);

    // The v2 tables exist and work on the migrated database.
    st.upsert_recognition(&rec("p1", "g1", &["e1"], verdict("x+1=2", "linear equation", Some(true))))
        .unwrap();
    assert_eq!(st.get_recognitions("p1").unwrap().len(), 1);
    assert_eq!(st.search_recognition("linear", 10).unwrap().len(), 1);
    drop(st);

    // Reopening is a no-op migration and keeps everything.
    let st = Storage::open(&path).unwrap();
    assert_eq!(st.load_elements("p1").unwrap().len(), 1);
    assert_eq!(st.get_recognitions("p1").unwrap().len(), 1);
    drop(st);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn upsert_and_get_recognitions() {
    let mut st = seeded();
    ink(&mut st, &["e1", "e2", "e3", "e4"]);
    let mut v = verdict("2x+3=7", "solving for x", Some(false));
    v.transcription = Some(Transcription { kind: TranscriptionKind::Text, text: "two x plus three".into() });
    st.upsert_recognition(&rec("p1", "g1", &["e1", "e2"], v)).unwrap();
    st.upsert_recognition(&rec("p1", "g2", &["e3"], verdict("", "a triangle", None))).unwrap();

    let got = st.get_recognitions("p1").unwrap();
    assert_eq!(got.len(), 2);
    let g1 = got.iter().find(|r| r.stroke_group_id == "g1").unwrap();
    assert_eq!(g1.element_ids, vec!["e1", "e2"]);
    assert_eq!(g1.bounds, Bounds { x: 10.0, y: 20.0, width: 300.0, height: 40.0 });
    assert_eq!(g1.verdict.latex, "2x+3=7");
    assert_eq!(g1.verdict.correct, Some(false));
    assert_eq!(g1.verdict.error_nature, Some(ErrorNature::Slip));
    assert_eq!(g1.verdict.code, VerdictCode::Algebra);
    assert_eq!(g1.verdict.hint.as_deref(), Some("Check the sign"));
    assert_eq!(g1.verdict.transcription.as_ref().unwrap().text, "two x plus three");
    assert_eq!(g1.source, RecognitionSource::Auto);
    assert!(!g1.user_override);
    assert_eq!(g1.provider, "anthropic");
    assert!(!g1.created_at.is_empty());
    let g2 = got.iter().find(|r| r.stroke_group_id == "g2").unwrap();
    assert_eq!(g2.verdict.code, VerdictCode::Incomplete);
    assert_eq!(serde_json::to_value(g2.verdict.kind).unwrap(), "diagram");

    // Upserting the same key replaces the row (and its search text) and keeps created_at.
    let created = g1.created_at.clone();
    st.upsert_recognition(&rec("p1", "g1", &["e1", "e2"], verdict("2x=4", "simplified", Some(true))))
        .unwrap();
    let got = st.get_recognitions("p1").unwrap();
    assert_eq!(got.len(), 2);
    let g1 = got.iter().find(|r| r.stroke_group_id == "g1").unwrap();
    assert_eq!(g1.verdict.latex, "2x=4");
    assert_eq!(g1.verdict.code, VerdictCode::Ok);
    assert_eq!(g1.created_at, created);
    assert!(st.search_recognition("solving", 10).unwrap().is_empty());
    assert_eq!(st.search_recognition("simplified", 10).unwrap().len(), 1);

    // A new group that takes over elements of an older group supersedes it.
    st.upsert_recognition(&rec("p1", "g3", &["e2", "e4"], verdict("y=1", "merged line", None)))
        .unwrap();
    let ids: Vec<_> = st.get_recognitions("p1").unwrap().into_iter().map(|r| r.stroke_group_id).collect();
    assert!(!ids.contains(&"g1".to_string()));
    assert!(ids.contains(&"g2".to_string()) && ids.contains(&"g3".to_string()));

    // camelCase wire format, verdict fields flattened.
    let json = serde_json::to_value(&st.get_recognitions("p1").unwrap()[0]).unwrap();
    for key in ["pageId", "strokeGroupId", "elementIds", "bounds", "latex", "correct", "code", "kind",
        "errorNature", "userOverride", "source", "provider", "model", "createdAt", "updatedAt"] {
        assert!(json.get(key).is_some(), "missing {key} in {json}");
    }
    let back: Recognition = serde_json::from_value(json).unwrap();
    assert_eq!(back.page_id, "p1");

    // Learning events are recorded.
    st.record_learning_event(&LearningEvent {
        id: String::new(),
        page_id: "p1".into(),
        stroke_group_id: Some("g3".into()),
        kind: "hint_shown".into(),
        payload: serde_json::json!({ "step": "hint" }),
        created_at: String::new(),
    })
    .unwrap();
    let events = st.learning_events("p1").unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "hint_shown");
    assert!(!events[0].id.is_empty() && !events[0].created_at.is_empty());
}

#[test]
fn edit_invalidates_verdict_and_search() {
    let mut st = seeded();
    st.upsert_elements(&[stroke("e1", "p1", 3), stroke("e2", "p1", 3), stroke("e3", "p1", 3)])
        .unwrap();
    st.upsert_recognition(&rec("p1", "g1", &["e1", "e2"], verdict("a^2+b^2=c^2", "pythagoras", Some(true))))
        .unwrap();
    st.upsert_recognition(&rec("p1", "g2", &["e3"], verdict("\\sin x", "sine wave", None))).unwrap();
    assert_eq!(st.search_recognition("pythagoras", 10).unwrap().len(), 1);

    // Re-saving unchanged ink (e.g. an autosave flush) keeps the verdict.
    st.upsert_elements(&[stroke("e1", "p1", 3)]).unwrap();
    assert_eq!(st.get_recognitions("p1").unwrap().len(), 2);

    // Moving a stroke changes its points: the verdict and its search row go.
    let mut moved = stroke("e1", "p1", 3);
    for p in &mut moved.points {
        p.x += 50.0;
    }
    st.upsert_elements(&[moved]).unwrap();
    let left: Vec<_> = st.get_recognitions("p1").unwrap().into_iter().map(|r| r.stroke_group_id).collect();
    assert_eq!(left, vec!["g2"]);
    assert!(st.search_recognition("pythagoras", 10).unwrap().is_empty());

    // Erasing a stroke invalidates its group too.
    st.delete_elements(&["e3".to_string()]).unwrap();
    assert!(st.get_recognitions("p1").unwrap().is_empty());
    assert!(st.search_recognition("sine", 10).unwrap().is_empty());

    // Direct invalidation reports how many groups it removed.
    st.upsert_recognition(&rec("p1", "g4", &["e2"], verdict("x", "letter x", None))).unwrap();
    ink(&mut st, &["e9"]);
    st.upsert_recognition(&rec("p1", "g5", &["e9"], verdict("y", "letter y", None))).unwrap();
    assert_eq!(st.invalidate_recognition_for_elements(&["e2".into(), "e9".into(), "zz".into()]).unwrap(), 2);
    assert_eq!(st.invalidate_recognition_for_elements(&["e2".into()]).unwrap(), 0);
    assert!(st.search_recognition("letter", 10).unwrap().is_empty());
}

#[test]
fn search_ranks_matching_latex() {
    let mut st = seeded();
    ink(&mut st, &["e1", "e2", "e3"]);
    st.upsert_recognition(&rec("p1", "g1", &["e1"], verdict("\\int_0^1 x^2 dx", "integral of a square", None)))
        .unwrap();
    st.upsert_recognition(&rec(
        "p1",
        "g2",
        &["e2"],
        verdict("\\int x dx + \\int \\sin x dx + \\int e^x dx", "integral integral integral sums", None),
    ))
    .unwrap();
    st.upsert_recognition(&rec("p1", "g3", &["e3"], verdict("a+b", "sum of letters", None))).unwrap();

    let hits = st.search_recognition("integral", 10).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].stroke_group_id, "g2", "denser match ranks first: {hits:?}");
    assert!(hits[0].rank <= hits[1].rank);
    assert_eq!(hits[0].page_id, "p1");
    assert!(hits[0].snippet.contains(&format!("{SNIPPET_OPEN}integral{SNIPPET_CLOSE}")), "{:?}", hits[0].snippet);

    // LaTeX command names are searchable and the last token is a prefix.
    let hits = st.search_recognition("sin", 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].stroke_group_id, "g2");
    assert_eq!(st.search_recognition("integ", 10).unwrap().len(), 2);

    // Limit applies.
    assert_eq!(st.search_recognition("integral", 1).unwrap().len(), 1);

    // FTS5 syntax in user input never surfaces as an error.
    for q in ["\"", "AND", "a OR", "(x", "x^2*", "NEAR(", "-a", "col:x", "\\frac{", "''", "", "   ", "*"] {
        assert!(st.search_recognition(q, 10).is_ok(), "query {q:?} errored");
    }
    assert_eq!(st.search_recognition("x^2", 10).unwrap()[0].stroke_group_id, "g1");

    // Trashed pages are not searched.
    st.soft_delete(mate_core::storage::EntityKind::Page, "p1").unwrap();
    assert!(st.search_recognition("integral", 10).unwrap().is_empty());
}

#[test]
fn user_override_persists() {
    let path = temp_db();
    {
        let mut st = Storage::open(&path).unwrap();
        st.upsert_unit(&common::unit("u1", None)).unwrap();
        st.upsert_section(&common::section("sec1", "u1")).unwrap();
        st.upsert_page(&common::page("p1", "sec1", None)).unwrap();
        ink(&mut st, &["e1"]);
        st.upsert_recognition(&rec("p1", "g1", &["e1"], verdict("3+4=8", "addition", Some(false))))
            .unwrap();
        st.set_user_override("p1", "g1", true).unwrap();
        assert!(st.set_user_override("p1", "missing", true).is_err());
    }
    let mut st = Storage::open(&path).unwrap();
    let r = &st.get_recognitions("p1").unwrap()[0];
    assert!(r.user_override);
    assert_eq!(r.verdict.correct, Some(true));
    assert_eq!(r.verdict.code, VerdictCode::Ok);
    assert_eq!(r.verdict.error_nature, None);

    // A re-recognition of the same ink keeps the user's call.
    st.upsert_recognition(&rec("p1", "g1", &["e1"], verdict("3+4=8", "addition again", Some(false))))
        .unwrap();
    let r = &st.get_recognitions("p1").unwrap()[0];
    assert!(r.user_override);
    assert_eq!(r.verdict.correct, Some(true));
    assert_eq!(r.verdict.description, "addition again");

    // Purging the page removes its recognitions and their search rows.
    st.soft_delete(mate_core::storage::EntityKind::Page, "p1").unwrap();
    st.purge(mate_core::storage::EntityKind::Page, "p1").unwrap();
    assert!(st.get_recognitions("p1").unwrap().is_empty());
    assert!(st.search_recognition("addition", 10).unwrap().is_empty());
    drop(st);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn fresh_result_is_stored() {
    let mut st = seeded();
    ink(&mut st, &["a", "b"]);
    tick();
    let r = rec("p1", "g1", &["a", "b"], verdict("x=1", "fresh", None));
    // An unchanged re-save after capture (autosave flush) does not make it stale.
    tick();
    ink(&mut st, &["a"]);
    assert_eq!(st.upsert_recognition(&r).unwrap(), UpsertOutcome::Stored);
    assert_eq!(st.get_recognitions("p1").unwrap()[0].captured_at, r.captured_at);
    assert_eq!(serde_json::to_value(UpsertOutcome::Stale).unwrap(), "stale");
    assert_eq!(serde_json::to_value(UpsertOutcome::Stored).unwrap(), "stored");

    // Invalid input is an error, not "stale".
    let mut bad = r.clone();
    bad.captured_at = 0;
    assert!(st.upsert_recognition(&bad).is_err());
    let mut bad = r.clone();
    bad.element_ids.clear();
    assert!(st.upsert_recognition(&bad).is_err());
}

#[test]
fn captured_at_far_in_the_future_is_an_error_not_stale() {
    let mut st = seeded();
    ink(&mut st, &["a", "b"]);
    tick();
    let mut r = rec("p1", "g1", &["a", "b"], verdict("x=1", "skewed", None));
    r.captured_at = now_ms() + 61_000;
    assert!(st.upsert_recognition(&r).is_err());
    assert!(st.get_recognitions("p1").unwrap().is_empty());
    // A later, correctly stamped result is still stored (the bad one left nothing behind).
    let ok = rec("p1", "g1", &["a", "b"], verdict("x=1", "fine", None));
    assert_eq!(st.upsert_recognition(&ok).unwrap(), UpsertOutcome::Stored);
    // Small skew (within a minute) is accepted.
    let mut near = rec("p1", "g1", &["a", "b"], verdict("x=2", "near", None));
    near.captured_at = now_ms() + 30_000;
    assert_eq!(st.upsert_recognition(&near).unwrap(), UpsertOutcome::Stored);
}

#[test]
fn stale_result_after_erase_is_rejected() {
    let mut st = seeded();
    ink(&mut st, &["a", "b"]);
    tick();
    // Settle captures {a, b} and the request goes out; the user erases b meanwhile.
    let r = rec("p1", "g1", &["a", "b"], verdict("x+1", "before erase", None));
    tick();
    st.delete_elements(&["b".to_string()]).unwrap();
    assert_eq!(st.upsert_recognition(&r).unwrap(), UpsertOutcome::Stale);
    assert!(st.get_recognitions("p1").unwrap().is_empty());
    assert!(st.search_recognition("erase", 10).unwrap().is_empty());

    // Unknown elements and elements on another page are stale too.
    let r = rec("p1", "g2", &["a", "ghost"], verdict("y", "ghost", None));
    assert_eq!(st.upsert_recognition(&r).unwrap(), UpsertOutcome::Stale);
    let r = rec("p2", "g3", &["a"], verdict("y", "elsewhere", None));
    assert_eq!(st.upsert_recognition(&r).unwrap(), UpsertOutcome::Stale);
}

#[test]
fn stale_result_after_move_is_rejected() {
    let mut st = seeded();
    ink(&mut st, &["a", "b"]);
    tick();
    let r = rec("p1", "g1", &["a", "b"], verdict("x+1", "before move", None));
    tick();
    let mut moved = stroke("a", "p1", 3);
    for p in &mut moved.points {
        p.y += 30.0;
    }
    st.upsert_elements(&[moved]).unwrap();
    assert_eq!(st.upsert_recognition(&r).unwrap(), UpsertOutcome::Stale);
    assert!(st.get_recognitions("p1").unwrap().is_empty());

    // A highlighter toggle or a new image also counts as an ink change.
    tick();
    let r = rec("p1", "g1", &["a", "b"], verdict("x+1", "after move", None));
    assert_eq!(st.upsert_recognition(&r).unwrap(), UpsertOutcome::Stored);
    let mut hl = stroke("b", "p1", 3);
    hl.is_highlighter = true;
    st.upsert_elements(&[hl]).unwrap();
    assert!(st.get_recognitions("p1").unwrap().is_empty());
    let mut img = stroke("b", "p1", 3);
    img.is_highlighter = true;
    st.upsert_recognition(&rec("p1", "g1", &["a", "b"], verdict("x", "again", None))).unwrap();
    tick();
    img.image_url = Some("asset-1".into());
    st.upsert_elements(&[img]).unwrap();
    assert!(st.get_recognitions("p1").unwrap().is_empty());
}

#[test]
fn older_response_does_not_supersede_newer() {
    let mut st = seeded();
    ink(&mut st, &["a", "b"]);
    tick();
    // g1 = {a, b} is captured and in flight; the user adds c; g2 = {a, b, c} is captured later.
    let g1 = rec("p1", "g1", &["a", "b"], verdict("x+1", "older capture", None));
    tick();
    ink(&mut st, &["c"]);
    tick();
    let g2 = rec("p1", "g2", &["a", "b", "c"], verdict("x+1=2", "newer capture", Some(true)));
    // g2 returns first, then g1.
    assert_eq!(st.upsert_recognition(&g2).unwrap(), UpsertOutcome::Stored);
    assert_eq!(st.upsert_recognition(&g1).unwrap(), UpsertOutcome::Stale);
    let left: Vec<_> = st.get_recognitions("p1").unwrap().into_iter().map(|r| r.stroke_group_id).collect();
    assert_eq!(left, vec!["g2"]);
    assert_eq!(st.search_recognition("newer", 10).unwrap().len(), 1);
    assert!(st.search_recognition("older", 10).unwrap().is_empty());

    // The same group answered out of order keeps the later capture too.
    tick();
    let late = rec("p1", "g2", &["a", "b", "c"], verdict("x+1=2", "latest", Some(true)));
    assert_eq!(st.upsert_recognition(&late).unwrap(), UpsertOutcome::Stored);
    assert_eq!(st.upsert_recognition(&g2).unwrap(), UpsertOutcome::Stale);
    assert_eq!(st.get_recognitions("p1").unwrap()[0].verdict.description, "latest");
}

#[test]
fn override_survives_reordered_element_ids() {
    let mut st = seeded();
    ink(&mut st, &["a", "b"]);
    st.upsert_recognition(&rec("p1", "g1", &["a", "b"], verdict("1+1=3", "sum", Some(false)))).unwrap();
    st.set_user_override("p1", "g1", true).unwrap();
    st.upsert_recognition(&rec("p1", "g1", &["b", "a"], verdict("1+1=3", "sum", Some(false)))).unwrap();
    let r = &st.get_recognitions("p1").unwrap()[0];
    assert!(r.user_override);
    assert_eq!(r.verdict.correct, Some(true));
}
