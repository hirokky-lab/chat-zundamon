import type {CalendarPreviewItem,GoogleCalendarPreviewResult,GoogleSourceListResult} from '@yui/domain';

/** Read every listed calendar before returning a combined upcoming preview.
 * A failed source fails the whole result so missing appointments never look like free time.
 */
export async function aggregateCalendarPreview(input:{
 sources:GoogleSourceListResult;
 read:(sourceId:string)=>Promise<GoogleCalendarPreviewResult>;
 signal:AbortSignal;
}):Promise<GoogleCalendarPreviewResult>{
 const items:CalendarPreviewItem[]=[];
 for(let offset=0;offset<input.sources.items.length;offset+=3){
  if(input.signal.aborted)throw new Error('Calendar read cancelled');
  const batch=input.sources.items.slice(offset,offset+3);
  const results=await Promise.all(batch.map(async source=>{
   const result=await input.read(source.id);
   return result.items.map(item=>({...item,calendar:{id:source.id,title:source.title}}));
  }));
  items.push(...results.flat());
 }
 if(input.signal.aborted)throw new Error('Calendar read cancelled');
 // All-day dates are compared at midnight JST, matching this app's calendar display.
 const start=(item:CalendarPreviewItem)=>Date.parse(item.start.kind==='all_day'?`${item.start.value}T00:00:00+09:00`:item.start.value);
 items.sort((a,b)=>start(a)-start(b));
 return {service:'calendar',checkedAt:input.sources.checkedAt,items:items.slice(0,3)};
}
