import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string, a: { ok: boolean }) => void calls.push(`${cmd}:${a.ok}`)) }));
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: { flushAll: vi.fn(async () => void calls.push("flush")), failed: () => 0 },
}));
vi.mock("../../stores/settings", () => ({ flushSettings: vi.fn(async () => void calls.push("settings")) }));
vi.mock("../../overlay/useEditSession", () => ({ endAllEdits: vi.fn(() => void calls.push("edits")) }));
vi.mock("../../recording/session", () => ({ isRecordingActive: () => true, stopRecordingBeforeExit: vi.fn(async () => void calls.push("recording")) }));

import { flushOnly } from "../flushOnly";

describe("flushOnly", () => {
  beforeEach(() => void (calls.length = 0));

  it("saves a running recording before flushing for an update", async () => {
    await flushOnly(3);
    expect(calls).toEqual(["edits", "recording", "flush", "settings", "report_flush:true"]);
  });
});
