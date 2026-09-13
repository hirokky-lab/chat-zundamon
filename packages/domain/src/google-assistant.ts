export type GoogleAssistantServiceName = 'calendar' | 'tasks';
export type GoogleAssistantItem = {
    service: GoogleAssistantServiceName;
    sourceId: string;
    id: string;
    version: string;
    title: string;
    notes?: string;
    start?: string;
    end?: string;
    due?: string;
    completed?: boolean;
    unsupported?: boolean;
};
export type GoogleAssistantListRequest = {
    service: GoogleAssistantServiceName;
    sourceId: string;
    timeMin?: string;
    timeMax?: string;
    pageToken?: string;
};
export type GoogleAssistantListResult = {
    service: GoogleAssistantServiceName;
    sourceId: string;
    fetchedAt: string;
    items: GoogleAssistantItem[];
    nextPageToken?: string;
    timeMin?: string;
    timeMax?: string;
};
export type GoogleAssistantChanges = {
    title?: string;
    notes?: string;
    start?: string;
    end?: string;
    due?: string | null;
    completed?: boolean;
};
export type GoogleAssistantPrepareRequest = {
    service: GoogleAssistantServiceName;
    sourceId: string;
    action: 'create' | 'update' | 'complete' | 'delete';
    itemId?: string;
    version?: string;
    changes: GoogleAssistantChanges;
};
export type GoogleAssistantOperation = {
    operationId: string;
    signature: string;
    keyVersion: string;
    expiresAt: string;
    state: 'prepared' | 'executing' | 'succeeded' | 'cancelled' | 'expired' | 'conflict' | 'unknown';
    request: GoogleAssistantPrepareRequest;
    before: GoogleAssistantItem | null;
    result?: GoogleAssistantItem;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/u.test(v);
const instant = (v: unknown): v is string => str(v, 64) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(v) && Number.isFinite(Date.parse(v));
export function isGoogleAssistantListRequest(v: unknown): v is GoogleAssistantListRequest { return object(v) && Object.keys(v).every(k => ['service', 'sourceId', 'timeMin', 'timeMax', 'pageToken'].includes(k)) && (v.service === 'calendar' || v.service === 'tasks') && str(v.sourceId) && (v.pageToken === undefined || str(v.pageToken, 2048)) && (v.timeMin === undefined || instant(v.timeMin)) && (v.timeMax === undefined || instant(v.timeMax)) && (v.service !== 'calendar' || (instant(v.timeMin) && instant(v.timeMax) && Date.parse(v.timeMax) > Date.parse(v.timeMin) && Date.parse(v.timeMax) - Date.parse(v.timeMin) <= 31 * 86400000)); }
export function isGoogleAssistantPrepareRequest(v: unknown): v is GoogleAssistantPrepareRequest {
    if (!object(v) || !Object.keys(v).every(k => ['service', 'sourceId', 'action', 'itemId', 'version', 'changes'].includes(k)) || !['calendar', 'tasks'].includes(String(v.service)) || !str(v.sourceId) || !['create', 'update', 'complete', 'delete'].includes(String(v.action)) || !object(v.changes))
        return false;
    const c = v.changes;
    if(v.action==='delete')return v.service==='calendar' && str(v.itemId) && str(v.version) && Object.keys(c).length===0;
    if (!Object.keys(c).length || !Object.keys(c).every(k => ['title', 'notes', 'start', 'end', 'due', 'completed'].includes(k)))
        return false;
    if (c.title !== undefined && !str(c.title, 1024) || c.notes !== undefined && (typeof c.notes !== 'string' || c.notes.length > 8000) || c.start !== undefined && !instant(c.start) || c.end !== undefined && !instant(c.end) || c.completed !== undefined && typeof c.completed !== 'boolean' || c.due !== undefined && c.due !== null && !(typeof c.due === 'string' && /^\d{4}-\d\d-\d\d$/u.test(c.due) && Number.isFinite(Date.parse(c.due)) && new Date(c.due).toISOString().slice(0, 10) === c.due))
        return false;
    if (v.action === 'create' ? v.itemId !== undefined || v.version !== undefined || !str(c.title) : !str(v.itemId) || !str(v.version))
        return false;
    if (v.service === 'calendar')
        return v.action !== 'complete' && c.due === undefined && c.completed === undefined && (v.action !== 'create' || instant(c.start) && instant(c.end)) && !(instant(c.start) && instant(c.end) && Date.parse(c.end) <= Date.parse(c.start));
    return c.start === undefined && c.end === undefined && (v.action !== 'complete' || Object.keys(c).length === 1 && typeof c.completed === 'boolean');
}
