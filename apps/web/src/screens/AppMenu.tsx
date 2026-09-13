import {BgmBalanceSettings} from '../bgm/BgmBalanceSettings';
import type {BgmController} from '../bgm/use-bgm';
import {BGM_TRACKS} from '../bgm/player';
import type { CharacterController } from '../vrm/vrm-preference';
import { MenuPage } from '../components/MenuPage';
import { CaretRight } from "@phosphor-icons/react";
import { lazy, Suspense, useState, type ReactElement } from "react";
import type { MotionGalleryProps } from './MotionGallery';
const LazyMotionGallery = lazy(() => import('./MotionGallery').then(module => ({default:module.MotionGallery})));

const LazyCharacterSettings = lazy(() => import('../vrm/CharacterSettings').then(module => ({default:module.CharacterSettings})));

const LazyVrmModelSettings = lazy(() => import('../vrm/VrmModelSettings').then(module => ({default:module.VrmModelSettings})));

type AppMenuProps = {
  bgm?: BgmController;
  characterController?: CharacterController;
  motionGallery?: Omit<MotionGalleryProps, 'onBack'>;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenConnections: () => void;
  onOpenHomeEdit: () => void;
  onOpenVoiceSettings?:()=>void;
  onOpenAISettings?:()=>void;
  onOpenLocation?: () => void;
  personalMenu?: {memory:()=>void;style:()=>void;about:()=>void;signOut?:()=>void};
};

export function AppMenu({ bgm, characterController, motionGallery, onClose, onOpenSettings, onOpenConnections, onOpenHomeEdit, onOpenLocation, onOpenAISettings, onOpenVoiceSettings, personalMenu }: AppMenuProps): ReactElement {
  const [page, setPage] = useState<"menu" | "credits" | "motions" | "character" | "vrm" | "sound">("menu");
  const items = [
    ...(personalMenu ? [{label:"プロフィール",onClick:personalMenu.memory}] : [{ label: "アプリ設定", onClick: onOpenSettings }]),
    ...(personalMenu ? [{label:"壁紙",onClick:personalMenu.style}] : []),
    ...(characterController ? [{label:'キャラクター',onClick:()=>setPage('character')}] : []),

    ...(bgm ? [{label:"BGM音量バランス",onClick:()=>setPage("sound")}] : []),
    ...(onOpenVoiceSettings?[{label:"声の設定",onClick:onOpenVoiceSettings}]:[]),
    ...(onOpenAISettings?[{label:"AI接続",onClick:onOpenAISettings}]:[]),
    { label: onOpenLocation ? "Google連携" : "接続サービス", onClick: onOpenConnections },
    ...(!personalMenu && onOpenLocation ? [{ label: "自宅・地域", onClick: onOpenLocation }] : []),
  ] as const;

  if (page === 'sound' && bgm) return <BgmBalanceSettings controller={bgm} onBack={()=>setPage('menu')} />;
  if (page === 'character' && characterController) return <Suspense fallback={<MenuPage title="キャラクター" onBack={()=>setPage('menu')}><p role="status">読み込み中…</p></MenuPage>}><LazyCharacterSettings controller={characterController} onBack={()=>setPage('menu')} onOpenVrm={()=>setPage('vrm')} onOpenMotions={motionGallery ? ()=>setPage('motions') : undefined} /></Suspense>;
  if (page === 'vrm' && characterController) return <Suspense fallback={<MenuPage title="VRMモデルの追加・管理" backLabel="キャラクターへ戻る" onBack={()=>setPage('character')}><p role="status">読み込み中…</p></MenuPage>}><LazyVrmModelSettings controller={characterController} onBack={()=>setPage('character')} /></Suspense>;
  if (page === 'motions' && motionGallery) return <Suspense fallback={<MenuPage title="Live2Dのモーション" backLabel="キャラクターへ戻る" onBack={()=>setPage('character')}><p role="status">読み込み中…</p></MenuPage>}><LazyMotionGallery {...motionGallery} onBack={()=>setPage('character')} /></Suspense>;
  return <MenuPage hideBack={page === "menu"} title={page === "credits" ? "クレジット" : "メニュー"} backLabel={page === "credits" ? "メニューへ戻る" : "トークへ戻る"} onBack={page === "credits" ? () => setPage("menu") : onClose}>
      {page === "menu" ? <ul className="app-menu-list">
        {items.map((item) => <li key={item.label}><button type="button" onClick={item.onClick}><strong>{item.label}</strong><CaretRight aria-hidden="true" size={20} /></button></li>)}
        <li><button type="button" onClick={() => setPage("credits")}><strong>クレジット</strong><CaretRight aria-hidden="true" size={20} /></button></li>
        {personalMenu?.signOut ? <li><button type="button" onClick={personalMenu.signOut}><strong>ログアウト</strong><CaretRight aria-hidden="true" size={20} /></button></li> : null}
      </ul> : <div className="credits-page"><dl>
        <dt>キャラクター</dt><dd>東北ずん子・ずんだもんプロジェクト</dd>
        <dt>イラスト</dt><dd>坂本アヒル</dd>
        <dt>Live2Dモデリング</dt><dd>Live2D Inc.</dd>
        <dt>BGM · DOVA-SYNDROME</dt><dd>{BGM_TRACKS.map(track => <div key={track.id}><a href={track.url} target="_blank" rel="noreferrer">{track.title}（{track.author}）</a></div>)}</dd>
        <dt>使用技術</dt><dd>Live2D Cubism SDK / Three.js / @pixiv/three-vrm</dd>
      </dl></div>}

  </MenuPage>;
}
