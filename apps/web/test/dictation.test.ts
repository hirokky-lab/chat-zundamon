import { describe, expect, it, vi } from "vitest";
import {
  CHAT_DICTATION_MAX_BYTES,
  CHAT_DICTATION_MAX_MS,
} from "@yui/domain";
import {
  createDictationController,
  type DictationController,
  type DictationRecorder,
} from "../src/dictation";

class FakeRecorder implements DictationRecorder {
  static supported = true;
  static latest: FakeRecorder | null = null;
  static throwOnStart = false;
  readonly chunks: Blob[] = [];
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, readonly options: MediaRecorderOptions) {
    FakeRecorder.latest = this;
  }

  static isTypeSupported() {
    return FakeRecorder.supported;
  }

  start() {
    if (FakeRecorder.throwOnStart) throw new Error("recorder start failed");
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.onstop?.();
  }

  emit(blob: Blob) {
    this.ondataavailable?.({ data: blob } as BlobEvent);
  }
}

function createFakes() {
  FakeRecorder.latest = null;
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  const transcribe = vi.fn(async () => "今日は休み");
  const onTranscript = vi.fn();
  const onState = vi.fn();
  const onError = vi.fn();
  const controller = createDictationController({
    mediaDevices: { getUserMedia } as Pick<MediaDevices, "getUserMedia">,
    MediaRecorder: FakeRecorder,
    transcriptionApi: { transcribe },
    clock: window,
    onTranscript,
    onState,
    onError,
  });
  return { controller, getUserMedia, transcribe, onTranscript, onState, onError, stop, stream };
}

async function startRecording(controller: DictationController) {
  await controller.start();
  expect(FakeRecorder.latest).not.toBeNull();
  return FakeRecorder.latest!;
}

