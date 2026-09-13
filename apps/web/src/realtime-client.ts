import {SpeechLimitError, createBrowserSpeechPlayer, createSpeechQueue, type SpeechPlayer, type SpeechPreparer} from "./sakura-speech";
import type { SessionAction } from "./session-reducer";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type Logger = {
  warn(message: string, detail?: unknown): void;
};

export type RealtimeClientOptions = {
  dispatch: (action: SessionAction) => void;
  createSpeechPlayer?: () => {play:SpeechPlayer;prepare?:SpeechPreparer;close():void};
  fetch?: FetchLike;
  getTimeZone?: () => string | undefined;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection?: () => RTCPeerConnection;
  createSessionId?: () => string;
  createAudioElement?: () => HTMLAudioElement;
  playPendingAcknowledgement?: (text: string, signal: AbortSignal) => void | Promise<void>;
  logger?: Logger;
  now?: () => Date;
};

export type RealtimeClient = {
  start(): Promise<void>;
  setMuted?(muted: boolean): void;
  interrupt?(): void;
  stop(): void | Promise<void>;
  usageContext?(): UsageSessionContext | null;
  consumeMemoryBatch?(): EphemeralCallMemoryBatch | null;
  cancelMemory?(): void;
};

export type UsageSessionContext = {
  sessionId: string;
  startedAt: string;
  endedAt: string;
};

export type EphemeralCallTurn = {
  role: "user" | "assistant";
  text: string;
  occurredAt: string;
};

export type EphemeralCallMemoryBatch = {
  sessionId: string;
  sourceOccurredAt: string;
  turns: EphemeralCallTurn[];
  explicitMemoryTargetTurnIndexes: number[];
};

type RealtimeEvent = Record<string, unknown> & { type: string };
const REALTIME_MAX_DURATION_MS = 30 * 60 * 1_000;
const MICROPHONE_REOPEN_DELAY_MS = 500;
const UNKNOWN_CANCEL_SETTLEMENT_TIMEOUT_MS = 5_000;
const MAX_MEMORY_TURNS = 12;
const MAX_MEMORY_TURN_TEXT = 4_000;
const MAX_MEMORY_TOTAL_TEXT = 12_000;
const MAX_EXPLICIT_MEMORY_TARGETS = 2;
const PENDING_ACKNOWLEDGEMENT = "終話後に保存を確認するね。";
const FAILED_PENDING_ACKNOWLEDGEMENT = "今は保存待ちにできなかったよ。";

export function isExplicitRememberIntent(transcript: string): boolean {
  const normalized = transcript.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 120) return false;
  if (/[?？「」『』〝〟«»‹›"“”‘’]/u.test(normalized)) return false;
  if (/(?:と言(?:う|った|って)|って言(?:う|った|って)|という(?:言葉|表現)|について|意味)/u.test(normalized)) return false;
  if (/(?:覚えて|記憶して|保存して|メモして|残して)(?:い)?ない|(?:覚えて|記憶して|保存して|メモして|残して)ほしいことはない/u.test(normalized)) return false;
  if (/(?:覚えて|記憶して|保存して|メモして|残して)(?:る|いる|くれた|もらえる|できます|できる)(?:の|か|かな|っけ)?[。!！]*$/u.test(normalized)) return false;
  return /(?:覚えて(?:おいて)?|記憶して(?:おいて)?|保存して(?:おいて)?|メモして(?:おいて)?|忘れないで|残して(?:おいて)?)(?:ください|ね)?[。!！]*$/u.test(normalized);
}

export function refersOnlyToPriorTurn(transcript: string): boolean {
  const normalized = transcript.normalize("NFKC").replace(/\s+/gu, "").replace(/[。!！]+$/gu, "");
  return /^(?:(?:これ|それ|この(?:話|こと|内容)|さっきの(?:話|こと|内容))を)?(?:覚えて(?:おいて)?|記憶して(?:おいて)?|保存して(?:おいて)?|メモして(?:おいて)?|忘れないで|残して(?:おいて)?)(?:ください|ね)?$/u.test(normalized);
}

export function mergeExplicitMemoryTargetTurns<T>(
  accepted: readonly T[],
  proposed: readonly T[],
): { targets: T[]; accepted: boolean } {
  const targets = [...accepted];
  for (const target of proposed) {
    if (targets.includes(target)) continue;
    if (targets.length >= MAX_EXPLICIT_MEMORY_TARGETS) return { targets, accepted: false };
    targets.push(target);
  }
  return { targets, accepted: true };
}

function playBrowserAcknowledgement(text: string, signal: AbortSignal): Promise<void> {
  if (typeof globalThis.SpeechSynthesisUtterance === "undefined" || typeof globalThis.speechSynthesis === "undefined") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      globalThis.speechSynthesis.cancel();
      finish();
    };
    utterance.addEventListener("end", finish, { once: true });
    utterance.addEventListener("error", finish, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else globalThis.speechSynthesis.speak(utterance);
  });
}

