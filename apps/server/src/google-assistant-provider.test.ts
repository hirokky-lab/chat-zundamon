import { it, expect } from 'vitest';
import { createGoogleAssistantProvider } from './google-assistant-provider.js';
import { LOCAL_USER } from './request-user.js';
it('uses fixed encoded Google endpoints, bounded pagination and If-Match writes', async () => { const calls: any[] = []; const provider = createGoogleAssistantProvider({ tokens: { getAccessToken: async () => 'fixture' }, canWrite: async () => true, transport: async (input) => { calls.push(input); return { id: 'event', etag: 'v1', summary: 'title', start: { dateTime: '2026-09-05T01:00:00Z' }, end: { dateTime: '2026-09-05T02:00:00Z' } }; } }); const before = await provider.get(LOCAL_USER, 'calendar', 'work/x', 'event'); await provider.write(LOCAL_USER, { operationId: 'abcd', signature: 's', keyVersion: '1', expiresAt: '2026-09-05T03:00:00Z', state: 'executing', before, request: { service: 'calendar', sourceId: 'work/x', itemId: 'event', version: 'v1', action: 'update', changes: { title: 'new' } } }); expect(calls[0].url).toContain('work%2Fx/events/event'); expect(calls[1].headers['if-match']).toBe('v1'); expect(calls[1].body).toEqual({ summary: 'new' }); });
it('rejects unsafe provider event edits and write credentials', async () => { const p = createGoogleAssistantProvider({ tokens: { getAccessToken: async () => 'fixture' }, canWrite: async () => false, transport: async () => ({ id: 'event', etag: 'v1', summary: 'title', attendees: [{ email: 'a' }], start: { dateTime: '2026-09-05T01:00:00Z' }, end: { dateTime: '2026-09-05T02:00:00Z' } }) }); expect((await p.get(LOCAL_USER, 'calendar', 'list', 'event')).unsupported).toBe(true); await expect(p.write(LOCAL_USER, { operationId: 'a', signature: 's', keyVersion: '1', expiresAt: 'x', state: 'executing', before: null, request: { service: 'tasks', sourceId: 'list', action: 'create', changes: { title: 'new' } } })).rejects.toThrow('unavailable'); });
it('deletes with If-Match and verifies the cancellation without resending',async()=>{
 const calls:any[]=[];
 const before={service:'calendar' as const,sourceId:'work/x',id:'event',version:'v1',title:'テスト',start:'2026-09-10T01:00:00Z',end:'2026-09-10T02:00:00Z'};
 const p=createGoogleAssistantProvider({tokens:{getAccessToken:async()=> 'fixture'},canWrite:async()=>true,transport:async input=>{calls.push(input);return input.method==='DELETE'?null:{id:'event',status:'cancelled'};}});
 await p.remove!(LOCAL_USER,{operationId:'op',signature:'s',keyVersion:'v1',expiresAt:'2026-09-10T00:00:00Z',state:'executing',before,request:{service:'calendar',sourceId:'work/x',itemId:'event',version:'v1',action:'delete',changes:{}}});
 expect(calls.map(c=>c.method)).toEqual(['DELETE','GET']);
 expect(calls[0].headers['if-match']).toBe('v1');
 expect(calls[0].body).toBeUndefined();
 expect(calls[0].url).toContain('work%2Fx/events/event');
});
