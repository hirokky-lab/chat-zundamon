import {useEffect, useRef, useState} from 'react';
import {readVoiceAudioSignal} from '../voice-audio-signal';
import {BgmPlayer, DEFAULT_BGM, parseBgmSettings, type BgmApi, type BgmSettings, type BgmStatus} from './player';
export function useBgm(api: BgmApi | undefined, scope: string, blocked: boolean) {
  const key = 'zundamon:bgm:' + scope;
  const [settings, setSettings] = useState<BgmSettings>(DEFAULT_BGM);
  const [status, setStatus] = useState<BgmStatus>('off');
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(() => document.hidden);
  const player = useRef<BgmPlayer | null>(null);
  const current = useRef({settings, blocked: blocked || hidden});
  current.current = {settings, blocked: blocked || hidden};
  useEffect(() => {
    try { setSettings(parseBgmSettings(JSON.parse(localStorage.getItem(key) ?? 'null'))); }
    catch { setSettings(DEFAULT_BGM); }
  }, [key]);
  useEffect(() => {
    if (!api) return;
    const p = new BgmPlayer(api, (s, e) => {setStatus(s); setError(e);}); player.current = p;
    const visibility = () => { if (document.hidden) p.pause(); setHidden(document.hidden); };
    // Only explicit BGM play actions unlock playback; a chat tap must not start music.
    document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => p.duck(readVoiceAudioSignal().speechState !== 'silent'), 100);
    p.configure(current.current.settings, current.current.blocked);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); p.dispose(); player.current = null; };
  }, [api, key]);
  useEffect(() => {player.current?.configure(settings, blocked || hidden);}, [settings, blocked, hidden]);
  return {settings, status, error, pause: () => player.current?.pause(), retry: () => player.current?.retry(),
    update(patch: Partial<BgmSettings>) {
      const next = parseBgmSettings({...settings, ...patch}); setSettings(next);
      try {localStorage.setItem(key, JSON.stringify(next));} catch {setError('BGMの設定を保存できません。この画面ではそのまま使えます。');}
      player.current?.configure(next, blocked || hidden);
      if (patch.enabled === true) player.current?.unlock();
    },
  };
}
export type BgmController = ReturnType<typeof useBgm>;
