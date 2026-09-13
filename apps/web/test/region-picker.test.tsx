import {render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {it,expect,vi} from 'vitest';
import {LifeSettings} from '../src/screens/LifeSettings';
it('only saves the selected region with its coordinates and preserves other settings',async()=>{
 const home={label:'東京都 立川市',query:'東京都 立川市',latitude:37.45,longitude:138.85,timezone:'Asia/Tokyo',precision:'locality' as const};
 const settings={revision:4,home:null,calendar:null,tasks:null};
 const api={getSettings:vi.fn().mockResolvedValue(settings),locations:vi.fn().mockResolvedValue({candidates:[home],attribution:'GeoNames'}),saveSettings:vi.fn().mockResolvedValue({...settings,home,revision:5})};
 const close=vi.fn();const google={getSettings:vi.fn()};const user=userEvent.setup();
 render(<LifeSettings api={api as any} googleApi={google as any} initialSection="home" onClose={close}/>);
 await user.type(await screen.findByRole('textbox',{name:'地域名'}),'立川');await user.click(screen.getByRole('button',{name:'検索',exact:true}));
 await screen.findByRole('button',{name:'東京都 立川市 を選ぶ'});expect(api.saveSettings).not.toHaveBeenCalled();
 await user.click(screen.getByRole('button',{name:'東京都 立川市 を選ぶ'}));await waitFor(()=>expect(close).toHaveBeenCalled());
 expect(api.saveSettings).toHaveBeenCalledWith({...settings,home});expect(google.getSettings).not.toHaveBeenCalled();
});
