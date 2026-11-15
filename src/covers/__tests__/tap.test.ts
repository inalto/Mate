// The covers as a tap sees them: a live cover is a tap target, and opening one toggles its reveal;
// the dim set of a pane is the replay's dimmed ids together with the revealed covers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Element } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";

const queue = vi.hoisted(() => ({ enqueueUpsert: vi.fn(), enqueueDelete: vi.fn(), flushAll: vi.fn(async () => {}), pending: () => 0, failed: () => 0 }));
const loaded = vi.hoisted(() => ({ els: [] as Element[] }));
vi.mock("../../ipc/elementsQueue", () => ({ elementsQueue: queue }));
vi.mock("../../ipc/elements", () => ({ loadElements: vi.fn(async () => loaded.els) }));
vi.mock("../../ipc/settings", () => ({ getSettings: vi.fn(), patchSettings: vi.fn(async () => {}) }));

import { createEditorStore, type EditorStore } from "../../stores/editor";
import { useNotebookStore } from "../../stores/notebook";
import { coverTargetOf, dimOf } from "../tap";

const cover = el("cv", [[0, 0], [100, 0]], { width: 28, penStyle: "cover" });
const ink = el("ink", [[0, 100], [100, 100]]);

let store: EditorStore;

beforeEach(async () => {
  store = createEditorStore();
  loaded.els = [cover, ink, { ...cover, id: "gone", deletedAt: "2026-01-02T00:00:00.000Z" }];
  useNotebookStore.setState({ loaded: true });
  await store.getState().loadPage("pg");
});

describe("coverTargetOf", () => {
  it("only live covers are targets", () => {
    const t = coverTargetOf(store);
    expect(t.isMarker("cv")).toBe(true);
    expect(t.isMarker("ink")).toBe(false);
    expect(t.isMarker("gone")).toBe(false);
    expect(t.isMarker("nope")).toBe(false);
  });

  it("opening a cover toggles its reveal", () => {
    const t = coverTargetOf(store);
    t.open("cv");
    expect(store.getState().revealed.has("cv")).toBe(true);
    t.open("cv");
    expect(store.getState().revealed.has("cv")).toBe(false);
  });
});

describe("dimOf", () => {
  it("is null when nothing is dimmed or revealed", () => {
    expect(dimOf({ replayDim: null, revealed: new Set() })).toBeNull();
    expect(dimOf({ replayDim: new Set(), revealed: new Set() })).toBeNull();
  });

  it("is the union of the replay's dimmed ids and the revealed covers (each once)", () => {
    const d = dimOf({ replayDim: new Set(["x", "cv"]), revealed: new Set(["cv", "c2"]) });
    expect(new Set(d)).toEqual(new Set(["x", "cv", "c2"]));
  });

  it("returns either set itself when the other is empty, and the same union for the same inputs", () => {
    const dim = new Set(["x"]);
    const revealed = new Set(["cv"]);
    expect(dimOf({ replayDim: dim, revealed: new Set() })).toBe(dim);
    expect(dimOf({ replayDim: null, revealed })).toBe(revealed);
    expect(dimOf({ replayDim: dim, revealed })).toBe(dimOf({ replayDim: dim, revealed }));
  });
});
