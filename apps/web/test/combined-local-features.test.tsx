import { within, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryApi } from "../src/api";
import { createWorkAssistApi } from "../src/api";
import { App } from "../src/App";
import { createMemoryLocalStateStore } from "../src/local-state";
import { createMemoryNotificationPreferenceStore, createLocalFixtureProactiveApi } from "../src/proactive-message";
import { createZundamonModelManifest } from "../src/live2d/zundamon-model-manifest";
import { renderYuiStartup } from "../src/startup-render";

const now = "2026-08-29T17:30:00.000Z";
const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: now };
const proactiveText = "おかえりなさい。今日もここにいますよ";
const originalInnerWidth = window.innerWidth;
const originalDeviceMemory = Object.getOwnPropertyDescriptor(navigator, "deviceMemory");

function memoryApi(process: ReturnType<typeof vi.fn>): MemoryApi {
  return {
    process,
    list: async () => [],
    update: async () => { throw new Error("unused"); },
    keep: async () => { throw new Error("unused"); },
    forget: async () => undefined,
    listTombstones: async () => [],
    releaseTombstone: async () => undefined,
    getSettings: async () => ({ memoryEnabled: true, updatedAt: now }),
    updateSettings: async ({ memoryEnabled }) => ({ memoryEnabled, updatedAt: now }),
  };
}

function browserStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  if (originalDeviceMemory) Object.defineProperty(navigator, "deviceMemory", originalDeviceMemory);
  else Reflect.deleteProperty(navigator, "deviceMemory");
});

