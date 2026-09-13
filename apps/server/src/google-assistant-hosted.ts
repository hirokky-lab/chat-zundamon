import { googleConnectionBinding } from './google-assistant-connection-binding.js';
import { randomUUID } from 'node:crypto';
import { createGoogleAssistantService, GoogleAssistantError, type GoogleAssistantRecord, type GoogleAssistantRepository } from './google-assistant.js';
import { createGoogleAssistantProvider, type GoogleAssistantTransport } from './google-assistant-provider.js';
import { acceptedGoogleAssistantScopes, acceptedGoogleConnectionScopes } from './google-assistant-oauth.js';
import type { GoogleCalendarTasksOAuthRepository } from './google-oauth.js';
import type { GoogleCalendarTasksAccessTokenProvider } from './google-calendar-tasks-provider.js';
import { isGoogleAssistantPrepareRequest } from '../../../packages/domain/src/google-assistant.js';
export type GoogleAssistantRpcClient = {
    rpc(name: string, args: Record<string, unknown>): Promise<{
        data: unknown;
        error: unknown;
    }>;
};
export function createSupabaseGoogleAssistantRepository(input: {
    rpcForOwner: (ownerId: string) => GoogleAssistantRpcClient;
}): GoogleAssistantRepository {
    async function invoke(ownerId: string, name: string, args: Record<string, unknown>) { const r = await input.rpcForOwner(ownerId).rpc(name, args); if (r.error)
        throw new GoogleAssistantError('unavailable'); return r.data; }
    return { async put(record) { await invoke(record.ownerId, 'put_google_assistant_operation', { p_record: record }); }, async get(ownerId, id) { const r = await invoke(ownerId, 'get_google_assistant_operation', { p_operation_id: id }); if (r === null)
            return null; if (!r || typeof r !== 'object' || Array.isArray(r))
            throw new GoogleAssistantError('unavailable'); const record = r as GoogleAssistantRecord; if (record.ownerId !== ownerId || record.operationId !== id || typeof record.signature !== 'string' || typeof record.expiresAt !== 'string' || !Number.isFinite(Date.parse(record.expiresAt)) || !isGoogleAssistantPrepareRequest(record.request) || !['prepared', 'executing', 'succeeded', 'cancelled', 'expired', 'conflict', 'unknown'].includes(record.state))
            throw new GoogleAssistantError('unavailable'); return record; }, async transition(ownerId, id, from, to, result) { return await invoke(ownerId, 'transition_google_assistant_operation', { p_operation_id: id, p_from: from, p_to: to, p_result: result ?? null }) === true; } };
}
export function createHostedGoogleAssistantService(input: {
    rpcForOwner: (ownerId: string) => GoogleAssistantRpcClient;
    oauthRepository: GoogleCalendarTasksOAuthRepository;
    tokens: GoogleCalendarTasksAccessTokenProvider;
    key: Buffer;
    keyVersion: string;
    flags: Parameters<typeof createGoogleAssistantService>[0]['flags'];
    transport?: GoogleAssistantTransport;
    now?: () => Date;
}) {
    const provider = createGoogleAssistantProvider({ connectionIdentity: async (owner, service) => { const c = await input.oauthRepository.getConnectionForOwner({ ownerId: owner.userId, service }); if (!c)
            throw new GoogleAssistantError('unavailable'); return googleConnectionBinding(c); }, tokens: input.tokens, transport: input.transport, now: input.now, canWrite: async (owner, service) => { const c = await input.oauthRepository.getConnectionForOwner({ ownerId: owner.userId, service }); return !!c && acceptedGoogleAssistantScopes(c.grantedScopes, service, 'write'); }, beforeRequest: async (owner, service) => { const c = await input.oauthRepository.getConnectionForOwner({ ownerId: owner.userId, service }); if (!c || !acceptedGoogleConnectionScopes(c.grantedScopes, service))
            throw new GoogleAssistantError('unavailable'); const rpc = input.rpcForOwner(owner.userId); const requestId = 'assistant:' + randomUUID(); const r = await rpc.rpc('acquire_google_calendar_tasks_quota', { p_service: service, p_request_id: requestId }); if (r.error || r.data !== true)
            throw new GoogleAssistantError('unavailable'); const commit = await rpc.rpc('commit_google_calendar_tasks_quota', { p_service: service, p_request_id: requestId }); if (commit.error || commit.data !== true)
            throw new GoogleAssistantError('unavailable'); } });
    return createGoogleAssistantService({ repository: createSupabaseGoogleAssistantRepository(input), provider, key: input.key, keyVersion: input.keyVersion, flags: input.flags, now: input.now });
}
