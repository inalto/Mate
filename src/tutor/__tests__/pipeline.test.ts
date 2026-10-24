import { describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { RecognizeResult } from "../../ipc/recognize";
import { DEFAULT_SETTINGS } from "../../model/constants";
import type { Recognition, Settings } from "../../model/types";
import { el } from "../../tools/__tests__/fixtures";
import { createAttemptLedger, MAX_ATTEMPTS_PER_REVISION, RETRY_DELAY_MS, revisionOf, runRecognition, type PipelineDeps } from "../pipeline";
import type { Region } from "../types";

const on: Settings = { ...DEFAULT_SETTINGS, aiConsent: true, tutorEnabled: true };
const region: Region = { regionId: "g1", type: "math", elementIds: ["a"], bounds: { x: 0, y: 0, width: 50, height: 30 }, baselineY: 30 };
const elements = [el("a", [[0, 0], [50, 30]])];

const result: RecognizeResult = {
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
  provider: "anthropic",
  model: "claude-opus-5-5",
};
const verdict = (({ provider: _p, model: _m, ...v }) => v)(result);

const fail = (kind: string, message = "Something went wrong.") =>
  vi.fn(async (): Promise<RecognizeResult> => Promise.reject({ kind, message }));

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    recognize: vi.fn(async () => result),
    upsert: vi.fn(async () => "stored" as const),
    capture: vi.fn(async () => ({ png: new Uint8Array([1, 2, 3]), bounds: { x: -24, y: -24, width: 98, height: 78 }, width: 10, height: 8 })),
    now: () => 1_000,
    warn: vi.fn(),
    flushWrites: vi.fn(async () => {}),
    toast: vi.fn(),
    attempts: createAttemptLedger(),
    ...over,
  };
}

