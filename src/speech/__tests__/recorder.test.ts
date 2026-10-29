import { afterEach, describe, expect, it, vi } from "vitest";
import { MIME_PREFERENCE, pickMime, RecorderError, startRecording } from "../recorder";

class FakeRecorder {
  static supported = new Set<string>(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
  static last: FakeRecorder | null = null;
  static isTypeSupported = (t: string) => FakeRecorder.supported.has(t);
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "";
    FakeRecorder.last = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["abc"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function install(getUserMedia: () => Promise<unknown>) {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(getUserMedia) }, configurable: true });
}

const fakeStream = () => {
  const track = { stop: vi.fn() };
  return { track, stream: { getTracks: () => [track] } };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeRecorder.supported = new Set(MIME_PREFERENCE);
});

describe("pickMime", () => {
  it("prefers opus in webm, then webm, then mp4, else lets the engine choose", () => {
    expect(pickMime((t) => MIME_PREFERENCE.includes(t as never))).toBe("audio/webm;codecs=opus");
    expect(pickMime((t) => t === "audio/webm" || t === "audio/mp4")).toBe("audio/webm");
    expect(pickMime((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMime(() => false)).toBe("");
    expect(
      pickMime(() => {
        throw new Error("nope");
      }),
    ).toBe("");
  });
});

describe("startRecording", () => {
  it("records with the preferred type and releases the microphone on stop", async () => {
    const { track, stream } = fakeStream();
    install(async () => stream);
    FakeRecorder.supported = new Set(["audio/mp4"]); // WebKit
    const rec = await startRecording();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeRecorder.last?.mimeType).toBe("audio/mp4");
    const out = await rec.stop();
    expect(out.mime).toBe("audio/mp4");
    expect(out.blob.size).toBe(3);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    expect(track.stop).toHaveBeenCalled();
    // A second stop returns the same recording.
    expect(await rec.stop()).toBe(out);
  });

  it("stops by itself at the cap", async () => {
    vi.useFakeTimers();
    const { track, stream } = fakeStream();
    install(async () => stream);
    const onLimit = vi.fn();
    const rec = await startRecording({ onLimit, maxMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.last?.state).toBe("inactive");
    expect(track.stop).toHaveBeenCalled();
    expect((await rec.stop()).mime).toBe("audio/webm;codecs=opus");
  });

  it("maps a refused permission and a missing microphone", async () => {
    install(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    await expect(startRecording()).rejects.toMatchObject({ kind: "permissionDenied" });
    install(async () => {
      throw new DOMException("none", "NotFoundError");
    });
    const err = await startRecording().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecorderError);
    expect((err as RecorderError).kind).toBe("noMicrophone");
  });
});
