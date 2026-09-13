import {render,screen,fireEvent} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {MenuHomeContext,MenuPage} from '../src/components/MenuPage';
import {AppMenu} from '../src/screens/AppMenu';
it('uses the common back action and blocks it while saving',()=>{
 const back=vi.fn();const {rerender}=render(<MenuPage title="設定" onBack={back}>内容</MenuPage>);
 expect(screen.getByRole('heading',{name:'設定'})).toHaveFocus();
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(back).toHaveBeenCalledTimes(1);
 rerender(<MenuPage title="設定" busy onBack={back}>内容</MenuPage>);
 fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(back).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('button',{name:'メニューへ戻る'})).toBeDisabled();
});
it('credits stays inside the common shell and returns to the menu',()=>{
 const close=vi.fn();render(<AppMenu onClose={close} onOpenSettings={vi.fn()} onOpenConnections={vi.fn()} onOpenHomeEdit={vi.fn()} />);
 fireEvent.click(screen.getByRole('button',{name:'クレジット'}));
 expect(screen.getByRole('dialog',{name:'クレジット'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'メニューへ戻る'}));
 expect(screen.getByRole('dialog',{name:'メニュー'})).toBeVisible();expect(close).not.toHaveBeenCalled();
});

it('separates back navigation from closing to home and disables both while saving',()=>{
 const back=vi.fn(),home=vi.fn();
 const page=(busy=false)=><MenuHomeContext.Provider value={home}><MenuPage title="メモリ" onBack={back} busy={busy}>内容</MenuPage></MenuHomeContext.Provider>;
 const {rerender}=render(page());
 fireEvent.click(screen.getByRole('button',{name:'メニューへ戻る'}));
 expect(back).toHaveBeenCalledOnce();expect(home).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'閉じてホームへ戻る'}));
 expect(home).toHaveBeenCalledOnce();
 rerender(page(true));
 expect(screen.getByRole('button',{name:'閉じてホームへ戻る'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'メニューへ戻る'})).toBeDisabled();
});
