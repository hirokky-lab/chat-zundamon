export type LifeHome = { label: string; query: string; latitude: number; longitude: number; timezone: string; precision: 'locality' | 'station' };
export type LifeSourceSelection = { id: string; title: string };
export type LifePersonal = { nickname: string; occupation: string; details: string; responsePreferences: string };
export type LifeSettings = { personal?: LifePersonal; revision: number; home: LifeHome | null; calendar: LifeSourceSelection | null; tasks: LifeSourceSelection | null };
export type LifeLocationResult = { candidates: LifeHome[]; attribution: string };
export type LifeWeatherDay = { date: string; temperatureMin: number; temperatureMax: number; precipitationProbability: number; weatherCode: number };
export type LifeWeatherForecast = { home: LifeHome; days: LifeWeatherDay[]; fetchedAt: string; attribution: string };
export const emptyLifeSettings = (): LifeSettings => ({revision:0,home:null,calendar:null,tasks:null});
function record(v:unknown): v is Record<string,unknown> {return !!v && typeof v==='object' && !Array.isArray(v);}
function text(v:unknown,max:number):v is string {return typeof v==='string' && v.trim().length>0 && v.length<=max && !/[\u0000-\u001f\u007f]/.test(v);}
export function isLifeHome(v:unknown):v is LifeHome {
 if(!record(v)||Object.keys(v).sort().join(',')!=='label,latitude,longitude,precision,query,timezone')return false;
 if(!text(v.label,160)||!text(v.query,200)||!text(v.timezone,80)||(v.precision!=='locality'&&v.precision!=='station'))return false;
 if(typeof v.latitude!=='number'||!Number.isFinite(v.latitude)||Math.abs(v.latitude)>90||typeof v.longitude!=='number'||!Number.isFinite(v.longitude)||Math.abs(v.longitude)>180)return false;
 try {new Intl.DateTimeFormat('en',{timeZone:v.timezone});return true;}catch{return false;}
}
export function isLifePersonal(v:unknown):v is LifePersonal {
 if(!record(v)||Object.keys(v).sort().join(',')!=='details,nickname,occupation,responsePreferences')return false;
 const field=(value:unknown,max:number,multiline=false)=>typeof value==='string'&&value.length<=max
  &&!(multiline?/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(value);
 return field(v.nickname,20)&&field(v.occupation,120)&&field(v.details,2000,true)&&field(v.responsePreferences,1000,true);
}
export function isLifeSettings(v:unknown):v is LifeSettings {
 if(!record(v)||!['calendar,home,revision,tasks','calendar,home,personal,revision,tasks'].includes(Object.keys(v).sort().join(','))||!Number.isSafeInteger(v.revision)||(v.revision as number)<0)return false;
 if('personal' in v&&!isLifePersonal(v.personal))return false;
 const source=(s:unknown)=>s===null||(record(s)&&Object.keys(s).sort().join(',')==='id,title'&&text(s.id,512)&&text(s.title,200));
 return (v.home===null||isLifeHome(v.home))&&source(v.calendar)&&source(v.tasks);
}
export function parseLifeSettings(value:unknown):LifeSettings|null {return isLifeSettings(value)?value:null;}
