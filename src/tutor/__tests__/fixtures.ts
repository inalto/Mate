// Shared tutor test data.
import type { Recognition } from "../../model/types";
import { EMPTY_TUTOR_VIEW, type TutorView } from "../useTutor";

export const BOUNDS = { x: 100, y: 100, width: 200, height: 40 };

export function recognition(id: string, over: Partial<Recognition> = {}): Recognition {
  return {
    pageId: "pg",
    strokeGroupId: id,
    elementIds: [`${id}-e`],
    bounds: BOUNDS,
    capturedAt: 1,
    source: "auto",
    userOverride: false,
    provider: "anthropic",
    model: "m",
    createdAt: "",
    updatedAt: "",
    description: "two x plus three equals seven",
    latex: "2x+3=7",
    correct: false,
    domain: "algebra",
    errorNature: "slip",
    hint: "Check the sign of the 3.",
    explanation: "Subtracting 3 from both sides changes its sign.",
    nextSteps: "Write 2x = 7 - 3.",
    focusSpan: null,
    illegible: false,
    transcription: null,
    code: "ALGEBRA",
    kind: "math",
    ...over,
  };
}

/** A tutor view of page "pg" with these recognitions (each also a current region). */
export function viewWith(recs: Recognition[], over: Partial<TutorView> = {}): TutorView {
  return {
    ...EMPTY_TUTOR_VIEW,
    pageId: "pg",
    recognitions: new Map(recs.map((r) => [r.strokeGroupId, r])),
    regions: new Map(recs.map((r) => [r.strokeGroupId, { regionId: r.strokeGroupId, type: "math" as const, elementIds: r.elementIds, bounds: r.bounds, baselineY: r.bounds.y + r.bounds.height }])),
    ...over,
  };
}
