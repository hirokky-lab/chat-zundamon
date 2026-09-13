import { parseLifeSettings, parseLifeCard, isLifeGoogleResult, isLifeGoogleOperation, type LifeSettings, type LifeHome, type LifeWeatherForecast, type GoogleAssistantListRequest, type GoogleAssistantListResult, type GoogleAssistantPrepareRequest, type GoogleAssistantOperation } from '@yui/domain';
export type LifeServicesApi = {
 getSettings():Promise<LifeSettings>;saveSettings(value:LifeSettings):Promise<LifeSettings>;
 locations(query:string):Promise<{candidates:LifeHome[];attribution:string}>;forecast(days:number):Promise<LifeWeatherForecast>;
 list(input:GoogleAssistantListRequest):Promise<GoogleAssistantListResult>;prepare(input:GoogleAssistantPrepareRequest):Promise<GoogleAssistantOperation>;
 confirm(operationId:string,signature:string):Promise<GoogleAssistantOperation>;cancel(operationId:string):Promise<GoogleAssistantOperation>;operation(operationId:string):Promise<GoogleAssistantOperation>;
 beginConnection(service:'calendar'|'tasks',purpose:'read'|'write'):Promise<string>;
};
/** All calls use the owner-authorized transport supplied by the app. Writes are never retried. */
export function createLifeServicesApi(fetchImpl:(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>):LifeServicesApi {
 async function request(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<any>{const r=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});if(!r.ok)throw new Error(r.status===409?'別の端末で設定が変わりました。閉じて開き直してください。':'取得・変更を確認できませんでした。');return r.json();}
 const settings=(v:unknown)=>{const parsed=parseLifeSettings(v);if(!parsed)throw new Error('設定の形式を確認できませんでした。');return parsed;};
 const operation=(v:unknown)=>{if(!isLifeGoogleOperation(v))throw new Error('操作の状態を確認できませんでした。');return v;};
 return {getSettings:async()=>settings(await request('/api/life-settings')),saveSettings:async v=>settings(await request('/api/life-settings',v,'PUT')),
 locations:async query=>{const v=await request('/api/life-weather/locations',{query});const c=parseLifeCard({kind:'home-candidates',query,candidates:v.candidates,revision:0});if(c?.kind!=='home-candidates'||typeof v.attribution!=='string'||v.attribution.length>500)throw new Error('地域候補を確認できませんでした。');return {candidates:c.candidates,attribution:v.attribution};},
 forecast:async days=>{const v=await request('/api/life-weather/forecast',{days});const c=parseLifeCard({kind:'weather',forecast:v});if(c?.kind!=='weather')throw new Error('予報を確認できませんでした。');return c.forecast;},
 list:async input=>{const v=await request('/api/google-assistant/list',input);if(!isLifeGoogleResult(v))throw new Error('一覧を確認できませんでした。');return v;},
 prepare:async input=>operation(await request('/api/google-assistant/prepare',input)),confirm:async(operationId,signature)=>operation(await request('/api/google-assistant/confirm',{operationId,signature})),cancel:async operationId=>operation(await request('/api/google-assistant/cancel',{operationId})),operation:async id=>operation(await request(`/api/google-assistant/operations/${encodeURIComponent(id)}`)),
 beginConnection:async(service,purpose)=>{const v=await request(`/api/google-calendar-tasks/${service}/connect`,{purpose});const u=new URL(v.authorizationUrl);if(u.protocol!=='https:'||u.hostname!=='accounts.google.com'||u.username||u.password)throw new Error('接続先を確認できませんでした。');return u.toString();},
 };
}
