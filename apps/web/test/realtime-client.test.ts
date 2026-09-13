import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeClient,
  createVoiceMemorySourceId,
  isExplicitRememberIntent,
  mergeExplicitMemoryTargetTurns,
  refersOnlyToPriorTurn,
  realtimeEventToSessionAction,
} from "../src/realtime-client";
import type { SessionAction } from "../src/session-reducer";

class Channel {
  sent: string[] = [];
  private listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback = typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  send(value: string) { this.sent.push(value); }
  close = vi.fn();
  open() { for (const listener of this.listeners.get("open") ?? []) listener(new Event("open")); }
  message(value: unknown) { for (const listener of this.listeners.get("message") ?? []) listener(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

function browser() {
  const trace: string[] = [];
  const channel = new Channel();
  const tracks = [{ enabled: true, stop: vi.fn() }];
  const peer = {
    ontrack: null as ((event: RTCTrackEvent) => void) | null,
    addTrack: vi.fn(),
    createDataChannel: () => channel,
    createOffer: async () => ({ type: "offer" as const, sdp: "offer" }),
    setLocalDescription: vi.fn(),
    setRemoteDescription: vi.fn(),
    close: vi.fn(),
  };
  const getUserMedia = vi.fn(async () => {
    trace.push("microphone");
    return { getTracks: () => tracks, getAudioTracks: () => tracks } as unknown as MediaStream;
  });
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    trace.push(input === "/api/realtime/calls" ? "realtime" : "usage");
    return new Response(input === "/api/realtime/calls" ? "answer" : null, { status: input === "/api/realtime/calls" ? 201 : 204 });
  });
  return { channel, fetch, getUserMedia, peer, trace, tracks };
}

describe("createRealtimeClient", () => {
  it("rejects a failed start after dispatching a sanitized failure and releasing resources", async () => {
    const fakes = browser();
    const failure = new TypeError("network");
    fakes.getUserMedia.mockRejectedValueOnce(failure);
    const actions: SessionAction[] = [];
    const client = createRealtimeClient({
      dispatch: (action) => actions.push(action),
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
    });

    await expect(client.start()).rejects.toBe(failure);

    expect(actions).toEqual([{ type: "failed", error: failure }]);
    expect(fakes.peer.close).toHaveBeenCalledOnce();
    expect(fakes.fetch).not.toHaveBeenCalled();
  });

  it("plays the remote Realtime stream and releases every remote track once", async () => {
    const fakes = browser();
    const actions: SessionAction[] = [];
    const audio = { autoplay: false, srcObject: null as MediaStream | null };
    const remoteTrack = { stop: vi.fn() } as unknown as MediaStreamTrack;
    const remoteStream = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
    const client = createRealtimeClient({
      dispatch: (action) => actions.push(action),
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
    });

    await client.start();
    fakes.peer.ontrack?.({ track: remoteTrack, streams: [remoteStream] } as unknown as RTCTrackEvent);

    expect(fakes.trace).toEqual(["microphone", "realtime"]);
    expect(audio.autoplay).toBe(true);
    expect(audio.srcObject).toBe(remoteStream);
    client.stop();
    client.stop();
    expect(remoteTrack.stop).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    expect(fakes.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it("keeps browser time-zone, opening request, transcripts, speaking state, and audio-token usage", async () => {
    const fakes = browser();
    const actions: SessionAction[] = [];
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-08-08T12:00:00.000Z"))
      .mockReturnValue(new Date("2026-08-08T12:03:00.000Z"));
    const client = createRealtimeClient({
      dispatch: (action) => actions.push(action),
      fetch: fakes.fetch,
      getTimeZone: () => "Asia/Tokyo",
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
      createSessionId: () => "call-1",
      now,
    });

    await client.start();
    expect(fakes.fetch).toHaveBeenCalledWith("/api/realtime/calls", expect.objectContaining({ headers: { "Content-Type": "application/sdp", "X-Yui-Time-Zone": "Asia/Tokyo", "X-Yui-Session-Id": "call-1" } }));
    fakes.channel.open();
    const events = fakes.channel.sent.map((event) => JSON.parse(event));
    expect(events).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "直近のテキスト会話があればその話題を一つだけ自然に引き継ぎ、なければ現在の時間帯に合う短い挨拶と答えやすい質問一つで始めてください。1文から2文に収め、自己紹介、話題メニュー、サービス案内はしないでください。",
        }],
      },
    });
    expect(events).toContainEqual({ type: "response.create" });
    expect(fakes.channel.sent.join("\n")).not.toContain("何でも選んで");
    expect(fakes.channel.sent.join("\n")).not.toContain("お気軽に");
    fakes.channel.message({ type: "output_audio_buffer.started" });
    fakes.channel.message({ type: "response.output_audio_transcript.done", transcript: "  返事です。 " });
    fakes.channel.message({ type: "output_audio_buffer.stopped" });
    fakes.channel.message({ type: "response.done", response: { usage: { input_token_details: { audio_tokens: 12, cached_tokens_details: { audio_tokens: 2 } }, output_token_details: { audio_tokens: 8 } } } });
    client.stop();

    expect(actions).toEqual(expect.arrayContaining([
      { type: "connected" },
      { type: "speaking" },
      { type: "transcript", turn: { role: "assistant", text: "返事です。" } },
      { type: "listening" },
      { type: "stopped" },
    ]));
    expect(client.usageContext?.()).toEqual({ sessionId: "call-1", startedAt: "2026-08-08T12:00:00.000Z", endedAt: "2026-08-08T12:03:00.000Z" });
    expect(fakes.fetch).toHaveBeenLastCalledWith("/api/usage", expect.objectContaining({ body: expect.stringContaining('"inputAudioTokens":10') }));
    expect(fakes.fetch).toHaveBeenLastCalledWith("/api/usage", expect.objectContaining({ body: expect.stringContaining('"outputAudioTokens":8') }));
  });

