import { describe, it, expect } from 'vitest';
import { isLifeServiceRequest, parseTalkLifeIntent, calendarWindow } from '../src/talk-life-intent.js';

describe('talk life intent boundary', () => {
 it('admits natural requests and follow-up edits without diverting greetings', () => {
  for (const value of ['明日の仕事の予定は？','未完了のタスク見せて','この予定を15時にして','これ完了にして','明日傘いる？','家から立川駅への道','自宅は立川市で覚えて']) expect(isLifeServiceRequest(value)).toBe(true);
  expect(isLifeServiceRequest('おはよう')).toBe(false);
 });
 it('rejects model-supplied source IDs and malformed date operations', () => {
  expect(parseTalkLifeIntent({kind:'calendar_read', sourceId:'injected'})).toBe(null);
  expect(parseTalkLifeIntent({kind:'calendar_read',dateFrom:'2026-02-31'})).toBe(null);
  expect(parseTalkLifeIntent({kind:'google_update',service:'tasks',completed:true})).toMatchObject({kind:'google_update',completed:true});
 });
 it('builds tomorrow in the user timezone, not UTC', () => {
  expect(calendarWindow('2026-09-06','2026-09-06',new Date('2026-09-05T08:00:00Z'),'Asia/Tokyo')).toEqual({timeMin:'2026-09-05T15:00:00.000Z',timeMax:'2026-09-06T15:00:00.000Z'});
 });
 it('rejects reversed and oversized ranges', () => {
  expect(()=>calendarWindow('2026-09-06','2026-09-05',new Date(),'Asia/Tokyo')).toThrow();
  expect(()=>calendarWindow('2026-09-01','2026-11-01',new Date(),'Asia/Tokyo')).toThrow();
 });
});
it('routes media link requests without requiring the word Drive',()=>{expect(isLifeServiceRequest('レミ蓋の動画リンク一つ')).toBe(true);expect(isLifeServiceRequest('資料の写真を探して')).toBe(true);});
