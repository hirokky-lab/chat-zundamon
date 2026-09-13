import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {it,expect,vi} from 'vitest';
import {GoogleConnections} from '../src/screens/GoogleConnections';
function setup(state='disconnected',url='https://accounts.google.com/o/oauth2/v2/auth?state=fixture'){
 const api={getSettings:vi.fn().mockResolvedValue({calendar:{state}}),beginConnection:vi.fn().mockResolvedValue(url),stopService:vi.fn().mockResolvedValue(undefined)};
 const navigate=vi.fn();render(<GoogleConnections api={api as any} onClose={()=>{}} navigate={navigate}/>);return{api,navigate};
}
it('opens Google from the application without a calendar selection step',async()=>{const{api,navigate}=setup();await screen.findByText('未接続');await userEvent.click(screen.getByRole('button',{name:'Googleカレンダーを接続'}));expect(api.beginConnection).toHaveBeenCalledWith('calendar');expect(navigate).toHaveBeenCalledWith(expect.stringContaining('https://accounts.google.com/'));expect(screen.queryByText('Google Tasks')).not.toBeInTheDocument();});
it('does not pretend the service is available before configuration',async()=>{const{api}=setup('disabled');await screen.findByText('利用準備中');expect(screen.getByRole('button',{name:'Googleカレンダーを接続'})).toBeDisabled();expect(api.beginConnection).not.toHaveBeenCalled();});
it('rejects an unexpected authorization destination',async()=>{const{navigate}=setup('disconnected','https://example.org/');await screen.findByText('未接続');await userEvent.click(screen.getByRole('button',{name:'Googleカレンダーを接続'}));expect(await screen.findByRole('alert')).toBeVisible();expect(navigate).not.toHaveBeenCalled();});
it('does not disconnect until the action is confirmed',async()=>{const{api}=setup('connected');await screen.findByText('接続済み');await userEvent.click(screen.getByRole('button',{name:'接続を解除',exact:true}));expect(api.stopService).not.toHaveBeenCalled();await userEvent.click(screen.getByRole('button',{name:'キャンセル'}));expect(api.stopService).not.toHaveBeenCalled();});
it('requests editing permission separately from the existing connection',async()=>{
 const {api}=setup('connected');
 await screen.findByText('接続済み');
 await userEvent.click(screen.getByRole('button',{name:'予定の追加・変更・削除を有効にする'}));
 expect(api.beginConnection).toHaveBeenCalledWith('calendar','write');
});
