import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  getRecognitions,
  recordLearningEvent,
  searchRecognition,
  setUserOverride,
  snippetParts,
} from "../recognition";

describe("recognition ipc", () => {
  it("passes camelCase args matching the Rust commands", async () => {
    await getRecognitions("p1");
    expect(invoke).toHaveBeenLastCalledWith("get_recognitions", { pageId: "p1" });
    await setUserOverride("p1", "g1", true);
    expect(invoke).toHaveBeenLastCalledWith("set_user_override", { pageId: "p1", strokeGroupId: "g1", correct: true });
    await searchRecognition("x^2");
    expect(invoke).toHaveBeenLastCalledWith("search_recognition", { query: "x^2", limit: 20 });
    await recordLearningEvent({ pageId: "p1", strokeGroupId: "g1", kind: "hint_shown" });
    expect(invoke).toHaveBeenLastCalledWith("record_learning_event", {
      ev: { pageId: "p1", strokeGroupId: "g1", kind: "hint_shown" },
    });
  });

  it("splits snippets into plain and matched runs", () => {
    const s = `the ${SNIPPET_OPEN}integral${SNIPPET_CLOSE} of ${SNIPPET_OPEN}x${SNIPPET_CLOSE}`;
    expect(snippetParts(s)).toEqual([
      { text: "the ", match: false },
      { text: "integral", match: true },
      { text: " of ", match: false },
      { text: "x", match: true },
    ]);
    expect(snippetParts("<b>plain</b>")).toEqual([{ text: "<b>plain</b>", match: false }]);
  });
});
