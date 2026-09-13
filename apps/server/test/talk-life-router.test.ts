import {describe,it,expect,vi} from 'vitest';
import {createTalkLifeRouter} from '../src/talk-life-router.js';
import {createLifeSettingsService,createInMemoryLifeSettingsRepository} from '../src/life-settings.js';
import {createLifeWeatherService} from '../src/life-weather.js';
import {createUnlimitedCostGuard} from '../src/cost-guard.js';
import type {TalkLifeIntent} from '../src/talk-life-intent.js';
const owner={userId:'owner-a',email:'owner@example.test',accessToken:'fixture'};
const home={label:'立川市',query:'立川市',latitude:37.45,longitude:138.85,timezone:'Asia/Tokyo',precision:'locality' as const};
const now=()=>new Date('2026-09-05T08:00:00Z');
async function setup(intent:TalkLifeIntent, snapshot?:any,sources?:any){
 const settings=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 await settings.update(owner,{revision:0,home,calendar:{id:'work',title:'仕事'},tasks:{id:'work-tasks',title:'仕事リスト'}});
 const list=vi.fn(async({request}:any)=>({...request,fetchedAt:now().toISOString(),items:[{service:request.service,sourceId:request.sourceId,id:'item',version:'v1',title:'打ち合わせ',start:'2026-09-06T01:00:00.000Z',end:'2026-09-06T02:00:00.000Z'}]}));
 const prepare=vi.fn(async({request}:any)=>({operationId:'op',signature:'signed',keyVersion:'v1',expiresAt:'2026-09-05T08:05:00.000Z',state:'prepared',request,before:null}));
 const classify=vi.fn(async()=>intent);
 const status=vi.fn();
 const weather=createLifeWeatherService({settings,provider:{locations:async()=>({candidates:[home],attribution:'fixture'}),forecast:async()=>({home,days:[{date:'2026-09-06',temperatureMin:20,temperatureMax:28,precipitationProbability:70,weatherCode:61}],fetchedAt:now().toISOString(),attribution:'fixture'})}});
 const router=createTalkLifeRouter({settings,weather,sources,google:{list,prepare,confirm:vi.fn(),cancel:vi.fn(),status} as any,intent:{classify},costGuard:createUnlimitedCostGuard(),maximumUsd:0.03,now,...(snapshot?{chatState:{get:async()=>snapshot} as any}:{})});
 const send=(text:string)=>router.respond({owner,text,turns:[{role:'user',text}],clientMessageId:'m1',timeZone:'Asia/Tokyo'});
 return {send,list,prepare,classify,settings,status};
}
describe('talk life service integration',()=>{
 it('uses saved work calendar and the requested tomorrow window',async()=>{const t=await setup({kind:'calendar_read',dateFrom:'2026-09-06',dateTo:'2026-09-06'});const result=await t.send('明日の予定は？');expect(t.list).toHaveBeenCalledWith({owner,request:{service:'calendar',sourceId:'work',timeMin:'2026-09-05T15:00:00.000Z',timeMax:'2026-09-06T15:00:00.000Z'}});expect(result?.lifeCard?.kind).toBe('google-items');expect(result?.bubbles[0]?.flow).toBe('external_context');});
 it('keeps ordinary greetings on existing chat without querying settings/providers',async()=>{const t=await setup({kind:'none'});expect(await t.send('おはよう')).toBe(null);expect(t.classify).not.toHaveBeenCalled();expect(t.list).not.toHaveBeenCalled();});
 it('creates a confirmation draft but never executes a task edit',async()=>{const t=await setup({kind:'google_update',service:'tasks',completed:true,targetTitle:'打ち合わせ'});const r=await t.send('このタスクを完了にして');expect(t.prepare).toHaveBeenCalledWith({owner,request:{service:'tasks',sourceId:'work-tasks',itemId:'item',version:'v1',action:'complete',changes:{completed:true}}});expect(r?.lifeCard?.kind).toBe('google-operation');});
 it('uses saved approximate home for Maps and fetched forecast for weather',async()=>{const map=await setup({kind:'maps',destination:'立川駅',origin:'home',travelMode:'walking'});expect((await map.send('家から立川駅への道'))?.lifeCard).toEqual({kind:'maps',origin:'立川市',destination:'立川駅',travelMode:'walking'});const t=await setup({kind:'weather',dateFrom:'2026-09-06'});expect((await t.send('明日傘いる？'))?.lifeCard?.kind).toBe('weather');});
 it('offers home candidates without silently saving a location',async()=>{const t=await setup({kind:'home_set',query:'立川市'});const before=await t.settings.get(owner);expect((await t.send('自宅は立川市で覚えて'))?.lifeCard?.kind).toBe('home-candidates');expect(await t.settings.get(owner)).toEqual(before);});
 it('does not use an old calendar card when an explicit source or date differs',async()=>{
  const old={timeline:[{type:'message',role:'assistant',lifeCard:{kind:'google-items',sourceTitle:'私用',result:{service:'calendar',sourceId:'personal',timeMin:'2026-09-04T15:00:00.000Z',timeMax:'2026-09-05T15:00:00.000Z',items:[{service:'calendar',sourceId:'personal',id:'old',version:'v0',title:'打ち合わせ'}]}}}]};
  const t=await setup({kind:'google_update',service:'calendar',sourceName:'仕事',dateFrom:'2026-09-06',dateTo:'2026-09-06',targetTitle:'打ち合わせ',title:'変更後'},old);
  await t.send('明日の仕事カレンダーのこの予定を変更して');
  expect(t.list).toHaveBeenCalled();
  expect(t.prepare.mock.calls[0]?.[0].request).toMatchObject({sourceId:'work',itemId:'item'});
 });
 it('does not silently shorten an unavailable weather date range',async()=>{
  const t=await setup({kind:'weather',dateFrom:'2026-09-06',dateTo:'2026-09-20'});
  const result=await t.send('これから2週間の天気');
  expect(result?.lifeCard).toBeUndefined();
  expect(result?.bubbles[0]?.text).toContain('期間全体');
 });

});