describe("dictation controller", () => {
  it("records, transcribes, and releases the microphone after a normal stop", async () => {
    const { controller, getUserMedia, transcribe, onTranscript, onState, stop } = createFakes();

    const recorder = await startRecording(controller);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(onState).toHaveBeenLastCalledWith("recording");
    recorder.emit(new Blob(["voice"], { type: "audio/webm" }));

    await controller.stop();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledWith("今日は休み");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith("idle");
  });

  it("stops automatically at the maximum duration", async () => {
    vi.useFakeTimers();
    try {
      const { controller, transcribe } = createFakes();
      const recorder = await startRecording(controller);
      recorder.emit(new Blob(["voice"], { type: "audio/webm" }));

      await vi.advanceTimersByTimeAsync(CHAT_DICTATION_MAX_MS);

      expect(transcribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a second tap as one stop request", async () => {
    const { controller, transcribe, onTranscript, stop } = createFakes();
    const recorder = await startRecording(controller);
    recorder.emit(new Blob(["voice"], { type: "audio/webm" }));

    await Promise.all([controller.stop(), controller.stop()]);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("returns to idle and reports a retryable error when microphone permission is denied", async () => {
    const { onState, onError } = createFakes();
    const denied = createDictationController({
      mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); }) } as Pick<MediaDevices, "getUserMedia">,
      MediaRecorder: FakeRecorder,
      transcriptionApi: { transcribe: vi.fn() },
      clock: window,
      onTranscript: vi.fn(),
      onState,
      onError,
    });

    await denied.start();

    expect(onState).toHaveBeenLastCalledWith("idle");
    expect(denied.state).toBe("idle");
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ name: "NotAllowedError" });
  });

  it("does not retain microphone data when recording is empty, too large, aborted, or transcribes blank text", async () => {
    const { controller, transcribe, onTranscript, onError, stop } = createFakes();
    const empty = await startRecording(controller);
    await controller.stop();
    expect(transcribe).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
    expect(onError).toHaveBeenCalledTimes(1);

    const oversized = await startRecording(controller);
    oversized.emit(new Blob([new Uint8Array(CHAT_DICTATION_MAX_BYTES + 1)], { type: "audio/webm" }));
    await controller.stop();
    expect(transcribe).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
    expect(onError).toHaveBeenCalledTimes(2);

    const abortable = await startRecording(controller);
    abortable.emit(new Blob(["voice"], { type: "audio/webm" }));
    controller.abort();
    await controller.stop();
    expect(transcribe).not.toHaveBeenCalled();

    const blank = await startRecording(controller);
    blank.emit(new Blob(["voice"], { type: "audio/webm" }));
    transcribe.mockResolvedValueOnce("   ");
    await controller.stop();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(controller.state).toBe("idle");
    expect(stop).toHaveBeenCalledTimes(4);
    const fresh = await startRecording(controller);
    fresh.emit(new Blob(["new-only"], { type: "audio/webm" }));
    transcribe.mockResolvedValueOnce("新しい録音");
    await controller.stop();
    expect(transcribe.mock.calls.at(-1)?.[0].size).toBe(8);
  });

  it("returns to idle with a retryable error after transcription fails", async () => {
    const { controller, transcribe, onError } = createFakes();
    const recorder = await startRecording(controller);
    recorder.emit(new Blob(["voice"], { type: "audio/webm" }));
    transcribe.mockRejectedValueOnce(new Error("upstream unavailable"));

    await controller.stop();

    expect(controller.state).toBe("idle");
    expect(onError).toHaveBeenCalledOnce();
    await expect(controller.start()).resolves.toBeUndefined();
    expect(controller.state).toBe("recording");
  });

  it("does not begin recording when the browser has no supported recorder", async () => {
    FakeRecorder.supported = false;
    try {
      const { controller, onState, onError, stop } = createFakes();
      await controller.start();

      expect(controller.state).toBe("idle");
      expect(onState).toHaveBeenLastCalledWith("idle");
      expect(onError).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      FakeRecorder.supported = true;
    }
  });

  it("cleans a session when recorder.start throws and permits a fresh retry", async () => {
    FakeRecorder.throwOnStart = true;
    try {
      const { controller, getUserMedia, onError, stop } = createFakes();

      await controller.start();

      const failedRecorder = FakeRecorder.latest!;
      expect(controller.state).toBe("idle");
      expect(onError).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(failedRecorder.ondataavailable).toBeNull();
      expect(failedRecorder.onerror).toBeNull();
      expect(failedRecorder.onstop).toBeNull();

      FakeRecorder.throwOnStart = false;
      await controller.start();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(FakeRecorder.latest).not.toBe(failedRecorder);
    } finally {
      FakeRecorder.throwOnStart = false;
    }
  });

  it("transcribes once when duplicate recorder stop events arrive", async () => {
    let resolveTranscript: ((text: string) => void) | undefined;
    const { controller, transcribe, onTranscript, stop } = createFakes();
    transcribe.mockImplementation(() => new Promise<string>((resolve) => { resolveTranscript = resolve; }));
    const recorder = await startRecording(controller);
    recorder.emit(new Blob(["voice"], { type: "audio/webm" }));

    const finished = controller.stop();
    recorder.onstop?.();
    expect(transcribe).toHaveBeenCalledTimes(1);
    resolveTranscript?.("一度だけ");
    await finished;

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("releases a stream that resolves after abort without creating a recorder", async () => {
    FakeRecorder.latest = null;
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const controller = createDictationController({
      mediaDevices: { getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve; })) } as Pick<MediaDevices, "getUserMedia">,
      MediaRecorder: FakeRecorder,
      transcriptionApi: { transcribe: vi.fn() },
      clock: window,
      onTranscript: vi.fn(),
      onState: vi.fn(),
      onError: vi.fn(),
    });

    const starting = controller.start();
    controller.abort();
    resolveStream?.(stream);
    await starting;

    expect(stop).toHaveBeenCalledOnce();
    expect(FakeRecorder.latest).toBeNull();
    expect(controller.state).toBe("idle");
  });

  it("aborts an in-flight transcription and clears recorder handlers without sending", async () => {
    let resolveTranscript: ((text: string) => void) | undefined;
    const { controller, transcribe, onTranscript, stop } = createFakes();
    transcribe.mockImplementation((_blob: Blob, signal: AbortSignal) => new Promise<string>((resolve) => {
      resolveTranscript = resolve;
      expect(signal.aborted).toBe(false);
    }));
    const recorder = await startRecording(controller);
    recorder.emit(new Blob(["voice"], { type: "audio/webm" }));

    const finished = controller.stop();
    expect(transcribe).toHaveBeenCalledOnce();
    controller.abort();
    resolveTranscript?.("送ってはいけない");
    await finished;

    expect(onTranscript).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
    expect(recorder.ondataavailable).toBeNull();
    expect(recorder.onerror).toBeNull();
    expect(recorder.onstop).toBeNull();
    expect(controller.state).toBe("idle");
  });
});
