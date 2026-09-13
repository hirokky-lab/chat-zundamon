import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { registerYuiServiceWorker } from "../src/pwa";

describe("YUI installed app", () => {
  it("publishes a changed worker without forcing an active chat window to navigate", () => {
    const worker = readFileSync("public/sw.js", "utf8");

    expect(worker).toContain('const ZUNDAMON_PWA_VERSION = "20260913-chat-zundamon-name-2"');
    expect(worker).toContain("self.clients.claim()");
    expect(worker).not.toContain("client.navigate");
  });

  it("registers the app service worker on supported secure browsers", async () => {
    const register = vi.fn(async () => ({ scope: "/" }));

    await registerYuiServiceWorker({ serviceWorker: { register } });

    expect(register).toHaveBeenCalledWith("/sw.js?v=20260913-chat-zundamon-name-2");
  });

  it("reloads an already installed app once when a new worker takes control", async () => {
    let controllerChange: (() => void) | undefined;
    const reload = vi.fn();
    const storage = new Map<string, string>();
    const serviceWorker = {
      controller: {},
      register: vi.fn(async () => ({ scope: "/" })),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        if (type === "controllerchange") controllerChange = listener;
      }),
    };

    await registerYuiServiceWorker(
      { serviceWorker },
      {
        reload,
        sessionStorage: {
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value),
        },
      },
    );
    controllerChange?.();
    controllerChange?.();

    expect(reload).toHaveBeenCalledOnce();
  });

  it("does nothing when service workers are unavailable", async () => {
    await expect(registerYuiServiceWorker({})).resolves.toBeUndefined();
  });
});
