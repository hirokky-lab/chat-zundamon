export type HostedBrowserConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  apiBaseUrl: string;
  photoAnalysisEnabled: boolean;
  integratedUiEnabled: boolean;
  prismEchoEnabled: boolean;
};

type BrowserEnv = Record<string, string | undefined>;

type BrowserConfigFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseHostedBrowserConfig(env: BrowserEnv): HostedBrowserConfig | null {
  const values = [env.VITE_ZUNDAMON_SUPABASE_URL, env.VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY, env.VITE_ZUNDAMON_API_BASE_URL];
  if (values.every((value) => !value?.trim())) return null;
  if (values.some((value) => !value?.trim())) throw new Error("Hosted browser configuration is incomplete");

  const supabaseUrl = httpsOrigin(env.VITE_ZUNDAMON_SUPABASE_URL!.trim());
  const rawApiBaseUrl = env.VITE_ZUNDAMON_API_BASE_URL!.trim();
  const apiBaseUrl = rawApiBaseUrl === "/" ? "" : httpsOrigin(rawApiBaseUrl);
  if (!supabaseUrl || apiBaseUrl === null) throw new Error("Hosted browser configuration is invalid");
  return {
    supabaseUrl,
    supabasePublishableKey: env.VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY!.trim(),
    apiBaseUrl,
    photoAnalysisEnabled: false,
    integratedUiEnabled: false,
    prismEchoEnabled: false,
  };
}

function isExactRuntimeConfig(value: unknown): value is {
  supabaseUrl: string;
  supabasePublishableKey: string;
  photoAnalysisEnabled: boolean;
  integratedUiEnabled: boolean;
  prismEchoEnabled: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "integratedUiEnabled,photoAnalysisEnabled,prismEchoEnabled,supabasePublishableKey,supabaseUrl") return false;
  return typeof record.supabaseUrl === "string" &&
    typeof record.supabasePublishableKey === "string" &&
    typeof record.photoAnalysisEnabled === "boolean" &&
    typeof record.integratedUiEnabled === "boolean" &&
    typeof record.prismEchoEnabled === "boolean" &&
    record.supabasePublishableKey.trim().length > 0 &&
    record.supabasePublishableKey.length <= 4096;
}

export async function loadHostedBrowserConfig(
  env: BrowserEnv,
  fetchImpl: BrowserConfigFetch = fetch,
  timeoutMs = 5_000,
): Promise<HostedBrowserConfig | null> {
  const supabaseUrl = env.VITE_ZUNDAMON_SUPABASE_URL?.trim();
  const supabasePublishableKey = env.VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY?.trim();
  const apiBaseUrl = env.VITE_ZUNDAMON_API_BASE_URL?.trim();
  const needsRuntimeConfig = apiBaseUrl === "/" && !supabaseUrl && !supabasePublishableKey;
  if (!needsRuntimeConfig) return parseHostedBrowserConfig(env);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    let response: Response;
    try {
      response = await fetchImpl("/api/browser-config", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "GET",
        signal: controller.signal,
      });
    } catch {
      throw new Error("Hosted browser configuration is unavailable");
    }
    if (!response.ok) throw new Error("Hosted browser configuration is unavailable");

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error(controller.signal.aborted
        ? "Hosted browser configuration is unavailable"
        : "Hosted browser configuration is invalid");
    }
    if (!isExactRuntimeConfig(value)) throw new Error("Hosted browser configuration is invalid");

    const parsed = parseHostedBrowserConfig({
      VITE_ZUNDAMON_SUPABASE_URL: value.supabaseUrl,
      VITE_ZUNDAMON_SUPABASE_PUBLISHABLE_KEY: value.supabasePublishableKey,
      VITE_ZUNDAMON_API_BASE_URL: "/",
    });
    return parsed && {
      ...parsed,
      photoAnalysisEnabled: value.photoAnalysisEnabled,
      integratedUiEnabled: value.integratedUiEnabled,
      prismEchoEnabled: value.prismEchoEnabled,
    };
  } finally {
    clearTimeout(timeout);
  }
}
