import {gmailResultsSchema,gmailContentSchema,type GmailResults,type GmailContent} from './gmail.js';
import {driveResultsSchema,driveContentSchema,type DriveResults,type DriveContent} from './google-drive.js';
import { isGoogleAssistantPrepareRequest, type GoogleAssistantItem, type GoogleAssistantListResult, type GoogleAssistantOperation } from './google-assistant.js';
import { parseLifeSettings, type LifeHome, type LifeWeatherForecast } from './life-settings.js';
export type LifeCard =
 | {kind:'gmail-results';query:string;result:GmailResults}
 | {kind:'gmail-content';content:GmailContent}
 | {kind:'gmail-draft';content:GmailContent;body:string}
 | {kind:'drive-results';query:string;result:DriveResults;mediaType?:'video'|'image'}
 | {kind:'drive-content';content:DriveContent}
 | {kind:'google-items';result:GoogleAssistantListResult;sourceTitle:string}
 | {kind:'google-operation';operation:GoogleAssistantOperation}
 | {kind:'weather';forecast:LifeWeatherForecast}
 | {kind:'maps';origin:string|null;destination:string;travelMode:'driving'|'walking'|'bicycling'|'transit'}
 | {kind:'home-candidates';query:string;candidates:LifeHome[];revision:number};
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const text=(v:unknown,max=1024):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const date=(v:unknown)=>text(v,64)&&/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/u.test(v)&&Number.isFinite(Date.parse(v));
export function isLifeGoogleItem(v:unknown):v is GoogleAssistantItem {return obj(v)&&keys(v,['service','sourceId','id','version','title','notes','start','end','due','completed','unsupported'])&&['calendar','tasks'].includes(String(v.service))&&text(v.sourceId)&&text(v.id)&&text(v.version)&&text(v.title)&& (v.notes===undefined||typeof v.notes==='string'&&v.notes.length<=8000)&&['start','end','due'].every(k=>v[k]===undefined||date(v[k]))&&['completed','unsupported'].every(k=>v[k]===undefined||typeof v[k]==='boolean');}
export function isLifeGoogleResult(v:unknown):v is GoogleAssistantListResult {return obj(v)&&keys(v,['service','sourceId','fetchedAt','items','nextPageToken','timeMin','timeMax'])&&['calendar','tasks'].includes(String(v.service))&&text(v.sourceId)&&date(v.fetchedAt)&&Array.isArray(v.items)&&v.items.length<=100&&v.items.every(i=>isLifeGoogleItem(i)&&i.service===v.service&&i.sourceId===v.sourceId)&&(v.nextPageToken===undefined||text(v.nextPageToken,2048))&&['timeMin','timeMax'].every(k=>v[k]===undefined||date(v[k]));}
export function isLifeGoogleOperation(v:unknown):v is GoogleAssistantOperation {try{return obj(v)&&keys(v,['operationId','signature','keyVersion','expiresAt','state','request','before','result'])&&text(v.operationId)&&text(v.signature)&&text(v.keyVersion)&&date(v.expiresAt)&&['prepared','executing','succeeded','cancelled','expired','conflict','unknown'].includes(String(v.state))&&isGoogleAssistantPrepareRequest(v.request)&&(v.before===null||isLifeGoogleItem(v.before))&&(v.result===undefined||isLifeGoogleItem(v.result));}catch{return false;}}
function home(v:unknown):v is LifeHome {try{return !!parseLifeSettings({revision:0,home:v,calendar:null,tasks:null})&&v!==null;}catch{return false;}}
export function parseLifeCard(v:unknown):LifeCard|null {
 if(!obj(v))return null;
 let valid=false;
 switch(v.kind){
 case 'gmail-results':valid=keys(v,['kind','query','result'])&&text(v.query,500)&&gmailResultsSchema.safeParse(v.result).success;break;
 case 'gmail-content':valid=keys(v,['kind','content'])&&gmailContentSchema.safeParse(v.content).success;break;
 case 'gmail-draft':valid=keys(v,['kind','content','body'])&&gmailContentSchema.safeParse(v.content).success&&text(v.body,4000);break;
 case 'drive-results':valid=keys(v,['kind','query','result','mediaType'])&&(v.mediaType===undefined||v.mediaType==='video'||v.mediaType==='image')&&text(v.query,200)&&driveResultsSchema.safeParse(v.result).success;break;
 case 'drive-content':valid=keys(v,['kind','content'])&&driveContentSchema.safeParse(v.content).success;break;
 case 'google-items':valid=keys(v,['kind','result','sourceTitle'])&&text(v.sourceTitle)&&isLifeGoogleResult(v.result);break;
 case 'google-operation':valid=keys(v,['kind','operation'])&&isLifeGoogleOperation(v.operation);break;
 case 'maps':valid=keys(v,['kind','origin','destination','travelMode'])&&(v.origin===null||text(v.origin,200))&&text(v.destination,200)&&['driving','walking','bicycling','transit'].includes(String(v.travelMode));break;
 case 'home-candidates':valid=keys(v,['kind','query','candidates','revision'])&&text(v.query,200)&&Number.isSafeInteger(v.revision)&&Number(v.revision)>=0&&Array.isArray(v.candidates)&&v.candidates.length<=10&&v.candidates.every(home);break;
 case 'weather': {const f=v.forecast;valid=keys(v,['kind','forecast'])&&obj(f)&&keys(f,['home','days','fetchedAt','attribution'])&&home(f.home)&&date(f.fetchedAt)&&text(f.attribution,500)&&Array.isArray(f.days)&&f.days.length>=1&&f.days.length<=7&&f.days.every(d=>obj(d)&&keys(d,['date','temperatureMin','temperatureMax','precipitationProbability','weatherCode'])&&date(d.date)&&['temperatureMin','temperatureMax','precipitationProbability','weatherCode'].every(k=>typeof d[k]==='number'&&Number.isFinite(d[k]))&&Number(d.precipitationProbability)>=0&&Number(d.precipitationProbability)<=100);break;}
 }
 return valid?v as LifeCard:null;
}
export function lifeMapsUrl(card:Extract<LifeCard,{kind:'maps'}>):string {const url=new URL('https://www.google.com/maps/dir/');url.searchParams.set('api','1');if(card.origin!==null)url.searchParams.set('origin',card.origin);url.searchParams.set('destination',card.destination);url.searchParams.set('travelmode',card.travelMode);return url.toString();}
