import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Element, Page } from "../../model/types";

vi.mock("../elements", () => ({
  loadElements: vi.fn(async () => []),
  upsertElements: vi.fn(async () => {}),
  deleteElements: vi.fn(async () => {}),
}));
vi.mock("../notebook", () => ({
  getNotebookTree: vi.fn(async () => ({ bookshelves: [], units: [], sections: [], pages: [] })),
  upsertPage: vi.fn(async () => {}),
}));
vi.mock("../settings", () => ({ getSettings: vi.fn(), setSettings: vi.fn(async () => {}) }));

import CanvasView from "../../canvas/CanvasView";
import { SnapshotCache } from "../../canvas/snapshot";
import { useNotebookStore } from "../../stores/notebook";
import * as ipc from "../elements";
import { createElementsQueue } from "../elementsQueue";

const stroke = (id: string, x = 0, pageId = "page-1"): Element => ({
  id,
  pageId,
  type: "stroke",
  points: [
    { x, y: 0, pressure: 0.5, timestamp: 0 },
    { x: x + 10, y: 10, pressure: 0.5, timestamp: 1 },
  ],
  color: "#000000",
  width: 4.11,
  isHighlighter: false,
  penStyle: "pen",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  version: 0,
});

describe("elementsQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces_same_id", async () => {
    const upsert = vi.fn(async (_els: Element[]) => {});
    const del = vi.fn(async (_ids: string[]) => {});
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: del });
    q.enqueueUpsert(stroke("a", 1));
    q.enqueueUpsert(stroke("a", 2));
    q.enqueueUpsert(stroke("b"));
    expect(q.pending()).toBe(2);
    await q.flushAll();
    expect(upsert).toHaveBeenCalledTimes(1);
    const sent = upsert.mock.calls[0][0];
    expect(sent.map((e) => e.id).sort()).toEqual(["a", "b"]);
    expect(sent.find((e) => e.id === "a")!.points[0].x).toBe(2);
    // An upsert followed by a delete of the same id only deletes.
    q.enqueueUpsert(stroke("c"));
    q.enqueueDelete("c");
    await q.flushAll();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(["c"]);
  });

  it("flushes_after_150ms", async () => {
    const upsert = vi.fn(async (_els: Element[]) => {});
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: vi.fn(async () => {}) });
    q.enqueueUpsert(stroke("a"));
    await vi.advanceTimersByTimeAsync(100);
    q.enqueueUpsert(stroke("b"));
    await vi.advanceTimersByTimeAsync(149);
    expect(upsert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toHaveLength(2);
    expect(q.pending()).toBe(0);
    // 200 pending items flush immediately.
    for (let i = 0; i < 200; i++) q.enqueueUpsert(stroke(`n${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][0]).toHaveLength(200);
  });

  it("flushAll_resolves_after_pending_written", async () => {
    let release: () => void = () => {};
    const written: string[] = [];
    let calls = 0;
    const upsert = vi.fn(async (els: Element[]) => {
      calls++;
      if (calls === 1) throw new Error("transient");
      await new Promise<void>((r) => (release = r));
      written.push(...els.map((e) => e.id));
    });
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: vi.fn(async () => {}) });
    q.enqueueUpsert(stroke("a"));
    q.enqueueUpsert(stroke("b"));
    let done = false;
    const p = q.flushAll().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(q.pending()).toBe(2);
    release();
    await p;
    expect(done).toBe(true);
    expect(written.sort()).toEqual(["a", "b"]);
    expect(upsert).toHaveBeenCalledTimes(2); // retried once
    expect(q.pending()).toBe(0);
    expect(q.failed()).toBe(0);
  });

  it("partial_erase_at_boundary_persists", async () => {
    // Partial erase at the element limit: delete 1 + add 2 must reach the backend deletes-first so
    // the live count never transiently exceeds the limit.
    const order: string[] = [];
    const upsert = vi.fn(async (els: Element[]) => {
      order.push(`upsert:${els.map((e) => e.id).join(",")}`);
    });
    const del = vi.fn(async (ids: string[]) => {
      order.push(`delete:${ids.join(",")}`);
    });
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: del });
    q.enqueueDelete("a");
    q.enqueueUpsert(stroke("a1"));
    q.enqueueUpsert(stroke("a2"));
    await q.flushAll();
    expect(order).toEqual(["delete:a", "upsert:a1,a2"]);
  });

  it("rejected_batch_is_retried_per_page_and_isolates_bad_element", async () => {
    const calls: string[][] = [];
    const upsert = vi.fn(async (els: Element[]) => {
      calls.push(els.map((e) => e.id));
      if (els.some((e) => e.id === "bad")) throw new Error("rejected");
    });
    const del = vi.fn(async (_ids: string[]) => {});
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: del });
    q.enqueueUpsert(stroke("a", 0, "page-1"));
    q.enqueueUpsert(stroke("bad", 0, "page-2"));
    q.enqueueDelete("gone", "page-1");
    await q.flushAll();
    // Whole batch twice, then per page: page-1 lands, page-2 is parked as failed.
    expect(calls.slice(0, 2)).toEqual([["a", "bad"], ["a", "bad"]]);
    expect(calls).toContainEqual(["a"]);
    expect(calls[calls.length - 1]).toEqual(["bad"]);
    expect(del).toHaveBeenCalledWith(["gone"]);
    expect(q.failed()).toBe(1);
    expect(q.snapshot().failed).toEqual([{ op: "upsert", element: stroke("bad", 0, "page-2") }]);
    // Later regular batches do not carry the failed element, so they succeed.
    calls.length = 0;
    q.enqueueUpsert(stroke("b", 0, "page-1"));
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toEqual([["b"]]);
    expect(q.failed()).toBe(1);
    // A newer write of the failed id supersedes it.
    q.enqueueUpsert(stroke("bad", 5, "page-2"));
    expect(q.failed()).toBe(0);
  });

  it("failed_items_retry_with_backoff", async () => {
    let reject = true;
    const upsert = vi.fn(async (_els: Element[]) => {
      if (reject) throw new Error("rejected");
    });
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: vi.fn(async () => {}) });
    q.enqueueUpsert(stroke("x"));
    await q.flushAll();
    expect(q.failed()).toBe(1);
    const after = upsert.mock.calls.length;
    await vi.advanceTimersByTimeAsync(999);
    expect(upsert).toHaveBeenCalledTimes(after);
    await vi.advanceTimersByTimeAsync(1);
    expect(upsert).toHaveBeenCalledTimes(after + 1); // 1 s
    await vi.advanceTimersByTimeAsync(1999);
    expect(upsert).toHaveBeenCalledTimes(after + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(upsert).toHaveBeenCalledTimes(after + 2); // then 2 s
    // flushAll retries failed items immediately too.
    await q.flushAll();
    expect(upsert).toHaveBeenCalledTimes(after + 3);
    reject = false;
    await vi.advanceTimersByTimeAsync(4000); // next backoff step
    expect(q.failed()).toBe(0);
    expect(q.pending()).toBe(0);
    const settled = upsert.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(upsert).toHaveBeenCalledTimes(settled); // nothing left to retry
  });

  it("backoff_is_capped_at_60s", async () => {
    const upsert = vi.fn(async (_els: Element[]) => {
      throw new Error("rejected");
    });
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: vi.fn(async () => {}) });
    q.enqueueUpsert(stroke("x"));
    await q.flushAll();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000 + 32000); // 6 retries
    const n = upsert.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(upsert).toHaveBeenCalledTimes(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(upsert).toHaveBeenCalledTimes(n + 1);
  });

  it("status_callback_reports_failed_count", async () => {
    let reject = true;
    const upsert = vi.fn(async (_els: Element[]) => {
      if (reject) throw new Error("rejected");
    });
    const q = createElementsQueue({ upsertElements: upsert, deleteElements: vi.fn(async () => {}) });
    const seen: { pending: number; failed: number }[] = [];
    const off = q.onStatus((s) => seen.push(s));
    q.enqueueUpsert(stroke("x"));
    expect(seen[seen.length - 1]).toEqual({ pending: 1, failed: 0 });
    await q.flushAll();
    expect(seen[seen.length - 1]).toEqual({ pending: 1, failed: 1 });
    reject = false;
    await q.flushAll();
    expect(seen[seen.length - 1]).toEqual({ pending: 0, failed: 0 });
    off();
    const count = seen.length;
    q.enqueueUpsert(stroke("y"));
    expect(seen).toHaveLength(count);
  });
});

describe("CanvasView snapshot", () => {
  const page: Page = {
    id: "page-1",
    sectionId: "s",
    title: "t",
    isExpanded: true,
    isFavourite: false,
    depth: 0,
    mode: "canvas",
    backgroundConfig: { type: "ruled", spacing: 40, dotRadius: 1.5 },
    thumbnailVersion: 0,
    orderIndex: 0,
    createdAt: "",
    updatedAt: "",
    version: 0,
  };

  beforeEach(() => {
    const stubCtx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (target, key) => {
        if (!(key in target)) target[key] = vi.fn();
        return target[key];
      },
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      stubCtx as unknown as CanvasRenderingContext2D,
    );
    vi.stubGlobal("OffscreenCanvas", undefined);
    useNotebookStore.setState({
      tree: { bookshelves: [], units: [], sections: [], pages: [page] },
      loaded: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rasterAll_called_once_per_load", async () => {
    const many = Array.from({ length: 5000 }, (_, i) => stroke(`e${i}`, i));
    vi.mocked(ipc.loadElements).mockResolvedValue(many);
    const spy = vi.spyOn(SnapshotCache.prototype, "rasterAll");
    render(createElement(CanvasView, { pageId: "page-1" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 300));
    expect(spy).toHaveBeenCalledTimes(1);
    // Only strokes inside the snapshot clip are drawn (x ≤ ~200 at the default camera).
    const drawn = [...(spy.mock.calls[0][0] as Iterable<Element>)];
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(5000);
  });

  it("raster_draws_only_visible_elements", async () => {
    const near = [stroke("n1", 0), stroke("n2", 50), stroke("n3", 100)];
    const far = [stroke("f1", 5000), stroke("f2", 9000)];
    // z-order: n3 below n1 below n2.
    near[0] = { ...near[0], content: { zIndex: 2 } };
    near[1] = { ...near[1], content: { zIndex: 3 } };
    near[2] = { ...near[2], content: { zIndex: 1 } };
    vi.mocked(ipc.loadElements).mockResolvedValue([far[0], near[1], near[0], far[1], near[2]]);
    const spy = vi.spyOn(SnapshotCache.prototype, "rasterAll");
    render(createElement(CanvasView, { pageId: "page-1" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const drawn = [...(spy.mock.calls[0][0] as Iterable<Element>)].map((e) => e.id);
    expect(drawn).toEqual(["n3", "n1", "n2"]);
  });
});
