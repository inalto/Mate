import { describe, expect, it } from "vitest";
import type { Recognition } from "../../model/types";
import { pickContext } from "../context";
import type { Region } from "../types";

function rec(id: string, y: number, latex: string, extra: Partial<Recognition> = {}): Recognition {
  return {
    pageId: "pg",
    strokeGroupId: id,
    elementIds: [`${id}-e`],
    bounds: { x: 100, y, width: 200, height: 40 },
    description: "",
    latex,
    correct: null,
    domain: "algebra",
    errorNature: null,
    hint: null,
    explanation: null,
    nextSteps: null,
    focusSpan: null,
    illegible: false,
    transcription: null,
    code: "INCOMPLETE",
    kind: "math",
    source: "auto",
    userOverride: false,
    provider: "anthropic",
    model: "m",
    createdAt: "",
    updatedAt: "",
    capturedAt: 1,
    ...extra,
  };
}

const region: Region = { regionId: "new", type: "math", elementIds: ["n1", "n2"], bounds: { x: 100, y: 1000, width: 200, height: 40 }, baselineY: 1040 };

describe("pickContext", () => {
  it("context_picks_nearest_11", () => {
    // 30 lines every 80 units from y=0; the region's baseline is at 1040.
    const recs = Array.from({ length: 30 }, (_, i) => rec(`l${i}`, i * 80, `x_{${i}}`));
    const ctx = pickContext(region, recs);
    expect(ctx).toHaveLength(11);
    // Baselines i*80+40 nearest to 1040: i = 12.5 ± … → lines 7..17, returned top to bottom.
    expect(ctx.map((c) => c.content)).toEqual(Array.from({ length: 11 }, (_, k) => `x_{${k + 7}}`));
    expect(ctx.every((c) => !c.isNew)).toBe(true);
  });

  it("skips the group itself, overlapping, illegible and empty lines and falls back to text", () => {
    const recs = [
      rec("new", 1000, "old reading"),
      rec("overlap", 1000, "y", { elementIds: ["n1"] }),
      rec("blurry", 950, "z", { illegible: true }),
      rec("empty", 900, "  "),
      rec("prose", 800, "", { transcription: { kind: "text", text: "Solve  for x" } }),
    ];
    expect(pickContext(region, recs)).toEqual([{ content: "Solve for x", isNew: false }]);
    expect(pickContext(region, [])).toEqual([]);
  });
});
