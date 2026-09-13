import type { TtsStatus } from "../../../packages/domain/src/index.js";
import { TtsProviderError } from "./tts.js";
import type { TtsProvider } from "./tts.js";

type VoicevoxStyle = { id: number; name: string; type?: string };
type VoicevoxSpeaker = { name: string; styles: VoicevoxStyle[] };
type Fetch = typeof globalThis.fetch;

const MAX_QUERY_BYTES = 1_000_000;
const MAX_WAV_BYTES = 16_000_000;

export type VoicevoxNemoProviderOptions = {
  baseUrls: string[];
  fetch?: Fetch;
  now?: () => number;
  statusTimeoutMs: number;
  queryTimeoutMs: number;
  synthesisTimeoutMs: number;
  createTimeoutSignal?: (milliseconds: number) => AbortSignal;
};

type UpstreamResponse = {
  response: Response;
  signal: AbortSignal;
};

type SelectedVoice = {
  baseUrl: string;
  speakerId: number;
};

export class VoicevoxNemoProvider implements TtsProvider {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly createTimeoutSignal: (milliseconds: number) => AbortSignal;
  private selectedVoice: SelectedVoice | undefined;
  private styleExpiresAt = 0;
  private statusExpiresAt = 0;

  constructor(private readonly options: VoicevoxNemoProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.createTimeoutSignal = options.createTimeoutSignal ?? AbortSignal.timeout;
  }

  async status(signal?: AbortSignal): Promise<TtsStatus> {
    if (signal?.aborted) throw new TtsProviderError("cancelled");
    if (this.statusExpiresAt > this.now()) {
      return { available: true, provider: "voicevox-nemo", voiceLabel: "女性2" };
    }
    try {
      this.clearExpiredVoice();
      const deadlineAt = this.now() + this.options.statusTimeoutMs;
      const speaker = await this.resolveVoice(signal, deadlineAt);
      await this.requestQueryAndSynthesis(
        "接続確認", speaker, signal, this.options.statusTimeoutMs, this.options.statusTimeoutMs, deadlineAt,
      );
      const expiresAt = this.now() + 60_000;
      this.statusExpiresAt = expiresAt;
      this.styleExpiresAt = expiresAt;
      return { available: true, provider: "voicevox-nemo", voiceLabel: "女性2" };
    } catch (error) {
      this.clearVoice();
      throw this.normalizeError(error, signal);
    }
  }

  async synthesize(
    input: { text: string; requestId: string },
    signal?: AbortSignal,
  ): Promise<{ audio: Uint8Array; contentType: "audio/wav" }> {
    try {
      this.clearExpiredVoice();
      const hadCachedVoice = this.selectedVoice !== undefined;
      const speaker = await this.resolveVoice(signal);
      try {
        const audio = await this.requestQueryAndSynthesis(
          input.text,
          speaker,
          signal,
          this.options.queryTimeoutMs,
          this.options.synthesisTimeoutMs,
        );
        return { audio, contentType: "audio/wav" };
      } catch (error) {
        this.clearVoice();
        if (!hadCachedVoice || signal?.aborted) throw error;
        const rediscovered = await this.resolveVoice(signal);
        const audio = await this.requestQueryAndSynthesis(
          input.text,
          rediscovered,
          signal,
          this.options.queryTimeoutMs,
          this.options.synthesisTimeoutMs,
        );
        return { audio, contentType: "audio/wav" };
      }
    } catch (error) {
      this.clearVoice();
      throw this.normalizeError(error, signal);
    }
  }

  private async resolveVoice(signal?: AbortSignal, deadlineAt?: number): Promise<SelectedVoice> {
    if (this.selectedVoice !== undefined && this.styleExpiresAt > this.now()) return this.selectedVoice;
    let lastError: TtsProviderError = new TtsProviderError("unavailable");
    for (const baseUrl of uniqueBaseUrls(this.options.baseUrls)) {
      try {
        const version = await this.request(
          baseUrl, "/version", { method: "GET" }, signal, this.options.statusTimeoutMs, deadlineAt,
        );
        await version.response.body?.cancel();
        const speakersResponse = await this.request(
          baseUrl, "/speakers", { method: "GET" }, signal, this.options.statusTimeoutMs, deadlineAt,
        );
        const speakers = JSON.parse(new TextDecoder().decode(await this.readBody(
          speakersResponse.response, MAX_QUERY_BYTES, "application/json", speakersResponse.signal,
        ))) as VoicevoxSpeaker[];
        const speaker = speakers.find((candidate) => candidate.name === "女声2");
        const style = speaker?.styles.find((candidate) => candidate.name === "ノーマル");
        if (!speaker || !style) {
          lastError = new TtsProviderError("voice-not-found");
          continue;
        }
        this.selectedVoice = { baseUrl, speakerId: style.id };
        this.styleExpiresAt = this.now() + 60_000;
        return this.selectedVoice;
      } catch (error) {
        const normalized = this.normalizeError(error, signal);
        if (normalized.kind === "cancelled") throw normalized;
        lastError = normalized;
      }
    }
    throw lastError;
  }

