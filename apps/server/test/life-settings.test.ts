import { describe,it,expect } from 'vitest';
import { createInMemoryLifeSettingsRepository,createLifeSettingsService } from '../src/life-settings.js';
import { createLifeWeatherService,createOpenMeteoProvider } from '../src/life-weather.js';
const owner={userId:'a',email:'a@test',accessToken:'token'};
const home={label:'Example',query:'Example',latitude:35,longitude:139,timezone:'Asia/Tokyo',precision:'locality' as const};
describe('life settings and weather',()=>{
 it('isolates owners and rejects stale revisions',async()=>{
  const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
  expect(await s.get(owner)).toEqual({revision:0,home:null,calendar:null,tasks:null});
  const input={revision:0,home,calendar:null,tasks:null};
  expect((await s.update(owner,input)).revision).toBe(1);
  expect((await s.get({...owner,userId:'b'})).home).toBeNull();
  await expect(s.update(owner,input)).rejects.toMatchObject({code:'conflict'});
 });
 it('home deletion prevents subsequent weather provider calls',async()=>{
  const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
  await s.update(owner,{revision:0,home,calendar:null,tasks:null});
  let calls=0;
  const w=createLifeWeatherService({settings:s,provider:{locations:async()=>({candidates:[],attribution:'Open-Meteo'}),forecast:async(h)=>{calls++;return {home:h,days:[],fetchedAt:new Date().toISOString(),attribution:'Open-Meteo'};}}});
  await w.forecast(owner,1);
  await s.update(owner,{revision:1,home:null,calendar:null,tasks:null});
  await expect(w.forecast(owner,1)).rejects.toMatchObject({code:'home_required'});
  expect(calls).toBe(1);
 });
 it('rejects unknown fields and invalid coordinates',async()=>{
  const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
  await expect(s.update(owner,{revision:0,home:{...home,latitude:91},calendar:null,tasks:null})).rejects.toMatchObject({code:'invalid_request'});
  await expect(s.update(owner,{revision:0,home:null,calendar:null,tasks:null,ownerId:'b'})).rejects.toMatchObject({code:'invalid_request'});
 });
 it('returns multiple candidates and validates provider payload',async()=>{
  const p=createOpenMeteoProvider({fetch:async()=>new Response(JSON.stringify({results:[{name:'Example',latitude:35,longitude:139,timezone:'Asia/Tokyo'},{name:'Example',latitude:36,longitude:140,timezone:'Asia/Tokyo'}]}))});
  expect((await p.locations('Example')).candidates).toHaveLength(2);
  const bad=createOpenMeteoProvider({fetch:async()=>new Response(JSON.stringify({daily:{}}))});
  await expect(bad.forecast(home,1)).rejects.toMatchObject({code:'unavailable'});
 });
});

it('invalidates in-flight forecast after deleting home',async()=>{
 const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());await s.update(owner,{revision:0,home,calendar:null,tasks:null});
 let release!:()=>void;let started!:()=>void;const ready=new Promise<void>(r=>started=r);const gate=new Promise<void>(r=>release=r);
 const w=createLifeWeatherService({settings:s,provider:{locations:async()=>({candidates:[],attribution:''}),forecast:async h=>{started();await gate;return {home:h,days:[],fetchedAt:'',attribution:''};}}});
 const pending=w.forecast(owner,1);await ready;await s.update(owner,{revision:1,home:null,calendar:null,tasks:null});release();
 await expect(pending).rejects.toMatchObject({code:'conflict'});
});
it('denies exhausted quota before sending query',async()=>{
 let calls=0;const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 const w=createLifeWeatherService({settings:s,quota:{acquire:async()=>false},provider:{locations:async()=>{calls++;return {candidates:[],attribution:''};},forecast:async()=>{throw Error();}}});
 await expect(w.locations(owner,'Example')).rejects.toMatchObject({code:'quota_exceeded'});expect(calls).toBe(0);
});
it('bounds response bodies and sends to fixed hosts with redirects forbidden',async()=>{
 let target='';let redirect:unknown;
 const p=createOpenMeteoProvider({fetch:async(url,init)=>{target=String(url);redirect=init?.redirect;return new Response('x'.repeat(70000));}});
 await expect(p.locations('https://evil.invalid/private')).rejects.toMatchObject({code:'unavailable'});
 expect(new URL(target).hostname).toBe('geocoding-api.open-meteo.com');expect(redirect).toBe('error');
});
it('validates forecast local dates, units, and missing provider values',async()=>{
 const payload={daily:{time:['2026-09-06'],temperature_2m_min:[20],temperature_2m_max:[30],precipitation_probability_max:[70],weather_code:[61]}};
 const provider=createOpenMeteoProvider({now:()=>new Date('2026-09-05T16:00:00Z'),fetch:async()=>new Response(JSON.stringify(payload))});
 const result=await provider.forecast(home,1);expect(result.days[0]).toEqual({date:'2026-09-06',temperatureMin:20,temperatureMax:30,precipitationProbability:70,weatherCode:61});
 payload.daily.time=['2026-09-05'];await expect(provider.forecast(home,1)).rejects.toMatchObject({code:'unavailable'});
});

