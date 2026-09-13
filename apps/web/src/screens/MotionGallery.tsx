import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Stop, ArrowCounterClockwise } from '@phosphor-icons/react';
import { MenuPage } from '../components/MenuPage';
import { AvatarStage, type AvatarStageProps } from '../live2d/AvatarStage';
import type { AvatarModelManifest, AvatarPreview } from '../live2d/avatar-contract';
import { MOTION_GALLERY, MOTION_GALLERY_ASSET } from '../live2d/motion-gallery-catalog';
import { ZUNDAMON_PORTRAIT } from '../live2d/zundamon-model-manifest';
import './motion-gallery.css';

export type MotionGalleryProps = {
  manifest: AvatarModelManifest;
  onBack: () => void;
  loadRenderer?: AvatarStageProps['loadRenderer'];
  capability?: AvatarStageProps['capability'];
};
const categories = [{ id:'motion', label:'動き' }, { id:'expression', label:'表情' }, { id:'pose', label:'ポーズ' }] as const;
type Category = typeof categories[number]['id'];
const label = (id?: string) => MOTION_GALLERY.find(item => item.id === id)?.label ?? '指定なし';

export function MotionGallery({ manifest, onBack, loadRenderer, capability }: MotionGalleryProps) {
  const galleryManifest = useMemo(() => ({ ...manifest, assets: [...manifest.assets.filter(asset => asset.path !== MOTION_GALLERY_ASSET.path), MOTION_GALLERY_ASSET] }), [manifest]);
  const [category, setCategory] = useState<Category>('motion');
  const [selection, setSelection] = useState<AvatarPreview>({ requestId:0, loop:false });
  const [selectedMotion, setSelectedMotion] = useState<string>();
  const [state, setState] = useState<'static'|'loading'|'ready'|'failed'>('static');
  const [attempt, setAttempt] = useState(0);
  const ready = state === 'ready';
  const playing = Boolean(selection.motion);
  const stop = () => setSelection(value => ({ ...value, motion:undefined, requestId:value.requestId+1 }));
  const play = (id: string) => {
    setSelectedMotion(id);
    setSelection(value => ({ ...value, motion:id, requestId:value.requestId+1 }));
  };
  const reset = () => {
    setSelectedMotion(undefined);
    setSelection(value => ({requestId:value.requestId+1, loop:value.loop}));
  };
  const active = category === 'motion' ? selectedMotion : selection[category];
  const items = MOTION_GALLERY.filter(item => item.kind === category);
  // Separate from the conversation's CSS and renderer; returning releases this model.
  return createPortal(<MenuPage title="Live2Dのモーション" backLabel="キャラクターへ戻る" onBack={onBack} contentClassName="motion-gallery-content">
    <div className="motion-gallery">
      <div className="motion-gallery-preview">
        <div className="motion-gallery-stage">
          <AvatarStage key={attempt} enabled manifest={galleryManifest} fallback={ZUNDAMON_PORTRAIT}
            preview={selection} onPreviewFinished={stop} onStateChange={setState}
            loadRenderer={loadRenderer} capability={capability} />
          {!ready ? <div className="motion-gallery-status" role="status">
            {state === 'failed' ? <>動きを読み込めませんでした。<button type="button" onClick={() => { reset(); setAttempt(value=>value+1); }}>再読み込み</button></> : state === 'loading' ? 'ずんだもんを準備中…' : '動きを表示できない場合は、端末の「動きを減らす」設定やブラウザの対応をご確認ください。'}
          </div> : null}
        </div>
        <div className="motion-gallery-player">
          <p aria-live="polite">{playing ? `再生中：${label(selection.motion)}` : selectedMotion ? `停止中：${label(selectedMotion)}` : '見たい動きを選んでね'}</p>
          <div className="motion-gallery-controls">
            <button type="button" disabled={!ready || !selectedMotion} onClick={() => playing ? stop() : selectedMotion && play(selectedMotion)}>
              {playing ? <Stop size={20} /> : <Play size={20} />}{playing ? '停止' : '再生'}
            </button>
            <label><input type="checkbox" checked={selection.loop} onChange={event=>setSelection(value=>({...value,loop:event.target.checked}))} />繰り返し</label>
            <button type="button" disabled={!ready} onClick={reset}><ArrowCounterClockwise size={20} />リセット</button>
          </div>
        </div>
      </div>
      <div className="motion-gallery-picker">
        <div className="motion-gallery-tabs" role="group" aria-label="見本の種類">
          {categories.map(item=><button type="button" key={item.id} aria-pressed={category===item.id} onClick={()=>setCategory(item.id)}>{item.label}<small>{MOTION_GALLERY.filter(entry=>entry.kind===item.id).length}</small></button>)}
        </div>
        <div className="motion-gallery-options" role="group" aria-label={`${categories.find(item=>item.id===category)?.label}の一覧`}>
          {category !== 'motion' ? <button type="button" disabled={!ready} aria-pressed={!active} onClick={()=>setSelection(value=>({...value,[category]:undefined}))}>指定なし</button> : null}
          {items.map(item=><button type="button" key={item.id} disabled={!ready} aria-pressed={active===item.id}
            onClick={()=>category==='motion'?play(item.id):setSelection(value=>({...value,[category]:item.id}))}>
            <span>{item.label}</span>{'duration' in item ? <small>{item.duration.toFixed(1)}秒</small> : null}
          </button>)}
        </div>
        <p className="motion-gallery-note">表情：{label(selection.expression)} ／ ポーズ：{label(selection.pose)}</p>
        <p className="motion-gallery-note">表情やポーズを指定すると、動きと組み合わせて試せます。元の動きは「指定なし」で確認できます。ここでの選択はトークには反映されません。</p>
      </div>
    </div>
  </MenuPage>, document.body);
}
