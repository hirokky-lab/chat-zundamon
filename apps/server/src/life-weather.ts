import { isLifeHome,type LifeHome,type LifeLocationResult,type LifeWeatherForecast } from '../../../packages/domain/src/life-settings.js';
import { LifeServiceError,type LifeSettingsService } from './life-settings.js';
import type { RequestUser } from './request-user.js';
export interface LifeWeatherProvider {locations(query:string):Promise<LifeLocationResult>;forecast(home:LifeHome,days:number):Promise<LifeWeatherForecast>;}
export type LifeWeatherQuota = {acquire(owner:RequestUser):Promise<boolean>};
export type LifeWeatherService=ReturnType<typeof createLifeWeatherService>;
export function createLifeWeatherService(input:{settings:LifeSettingsService;provider:LifeWeatherProvider;quota?:LifeWeatherQuota}) {
 const quota=input.quota??createInMemoryLifeWeatherQuota();
 const cache=new Map<string,{revision:number;days:number;expires:number;value:LifeWeatherForecast}>();
 const claim=async(o:RequestUser)=>{if(!o.userId)throw new LifeServiceError('unavailable');if(!await quota.acquire(o))throw new LifeServiceError('quota_exceeded');};
 return {
  async locations(owner:RequestUser,query:string) {if(typeof query!=='string'||query.trim().length<2||query.length>200||/[\u0000-\u001f\u007f]/.test(query))throw new LifeServiceError('invalid_request');await claim(owner);return input.provider.locations(query.trim());},
  async forecast(owner:RequestUser,days:number) {
   if(!Number.isInteger(days)||days<1||days>7)throw new LifeServiceError('invalid_request');
   const before=await input.settings.get(owner);if(!before.home){cache.delete(owner.userId);throw new LifeServiceError('home_required');}
   const cached=cache.get(owner.userId);if(cached&&cached.revision===before.revision&&cached.days===days&&cached.expires>Date.now())return structuredClone(cached.value);
   cache.delete(owner.userId);
   await claim(owner);const result=await input.provider.forecast(before.home,days);
   // A concurrent deletion/change must invalidate even a request already in flight.
   if((await input.settings.get(owner)).revision!==before.revision)throw new LifeServiceError('conflict');
   if(cache.size>=50)cache.delete(cache.keys().next().value!);
   cache.set(owner.userId,{revision:before.revision,days,expires:Date.now()+60000,value:structuredClone(result)});
   return result;
  },
 };
}
export function createInMemoryLifeWeatherQuota():LifeWeatherQuota {
 const calls=new Map<string,number[]>();return {async acquire(o){const now=Date.now();const list=(calls.get(o.userId)??[]).filter(t=>t>=now-86400000);if(list.length>=50||list.filter(t=>t>=now-60000).length>=8)return false;list.push(now);calls.set(o.userId,list);return true;}};
}
const attribution='Weather data by Open-Meteo (https://open-meteo.com/), CC BY 4.0; location data by GeoNames';
type Json=Record<string,unknown>;
const obj=(v:unknown):v is Json=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function createOpenMeteoProvider(options:{fetch?:typeof globalThis.fetch;now?:()=>Date}={}):LifeWeatherProvider {
 const transport=options.fetch??globalThis.fetch;
 async function json(url:URL):Promise<Json> {
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);
  try {
   const response=await transport(url,{signal:controller.signal,redirect:'error',headers:{Accept:'application/json'}});
   if(!response.ok||!response.body)throw new LifeServiceError('unavailable');
   const reader=response.body.getReader();const chunks:Uint8Array[]=[];let length=0;
   while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536){await reader.cancel();throw new LifeServiceError('unavailable');}chunks.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const value:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!obj(value))throw new LifeServiceError('unavailable');return value;
  }catch{throw new LifeServiceError('unavailable');}finally{clearTimeout(timeout);}
 }
 return {
  async locations(query) {
   const normalized=query.normalize('NFKC').trim();
   const expand=/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,30}$/u.test(normalized)&&!/[都道府県市区町村駅]$/u.test(normalized);
   // Search a bounded set of municipality names as well as the entered place.
   // Never choose one automatically: similarly named places remain candidates.
   const names=expand?[normalized+'市',normalized,normalized+'町',normalized+'村']:[normalized];
   const results=await Promise.all(names.map(async name=>{
    const url=new URL('https://geocoding-api.open-meteo.com/v1/search');url.search=new URLSearchParams({name,count:'5',language:'ja',format:'json'}).toString();
    const value=await json(url);if(value.results===undefined)return [];
    if(!Array.isArray(value.results)||value.results.length>5)throw new LifeServiceError('unavailable');
    return value.results.map((r:unknown)=>{
     if(!obj(r)||typeof r.name!=='string')throw new LifeServiceError('unavailable');
     const parts=r.country_code==='JP'||r.country==='日本'?[r.admin1,r.admin2,r.admin3,r.admin4,r.name]:[r.country,r.admin1,r.admin2,r.admin3,r.admin4,r.name];
     const label=[...new Set(parts.filter((x):x is string=>typeof x==='string'&&x.length>0))].join(' ');
     const home={label,query:label,latitude:r.latitude,longitude:r.longitude,timezone:r.timezone,precision:'locality' as const};
     if(!isLifeHome(home))throw new LifeServiceError('unavailable');return home;
    });
   }));
   const seen=new Set<string>();
   const candidates=results.flat().filter(h=>{const key=`${h.latitude},${h.longitude}`;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,5);
   return {candidates,attribution};
  },
  async forecast(home,days) {
   if(!isLifeHome(home)||!Number.isInteger(days)||days<1||days>7)throw new LifeServiceError('invalid_request');
   const url=new URL('https://api.open-meteo.com/v1/forecast');
   url.search=new URLSearchParams({latitude:String(home.latitude),longitude:String(home.longitude),timezone:home.timezone,forecast_days:String(days),daily:'temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code'}).toString();
   const value=await json(url);const daily=value.daily;
   if(!obj(daily)||!Array.isArray(daily.time)||daily.time.length!==days)throw new LifeServiceError('unavailable');
   const keys=['temperature_2m_min','temperature_2m_max','precipitation_probability_max','weather_code'];
   for(const key of keys)if(!Array.isArray(daily[key])||(daily[key] as unknown[]).length!==days)throw new LifeServiceError('unavailable');
   const now=options.now?.()??new Date();
   const localToday=new Intl.DateTimeFormat('sv-SE',{timeZone:home.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
   const result=daily.time.map((date:unknown,i:number)=>{
    const expected=new Date(Date.parse(localToday+'T00:00:00Z')+i*86400000).toISOString().slice(0,10);
    if(date!==expected)throw new LifeServiceError('unavailable');
    const values=keys.map(k=>(daily[k] as unknown[])[i]);
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||values.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new LifeServiceError('unavailable');
    const [temperatureMin,temperatureMax,precipitationProbability,weatherCode]=values as [number,number,number,number];
    if(temperatureMin < -100||temperatureMax>70||temperatureMin>temperatureMax||precipitationProbability<0||precipitationProbability>100||!Number.isInteger(weatherCode)||weatherCode<0||weatherCode>99)throw new LifeServiceError('unavailable');
    return {date,temperatureMin,temperatureMax,precipitationProbability,weatherCode};
   });return {home,days:result,fetchedAt:now.toISOString(),attribution};
  },
 };
}
