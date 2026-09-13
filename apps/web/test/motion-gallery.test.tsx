import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MotionGallery } from '../src/screens/MotionGallery';
import { MenuHomeContext } from '../src/components/MenuPage';
import { AppMenu } from '../src/screens/AppMenu';
import { createZundamonModelManifest } from '../src/live2d/zundamon-model-manifest';
import { MOTION_GALLERY, MOTION_GALLERY_ASSET } from '../src/live2d/motion-gallery-catalog';
import type { AvatarStageProps } from '../src/live2d/AvatarStage';

let latest: AvatarStageProps;
vi.mock('../src/live2d/AvatarStage', () => ({ AvatarStage: (props: AvatarStageProps) => {
  latest=props;
  useEffect(()=>props.onStateChange?.('ready'),[props.onStateChange]);
  return <div aria-label="モデル表示"><button onClick={()=>props.onPreviewFinished?.()}>再生完了の通知</button></div>;
} }));
const manifest=createZundamonModelManifest('a'.repeat(64))!;

describe('motion gallery',()=>{
 it('replays selections, stops from real completion, combines expressions and poses, and resets without modifying the conversation manifest',async()=>{
  render(<MotionGallery manifest={manifest} onBack={()=>{}} />);
  const user=userEvent.setup();
  await user.click(screen.getByRole('button',{name:/^うなずく/}));
  expect(latest.preview?.motion).toBe('mtnBody_yes');
  const request=latest.preview!.requestId;
  await user.click(screen.getByRole('button',{name:/^うなずく/}));
  expect(latest.preview!.requestId).toBeGreaterThan(request);
  await user.click(screen.getByRole('checkbox',{name:'繰り返し'}));
  expect(latest.preview?.loop).toBe(true);
  await user.click(screen.getByRole('button',{name:'停止',exact:true}));
  expect(latest.preview?.motion).toBeUndefined();
  await user.click(screen.getByRole('button',{name:'再生',exact:true}));
  expect(latest.preview?.motion).toBe('mtnBody_yes');
  await user.click(screen.getByRole('button',{name:'再生完了の通知'}));
  expect(latest.preview?.motion).toBeUndefined();
  await user.click(screen.getByRole('button',{name:/^表情/}));
  await user.click(screen.getByRole('button',{name:'にっこり',exact:true}));
  await user.click(screen.getByRole('button',{name:/^ポーズ/}));
  await user.click(screen.getByRole('button',{name:'両手を上げる',exact:true}));
  expect(latest.preview).toMatchObject({expression:'exp_smile',pose:'pose_Upper'});
  await user.click(screen.getByRole('button',{name:'指定なし',exact:true}));
  expect(latest.preview?.pose).toBeUndefined();
  expect(latest.preview?.expression).toBe('exp_smile');
  await user.click(screen.getByRole('button',{name:'リセット'}));
  expect(latest.preview).toEqual({requestId:expect.any(Number),loop:true});
  expect(latest.manifest!.assets).toContainEqual(MOTION_GALLERY_ASSET);
  expect(manifest.assets).toContainEqual(MOTION_GALLERY_ASSET);
  expect(latest.manifest!.assets.filter(asset => asset.path === MOTION_GALLERY_ASSET.path)).toHaveLength(1);
  expect(new Set(MOTION_GALLERY.map(x=>x.id)).size).toBe(55);
 });
 it('opens inside Character and returns there before the menu',async()=>{
  const close=vi.fn();
  render(<AppMenu characterController={{preference:{mode:"live2d"},ready:true,saving:false,error:null,serverReady:false,serverConfigured:false,save:vi.fn(),reloadServer:vi.fn()} as any} motionGallery={{manifest}} onClose={close} onOpenSettings={()=>{}} onOpenConnections={()=>{}} onOpenHomeEdit={()=>{}} />);
  const user=userEvent.setup();
  expect(screen.queryByRole('button',{name:'Live2Dのモーション'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'キャラクター'}));
  await user.click(await screen.findByRole('button',{name:/Live2Dのモーション/}));
  await screen.findByRole('heading',{name:'Live2Dのモーション'});
  await user.click(await screen.findByRole('button',{name:'キャラクターへ戻る'}));
  await screen.findByRole('heading',{name:'キャラクター'});
  await user.click(screen.getByRole('button',{name:'メニューへ戻る'}));
  await waitFor(()=>expect(screen.getByRole('heading',{name:'メニュー'})).toBeVisible());
  expect(close).not.toHaveBeenCalled();
 });
});

it('opens VRM management on its own page, returns to Character, and closes home without saving',async()=>{
 const close=vi.fn(),save=vi.fn();
 const controller={preference:{mode:"live2d"},ready:true,saving:false,error:null,serverReady:false,serverConfigured:false,save,reloadServer:vi.fn()} as any;
 render(<MenuHomeContext.Provider value={close}><AppMenu characterController={controller} onClose={close} onOpenSettings={()=>{}} onOpenConnections={()=>{}} onOpenHomeEdit={()=>{}}/></MenuHomeContext.Provider>);
 const user=userEvent.setup();
 await user.click(screen.getByRole('button',{name:'キャラクター'}));
 const open=await screen.findByRole('button',{name:/VRMモデルの追加・管理/});
 expect(open).not.toHaveAttribute('aria-expanded');
 expect(screen.queryByRole('button',{name:'VRMファイルを選ぶ'})).not.toBeInTheDocument();
 await user.click(open);
 await screen.findByRole('button',{name:'VRMファイルを選ぶ'});
 expect(screen.getByRole('heading',{level:1,name:'VRMモデルの追加・管理'})).toBeVisible();
 expect(screen.queryByRole('group',{name:'表示するキャラクター'})).not.toBeInTheDocument();
 await user.click(screen.getByRole('button',{name:'キャラクターへ戻る'}));
 await screen.findByRole('heading',{level:1,name:'キャラクター'});
 await user.click(screen.getByRole('button',{name:/VRMモデルの追加・管理/}));
 await screen.findByRole('button',{name:'VRMファイルを選ぶ'});
 await user.click(screen.getByRole('button',{name:'閉じてホームへ戻る'}));
 expect(close).toHaveBeenCalledOnce();expect(save).not.toHaveBeenCalled();
});
