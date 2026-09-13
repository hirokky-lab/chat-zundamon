import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import { EMPTY_LOCAL_CHAT } from '../../src/local-state';
import { createZundamonModelManifest } from '../../src/live2d/zundamon-model-manifest';
import type { AvatarRendererLoader } from '../../src/live2d/avatar-contract';
import type { LifeServicesApi } from '../../src/life-services';
import type { MemoryApi } from '../../src/api';
import '../../src/styles.css';

const now = () => new Date().toISOString();
const profile = { displayName: '確認用', addressingStyle: 'san' as const, updatedAt: now() };
const bridge = await fetch('/live2d/zundamon/local-bridge.json').then(r => r.json());
const manifest = createZundamonModelManifest(bridge.sha256)!;
const metrics = { loads: 0, disposed: 0, active: 0, frames: 0, firstReadyMs: 0, lastMouth: 0, lastEye: 1, mouthMax: 0, blinks: 0 };
Object.assign(window, { avatarMetrics: metrics });
const loader: AvatarRendererLoader = async (canvas, model, signal) => {
  metrics.loads++;
  const start = performance.now();
  const { loadVerifiedAvatarRenderer } = await import('../../src/live2d/avatar-loader');
  const renderer = await loadVerifiedAvatarRenderer({ canvas, manifest: model, signal, timeoutMs: 15000 });
  metrics.firstReadyMs = performance.now() - start;
  metrics.active++;
  let disposed = false;
  return {
    resize: (...args) => renderer.resize(...args),
    setInput(input) { metrics.frames++; metrics.lastMouth = input.mouthOpen; metrics.lastEye = input.eyeOpenLeft; metrics.mouthMax = Math.max(metrics.mouthMax, input.mouthOpen); if (!input.eyeOpenLeft) metrics.blinks++; renderer.setInput(input); },
    dispose() { if (!disposed) { disposed = true; metrics.disposed++; metrics.active--; } renderer.dispose(); },
  };
};
const memoryApi: MemoryApi = {
  list: async () => [], update: async () => { throw new Error('fixture'); }, keep: async () => { throw new Error('fixture'); }, forget: async () => {},
  listTombstones: async () => [], releaseTombstone: async () => {}, getSettings: async () => ({ memoryEnabled: false, updatedAt: null }), updateSettings: async () => ({ memoryEnabled: false, updatedAt: null }),
};
const fixtureServices = { getSettings: async () => ({ revision: 0, home: null, calendar: null, tasks: null }) } as LifeServicesApi;
let fixtureVolume: number | null = null;
const params = new URLSearchParams(location.search);
// This fixture reads no audio device and plays no sound. A deterministic envelope
// demonstrates the same 0..1 adapter that future cloud playback can supply.
const readAudioSignal = () => fixtureVolume !== null ? { speechState: 'speaking' as const, volume: fixtureVolume } : params.get('mouth') === 'fixture'
  ? { speechState: 'speaking' as const, volume: Math.max(0, Math.sin(performance.now() / 180)) * 0.85 }
  : { speechState: 'silent' as const, volume: 0 };
createRoot(document.getElementById('root')!).render(<><App
  createAvatarSpeechPlayer={() => ({play:async(text,signal)=>{if(!signal.aborted)Object.assign(window,{lastSpokenText:text});},close:()=>{}})}
  live2dAvatarEnabled live2dModel={manifest} live2dRendererLoader={loader} live2dReadAudioSignal={readAudioSignal}
  integratedUiEnabled lifeServicesApi={fixtureServices} splashDurationMs={0} automaticMemoryEnabled={false} memoryApi={memoryApi}
  now={now} nextId={() => crypto.randomUUID()} profileApi={{ get: async () => profile, save: async () => profile }}
  chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now() }), save: async () => {} }}
  chatApi={{ respond: async request => ({ replyGroupId: request.clientMessageId + ':assistant', bubbles: [{ id: request.clientMessageId + ':reply', sequence: 0, text: 'ずんだもんの姿を表示する、ローカルの試作だよ。', createdAt: now() }] }) }}
/>
<details style={{ position: 'fixed', zIndex: 7, bottom: 104, left: 12, maxWidth: 'calc(100% - 24px)', padding: '8px 12px', borderRadius: 12, background: '#fff', border: '1px solid #e5e3e9', fontSize: 12 }}>
  <summary>動作確認（無音）</summary>
  <label style={{ display: 'block', padding: 8 }}>口の開き <input aria-label="口の開き" type="range" min="0" max="1" step="0.1" defaultValue="0" onChange={e => { fixtureVolume = Number(e.target.value); }} /></label>
  <button type="button" onClick={() => { fixtureVolume = null; }}>自動の口の動きに戻す</button>
  <p>録音・音声再生・実通話は行いません。</p>
</details>
</>);
