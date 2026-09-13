import { acceptedGoogleReadScopes, googleReadScopes, type GoogleService } from './google-calendar-tasks.js';
export type GoogleOAuthPurpose = 'read' | 'write';
export const googleAssistantWriteScope = (service: GoogleService): string => service === 'calendar' ? 'https://www.googleapis.com/auth/calendar.events' : 'https://www.googleapis.com/auth/tasks';
export function googleAssistantScopes(service: GoogleService, purpose: GoogleOAuthPurpose = 'read'): readonly string[] { return [...googleReadScopes(service), ...(purpose === 'write' ? [googleAssistantWriteScope(service)] : [])]; }
export function acceptedGoogleAssistantScopes(scopes: readonly string[], service: GoogleService, purpose: GoogleOAuthPurpose = 'read'): boolean { if (purpose === 'read')
    return acceptedGoogleReadScopes(scopes, service); const expected = googleAssistantScopes(service, 'write'); return scopes.length === expected.length && new Set(scopes).size === scopes.length && expected.every(scope => scopes.includes(scope)); }
export function acceptedGoogleConnectionScopes(scopes: readonly string[], service: GoogleService): boolean { return acceptedGoogleAssistantScopes(scopes, service, 'read') || acceptedGoogleAssistantScopes(scopes, service, 'write'); }
