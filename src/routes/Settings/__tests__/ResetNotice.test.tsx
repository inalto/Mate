import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/backup", () => ({ takeResetIncomplete: vi.fn() }));
vi.mock("../../../components/Toast", () => ({ showToast: vi.fn() }));

import { showToast } from "../../../components/Toast";
import { takeResetIncomplete } from "../../../ipc/backup";
import ResetNotice from "../ResetNotice";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ResetNotice", () => {
  it("shows_where_the_backup_is_after_an_incomplete_reset", async () => {
    vi.mocked(takeResetIncomplete).mockResolvedValue({ recoveryPath: "C:/data/mate-recovery.zip", error: "locked" });
    render(<ResetNotice />);
    await vi.waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(vi.mocked(showToast).mock.calls[0][0]).toBe(
      "Local data could not be fully reset. Your backup is at C:/data/mate-recovery.zip.",
    );
  });

  it("stays_quiet_when_nothing_was_left_behind", async () => {
    vi.mocked(takeResetIncomplete).mockResolvedValue(null);
    render(<ResetNotice />);
    await vi.waitFor(() => expect(takeResetIncomplete).toHaveBeenCalled());
    expect(showToast).not.toHaveBeenCalled();
  });
});