describe('all calendar talk reads',()=>{
 const sources={sources:async()=>({status:'completed',value:{items:[{id:'work',title:'仕事'},{id:'personal',title:'プライベート'}]}})};
 it('reads every readable calendar and subsequent pages, preserving calendar labels',async()=>{
  const t=await setup({kind:'calendar_read',dateFrom:'2026-09-06',dateTo:'2026-09-06'},undefined,sources);
  t.list.mockImplementation(async({request}:any)=>({...request,fetchedAt:now().toISOString(),items:[{service:'calendar',sourceId:request.sourceId,id:request.pageToken?'second':'first',version:'v1',title:request.pageToken?'夕方の予定':'朝の予定',start:request.pageToken?'2026-09-06T08:00:00Z':'2026-09-06T01:00:00Z'}],...(!request.pageToken?{nextPageToken:'page2'}:{})}));
  const result=await t.send('明日の予定は？');
  expect(t.list).toHaveBeenCalledTimes(4);
  expect(result?.bubbles[0]?.text).toContain('プライベート');
  expect(result?.bubbles[0]?.text).toContain('夕方の予定');
 });
 it('does not report no events when a calendar fails',async()=>{
  const t=await setup({kind:'calendar_read'},undefined,sources);
  t.list.mockRejectedValue(new Error('unavailable'));
  const result=await t.send('今日の予定は？');
  expect(result?.bubbles[0]?.text).not.toContain('予定はなかった');
  expect(result?.bubbles[0]?.text).toMatch(/取得|確認|接続|使え/);
 });
});
it('prepares deletion of a specifically named event without changing it',async()=>{
 const t=await setup({kind:'google_delete',service:'calendar',sourceName:'仕事',targetTitle:'打ち合わせ',dateFrom:'2026-09-06',dateTo:'2026-09-06'});
 const result=await t.send('明日の仕事の打ち合わせを削除して');
 expect(t.prepare.mock.calls[0]?.[0].request).toMatchObject({action:'delete',sourceId:'work',itemId:'item',changes:{}});
 expect(result?.lifeCard?.kind).toBe('google-operation');
 expect(result?.bubbles[0]?.text).toContain('削除する？');
});

