import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { clearWolframAppid, setWolframAppid, testWolframAppid, wolframShortAnswer, wolframStatus } from "../math";

describe("math ipc", () => {
  it("calls the Wolfram commands with the right arguments", async () => {
    await setWolframAppid("ID");
    expect(invoke).toHaveBeenLastCalledWith("set_wolfram_appid", { appid: "ID" });
    await clearWolframAppid();
    expect(invoke).toHaveBeenLastCalledWith("clear_wolfram_appid");
    await testWolframAppid();
    expect(invoke).toHaveBeenLastCalledWith("test_wolfram_appid");
    invoke.mockResolvedValueOnce({ configured: true, consent: false });
    expect(await wolframStatus()).toEqual({ configured: true, consent: false });
    expect(invoke).toHaveBeenLastCalledWith("wolfram_status");
    invoke.mockResolvedValueOnce("4");
    expect(await wolframShortAnswer("2+2")).toBe("4");
    expect(invoke).toHaveBeenLastCalledWith("wolfram_short_answer", { query: "2+2" });
  });

  it("passes the readable error through", async () => {
    invoke.mockRejectedValueOnce("Wolfram|Alpha is off. Turn it on in Settings.");
    await expect(wolframShortAnswer("x")).rejects.toBe("Wolfram|Alpha is off. Turn it on in Settings.");
  });
});
