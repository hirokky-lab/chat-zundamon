import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createZundamonModelManifest } from '../src/live2d/zundamon-model-manifest';
import { App } from '../src/App';
import { EMPTY_LOCAL_CHAT } from '../src/local-state';
import type { CharacterPreference } from '../src/vrm/vrm-preference';

it('does not render the default character while server selection is unresolved', async () => {
  let resolve!: (value: CharacterPreference) => void;
  const pending = new Promise<CharacterPreference>(done => { resolve = done; });
  const load = vi.fn(() => pending);
  const now = new Date().toISOString();
  const profile = { displayName: '確認用', addressingStyle: 'san' as const, updatedAt: now };
  const view = render(<App wallpaperScope={crypto.randomUUID()} integratedUiEnabled splashDurationMs={0}
    characterCloud={{ check: async () => {}, load, save: async value => value }}
    chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => {} }}
    profileApi={{ get: async () => profile, save: async () => profile }}
    chatApi={{ respond: async () => ({ bubbles: ['こんにちはなのだ。'] }) }} />);
  await waitFor(() => expect(load).toHaveBeenCalled());
  await screen.findByText('キャラクターを読み込み中…');
  expect(view.container.querySelector('.talk-avatar img')).toBeNull();
  await act(async () => resolve({ mode: 'live2d', storage: 'server' }));
  await waitFor(() => expect(view.container.querySelector('.talk-avatar img')).not.toBeNull());
  view.unmount();
});

it('keeps the character and talk controls when the selected renderer fails', async () => {
  const now = new Date().toISOString();
  const profile = { displayName: '確認用', addressingStyle: 'san' as const, updatedAt: now };
  const loader = vi.fn(async () => { throw new Error('private renderer failure'); });
  render(<App wallpaperScope={crypto.randomUUID()} integratedUiEnabled splashDurationMs={0}
    live2dAvatarEnabled live2dModel={createZundamonModelManifest('a'.repeat(64))}
    live2dCapability={{ mode: 'animate' }} live2dRendererLoader={loader}
    chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => {} }}
    profileApi={{ get: async () => profile, save: async () => profile }}
    chatApi={{ respond: async () => ({ bubbles: [] }) }} />);
  await screen.findByText('静止画で表示しています');
  expect(loader).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('ずんだもんの姿')).toContainElement(screen.getByRole('img', { name: 'ずんだもん' }));
  expect(screen.getByRole('button', { name: 'トークを開く' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'メッセージ' })).toBeEnabled();
  expect(screen.queryByText('private renderer failure')).not.toBeInTheDocument();
});
