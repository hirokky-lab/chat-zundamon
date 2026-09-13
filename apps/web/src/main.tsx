import {trackInputModality} from "./input-modality";
import { createRoot } from "react-dom/client";
import type { RealtimeClientFactory } from "./App";
import { registerYuiServiceWorker } from "./pwa";
import { isIntegratedUiEnabled } from "./integrated-ui";
import { renderYuiStartup } from "./startup-render";
import "./styles.css";
import "./dark-mode.css";

declare global {
  interface Window {
    __YUI_E2E_REALTIME_CLIENT__?: RealtimeClientFactory;
    __YUI_E2E_SAY__?: (text: string) => void;
  }
}

const stopTrackingInput = trackInputModality();
if (import.meta.hot) import.meta.hot.dispose(stopTrackingInput);

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element is missing");
}

const e2eRealtimeClient =
  import.meta.env.VITE_ZUNDAMON_E2E === "true"
    ? window.__YUI_E2E_REALTIME_CLIENT__
    : undefined;

const integratedUiEnabled = isIntegratedUiEnabled(import.meta.env.VITE_YUI_INTEGRATED_UI_ENABLED ?? "true");
const root = createRoot(rootElement);

void registerYuiServiceWorker(navigator).catch(() => undefined);

void renderYuiStartup({
  root,
  env: import.meta.env,
  realtimeClient: e2eRealtimeClient,
  integratedUiEnabled,
});
