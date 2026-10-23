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
vi.mock("../../stores/settings", () => ({
  flushSettings: vi.fn(async () => void calls.push("settings")),
}));
// Pane stores: pane 0 has an open text edit session whose commit enqueues the edited element.
const openSession = { id: null as string | null };
const paneStore = (pane: number) => ({
  getState: () => ({
    editingId: pane === 0 ? openSession.id : null,
    endEdit: () => {
      if (pane !== 0 || openSession.id === null) return;
      calls.push(`commit:${openSession.id}`);
      openSession.id = null;
    },
  }),
});
vi.mock("../../stores/focusedEditor", () => ({ editorForPane: (i: number) => paneStore(i) }));
const showToast = vi.fn();
vi.mock("../../components/Toast", () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
let startedResult = true;
const win = vi.hoisted(() => ({ page: false }));
vi.mock("../../ipc/windows", () => ({ isPageWindow: () => win.page }));

import * as ipc from "../../ipc/lifecycle";
import { CLEAN_EXIT_KEY, SAFE_CLOSE_TOAST, STILL_SAVING_TOAST, installCloseHandler } from "../close";

type W = {
  __mateFlushAndClose?: (id: number) => Promise<void>;
  __mateCloseAttemptCancelled?: (id: number) => void;
  __mateCloseRefused?: () => void;
};
const w = window as unknown as W;

beforeEach(() => {
  calls.length = 0;
  failedCount = 0;
  startedResult = true;
  win.page = false;
  openSession.id = null;
  showToast.mockClear();
  vi.mocked(ipc.completeCloseAttempt).mockClear();
  localStorage.clear();
  installCloseHandler();
});

describe("close handler", () => {
  it("page_window_close_leaves_the_clean_exit_flag_to_main", async () => {
    win.page = true;
    await w.__mateFlushAndClose!(4);
    expect(calls).toEqual(["started:4", "flush", "settings", "complete:4"]);
    expect(localStorage.getItem(CLEAN_EXIT_KEY)).toBeNull();
  });

  it("main_close_refused_by_a_page_window_shows_the_safe_close_toast", () => {
    w.__mateCloseRefused!();
    expect(showToast).toHaveBeenCalledWith(SAFE_CLOSE_TOAST);
  });

  it("flushes_pending_settings_on_beforeunload", async () => {
    window.dispatchEvent(new Event("beforeunload"));
    await Promise.resolve();
    expect(calls).toContain("settings");
  });

  it("close_while_editing_persists_text", async () => {
    openSession.id = "t1";
    await w.__mateFlushAndClose!(9);
    // The session commits (enqueueing the text) before the queue is flushed.
    expect(calls).toEqual(["commit:t1", "started:9", "flush", "settings", "complete:9"]);
  });

  it("ends_edit_sessions_on_beforeunload", async () => {
    openSession.id = "t2";
    window.dispatchEvent(new Event("beforeunload"));
    expect(calls.slice(0, 2)).toEqual(["commit:t2", "flush"]);
  });

  it("completes_when_queue_flushes", async () => {
    await w.__mateFlushAndClose!(1);
    expect(calls).toEqual(["started:1", "flush", "settings", "complete:1"]);
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
    expect(showToast).toHaveBeenCalledWith(
      `${SAFE_CLOSE_TOAST} Saved a recovery file: p`,
      expect.objectContaining({ label: "Close anyway" }),
      { expiresAfterMs: 30_000 },
    );
  });

  it("close_anyway_completes_after_recovery_written", async () => {
    failedCount = 1;
    await w.__mateFlushAndClose!(7);
    const action = showToast.mock.calls[0][1] as { label: string; onClick: () => void };
    expect(ipc.completeCloseAttempt).not.toHaveBeenCalled();
    action.onClick();
    expect(ipc.completeCloseAttempt).toHaveBeenCalledWith(7, true);
    expect(localStorage.getItem(CLEAN_EXIT_KEY)).toBe("0");
  });

  it("keeps cancel behaviour without close-anyway when the recovery file cannot be written", async () => {
    failedCount = 1;
    vi.mocked(ipc.writeRecoveryArtifact).mockRejectedValueOnce(new Error("disk"));
    await w.__mateFlushAndClose!(8);
    expect(calls).toContain("cancel:8");
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
    expect(showToast).toHaveBeenCalledWith(STILL_SAVING_TOAST);
    release();
    await run;
    expect(ipc.completeCloseAttempt).not.toHaveBeenCalled();
  });
});
