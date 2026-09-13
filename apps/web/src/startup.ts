import { loadHostedBrowserConfig, type HostedBrowserConfig } from "./hosted-config";

type BrowserEnv = Record<string, string | undefined>;
type BrowserConfigFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type YuiStartup =
  | { mode: "hosted"; config: HostedBrowserConfig }
  | { mode: "local" }
  | { mode: "error" };

export async function resolveYuiStartup(
  env: BrowserEnv,
  fetchImpl: BrowserConfigFetch = fetch,
): Promise<YuiStartup> {
  try {
    const config = await loadHostedBrowserConfig(env, fetchImpl);
    return config ? { mode: "hosted", config } : { mode: "local" };
  } catch {
    return { mode: "error" };
  }
}
