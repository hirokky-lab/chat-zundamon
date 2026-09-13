import {describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {AIConnection} from '../src/screens/AIConnection';
import type {AIConnectionApi} from '../src/ai-connection';
const status={configured:true,source:'server' as const,checkedAt:null,model:'test'};
function api():AIConnectionApi{return {status:vi.fn(async()=>status),save:vi.fn(async()=>status),test:vi.fn(async()=>status),remove:vi.fn(async()=>({...status,configured:false,source:'none' as const}))};}
describe('AI setup',()=>{
 it('masks replacement input, clears it after success, and confirms removal',async()=>{
  const service=api();const view=render(<AIConnection api={service} onClose={()=>{}}/>);
  await screen.findByText('登録済み');const input=screen.getByLabelText('新しいAPIキー');expect(input.getAttribute('type')).toBe('password');
  fireEvent.change(input,{target:{value:'sk-example'}});fireEvent.click(screen.getByRole('button',{name:'確認して保存する'}));
  await screen.findByText('接続を確認して保存しました。');expect((input as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button',{name:'接続を解除',exact:true}));expect(service.remove).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'接続を解除する'}));await screen.findByText('AIの接続を解除しました。');view.unmount();
 });
 it('keeps the registered state after a rejected replacement',async()=>{
  const service=api();service.save=vi.fn(async()=>{throw Error('接続できません');});const view=render(<AIConnection api={service} onClose={()=>{}}/>);
  await screen.findByText('登録済み');fireEvent.change(screen.getByLabelText('新しいAPIキー'),{target:{value:'bad'}});fireEvent.click(screen.getByRole('button',{name:'確認して保存する'}));await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('接続できません'));expect(screen.getByText('登録済み')).toBeTruthy();view.unmount();
 });
});
