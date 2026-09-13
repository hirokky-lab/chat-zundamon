import {
  CHAT_DICTATION_MAX_BYTES,
  CHAT_DICTATION_MAX_MS,
  type ChatDictationMimeType,
} from "@yui/domain";
import type { TranscriptionApi } from "./api";

export type DictationState = "idle" | "recording" | "transcribing" | "error";

export type DictationRecorder = {
  state: RecordingState;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
};

type DictationRecorderConstructor = {
  new (stream: MediaStream, options: MediaRecorderOptions): DictationRecorder;
  isTypeSupported(mimeType: string): boolean;
};

type Clock = Pick<Window, "setTimeout" | "clearTimeout">;

type DictationSession = {
  stream: MediaStream;
  recorder: DictationRecorder;
  mimeType: ChatDictationMimeType;
  chunks: Blob[];
  abortController: AbortController;
  timer: number | null;
  stopped: boolean;
  cancelled: boolean;
  cleaned: boolean;
  tracksReleased: boolean;
  finalizing: boolean;
  completion: Promise<void>;
  resolve: () => void;
};

export type DictationController = {
  readonly state: DictationState;
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): void;
};

export function createDictationController({
  mediaDevices,
  MediaRecorder,
  transcriptionApi,
  clock,
  onTranscript,
  onState,
  onError = () => undefined,
}: {
  mediaDevices: Pick<MediaDevices, "getUserMedia">;
  MediaRecorder: DictationRecorderConstructor;
  transcriptionApi: TranscriptionApi;
  clock: Clock;
  onTranscript: (text: string) => void;
  onState: (state: DictationState) => void;
  onError?: (cause: unknown) => void;
}): DictationController {
  let state: DictationState = "idle";
  let session: DictationSession | null = null;
  let startRequest = 0;
  let starting = false;

  const setState = (next: DictationState) => {
    state = next;
    onState(next);
  };

  const releaseTracks = (current: DictationSession) => {
    if (current.tracksReleased) return;
    current.tracksReleased = true;
    for (const track of current.stream.getTracks()) track.stop();
  };

  const cleanup = (current: DictationSession) => {
    if (current.cleaned) return;
    current.cleaned = true;
    if (current.timer !== null) {
      clock.clearTimeout(current.timer);
      current.timer = null;
    }
    current.recorder.ondataavailable = null;
    current.recorder.onerror = null;
    current.recorder.onstop = null;
    current.chunks.length = 0;
    releaseTracks(current);
    if (session === current) session = null;
    current.resolve();
  };

  const fail = (current: DictationSession | null, cause: unknown = new Error("dictation failed")) => {
    if (current) cleanup(current);
    setState("idle");
    onError(cause);
  };

  const completeRecording = async (current: DictationSession) => {
    if (current.cancelled || current.cleaned || current.finalizing) return;
    current.finalizing = true;
    if (current.timer !== null) {
      clock.clearTimeout(current.timer);
      current.timer = null;
    }
    const blob = new Blob(current.chunks, { type: current.mimeType });
    current.chunks.length = 0;
    if (blob.size === 0 || blob.size > CHAT_DICTATION_MAX_BYTES) {
      fail(current);
      return;
    }

    releaseTracks(current);
    setState("transcribing");
    try {
      const text = (await transcriptionApi.transcribe(blob, current.abortController.signal)).trim();
      if (!current.cancelled && text) onTranscript(text);
      if (!current.cancelled) {
        cleanup(current);
        setState("idle");
      }
    } catch (cause) {
      if (!current.cancelled) fail(current, cause);
    }
  };

  const stop = async () => {
    const current = session;
    if (!current) return;
    if (current.stopped) return current.completion;
    current.stopped = true;
    if (current.timer !== null) {
      clock.clearTimeout(current.timer);
      current.timer = null;
    }
    if (current.recorder.state === "inactive") {
      void completeRecording(current);
    } else {
      current.recorder.stop();
    }
    return current.completion;
  };

  return {
    get state() {
      return state;
    },
    async start() {
      if (state === "recording" || state === "transcribing" || starting) return;
      const request = startRequest + 1;
      startRequest = request;
      starting = true;
      let stream: MediaStream | null = null;
      let current: DictationSession | null = null;
      try {
        stream = await mediaDevices.getUserMedia({ audio: true });
        if (request !== startRequest) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const mimeType = (["audio/webm", "audio/mp4"] as const).find((type) => MediaRecorder.isTypeSupported(type));
        if (!mimeType) {
          for (const track of stream.getTracks()) track.stop();
          stream = null;
          throw new Error("unsupported recorder");
        }
        let resolve: () => void = () => undefined;
        const completion = new Promise<void>((done) => { resolve = done; });
        const recorder = new MediaRecorder(stream, { mimeType });
        const created: DictationSession = {
          stream,
          recorder,
          mimeType,
          chunks: [],
          abortController: new AbortController(),
          timer: null,
          stopped: false,
          cancelled: false,
          cleaned: false,
          tracksReleased: false,
          finalizing: false,
          completion,
          resolve,
        };
        current = created;
        session = created;
        recorder.ondataavailable = (event) => {
          if (!created.cancelled && event.data.size > 0) created.chunks.push(event.data);
        };
        recorder.onerror = (event) => fail(created, event.error ?? event);
        recorder.onstop = () => { void completeRecording(created); };
        recorder.start();
        created.timer = clock.setTimeout(() => { void stop(); }, CHAT_DICTATION_MAX_MS);
        setState("recording");
      } catch (cause) {
        if (current) cleanup(current);
        else if (stream) for (const track of stream.getTracks()) track.stop();
        if (request === startRequest) fail(null, cause);
      } finally {
        if (request === startRequest) starting = false;
      }
    },
    stop,
    abort() {
      startRequest += 1;
      starting = false;
      const current = session;
      if (!current) return;
      current.cancelled = true;
      current.abortController.abort();
      if (current.recorder.state !== "inactive") current.recorder.stop();
      cleanup(current);
      setState("idle");
    },
  };
}
