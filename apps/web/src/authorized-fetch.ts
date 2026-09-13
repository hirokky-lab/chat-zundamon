import type { AuthSession } from "./auth";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AuthExpiredError extends Error {
  constructor() {
    super("Authentication expired");
  }
}

function apiUrl(input: RequestInfo | URL, baseUrl: string): RequestInfo | URL {
  if (typeof input !== "string" || !input.startsWith("/api")) return input;
  return `${baseUrl.replace(/\/$/u, "")}${input}`;
}

export function createAuthorizedFetch(options: {
  apiBaseUrl: string;
  getSession: () => Promise<AuthSession | null>;
  fetchImpl?: FetchLike;
  onAuthExpired?: () => void;
}): FetchLike {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const session = await options.getSession();
    if (!session) {
      options.onAuthExpired?.();
      throw new AuthExpiredError();
    }

    const inheritedHeaders = input instanceof Request ? input.headers : undefined;
    const headers = new Headers(inheritedHeaders);
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
    headers.set("Authorization", `Bearer ${session.accessToken}`);
    const response = await fetchImpl(apiUrl(input, options.apiBaseUrl), { ...init, headers });
    if (response.status !== 401) return response;

    try {
      await response.body?.cancel();
    } catch {
      // The status code remains authoritative; never inspect an upstream body.
    }
    options.onAuthExpired?.();
    throw new AuthExpiredError();
  };
}
