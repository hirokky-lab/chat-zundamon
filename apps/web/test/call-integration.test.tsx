import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App, type RealtimeClientFactory } from "../src/App";
import type { MemoryApi } from "../src/api";
import { EMPTY_LOCAL_CHAT, type LocalStateStore } from "../src/local-state";
import type { EphemeralCallMemoryBatch } from "../src/realtime-client";
import type { SessionAction } from "../src/session-reducer";

const now = "2026-08-08T12:48:00.000Z";
const chatProps = {
  chatStore: { load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined } satisfies LocalStateStore,
  profileApi: { get: async () => ({ displayName: "大輝", addressingStyle: "san" as const, updatedAt: now }), save: async (input: { displayName: string; addressingStyle: "san" | "none" }) => ({ ...input, updatedAt: now }) },
  chatApi: { respond: async ({ clientMessageId }: { clientMessageId: string }) => ({
    replyGroupId: `${clientMessageId}:assistant`,
    bubbles: [{
      id: `${clientMessageId}:assistant:0`,
      text: "こんばんは",
      createdAt: now,
      sequence: 0 as const,
    }],
  }) },
  now: () => now,
};

const memoryBatch: EphemeralCallMemoryBatch = {
  sessionId: "call-1",
  sourceOccurredAt: "2026-08-08T12:00:10.000Z",
  turns: [
    { role: "user", text: "毎週水曜は図書館に行く。これを覚えておいて", occurredAt: "2026-08-08T12:00:10.000Z" },
    { role: "assistant", text: "通話が終わって保存できた後にだけ確認できます。", occurredAt: "2026-08-08T12:00:12.000Z" },
  ],
  explicitMemoryTargetTurnIndexes: [0],
};

function fakeMemoryApi(options: {
  process?: MemoryApi["process"];
  memoryEnabled?: boolean;
} = {}): MemoryApi {
  return {
    process: options.process ?? vi.fn(async (input) => ({ sourceMessageId: input.sourceMessageId, state: "completed" as const, appliedCount: 1 })),
    list: vi.fn(async () => []),
    update: vi.fn(),
    forget: vi.fn(),
    listTombstones: vi.fn(async () => []),
    releaseTombstone: vi.fn(),
    getSettings: vi.fn(async () => ({
      memoryEnabled: options.memoryEnabled ?? true,
      updatedAt: null,
    })),
    updateSettings: vi.fn(),
  } as MemoryApi;
}

function controlledCall(batch: EphemeralCallMemoryBatch | null = memoryBatch) {
  let dispatch: ((action: SessionAction) => void) | undefined;
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(() => dispatch?.({ type: "stopped" }));
  const consumeMemoryBatch = vi.fn(() => batch);
  const cancelMemory = vi.fn();
  const factory: RealtimeClientFactory = (nextDispatch) => {
    dispatch = nextDispatch;
    return { start, stop, consumeMemoryBatch, cancelMemory, usageContext: () => ({ sessionId: "call-1", startedAt: "2026-08-08T12:00:00.000Z", endedAt: "2026-08-08T12:00:30.000Z" }) };
  };
  return { factory, start, stop, consumeMemoryBatch, cancelMemory, emit(action: SessionAction) { act(() => dispatch?.(action)); } };
}