  private async requestQueryAndSynthesis(
    text: string,
    speaker: SelectedVoice,
    signal?: AbortSignal,
    queryTimeoutMs = this.options.queryTimeoutMs,
    synthesisTimeoutMs = this.options.synthesisTimeoutMs,
    deadlineAt?: number,
  ): Promise<Uint8Array> {
    const query = await this.request(
      speaker.baseUrl,
      `/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker.speakerId}`,
      { method: "POST" },
      signal,
      queryTimeoutMs,
      deadlineAt,
    );
    const queryJson = new TextDecoder().decode(await this.readBody(
      query.response, MAX_QUERY_BYTES, "application/json", query.signal,
    ));
    const synthesis = await this.request(
      speaker.baseUrl,
      `/synthesis?speaker=${speaker.speakerId}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: queryJson },
      signal,
      synthesisTimeoutMs,
      deadlineAt,
    );
    const audio = await this.readBody(synthesis.response, MAX_WAV_BYTES, "audio/wav", synthesis.signal);
    if (!this.isValidWav(audio)) throw new TtsProviderError("upstream");
    return audio;
  }

  private isValidWav(audio: Uint8Array): boolean {
    if (audio.length < 44 || this.fourCc(audio, 0) !== "RIFF" || this.fourCc(audio, 8) !== "WAVE") {
      return false;
    }
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
    if (view.getUint32(4, true) !== audio.length - 8) return false;
    let offset = 12;
    let fmt: DataView | undefined;
    let hasData = false;
    while (offset < audio.length) {
      if (offset + 8 > audio.length) return false;
      const size = view.getUint32(offset + 4, true);
      const contentStart = offset + 8;
      const contentEnd = contentStart + size;
      const paddedEnd = contentEnd + (size % 2);
      if (contentEnd > audio.length || paddedEnd > audio.length) return false;
      const type = this.fourCc(audio, offset);
      if (type === "fmt ") {
        if (size < 16 || fmt) return false;
        fmt = new DataView(audio.buffer, audio.byteOffset + contentStart, size);
      }
      if (type === "data") hasData = true;
      offset = paddedEnd;
    }
    if (offset !== audio.length || !fmt || !hasData) return false;
    const format = fmt.getUint16(0, true);
    const channels = fmt.getUint16(2, true);
    const sampleRate = fmt.getUint32(4, true);
    const byteRate = fmt.getUint32(8, true);
    const blockAlign = fmt.getUint16(12, true);
    const bitsPerSample = fmt.getUint16(14, true);
    return format === 1 && channels > 0 && sampleRate > 0 && byteRate > 0 && blockAlign > 0 && bitsPerSample > 0;
  }

  private fourCc(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(...bytes.slice(offset, offset + 4));
  }

  private async readBody(
    response: Response,
    maxBytes: number,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== contentType) {
      await response.body?.cancel();
      throw new TtsProviderError("upstream");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new TtsProviderError("upstream");
    }
    if (!response.body) throw new TtsProviderError("upstream");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await this.readChunk(reader, signal);
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new TtsProviderError("upstream");
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  private async readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!signal) return reader.read();
    if (signal.aborted) throw signal.reason;
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      void reader.read().then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private clearExpiredVoice(): void {
    if (this.styleExpiresAt <= this.now()) this.clearVoice();
  }

  private clearVoice(): void {
    this.selectedVoice = undefined;
    this.styleExpiresAt = 0;
    this.statusExpiresAt = 0;
  }

  private async request(
    baseUrl: string,
    path: string,
    init: RequestInit,
    callerSignal: AbortSignal | undefined,
    timeoutMs: number,
    deadlineAt?: number,
  ): Promise<UpstreamResponse> {
    if (callerSignal?.aborted) throw new TtsProviderError("cancelled");
    const remaining = deadlineAt === undefined
      ? timeoutMs
      : Math.min(timeoutMs, deadlineAt - this.now());
    if (remaining <= 0) throw new TtsProviderError("timeout");
    const timeout = this.createTimeoutSignal(remaining);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    try {
      const response = await this.fetch(new URL(path, baseUrl), { ...init, signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TtsProviderError("upstream");
      }
      return { response, signal };
    } catch (error) {
      throw this.normalizeError(error, callerSignal, timeout);
    }
  }

  private normalizeError(error: unknown, callerSignal?: AbortSignal, timeout?: AbortSignal): TtsProviderError {
    if (error instanceof TtsProviderError) return error;
    if (callerSignal?.aborted) return new TtsProviderError("cancelled");
    if (timeout?.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) {
      return new TtsProviderError("timeout");
    }
    if (
      error instanceof TypeError ||
      (error instanceof Error && /ECONNREFUSED|connection refused/i.test(error.message))
    ) return new TtsProviderError("unavailable");
    return new TtsProviderError("upstream");
  }
}

function uniqueBaseUrls(baseUrls: string[]): string[] {
  return [...new Set(baseUrls)];
}

export function createVoicevoxNemoProvider(options: VoicevoxNemoProviderOptions): TtsProvider {
  return new VoicevoxNemoProvider(options);
}
