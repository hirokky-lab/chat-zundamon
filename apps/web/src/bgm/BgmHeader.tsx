import {useEffect, useId, useRef, useState} from 'react';
import {CaretDown, MusicNote, Pause, Play, X} from '@phosphor-icons/react';
import {BGM_TRACKS, type BgmTrack} from './player';
import type {BgmController} from './use-bgm';
import './bgm-header.css';

/** The header controls the shared player; opening this panel never unlocks audio. */
export function BgmHeader({controller: c}: {controller: BgmController}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const active = c.settings.enabled && (c.status === 'playing' || c.status === 'loading' || c.status === 'paused');
  const close = () => {setOpen(false); trigger.current?.focus();};

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); setOpen(false); trigger.current?.focus();}
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const togglePlayback = () => {
    if (active) c.update({enabled:false});
    else if (c.settings.enabled) c.retry();
    else c.update({enabled:true});
  };
  const status = c.error ?? ({off:'',waiting:'再生ボタンで開始できます',loading:'読み込み中…',playing:'',paused:'音声入力・通話中は一時停止します',error:'再生できませんでした'})[c.status];

  return <div className="bgm-header" ref={root}>
    <button ref={trigger} type="button" className="header-action bgm-header-trigger" aria-label="BGMを操作" title="BGM" aria-expanded={open} aria-controls={id} aria-haspopup="dialog" data-playing={c.status === 'playing'} onClick={() => setOpen(value => !value)}>
      <MusicNote size={24} weight={c.status === 'playing' ? 'fill' : 'regular'} aria-hidden="true" />
    </button>
    {open && <section id={id} role="dialog" aria-label="BGMプレーヤー" className="bgm-popover">
      <div className="bgm-popover-heading"><span>BGM</span><button ref={closeButton} type="button" className="bgm-close" onClick={close} aria-label="BGMプレーヤーを閉じる"><X size={18} aria-hidden="true" /></button></div>
      <div className="bgm-popover-track">
        <div className="bgm-track-select"><select aria-label="BGMの曲" value={c.settings.track} onChange={event => c.update({track:event.target.value as BgmTrack})}>
          {BGM_TRACKS.map(track => <option key={track.id} value={track.id}>{track.title}</option>)}
        </select><CaretDown size={18} aria-hidden="true" /></div>
        <button type="button" className="bgm-playback" aria-label={active ? 'BGMを停止' : 'BGMを再生'} onClick={togglePlayback}>
          {active ? <Pause size={23} weight="fill" aria-hidden="true" /> : <Play size={23} weight="fill" aria-hidden="true" />}
        </button>
      </div>
      {status && <p className="bgm-popover-status" role="status">{status}</p>}
    </section>}
  </div>;
}
