import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isGoogleAssistantListRequest, isGoogleAssistantPrepareRequest, type GoogleAssistantItem, type GoogleAssistantListRequest, type GoogleAssistantListResult, type GoogleAssistantOperation, type GoogleAssistantPrepareRequest, type GoogleAssistantServiceName } from '../../../packages/domain/src/google-assistant.js';
import type { RequestUser } from './request-user.js';
export type GoogleAssistantRecord = GoogleAssistantOperation & {
    ownerId: string;
    connectionBinding?: string;
};
export type GoogleAssistantRepository = {
    put(record: GoogleAssistantRecord): Promise<void>;
    get(ownerId: string, id: string): Promise<GoogleAssistantRecord | null>;
    transition(ownerId: string, id: string, from: GoogleAssistantOperation['state'], to: GoogleAssistantOperation['state'], result?: GoogleAssistantItem): Promise<boolean>;
};
export type GoogleAssistantProvider = {
    remove?(owner: RequestUser, operation: GoogleAssistantOperation & {connectionBinding?:string}):Promise<void>;
    connectionIdentity?(owner: RequestUser, service: GoogleAssistantServiceName): Promise<string>;
    list(owner: RequestUser, request: GoogleAssistantListRequest): Promise<GoogleAssistantListResult>;
    get(owner: RequestUser, service: GoogleAssistantServiceName, sourceId: string, id: string, connectionBinding?: string): Promise<GoogleAssistantItem>;
    write(owner: RequestUser, operation: GoogleAssistantOperation & { connectionBinding?: string }): Promise<GoogleAssistantItem>;
};
export type GoogleAssistantService = {
    list(input: {
        owner: RequestUser;
        request: GoogleAssistantListRequest;
    }): Promise<GoogleAssistantListResult>;
    prepare(input: {
        owner: RequestUser;
        request: GoogleAssistantPrepareRequest;
    }): Promise<GoogleAssistantOperation>;
    confirm(input: {
        owner: RequestUser;
        operationId: string;
        signature: string;
    }): Promise<GoogleAssistantOperation>;
    cancel(input: {
        owner: RequestUser;
        operationId: string;
    }): Promise<GoogleAssistantOperation>;
    status(input: {
        owner: RequestUser;
        operationId: string;
    }): Promise<GoogleAssistantOperation>;
};
export class GoogleAssistantError extends Error {
    constructor(public code: 'invalid_request' | 'unavailable' | 'not_found' | 'invalid_signature' | 'conflict') { super(code); }
}
export function createGoogleAssistantService(input: {
    repository: GoogleAssistantRepository;
    provider: GoogleAssistantProvider;
    key: Buffer;
    keyVersion: string;
    flags: {
        calendarRead: boolean;
        tasksRead: boolean;
        calendarWrite: boolean;
        tasksWrite: boolean;
    };
    now?: () => Date;
}): GoogleAssistantService {
    if (input.key.length !== 32 || !input.keyVersion)
        throw new Error('Invalid operation key');
    const now = input.now ?? (() => new Date());
    const repo = input.repository;
    function guard(owner: RequestUser, service: GoogleAssistantServiceName, write = false) { if (!owner?.userId)
        throw new GoogleAssistantError('unavailable'); if (!input.flags[service === 'calendar' ? 'calendarRead' : 'tasksRead'] || write && !input.flags[service === 'calendar' ? 'calendarWrite' : 'tasksWrite'])
        throw new GoogleAssistantError('unavailable'); }
    function signature(r: Omit<GoogleAssistantRecord, 'signature'>) { return createHmac('sha256', input.key).update('yui-google-assistant-operation-v1\n').update(canonicalJson([r.ownerId, r.operationId, r.keyVersion, r.expiresAt, r.request, r.before, r.connectionBinding ?? null])).digest('base64url'); }
    async function get(owner: RequestUser, id: string) { if (!owner?.userId || typeof id !== 'string' || id.length > 100)
        throw new GoogleAssistantError('not_found'); const r = await repo.get(owner.userId, id); if (!r || r.ownerId !== owner.userId)
        throw new GoogleAssistantError('not_found'); if (r.state === 'executing' && Date.parse(r.expiresAt) + 60000 <= now().getTime()) {
        await repo.transition(owner.userId, id, 'executing', 'unknown');
        return (await repo.get(owner.userId, id))!;
    } if (r.state === 'prepared' && Date.parse(r.expiresAt) <= now().getTime()) {
        await repo.transition(owner.userId, id, 'prepared', 'expired');
        return (await repo.get(owner.userId, id))!;
    } return r; }
    function publicRecord(r: GoogleAssistantRecord): GoogleAssistantOperation { const { ownerId: _, connectionBinding: _binding, ...out } = r; return out; }
    const service: GoogleAssistantService = {
        async list({ owner, request }) { if (!isGoogleAssistantListRequest(request))
            throw new GoogleAssistantError('invalid_request'); guard(owner, request.service); return input.provider.list(owner, request); },
        async prepare({ owner, request }) { if (!isGoogleAssistantPrepareRequest(request))
            throw new GoogleAssistantError('invalid_request'); guard(owner, request.service, true); const connectionBinding = await input.provider.connectionIdentity?.(owner, request.service); const frozen = structuredClone(request); const before = request.action === 'create' ? null : await input.provider.get(owner, request.service, request.sourceId, request.itemId!, connectionBinding); if (before && (before.version !== request.version || before.unsupported || before.id !== request.itemId || before.sourceId !== request.sourceId))
            throw new GoogleAssistantError('conflict'); if (request.service === 'calendar') {
            const start = request.changes.start ?? before?.start;
            const end = request.changes.end ?? before?.end;
            if (!start || !end || Date.parse(end) <= Date.parse(start))
                throw new GoogleAssistantError('invalid_request');
        } const r: GoogleAssistantRecord = { ownerId: owner.userId, ...(connectionBinding ? { connectionBinding } : {}), operationId: randomUUID(), signature: '', keyVersion: input.keyVersion, expiresAt: new Date(now().getTime() + 300000).toISOString(), state: 'prepared', request: frozen, before }; r.signature = signature(r); await repo.put(r); return publicRecord(r); },
        async status({ owner, operationId }) { return publicRecord(await get(owner, operationId)); },
        async cancel({ owner, operationId }) { await get(owner, operationId); await repo.transition(owner.userId, operationId, 'prepared', 'cancelled'); return service.status({ owner, operationId }); },
        async confirm({ owner, operationId, signature: supplied }) {
            const r = await get(owner, operationId);
            guard(owner, r.request.service, true);
            const expected = signature(r);
            if (r.keyVersion !== input.keyVersion || typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)) || r.signature !== expected)
                throw new GoogleAssistantError('invalid_signature');
            if (r.state !== 'prepared')
                return publicRecord(r);
            if (!await repo.transition(owner.userId, operationId, 'prepared', 'executing'))
                return service.status({ owner, operationId });
            let writeStarted = false;
            try {
                if (r.connectionBinding && r.connectionBinding !== await input.provider.connectionIdentity?.(owner, r.request.service))
                    throw new GoogleAssistantError('conflict');
                if (r.before) {
                    const current = await input.provider.get(owner, r.request.service, r.request.sourceId, r.before.id, r.connectionBinding);
                    if (current.version !== r.before.version || current.unsupported) {
                        await repo.transition(owner.userId, operationId, 'executing', 'conflict');
                        return service.status({ owner, operationId });
                    }
                }
                guard(owner, r.request.service, true);
                writeStarted = true;
                if(r.request.action==='delete') {
                    if(!input.provider.remove)throw new GoogleAssistantError('unavailable');
                    await input.provider.remove(owner,r);
                    await repo.transition(owner.userId,operationId,'executing','succeeded');
                    return service.status({owner,operationId});
                }
                const written = await input.provider.write(owner, r);
                const read = await input.provider.get(owner, r.request.service, r.request.sourceId, written.id, r.connectionBinding);
                const matches = Object.entries(r.request.changes).every(([k, v]) => v === null ? read[k as keyof GoogleAssistantItem] === undefined : k === 'notes' && v === '' ? !read.notes : (k === 'start' || k === 'end') ? Date.parse(String(read[k])) === Date.parse(String(v)) : read[k as keyof GoogleAssistantItem] === v);
                await repo.transition(owner.userId, operationId, 'executing', matches ? 'succeeded' : 'unknown', matches ? read : undefined);
            }
            catch (e) {
                await repo.transition(owner.userId, operationId, 'executing', e instanceof GoogleAssistantError && e.code === 'conflict' ? 'conflict' : writeStarted ? 'unknown' : 'conflict');
            }
            return service.status({ owner, operationId });
        }
    };
    return service;
}
export function makeInMemoryGoogleAssistantRepository(): GoogleAssistantRepository { const rows = new Map<string, GoogleAssistantRecord>(); const key = (o: string, i: string) => o + ':' + i; return { async put(r) { if (rows.has(key(r.ownerId, r.operationId)))
        throw new Error('duplicate'); rows.set(key(r.ownerId, r.operationId), structuredClone(r)); }, async get(o, i) { return structuredClone(rows.get(key(o, i)) ?? null); }, async transition(o, i, from, to, result) { const r = rows.get(key(o, i)); if (!r || r.state !== from)
        return false; r.state = to; if (result)
        r.result = structuredClone(result); return true; } }; }
