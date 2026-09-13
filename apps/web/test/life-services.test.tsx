import {render,screen,waitFor,fireEvent} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,it,expect,vi} from 'vitest';
import {parseLifeCard,parseLocalChatSnapshot,type LifeCard,type GoogleAssistantOperation} from '@yui/domain';
import {createChatApi} from '../src/api';
import {LifeCardView,lifeLocalDateTime} from '../src/LifeCard';
import {LifeSettings} from '../src/screens/LifeSettings';
import type {LifeServicesApi} from '../src/life-services';
import type {GoogleCalendarTasksApi} from '../src/google-calendar-tasks';
const card:LifeCard={kind:'maps',origin:null,destination:'東京駅 & a=1',travelMode:'transit'};
const timestamp='2026-09-05T01:00:00.000Z';
describe('life cards',()=>{
 it('retains external cards across HTTP and snapshot reload while rejecting invalid authority shapes',async()=>{
 const reply={replyGroupId:'a:assistant',bubbles:[{id:'a:assistant:0',sequence:0,text:'道順です',createdAt:timestamp,flow:'external_context'}],lifeCard:card};
 expect((await createChatApi(async()=>Response.json({reply})).respond({kind:'reply',clientMessageId:'a',timeline:[]})).lifeCard).toEqual(card);
 const message={id:'a:assistant:0',replyGroupId:'a:assistant',sequence:0,type:'message',role:'assistant',text:'道順です',createdAt:timestamp,delivery:'sent',flow:'external_context',lifeCard:card};
 const snapshot={timeline:[message],draft:'',pendingDisplayName:null,lastOpeningAt:null,lastConversationAt:null};
 expect(parseLocalChatSnapshot(JSON.parse(JSON.stringify(snapshot)))?.timeline[0]).toEqual(message);
 expect(parseLocalChatSnapshot({...snapshot,timeline:[{...message,role:'user'}]})).toBeNull();
 expect(parseLocalChatSnapshot({...snapshot,timeline:[{...message,flow:'conversation'}]})).toBeNull();
 expect(parseLifeCard({...card,url:'https://evil.example'})).toBeNull();
 expect(parseLifeCard({...card,destination:'x'.repeat(201)})).toBeNull();
 });
 it('encodes the destination and only links to fixed Google Maps host',()=>{render(<LifeCardView card={card} api={{} as LifeServicesApi}/>);const link=screen.getByRole('link');const url=new URL(link.getAttribute('href')!);expect(url.hostname).toBe('www.google.com');expect(url.searchParams.get('destination')).toBe(card.destination);expect(url.searchParams.has('origin')).toBe(false);});
 it('refreshes restored operations and prevents confirming expired server state',async()=>{const op:GoogleAssistantOperation={operationId:'op',signature:'sig',keyVersion:'v1',expiresAt:'2099-01-01T00:00:00Z',state:'prepared',request:{service:'tasks',sourceId:'s',action:'create',changes:{title:'買い物'}},before:null};const api={operation:vi.fn().mockResolvedValue({...op,state:'expired'}),confirm:vi.fn()} as unknown as LifeServicesApi;render(<LifeCardView card={{kind:'google-operation',operation:op}} api={api}/>);await screen.findByText('確認期限が切れました');expect(screen.queryByRole('button',{name:'この内容で追加'})).toBeNull();expect(api.confirm).not.toHaveBeenCalled();});
 it('loads home settings independently and saves only after explicit candidate choice',async()=>{const home={label:'架空地域',query:'架空',latitude:35,longitude:139,timezone:'Asia/Tokyo',precision:'locality' as const};const settings={revision:2,home:null,calendar:null,tasks:null};const api={getSettings:vi.fn().mockResolvedValue(settings),locations:vi.fn().mockResolvedValue({candidates:[home],attribution:'fixture'}),saveSettings:vi.fn().mockResolvedValue({...settings,revision:3,home})} as unknown as LifeServicesApi;const google={getSettings:vi.fn().mockRejectedValue(new Error('offline'))} as unknown as GoogleCalendarTasksApi;render(<LifeSettings api={api} googleApi={google} onClose={()=>{}} initialSection="home"/>);const user=userEvent.setup();await user.type(await screen.findByRole('textbox',{name:'地域名'}),'架空');await user.click(screen.getByRole('button',{name:'検索'}));await screen.findByRole('button',{name:'架空地域 を選ぶ'});expect(api.saveSettings).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'架空地域 を選ぶ'}));await waitFor(()=>expect(api.saveSettings).toHaveBeenCalledWith({...settings,home}));});
});

