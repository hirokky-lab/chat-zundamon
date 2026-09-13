import { it, expect } from 'vitest';
import { createHostedGoogleAssistantService, createSupabaseGoogleAssistantRepository } from './google-assistant-hosted.js';
import { makeInMemoryGoogleCalendarTasksOAuthRepository } from './google-oauth.js';
import { googleAssistantScopes } from './google-assistant-oauth.js';
import { LOCAL_USER as owner } from './request-user.js';
it('hosted read uses owner-bound credentials and durable quota independent of home visibility', async () => { const repo = makeInMemoryGoogleCalendarTasksOAuthRepository(); await repo.saveConnection({ ownerId: owner.userId, service: 'tasks', googleSubject: 'sub', grantedScopes: googleAssistantScopes('tasks'), refreshToken: Buffer.from('fixture') }); const calls: {
    ownerId: string;
    name: string;
    args: Record<string, unknown>;
}[] = []; const service = createHostedGoogleAssistantService({ rpcForOwner: ownerId => ({ rpc: async (name, args) => { calls.push({ ownerId, name, args }); return { data: true, error: null }; } }), oauthRepository: repo, tokens: { getAccessToken: async () => 'fixture' }, key: Buffer.alloc(32, 1), keyVersion: '1', flags: { calendarRead: false, tasksRead: true, calendarWrite: false, tasksWrite: false }, transport: async () => ({ items: [{ id: 'task', etag: 'v1', title: 'readable', status: 'needsAction' }], nextPageToken: 'next' }) }); expect(await service.list({ owner, request: { service: 'tasks', sourceId: 'list' } })).toMatchObject({ items: [{ title: 'readable', version: 'v1' }], nextPageToken: 'next' }); expect(calls.map(x => x.name)).toEqual(['acquire_google_calendar_tasks_quota', 'commit_google_calendar_tasks_quota']); expect(calls.every(x => x.ownerId === owner.userId && !('p_owner_id' in x.args))).toBe(true); await expect(service.list({ owner: { ...owner, userId: 'other' }, request: { service: 'tasks', sourceId: 'list' } })).rejects.toThrow('unavailable'); });
it('repository rejects a cross-owner RPC response', async () => { const repo = createSupabaseGoogleAssistantRepository({ rpcForOwner: () => ({ rpc: async () => ({ data: { ownerId: 'other' }, error: null }) }) }); await expect(repo.get(owner.userId, 'id')).rejects.toThrow('unavailable'); });
