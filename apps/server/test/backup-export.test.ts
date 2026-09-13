import { describe, expect, it } from 'vitest';
import { createSupabaseBackupRepository } from '../src/backup';

describe('complete backup export', () => {
  it('reads beyond the API row limit with stable owner and primary key ordering', async () => {
    const requests: URL[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input)); requests.push(url);
      const offset = Number(url.searchParams.get('offset'));
      const length = url.pathname.endsWith('/usage_events') ? Math.min(500, 1203 - offset) : 0;
      return Response.json(Array.from({ length }, (_, index) => ({ user_id: 'owner', session_id: String(offset + index), payload: {}, created_at: '2026-09-13T00:00:00Z' })));
    };
    const result = await createSupabaseBackupRepository('https://example.supabase.co', 'fixture', fetchImpl).exportAll();
    expect(result.usageEvents).toHaveLength(1203);
    const pages = requests.filter(url => url.pathname.endsWith('/usage_events'));
    expect(pages.map(url => url.searchParams.get('offset'))).toEqual(['0', '500', '1000']);
    expect(pages.every(url => url.searchParams.get('order') === 'user_id.asc,session_id.asc')).toBe(true);
  });
  it('rejects a later failed page instead of returning a partial archive', async () => {
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/memories')) return Response.json([]);
      if (url.searchParams.get('offset') !== '0') return Response.json({ message: 'unavailable' }, { status: 403 });
      return Response.json(Array.from({ length: 500 }, (_, id) => ({ user_id: 'owner', id: String(id) })));
    };
    await expect(createSupabaseBackupRepository('https://example.supabase.co', 'fixture', fetchImpl).exportAll()).rejects.toThrow('Backup export unavailable');
  });
});