export function registerGoogleAssistantRoutes(app: FastifyInstance, service: GoogleAssistantService): void {
    const handle = (fn: (owner: RequestUser, body: any, params: any) => Promise<unknown>) => async (request: any, reply: any) => { reply.header('cache-control', 'no-store'); if (!request.yuiUser)
        return reply.code(401).send({ error: 'Authentication required' }); try {
        return await fn(request.yuiUser, request.body, request.params);
    }
    catch (e) {
        return reply.code(e instanceof GoogleAssistantError && e.code === 'invalid_request' ? 400 : 409).send({ error: e instanceof GoogleAssistantError ? e.code : 'unavailable' });
    } };
    app.post('/api/google-assistant/list', handle((owner, request) => service.list({ owner, request })));
    app.post('/api/google-assistant/prepare', handle((owner, request) => service.prepare({ owner, request })));
    app.post('/api/google-assistant/confirm', handle((owner, b) => { if (!exactKeys(b, ['operationId', 'signature']))
        throw new GoogleAssistantError('invalid_request'); return service.confirm({ owner, operationId: b.operationId, signature: b.signature }); }));
    app.post('/api/google-assistant/cancel', handle((owner, b) => { if (!exactKeys(b, ['operationId']))
        throw new GoogleAssistantError('invalid_request'); return service.cancel({ owner, operationId: b.operationId }); }));
    app.get('/api/google-assistant/operations/:operationId', handle((owner, _, p) => service.status({ owner, operationId: p.operationId })));
}
function canonicalJson(value: unknown): string { if (Array.isArray(value))
    return '[' + value.map(canonicalJson).join(',') + ']'; if (value && typeof value === 'object')
    return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'; return JSON.stringify(value); }
function exactKeys(v: unknown, keys: string[]): v is Record<string, string> { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.sort().join(',') && Object.values(v).every(x => typeof x === 'string'); }