  it("counts duplicate transcription and response usage server events only once", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
      createSessionId: () => "usage-dedupe-call",
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-usage-dedupe" } });
    fakes.channel.message({ type: "response.done", event_id: "done-opening-usage", response: { id: "opening-usage-dedupe" } });
    const transcription = {
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "asr-usage-once",
      item_id: "user-usage-once",
      transcript: "利用量は一度だけ",
      usage: { type: "tokens", input_token_details: { audio_tokens: 5, text_tokens: 2 }, output_tokens: 3 },
    };
    fakes.channel.message(transcription);
    fakes.channel.message(transcription);
    fakes.channel.message({ type: "response.created", response: { id: "normal-usage-dedupe" } });
    const responseDone = {
      type: "response.done",
      event_id: "response-usage-once",
      response: {
        id: "normal-usage-dedupe",
        usage: {
          input_token_details: { text_tokens: 10, audio_tokens: 7, cached_tokens_details: { text_tokens: 2, audio_tokens: 1 } },
          output_token_details: { text_tokens: 4, audio_tokens: 3 },
        },
      },
    };
    fakes.channel.message(responseDone);
    fakes.channel.message(responseDone);
    await client.stop();

    const usageRequest = fakes.fetch.mock.calls.at(-1)?.[1] as RequestInit;
    expect(JSON.parse(String(usageRequest.body))).toMatchObject({
      inputTextTokens: 8,
      inputAudioTokens: 6,
      outputTextTokens: 4,
      outputAudioTokens: 3,
      cachedInputTextTokens: 2,
      cachedInputAudioTokens: 1,
      asrInputAudioTokens: 5,
      asrInputTextTokens: 2,
      asrOutputTokens: 3,
    });
  });

  it("stops sending microphone audio while YUI audio is playing", async () => {
    vi.useFakeTimers();
    try {
      const fakes = browser();
      const client = createRealtimeClient({
        dispatch: () => undefined,
        fetch: fakes.fetch,
        getUserMedia: fakes.getUserMedia,
        createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
        createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
      });

      await client.start();
      expect(fakes.tracks[0].enabled).toBe(true);

      fakes.channel.message({ type: "output_audio_buffer.started" });
      expect(fakes.tracks[0].enabled).toBe(false);

      fakes.channel.message({ type: "output_audio_buffer.stopped" });
      expect(fakes.tracks[0].enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(499);
      expect(fakes.tracks[0].enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fakes.tracks[0].enabled).toBe(true);

      fakes.channel.message({ type: "output_audio_buffer.started" });
      fakes.channel.message({ type: "response.done", response: {} });
      expect(fakes.tracks[0].enabled).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(fakes.tracks[0].enabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests an ordinary response as soon as a completed user transcript arrives", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-low-latency" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-low-latency" } });
    const before = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-low-latency", transcript: "今日は散歩したよ" });

    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event))).toEqual([{ type: "response.create" }]);
  });

  it("deduplicates completed items and waits for the matching opening cancellation before an ordinary barge-in", async () => {
    const fakes = browser();
    const actions: SessionAction[] = [];
    const client = createRealtimeClient({
      dispatch: (action) => actions.push(action),
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    const before = fakes.channel.sent.length;

    const transcript = { type: "conversation.item.input_audio_transcription.completed", item_id: "user-barge-1", transcript: "先に今日の話をするね" };
    fakes.channel.message(transcript);
    fakes.channel.message(transcript);
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([]);
    expect(actions.filter((action) => action.type === "transcript" && action.turn.role === "user")).toHaveLength(1);

    fakes.channel.message({ type: "response.created", response: { id: "opening-barge-1" } });
    expect(fakes.channel.sent.map((event) => JSON.parse(event)).filter((event) => event.type === "response.cancel")).toHaveLength(1);
    fakes.channel.message({ type: "response.done", response: { id: "stale-opening" } });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([]);
    fakes.channel.message({ type: "response.done", response: { id: "opening-barge-1" } });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([]);
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "opening-barge-1" });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([{ type: "response.create" }]);
  });

  it("binds an unknown active rejection to done first and waits for matching drain", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-rejection" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-rejection" } });
    const before = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-rejection-1", transcript: "普通の返事をして" });
    fakes.channel.message({ type: "error", error: { code: "conversation_already_has_active_response" } });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event))).toEqual([
      { type: "response.create" },
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
    fakes.channel.message({ type: "response.created", response: { id: "delayed-rejected-create" } });
    fakes.channel.message({ type: "response.done", response: { id: "server-active-unknown" } });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event))).toEqual([
      { type: "response.create" },
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "stale-server-active" });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event))).toEqual([
      { type: "response.create" },
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "server-active-unknown" });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event))).toEqual([
      { type: "response.create" },
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
      { type: "response.create" },
    ]);
  });

  it("binds an unknown active rejection to drain first and waits for matching done", async () => {
    const fakes = browser();
    const audio = { autoplay: false, muted: false, srcObject: null as MediaStream | null };
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-rejection-drain-first" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-rejection-drain-first" } });
    const before = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-rejection-drain-first", transcript: "この話を覚えておいて" });
    fakes.channel.message({ type: "error", error: { code: "conversation_already_has_active_response" } });
    fakes.channel.message({ type: "output_audio_buffer.stopped", response_id: "unknown-drain-first" });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toHaveLength(1);
    fakes.channel.message({ type: "response.done", response: { id: "stale-unknown-drain-first" } });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toHaveLength(1);
    fakes.channel.message({ type: "response.done", response: { id: "unknown-drain-first" } });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([
      { type: "response.create", response: { tool_choice: { type: "function", name: "remember_pending" } } },
      { type: "response.create", response: { tool_choice: { type: "function", name: "remember_pending" } } },
    ]);
    expect(audio.muted).toBe(true);
  });

  it("keeps remote audio muted and the queue blocked when an unknown cancellation has no valid response ID", async () => {
    vi.useFakeTimers();
    try {
      const fakes = browser();
      const actions: SessionAction[] = [];
      const audio = { autoplay: false, muted: false, srcObject: null as MediaStream | null };
      const client = createRealtimeClient({
        dispatch: (action) => actions.push(action),
        fetch: fakes.fetch,
        getUserMedia: fakes.getUserMedia,
        createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
        createAudioElement: () => audio as unknown as HTMLAudioElement,
      });
      await client.start();
      fakes.channel.open();
      fakes.channel.message({ type: "response.created", response: { id: "opening-rejection-no-id" } });
      fakes.channel.message({ type: "response.done", response: { id: "opening-rejection-no-id" } });
      const before = fakes.channel.sent.length;

      fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-rejection-no-id", transcript: "返事を続けて" });
      fakes.channel.message({ type: "error", error: { code: "conversation_already_has_active_response" } });
      fakes.channel.message({ type: "response.done", response: {} });
      fakes.channel.message({ type: "output_audio_buffer.cleared" });

      expect(audio.muted).toBe(true);
      expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(actions).not.toContainEqual({ type: "stopped" });
      await vi.advanceTimersByTimeAsync(1);
      expect(actions).toContainEqual({ type: "stopped" });
      expect(audio.muted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a tracked matching drain observed before cancellation", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-drained-before-cancel" } });
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "opening-drained-before-cancel" });
    const before = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-after-prior-drain", transcript: "先に話すね" });
    fakes.channel.message({ type: "response.done", response: { id: "opening-drained-before-cancel" } });

    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([{ type: "response.create" }]);
  });

  it("binds remember tool, audio, and completion only to the forced response ID", async () => {
    const fakes = browser();
    const audio = { autoplay: false, muted: false, srcObject: null as MediaStream | null };
    const playPendingAcknowledgement = vi.fn(async () => undefined);
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
      playPendingAcknowledgement,
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-bind" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-bind" } });
    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-normal-bind", transcript: "今日は晴れだね" });
    fakes.channel.message({ type: "response.created", response: { id: "normal-bind" } });
    const beforeRemember = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "user-remember-bind", transcript: "この話を覚えておいて" });
    expect(fakes.channel.sent.slice(beforeRemember).map((event) => JSON.parse(event))).toEqual([
      { type: "response.cancel", response_id: "normal-bind" },
      { type: "output_audio_buffer.clear" },
    ]);
    fakes.channel.message({ type: "response.function_call_arguments.done", response_id: "normal-bind", name: "remember_pending", call_id: "wrong-response-call", arguments: "{}" });
    fakes.channel.message({ type: "response.done", response: { id: "stale-normal-bind" } });
    expect(fakes.channel.sent.map((event) => JSON.parse(event)).filter((event) => event.item?.type === "function_call_output")).toEqual([]);
    expect(fakes.channel.sent.slice(beforeRemember).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([]);

    fakes.channel.message({ type: "response.done", response: { id: "normal-bind" } });
    expect(fakes.channel.sent.slice(beforeRemember).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([]);
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "normal-bind" });
    expect(fakes.channel.sent.slice(beforeRemember).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([{
      type: "response.create",
      response: { tool_choice: { type: "function", name: "remember_pending" } },
    }]);
    fakes.channel.message({ type: "response.created", response: { id: "forced-bind" } });
    fakes.channel.message({ type: "output_audio_buffer.started", response_id: "normal-bind" });
    fakes.channel.message({ type: "response.function_call_arguments.done", response_id: "normal-bind", name: "remember_pending", call_id: "stale-call", arguments: "{}" });
    expect(fakes.channel.sent.map((event) => JSON.parse(event)).filter((event) => event.item?.type === "function_call_output")).toEqual([]);
    fakes.channel.message({ type: "response.function_call_arguments.done", response_id: "forced-bind", name: "remember_pending", call_id: "forced-call", arguments: "{}" });
    fakes.channel.message({ type: "response.done", response: { id: "normal-bind" } });
    expect(audio.muted).toBe(true);
    fakes.channel.message({ type: "response.done", response: { id: "forced-bind" } });
    await vi.waitFor(() => expect(playPendingAcknowledgement).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(audio.muted).toBe(false));
  });

  it("keeps forbidden forced audio muted until its matching buffer clear arrives after response completion", async () => {
    const fakes = browser();
    const actions: SessionAction[] = [];
    const audio = { autoplay: false, muted: false, srcObject: null as MediaStream | null };
    const playPendingAcknowledgement = vi.fn(async () => undefined);
    const client = createRealtimeClient({
      dispatch: (action) => actions.push(action),
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
      playPendingAcknowledgement,
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-drain" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-drain" } });
    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "remember-drain", transcript: "この話を覚えておいて" });
    fakes.channel.message({ type: "response.created", response: { id: "forced-drain" } });
    fakes.channel.message({
      type: "response.function_call_arguments.done",
      response_id: "forced-drain",
      name: "remember_pending",
      call_id: "remember-drain-call",
      arguments: "{}",
    });
    const beforeForbiddenAudio = fakes.channel.sent.length;

    fakes.channel.message({ type: "output_audio_buffer.started", response_id: "forced-drain" });
    fakes.channel.message({ type: "response.output_audio_transcript.done", response_id: "forced-drain", transcript: "保存したよ" });
    expect(fakes.channel.sent.slice(beforeForbiddenAudio).map((event) => JSON.parse(event))).toEqual([
      { type: "response.cancel", response_id: "forced-drain" },
      { type: "output_audio_buffer.clear" },
    ]);
    fakes.channel.message({ type: "response.done", response: { id: "forced-drain" } });
    await vi.waitFor(() => expect(playPendingAcknowledgement).toHaveBeenCalledOnce());
    expect(audio.muted).toBe(true);
    expect(actions).not.toContainEqual({ type: "transcript", turn: { role: "assistant", text: "保存したよ" } });

    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "stale-forced-drain" });
    expect(audio.muted).toBe(true);
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "forced-drain" });
    await vi.waitFor(() => expect(audio.muted).toBe(false));
  });

  it("gates a remember response, discards a tool-less claim, and plays only a fixed pending acknowledgement after the tool", async () => {
    const fakes = browser();
    const actions: SessionAction[] = [];
    const audio = { autoplay: false, muted: false, srcObject: null as MediaStream | null };
    const playPendingAcknowledgement = vi.fn(async () => undefined);
    const client = createRealtimeClient({
      dispatch: (action) => actions.push(action),
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
      playPendingAcknowledgement,
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-gated" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-gated" } });
    const before = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "この傘のことを保存しておいて" });
    expect(audio.muted).toBe(true);
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event))).toContainEqual({
      type: "response.create",
      response: { tool_choice: { type: "function", name: "remember_pending" } },
    });

    fakes.channel.message({ type: "response.created", response: { id: "forced-gated-1" } });
    fakes.channel.message({ type: "output_audio_buffer.started", response_id: "forced-gated-1" });
    fakes.channel.message({ type: "response.output_audio_transcript.done", response_id: "forced-gated-1", transcript: "覚えたよ" });
    fakes.channel.message({ type: "response.done", response: { id: "forced-gated-1" } });
    expect(audio.muted).toBe(true);
    expect(actions).not.toContainEqual({ type: "transcript", turn: { role: "assistant", text: "覚えたよ" } });
    expect(fakes.channel.sent.map((event) => JSON.parse(event))).toContainEqual({ type: "response.cancel", response_id: "forced-gated-1" });
    expect(fakes.channel.sent.map((event) => JSON.parse(event))).toContainEqual({ type: "output_audio_buffer.clear" });
    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toHaveLength(1);

    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "forced-gated-1" });
    fakes.channel.message({ type: "response.created", response: { id: "forced-gated-2" } });
    fakes.channel.message({
      type: "response.function_call_arguments.done",
      response_id: "forced-gated-2",
      name: "remember_pending",
      call_id: "remember-gated-1",
      arguments: "{}",
    });
    fakes.channel.message({ type: "response.done", response: { id: "forced-gated-2" } });
    await vi.waitFor(() => expect(playPendingAcknowledgement).toHaveBeenCalledWith("終話後に保存を確認するね。", expect.any(AbortSignal)));
    await vi.waitFor(() => expect(audio.muted).toBe(false));

    const afterTool = fakes.channel.sent.map((event) => JSON.parse(event));
    expect(afterTool).toContainEqual({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "remember-gated-1", output: '{"state":"pending"}' },
    });
    expect(afterTool.filter((event) => event.type === "response.create").at(-1)).toEqual({
      type: "response.create",
      response: { tool_choice: { type: "function", name: "remember_pending" } },
    });
    expect(actions).toContainEqual({ type: "transcript", turn: { role: "assistant", text: "終話後に保存を確認するね。" } });
    await client.stop();
    expect(client.consumeMemoryBatch?.()).toMatchObject({ explicitMemoryTargetTurnIndexes: expect.any(Array) });
  });

  it("keeps one remember gate when a second completed transcript races the pending tool", async () => {
    const fakes = browser();
    const audio = { autoplay: false, muted: false, srcObject: null as MediaStream | null };
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
      playPendingAcknowledgement: async () => undefined,
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-double" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-double" } });
    const before = fakes.channel.sent.length;

    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "これを覚えて" });
    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "忘れないでね" });

    expect(fakes.channel.sent.slice(before).map((event) => JSON.parse(event)).filter((event) => event.type === "response.create")).toEqual([{
      type: "response.create",
      response: { tool_choice: { type: "function", name: "remember_pending" } },
    }]);
    expect(audio.muted).toBe(true);
  });

  it("ends a realtime call after the hard 30 minute browser ceiling", async () => {
    vi.useFakeTimers();
    try {
      const fakes = browser();
      const actions: SessionAction[] = [];
      const client = createRealtimeClient({
        dispatch: (action) => actions.push(action),
        fetch: fakes.fetch,
        getUserMedia: fakes.getUserMedia,
        createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
        createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
        createSessionId: () => "call-limit",
      });

      await client.start();
      fakes.channel.open();
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);

      expect(actions).toContainEqual({ type: "stopped" });
      expect(fakes.peer.close).toHaveBeenCalledTimes(1);
      expect(fakes.fetch).toHaveBeenLastCalledWith("/api/usage", expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps only bounded current-call text in memory and consumes it once after stop", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
      createSessionId: () => "private-session-value",
      now: () => new Date("2026-08-08T12:00:00.000Z"),
    });

    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-bounded" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-bounded" } });
    fakes.channel.message({ type: "input_audio_buffer.append", audio: "base64-audio-must-not-be-kept" });
    fakes.channel.message({ type: "response.output_audio.delta", delta: "base64-output-audio" });
    for (let index = 0; index < 14; index += 1) {
      fakes.channel.message({
        type: index % 2 === 0
          ? "conversation.item.input_audio_transcription.completed"
          : "response.output_audio_transcript.done",
        transcript: `${index}:`.padEnd(index === 13 ? 5_000 : 1_010, String(index % 10)),
      });
    }
    fakes.channel.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "これを覚えておいて",
    });
    fakes.channel.message({ type: "response.created", response: { id: "normal-bounded" } });
    fakes.channel.message({ type: "response.done", response: { id: "normal-bounded" } });
    fakes.channel.message({ type: "output_audio_buffer.cleared", response_id: "normal-bounded" });
    fakes.channel.message({ type: "response.created", response: { id: "forced-bounded" } });
    fakes.channel.message({
      type: "response.function_call_arguments.done",
      response_id: "forced-bounded",
      name: "remember_pending",
      call_id: "remember-call-1",
      arguments: "{}",
    });
    await client.stop();

    const batch = client.consumeMemoryBatch?.();
    expect(batch).not.toBeNull();
    expect(batch?.turns.length).toBeLessThanOrEqual(12);
    expect(batch?.turns.reduce((total, turn) => total + turn.text.length, 0)).toBeLessThanOrEqual(12_000);
    expect(batch?.turns.every((turn) => turn.text.length <= 4_000)).toBe(true);
    expect(batch?.turns.at(-1)).toMatchObject({ role: "user", text: "これを覚えておいて" });
    expect(batch?.explicitMemoryTargetTurnIndexes.length).toBeGreaterThan(0);
    const toolOutput = fakes.channel.sent.map((event) => JSON.parse(event)).find((event) => event.item?.type === "function_call_output");
    expect(toolOutput).toEqual({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "remember-call-1", output: '{"state":"pending"}' },
    });
    expect(toolOutput.item.output).not.toMatch(/completed|saved|覚えた|保存した/u);
    expect(JSON.stringify(batch)).not.toContain("base64-audio");
    expect(JSON.stringify(batch)).not.toContain("base64-output-audio");
    expect(client.consumeMemoryBatch?.()).toBeNull();
    expect(JSON.stringify(fakes.fetch.mock.calls)).not.toContain("これを覚えておいて");
  });

  it("does not treat spoken remember wording as durable intent without the pending tool", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "これを覚えておいて" });
    await client.stop();

    expect(client.consumeMemoryBatch?.()).toMatchObject({ explicitMemoryTargetTurnIndexes: [] });
    expect(fakes.channel.sent.map((event) => JSON.parse(event)).filter((event) => event.item?.type === "function_call_output")).toEqual([]);
  });

  it("keeps both factual targets from two accepted remember gates in one mixed call", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-two-gates" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-two-gates" } });

    for (const [index, transcript] of ["猫が好きだから覚えて", "犬も好きだから覚えて"].entries()) {
      const responseId = `remember-two-${index}`;
      fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: `remember-user-${index}`, transcript });
      fakes.channel.message({ type: "response.created", response: { id: responseId } });
      fakes.channel.message({
        type: "response.function_call_arguments.done",
        response_id: responseId,
        name: "remember_pending",
        call_id: `remember-call-${index}`,
        arguments: "{}",
      });
      fakes.channel.message({ type: "response.done", response: { id: responseId } });
      fakes.channel.message({ type: "output_audio_buffer.stopped", response_id: responseId });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await client.stop();

    const batch = client.consumeMemoryBatch?.();
    expect(batch?.explicitMemoryTargetTurnIndexes.map((index) => batch.turns[index]?.text)).toEqual([
      "猫が好きだから覚えて",
      "犬も好きだから覚えて",
    ]);
  });

  it("does not let a no-argument tool call turn quoted remember wording into semantic proof", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, muted: false, srcObject: null } as unknown as HTMLAudioElement),
    });
    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "response.created", response: { id: "opening-negative-intent" } });
    fakes.channel.message({ type: "response.done", response: { id: "opening-negative-intent" } });
    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "negative-intent", transcript: "「覚えて」と言った" });
    fakes.channel.message({ type: "response.created", response: { id: "normal-negative-intent" } });
    fakes.channel.message({
      type: "response.function_call_arguments.done",
      response_id: "normal-negative-intent",
      name: "remember_pending",
      call_id: "unproved-remember",
      arguments: "{}",
    });
    await client.stop();

    expect(fakes.channel.sent.map((event) => JSON.parse(event)).filter((event) => event.item?.type === "function_call_output")).toEqual([]);
    expect(client.consumeMemoryBatch?.()).toMatchObject({ explicitMemoryTargetTurnIndexes: [] });
  });

  it("discards active and sealed call text when memory collection is cancelled", async () => {
    const fakes = browser();
    const client = createRealtimeClient({
      dispatch: () => undefined,
      fetch: fakes.fetch,
      getUserMedia: fakes.getUserMedia,
      createPeerConnection: () => fakes.peer as unknown as RTCPeerConnection,
      createAudioElement: () => ({ autoplay: false, srcObject: null } as unknown as HTMLAudioElement),
    });

    await client.start();
    fakes.channel.open();
    fakes.channel.message({ type: "conversation.item.input_audio_transcription.completed", transcript: "保存しない秘密の発言" });
    client.cancelMemory?.();
    await client.stop();

    expect(client.consumeMemoryBatch?.()).toBeNull();
  });

  it("derives an opaque stable source ID without exposing the realtime session ID", async () => {
    const first = await createVoiceMemorySourceId("private-session-value");
    const second = await createVoiceMemorySourceId("private-session-value");

    expect(first).toBe(second);
    expect(first).toMatch(/^voice:[a-f0-9]{64}$/);
    expect(first).not.toContain("private-session-value");
  });
});

