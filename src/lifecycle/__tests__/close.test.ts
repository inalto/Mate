import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("../../ipc/lifecycle", () => ({
  closeAttemptStarted: vi.fn(async (id: number) => (calls.push(`started:${id}`), startedResult)),
  cancelCloseAttempt: vi.fn(async (id: number) => void calls.push(`cancel:${id}`)),
  completeCloseAttempt: vi.fn(async (id: number) => void calls.push(`complete:${id}`)),
  writeRecoveryArtifact: vi.fn(async (name: string) => (calls.push(`recovery:${name}`), { path: "p", size: 1 })),
}));

let failedCount = 0;
vi.mock("../../ipc/elementsQueue", () => ({
  elementsQueue: {
    flushAll: vi.fn(async () => void calls.push("flush")),
    failed: () => failedCount,
    pending: () => failedCount,
    snapshot: () => ({
      pending: [],
      failed: failedCount ? [{ op: "delete", id: "e1" }] : [],
    }),
  },
}));
const showToast = vi.fn();
vi.mock("../../components/Toast", () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
let startedResult = true;

import * as ipc from "../../ipc/lifecycle";
import { CLEAN_EXIT_KEY, SAFE_CLOSE_TOAST, installCloseHandler } from "../close";

type W = { __mateFlushAndClose?: (id: number) => Promise<void>; __mateCloseAttemptCancelled?: (id: number) => void };
const w = window as unknown as W;

beforeEach(() => {
  calls.length = 0;
  failedCount = 0;
  startedResult = true;
  showToast.mockClear();
  vi.mocked(ipc.completeCloseAttempt).mockClear();
  localStorage.clear();
  installCloseHandler();
});

describe("close handler", () => {
  it("completes_when_queue_flushes", async () => {
    await w.__mateFlushAndClose!(1);
    expect(calls).toEqual(["started:1", "flush", "complete:1"]);
    expect(ipc.completeCloseAttempt).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(CLEAN_EXIT_KEY)).toBe("1");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("cancels_and_writes_recovery_when_writes_failed", async () => {
    failedCount = 1;
    await w.__mateFlushAndClose!(2);
    expect(calls[0]).toBe("started:2");
    expect(calls[2]).toMatch(/^recovery:mate-recovery-.*\.json$/);
    expect(calls[3]).toBe("cancel:2");
    expect(ipc.completeCloseAttempt).not.toHaveBeenCalled();
    expect(localStorage.getItem(CLEAN_EXIT_KEY)).toBeNull();
    const json = JSON.parse(vi.mocked(ipc.writeRecoveryArtifact).mock.calls[0][1]);
    expect(json.app).toBe("Mate");
    expect(json.failed).toEqual([{ op: "delete", id: "e1" }]);
    expect(showToast).toHaveBeenCalledWith(SAFE_CLOSE_TOAST);
  });

  it("ignores_stale_cancel_id", async () => {
    startedResult = false;
    await w.__mateFlushAndClose!(3);
    expect(calls).toEqual(["started:3"]);
    w.__mateCloseAttemptCancelled!(3);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("shows toast when the current attempt is cancelled by the watchdog", async () => {
    let release!: () => void;
    const { elementsQueue } = await import("../../ipc/elementsQueue");
    vi.mocked(elementsQueue.flushAll).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const run = w.__mateFlushAndClose!(5);
    await vi.waitFor(() => expect(calls).toContain("started:5"));
    w.__mateCloseAttemptCancelled!(4);
    expect(showToast).not.toHaveBeenCalled();
    w.__mateCloseAttemptCancelled!(5);
    expect(showToast).toHaveBeenCalledWith(SAFE_CLOSE_TOAST);
    release();
    await run;
    expect(ipc.completeCloseAttempt).not.toHaveBeenCalled();
  });
});
