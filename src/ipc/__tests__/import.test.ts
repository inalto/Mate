import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (): Promise<unknown> => undefined));
const handlers = vi.hoisted(() => new Map<string, (e: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  }),
}));

import {
  cancelImport,
  importFiles,
  isImportPath,
  onImportFileOpened,
  onImportProgress,
  sniffImportFiles,
  takePendingImportFiles,
} from "../import";

beforeEach(() => {
  invoke.mockClear();
  handlers.clear();
});

describe("import ipc", () => {
  it("calls the commands with camelCase arguments", async () => {
    await sniffImportFiles(["a.note"]);
    expect(invoke).toHaveBeenLastCalledWith("sniff_import_files", { paths: ["a.note"] });
    await importFiles(["a.note"], { kind: "existing-unit", unitId: "u1" });
    expect(invoke).toHaveBeenLastCalledWith("import_files", { paths: ["a.note"], target: { kind: "existing-unit", unitId: "u1" } });
    await cancelImport();
    expect(invoke).toHaveBeenLastCalledWith("cancel_import");
    invoke.mockResolvedValueOnce(["b.goodnotes"]);
    expect(await takePendingImportFiles()).toEqual(["b.goodnotes"]);
  });

  it("delivers progress and file-opened payloads", async () => {
    const progress = vi.fn();
    const opened = vi.fn();
    const off = await onImportProgress(progress);
    await onImportFileOpened(opened);
    handlers.get("import://progress")!({ payload: { path: "a", phase: "parsing", pagesDone: 0, pagesTotal: 0 } });
    handlers.get("import://file-opened")!({ payload: { paths: ["x.one"] } });
    expect(progress).toHaveBeenCalledWith({ path: "a", phase: "parsing", pagesDone: 0, pagesTotal: 0 });
    expect(opened).toHaveBeenCalledWith(["x.one"]);
    off();
    expect(handlers.has("import://progress")).toBe(false);
  });

  it("recognises the import extensions only", () => {
    for (const p of [String.raw`C:\notes\Maths.GoodNotes`, "/n/a.note", "a.one", "a.onepkg", "a.freenotes", "a.freenotesv2", "a.freebackup", "a.sdocx"]) {
      expect(isImportPath(p), p).toBe(true);
    }
    for (const p of ["a.pdf", "note", ".note", "a.png"]) expect(isImportPath(p), p).toBe(false);
    expect(isImportPath("book.mate")).toBe(true);
  });
});