export async function createVoiceMemorySourceId(sessionId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`yui-voice-memory\0${sessionId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `voice:${hex}`;
}

export function realtimeEventToSessionAction(
  event: unknown,
): SessionAction | null {
  if (!isRealtimeEvent(event)) {
    return null;
  }

  switch (event.type) {
    case "conversation.item.input_audio_transcription.completed":
      return transcriptAction("user", event.transcript);
    case "response.output_audio_transcript.done":
      return transcriptAction("assistant", event.transcript);
    case "output_audio_buffer.started":
      return { type: "speaking" };
    case "output_audio_buffer.stopped":
      return { type: "listening" };
    default:
      return null;
  }
}

export function createRealtimeClient(
  options: RealtimeClientOptions,
): RealtimeClient {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const getUserMedia =
    options.getUserMedia ??
    ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
  const peer =
    options.createPeerConnection?.() ?? new RTCPeerConnection();
  const logger = options.logger ?? console;
  const createSessionId =
    options.createSessionId ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const getTimeZone =
    options.getTimeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const audio = options.createAudioElement?.() ?? document.createElement("audio");
  const playPendingAcknowledgement = options.playPendingAcknowledgement ?? playBrowserAcknowledgement;
  const remoteTracks = new Set<MediaStreamTrack>();
  audio.autoplay = true;

  let zundamon = false;
  let userMuted = false;
  let transcriptSequence = 0;
  let speechPlayer: {play:SpeechPlayer;prepare?:SpeechPreparer;close():void}|null = null;
  let speechQueue: ReturnType<typeof createSpeechQueue>|null = null;
  let dataChannel: RTCDataChannel | null = null;
  let localStream: MediaStream | null = null;
  let openingSent = false;
  let released = false;
  let started = false;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let sessionId: string | null = null;
  let stoppedDispatched = false;
  let usageReport: Promise<void> | null = null;
  let realtimeReady = false;
  let memoryCancelled = false;
  let memorySealed = false;
  let explicitMemoryTargetTurns: EphemeralCallTurn[] = [];
  let memoryTurns: EphemeralCallTurn[] = [];
  let sealedMemoryBatch: EphemeralCallMemoryBatch | null = null;
  const handledRememberCalls = new Set<string>();
  const handledUserTranscriptItems = new Set<string>();
  const handledUsageEventIds = new Set<string>();
  type RequestedResponseKind = "opening" | "normal" | "remember";
  type ActiveResponseKind = RequestedResponseKind | "unmanaged";
  let pendingResponse: { kind: RequestedResponseKind } | null = null;
  let activeResponse: {
    id: string;
    kind: ActiveResponseKind;
    cancelRequested: boolean;
    done: boolean;
    audioDrainRequired: boolean;
    audioDrained: boolean;
  } | null = null;
  let queuedResponse: RequestedResponseKind | null = null;
  let rejectedUnknownCancellation: {
    responseId: string | null;
    done: boolean;
    audioDrained: boolean;
  } | null = null;
  let rememberGate: {
    toolAccepted: boolean;
    responseDone: boolean;
    acknowledgementDone: boolean;
    retryCount: number;
    responseId: string | null;
    audioDrained: boolean;
  } | null = null;
  let acknowledgementController: AbortController | null = null;
  let rejectedCancellationTimer: ReturnType<typeof setTimeout> | null = null;
  let maximumDurationTimer: ReturnType<typeof setTimeout> | null = null;
  let microphoneReopenTimer: ReturnType<typeof setTimeout> | null = null;
  const usage = emptyUsage();

  const tryRelease = (message: string, release: () => void): void => {
    try {
      release();
    } catch {
      logger.warn(message);
    }
  };

  const releaseResources = (): void => {
    if (released) {
      return;
    }
    released = true;
    speechQueue?.cancel();
    speechPlayer?.close();
    if (maximumDurationTimer) {
      clearTimeout(maximumDurationTimer);
      maximumDurationTimer = null;
    }
    if (microphoneReopenTimer) {
      clearTimeout(microphoneReopenTimer);
      microphoneReopenTimer = null;
    }
    if (rejectedCancellationTimer) {
      clearTimeout(rejectedCancellationTimer);
      rejectedCancellationTimer = null;
    }
    acknowledgementController?.abort();
    acknowledgementController = null;
    rememberGate = null;
    audio.muted = true;
    for (const track of localStream?.getTracks() ?? []) {
      tryRelease("Failed to release Realtime track", () => track.stop());
    }
    for (const track of remoteTracks) {
      tryRelease("Failed to release Realtime track", () => track.stop());
    }
    audio.srcObject = null;
    if (dataChannel) {
      tryRelease("Failed to close Realtime data channel", () =>
        dataChannel?.close(),
      );
    }
    tryRelease("Failed to close Realtime peer connection", () => peer.close());
  };

  const dispatchStopped = (): void => {
    if (stoppedDispatched) {
      return;
    }
    stoppedDispatched = true;
    options.dispatch({ type: "stopped" });
  };

  const appendMemoryTurn = (role: "user" | "assistant", text: string): void => {
    if (memoryCancelled || released) return;
    const boundedText = text.trim().slice(0, MAX_MEMORY_TURN_TEXT);
    if (!boundedText) return;
    memoryTurns.push({ role, text: boundedText, occurredAt: now().toISOString() });
    if (memoryTurns.length > MAX_MEMORY_TURNS) {
      memoryTurns.splice(0, memoryTurns.length - MAX_MEMORY_TURNS);
    }
    let total = memoryTurns.reduce((sum, turn) => sum + turn.text.length, 0);
    while (memoryTurns.length > 1 && total > MAX_MEMORY_TOTAL_TEXT) {
      total -= memoryTurns.shift()!.text.length;
    }
    if (total > MAX_MEMORY_TOTAL_TEXT && memoryTurns[0]) {
      memoryTurns[0] = {
        ...memoryTurns[0],
        text: memoryTurns[0].text.slice(-MAX_MEMORY_TOTAL_TEXT),
      };
    }
  };

  const sealMemoryBatch = (): void => {
    if (memorySealed) return;
    memorySealed = true;
    if (!memoryCancelled && sessionId && startedAt && memoryTurns.some((turn) => turn.role === "user")) {
      sealedMemoryBatch = {
        sessionId,
        sourceOccurredAt: memoryTurns.find((turn) => turn.role === "user")?.occurredAt ?? startedAt,
        turns: memoryTurns.map((turn) => ({ ...turn })),
        explicitMemoryTargetTurnIndexes: explicitMemoryTargetTurns
          .map((target) => memoryTurns.indexOf(target))
          .filter((index) => index >= 0),
      };
    }
    memoryTurns = [];
  };

  const setMicrophoneEnabled = (enabled: boolean): void => {
    for (const track of localStream?.getAudioTracks() ?? []) {
      track.enabled = enabled && !userMuted;
    }
  };

  const muteMicrophoneForPlayback = (): void => {
    if (microphoneReopenTimer) {
      clearTimeout(microphoneReopenTimer);
      microphoneReopenTimer = null;
    }
    setMicrophoneEnabled(false);
  };

  const reopenMicrophoneAfterPlayback = (): void => {
    if (microphoneReopenTimer) {
      clearTimeout(microphoneReopenTimer);
    }
    microphoneReopenTimer = setTimeout(() => {
      microphoneReopenTimer = null;
      if (!released) setMicrophoneEnabled(true);
    }, MICROPHONE_REOPEN_DELAY_MS);
  };

  const responseKindPriority = (kind: RequestedResponseKind): number =>
    kind === "remember" ? 2 : kind === "normal" ? 1 : 0;

  const sendResponseRequest = (kind: RequestedResponseKind): void => {
    if (!dataChannel || pendingResponse || activeResponse || rejectedUnknownCancellation) return;
    pendingResponse = { kind };
    dataChannel.send(JSON.stringify(kind === "remember"
      ? { type: "response.create", response: { tool_choice: { type: "function", name: "remember_pending" } } }
      : { type: "response.create" }));
  };

  const cancelActiveResponse = (): void => {
    if (!activeResponse || activeResponse.cancelRequested) return;
    activeResponse.cancelRequested = true;
    activeResponse.audioDrainRequired = !zundamon;
    if(zundamon){speechQueue?.cancel();activeResponse.audioDrained=true;}
    if(!activeResponse.done)dataChannel?.send(JSON.stringify({ type: "response.cancel", response_id: activeResponse.id }));
    if(!zundamon)dataChannel?.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    if(zundamon)settleActiveResponse();
  };

  const flushQueuedResponse = (): void => {
    if (!queuedResponse || pendingResponse || activeResponse || rejectedUnknownCancellation) return;
    const next = queuedResponse;
    queuedResponse = null;
    sendResponseRequest(next);
  };

  const enqueueResponse = (kind: RequestedResponseKind): void => {
    if (!pendingResponse && !activeResponse && !rejectedUnknownCancellation) {
      sendResponseRequest(kind);
      return;
    }
    if (!queuedResponse || responseKindPriority(kind) >= responseKindPriority(queuedResponse)) {
      queuedResponse = kind;
    }
    cancelActiveResponse();
  };

  const recordRejectedCancellationEvent = (
    responseId: string | null,
    event: "done" | "audioDrained",
  ): void => {
    if (!rejectedUnknownCancellation || responseId === null) return;
    if (rejectedUnknownCancellation.responseId === null) {
      rejectedUnknownCancellation.responseId = responseId;
    } else if (rejectedUnknownCancellation.responseId !== responseId) {
      return;
    }
    rejectedUnknownCancellation[event] = true;
    if (!rejectedUnknownCancellation.done || !rejectedUnknownCancellation.audioDrained) return;
    rejectedUnknownCancellation = null;
    if (rejectedCancellationTimer) {
      clearTimeout(rejectedCancellationTimer);
      rejectedCancellationTimer = null;
    }
    if (!rememberGate) audio.muted = false;
    flushQueuedResponse();
  };

  const finishRememberGate = (): void => {
    if (!rememberGate?.responseDone || !rememberGate.acknowledgementDone || !rememberGate.audioDrained) return;
    rememberGate = null;
    acknowledgementController = null;
    audio.muted = false;
    reopenMicrophoneAfterPlayback();
  };

  const playFixedAcknowledgement = (text: string): void => {
    if (!rememberGate) return;
    options.dispatch({ type: "transcript", turn: { role: "assistant", text } });
    options.dispatch({ type: "speaking" });
    acknowledgementController?.abort();
    const controller = new AbortController();
    acknowledgementController = controller;
    void Promise.resolve(zundamon && speechPlayer ? speechPlayer.play(text, controller.signal) : playPendingAcknowledgement(text, controller.signal))
      .catch(() => undefined)
      .finally(() => {
        if (released || acknowledgementController !== controller || !rememberGate) return;
        rememberGate.acknowledgementDone = true;
        options.dispatch({ type: "listening" });
        finishRememberGate();
      });
  };

  const beginRememberGate = (): void => {
    audio.muted = true;
    muteMicrophoneForPlayback();
    rememberGate = {
      toolAccepted: false,
      responseDone: false,
      acknowledgementDone: false,
      retryCount: 0,
      responseId: null,
      audioDrained: false,
    };
    enqueueResponse("remember");
  };

  const settleActiveResponse = (): void => {
    if (!activeResponse?.done) return;
    if (activeResponse.audioDrainRequired && !activeResponse.audioDrained) return;
    const completed = activeResponse;
    activeResponse = null;
    if (completed.kind === "remember" && rememberGate?.responseId === completed.id) {
      rememberGate.responseId = null;
      rememberGate.audioDrained = true;
      if (rememberGate.toolAccepted) {
        rememberGate.responseDone = true;
        finishRememberGate();
      } else if (rememberGate.retryCount === 0) {
        rememberGate.retryCount = 1;
        enqueueResponse("remember");
      } else {
        rememberGate.responseDone = true;
        playFixedAcknowledgement(FAILED_PENDING_ACKNOWLEDGEMENT);
      }
    } else if (!rememberGate) {
      reopenMicrophoneAfterPlayback();
    }
    flushQueuedResponse();
  };

  const stop = (): Promise<void> => {
    sealMemoryBatch();
    releaseResources();
    dispatchStopped();
    if (usageReport) return usageReport;
    if (!realtimeReady || !sessionId || !startedAt) {
      usageReport = Promise.resolve();
      return usageReport;
    }

    endedAt = now().toISOString();
    usageReport = fetchImpl("/api/usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, startedAt, endedAt, ...usage }),
      keepalive: true,
    })
      .then(async (response) => {
        if (response.ok) return;
        try {
          await response.body?.cancel();
        } catch {
          // The HTTP status remains authoritative.
        }
        throw new Error(`Usage report failed with ${response.status}`);
      })
      .catch(() => {
        logger.warn("Failed to report API usage");
      });
    return usageReport;
  };

  return {
    async start() {
      if (started) {
        throw new Error("Realtime client has already started");
      }
      if (released) {
        throw new Error("Realtime client has stopped");
      }
      started = true;
      sessionId = createSessionId();

      try {
        if(options.createSpeechPlayer) speechPlayer=options.createSpeechPlayer();
        else if(typeof AudioContext!=="undefined") speechPlayer=createBrowserSpeechPlayer(fetchImpl);
        localStream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (released) {
          for (const track of localStream.getTracks()) {
            tryRelease("Failed to release Realtime track", () => track.stop());
          }
          return;
        }
        for (const track of localStream.getTracks()) {
          peer.addTrack(track, localStream);
        }
        peer.ontrack = (event) => {
          for (const track of [
            event.track,
            ...event.streams.flatMap((stream) => stream.getTracks()),
          ]) {
            remoteTracks.add(track);
          }
          if (!released && !zundamon && event.streams[0]) {
            audio.srcObject = event.streams[0];
          }
        };

        dataChannel = peer.createDataChannel("oai-events");
        dataChannel.addEventListener("open", () => {
          if (released || openingSent || !dataChannel) {
            return;
          }
          openingSent = true;
          startedAt = now().toISOString();
          maximumDurationTimer = setTimeout(() => {
            void stop();
          }, REALTIME_MAX_DURATION_MS);
          options.dispatch({ type: "connected" });
          sendOpeningRequest(dataChannel);
          enqueueResponse("opening");
        });
        dataChannel.addEventListener("message", (message) => {
          if (released) {
            return;
          }
          const event = parseRealtimeEvent(message, logger);
          if (event === null) {
            return;
          }
          const usageEventId = validRealtimeId(event.event_id);
          const usageEventType = event.type === "response.done" || event.type === "conversation.item.input_audio_transcription.completed";
          const duplicateUsageEvent = usageEventType && usageEventId !== null && handledUsageEventIds.has(usageEventId);
          if (usageEventType && usageEventId !== null) handledUsageEventIds.add(usageEventId);
          const isUsageEvent = duplicateUsageEvent ? true : addUsageEvent(usage, event);
          if (event.type === "response.created") {
            if (rejectedUnknownCancellation) return;
            const id = realtimeResponseId(event);
            if (!id || activeResponse) return;
            const kind: ActiveResponseKind = pendingResponse?.kind ?? "unmanaged";
            pendingResponse = null;
            activeResponse = {
              id,
              kind,
              cancelRequested: false,
              done: false,
              audioDrainRequired: false,
              audioDrained: false,
            };
            if(zundamon){
              speechQueue?.cancel();
              const response = activeResponse;
              const played = (text: string, signal: AbortSignal) => {
                if(released || signal.aborted || response.cancelRequested) return;
                appendMemoryTurn("assistant",text);
                options.dispatch({type:"transcript",id:`voice:${sessionId}:${id}:${++transcriptSequence}`,occurredAt:now().toISOString(),turn:{role:"assistant",text}});
              };
              speechQueue=createSpeechQueue(async(text,signal)=>{
                if(released || !speechPlayer)return;
                options.dispatch({type:"speaking"}); await speechPlayer.play(text,signal); played(text,signal);
              },speechPlayer?.prepare ? async(text,signal)=>{
                const ready=await speechPlayer!.prepare!(text,signal);
                return async()=>{if(released || signal.aborted)return;options.dispatch({type:"speaking"});await ready();played(text,signal);};
              }:undefined);
            }
            if (kind === "remember" && rememberGate) rememberGate.responseId = id;
            if (queuedResponse) cancelActiveResponse();
            return;
          }
          if (event.type === "error" && record(event.error)?.code === "conversation_already_has_active_response") {
            if (pendingResponse) {
              const rejected = pendingResponse.kind;
              pendingResponse = null;
              if (!queuedResponse || responseKindPriority(rejected) >= responseKindPriority(queuedResponse)) {
                queuedResponse = rejected;
              }
            }
            if (activeResponse) {
              cancelActiveResponse();
            } else if (!rejectedUnknownCancellation) {
              rejectedUnknownCancellation = { responseId: null, done: false, audioDrained: zundamon };
              audio.muted = true;
              rejectedCancellationTimer = setTimeout(() => {
                rejectedCancellationTimer = null;
                if (rejectedUnknownCancellation) void stop();
              }, UNKNOWN_CANCEL_SETTLEMENT_TIMEOUT_MS);
              dataChannel?.send(JSON.stringify({ type: "response.cancel" }));
              if(!zundamon)dataChannel?.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
            }
            return;
          }
          if(zundamon && event.type === "input_audio_buffer.speech_started") {
            speechQueue?.cancel(); cancelActiveResponse();
            options.dispatch({type:"listening"});return;
          }
          if(zundamon && (event.type === "response.output_text.delta" || event.type === "response.output_text.done")) {
            if(!activeResponse || activeResponse.cancelRequested || activeResponse.kind === "unmanaged" || rememberGate || validRealtimeId(event.response_id)!==activeResponse.id)return;
            if(event.type === "response.output_text.delta" && typeof event.delta === "string") {
              activeResponse.audioDrainRequired=true;
              speechQueue?.push(event.delta);
            }
            return;
          }
          const action = realtimeEventToSessionAction(event);
          if (action?.type === "transcript" && action.turn.role === "user") {
            const itemId = validRealtimeId(event.item_id);
            if (itemId) {
              if (handledUserTranscriptItems.has(itemId)) return;
              handledUserTranscriptItems.add(itemId);
            }
            appendMemoryTurn("user", action.turn.text);
            options.dispatch({...action,id:`voice:${sessionId}:${itemId ?? ++transcriptSequence}`,occurredAt:now().toISOString()});
            if (isExplicitRememberIntent(action.turn.text) && !rememberGate) beginRememberGate();
            else if (!rememberGate) enqueueResponse("normal");
            return;
          }
          if (event.type === "response.function_call_arguments.done") {
            const callId = typeof event.call_id === "string" ? event.call_id : "";
            const responseId = validRealtimeId(event.response_id);
            let validArguments = false;
            try {
              const parsed = JSON.parse(typeof event.arguments === "string" ? event.arguments : "") as unknown;
              validArguments = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
            } catch {
              validArguments = false;
            }
            if (rememberGate && activeResponse?.kind === "remember" && responseId === activeResponse.id && responseId === rememberGate.responseId && event.name === "remember_pending" && /^[A-Za-z0-9_-]{1,128}$/u.test(callId) && validArguments && !handledRememberCalls.has(callId)) {
              handledRememberCalls.add(callId);
              rememberGate.toolAccepted = true;
              const latestUserTurns = memoryTurns.filter((turn) => turn.role === "user");
              const latest = latestUserTurns.at(-1);
              const previous = latestUserTurns.at(-2);
              const proposedTarget = latest
                ? (refersOnlyToPriorTurn(latest.text) && previous ? previous : latest)
                : null;
              const mergedTargets = mergeExplicitMemoryTargetTurns(
                explicitMemoryTargetTurns,
                proposedTarget ? [proposedTarget] : [],
              );
              explicitMemoryTargetTurns = mergedTargets.targets;
              dataChannel?.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: JSON.stringify(mergedTargets.accepted ? { state: "pending" } : { state: "rejected", reason: "target_limit" }),
                },
              }));
              playFixedAcknowledgement(mergedTargets.accepted ? PENDING_ACKNOWLEDGEMENT : FAILED_PENDING_ACKNOWLEDGEMENT);
              return;
            }
          }
          if (rememberGate) {
            if (event.type === "output_audio_buffer.started" && validRealtimeId(event.response_id) === rememberGate.responseId) {
              if (activeResponse?.id === rememberGate.responseId) {
                activeResponse.audioDrainRequired = true;
                activeResponse.audioDrained = false;
              }
              cancelActiveResponse();
            }
          }
          if (event.type === "output_audio_buffer.cleared" || event.type === "output_audio_buffer.stopped") {
            const id = validRealtimeId(event.response_id);
            if (activeResponse && id === activeResponse.id) {
              activeResponse.audioDrained = true;
              settleActiveResponse();
            } else if (rejectedUnknownCancellation) {
              recordRejectedCancellationEvent(id, "audioDrained");
            }
            if (rememberGate) return;
            if (event.type === "output_audio_buffer.cleared") return;
          }
          if (event.type === "response.done") {
            const id = realtimeResponseId(event);
            if (activeResponse) {
              if (!id || id !== activeResponse.id) return;
              activeResponse.done = true;
              if(zundamon && ["cancelled","failed","incomplete"].includes(String(record(event.response)?.status))){speechQueue?.cancel();activeResponse.cancelRequested=true;activeResponse.audioDrained=true;}
              if(zundamon && activeResponse.kind !== "remember" && !activeResponse.cancelRequested && speechQueue) {
                const current=activeResponse;
                void speechQueue.finish().then(()=>{
                  if(released || activeResponse!==current || current.cancelRequested)return;
                  current.audioDrained=true;options.dispatch({type:"listening"});settleActiveResponse();
                }).catch((error)=>{
                  if(released || activeResponse!==current || current.cancelRequested)return;
                  void stop();options.dispatch({type:"failed",error:error instanceof SpeechLimitError ? error : new Error("ずんだもんの音声を再生できませんでした。時間をおいて通話し直してください。")});
                });
                return;
              }
              settleActiveResponse();
              return;
            }
            if (rejectedUnknownCancellation) {
              recordRejectedCancellationEvent(id, "done");
            } else if (!id && !rememberGate) {
              reopenMicrophoneAfterPlayback();
            }
            return;
          }
          if (rememberGate) return;
          if (event.type === "output_audio_buffer.started") {
            const id = validRealtimeId(event.response_id);
            if (activeResponse && id === activeResponse.id) {
              activeResponse.audioDrainRequired = true;
              activeResponse.audioDrained = false;
            }
            muteMicrophoneForPlayback();
          } else if (event.type === "output_audio_buffer.stopped") {
            reopenMicrophoneAfterPlayback();
          }
          if (action) {
            if (action.type === "transcript") {
              appendMemoryTurn(action.turn.role, action.turn.text);
            }
            options.dispatch(action);
            return;
          }
          if (isUsageEvent) {
            return;
          }
          logger.warn("Ignored unknown Realtime event", event.type);
        });

        const offer = await peer.createOffer();
        if (released) {
          return;
        }
        await peer.setLocalDescription(offer);
        if (released) {
          return;
        }
        if (!offer.sdp) {
          throw new Error("Realtime SDP offer is empty");
        }

        let timeZone: string | undefined;
        try {
          timeZone = getTimeZone()?.trim() || undefined;
        } catch {
          // Time-zone discovery is optional and must never prevent a call.
        }
        const headers = {
          "Content-Type": "application/sdp",
          "X-Yui-Session-Id": sessionId,
          ...(timeZone ? { "X-Yui-Time-Zone": timeZone } : {}),
        };

        const response = await fetchImpl("/api/realtime/calls", {
          method: "POST",
          headers,
          body: offer.sdp,
        });
        if (released) {
          return;
        }
        if (!response.ok) {
          throw new Error(`Realtime call failed with ${response.status}`);
        }

        zundamon=response.headers.get("X-Yui-Voice-Provider")==="zundamon";
        if(zundamon && !speechPlayer)throw new Error("このブラウザーでは音声を再生できません。");
        const answerSdp = await response.text();
        if (released) {
          return;
        }
        if (!answerSdp.trim()) {
          throw new Error("Realtime SDP answer is empty");
        }
        await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
        realtimeReady = true;
      } catch (cause) {
        if (released) {
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        releaseResources();
        options.dispatch({ type: "failed", error });
        throw error;
      }
    },

    stop,
    setMuted(muted) {
      if (released) return;
      userMuted = muted;
      setMicrophoneEnabled(!muted);
      options.dispatch({type:"microphone",enabled:!muted && !released});
    },
    interrupt() {
      if(released) return;
      speechQueue?.cancel(); cancelActiveResponse();
      setMicrophoneEnabled(true);
      options.dispatch({type:"listening"});
    },

    usageContext() {
      return sessionId && startedAt && endedAt
        ? { sessionId, startedAt, endedAt }
        : null;
    },

    consumeMemoryBatch() {
      const batch = sealedMemoryBatch;
      sealedMemoryBatch = null;
      return batch;
    },

    cancelMemory() {
      memoryCancelled = true;
      memoryTurns = [];
      sealedMemoryBatch = null;
    },
  };
}

type RealtimeUsage = {
  inputTextTokens: number;
  outputTextTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  cachedInputTextTokens: number;
  cachedInputAudioTokens: number;
  asrInputAudioTokens: number;
  asrInputTextTokens: number;
  asrOutputTokens: number;
};

function emptyUsage(): RealtimeUsage {
  return {
    inputTextTokens: 0,
    outputTextTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    cachedInputTextTokens: 0,
    cachedInputAudioTokens: 0,
    asrInputAudioTokens: 0,
    asrInputTextTokens: 0,
    asrOutputTokens: 0,
  };
}

function addUsageEvent(usage: RealtimeUsage, event: RealtimeEvent): boolean {
  if (event.type === "response.done") {
    const response = record(event.response);
    const responseUsage = record(response?.usage);
    const input = record(responseUsage?.input_token_details);
    const cached = record(input?.cached_tokens_details);
    const output = record(responseUsage?.output_token_details);
    const cachedText = tokenCount(cached?.text_tokens);
    const cachedAudio = tokenCount(cached?.audio_tokens);

    usage.cachedInputTextTokens += cachedText;
    usage.cachedInputAudioTokens += cachedAudio;
    usage.inputTextTokens += Math.max(
      0,
      tokenCount(input?.text_tokens) - cachedText,
    );
    usage.inputAudioTokens += Math.max(
      0,
      tokenCount(input?.audio_tokens) - cachedAudio,
    );
    usage.outputTextTokens += tokenCount(output?.text_tokens);
    usage.outputAudioTokens += tokenCount(output?.audio_tokens);
    return true;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    const asrUsage = record(event.usage);
    if (asrUsage?.type === "tokens") {
      const input = record(asrUsage.input_token_details);
      usage.asrInputAudioTokens += tokenCount(input?.audio_tokens);
      usage.asrInputTextTokens += tokenCount(input?.text_tokens);
      usage.asrOutputTokens += tokenCount(asrUsage.output_tokens);
    }
    return true;
  }

  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function validRealtimeId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ? value
    : null;
}

function realtimeResponseId(event: RealtimeEvent): string | null {
  return validRealtimeId(record(event.response)?.id ?? event.response_id);
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function isRealtimeEvent(event: unknown): event is RealtimeEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    typeof (event as { type?: unknown }).type === "string"
  );
}

function transcriptAction(
  role: "user" | "assistant",
  transcript: unknown,
): SessionAction | null {
  if (typeof transcript !== "string" || !transcript.trim()) {
    return null;
  }
  return {
    type: "transcript",
    turn: { role, text: transcript.trim() },
  };
}

function parseRealtimeEvent(
  message: MessageEvent,
  logger: Logger,
): RealtimeEvent | null {
  if (typeof message.data !== "string") {
    logger.warn("Ignored non-text Realtime event");
    return null;
  }
  try {
    const event: unknown = JSON.parse(message.data);
    if (!isRealtimeEvent(event)) {
      logger.warn("Ignored malformed Realtime event");
      return null;
    }
    return event;
  } catch {
    logger.warn("Ignored malformed Realtime event");
    return null;
  }
}

function sendOpeningRequest(
  dataChannel: RTCDataChannel,
): void {
  dataChannel.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "直近のテキスト会話があればその話題を一つだけ自然に引き継ぎ、なければ現在の時間帯に合う短い挨拶と答えやすい質問一つで始めてください。1文から2文に収め、自己紹介、話題メニュー、サービス案内はしないでください。",
          },
        ],
      },
    }),
  );
}
