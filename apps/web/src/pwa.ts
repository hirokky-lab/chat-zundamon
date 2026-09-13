type ServiceWorkerNavigator = {
  serviceWorker?: {
    controller?: unknown;
    register(scriptUrl: string): Promise<unknown>;
    addEventListener?(type: "controllerchange", listener: () => void): void;
  };
};

type ReloadContext = {
  reload(): void;
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
};

const PWA_VERSION = "20260913-chat-zundamon-name-2";
const RELOAD_KEY = `zundamon-ai:pwa-reloaded:${PWA_VERSION}`;

export async function registerYuiServiceWorker(
  navigatorLike: ServiceWorkerNavigator,
  reloadContext: ReloadContext = {
    reload: () => window.location.reload(),
    sessionStorage: window.sessionStorage,
  },
): Promise<void> {
  if (!navigatorLike.serviceWorker) return;
  const serviceWorker = navigatorLike.serviceWorker;
  const controlledAtRegistration = Boolean(serviceWorker.controller);
  let reloadRequested = reloadContext.sessionStorage.getItem(RELOAD_KEY) === "1";
  serviceWorker.addEventListener?.("controllerchange", () => {
    if (!controlledAtRegistration || reloadRequested) return;
    reloadRequested = true;
    reloadContext.sessionStorage.setItem(RELOAD_KEY, "1");
    reloadContext.reload();
  });
  await serviceWorker.register(`/sw.js?v=${PWA_VERSION}`);
}
