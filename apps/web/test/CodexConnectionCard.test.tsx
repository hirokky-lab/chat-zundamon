import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodexConnectionCard } from '../src/components/CodexConnectionCard';
import type { CodexApi } from '../src/codex';
describe('Codex in AI connections',()=>{
 it('shows verified connection and refreshes from Codex',async()=>{
  const status=vi.fn().mockResolvedValueOnce({enabled:true,connected:true,projectCount:21,model:'test-model'}).mockResolvedValueOnce({enabled:true,connected:false,message:'Codexにログインしてください。'});
  render(<CodexConnectionCard api={{status} as unknown as CodexApi}/>);
  expect(await screen.findByText('接続済み')).toBeVisible();expect(screen.getByText(/登録プロジェクト：21件/)).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'Codexの接続を確認'}));
  await waitFor(()=>expect(screen.getByText('接続できません')).toBeVisible());expect(screen.getByRole('status')).toHaveTextContent('ログイン');
 });
});