describe("realtimeEventToSessionAction", () => {
  it("maps user and assistant audio transcripts without accepting blank text", () => {
    expect(realtimeEventToSessionAction({ type: "conversation.item.input_audio_transcription.completed", transcript: "  こんにちは " })).toEqual({ type: "transcript", turn: { role: "user", text: "こんにちは" } });
    expect(realtimeEventToSessionAction({ type: "response.output_audio_transcript.done", transcript: "" })).toBeNull();
  });
});

describe("isExplicitRememberIntent", () => {
  it.each([
    "これを覚えて",
    "この話を覚えておいて",
    "この内容を保存してください",
    "大事だからメモしておいてね",
    "このことを忘れないで",
  ])("accepts an actual imperative: %s", (transcript) => {
    expect(isExplicitRememberIntent(transcript)).toBe(true);
  });

  it.each([
    "覚えてない",
    "保存してない",
    "覚えてほしいことはない",
    "保存してほしいことはない",
    "「覚えて」と言った",
    "覚えてという言葉について話そう",
    "覚えてる？",
    "保存してくれた？",
    "これを覚えてもらえる？",
  ])("rejects a negation, quotation, meta mention, or question: %s", (transcript) => {
    expect(isExplicitRememberIntent(transcript)).toBe(false);
  });
});