it('finds Nagaoka city from a short place name while retaining other municipalities',async()=>{
 const names:string[]=[];
 const p=createOpenMeteoProvider({fetch:async url=>{
  const name=new URL(String(url)).searchParams.get('name')!;names.push(name);
  const results=name==='立川市'?[{name:'立川市',admin1:'東京都',admin2:'立川市',country:'日本',latitude:37.45,longitude:138.85,timezone:'Asia/Tokyo'}]:name==='立川'?[{name:'立川',admin1:'京都府',admin2:'府中市',country:'日本',latitude:34.93,longitude:135.69,timezone:'Asia/Tokyo'}]:[];
  return new Response(JSON.stringify({results}));
 }});
 const result=await p.locations('立川');
 expect(result.candidates.map(h=>h.label)).toEqual(['東京都 立川市','京都府 府中市 立川']);
 expect(names).toHaveLength(4);
 expect(result.candidates[0]?.query).toBe('東京都 立川市');
});
it('shows prefecture city and neighborhood without duplicate municipality names',async()=>{
 const p=createOpenMeteoProvider({fetch:async()=>new Response(JSON.stringify({results:[{name:'サンプル地区',admin1:'東京都',admin2:'立川市',admin3:'立川市',country:'日本',latitude:37.47,longitude:138.83,timezone:'Asia/Tokyo'}]}))});
 expect((await p.locations('サンプル地区')).candidates.map(h=>h.label)).toEqual(['東京都 立川市 サンプル地区']);
});

const personal={nickname:'ユイ友',occupation:'企画',details:'料理が好き\n犬と暮らす',responsePreferences:'短く\nわかりやすく'};
it('saves personal fields, preserves them for old clients, permits clearing, and isolates owners',async()=>{
 const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 const saved=await s.update(owner,{revision:0,home:null,calendar:null,tasks:null,personal});
 expect(saved.personal).toEqual(personal);
 const legacy=await s.update(owner,{revision:1,home,calendar:null,tasks:null});
 expect(legacy.personal).toEqual(personal);
 expect((await s.get({...owner,userId:'other'})).personal).toBeUndefined();
 await expect(s.update(owner,{...saved,revision:1})).rejects.toMatchObject({code:'conflict'});
 const empty={nickname:'',occupation:'',details:'',responsePreferences:''};
 expect((await s.update(owner,{...legacy,personal:empty})).personal).toEqual(empty);
});
it('rejects malformed or overlong personal data without changing the saved revision',async()=>{
 const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 for(const invalid of [null,{}, {...personal,extra:'x'}, {...personal,nickname:'x'.repeat(21)}, {...personal,occupation:'x'.repeat(121)}, {...personal,details:'x'.repeat(2001)}, {...personal,responsePreferences:'x'.repeat(1001)}, {...personal,nickname:'a\nb'}, {...personal,details:'a\tb'}, {...personal,details:12}]) {
  await expect(s.update(owner,{revision:0,home:null,calendar:null,tasks:null,personal:invalid})).rejects.toMatchObject({code:'invalid_request'});
 }
 expect((await s.get(owner)).revision).toBe(0);
});
it('uses UTF-16 limits consistently for emoji and allows CRLF in multiline fields',async()=>{
 const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 const input={revision:0,home:null,calendar:null,tasks:null,personal:{...personal,nickname:'🙂'.repeat(10),details:'line\r\nline'}};
 expect((await s.update(owner,input)).personal?.nickname).toBe('🙂'.repeat(10));
 await expect(s.update(owner,{...input,revision:1,personal:{...input.personal,nickname:'🙂'.repeat(11)}})).rejects.toMatchObject({code:'invalid_request'});
});
it('rejects credential-bearing personal fields before persistence',async()=>{
 const s=createLifeSettingsService(createInMemoryLifeSettingsRepository());
 for(const key of ['nickname','occupation','details','responsePreferences']) {
  await expect(s.update(owner,{revision:0,home:null,calendar:null,tasks:null,personal:{...personal,[key]:'パスワード: abc123'}})).rejects.toMatchObject({code:'invalid_request'});
 }
 expect((await s.get(owner)).revision).toBe(0);
});