const retryOf = (out: unknown) => (out && typeof out === "object" && "retryInMs" in out ? out.retryInMs : undefined);

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
    const d = deps({ recognize: fail("disabled", "AI checking is off.") });
    expect(await runRecognition(region, elements, [], on, d)).toBeNull();
    expect(d.recognize).toHaveBeenCalledTimes(1);
  });

  it("checks, persists with capturedAt and the provider Rust used, and skips an unchanged result", async () => {
    const d = deps();
    const out = await runRecognition(region, elements, [], on, d);
    expect(out).toMatchObject({ status: "checked", verdict, stored: true });
    const rec = vi.mocked(d.upsert).mock.calls[0][0];
    expect(rec).toMatchObject({
      pageId: "pg",
      strokeGroupId: "g1",
      elementIds: ["a"],
      capturedAt: 1_000,
      source: "auto",
      provider: "anthropic",
      model: "claude-opus-5-5",
    });
    expect(rec.bounds).toEqual(region.bounds);
    const req = vi.mocked(d.recognize).mock.calls[0][0];
    expect(req.imagePngBase64).toBe("AQID");

    // Same verdict for the same, unchanged members with a stored row: nothing is written again.
    const again = deps();
    const stored = { ...rec, createdAt: "t", updatedAt: "t" } as Recognition;
    const out2 = await runRecognition(region, elements, [stored], on, again, { persisted: () => true, elementsNow: () => elements });
    expect(out2).toMatchObject({ status: "checked", stored: false, unchanged: true });
    expect(again.upsert).not.toHaveBeenCalled();
  });

  it("unchanged_reply_after_edit_is_persisted", async () => {
    const stored = {
      ...verdict,
      pageId: "pg",
      strokeGroupId: "g1",
      elementIds: ["a"],
      bounds: region.bounds,
      source: "auto",
      userOverride: false,
      provider: "anthropic",
      model: "claude-opus-5-5",
      createdAt: "t",
      updatedAt: "t",
      capturedAt: 500,
    } as Recognition;
    // A lasso nudge lands while the reply is on its way: same verdict, but the ink moved.
    const nudged = [{ ...elements[0], updatedAt: "2026-03-01T00:00:00.000Z", version: 2 }];
    const d = deps({ upsert: vi.fn(async () => "stale" as const) });
    const out = await runRecognition(region, elements, [stored], on, d, { persisted: () => true, elementsNow: () => nudged });
    // Written (so Rust runs its stale check) instead of being shown without a row.
    expect(d.upsert).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ status: "stale" });

    // Same ink, but no stored row is known (e.g. a verdict restored in memory): written too.
    const d2 = deps();
    const out2 = await runRecognition(region, elements, [stored], on, d2, { persisted: () => false, elementsNow: () => elements });
    expect(d2.upsert).toHaveBeenCalledTimes(1);
    expect(out2).toMatchObject({ status: "checked", stored: true });
  });

  it("capture_waits_for_pending_element_writes", async () => {
    let flushed!: () => void;
    const order: string[] = [];
    let clock = 1_000;
    const d = deps({
      flushWrites: vi.fn(() => new Promise<void>((r) => (flushed = () => (order.push("flushed"), r())))),
      now: () => (order.push("stamp"), clock),
    });
    const run = runRecognition(region, elements, [], on, d);
    await Promise.resolve();
    await Promise.resolve();
    // The edit is still in the write-behind queue: no stamp, no capture yet.
    expect(d.flushWrites).toHaveBeenCalledTimes(1);
    expect(d.capture).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    clock = 1_200;
    flushed();
    await run;
    expect(order).toEqual(["flushed", "stamp"]);
    expect(vi.mocked(d.upsert).mock.calls[0][0].capturedAt).toBe(1_200);
    // A failing flush never blocks checking.
    const broken = deps({ flushWrites: vi.fn(async () => Promise.reject(new Error("io"))) });
    expect(await runRecognition(region, elements, [], on, broken)).toMatchObject({ status: "checked" });
  });

  it("stale results count as attempts", async () => {
    const d = deps({ upsert: vi.fn(async () => "stale" as const) });
    for (let i = 0; i < MAX_ATTEMPTS_PER_REVISION; i++) expect(await runRecognition(region, elements, [], on, d)).toEqual({ status: "stale" });
    expect(await runRecognition(region, elements, [], on, d)).toMatchObject({ status: "unchecked", kind: "exhausted" });
    expect(d.recognize).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION);
    // A stored result clears the count for its revision.
    const ok = deps();
    await runRecognition(region, elements, [], on, ok);
    expect(ok.attempts.count(revisionOf(region, elements))).toBe(0);
  });

  it("offline_does_not_block_or_retry_forever", async () => {
    const offline = fail("network", "Could not reach the AI service (no connection).");
    const d = deps({ recognize: offline });
    // One request per settle; it resolves (never throws) with a muted state and asks for a later retry.
    const first = await runRecognition(region, elements, [], on, d);
    expect(first).toMatchObject({ status: "unchecked", kind: "network", retryInMs: RETRY_DELAY_MS });
    expect(offline).toHaveBeenCalledTimes(1);
    const second = await runRecognition(region, elements, [], on, d);
    expect(retryOf(second)).toBe(RETRY_DELAY_MS * 2);
    // The third attempt is the last: no further retry is asked for.
    const third = await runRecognition(region, elements, [], on, d);
    expect(third).toMatchObject({ status: "unchecked", kind: "network" });
    expect(retryOf(third)).toBeUndefined();
    expect(offline).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION);
    expect(MAX_ATTEMPTS_PER_REVISION).toBe(3);
    expect(d.upsert).not.toHaveBeenCalled();

    // Later settles of the same revision do not call again.
    expect(await runRecognition(region, elements, [], on, d)).toMatchObject({ status: "unchecked", kind: "exhausted" });
    expect(offline).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION);

    // An edit is a new revision: it gets its own attempts.
    const edited = [{ ...elements[0], updatedAt: "2026-02-01T00:00:00.000Z", version: 1 }];
    await runRecognition(region, edited, [], on, d);
    expect(offline).toHaveBeenCalledTimes(MAX_ATTEMPTS_PER_REVISION + 1);

    // A thrown non-protocol error (e.g. the IPC bridge failing) is handled the same way.
    const weird = deps({ recognize: vi.fn(async () => Promise.reject(new Error("boom"))) });
    await expect(runRecognition(region, elements, [], on, weird)).resolves.toMatchObject({ status: "unchecked" });
  });

  it("refusal_is_not_retried", async () => {
    for (const kind of ["refused", "truncated", "rejected"]) {
      const r = fail(kind);
      const d = deps({ recognize: r });
      const out = await runRecognition(region, elements, [], on, d);
      expect(out).toMatchObject({ status: "unchecked", kind });
      expect(retryOf(out)).toBeUndefined();
      await runRecognition(region, elements, [], on, d);
      expect(r).toHaveBeenCalledTimes(1);
      // Not a block: other groups are still checked.
      expect(d.attempts.block).toBeNull();
    }
  });

  it("billing_error_blocks_live_mode", async () => {
    for (const kind of ["auth", "billing", "unknownModel"]) {
      const r = fail(kind, `Blocked by ${kind}.`);
      const d = deps({ recognize: r });
      const out = await runRecognition(region, elements, [], on, d);
      // The structured kind is shown in the interface language (errors.ai.<kind>).
      const sentence = i18n.t(`errors.ai.${kind as "auth" | "billing" | "unknownModel"}`);
      expect(out).toMatchObject({ status: "unchecked", kind, reason: sentence });
      expect(r).toHaveBeenCalledTimes(1);
      // The block is announced once with the same sentence Ask uses, not only the muted marker.
      expect(d.toast).toHaveBeenCalledTimes(1);
      expect(d.toast).toHaveBeenCalledWith(sentence);
      const other: Region = { ...region, regionId: "g2" };
      expect(await runRecognition(other, elements, [], on, d)).toMatchObject({ status: "unchecked", kind });
      expect(r).toHaveBeenCalledTimes(1);
      // A new key, model or provider clears the block.
      d.attempts.clearAuthBlock();
      await runRecognition(other, elements, [], on, d);
      expect(r).toHaveBeenCalledTimes(2);
      // A new block after the change is announced again.
      expect(d.toast).toHaveBeenCalledTimes(2);
    }
  });

  it("blocking_error_toasts_once_for_concurrent_checks", async () => {
    let fail!: () => void;
    const gate = new Promise<void>((r) => (fail = r));
    const d = deps({ recognize: vi.fn(async (): Promise<RecognizeResult> => gate.then(() => Promise.reject({ kind: "auth", message: "The API key was not accepted." }))) });
    const a = runRecognition(region, elements, [], on, d);
    const b = runRecognition({ ...region, regionId: "g2" }, elements, [], on, d);
    await Promise.resolve();
    fail();
    await Promise.all([a, b]);
    expect(d.recognize).toHaveBeenCalledTimes(2);
    expect(d.toast).toHaveBeenCalledTimes(1);
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

describe("practice context", () => {
  it("answer_under_question_sends_practice_context", async () => {
    const question = el("q", [[0, -200]], {
      type: "text-box",
      boxWidth: 400,
      boxHeight: 80,
      content: { rawContent: "Differentiate x^2", practice: { expectedAnswer: "2x", solutionLatex: "2x", questionType: "short-answer" } },
    });
    const d = deps();
    await runRecognition(region, [...elements, question], [], on, d);
    expect(d.recognize).toHaveBeenCalledWith(expect.objectContaining({ practice: { question: "Differentiate x^2", expectedAnswer: "2x" } }));

    // Not under a practice question: no practice block.
    const d2 = deps();
    await runRecognition(region, elements, [], on, d2);
    expect(vi.mocked(d2.recognize).mock.calls[0][0].practice).toBeUndefined();
  });
});
