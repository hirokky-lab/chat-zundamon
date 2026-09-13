import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CodexConfirmation } from '../src/components/CodexConfirmation';
import type { CodexPendingRequest } from '@yui/domain';
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};});
const request:CodexPendingRequest={id:'q1',kind:'questions',title:'Codexからの質問',details:'対象を確認します',choices:[{id:'send',label:'回答を送る'}],questions:[{id:'target',question:'対象はどれですか？',options:['A','B'],required:true}]};
describe('Codex confirmation',()=>{
 it('does not answer automatically and submits the chosen answer',async()=>{
  const onAnswer=vi.fn(async()=>{});render(<CodexConfirmation request={request} onAnswer={onAnswer} onClose={()=>{}}/>);
  expect(onAnswer).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'回答を送る'})).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'B',exact:true}));fireEvent.click(screen.getByRole('button',{name:'回答を送る'}));
  await waitFor(()=>expect(onAnswer).toHaveBeenCalledWith({choice:'send',answers:{target:'B'}}));
 });
 it('retains an answer after a connection failure for retry',async()=>{
  const onAnswer=vi.fn().mockRejectedValueOnce(Error('接続が切れました')).mockResolvedValue(undefined);
  render(<CodexConfirmation request={request} onAnswer={onAnswer} onClose={()=>{}}/>);
  fireEvent.change(screen.getByRole('textbox',{name:'対象はどれですか？'}),{target:{value:'自由入力'}});
  fireEvent.click(screen.getByRole('button',{name:'回答を送る'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('接続が切れました');
  expect(screen.getByRole('textbox')).toHaveValue('自由入力');
 });
});