it('persists paged results and a prepared calendar edit with local datetime fields',async()=>{
 const item={service:'calendar' as const,sourceId:'private-source-id',id:'item',version:'v1',title:'打合せ',start:'2026-09-06T06:00:00Z',end:'2026-09-06T07:00:00Z'};
 const result={service:'calendar' as const,sourceId:item.sourceId,fetchedAt:timestamp,timeMin:'2026-09-06T00:00:00Z',timeMax:'2026-09-07T00:00:00Z',items:[item],nextPageToken:'page2'};
 const operation:GoogleAssistantOperation={operationId:'op',signature:'sig',keyVersion:'v1',expiresAt:'2099-01-01T00:00:00Z',state:'prepared',request:{service:'calendar',sourceId:item.sourceId,itemId:item.id,version:item.version,action:'update',changes:{title:item.title,start:item.start,end:item.end}},before:item};
 const api={list:vi.fn().mockResolvedValue({...result,nextPageToken:undefined}),prepare:vi.fn().mockResolvedValue(operation)} as unknown as LifeServicesApi;
 const onCardChange=vi.fn();render(<LifeCardView card={{kind:'google-items',sourceTitle:'仕事',result}} api={api} onCardChange={onCardChange}/>);const user=userEvent.setup();
 await user.click(screen.getByRole('button',{name:'次の項目'}));expect(api.list).toHaveBeenCalledWith({service:'calendar',sourceId:item.sourceId,timeMin:result.timeMin,timeMax:result.timeMax,pageToken:'page2'});expect(onCardChange).toHaveBeenCalledOnce();
 await user.click(screen.getByRole('button',{name:'変更の下書き'}));const start=screen.getByLabelText('開始');expect(start).toHaveAttribute('type','datetime-local');expect(start).toHaveValue(lifeLocalDateTime(item.start));fireEvent.change(start,{target:{value:'2026-09-06T16:00'}});fireEvent.change(screen.getByLabelText('終了'),{target:{value:'2026-09-06T17:00'}});
 await user.click(screen.getByRole('button',{name:'変更内容を確認'}));expect(api.prepare).toHaveBeenCalledWith(expect.objectContaining({changes:expect.objectContaining({start:new Date('2026-09-06T16:00').toISOString(),end:new Date('2026-09-06T17:00').toISOString()})}));expect(onCardChange).toHaveBeenLastCalledWith({kind:'google-operation',operation});expect(screen.queryByText(/private-source-id/)).toBeNull();
});
it('does not recheck or persist an identical operation on rerender',async()=>{
 const operation:GoogleAssistantOperation={operationId:'op',signature:'sig',keyVersion:'v1',expiresAt:'2099-01-01T00:00:00Z',state:'prepared',request:{service:'tasks',sourceId:'source',action:'create',changes:{title:'買い物'}},before:null};
 const api={operation:vi.fn().mockResolvedValue(operation)} as unknown as LifeServicesApi;const onCardChange=vi.fn();const {rerender}=render(<LifeCardView card={{kind:'google-operation',operation}} api={api} onCardChange={onCardChange}/>);await waitFor(()=>expect(screen.getByRole('button',{name:'この内容で追加'})).toBeEnabled());rerender(<LifeCardView card={JSON.parse(JSON.stringify({kind:'google-operation',operation}))} api={api} onCardChange={onCardChange}/>);expect(api.operation).toHaveBeenCalledOnce();expect(onCardChange).not.toHaveBeenCalled();
});
it('retries persistence after an operation status save failure before allowing confirmation',async()=>{
 const operation:GoogleAssistantOperation={operationId:'op',signature:'sig',keyVersion:'v1',expiresAt:'2099-01-01T00:00:00Z',state:'prepared',request:{service:'tasks',sourceId:'source',action:'create',changes:{title:'買い物'}},before:null};
 const api={operation:vi.fn().mockResolvedValue(operation)} as unknown as LifeServicesApi;const onCardChange=vi.fn().mockRejectedValueOnce(new Error('save failed')).mockResolvedValue(undefined);render(<LifeCardView card={{kind:'google-operation',operation:{...operation,state:'unknown'}}} api={api} onCardChange={onCardChange}/>);
 await screen.findByText('現在の操作状態を確認できません。状態を確認してください。');await userEvent.setup().click(screen.getByRole('button',{name:'状態を確認'}));await waitFor(()=>expect(screen.getByRole('button',{name:'この内容で追加'})).toBeEnabled());expect(onCardChange).toHaveBeenCalledTimes(2);
});
it('does not persist an action result arriving after its card unmounts',async()=>{
 const result={service:'tasks' as const,sourceId:'s',fetchedAt:timestamp,items:[{service:'tasks' as const,sourceId:'s',id:'i',version:'v',title:'買い物'}]};let release!:(v:GoogleAssistantOperation)=>void;const pending=new Promise<GoogleAssistantOperation>(resolve=>{release=resolve;});const api={prepare:vi.fn().mockReturnValue(pending)} as unknown as LifeServicesApi;const onCardChange=vi.fn();const {unmount}=render(<LifeCardView card={{kind:'google-items',sourceTitle:'タスク',result}} api={api} onCardChange={onCardChange}/>);await userEvent.setup().click(screen.getByRole('button',{name:'完了にする下書き'}));unmount();release({operationId:'op',signature:'sig',keyVersion:'v1',expiresAt:'2099-01-01T00:00:00Z',state:'prepared',request:{service:'tasks',sourceId:'s',action:'complete',itemId:'i',version:'v',changes:{completed:true}},before:result.items[0]});await pending;await new Promise(resolve=>setTimeout(resolve,0));expect(onCardChange).not.toHaveBeenCalled();
});

