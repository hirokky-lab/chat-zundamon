import type { GoogleAssistantItem, GoogleAssistantServiceName } from '../../../packages/domain/src/google-assistant.js';
import { GoogleAssistantError, type GoogleAssistantProvider } from './google-assistant.js';
import type { GoogleCalendarTasksAccessTokenProvider } from './google-calendar-tasks-provider.js';
import type { RequestUser } from './request-user.js';
export type GoogleAssistantTransport = (input: {
    url: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    headers: Record<string, string>;
    body?: unknown;
    signal: AbortSignal;
}) => Promise<unknown>;
export function createGoogleAssistantProvider(input: {
    tokens: GoogleCalendarTasksAccessTokenProvider;
    connectionIdentity?: (owner: RequestUser, service: GoogleAssistantServiceName) => Promise<string>;
    canWrite: (owner: RequestUser, service: GoogleAssistantServiceName) => Promise<boolean>;
    beforeRequest?: (owner: RequestUser, service: GoogleAssistantServiceName) => Promise<void>;
    transport?: GoogleAssistantTransport;
    now?: () => Date;
}): GoogleAssistantProvider {
    const transport = input.transport ?? fetchTransport;
    const now = input.now ?? (() => new Date());
    async function request(owner: RequestUser, service: GoogleAssistantServiceName, url: URL, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', body?: unknown, version?: string, expectedConnectionBinding?: string) { const signal = AbortSignal.timeout(15000); await input.beforeRequest?.(owner, service); if (method !== 'GET' && !await input.canWrite(owner, service))
        throw new GoogleAssistantError('unavailable'); const token = await input.tokens.getAccessToken({ owner, service, signal, ...(expectedConnectionBinding ? { expectedConnectionBinding } : {}), ...(method !== "GET" ? { requireWrite: true } : {}) }); if (signal.aborted)
        throw new GoogleAssistantError('unavailable'); return transport({ url: url.toString(), method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json', ...(version ? { 'if-match': version } : {}) }, ...(body ? { body } : {}), signal }); }
    return {
        ...(input.connectionIdentity ? { connectionIdentity: input.connectionIdentity } : {}),
        async list(owner, r) { const url = endpoint(r.service, r.sourceId); url.searchParams.set('maxResults', '50'); if (r.pageToken)
            url.searchParams.set('pageToken', r.pageToken); if (r.service === 'calendar') {
            url.searchParams.set('singleEvents', 'true');
            url.searchParams.set('orderBy', 'startTime');
            url.searchParams.set('timeMin', r.timeMin!);
            url.searchParams.set('timeMax', r.timeMax!);
        }
        else {
            url.searchParams.set('showCompleted', 'false');
            url.searchParams.set('showDeleted', 'false');
            url.searchParams.set('showHidden', 'false');
            if (r.timeMin)
                url.searchParams.set('dueMin', r.timeMin);
            if (r.timeMax)
                url.searchParams.set('dueMax', r.timeMax);
        } const raw = await request(owner, r.service, url); if (!obj(raw) || raw.items !== undefined && !Array.isArray(raw.items) || Array.isArray(raw.items) && raw.items.length > 50 || raw.nextPageToken !== undefined && !text(raw.nextPageToken, 2048))
            throw new GoogleAssistantError('unavailable'); return { service: r.service, sourceId: r.sourceId, fetchedAt: now().toISOString(), items: ((raw.items ?? []) as unknown[]).map(x => parseItem(x, r.service, r.sourceId)), ...(raw.nextPageToken ? { nextPageToken: raw.nextPageToken as string } : {}), ...(r.timeMin ? { timeMin: r.timeMin } : {}), ...(r.timeMax ? { timeMax: r.timeMax } : {}) }; },
        async get(owner, service, sourceId, id, connectionBinding) { const item = parseItem(await request(owner, service, endpoint(service, sourceId, id), "GET", undefined, undefined, connectionBinding), service, sourceId); if (item.id !== id)
            throw new GoogleAssistantError('unavailable'); return item; },
        async remove(owner,op) {
            if(op.request.service!=='calendar'||!op.before||op.before.unsupported)throw new GoogleAssistantError('invalid_request');
            const url=endpoint('calendar',op.request.sourceId,op.before.id);
            url.searchParams.set('sendUpdates','none');
            await request(owner,'calendar',url,'DELETE',undefined,op.before.version,op.connectionBinding);
            try {
                const after=await request(owner,'calendar',endpoint('calendar',op.request.sourceId,op.before.id),'GET',undefined,undefined,op.connectionBinding);
                if(!obj(after)||after.id!==op.before.id||after.status!=='cancelled')throw new GoogleAssistantError('unavailable');
            } catch(error) {
                if(!(error instanceof GoogleEventGone))throw error;
            }
        },
        async write(owner, op) { const r = op.request; if (op.before?.unsupported)
            throw new GoogleAssistantError('conflict'); const body: Record<string, unknown> = {}; const c = r.changes; if (c.title !== undefined)
            body[r.service === 'calendar' ? 'summary' : 'title'] = c.title; if (c.notes !== undefined)
            body[r.service === 'calendar' ? 'description' : 'notes'] = c.notes; if (c.start !== undefined)
            body.start = { dateTime: c.start }; if (c.end !== undefined)
            body.end = { dateTime: c.end }; if (c.due !== undefined)
            body.due = c.due === null ? null : `${c.due}T00:00:00.000Z`; if (c.completed !== undefined) {
            body.status = c.completed ? 'completed' : 'needsAction';
            if (!c.completed)
                body.completed = null;
        } if (r.service === 'calendar' && r.action === 'create')
            body.id = 'e' + op.operationId.replace(/-/g, ''); const url = endpoint(r.service, r.sourceId, r.itemId); if (r.service === 'calendar')
            url.searchParams.set('sendUpdates', 'none'); const raw = await request(owner, r.service, url, r.action === 'create' ? 'POST' : 'PATCH', body, op.before?.version, op.connectionBinding); return parseItem(raw, r.service, r.sourceId); }
    };
}
function endpoint(service: GoogleAssistantServiceName, source: string, id?: string): URL { const encode = (x: string) => { if (!text(x, 1024) || x === '.' || x === '..')
    throw new GoogleAssistantError('invalid_request'); return encodeURIComponent(x); }; return new URL(service === 'calendar' ? `https://www.googleapis.com/calendar/v3/calendars/${encode(source)}/events${id ? '/' + encode(id) : ''}` : `https://tasks.googleapis.com/tasks/v1/lists/${encode(source)}/tasks${id ? '/' + encode(id) : ''}`); }
function obj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v: unknown, max = 8000): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000]/u.test(v); }
function parseItem(raw: unknown, service: GoogleAssistantServiceName, sourceId: string): GoogleAssistantItem { if (!obj(raw) || !text(raw.id, 1024) || !text(raw.etag, 1024))
    throw new GoogleAssistantError('unavailable'); const title = service === 'calendar' ? raw.summary : raw.title; if (typeof title !== 'string' || title.length > 1024)
    throw new GoogleAssistantError('unavailable'); const notes = service === 'calendar' ? raw.description : raw.notes; if (notes !== undefined && (typeof notes !== 'string' || notes.length > 8000))
    throw new GoogleAssistantError('unavailable'); const base: GoogleAssistantItem = { service, sourceId, id: raw.id, version: raw.etag, title, ...(notes ? { notes: notes as string } : {}) }; if (service === 'calendar') {
    if (!obj(raw.start) || !obj(raw.end))
        throw new GoogleAssistantError('unavailable');
    const start = raw.start.dateTime ?? raw.start.date;
    const end = raw.end.dateTime ?? raw.end.date;
    if (!text(start, 64) || !text(end, 64) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)))
        throw new GoogleAssistantError('unavailable');
    return { ...base, start, end, ...(raw.recurrence !== undefined || raw.recurringEventId !== undefined || raw.attendees !== undefined || raw.eventType !== undefined && raw.eventType !== 'default' || raw.start.date !== undefined || raw.status === 'cancelled' ? { unsupported: true } : {}) };
} if (raw.status !== 'completed' && raw.status !== 'needsAction')
    throw new GoogleAssistantError('unavailable'); if (raw.due !== undefined && (!text(raw.due, 64) || !Number.isFinite(Date.parse(raw.due))))
    throw new GoogleAssistantError('unavailable'); return { ...base, completed: raw.status === 'completed', ...(typeof raw.due === 'string' ? { due: raw.due.slice(0, 10) } : {}), ...(raw.assignmentInfo !== undefined || raw.deleted === true ? { unsupported: true } : {}) }; }
class GoogleEventGone extends Error {}
async function fetchTransport(input: Parameters<GoogleAssistantTransport>[0]): Promise<unknown> { const r = await fetch(input.url, { method: input.method, headers: input.headers, signal: input.signal, redirect: 'error', ...(input.body ? { body: JSON.stringify(input.body) } : {}) }); if(input.method==='GET'&&(r.status===404||r.status===410))throw new GoogleEventGone(); if(input.method==='DELETE'&&r.status===204)return null; if (r.status === 412)
    throw new GoogleAssistantError('conflict'); if (!r.ok)
    throw new GoogleAssistantError('unavailable'); const max = 512 * 1024; const length = r.headers.get('content-length'); if (length !== null && (!/^\d+$/u.test(length) || Number(length) > max))
    throw new GoogleAssistantError('unavailable'); const reader = r.body?.getReader(); if (!reader)
    throw new GoogleAssistantError('unavailable'); const chunks: Uint8Array[] = []; let total = 0; try {
    while (true) {
        const next = await reader.read();
        if (next.done)
            break;
        total += next.value.byteLength;
        if (total > max) {
            await reader.cancel();
            throw new GoogleAssistantError('unavailable');
        }
        chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
finally {
    reader.releaseLock();
} }