describe("combined local feature fixture", () => {
  it("admits proactive and Live2D local fixtures together at startup and restores both to OFF on reload", async () => {
    const renderOn = vi.fn<(node: ReactNode) => void>();
    await renderYuiStartup({
      root: { render: renderOn },
      env: {
        VITE_YUI_PROACTIVE_MESSAGING_ENABLED: "true",
        VITE_YUI_LIVE2D_AVATAR_ENABLED: "true",
        VITE_YUI_LIVE2D_BRIDGE_SHA256: "a".repeat(64),
      },
      integratedUiEnabled: true,
    });
    const on = renderOn.mock.calls[0]?.[0] as ReactElement;
    expect(on.type).toBe(App);
    expect(on.props.proactiveMessagingEnabled).toBe(true);
    expect(on.props.proactiveApi).toBeDefined();
    expect(on.props.live2dAvatarEnabled).toBe(true);
    expect(on.props.live2dModel).toMatchObject({ id: "live2d-official-simple-2026-05-28" });

    const renderOff = vi.fn<(node: ReactNode) => void>();
    await renderYuiStartup({ root: { render: renderOff }, env: {}, integratedUiEnabled: true });
    const off = renderOff.mock.calls[0]?.[0] as ReactElement;
    expect(off.type).toBe(App);
    expect(off.props.proactiveMessagingEnabled).toBe(false);
    expect(off.props.proactiveApi).toBeUndefined();
    expect(off.props.live2dAvatarEnabled).toBe(false);
    expect(off.props.live2dModel).toBeUndefined();
  });

  it("keeps character Talk, work assistance, proactive text, and reduced-motion Live2D isolated across reload", async () => {
    const user = userEvent.setup();
    const storage = browserStorage();
    const chatStore = createMemoryLocalStateStore();
    const notificationStore = createMemoryNotificationPreferenceStore(true);
    const processMemory = vi.fn();
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({ replyGroupId: `${clientMessageId}:reply`, bubbles: [] }));
    const loadRenderer = vi.fn(async () => ({
      render: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" || query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(8);
    Object.defineProperty(navigator, "deviceMemory", { configurable: true, value: 8 });
    const loseContext = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId) => (
      contextId === "webgl2"
        ? { getExtension: () => ({ loseContext }) } as unknown as RenderingContext
        : null
    ));

    const workFetch = vi.fn(async () => Response.json({
      status: "success",
      result: { summary: "作業を整理しました", tasks: ["確認する"], draft: null, workplacePolicy: "unknown" },
    }));
    const workAssist = createWorkAssistApi(workFetch);
    const proactiveApi = createLocalFixtureProactiveApi(storage, () => "Asia/Tokyo");
    const manifest = createZundamonModelManifest("a".repeat(64));

    const first = render(<App
      splashDurationMs={0}
      integratedUiEnabled
      chatStore={chatStore}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }}
      chatApi={{ respond }}
      memoryApi={memoryApi(processMemory)}
      automaticChatMemoryMode="hosted_authoritative_snapshot"
      now={() => now}
      nextId={() => "combined-fixture-message"}
      proactiveMessagingEnabled
      proactiveApi={proactiveApi}
      notificationPreferenceStore={notificationStore}
      live2dAvatarEnabled
      live2dModel={manifest}
      live2dRendererLoader={loadRenderer}
    />);

    expect(await within(await screen.findByRole("list", { name: "ずんだもんとの会話" })).findByText(proactiveText)).toBeVisible();
    expect(respond).toHaveBeenCalledOnce();
    expect(JSON.stringify(respond.mock.calls)).not.toContain(proactiveText);
    expect(processMemory).not.toHaveBeenCalled();

    await expect(workAssist.assist({
      requestId: "work-assist-combined-1",
      conversationId: "conversation-main",
      mode: "organize",
      text: "本人が明示した作業だけを整理する",
      confirmationToken: "fixture-confirmation",
    })).resolves.toMatchObject({ status: "success" });
    const requestBody = String(workFetch.mock.calls[0]?.[1]?.body);
    expect(requestBody).toContain("本人が明示した作業だけを整理する");
    expect(requestBody).not.toContain(proactiveText);

    expect(screen.queryByRole("button", { name: "ホームへ移動" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ニュースへ移動" })).not.toBeInTheDocument();
    expect(await screen.findByText("静止画で表示しています")).toBeVisible();
    expect(screen.queryByTestId("live2d-avatar-canvas")).not.toBeInTheDocument();
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(loseContext).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "アプリ設定" }));
    const notificationToggle = screen.getByRole("checkbox", { name: "ずんだもんの通知" });
    notificationToggle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(notificationToggle).not.toBeChecked());
    await expect(notificationStore.load()).resolves.toBe(false);

    expect(`${warn.mock.calls.flat().join(" ")} ${error.mock.calls.flat().join(" ")}`).not.toContain(proactiveText);
    first.unmount();

    const offOpen = vi.fn(async () => ({ status: "failure" as const, code: "must-not-run" }));
    render(<App
      splashDurationMs={0}
      integratedUiEnabled
      chatStore={chatStore}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }}
      chatApi={{ respond }}
      memoryApi={memoryApi(processMemory)}
      automaticChatMemoryMode="hosted_authoritative_snapshot"
      now={() => now}
      nextId={() => "combined-fixture-reload"}
      proactiveMessagingEnabled={false}
      proactiveApi={{ open: offOpen, act: vi.fn() }}
      notificationPreferenceStore={notificationStore}
      live2dAvatarEnabled={false}
      live2dModel={manifest}
      live2dRendererLoader={loadRenderer}
    />);

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(offOpen).not.toHaveBeenCalled();
    expect(processMemory).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
    expect(JSON.stringify(respond.mock.calls)).not.toContain(proactiveText);
    expect(await screen.findByRole("img", { name: "キャラクター（素材未設定時は代替画像）" })).toBeVisible();
    expect(screen.queryByText("静止画で表示しています")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live2d-avatar-canvas")).not.toBeInTheDocument();
  });

  it("keeps work assistance and the static avatar usable when the proactive fixture fails", async () => {
    const user = userEvent.setup();
    const privateFailure = `${proactiveText} private-adapter-detail`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const workAssist = createWorkAssistApi(async () => Response.json({
      status: "success",
      result: { summary: "安全に整理しました", tasks: [], draft: null, workplacePolicy: "unknown" },
    }));

    render(<App
      splashDurationMs={0}
      integratedUiEnabled
      chatStore={createMemoryLocalStateStore()}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }}
      chatApi={{ respond: vi.fn(async ({ clientMessageId }) => ({ replyGroupId: `${clientMessageId}:reply`, bubbles: [] })) }}
      now={() => now}
      proactiveMessagingEnabled
      proactiveApi={{ open: async () => { throw new Error(privateFailure); }, act: vi.fn() }}
      notificationPreferenceStore={createMemoryNotificationPreferenceStore(true)}
      live2dAvatarEnabled
      live2dModel={undefined}
      live2dCapability={{ mode: "fallback", reason: "unsupported" }}
    />);

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    await expect(workAssist.assist({ requestId: "work-after-proactive-failure", conversationId: "conversation-main", mode: "organize", text: "安全に整理する" }))
      .resolves.toMatchObject({ status: "success" });
    expect(await screen.findByRole("img", { name: "キャラクター（素材未設定時は代替画像）" })).toBeVisible();
    expect(screen.queryByText(privateFailure)).not.toBeInTheDocument();
    expect(warn.mock.calls.flat().join(" ")).not.toContain(privateFailure);
  });
});
