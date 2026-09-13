import { createLocalPreviewProps } from "./local-preview";
import type { ReactNode } from "react";
import { App, HostedApp, type RealtimeClientFactory } from "./App";
import { resolveYuiStartup } from "./startup";
import { createBrowserNotificationPreferenceStore, createLocalFixtureProactiveApi } from "./proactive-message";
import { isHostedZundamonEnabled, isLive2dAvatarEnabled } from "./live2d/avatar-feature";
import { createZundamonModelManifest } from "./live2d/zundamon-model-manifest";
import { createSimpleModelManifest } from "./live2d/simple-model-manifest";

type BrowserEnv = Record<string, string | undefined>;
type BrowserConfigFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type RenderRoot = { render(node: ReactNode): void };
type AuthModule = Pick<typeof import("./auth"), "createBrowserAuthClient">;

export type RenderYuiStartupOptions = {
  root: RenderRoot;
  env: BrowserEnv;
  integratedUiEnabled: boolean;
  realtimeClient?: RealtimeClientFactory;
  fetchImpl?: BrowserConfigFetch;
  loadAuth?: () => Promise<AuthModule>;
};

function renderStartupError(root: RenderRoot): void {
  root.render(<main className="startup-error" role="alert">Chatずんだもんを起動できませんでした。</main>);
}

export async function renderYuiStartup(options: RenderYuiStartupOptions): Promise<void> {
  const startup = await resolveYuiStartup(options.env, options.fetchImpl ?? fetch);
  if (startup.mode === "local") {
    const localPreview = options.env.VITE_ZUNDAMON_LOCAL_API_ENABLED !== "true" && options.env.VITE_ZUNDAMON_E2E !== "true";
    const previewProps = localPreview ? await createLocalPreviewProps() : {};
    const proactiveMessagingEnabled = options.env.VITE_YUI_PROACTIVE_MESSAGING_ENABLED === "true";
    const prismEchoEnabled = options.env.VITE_YUI_PRISM_ECHO_ENABLED === "true";
    const live2dAvatarEnabled = isLive2dAvatarEnabled(options.env.VITE_YUI_LIVE2D_AVATAR_ENABLED);
    const live2dModel = live2dAvatarEnabled
      ? (options.env.VITE_YUI_LIVE2D_MODEL === "zundamon" ? createZundamonModelManifest : createSimpleModelManifest)(options.env.VITE_YUI_LIVE2D_BRIDGE_SHA256)
      : undefined;
    options.root.render(<App
      {...previewProps}
      localPreview={localPreview}
      realtimeClient={options.realtimeClient}
      integratedUiEnabled={options.integratedUiEnabled}
      causalCueEnabled={prismEchoEnabled}
      proactiveMessagingEnabled={proactiveMessagingEnabled}
      proactiveApi={proactiveMessagingEnabled ? createLocalFixtureProactiveApi() : undefined}
      notificationPreferenceStore={proactiveMessagingEnabled ? createBrowserNotificationPreferenceStore() : undefined}
      live2dAvatarEnabled={live2dAvatarEnabled}
      live2dModel={live2dModel}
    />);
    return;
  }
  if (startup.mode === "error") {
    renderStartupError(options.root);
    return;
  }

  try {
    const { createBrowserAuthClient } = await (options.loadAuth ?? (() => import("./auth")))();
    const privateLocalAvatar = options.env.MODE === "local-live2d" && !options.env.VITE_YUI_DEPLOYMENT_ENV
      && options.env.VITE_YUI_LIVE2D_AVATAR_ENABLED === "true"
      && options.env.VITE_YUI_LIVE2D_MODEL === "zundamon"
      && /^[a-f0-9]{64}$/.test(options.env.VITE_YUI_LIVE2D_BRIDGE_SHA256 ?? "");
    const live2dProps = (isHostedZundamonEnabled(options.env) || privateLocalAvatar) ? {
      live2dAvatarEnabled: true,
      live2dModel: createZundamonModelManifest(options.env.VITE_YUI_LIVE2D_BRIDGE_SHA256),
    } : {};
    options.root.render(<HostedApp
      {...live2dProps}
      authClient={options.env.VITE_ZUNDAMON_GOOGLE_LOGIN_ENABLED === "false"
        ? createBrowserAuthClient(startup.config.supabaseUrl, startup.config.supabasePublishableKey, {googleEnabled:false})
        : createBrowserAuthClient(startup.config.supabaseUrl, startup.config.supabasePublishableKey)}
      vrmStorageConfig={{url: startup.config.supabaseUrl, key: startup.config.supabasePublishableKey}}
      apiBaseUrl={startup.config.apiBaseUrl}
      photoAnalysisEnabled={startup.config.photoAnalysisEnabled}
      prismEchoEnabled={startup.config.prismEchoEnabled}
      realtimeClient={options.realtimeClient}
      integratedUiEnabled={startup.config.integratedUiEnabled}
    />);
  } catch {
    renderStartupError(options.root);
  }
}