describe("refersOnlyToPriorTurn", () => {
  it.each(["これを覚えて", "この話を覚えておいて", "さっきの内容を保存してね"])('%s targets the immediately prior user turn', (transcript) => {
    expect(refersOnlyToPriorTurn(transcript)).toBe(true);
  });

  it.each(["猫が好きだから覚えて", "水曜は図書館に行く。これを覚えて", "大事だからメモしておいてね"])('%s keeps the factual current turn as the only target', (transcript) => {
    expect(refersOnlyToPriorTurn(transcript)).toBe(false);
  });
});

describe("mergeExplicitMemoryTargetTurns", () => {
  it("accumulates two remember gates without overwriting the first target", () => {
    const first = { role: "user" as const, text: "猫が好き", occurredAt: "2026-08-12T00:00:00.000Z" };
    const second = { role: "user" as const, text: "犬も好き", occurredAt: "2026-08-12T00:00:01.000Z" };
    expect(mergeExplicitMemoryTargetTurns([first], [second])).toEqual({ targets: [first, second], accepted: true });
  });

  it("deduplicates repeated gates and preserves accepted targets when the strict cap is exceeded", () => {
    const first = { role: "user" as const, text: "猫が好き", occurredAt: "2026-08-12T00:00:00.000Z" };
    const second = { role: "user" as const, text: "犬も好き", occurredAt: "2026-08-12T00:00:01.000Z" };
    const third = { role: "user" as const, text: "鳥も好き", occurredAt: "2026-08-12T00:00:02.000Z" };
    expect(mergeExplicitMemoryTargetTurns([first], [first])).toEqual({ targets: [first], accepted: true });
    expect(mergeExplicitMemoryTargetTurns([first, second], [third])).toEqual({ targets: [first, second], accepted: false });
  });
});

