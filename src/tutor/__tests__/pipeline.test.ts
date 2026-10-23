import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Recognition, Settings, Verdict } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";
import { createAttemptLedger, MAX_ATTEMPTS_PER_REVISION, runRecognition, type PipelineDeps } from "../pipeline";
import type { Region } from "../types";

const on: Settings = { ...DEFAULT_SETTINGS, aiConsent: true, tutorEnabled: true };
const region: Region = { regionId: "g1", type: "math", elementIds: ["a"], bounds: { x: 0, y: 0, width: 50, height: 30 }, baselineY: 30 };
const elements = [el("a", [[0, 0], [50, 30]])];

const verdict: Verdict = {
  description: "x equals two",
  latex: "x=2",
  correct: true,
  domain: "algebra",
  errorNature: null,
  hint: null,
  explanation: null,
  nextSteps: null,
  focusSpan: null,
  illegible: false,
  transcription: null,
  code: "OK",
  kind: "math",
};

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    recognize: vi.fn(async () => verdict),
    upsert: vi.fn(async () => "stored" as const),
    capture: vi.fn(async () => ({ png: new Uint8Array([1, 2, 3]), bounds: { x: -24, y: -24, width: 98, height: 78 }, width: 10, height: 8 })),
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => 1_000,
    warn: vi.fn(),
    attempts: createAttemptLedger(),
    sleeps,
    ...over,
  };
}

describe("runRecognition", () => {
  it("pipeline_skips_when_disabled", async () => {
    for (const s of [
      { ...on, aiConsent: null },
      { ...on, aiConsent: false },
      { ...on, tutorEnabled: false },
    ]) {
      const d = deps();
      expect(await runRecognition(region, elements, [], s, d)).toBeNull();
      expect(d.capture).not.toHaveBeenCalled();
      expect(d.recognize).not.toHaveBeenCalled();
    }
    // Rust says disabled (no key stored): also nothing to show, and no retry.
    const d = deps({ recognize: vi.fn(async () => Promise.reject({ kind: "disabled", message: "AI checking is off." })) });
    expect(await runRecognition(region, elements, [], on, d)).toBeNull();
    expect(d.recognize).toHaveBeenCalledTimes(1);
  });

  it("checks, persists with capturedAt and skips an unchanged result", async () => {
    const d = deps();
    const out = await runRecognition(region, elements, [], on, d);
    expect(out).toMatchObject({ status: "checked", verdict, stored: true });
    const rec = vi.mocked(d.upsert).mock.calls[0][0];
    expect(rec).toMatchObject({ pageId: "pg", strokeGroupId: "g1", elementIds: ["a"], capturedAt: 1_000, source: "auto", provider: "anthropic" });
    expect(rec.bounds).toEqual(region.bounds);
    const req = vi.mocked(d.recognize).mock.calls[0][0];
    expect(req.imagePngBase64).toBe("AQID");

    // Same verdict for the same members: nothing is written again.
    const again = deps();
    const stored = { ...rec, createdAt: "t", updatedAt: "t" } as Recognition;
    const out2 = await runRecognition(region, elements, [stored], on, again);
    expect(out2).toMatchObject({ status: "checked", stored: false });
    expect(again.upsert).not.toHaveBeenCalled();
  });

  it("offline_does_not_block_or_retry_forever", async () => {
    const offline = vi.fn(async () => Promise.reject({ kind: "network", message: "Could not reach the AI service (no connection)." }));
    const d = deps({ recognize: offline });
    const out = await runRecognition(region, elements, [], on, d);
    // Resolves (never throws) with a muted state the overlay can show.
    expect(out).toMatchObject({ status: "unchecked", kind: "network" });
    expect(offline).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION);
    expect(MAX_ATTEMPTS_PER_REVISION).toBe(3);
    expect(d.sleeps.length).toBe(MAX_ATTEMPTS_PER_REVISION - 1);
    expect(d.sleeps[1]).toBeGreaterThan(d.sleeps[0]);
    expect(d.upsert).not.toHaveBeenCalled();

    // The next settle of the same revision does not call again.
    const out2 = await runRecognition(region, elements, [], on, d);
    expect(out2).toMatchObject({ status: "unchecked" });
    expect(offline).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION);

    // An edit is a new revision: it gets its own attempts.
    const edited = [{ ...elements[0], updatedAt: "2026-02-01T00:00:00.000Z", version: 1 }];
    await runRecognition(region, edited, [], on, d);
    expect(offline).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION * 2);

    // A thrown non-protocol error (e.g. the IPC bridge failing) is handled the same way.
    const weird = deps({ recognize: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await expect(runRecognition(region, elements, [], on, weird)).resolves.toMatchObject({ status: "unchecked" });
  });

  it("stops at once on a rejected key and blocks further checks", async () => {
    const auth = vi.fn(async () => Promise.reject({ kind: "auth", message: "The API key was not accepted. Check it in Settings." }));
    const d = deps({ recognize: auth });
    const out = await runRecognition(region, elements, [], on, d);
    expect(out).toMatchObject({ status: "unchecked", kind: "auth", reason: "The API key was not accepted. Check it in Settings." });
    expect(auth).toHaveBeenCalledTimes(1);
    const other: Region = { ...region, regionId: "g2" };
    await runRecognition(other, elements, [], on, d);
    expect(auth).toHaveBeenCalledTimes(1);
    d.attempts.clearAuthBlock();
    await runRecognition(other, elements, [], on, d);
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it("pipeline_drops_stale_result", async () => {
    const d = deps({ upsert: vi.fn(async () => "stale" as const) });
    const out = await runRecognition(region, elements, [], on, d);
    expect(out).toEqual({ status: "stale" });
    // No retry for a stale result.
    expect(d.recognize).toHaveBeenCalledTimes(1);
  });

  it("warns above 512 KB and survives a failed capture or write", async () => {
    const big = deps({
      capture: vi.fn(async () => ({ png: new Uint8Array(600 * 1024), bounds: region.bounds, width: 2048, height: 2048 })),
    });
    await runRecognition(region, elements, [], on, big);
    expect(big.warn).toHaveBeenCalledTimes(1);

    const noCanvas = deps({ capture: vi.fn(async () => Promise.reject(new Error("no canvas"))) });
    expect(await runRecognition(region, elements, [], on, noCanvas)).toMatchObject({ status: "unchecked", kind: "capture" });
    expect(noCanvas.recognize).not.toHaveBeenCalled();

    const failingWrite = deps({ upsert: vi.fn(async () => Promise.reject(new Error("disk full"))) });
    expect(await runRecognition(region, elements, [], on, failingWrite)).toMatchObject({ status: "checked", stored: false });
  });
});
