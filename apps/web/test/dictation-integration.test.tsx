import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { EMPTY_LOCAL_CHAT, type LocalStateStore } from "../src/local-state";

const now = "2026-08-09T12:00:00.000Z";
const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: now };

class BrowserRecorder {
  static current: BrowserRecorder | null = null;
  static isTypeSupported() { return true; }
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, _options: MediaRecorderOptions) {
    BrowserRecorder.current = this;
  }

  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) } as BlobEvent);
    this.onstop?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("chat dictation", () => {
  it("puts the transcript into the draft when the microphone is pressed again", async () => {
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
    });
    vi.stubGlobal("MediaRecorder", BrowserRecorder);
    const saves: unknown[] = [];
    const store: LocalStateStore = { load: async () => EMPTY_LOCAL_CHAT, save: async (snapshot) => { saves.push(snapshot); } };
    const transcribe = vi.fn(async () => "今日は休み");
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({
      replyGroupId: `${clientMessageId}:assistant`,
      bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "ゆっくりしてね", createdAt: now, sequence: 0 as const }],
    }));
    const user = userEvent.setup();

    render(<App splashDurationMs={0} chatStore={store} profileApi={{ get: async () => profile, save: async () => profile }} chatApi={{ respond }} transcriptionApi={{ transcribe }} now={() => now} nextId={() => "voice-message"} />);
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    respond.mockClear();

    await user.click(await screen.findByRole("button", { name: "音声入力を開始" }));
    expect(screen.getByRole("button", { name: "音声入力を停止" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "音声入力を停止" }));

    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(respond).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toHaveValue("今日は休み");
    expect(JSON.stringify(saves)).not.toContain("audio/webm");
  });

  it("transcribes and sends exactly once when send is pressed during recording", async () => {
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
    });
    vi.stubGlobal("MediaRecorder", BrowserRecorder);
    const transcribe = vi.fn(async () => "そのまま送って");
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({
      replyGroupId: `${clientMessageId}:assistant`,
      bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "送ったよ", createdAt: now, sequence: 0 as const }],
    }));
    const user = userEvent.setup();

    render(<App splashDurationMs={0} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined }} profileApi={{ get: async () => profile, save: async () => profile }} chatApi={{ respond }} transcriptionApi={{ transcribe }} now={() => now} nextId={() => "voice-send"} />);
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    respond.mockClear();

    await user.click(await screen.findByRole("button", { name: "音声入力を開始" }));
    await user.click(screen.getByRole("button", { name: "録音を送信" }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toHaveValue("");
  });

  it("releases a microphone permission stream that resolves after the chat unmounts", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const trackStop = vi.fn();
    BrowserRecorder.current = null;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => { resolveStream = resolve; })) },
    });
    vi.stubGlobal("MediaRecorder", BrowserRecorder);
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({ replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "こんにちは", createdAt: now, sequence: 0 as const }] }));
    const transcribe = vi.fn();
    const user = userEvent.setup();

    const app = render(<App splashDurationMs={0} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined }} profileApi={{ get: async () => profile, save: async () => profile }} chatApi={{ respond }} transcriptionApi={{ transcribe }} now={() => now} nextId={() => "pending-permission"} />);
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "音声入力を開始" }));
    app.unmount();
    resolveStream?.({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
    await Promise.resolve();

    expect(trackStop).toHaveBeenCalledOnce();
    expect(BrowserRecorder.current).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight transcription on unmount without sending its transcript", async () => {
    let resolveTranscript: ((text: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: trackStop }] })) },
    });
    vi.stubGlobal("MediaRecorder", BrowserRecorder);
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({ replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "こんにちは", createdAt: now, sequence: 0 as const }] }));
    const transcribe = vi.fn((_blob: Blob, requestSignal: AbortSignal) => new Promise<string>((resolve) => { signal = requestSignal; resolveTranscript = resolve; }));
    const user = userEvent.setup();

    const app = render(<App splashDurationMs={0} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined }} profileApi={{ get: async () => profile, save: async () => profile }} chatApi={{ respond }} transcriptionApi={{ transcribe }} now={() => now} nextId={() => "pending-transcript"} />);
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    respond.mockClear();
    await user.click(screen.getByRole("button", { name: "音声入力を開始" }));
    await user.click(screen.getByRole("button", { name: "音声入力を停止" }));
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    const recorder = BrowserRecorder.current!;

    app.unmount();
    resolveTranscript?.("画面を閉じた後の発話");
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    expect(trackStop).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
    expect(recorder.ondataavailable).toBeNull();
    expect(recorder.onerror).toBeNull();
    expect(recorder.onstop).toBeNull();
  });

  it("does not retry dictation from the error control while a draft locks the composer", async () => {
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", BrowserRecorder);
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({ replyGroupId: `${clientMessageId}:assistant`, bubbles: [{ id: `${clientMessageId}:assistant:0`, text: "こんにちは", createdAt: now, sequence: 0 as const }] }));
    const user = userEvent.setup();

    render(<App splashDurationMs={0} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined }} profileApi={{ get: async () => profile, save: async () => profile }} chatApi={{ respond }} transcriptionApi={{ transcribe: vi.fn(async () => { throw new Error("failed"); }) }} now={() => now} nextId={() => "locked-retry"} />);
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "音声入力を開始" }));
    await user.click(screen.getByRole("button", { name: "音声入力を停止" }));
    const retry = await screen.findByRole("button", { name: "もう一度試す" });
    await user.type(screen.getByRole("textbox", { name: "メッセージ" }), "下書き中");

    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
