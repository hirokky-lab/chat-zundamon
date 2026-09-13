import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, it, vi} from 'vitest';
import {BgmHeader} from '../src/bgm/BgmHeader';
import {DEFAULT_BGM} from '../src/bgm/player';
import type {BgmController} from '../src/bgm/use-bgm';
function controller(patch: Partial<BgmController> = {}): BgmController {
  return {settings:DEFAULT_BGM, status:'off', error:undefined, update:vi.fn(), retry:vi.fn(), pause:vi.fn(), ...patch};
}
it('opens without playing, closes with Escape and restores focus; outside interactions dismiss it', async () => {
  const user=userEvent.setup(), c=controller();
  render(<><BgmHeader controller={c}/><button>別の操作</button></>);
  const trigger=screen.getByRole('button',{name:'BGMを操作'});
  await user.click(trigger);
  expect(screen.getByRole('dialog',{name:'BGMプレーヤー'})).toBeVisible();
  expect(c.update).not.toHaveBeenCalled();expect(c.retry).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');expect(screen.queryByRole('dialog')).toBeNull();expect(trigger).toHaveFocus();
  await user.click(trigger);await user.click(screen.getByText('別の操作'));
  expect(screen.queryByRole('dialog')).toBeNull();expect(c.update).not.toHaveBeenCalled();
});
it('uses the shared controller for playback and track selection; closing does not stop music',async()=>{
  const user=userEvent.setup(), c=controller();
  const view=render(<BgmHeader controller={c}/>);
  await user.click(screen.getByRole('button',{name:'BGMを操作'}));
  await user.click(screen.getByRole('button',{name:'BGMを再生'}));expect(c.update).toHaveBeenLastCalledWith({enabled:true});
  view.rerender(<BgmHeader controller={{...c,settings:{...DEFAULT_BGM,enabled:true},status:'playing'}}/>);
  await user.selectOptions(screen.getByRole('combobox',{name:'BGMの曲'}),'kaeru');expect(c.update).toHaveBeenLastCalledWith({track:'kaeru'});
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'BGMを停止'}));expect(c.update).toHaveBeenLastCalledWith({enabled:false});
  c.update=vi.fn();view.rerender(<BgmHeader controller={c}/>);
  await user.click(screen.getByRole('button',{name:'BGMプレーヤーを閉じる'}));expect(c.update).not.toHaveBeenCalled();expect(c.pause).not.toHaveBeenCalled();
});
it('offers retry for a saved enabled track that has not started or failed',async()=>{
  const user=userEvent.setup(), c=controller({settings:{...DEFAULT_BGM,enabled:true},status:'error',error:'音源を読み込めませんでした。'});
  render(<BgmHeader controller={c}/>);await user.click(screen.getByRole('button',{name:'BGMを操作'}));
  expect(screen.getByRole('status')).toHaveTextContent('音源を読み込めませんでした。');
  await user.click(screen.getByRole('button',{name:'BGMを再生'}));expect(c.retry).toHaveBeenCalledOnce();
});
