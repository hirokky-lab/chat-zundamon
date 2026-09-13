import {acquirePlaybackAudioSession} from '../playback-audio-session';
import {isBgmTrack, type BgmTrack} from '@yui/domain';
export {BGM_TRACKS, type BgmTrack} from '@yui/domain';
export type BgmSettings = { enabled: boolean; volume: number; track: BgmTrack };
export const DEFAULT_BGM: BgmSettings = { enabled: false, volume: 0.12, track: 'hiru' };
export function parseBgmSettings(value: unknown): BgmSettings {
  const v = value as Partial<BgmSettings> | null;
  return { enabled: v?.enabled === true, volume: typeof v?.volume === 'number' && Number.isFinite(v.volume) ? Math.max(0, Math.min(0.5, v.volume)) : DEFAULT_BGM.volume,
    track: isBgmTrack(v?.track) ? v.track : 'hiru' };
}
export type BgmApi = { load(track: BgmTrack, signal: AbortSignal): Promise<ArrayBuffer> };
export function createBgmApi(fetch: typeof globalThis.fetch): BgmApi {
  return { async load(track, signal) {
    const response = await fetch('/api/bgm/' + track, {signal, cache: 'no-store'});
    if (!response.ok) throw Error(response.status === 404 ? 'この曲の音源はまだ準備できていません。' : 'BGMを読み込めませんでした。もう一度お試しください。');
    return response.arrayBuffer();
  } };
}
export type BgmStatus = 'off' | 'waiting' | 'loading' | 'playing' | 'paused' | 'error';
/** Separate gain avoids iOS HTMLMediaElement.volume limitations and never touches speech playback. */
export class BgmPlayer {
  private context?: AudioContext;
  private audioSession?: ReturnType<typeof acquirePlaybackAudioSession>;
  private gain?: GainNode;
  private source?: AudioBufferSourceNode;
  private buffer?: {track: BgmTrack; data: AudioBuffer};
  private request?: AbortController;
  private generation = 0;
  private settings = DEFAULT_BGM;
  private track: BgmTrack = 'hiru';
  private blocked = false;
  private unlocked = false;
  private disposed = false;
  private ducked = false;
  private status: BgmStatus = 'off';
  constructor(private api: BgmApi, private notify: (status: BgmStatus, error?: string) => void, private makeContext = () => new AudioContext()) {}
  private report(status: BgmStatus, error?: string) { this.status = status; this.notify(status, error); }
  configure(settings: BgmSettings, blocked: boolean) {
    const track = settings.track;
    const restart = track !== this.track || this.settings.enabled !== settings.enabled || this.blocked !== blocked;
    this.settings = settings; this.track = track; this.blocked = blocked;
    this.applyGain();
    if (restart) { this.stop(); void this.start(); }
  }
  /** Must be called synchronously in a user gesture, before any download. */
  unlock() {
    if (this.disposed || !this.settings.enabled || this.blocked || this.status === 'error') return;
    try {
      this.audioSession ??= acquirePlaybackAudioSession();
      this.audioSession.refresh();
      if (!this.context) { this.context = this.makeContext(); this.gain = this.context.createGain(); this.gain.connect(this.context.destination); }
      this.unlocked = true;
      void this.context.resume().then(() => this.start()).catch(() => this.report('waiting'));
    } catch { this.report('error', 'このブラウザではBGMを再生できません。'); }
  }
  pause() { this.blocked = true; this.stop(); this.report(this.settings.enabled ? 'paused' : 'off'); }
  duck(speaking: boolean) { if (speaking === this.ducked) return; this.ducked = speaking; this.applyGain(); }
  private applyGain() {
    if (!this.gain || !this.context) return;
    const value = this.settings.volume * (this.ducked ? 0.25 : 1);
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setTargetAtTime(value, this.context.currentTime, this.ducked ? 0.08 : 0.35);
  }
  private stop() {
    this.audioSession?.release(); this.audioSession = undefined;
    this.generation++; this.request?.abort(); this.request = undefined;
    this.source?.stop(); this.source?.disconnect(); this.source = undefined;
    if (this.context?.state === 'running') void this.context.suspend().catch(() => {});
  }
  private async start() {
    if (this.disposed) return;
    if (!this.settings.enabled) { this.report('off'); return; }
    if (this.blocked) { this.report('paused'); return; }
    if (!this.unlocked || !this.context) { this.report('waiting'); return; }
    if (this.source || this.request) return;
    const context = this.context, track = this.track, generation = this.generation;
    const request = new AbortController(); this.request = request;
    this.report('loading');
    try {
      if (this.buffer?.track !== track) {
        const bytes = await this.api.load(track, request.signal);
        const data = await context.decodeAudioData(bytes).catch(() => {
          throw Error('この音源を再生できませんでした。別の曲を選ぶか、もう一度お試しください。');
        });
        if (generation !== this.generation || this.disposed) return;
        this.buffer = {track, data};
      }
      this.audioSession ??= acquirePlaybackAudioSession();
      this.audioSession.refresh();
      await context.resume();
      if (generation !== this.generation || this.disposed) return;
      if (context.state !== 'running') { this.report('waiting'); return; }
      this.source = context.createBufferSource(); this.source.buffer = this.buffer.data;
      this.source.loop = true; this.source.connect(this.gain!);
      this.gain!.gain.setValueAtTime(0, context.currentTime); this.applyGain();
      this.source.start(); this.report('playing');
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.report('error', error instanceof Error ? error.message : 'BGMを再生できませんでした。');
    } finally { if (this.request === request) this.request = undefined; }
  }
  retry() { this.stop(); this.report('waiting'); this.unlock(); }
  dispose() { this.disposed = true; this.stop(); this.buffer = undefined; void this.context?.close().catch(() => {}); }
}
