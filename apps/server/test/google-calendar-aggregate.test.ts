import {it,expect,vi} from 'vitest';
import {aggregateCalendarPreview} from '../src/google-calendar-aggregate.js';
const sources={service:'calendar' as const,checkedAt:'2026-09-09T00:00:00.000Z',items:[{id:'work',title:'仕事'},{id:'private',title:'プライベート'}]};
it('reads every calendar, orders appointments and retains source identity',async()=>{
 const read=vi.fn(async(id:string)=>({service:'calendar' as const,checkedAt:sources.checkedAt,items:[{title:'予定',start:{kind:'date_time' as const,value:id==='work'?'2026-09-10T03:00:00Z':'2026-09-10T01:00:00Z'}}]}));
 const result=await aggregateCalendarPreview({sources,read,signal:new AbortController().signal});
 expect(read.mock.calls.map(([id])=>id)).toEqual(['work','private']);expect(result.items.map(i=>i.calendar?.title)).toEqual(['プライベート','仕事']);
});
it('never reports a partial read as a complete calendar result',async()=>{
 await expect(aggregateCalendarPreview({sources,signal:new AbortController().signal,read:async()=>{throw Error('unavailable');}})).rejects.toThrow();
});
it('makes no calls after cancellation',async()=>{const c=new AbortController();c.abort();const read=vi.fn();await expect(aggregateCalendarPreview({sources,read,signal:c.signal})).rejects.toThrow();expect(read).not.toHaveBeenCalled();});