describe("call integration", () => {
  it("keeps persisted call cards through the hydrate opening write and blocks calls until hydration completes", async () => {
    const saves: unknown[] = [];
    const store: LocalStateStore = {
      load: async () => ({ ...EMPTY_LOCAL_CHAT, timeline: [{ id: "call:old", type: "call", startedAt: "2026-08-08T11:00:00.000Z", endedAt: "2026-08-08T11:12:00.000Z" }] }),
      save: async (snapshot) => { saves.push(snapshot); },
    };
    render(<App {...chatProps} splashDurationMs={0} chatStore={store} />);
    expect(await screen.findByText("ずんだもんと12分話しました")).toBeVisible();
    await waitFor(() => expect(saves.some((snapshot) => JSON.stringify(snapshot).includes("call:old"))).toBe(true));
  });

  it("keeps the messenger visible while preparing and enters Session only after connected", async () => {
    const call = controlledCall();
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={call.factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));

    expect(call.start).toHaveBeenCalledTimes(1);
    const preparingButton = screen.getByRole("button", { name: "通話を準備しています" });
    expect(preparingButton).toBeDisabled();
    expect(preparingButton).not.toHaveTextContent("通話を準備しています");
    expect(preparingButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();

    call.emit({ type: "connected" });
    expect(await screen.findByText("聞いています")).toBeVisible();
  });

  it("returns safely to chat after a call connection failure", async () => {
    const start = vi.fn(async () => { throw new Error("connection unavailable"); });
    const factory: RealtimeClientFactory = () => ({ start, stop: vi.fn() });
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ずんだもんとの接続に失敗しました。マイクは停止しています");
    expect(screen.queryByText(/VOICEVOX Nemoを起動/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "もう一度試す" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeEnabled();
  });

  it("shows actionable microphone guidance when call permission is denied", async () => {
    const start = vi.fn(async () => { throw new DOMException("denied", "NotAllowedError"); });
    const factory: RealtimeClientFactory = () => ({ start, stop: vi.fn() });
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "通話にはマイクの許可が必要です。iPhoneの設定でChatずんだもんのマイクを許可してください。",
    );
  });

  it("recovers when the realtime client factory throws synchronously", async () => {
    const factory: RealtimeClientFactory = () => {
      throw new Error("factory failed");
    };
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);

    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ずんだもんとの接続に失敗しました。マイクは停止しています",
    );
    expect(screen.getByRole("button", { name: "ライブチャットを開始" })).toBeEnabled();
  });

  it("recovers when realtime start throws synchronously", async () => {
    const stop = vi.fn();
    const factory: RealtimeClientFactory = () => ({
      start: () => {
        throw new DOMException("denied", "NotAllowedError");
      },
      stop,
    });
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);

    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "通話にはマイクの許可が必要です。iPhoneの設定でChatずんだもんのマイクを許可してください。",
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "ライブチャットを開始" })).toBeEnabled();
  });

  it("recovers when realtime start rejects", async () => {
    const stop = vi.fn();
    const factory: RealtimeClientFactory = () => ({
      start: async () => {
        throw new TypeError("network");
      },
      stop,
    });
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);

    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ずんだもんとの接続に失敗しました。マイクは停止しています",
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "ライブチャットを開始" })).toBeEnabled();
  });

  it("times out an unanswered realtime start after twelve seconds", async () => {
    const stop = vi.fn();
    const factory: RealtimeClientFactory = () => ({
      start: () => new Promise<void>(() => undefined),
      stop,
    });
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);
    const callButton = await screen.findByRole("button", { name: "ライブチャットを開始" });

    vi.useFakeTimers();
    try {
      fireEvent.click(callButton);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });

      expect(stop).toHaveBeenCalledOnce();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "ずんだもんとの接続に失敗しました。マイクは停止しています",
      );
      expect(screen.getByRole("button", { name: "ライブチャットを開始" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale connected callback when a reused client has a newer attempt", async () => {
    const dispatches: Array<(action: SessionAction) => void> = [];
    const start = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    const sharedClient = { start, stop: vi.fn() };
    const factory: RealtimeClientFactory = (dispatch) => {
      dispatches.push(dispatch);
      return sharedClient;
    };
    render(<App {...chatProps} splashDurationMs={0} realtimeClient={factory} />);

    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    expect(await screen.findByRole("alert")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "ライブチャットを開始" }));
    expect(start).toHaveBeenCalledTimes(2);

    act(() => dispatches[0]?.({ type: "connected" }));

    expect(screen.queryByText("聞いています")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(screen.getByRole("button", { name: "通話を準備しています" })).toBeDisabled();
  });

  it("returns voice turns to Talk and submits memory processing once after a normal stop", async () => {
    const call = controlledCall();
    const saves: unknown[] = [];
    let settle: ((value: { sourceMessageId: string; state: "completed"; appliedCount: number }) => void) | undefined;
    const process = vi.fn((input: { sourceMessageId: string }, signal?: AbortSignal) => new Promise<{ sourceMessageId: string; state: "completed"; appliedCount: number }>((resolve, reject) => {
      settle = resolve;
      signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
    }));
    render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi({ process })} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async (snapshot) => { saves.push(snapshot); } }} realtimeClient={call.factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    call.emit({ type: "connected" });
    call.emit({ type: "transcript", turn: { role: "user", text: "毎週水曜は図書館に行く。これを覚えておいて" } });
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを終了" }));

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    expect(process).toHaveBeenCalledWith(expect.objectContaining({
      sourceMessageId: expect.stringMatching(/^voice:[a-f0-9]{64}$/),
      sourceOccurredAt: memoryBatch.sourceOccurredAt,
      sourceOrigin: "voice",
      explicitMemoryTargetTurnIndexes: [0],
      turns: [
        { role: "user", text: memoryBatch.turns[0].text, provenance: "authoritative_source" },
        { role: "assistant", text: memoryBatch.turns[1].text, provenance: "context" },
      ],
    }), expect.any(AbortSignal));
    expect(await screen.findByText("ずんだもんと1分未満話しました")).toBeVisible();
    expect(screen.getByLabelText("ずんだもんとの会話")).toHaveTextContent(memoryBatch.turns[0].text);
    await waitFor(() => expect(saves.some((snapshot) => JSON.stringify(snapshot).includes(memoryBatch.turns[0].text))).toBe(true));
    settle?.({ sourceMessageId: "ignored-by-test", state: "completed", appliedCount: 1 });
  });

  it("never blocks chat on voice processing failure and ignores duplicate end events", async () => {
    const call = controlledCall({ ...memoryBatch, explicitMemoryTargetTurnIndexes: [] });
    const process = vi.fn(async () => { throw new Error("memory unavailable"); });
    const firstMount = render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi({ process })} realtimeClient={call.factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    call.emit({ type: "connected" });
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを終了" }));
    call.emit({ type: "stopped" });

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();

    firstMount.unmount();
    render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi({ process })} realtimeClient={controlledCall().factory} />);
    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("does no processing when YUI memory is off and cancels ephemeral work on unmount", async () => {
    const disabledCall = controlledCall();
    const disabledProcess = vi.fn();
    const disabled = render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi({ process: disabledProcess, memoryEnabled: false })} realtimeClient={disabledCall.factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    disabledCall.emit({ type: "connected" });
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを終了" }));
    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    expect(disabledProcess).not.toHaveBeenCalled();
    expect(disabledCall.consumeMemoryBatch).toHaveBeenCalledOnce();
    disabled.unmount();

    const activeCall = controlledCall();
    let submittedSignal: AbortSignal | undefined;
    const process = vi.fn((_input, signal) => {
      submittedSignal = signal;
      return new Promise(() => undefined);
    });
    const active = render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi({ process })} realtimeClient={activeCall.factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    activeCall.emit({ type: "connected" });
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを終了" }));
    await waitFor(() => expect(process).toHaveBeenCalledOnce());
    active.unmount();

    expect(submittedSignal?.aborted).toBe(true);

    const connectedCall = controlledCall();
    const connected = render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi()} realtimeClient={connectedCall.factory} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    connectedCall.emit({ type: "connected" });
    connected.unmount();
    expect(connectedCall.cancelMemory).toHaveBeenCalledOnce();
  });

  it("aborts unsettled voice processing on logout", async () => {
    const call = controlledCall();
    const onSignOut = vi.fn(async () => undefined);
    let submittedSignal: AbortSignal | undefined;
    const process = vi.fn((_input, signal) => {
      submittedSignal = signal;
      return new Promise(() => undefined);
    });
    render(<App {...chatProps} splashDurationMs={0} memoryApi={fakeMemoryApi({ process })} realtimeClient={call.factory} onSignOut={onSignOut} />);
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    call.emit({ type: "connected" });
    await userEvent.click(await screen.findByRole("button", { name: "ライブチャットを終了" }));
    await waitFor(() => expect(process).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("button", { name: "設定を開く" }));
    await userEvent.click(screen.getByRole("button", { name: "ログアウト" }));

    expect(submittedSignal?.aborted).toBe(true);
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