it('shows feedback even when the checked operation is unchanged',async()=>{
 const operation:GoogleAssistantOperation={operationId:'op',signature:'sig',keyVersion:'v1',expiresAt:'2099-01-01T00:00:00Z',state:'succeeded',request:{service:'calendar',sourceId:'s',action:'create',changes:{title:'予定'}},before:null};
 const api={operation:vi.fn().mockResolvedValue(operation)} as unknown as LifeServicesApi;
 render(<LifeCardView card={{kind:'google-operation',operation}} api={api}/>);
 await waitFor(()=>expect(api.operation).toHaveBeenCalledOnce());
 await userEvent.setup().click(screen.getByRole('button',{name:'状態を確認'}));
 expect(await screen.findByRole('status')).toHaveTextContent('確認しました');expect(api.operation).toHaveBeenCalledTimes(2);
});
it('offers a delete draft for each calendar candidate without executing it',async()=>{
 const items=['a','b'].map(id=>({service:'calendar' as const,sourceId:'s',id,version:'v1',title:id,start:timestamp,end:'2026-09-05T02:00:00Z'}));
 const api={prepare:vi.fn().mockResolvedValue({operationId:'op',state:'prepared',request:{service:'calendar',sourceId:'s',action:'delete',changes:{}},before:items[1]}) ,confirm:vi.fn()} as unknown as LifeServicesApi;
 render(<LifeCardView card={{kind:'google-items',sourceTitle:'仕事',result:{service:'calendar',sourceId:'s',fetchedAt:timestamp,items}}} api={api}/>);
 await userEvent.setup().click(screen.getAllByRole('button',{name:'削除の確認へ'})[1]!);
 expect(api.prepare).toHaveBeenCalledWith({service:'calendar',sourceId:'s',itemId:'b',version:'v1',action:'delete',changes:{}});expect(api.confirm).not.toHaveBeenCalled();
});
