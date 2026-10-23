import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { practiceGenerate } from "../practice";
import { suggestTitle, summarizePage } from "../semantics";
import { sessionAttempts } from "../../tutor/attempts";

afterEach(() => {
  sessionAttempts.clearAuthBlock();
  invoke.mockReset();
});

describe("AI commands and the live-checking block", () => {
  it.each([
    ["auth", "The API key was not accepted. Check it in Settings."],
    ["billing", "The AI account has a billing problem. Check it with the provider."],
    ["unknownModel", "The selected model is not available. Check the model in Settings."],
  ])("a %s failure on a summary blocks checking and rejects with the sentence", async (kind, message) => {
    invoke.mockRejectedValueOnce({ kind, message });
    await expect(summarizePage("p1")).rejects.toThrow(message);
    expect(sessionAttempts.block).toEqual({ kind, reason: message });
  });

  it("titles and practice questions block too", async () => {
    invoke.mockRejectedValueOnce({ kind: "auth", message: "bad key" });
    await expect(suggestTitle("p1")).rejects.toThrow("bad key");
    expect(sessionAttempts.block?.kind).toBe("auth");
    sessionAttempts.clearAuthBlock();
    invoke.mockRejectedValueOnce({ kind: "billing", message: "pay up" });
    await expect(practiceGenerate("u1", 3, ["true-false"])).rejects.toThrow("pay up");
    expect(sessionAttempts.block?.kind).toBe("billing");
  });

  it("other failures do not block", async () => {
    for (const kind of ["disabled", "rateLimited", "network", "internal"]) {
      invoke.mockRejectedValueOnce({ kind, message: "nope" });
      await expect(summarizePage("p1")).rejects.toThrow("nope");
    }
    expect(sessionAttempts.block).toBeNull();
  });

  it("passes results through", async () => {
    invoke.mockResolvedValueOnce({ summary: "s", cached: false });
    await expect(summarizePage("p1")).resolves.toEqual({ summary: "s", cached: false });
  });
});
