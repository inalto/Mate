import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { clearAiKey, setAiKey } from "../ai";
import { sessionAttempts } from "../../tutor/attempts";

describe("ai ipc", () => {
  it("a saved or removed key lifts the live-checking block", async () => {
    sessionAttempts.setBlock("auth", "The API key was not accepted. Check it in Settings.");
    await setAiKey("anthropic", "sk-new");
    expect(invoke).toHaveBeenLastCalledWith("set_ai_key", { provider: "anthropic", key: "sk-new" });
    expect(sessionAttempts.block).toBeNull();

    sessionAttempts.setBlock("billing", "x");
    await clearAiKey("anthropic");
    expect(sessionAttempts.block).toBeNull();
  });

  it("keeps the block when saving fails", async () => {
    sessionAttempts.setBlock("auth", "x");
    invoke.mockRejectedValueOnce("Enter an API key first.");
    await expect(setAiKey("anthropic", " ")).rejects.toBe("Enter an API key first.");
    expect(sessionAttempts.block).not.toBeNull();
    sessionAttempts.clearAuthBlock();
  });
});

describe("ai provider ipc", () => {
  it("lists providers and models through the matching commands", async () => {
    const { listAiModels, listAiProviders } = await import("../ai");
    invoke.mockResolvedValueOnce([{ id: "ollama" }] as never);
    expect(await listAiProviders()).toEqual([{ id: "ollama" }]);
    expect(invoke).toHaveBeenLastCalledWith("list_ai_providers");
    invoke.mockResolvedValueOnce(["a"] as never);
    expect(await listAiModels()).toEqual(["a"]);
    expect(invoke).toHaveBeenLastCalledWith("list_ai_models");
  });
});