it('plays text responses with Zundamon, stops on speech, and never waits for remote audio drain',async()=>{
 const f=browser();const spoken:string[]=[];const actions:SessionAction[]=[];
 const fetch=vi.fn(async(input:RequestInfo|URL)=>new Response(input==='/api/realtime/calls'?'answer':null,{status:input==='/api/realtime/calls'?201:204,headers:{'X-Yui-Voice-Provider':'zundamon'}}));
 const client=createRealtimeClient({dispatch:a=>actions.push(a),fetch,getUserMedia:f.getUserMedia,createPeerConnection:()=>f.peer as unknown as RTCPeerConnection,createAudioElement:()=>({} as HTMLAudioElement),createSpeechPlayer:()=>({play:async(text:string)=>{spoken.push(text);},close:()=>{}})});
 await client.start();f.channel.open();f.channel.message({type:'response.created',response:{id:'r1'}});
 f.channel.message({type:'response.output_text.delta',response_id:'r1',delta:'こんにちは。'});
 f.channel.message({type:'response.output_text.done',response_id:'r1',text:'こんにちは。'});
 f.channel.message({type:'response.done',response:{id:'r1',status:'completed'}});
 await new Promise(r=>setTimeout(r,0));expect(spoken).toEqual(['こんにちは。']);
 expect(actions).toContainEqual(expect.objectContaining({type:'transcript',turn:{role:'assistant',text:'こんにちは。'}}));
 f.channel.message({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'話そう'});
 f.channel.message({type:'response.created',response:{id:'r2'}});
 f.channel.message({type:'input_audio_buffer.speech_started'});
 f.channel.message({type:'response.done',response:{id:'r2',status:'cancelled'}});
 f.channel.message({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'別の話'});
 expect(f.channel.sent.filter(x=>JSON.parse(x).type==='response.create')).toHaveLength(3);
 await client.stop();
});

