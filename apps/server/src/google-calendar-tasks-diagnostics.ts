export type GoogleCalendarTasksDiagnosticReason =
  | "credential"
  | "refresh"
  | "provider_transport"
  | "response_validation"
  | "unknown";

/** Content-free internal classification. Never attach provider values or causes. */
export class GoogleCalendarTasksDiagnosticError extends Error {
  constructor(readonly reason: GoogleCalendarTasksDiagnosticReason) {
    super("Google Calendar/Tasks response unavailable");
  }
}

export function googleCalendarTasksDiagnostic(
  error: unknown,
  fallback: GoogleCalendarTasksDiagnosticReason = "unknown",
): GoogleCalendarTasksDiagnosticError {
  return error instanceof GoogleCalendarTasksDiagnosticError
    ? error
    : new GoogleCalendarTasksDiagnosticError(fallback);
}
