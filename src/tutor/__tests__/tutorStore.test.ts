import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  setUserOverride: vi.fn(async () => {}),
  recordLearningEvent: vi.fn(async () => {}),
}));
vi.mock("../../ipc/recognition", async (orig) => ({ ...(await orig<typeof import("../../ipc/recognition")>()), ...ipc }));
const session = vi.hoisted(() => ({ requestCheck: vi.fn(() => true), showRecognition: vi.fn() }));
vi.mock("../useTutor", async (orig) => ({ ...(await orig<typeof import("../useTutor")>()), ...session }));

import { DEFAULT_SETTINGS } from "../../model/constants";
import { groupOfElement, useTutorUi } from "../../stores/tutor";
import { tutorMarkers } from "../overlay";
import { EMPTY_TUTOR_VIEW, useTutorViews } from "../useTutor";
import { recognition, viewWith } from "./fixtures";

const ui = () => useTutorUi.getState();
const kinds = () => ipc.recordLearningEvent.mock.calls.map((c) => (c as unknown as [{ kind: string }])[0].kind);

describe("tutor store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTutorUi.setState({ card: null });
    useTutorViews.setState({ views: { 0: viewWith([recognition("g")]), 1: EMPTY_TUTOR_VIEW } });
  });

  it("override_marks_correct_and_records_event", async () => {
    const settings = { ...DEFAULT_SETTINGS, correctnessMode: false };
    expect(tutorMarkers(useTutorViews.getState().views[0], settings).map((m) => m.kind)).toEqual(["squiggle"]);
    ui().openCard(0, "g");
    await ui().markCorrect();
    expect(ipc.setUserOverride).toHaveBeenCalledWith("pg", "g", true);
    expect(ipc.recordLearningEvent).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "pg", strokeGroupId: "g", kind: "override", payload: expect.objectContaining({ correct: true, previous: false }) }),
    );
    expect(session.showRecognition).toHaveBeenCalledWith(expect.objectContaining({ strokeGroupId: "g", correct: true, userOverride: true }));
    // The squiggle becomes a tick.
    expect(tutorMarkers(useTutorViews.getState().views[0], settings).map((m) => m.kind)).toEqual(["tick"]);
  });

  it("reveal_ladder_records_hint_why_next_once", () => {
    ui().openCard(0, "g");
    ui().noteHintShown();
    ui().noteHintShown();
    ui().revealWhy();
    ui().revealWhy();
    ui().revealNext();
    expect(kinds()).toEqual(["hint_shown", "why_shown", "next_shown"]);
    expect(ui().card?.step).toBe(2);
  });

  it("opening_an_unchecked_group_asks_for_a_check", () => {
    useTutorViews.setState({ views: { 0: viewWith([], { regions: new Map([["n", { regionId: "n", type: "math", elementIds: ["e1"], bounds: { x: 0, y: 0, width: 5, height: 5 }, baselineY: 5 }]]) }), 1: EMPTY_TUTOR_VIEW } });
    ui().openCard(0, "n", { ask: true });
    expect(session.requestCheck).toHaveBeenCalledWith(0, "n");
    expect(ui().card).toMatchObject({ groupId: "n", asking: true, pageId: "pg" });
    expect(groupOfElement(useTutorViews.getState().views[0], "e1")).toBe("n");
    // An already checked group is not sent again.
    session.requestCheck.mockClear();
    useTutorViews.setState({ views: { 0: viewWith([recognition("g")]), 1: EMPTY_TUTOR_VIEW } });
    ui().openCard(0, "g");
    expect(session.requestCheck).not.toHaveBeenCalled();
  });

  it("try_again_rechecks_forgetting_attempts", () => {
    ui().openCard(0, "g");
    ui().retry();
    expect(session.requestCheck).toHaveBeenCalledWith(0, "g", { retry: true });
  });

  it("failed_override_keeps_the_verdict", async () => {
    ipc.setUserOverride.mockRejectedValueOnce(new Error("disk"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    ui().openCard(0, "g");
    await ui().markCorrect();
    expect(ipc.recordLearningEvent).not.toHaveBeenCalled();
    expect(useTutorViews.getState().views[0].recognitions.get("g")?.correct).toBe(false);
  });
});