it("keeps mute enabled across interruption and excludes interrupted speech from history", async () => {
 const f = browser(); const actions: SessionAction[] = []; let finish!: () => void;
 const fetch = vi.fn(async(input:RequestInfo|URL)=>new Response(input==='/api/realtime/calls'?'answer':null,{status:input==='/api/realtime/calls'?201:204,headers:{'X-Yui-Voice-Provider':'zundamon'}}));
 const client = createRealtimeClient({ dispatch:a=>actions.push(a), fetch, getUserMedia:f.getUserMedia,
   createPeerConnection:()=>f.peer as unknown as RTCPeerConnection, createAudioElement:()=>({} as HTMLAudioElement),
   createSpeechPlayer:()=>({play:async()=>new Promise<void>(resolve=>{finish=resolve;}),close:()=>{}}) });
 await client.start(); f.channel.open(); client.setMuted?.(true);
 f.channel.message({type:'response.created',response:{id:'interrupt-test'}});
 f.channel.message({type:'response.output_text.delta',response_id:'interrupt-test',delta:'再生の途中なのだ。'});
 await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 client.interrupt?.(); finish();
 f.channel.message({type:'response.done',response:{id:'interrupt-test',status:'cancelled'}});
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(actions.filter(a=>a.type==='transcript')).toHaveLength(0);
 expect(actions).toContainEqual({type:'microphone',enabled:false});
 expect(f.tracks[0].enabled).toBe(false);
 await client.stop();
});
