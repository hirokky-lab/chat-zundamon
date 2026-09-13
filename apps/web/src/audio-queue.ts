import { TtsClientError } from "./tts-client";
import type { TtsClient } from "./tts-client";

export type SpokenChunk = { generation: number; index: number; text: string };
export type AudioQueue = { beginGeneration(): number; enqueue(chunk: SpokenChunk): void; completeGeneration(generation: number): void; cancelGeneration(): void };
type AudioQueueOptions = { ttsClient: TtsClient; play: (blob: Blob, signal: AbortSignal) => Promise<void>; wait: (ms: number, signal: AbortSignal) => Promise<void>; onSpeaking: () => void; onListening: () => void; onDrained: (generation: number) => void; onTerminalError: (error: TtsClientError) => void };
type Generation = { id: number; controller: AbortController; pending: SpokenChunk[]; nextIndex: number; completed: boolean; failed: boolean; draining: boolean; drained: boolean };

export function createAudioQueue(options: AudioQueueOptions): AudioQueue {
  let nextGeneration = 0;
  let current = makeGeneration(0);

  const isCurrent = (state: Generation) => current === state;
  const checkDrained = (state: Generation) => {
    if (!isCurrent(state) || state.failed || state.controller.signal.aborted || !state.completed || state.pending.length || state.draining || state.drained) return;
    state.drained = true;
    options.onListening();
    options.onDrained(state.id);
  };
  const start = (state: Generation) => { void drain(state); };
  const drain = async (state: Generation): Promise<void> => {
    if (state.draining || state.failed || state.controller.signal.aborted) return;
    state.draining = true;
    try {
      while (isCurrent(state) && !state.failed && !state.controller.signal.aborted) {
        const position = state.pending.findIndex((chunk) => chunk.index === state.nextIndex);
        if (position < 0) break;
        const chunk = state.pending.splice(position, 1)[0]!;
        const requestId = `tts:${state.id}:${chunk.index}`;
        let blob: Blob | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try { blob = await options.ttsClient.synthesize({ requestId, text: chunk.text }, state.controller.signal); break; }
          catch (error) {
            if (!isCurrent(state) || state.controller.signal.aborted) break;
            const failure = error instanceof TtsClientError ? error : new TtsClientError("upstream");
            if (attempt === 0 && (failure.kind === "timeout" || failure.kind === "upstream")) {
              try { await options.wait(250, state.controller.signal); } catch { break; }
              continue;
            }
            state.failed = true;
            state.pending = [];
            options.onTerminalError(failure);
            break;
          }
        }
        if (!blob || !isCurrent(state) || state.failed || state.controller.signal.aborted) continue;
        options.onSpeaking();
        try { await options.play(blob, state.controller.signal); } catch { /* cancellation/playback failure is non-terminal */ }
        if (isCurrent(state) && !state.controller.signal.aborted) state.nextIndex += 1;
      }
    } finally {
      state.draining = false;
      checkDrained(state);
    }
  };

  return {
    beginGeneration() {
      current.controller.abort();
      current = makeGeneration(++nextGeneration);
      return current.id;
    },
    enqueue(chunk) {
      if (chunk.generation !== current.id || current.failed || current.controller.signal.aborted) return;
      current.pending.push(chunk);
      start(current);
    },
    completeGeneration(generation) {
      if (generation !== current.id || current.failed) return;
      current.completed = true;
      checkDrained(current);
    },
    cancelGeneration() {
      current.controller.abort();
      current = makeGeneration(++nextGeneration);
    },
  };
}

function makeGeneration(id: number): Generation {
  return { id, controller: new AbortController(), pending: [], nextIndex: 0, completed: false, failed: false, draining: false, drained: false };
}
