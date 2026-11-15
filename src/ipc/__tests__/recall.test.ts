import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { recallElementHistory, recallPageStats, recallUnitStats, recordRecall } from "../recall";

describe("recall ipc", () => {
  it("passes camelCase args matching the Rust commands", async () => {
    const answer = { pageId: "p1", elementId: "c1", knew: true, runId: "r1" };
    await recordRecall(answer);
    expect(invoke).toHaveBeenLastCalledWith("record_recall", { answer });
    await recallPageStats("p1");
    expect(invoke).toHaveBeenLastCalledWith("recall_page_stats", { pageId: "p1" });
    await recallUnitStats("u1");
    expect(invoke).toHaveBeenLastCalledWith("recall_unit_stats", { unitId: "u1" });
    await recallElementHistory("c1", 5);
    expect(invoke).toHaveBeenLastCalledWith("recall_element_history", { elementId: "c1", last: 5 });
  });
});