it('resolves the last created event from server operation state, even with a stale inferred date',async()=>{
 const operation={operationId:'created-op',state:'prepared',request:{service:'calendar',sourceId:'personal',action:'create',changes:{title:'AI開発'}},before:null};
 const t=await setup({kind:'google_delete',service:'calendar',sourceName:'仕事',dateFrom:'2026-09-04',dateTo:'2026-09-04'},{timeline:[{type:'message',role:'assistant',lifeCard:{kind:'google-operation',operation}}]});
 t.status.mockResolvedValue({...operation,state:'succeeded',result:{service:'calendar',sourceId:'personal',id:'created-event',version:'v2',title:'AI開発',start:'2026-09-06T11:00:00Z',end:'2026-09-06T12:00:00Z'}});
 const r=await t.send('さっきの削除して');
 expect(t.status).toHaveBeenCalledWith({owner,operationId:'created-op'});
 expect(t.list).not.toHaveBeenCalled();
 expect(t.prepare.mock.calls[0]?.[0].request).toMatchObject({sourceId:'personal',itemId:'created-event',version:'v2',action:'delete'});
 expect(r?.lifeCard?.kind).toBe('google-operation');
});
it('does not substitute a different event when the referenced operation was cancelled',async()=>{
 const operation={operationId:'cancelled-op',state:'cancelled',request:{service:'calendar',sourceId:'work',action:'create',changes:{title:'予定'}},before:null};
 const t=await setup({kind:'google_delete',service:'calendar'},{timeline:[{type:'message',role:'assistant',lifeCard:{kind:'google-operation',operation}}]});
 t.status.mockResolvedValue(operation);await t.send('さっきの削除して');
 expect(t.prepare).not.toHaveBeenCalled();expect(t.list).not.toHaveBeenCalled();
});
it('does not invite selection when there are no matching events',async()=>{
 const t=await setup({kind:'google_delete',service:'calendar',targetTitle:'見つからない予定'});
 const r=await t.send('見つからない予定を削除して');
 expect(t.prepare).not.toHaveBeenCalled();expect(r?.bubbles[0]?.text).not.toContain('選んで');expect(r?.lifeCard).toBeUndefined();
});
it('returns one real Drive file when asked for one, without implying permission changes',async()=>{
 const files=[{id:'one',name:'one.txt',mimeType:'text/plain'},{id:'two',name:'two.txt',mimeType:'text/plain'}];
 const drive={search:vi.fn().mockResolvedValue({files,nextPageToken:'more'})};
 const router=createTalkLifeRouter({drive:drive as any,settings:{} as any,weather:{} as any,intent:{classify:async()=>({kind:'drive_search',query:'資料'})},costGuard:createUnlimitedCostGuard(),maximumUsd:0.03});
 const send=(text:string)=>router.respond({owner,text,turns:[],clientMessageId:'drive-test',timeZone:'Asia/Tokyo'});
 expect((await send('Driveの資料を1つ適当に共有'))?.lifeCard).toEqual({kind:'drive-results',query:'資料',result:{files:[files[0]]}});
 expect((await send('Driveの資料を探して'))?.lifeCard).toEqual({kind:'drive-results',query:'資料',result:{files,nextPageToken:'more'}});
 drive.search.mockResolvedValueOnce({files:[]} as any);
 expect((await send('Driveの資料を1つ共有'))?.lifeCard).toBeUndefined();
});
