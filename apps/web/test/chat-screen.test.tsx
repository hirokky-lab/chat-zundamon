import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { YuiRequestError, type ChatApi, type MemoryApi, type ProfileApi } from "../src/api";
import { App, type RealtimeClientFactory } from "../src/App";
import { EMPTY_LOCAL_CHAT, type LocalStateStore } from "../src/local-state";
import type { PreparedPhoto } from "../src/photo-preparation";
import { Chat as ProductionChat, type ChatProps } from "../src/screens/Chat";
import type { SessionAction } from "../src/session-reducer";
import type { YuiPortrait } from "../src/integrated-ui";
import { createLocalGoogleCalendarTasksApi, type GoogleCalendarTasksApi } from "../src/google-calendar-tasks";

const chatStyles = readFileSync("src/styles.css", "utf8");
const now = "2026-08-08T12:48:00.000Z";
const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: now };
const longTimelineSnapshot = {
  ...EMPTY_LOCAL_CHAT,
  timeline: [
    { id: "long-user-1", type: "message" as const, role: "user" as const, text: "一つ目の話", createdAt: now, delivery: "sent" as const },
    { id: "long-assistant-1", type: "message" as const, role: "assistant" as const, text: "一つ目への返事", createdAt: now, delivery: "sent" as const },
    { id: "long-user-2", type: "message" as const, role: "user" as const, text: "二つ目の話", createdAt: now, delivery: "sent" as const },
    { id: "long-assistant-2", type: "message" as const, role: "assistant" as const, text: "二つ目への返事", createdAt: now, delivery: "sent" as const },
    { id: "long-user-3", type: "message" as const, role: "user" as const, text: "三つ目の話", createdAt: now, delivery: "sent" as const },
    { id: "long-assistant-3", type: "message" as const, role: "assistant" as const, text: "三つ目への返事", createdAt: now, delivery: "sent" as const },
  ],
};
const noopGreetingRevealed = () => undefined;

type TestChatProps = Omit<ChatProps, "delayedGreetingReplyGroupId" | "onGreetingRevealed"> & Partial<Pick<ChatProps, "delayedGreetingReplyGroupId" | "onGreetingRevealed">>;

function Chat({ delayedGreetingReplyGroupId = null, onGreetingRevealed = noopGreetingRevealed, ...props }: TestChatProps) {
  return <ProductionChat {...props} delayedGreetingReplyGroupId={delayedGreetingReplyGroupId} onGreetingRevealed={onGreetingRevealed} />;
}

function reply(clientMessageId: string, text = "おかえりなさい") {
  const replyGroupId = `${clientMessageId}:assistant`;
  return {
    replyGroupId,
    bubbles: [{ id: `${replyGroupId}:0`, text, createdAt: now, sequence: 0 as const }],
  };
}

function chatApp({
  store = { load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined },
  profileApi = { get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) },
  chatApi = { respond: async ({ clientMessageId }) => reply(clientMessageId) },
  memoryApi,
  integratedUiEnabled,
  realtimeClient,
  yuiPortrait,
  googleCalendarTasksApi,
}: {
  store?: LocalStateStore;
  profileApi?: ProfileApi;
  chatApi?: ChatApi;
  memoryApi?: MemoryApi;
  integratedUiEnabled?: boolean;
  realtimeClient?: RealtimeClientFactory;
  yuiPortrait?: YuiPortrait;
  googleCalendarTasksApi?: GoogleCalendarTasksApi;
} = {}) {
  const renderApp = (enabled = integratedUiEnabled) => <App splashDurationMs={0} chatStore={store} profileApi={profileApi} chatApi={chatApi} memoryApi={memoryApi} integratedUiEnabled={enabled} realtimeClient={realtimeClient} yuiPortrait={yuiPortrait} googleCalendarTasksApi={googleCalendarTasksApi} now={() => now} nextId={() => crypto.randomUUID()} />;
  const app = render(renderApp());
  return { ...app, rerenderWithIntegratedUi: (enabled: boolean) => app.rerender(renderApp(enabled)) };
}

async function openIntegratedSettings(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "メニューを開く" }));
  await user.click(screen.getByRole("button", { name: "アプリ設定" }));
}

function firePrimaryPointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", values: { pointerId: number; isPrimary: boolean; clientX?: number; clientY?: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, Object.fromEntries(Object.entries({ pointerType: "touch", ...values }).map(([key, value]) => [key, { value }])));
  fireEvent(target, event);
}

describe("Zundamon conversation", () => {
  it("keeps send and latest-position controls as separate accessible contracts", () => {
    const source = readFileSync("src/screens/Chat.tsx", "utf8");

    expect(source).toContain('data-testid="composer-send-prism"');
    expect(source).toContain('data-testid="talk-jump-to-latest"');
    expect(source).toContain('data-testid="composer-send-prism"');
    expect(source).toContain('"メッセージを送信"');
    expect(source).toContain('aria-label="最新のメッセージへ移動"');
  });
  it("keeps local automatic chat memory disabled after a completed text reply", async () => {
    const process = vi.fn();
    const memoryApi = {
      process,
      getSettings: async () => ({ memoryEnabled: true, updatedAt: now }),
    } as unknown as MemoryApi;
    const user = userEvent.setup();
    render(<App splashDurationMs={0} chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => undefined }}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }}
      chatApi={{ respond: async ({ clientMessageId }) => reply(clientMessageId) }} memoryApi={memoryApi}
      now={() => now} nextId={() => "message-local"} />);
    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "通常の会話");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(await within(screen.getByLabelText("ずんだもんの今のセリフ")).findByText("おかえりなさい")).toBeVisible();
    await Promise.resolve();
    expect(process).not.toHaveBeenCalled();
  });

  it("shows causal Talk cues only from the observed send, wait, and delivered lifecycle", async () => {
    let releaseSendingPersist: (() => void) | undefined;
    let resolveReply: ((value: ReturnType<typeof reply>) => void) | undefined;
    const sendingPersist = new Promise<void>((resolve) => { releaseSendingPersist = resolve; });
    const pendingReply = new Promise<ReturnType<typeof reply>>((resolve) => { resolveReply = resolve; });
    const ids = ["opening-unused", "message-1"];
    const store: LocalStateStore = {
      load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }),
      save: async (snapshot) => {
        if (snapshot.timeline.some((item) => item.type === "message" && item.id === "message-1" && item.delivery === "sending")) {
          await sendingPersist;
        }
      },
    };
    const user = userEvent.setup();

    render(<App
      splashDurationMs={0}
      integratedUiEnabled
      causalCueEnabled
      chatStore={store}
      profileApi={{ get: async () => profile, save: async () => profile }}
      chatApi={{ respond: async () => pendingReply }}
      now={() => now}
      nextId={() => ids.shift() ?? "unexpected-id"}
    />);

    expect(await screen.findByText("ここから、話を受け取る")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "メッセージ" }), "こんにちは");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(await screen.findByRole("status", { name: "ずんだもんが返事をつくっています" })).toHaveTextContent("");
    expect(screen.queryByText("受け取りました。返事をつくっています")).not.toBeInTheDocument();

    releaseSendingPersist?.();
    expect((await screen.findByRole("status", { name: "ずんだもんが返事をつくっています" })).querySelectorAll(".typing-dot")).toHaveLength(3);

    resolveReply?.(reply("message-1", "届いたよ"));
    expect(await screen.findByText("ずんだもんから返事が届きました")).toBeVisible();
    expect(within(screen.getByLabelText("ずんだもんの今のセリフ")).getByText("届いたよ")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "閉じてホームへ戻る" }));
    expect(screen.getAllByText("ずんだもんから返事が届きました")).toHaveLength(1);
  });

  it("does not recreate the chat controller when only the display cue flag changes", async () => {
    const load = vi.fn(async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }));
    const store: LocalStateStore = { load, save: async () => undefined };
    const profileApi = { get: async () => profile, save: async () => profile };
    const chatApi = { respond: async ({ clientMessageId }: { clientMessageId: string }) => reply(clientMessageId) };
    const nowValue = () => now;
    const nextId = () => "message-stable";
    const view = render(<App splashDurationMs={0} causalCueEnabled={false} chatStore={store} profileApi={profileApi} chatApi={chatApi} now={nowValue} nextId={nextId} />);

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    view.rerender(<App splashDurationMs={0} causalCueEnabled chatStore={store} profileApi={profileApi} chatApi={chatApi} now={nowValue} nextId={nextId} />);

    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing talk as the complete default when the integrated UI flag is omitted", async () => {
    chatApp();

    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    expect(composer).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "ずんだもんの主な画面" })).not.toBeInTheDocument();
    expect(composer.closest(".chat-screen")).not.toHaveAttribute("data-integrated-ui");
  });

  it("does not arm legacy Talk pointer navigation while the integrated flag is off", async () => {
    const app = chatApp({ integratedUiEnabled: false });
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    const talk = composer.closest(".chat-screen")!;
    firePrimaryPointer(talk, "pointerdown", { pointerId: 1, isPrimary: true, clientX: 290, clientY: 180 });
    firePrimaryPointer(talk, "pointerup", { pointerId: 1, isPrimary: true, clientX: 120, clientY: 180 });
    expect(talk).not.toHaveAttribute("data-integrated-ui");
    app.rerenderWithIntegratedUi(true);
    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "ホーム" })).not.toBeInTheDocument();
  });




  it("keeps Connection Services busy until the App-level Google promise settles", async () => {
    const user = userEvent.setup();
    let resolveStart: ((url: string) => void) | undefined;
    const base = createLocalGoogleCalendarTasksApi({
      calendar: { service: "calendar", state: "disconnected", homeVisible: false },
      tasks: { service: "tasks", state: "disabled", homeVisible: false },
    });
    const beginConnection = vi.fn(() => new Promise<string>((resolve) => { resolveStart = resolve; }));
    chatApp({ integratedUiEnabled: true, googleCalendarTasksApi: { ...base, beginConnection } });
    await user.click(await screen.findByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "接続サービス" }));

    await user.click(screen.getByRole("button", { name: "Googleカレンダーを接続" }));

    expect(beginConnection).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Googleカレンダーを変更しています");
    expect(screen.getByRole("button", { name: "Googleカレンダーを接続" })).toBeDisabled();
    void resolveStart;
  });

  it("does not claim a Google disconnect when the App-level stop fails", async () => {
    const user = userEvent.setup();
    const base = createLocalGoogleCalendarTasksApi({
      calendar: { service: "calendar", state: "connected", homeVisible: true },
      tasks: { service: "tasks", state: "disabled", homeVisible: false },
    });
    const stopService = vi.fn(() => Promise.reject(new Error("private stop failure")));
    chatApp({ integratedUiEnabled: true, googleCalendarTasksApi: { ...base, stopService } });
    await user.click(await screen.findByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "接続サービス" }));
    await user.click(screen.getByRole("button", { name: "Googleカレンダーのその他の操作" }));
    await user.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの状態を変更できませんでした");
    expect(screen.getByText("接続済み")).toBeVisible();
    expect(document.body.textContent).not.toContain("private stop failure");
  });

  it("keeps the stopped local service connected when its clear reports failure", async () => {
    const user = userEvent.setup();
    const base = createLocalGoogleCalendarTasksApi({
      calendar: { service: "calendar", state: "connected", homeVisible: true },
      tasks: { service: "tasks", state: "connected", homeVisible: true },
    });
    const googleCalendarTasksApi: GoogleCalendarTasksApi = {
      ...base,
      stopService: async (service) => {
        if (service === "calendar") throw new Error("local clear failed");
        await base.stopService(service);
      },
    };
    chatApp({ integratedUiEnabled: true, googleCalendarTasksApi });

    await user.click(await screen.findByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "接続サービス" }));
    await user.click(screen.getByRole("button", { name: "Googleカレンダーのその他の操作" }));
    await user.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの状態を変更できませんでした");
    expect(await googleCalendarTasksApi.getSettings()).toMatchObject({calendar:{state:"connected"},tasks:{state:"connected"}});
  });



  it("does not navigate for vertical, composer, or cancelled/multitouch pointer gestures", async () => {
    chatApp({ integratedUiEnabled: true });
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    const talk = composer.closest(".chat-screen")!;
    firePrimaryPointer(talk, "pointerdown", { pointerId: 1, isPrimary: true, clientX: 290, clientY: 100 });
    firePrimaryPointer(talk, "pointermove", { pointerId: 1, isPrimary: true, clientX: 210, clientY: 290 });
    firePrimaryPointer(talk, "pointerup", { pointerId: 1, isPrimary: true, clientX: 120, clientY: 350 });
    firePrimaryPointer(composer, "pointerdown", { pointerId: 2, isPrimary: true, clientX: 290, clientY: 650 });
    firePrimaryPointer(composer, "pointerup", { pointerId: 2, isPrimary: true, clientX: 120, clientY: 650 });
    firePrimaryPointer(talk, "pointerdown", { pointerId: 3, isPrimary: true, clientX: 290, clientY: 100 });
    firePrimaryPointer(talk, "pointercancel", { pointerId: 3, isPrimary: true });
    firePrimaryPointer(talk, "pointerdown", { pointerId: 4, isPrimary: false, clientX: 290, clientY: 100 });
    firePrimaryPointer(talk, "pointerup", { pointerId: 4, isPrimary: false, clientX: 120, clientY: 100 });
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  });

  it("cancels an active primary swipe when a second pointer joins before primary release", async () => {
    chatApp({ integratedUiEnabled: true });
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    const talk = composer.closest(".chat-screen")!;
    firePrimaryPointer(talk, "pointerdown", { pointerId: 1, isPrimary: true, clientX: 290, clientY: 180 });
    firePrimaryPointer(talk, "pointerdown", { pointerId: 2, isPrimary: false, clientX: 260, clientY: 180 });
    firePrimaryPointer(talk, "pointerup", { pointerId: 1, isPrimary: true, clientX: 120, clientY: 180 });
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "ホーム" })).not.toBeInTheDocument();
  });


  it("warns when the injected preview store is only temporary", async () => {
    render(<App localPreview chatStorePersistent={false} splashDurationMs={0} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined }} profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} />);
    expect(await screen.findByText("この端末には履歴を保存できません")).toBeVisible();
  });

  it("keeps external voice actions disabled in the local display preview", async () => {
    const user = userEvent.setup();
    render(<App localPreview splashDurationMs={0} chatStore={{ load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined }} profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} />);
    await screen.findByRole("textbox", { name: "メッセージ" });
    await user.click(screen.getByRole("button", {name:"ライブチャットを開始"}));
    expect(screen.getByText("ライブチャットはまだ未接続です")).toBeVisible();
    expect(screen.getByRole("button", { name: "音声入力を開始" })).toBeDisabled();
    expect(screen.getByText("音声はまだ未接続です")).toBeVisible();
  });

  it("preserves an unsent draft while opening and closing the menu", async () => {
    const user = userEvent.setup();
    chatApp({ integratedUiEnabled: true });
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });

    await user.type(composer, "あとで送る下書き");
    await user.click(screen.getByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "閉じてホームへ戻る" }));

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toHaveValue("あとで送る下書き");
  });




  it("returns from an integrated realtime call to Talk and its composer", async () => {
    const user = userEvent.setup();
    let dispatch: ((action: SessionAction) => void) | undefined;
    const realtimeClient: RealtimeClientFactory = (nextDispatch) => {
      dispatch = nextDispatch;
      return {
        start: async () => undefined,
        stop: () => dispatch?.({ type: "stopped" }),
      };
    };
    chatApp({ integratedUiEnabled: true, realtimeClient });

    await user.click(await screen.findByRole("button", { name: "ライブチャットを開始" }));
    act(() => dispatch?.({ type: "connected" }));
    expect(await screen.findByText("聞いています")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "ライブチャットを終了" }));

    expect(await screen.findByRole("button", { name: "メニューを開く" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  });

  it("keeps source cards visible after an explicit Web search prompt in integrated Talk", async () => {
    const user = userEvent.setup();
    chatApp({
      integratedUiEnabled: true,
      chatApi: {
        respond: async ({ clientMessageId }) => ({
          ...reply(clientMessageId, "公式の案内を見つけたよ"),
          search: {
            status: "completed" as const,
            searchedAt: now,
            sources: [{ title: "公式発表", url: "https://example.com/official" }],
            evidence: {
              facts: [{ text: "公式の案内は今日です", sourceUrl: "https://example.com/official" }],
              inference: "予定は変更される可能性があります",
              suggestion: "ずんだもんからは公式をもう一度見るのがおすすめ",
            },
          },
        }),
      },
    });
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });

    await user.type(composer, "最新情報を検索して");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));

    expect(await screen.findByText("公式の案内を見つけたよ")).toBeVisible();
    expect(screen.getByRole("complementary", { name: "Web検索の結果" })).toBeVisible();
    expect(screen.getByRole("link", { name: "公式発表" })).toHaveAttribute("href", "https://example.com/official");
    expect(screen.getByRole("button", { name: "メニューを開く" })).toBeVisible();
  });

  it("shows completed and failed web search status with safe source links in the talk", () => {
    const searched = {
      id: "search:0", type: "message" as const, role: "assistant" as const,
      text: "確認したよ", createdAt: now, delivery: "sent" as const,
      replyGroupId: "search", sequence: 0 as const,
      search: {
        status: "completed" as const,
        searchedAt: "2026-08-13T03:00:00.000Z",
        sources: [{ title: "公式発表", url: "https://example.com/official" }],
        evidence: {
          facts: [{ text: "公式の案内は今日です", sourceUrl: "https://example.com/official" }],
          inference: "予定は変更される可能性があります",
          suggestion: "ずんだもんからは公式をもう一度見るのがおすすめ",
        },
      },
    };
    const failed = {
      ...searched, id: "failed:0", replyGroupId: "failed", text: "今は確認できないよ",
      search: { status: "failed" as const, searchedAt: "2026-08-13T03:00:00.000Z", sources: [] as [] },
    };
    render(<Chat state={{ profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [searched, failed] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByText("検索済み")).toBeInTheDocument();
    expect(screen.getByText("事実")).toBeInTheDocument();
    expect(screen.getByText("考えられること")).toBeInTheDocument();
    expect(screen.getByText("ずんだもんからの提案")).toBeInTheDocument();
    expect(screen.getByText("検索結果を取得できませんでした")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "公式発表" })).toHaveAttribute("href", "https://example.com/official");
    expect(screen.getByRole("link", { name: "公式発表" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.getByRole("main")).not.toHaveAttribute("data-integrated-ui");
  });

  it("shows search-in-progress only for a pending explicit request", () => {
    const pending = { id: "pending-search", type: "message" as const, role: "user" as const, text: "最新情報を検索して", createdAt: now, delivery: "sending" as const };
    render(<Chat state={{ profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [pending] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("status", { name: "検索中" })).toBeInTheDocument();
  });

  it("keeps measured header, history, and bottom controls as direct chat-root siblings", () => {
    let resize: ResizeObserverCallback | null = null;
    let headerHeight = 84.5;
    let composerHeight = 112.25;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.classList.contains("chat-header")) return DOMRect.fromRect({ height: headerHeight });
      if (this.classList.contains("chat-bottom-stack")) return DOMRect.fromRect({ height: composerHeight });
      return DOMRect.fromRect();
    });
    try {
      const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
      const { container } = render(<Chat state={state} hydrating={false} persistenceWarning="履歴を保存できません" onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

      const root = container.querySelector<HTMLElement>(".chat-screen")!;
      const header = root.querySelector<HTMLElement>(":scope > .chat-header")!;
      const history = root.querySelector<HTMLElement>(":scope > .chat-history-shell")!;
      const bottomStack = root.querySelector<HTMLElement>(":scope > .chat-bottom-stack")!;
      const composer = bottomStack.querySelector<HTMLElement>(".chat-composer")!;
      expect(Array.from(root.children)).toEqual([header, root.querySelector(":scope > .desktop-stage-dialogue"), history, bottomStack]);
      expect(history).toContainElement(history.querySelector(".chat-search-slot"));
      expect(composer).toContainElement(screen.getByRole("status"));
      expect(root.style.getPropertyValue("--chat-header-height")).toBe("84.5px");
      expect(root.style.getPropertyValue("--chat-composer-height")).toBe("112.25px");

      headerHeight = 96;
      composerHeight = 140;
      act(() => resize?.([], {} as ResizeObserver));
      expect(root.style.getPropertyValue("--chat-header-height")).toBe("96px");
      expect(root.style.getPropertyValue("--chat-composer-height")).toBe("140px");
    } finally {
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("measures overlay insets on the first animation frame without ResizeObserver", () => {
    let nextFrame: FrameRequestCallback | null = null;
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 17;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.classList.contains("chat-header")) return DOMRect.fromRect({ height: 76 });
      if (this.classList.contains("chat-bottom-stack")) return DOMRect.fromRect({ height: 90 });
      return DOMRect.fromRect();
    });
    try {
      const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
      const { container } = render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const root = container.querySelector<HTMLElement>(".chat-screen")!;

      expect(root.style.getPropertyValue("--chat-header-height")).toBe("");
      act(() => nextFrame?.(0));
      expect(root.style.getPropertyValue("--chat-header-height")).toBe("76px");
      expect(root.style.getPropertyValue("--chat-composer-height")).toBe("90px");
    } finally {
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the approved plus, microphone, and send actions inside the message field", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    const shell = composer.closest(".composer-shell");
    expect(shell).not.toBeNull();
    expect(shell).toContainElement(screen.getByRole("button", { name: "追加機能は現在利用できません" }));
    expect(shell).toContainElement(screen.getByRole("button", { name: "音声入力を開始" }));
    expect(shell).toContainElement(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(screen.queryByText("ずんだもんに話す")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "このアプリについて" })).not.toBeInTheDocument();
  });

  it("starts at one line and keeps Shift+Enter as a newline on desktop", async () => {
    const onSend = vi.fn();
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false}
      onSend={onSend} onRetry={vi.fn()} onCall={vi.fn()}
      onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    expect(composer.closest(".composer-shell")).toHaveAttribute("data-empty", "true");
    expect(composer).toHaveAttribute("rows", "1");
    expect(composer).toHaveStyle({ height: "32px" });
    await userEvent.type(composer, "一行目{Shift>}{Enter}{/Shift}二行目");
    expect(composer).toHaveValue("一行目\n二行目");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(onSend).toHaveBeenCalledWith("一行目\n二行目");
  });

  it("sends desktop Enter only after IME confirmation", () => {
    const onSend = vi.fn();
    render(<Chat state={{ profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT }} hydrating={false} persistenceWarning={false} onSend={onSend} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    fireEvent.compositionStart(composer);
    fireEvent.change(composer, { target: { value: "こんにちは" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(composer);
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(onSend).toHaveBeenCalledExactlyOnceWith("こんにちは");
  });

  it("keeps mobile Enter as newline and sends with the button", async () => {
    const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
    try {
      const onSend = vi.fn();
      render(<Chat state={{ profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT }} hydrating={false} persistenceWarning={false} onSend={onSend} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const composer = screen.getByRole("textbox", { name: "メッセージ" });
      await userEvent.type(composer, "一行目{Enter}二行目");
      expect(composer).toHaveValue("一行目\n二行目");
      expect(onSend).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "メッセージを送信" }));
      expect(onSend).toHaveBeenCalledExactlyOnceWith("一行目\n二行目");
    } finally { agent.mockRestore(); }
  });

  it("keeps empty, one-character, and one-line drafts at the same height", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 32 });
    expect(composer).toHaveStyle({ height: "32px" });

    fireEvent.change(composer, { target: { value: "あ" } });
    expect(composer).toHaveStyle({ height: "32px" });

    fireEvent.change(composer, { target: { value: "一行に収まる文章" } });
    expect(composer).toHaveStyle({ height: "32px" });
  });

  it("grows only when the draft wraps onto a second line", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 56 });
    fireEvent.change(composer, { target: { value: "折り返して二行になる文章" } });

    expect(composer).toHaveStyle({ height: "56px", overflowY: "hidden" });
  });

  it("keeps an empty line compact while reserving space below the actions", () => {
    const style = document.createElement("style");
    style.textContent = chatStyles;
    document.head.append(style);
    try {
      const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
      render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

      const composer = screen.getByRole("textbox", { name: "メッセージ" });
      const shell = composer.closest(".composer-shell");
      const actionRow = shell?.querySelector(".composer-actions-row");
      const sendButton = actionRow?.querySelector(".send-action");
      expect(shell).not.toBeNull();
      expect(actionRow).not.toBeNull();
      expect(sendButton).not.toBeNull();

      const textareaStyle = getComputedStyle(composer);
      const shellStyle = getComputedStyle(shell!);
      const actionRowStyle = getComputedStyle(actionRow!);
      const sendButtonStyle = getComputedStyle(sendButton!);
      const pixels = (value: string) => Number.parseFloat(value) || 0;
      const requiredTextareaHeight = pixels(textareaStyle.lineHeight)
        + pixels(textareaStyle.paddingTop)
        + pixels(textareaStyle.paddingBottom);
      expect(textareaStyle.boxSizing).toBe("border-box");
      expect(pixels(textareaStyle.minHeight)).toBeGreaterThanOrEqual(requiredTextareaHeight);

      const actionRowHeight = Math.max(
        pixels(actionRowStyle.minHeight),
        pixels(sendButtonStyle.height)
          + pixels(actionRowStyle.paddingTop)
          + pixels(actionRowStyle.paddingBottom)
          + pixels(actionRowStyle.borderTopWidth)
          + pixels(actionRowStyle.borderBottomWidth),
      );
      const shellBorderHeight = Math.max(
        2,
        pixels(shellStyle.borderTopWidth) + pixels(shellStyle.borderBottomWidth),
      );
      const compactShellHeight = Math.max(pixels(textareaStyle.height), pixels(textareaStyle.minHeight))
        + pixels(textareaStyle.marginTop)
        + pixels(textareaStyle.marginBottom)
        + actionRowHeight
        + shellBorderHeight;
      // The restored composer deliberately keeps a 49px text row plus the 49px action row.
      expect(compactShellHeight, JSON.stringify({
        textareaHeight: textareaStyle.height,
        textareaMarginTop: textareaStyle.marginTop,
        actionRowMinHeight: actionRowStyle.minHeight,
        actionRowPaddingTop: actionRowStyle.paddingTop,
        actionRowPaddingBottom: actionRowStyle.paddingBottom,
        sendButtonHeight: sendButtonStyle.height,
        shellBorderTop: shellStyle.borderTopWidth,
        shellBorderBottom: shellStyle.borderBottomWidth,
        shellBorderHeight,
      })).toBeLessThanOrEqual(102);
    } finally {
      style.remove();
    }
  });

  it("uses a line-free outer layer and a frosted shell with inset actions", async () => {
    const style = document.createElement("style");
    style.textContent = chatStyles;
    document.head.append(style);
    try {
      const user = userEvent.setup();
      const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
      const { container } = render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

      const composerLayer = container.querySelector<HTMLElement>(".chat-composer")!;
      const composer = screen.getByRole("textbox", { name: "メッセージ" });
      const shell = composer.closest<HTMLElement>(".composer-shell")!;
      const actionRow = shell.querySelector<HTMLElement>(".composer-actions-row")!;
      expect(getComputedStyle(composerLayer).backgroundImage).not.toContain("gradient");
      expect(getComputedStyle(composerLayer).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      const shellStyle = getComputedStyle(shell);
      expect(shellStyle.backgroundColor).toBe("rgba(255, 255, 255, 0.78)");
      expect(shellStyle.borderRadius).toBe("28px");
      expect(getComputedStyle(actionRow).paddingRight).toBe("5px");
      expect(getComputedStyle(actionRow).paddingBottom).toBe("5px");
      const sendButtonStyle = getComputedStyle(screen.getByRole("button", { name: "メッセージを送信" }));
      expect(sendButtonStyle.width).toBe("44px");
      expect(sendButtonStyle.height).toBe("44px");
      expect(chatStyles).toMatch(/\.attach-action::before, \.microphone-action::before, \.send-action::before\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;[^}]*border-radius:\s*18px;/s);
      await user.click(composer);
      expect(composer).toHaveFocus();
    } finally {
      style.remove();
    }
  });

  it("keeps photo selection inert until the explicitly supplied photo boundary is enabled", async () => {
    const user = userEvent.setup();
    const onPhotoSelected = vi.fn();
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    const { rerender } = render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onPhotoSelected={onPhotoSelected} />);

    expect(screen.getByRole("button", { name: "追加機能は現在利用できません" })).toBeDisabled();
    expect(screen.queryByLabelText("写真を選ぶ")).not.toBeInTheDocument();

    rerender(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoInputEnabled />);
    expect(screen.getByRole("button", { name: "追加機能は現在利用できません" })).toBeDisabled();
    expect(screen.queryByLabelText("写真を選ぶ")).not.toBeInTheDocument();

    rerender(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoInputEnabled onPhotoSelected={onPhotoSelected} />);
    const photoInput = screen.getByLabelText("写真を選ぶ");
    expect(screen.getByRole("button", { name: "写真を追加" })).toBeEnabled();
    expect(photoInput).toHaveAttribute("accept", "image/jpeg,image/png,image/webp,image/heic,image/heif");
    expect(photoInput).not.toHaveAttribute("capture");

    await user.upload(photoInput, new File(["image"], "day.jpg", { type: "image/jpeg" }));
    expect(onPhotoSelected).toHaveBeenCalledWith(expect.objectContaining({ name: "day.jpg", type: "image/jpeg" }));
  });

  it("offers distinct gallery and rear-camera inputs only inside the enabled photo chooser", async () => {
    const user = userEvent.setup();
    const onPhotoSelected = vi.fn();
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoInputEnabled onPhotoSelected={onPhotoSelected} />);

    expect(screen.queryByRole("dialog", { name: "写真を追加" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "写真を追加" }));
    expect(screen.getByRole("dialog", { name: "写真を追加" })).toBeVisible();
    expect(screen.getByLabelText("写真を選ぶ")).not.toHaveAttribute("capture");
    expect(screen.getByLabelText("カメラで撮る")).toHaveAttribute("capture", "environment");

    fireEvent.change(screen.getByLabelText("カメラで撮る"), {target:{files:[new File(["camera"], "camera.jpg", {type:"image/jpeg"})]}});
    expect(onPhotoSelected).toHaveBeenCalledWith(expect.objectContaining({ name: "camera.jpg", type: "image/jpeg" }));
    expect(screen.queryByRole("dialog", { name: "写真を追加" })).not.toBeInTheDocument();
  });

  it("renders a saved photo only through the supplied content boundary and keeps its delete action local", async () => {
    const dispose = vi.fn();
    const loadPhotoContent = vi.fn(async () => ({ objectUrl: "blob:saved-photo", dispose }));
    const onDeletePhoto = vi.fn();
    const state = {
      profile,
      openingRequestId: null,
      snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "11111111-1111-4111-8111-111111111111", type: "photo" as const, role: "user" as const, photoId: "22222222-2222-4222-8222-222222222222", caption: "これ見て", origin: "photo" as const, createdAt: now, delivery: "sent" as const }] },
    };
    const user = userEvent.setup();
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} loadPhotoContent={loadPhotoContent} onDeletePhoto={onDeletePhoto} />);

    expect(await screen.findByRole("img", { name: "送信した写真" })).toHaveAttribute("src", "blob:saved-photo");
    expect(loadPhotoContent).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", expect.any(AbortSignal));
    expect(screen.getByText("これ見て")).toBeVisible();
    expect(screen.queryByText("写真を送信・保存しました")).not.toBeInTheDocument();
    expect(screen.queryByText("写真を削除")).not.toBeInTheDocument();
    await user.click(screen.getByRole("img", { name: "送信した写真" }));
    await user.click(screen.getByRole("img", { name: "送信した写真" }));
    expect(screen.queryByRole("dialog", { name: "写真を削除" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("img", { name: "送信した写真" }));
    await user.click(screen.getByRole("button", { name: "やめる" }));
    expect(onDeletePhoto).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "写真を削除" })).not.toBeInTheDocument();
    fireEvent.error(screen.getByRole("img", { name: "送信した写真" }));
    expect(screen.getByText("写真を表示できません")).toBeVisible();
    expect(screen.getByText("保存済みですが、写真を表示できません")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "写真の操作を開く" }));
    expect(screen.getByRole("dialog", { name: "写真を削除" })).toBeVisible();
    expect(onDeletePhoto).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "写真を削除する" }));
    expect(onDeletePhoto).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });

  it("places the new day before its first photo, without another divider before the reply", () => {
    const today = "2026-09-09T03:53:00.000Z";
    const state = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
      { id: "yesterday", type: "message" as const, role: "user" as const, text: "昨日", createdAt: "2026-09-08T03:00:00.000Z", delivery: "sent" as const },
      { id: "photo", type: "photo" as const, role: "user" as const, photoId: "22222222-2222-4222-8222-222222222222", caption: "今日の写真", origin: "photo" as const, createdAt: today, delivery: "sent" as const },
      { id: "reply", type: "message" as const, role: "assistant" as const, text: "写真への返答", createdAt: today, delivery: "sent" as const },
    ] } };
    const { container } = render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onOpenSettings={vi.fn()} />);
    const rows = Array.from(container.querySelectorAll('.chat-timeline > li:not(.chat-end-sentinel)'));
    expect(rows).toHaveLength(5);
    expect(rows[2]).toHaveClass('chat-date-divider');
    expect(rows[2]).toHaveTextContent('9月9日');
    expect(rows[3]).toHaveTextContent('今日の写真');
    expect(rows[4]).toHaveTextContent('写真への返答');
  });

  it("clears a photo caption draft only after the parent confirms its delivery", async () => {
    const onDraftChange = vi.fn();
    const state = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, draft: "これ見て" } };
    const props = { state, hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn(), onDraftChange };
    const { rerender } = render(<Chat {...props} />);
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toHaveValue("これ見て");

    rerender(<Chat {...props} clearDraftRequestId={1} />);

    expect(screen.getByRole("textbox", { name: "メッセージ" })).toHaveValue("");
    expect(onDraftChange).toHaveBeenCalledWith("");
  });

  it("does not claim a photo deletion succeeded when its safe action rejects", async () => {
    const user = userEvent.setup();
    const onDeletePhoto = vi.fn(async () => { throw new Error("untrusted deletion detail"); });
    const state = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "11111111-1111-4111-8111-111111111111", type: "photo" as const, role: "user" as const, photoId: "22222222-2222-4222-8222-222222222222", caption: "これ見て", origin: "photo" as const, createdAt: now, delivery: "sent" as const }] } };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onDeletePhoto={onDeletePhoto} />);

    await user.click(screen.getByRole("button", { name: "写真の操作を開く" }));
    await user.click(screen.getByRole("button", { name: "写真を削除する" }));

    expect(await screen.findByText("写真を削除できませんでした。もう一度お試しください。")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "写真の操作を開く" })).toBeVisible();
    expect(screen.queryByText("untrusted deletion detail")).not.toBeInTheDocument();
  });

  it("attaches a prepared photo inside the composer and sends with the regular arrow", async () => {
    const user = userEvent.setup();
    const onSendPhoto = vi.fn();
    const onCancelPhoto = vi.fn();
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoPreview={{ url: "blob:prepared-photo", byteSize: 1234 }} onSendPhoto={onSendPhoto} onCancelPhoto={onCancelPhoto} />);

    expect(screen.getByRole("img", { name: "送信前の写真" })).toHaveAttribute("src", "blob:prepared-photo");
    expect(screen.queryByText("写真を確認してから送信します。")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "送信前の写真" }).closest(".composer-shell")).not.toBeNull();
    expect(onSendPhoto).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    expect(onSendPhoto).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "写真を取り消す" }));
    expect(onCancelPhoto).toHaveBeenCalledOnce();
  });

  it("dismisses the photo picker outside, on the plus toggle, or Escape without activating the background", async () => {
    const user = userEvent.setup();
    const settings = vi.fn();
    render(<Chat state={{ profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onOpenSettings={settings} photoInputEnabled onPhotoSelected={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: '写真を追加' });
    await user.click(toggle);
    const picker = screen.getByRole('dialog', { name: '写真を追加' });
    expect(within(picker).getByRole('button', { name: '写真', exact: true })).toBeVisible();
    expect(within(picker).getByRole('button', { name: 'カメラ', exact: true })).toBeVisible();
    expect(within(picker).queryByRole('button', { name: '閉じる' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '設定を開く' }));
    expect(settings).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '写真を追加' })).toBeNull();
    await user.click(toggle);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '写真を追加' })).toBeNull();
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByRole('dialog', { name: '写真を追加' })).toBeNull();
  });

  it("fails closed when a photo preview has no send and cancel boundary", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoPreview={{ url: "blob:prepared-photo", byteSize: 1234 }} />);
    expect(screen.getByRole("button", { name: "メッセージを送信" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "写真を取り消す" })).toBeDisabled();
  });

  it("prepares an explicitly selected photo locally before displaying the send confirmation", async () => {
    const user = userEvent.setup();
    const transfer = vi.fn();
    const prepared = {
      blob: new Blob(["prepared"], { type: "image/jpeg" }), previewUrl: "blob:prepared-photo", width: 10, height: 10, byteSize: 8,
      transfer, dispose: vi.fn(),
    } satisfies PreparedPhoto;
    const preparePhotoForSelection = vi.fn(async () => prepared);
    const photoApi = { analyze: vi.fn(), commit: vi.fn(), delete: vi.fn(), fetchContent: vi.fn() };
    render(<App splashDurationMs={0} chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => undefined }}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} chatApi={{ respond: vi.fn() }}
      photoApi={photoApi} photoAnalysisEnabled photoPreparation={preparePhotoForSelection} now={() => now} nextId={() => "photo-message"} />);

    const input = await screen.findByLabelText("写真を選ぶ");
    await user.upload(input, new File(["source"], "day.jpg", { type: "image/jpeg" }));

    expect(preparePhotoForSelection).toHaveBeenCalledOnce();
    expect(await screen.findByRole("img", { name: "送信前の写真" })).toHaveAttribute("src", "blob:prepared-photo");
    expect(transfer).not.toHaveBeenCalled();
    expect(photoApi.analyze).not.toHaveBeenCalled();
  });

  it("returns to an actionable photo picker with a fixed alert when preparation rejects", async () => {
    const user = userEvent.setup();
    const photoApi = { analyze: vi.fn(), commit: vi.fn(), delete: vi.fn(), fetchContent: vi.fn() };
    render(<App splashDurationMs={0} chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => undefined }}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} chatApi={{ respond: vi.fn() }}
      photoApi={photoApi} photoAnalysisEnabled photoPreparation={vi.fn(async () => { throw new Error("private raw failure"); })}
      now={() => now} nextId={() => "photo-message"} />);

    await user.upload(await screen.findByLabelText("写真を選ぶ"), new File(["source"], "day.jpg", { type: "image/jpeg" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("写真を準備できませんでした。別の写真で試してください。");
    expect(screen.getByRole("button", { name: "写真を追加" })).toBeEnabled();
    expect(screen.queryByText("private raw failure")).not.toBeInTheDocument();
    expect(photoApi.analyze).not.toHaveBeenCalled();
  });

  it("announces local photo preparation while the selected file is being sanitized", async () => {
    let resolvePreparation: ((photo: PreparedPhoto) => void) | undefined;
    const pendingPreparation = new Promise<PreparedPhoto>((resolve) => { resolvePreparation = resolve; });
    const photoApi = { analyze: vi.fn(), commit: vi.fn(), delete: vi.fn(), fetchContent: vi.fn() };
    const user = userEvent.setup();
    render(<App splashDurationMs={0} chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => undefined }}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} chatApi={{ respond: vi.fn() }}
      photoApi={photoApi} photoAnalysisEnabled photoPreparation={() => pendingPreparation}
      now={() => now} nextId={() => "photo-message"} />);

    await user.upload(await screen.findByLabelText("写真を選ぶ"), new File(["source"], "day.jpg", { type: "image/jpeg" }));

    expect(screen.getByRole("status")).toHaveTextContent("写真を準備しています");
    expect(screen.getByRole("button", { name: "写真を追加" })).toBeDisabled();

    resolvePreparation?.({
      blob: new Blob(["prepared"], { type: "image/jpeg" }), previewUrl: "blob:prepared-photo", width: 10, height: 10, byteSize: 8,
      transfer: vi.fn(), dispose: vi.fn(),
    });
    expect(await screen.findByRole("img", { name: "送信前の写真" })).toBeVisible();
  });

  it("keeps the photo picker above the fixed composer and scrolling timeline", async () => {
    const user = userEvent.setup();
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoInputEnabled onPhotoSelected={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "写真を追加" }));
    const picker = screen.getByRole("dialog", { name: "写真を追加" });
    expect(picker).toContainElement(screen.getByRole("button", { name: "写真", exact:true }));
    expect(picker).toContainElement(screen.getByRole("button", { name: "カメラ", exact:true }));
    expect(chatStyles).toMatch(/\.photo-picker\s*\{[^}]*position:\s*absolute[^}]*z-index:\s*[7-9]\d*[^}]*\}/u);
    expect(chatStyles).toMatch(/\.chat-bottom-stack\s*\{[^}]*z-index:\s*6/u);
    expect(chatStyles).toMatch(/\.composer-shell\s*\{[^}]*overflow:\s*visible/u);
  });

  it("blocks duplicate photo actions while the confirmed photo is being sent", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoPreview={{ url: "blob:prepared-photo", byteSize: 1234, sending: true }} onSendPhoto={vi.fn()} onCancelPhoto={vi.fn()} />);
    expect(screen.getByRole("button", { name: "メッセージを送信" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "写真を取り消す" })).toBeDisabled();
  });

  it("shows storage progress in the composer without another confirmation dialog", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoPreview={{ url: "blob:prepared-photo", byteSize: 1234, sending: true }} photoStatusMessage="会話に保存しています" onSendPhoto={vi.fn()} onCancelPhoto={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("会話に保存しています");
    expect(screen.queryByText("写真を確認してから送信します。")).not.toBeInTheDocument();
  });

  it("does not fetch or offer deletion of a photo that is still being delivered", () => {
    const loadPhotoContent = vi.fn(async () => ({ objectUrl: "blob:pending", dispose: vi.fn() }));
    const state = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "pending", type: "photo" as const, role: "user" as const, photoId: "pending", caption: "", createdAt: now, delivery: "sending" as const, origin: "photo" as const }] } };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} loadPhotoContent={loadPhotoContent} onDeletePhoto={vi.fn()} />);
    expect(loadPhotoContent).not.toHaveBeenCalled();
    expect(screen.getByText("写真を送信・保存しています")).toBeVisible();
    expect(screen.queryByRole("button", { name: "写真を削除" })).not.toBeInTheDocument();
  });

  it("offers only a generic retry after a retryable photo delivery failure", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoPreview={{ url: "blob:prepared-photo", byteSize: 1234, retryable: true }} onSendPhoto={vi.fn()} onCancelPhoto={vi.fn()} />);
    expect(screen.getByText("送信を再試行してください")).toBeVisible();
    expect(screen.getByRole("button", { name: "メッセージを送信" })).toBeEnabled();
    expect(screen.queryByText("untrusted provider detail")).not.toBeInTheDocument();
  });

  it("offers storage-only recovery when photo receipt is known but storage is unconfirmed", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} photoPreview={{ url: "blob:prepared-photo", byteSize: 1234, retryable: true, saveOnly: true }} onSendPhoto={vi.fn()} onCancelPhoto={vi.fn()} />);
    expect(screen.getByText("保存を再試行してください")).toBeVisible();
    expect(screen.getByRole("button", { name: "メッセージを送信" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "写真を取り消す" })).toBeEnabled();
  });

  it("keeps the centered toolbar and composer outside the scrollable talk", async () => {
    chatApp({integratedUiEnabled:true});
    const header=await screen.findByRole("banner");
    const composer=await screen.findByRole("textbox",{name:"メッセージ"});
    const history=screen.getByTestId("chat-scroll-area");
    expect(history).not.toContainElement(header);
    expect(history).not.toContainElement(composer);
    expect(header).toContainElement(screen.getByRole("button",{name:"トークを開く"}));
    expect(header).toContainElement(screen.getByRole("button",{name:"ライブチャットを開始"}));
    expect(header).toContainElement(screen.getByRole("button",{name:"音声ON"}));
    expect(header).toContainElement(screen.getByRole("button",{name:"メニューを開く"}));
    expect(screen.queryByRole("navigation",{name:"ずんだもんの主な画面"})).not.toBeInTheDocument();
  });

  it("opens the approved integrated menu instead of exposing a settings gear", async () => {
    const user = userEvent.setup();
    chatApp({ integratedUiEnabled: true });

    expect(await screen.findByRole("button", { name: "メニューを開く" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "設定を開く" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "メニューを開く" }));

    expect(screen.getByRole("main", { name: "ずんだもんとの継続トーク" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "メニュー" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "メニュー" })).toBeVisible();
    expect(screen.getByRole("button", { name: "アプリ設定" })).toBeVisible();
    expect(screen.getByRole("button", { name: "接続サービス" })).toBeVisible();
    expect(screen.getByRole("button", { name: "クレジット" })).toBeVisible();
  });

  it("opens search from the Talk heading and removes the menu shortcut", async () => {
    const user = userEvent.setup();
    chatApp({ integratedUiEnabled: true });
    await user.click(await screen.findByRole("button", { name: "メニューを開く" }));
    expect(within(screen.getByRole("dialog", {name:"メニュー"})).queryByRole("button", {name:"トークを検索"})).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name:"閉じてホームへ戻る"}));
    await user.click(screen.getByRole("button", {name:"トークを開く"}));
    const searchButton=screen.getByRole("button", {name:"履歴を検索"});
    expect(searchButton.parentElement).toContainElement(screen.getByRole("heading", {name:"トーク",exact:true}));
    await user.click(searchButton);
    expect(screen.getByRole("searchbox", {name:"チャット履歴を検索"})).toHaveFocus();
    expect(screen.getByRole("textbox", {name:"メッセージ"})).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name:"検索を閉じる"}));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name:"履歴を検索"})).toHaveFocus();
    expect(screen.getByRole("button", {name:"トークを閉じる"})).toHaveAttribute("aria-expanded","true");
  });

  it("does not reopen a closed search after leaving and returning to Talk", async () => {
    const user = userEvent.setup();
    chatApp({ integratedUiEnabled: true });
    await user.click(await screen.findByRole("button", {name:"トークを開く"}));
    await user.click(screen.getByRole("button", {name:"履歴を検索"}));
    await user.click(screen.getByRole("button", {name:"検索を閉じる"}));
    await user.click(screen.getByRole("button", {name:"メニューを開く"}));
    await user.click(screen.getByRole("button", {name:"閉じてホームへ戻る"}));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("grows the message field up to five lines and keeps its actions on a lower row", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 164 });
    Object.defineProperty(composer, "clientHeight", { configurable: true, value: 72 });
    fireEvent.change(composer, { target: { value: "一行目\n二行目\n三行目\n四行目\n五行目\n六行目" } });

    expect(composer).toHaveStyle({ height: "120px", overflowY: "auto" });
    const actionRow = composer.closest(".composer-shell")?.querySelector(".composer-actions-row");
    expect(actionRow).toContainElement(screen.getByRole("button", { name: "音声入力を開始" }));
    expect(actionRow).toContainElement(screen.getByRole("button", { name: "メッセージを送信" }));
  });

  it("keeps call feedback and the composer clear of iPhone screen edges", () => {
    expect(chatStyles).toContain("height: 100dvh");
    expect(chatStyles).toContain("padding-bottom: calc(32px + env(safe-area-inset-bottom))");
    expect(chatStyles).toContain("padding-right: max(14px, env(safe-area-inset-right))");
    expect(chatStyles).toContain("padding-left: max(14px, env(safe-area-inset-left))");
    expect(chatStyles).toMatch(/\.call-feedback\s*\{[^}]*margin:\s*0 max\(16px, env\(safe-area-inset-right\)\) 8px max\(16px, env\(safe-area-inset-left\)\)/s);
    expect(chatStyles).toMatch(/\.call-error button\s*\{[^}]*min-height:\s*44px/s);
  });

  it("shows a visible call preparation state and a retryable failure", async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    const base = {
      state, hydrating: false, persistenceWarning: false,
      onSend: vi.fn(), onRetry: vi.fn(), onOpenSettings: vi.fn(),
      onStartDictation: vi.fn(), onCall,
    };
    const { rerender } = render(<Chat {...base} callPreparing />);
    expect(screen.getByRole("status", { name: "ずんだもんとの通話を接続中" })).toBeVisible();
    expect(screen.getByRole("button", { name: "通話を準備しています" })).toBeDisabled();
    rerender(<Chat {...base} callPreparing={false} callError="通信が切れました" />);
    await user.click(screen.getByRole("button", { name: "通話をもう一度試す" }));
    expect(onCall).toHaveBeenCalledOnce();
  });

  it("keeps call failure feedback inside the measured floating header", () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} callError="マイクを確認してください" onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("マイクを確認してください");
    expect(alert).toHaveClass("call-error");
    expect(alert).toHaveAccessibleName("通話の準備");
    expect(alert.parentElement).toHaveClass("chat-header");
  });

  it("shows a recording waveform and lets the send action finish and send the recording", async () => {
    const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
    const onSendDictation = vi.fn();
    const user = userEvent.setup();
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} onStartDictation={vi.fn()} onSendDictation={onSendDictation} dictationState="recording" />);

    expect(screen.getByRole("status", { name: "録音中" })).toBeVisible();
    const send = screen.getByRole("button", { name: "録音を送信" });
    expect(send).toBeEnabled();
    await user.click(send);

    expect(onSendDictation).toHaveBeenCalledOnce();
  });

  it("shows a cloud conflict instead of the generic local-storage warning", () => {
    const state = { profile, openingRequestId: null, delayedGreetingReplyGroupId: null, snapshot: EMPTY_LOCAL_CHAT };
    render(<Chat state={state} hydrating={false} persistenceWarning="別の画面で会話が更新されました" onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("別の画面で会話が更新されました");
    expect(screen.queryByText("この端末には履歴を保存できません")).not.toBeInTheDocument();
  });

  it("routes Talk bubbles through the approved soft-graphite theme consumers", () => {
    const approvedTokens = {
      "--yui-action-graphite": "#3B3B3B",
      "--yui-action-hover": "#252525",
      "--yui-interaction-hover-light": "rgb(59 59 59 / 10%)",
      "--yui-interaction-hover-dark": "rgb(247 247 246 / 14%)",
      "--yui-search-match-light": "#E8E8E7",
      "--yui-search-match-dark": "#454545",
      "--yui-owner-bubble-light-bg": "#F3F3F3",
      "--yui-owner-bubble-light-text": "#1B1B1B",
      "--yui-owner-bubble-light-border": "#EDEDED",
      "--yui-owner-bubble-dark-bg": "#303030",
      "--yui-owner-bubble-dark-text": "#F7F7F6",
      "--yui-owner-bubble-dark-border": "#3A3A3A",
      "--yui-assistant-bubble-light-bg": "#FFFFFF",
      "--yui-assistant-bubble-light-border": "#E9E9E8",
      "--yui-assistant-bubble-dark-bg": "#272727",
      "--yui-assistant-bubble-dark-border": "#3D3D3D",
      "--yui-speech-text-light": "#242424",
      "--yui-speech-text-dark": "#F7F7F6",
    } as const;
    for (const [token, value] of Object.entries(approvedTokens)) {
      const escapedValue = value.replace(/[()]/g, "\\$&");
      expect(chatStyles).toMatch(new RegExp(`${token}:\\s*${escapedValue};`, "i"));
    }
    expect(chatStyles).toMatch(/\.header-action:hover[^}]*var\(--yui-interaction-hover\)/);
    expect(chatStyles).toMatch(/\.chat-message\.is-search-match p[^}]*var\(--yui-search-match\)/);
    expect(chatStyles).toMatch(/\.latest-chat-action:hover[^}]*var\(--yui-action-hover\)/);
    for (const retired of ["#071426", "#eaf4ff", "rgb(234 244 255", "rgb(245 248 252", "rgb(7 20 38", "rgb(6 18 35"]) {
      expect(chatStyles.toLowerCase()).not.toContain(retired);
    }

    const state = {
      profile,
      openingRequestId: null,
      snapshot: {
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          { id: "owner-token", type: "message" as const, role: "user" as const, text: "下書きではない発言", createdAt: now, delivery: "sent" as const },
          { id: "assistant-token", type: "message" as const, role: "assistant" as const, text: "ずんだもんの発言", createdAt: now, delivery: "sent" as const },
        ],
      },
    };
    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText("下書きではない発言")).toHaveClass("chat-message-bubble");
    expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("ずんだもんの発言")).toHaveClass("chat-message-bubble");
    for (const consumer of [
      "--yui-owner-bubble-bg",
      "--yui-owner-bubble-text",
      "--yui-owner-bubble-border",
      "--yui-assistant-bubble-bg",
      "--yui-assistant-bubble-border",
      "--yui-speech-text",
    ]) {
      expect(chatStyles).toContain(`var(${consumer})`);
    }
    expect(chatStyles).toContain("@media (prefers-color-scheme: dark)");
    expect(chatStyles).toMatch(/\.chat-message\.is-assistant p[^}]*color:\s*var\(--yui-speech-text\)/);
    expect(chatStyles).toMatch(/\.yui-speech-bubble[^}]*color:\s*var\(--yui-speech-text\)/);
  });


  it("keeps a direct Chat fixture without a greeting idle past the reveal deadline", async () => {
    vi.useFakeTimers();
    try {
      const state = { profile, openingRequestId: null, snapshot: EMPTY_LOCAL_CHAT };
      render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(2_400); });

      expect(screen.queryByText("入力中…")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the character toolbar and local date in the opened talk", async () => {
    chatApp({
      store: {
        load: async () => ({ ...EMPTY_LOCAL_CHAT, timeline: [{
          id: "legacy-assistant",
          type: "message",
          role: "assistant",
          text: "こんばんは",
          createdAt: now,
          delivery: "sent",
        }] }),
        save: async () => undefined,
      },
    });

    await userEvent.setup().click(await screen.findByRole("button", { name: "トークを開く" }));
    expect(screen.getByRole("button", { name: "設定を開く" })).toBeVisible();
    const callButton = screen.getByRole("button", { name: "ライブチャットを開始" });
    expect(callButton).toBeVisible();
    expect(callButton).not.toHaveTextContent("☎");
    expect(callButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("8月8日（土）")).toBeVisible();
    expect(screen.getByTestId("message-legacy-assistant").querySelector("time")).toHaveClass("chat-message-time");
    expect(screen.queryByText(/ここにいます|同じ時間にいます|オンライン/)).not.toBeInTheDocument();
  });

  it("opens saved memories from settings and returns to settings", async () => {
    const user = userEvent.setup();
    chatApp({ memoryApi: {
      list: async () => [],
      update: async () => { throw new Error("unused"); }, forget: async () => undefined, listTombstones: async () => [], releaseTombstone: async () => undefined,
      getSettings: async () => ({ memoryEnabled: true, updatedAt: now }),
      updateSettings: async (settings) => ({ ...settings, updatedAt: now }),
    } });

    await user.click(await screen.findByRole("button", { name: "設定を開く" }));
    await user.click(screen.getByRole("button", { name: "覚えたことを開く" }));
    expect(await screen.findByRole("heading", { name: "覚えていること" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "プロフィールへ戻る" }));
    expect(await screen.findByRole("heading", { name: "設定" })).toBeVisible();
  });

  it("blocks dictation while a draft, send, or call is active", () => {
    const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, draft: "あとで送る" } };
    const props = { hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn(), onStartDictation: vi.fn() };
    const { rerender } = render(<Chat state={baseState} {...props} />);
    expect(screen.getByRole("button", { name: "音声入力を開始" })).toBeDisabled();

    rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, draft: "", timeline: [{ id: "sending", type: "message", role: "user", text: "送信中", createdAt: now, delivery: "sending" }] } }} {...props} />);
    expect(screen.getByRole("button", { name: "音声入力を開始" })).toBeDisabled();

    rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, draft: "" } }} dictationDisabled {...props} />);
    const microphone = screen.getByRole("button", { name: "音声入力を開始" });
    expect(microphone).toBeDisabled();
    expect(microphone.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("applies the microphone lock to the retry control too", () => {
    const lockedState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, draft: "編集中" } };
    const props = { hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn(), onStartDictation: vi.fn(), dictationError: "音声入力に失敗しました。" };
    const { rerender } = render(<Chat state={lockedState} {...props} />);
    expect(screen.getByRole("button", { name: "もう一度試す" })).toBeDisabled();

    rerender(<Chat state={{ ...lockedState, snapshot: { ...lockedState.snapshot, draft: "" } }} dictationDisabled {...props} />);
    expect(screen.getByRole("button", { name: "もう一度試す" })).toBeDisabled();
  });

  it("keeps Enter as a newline after IME composition and sends only with the arrow button", async () => {
    const respond = vi.fn(async ({ clientMessageId }: { clientMessageId: string }) => ({ id: `${clientMessageId}:assistant`, role: "assistant" as const, text: "おかえりなさい", createdAt: now }));
    chatApp({ profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond } });
    const user = userEvent.setup();
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    respond.mockClear();

    fireEvent.compositionStart(composer);
    await user.type(composer, "ただいま");
    await user.keyboard("{Enter}");
    expect(respond).not.toHaveBeenCalled();
    fireEvent.compositionEnd(composer);
    await user.type(composer, "一行目{Shift>}{Enter}{/Shift}二行目");
    expect(composer).toHaveValue("ただいま\n一行目\n二行目");
    expect(respond).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  });

  it("restores an unsent draft after reload", async () => {
    let snapshot = EMPTY_LOCAL_CHAT;
    const store: LocalStateStore = {
      load: async () => snapshot,
      save: async (next) => { snapshot = next; },
    };
    const user = userEvent.setup();
    const props = { splashDurationMs: 0, chatStore: store, profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond: async ({ clientMessageId }: { clientMessageId: string }) => reply(clientMessageId) }, now: () => now, nextId: () => crypto.randomUUID() };
    const first = render(<App {...props} />);

    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "また明日");
    await waitFor(() => expect(snapshot.draft).toBe("また明日"));
    first.unmount();
    render(<App {...props} />);

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toHaveValue("また明日");
  });

  it("shows a dot-only typing status and reveals a fresh three-bubble reply group in sequence", async () => {
    vi.useFakeTimers();
    try {
      const baseState = {
        profile,
        openingRequestId: null,
        snapshot: {
          ...EMPTY_LOCAL_CHAT,
          timeline: [{ id: "old", type: "message" as const, role: "assistant" as const, text: "すでに見た返信", createdAt: now, delivery: "sent" as const, replyGroupId: "old-group", sequence: 0 }],
        },
      };
      const stateWithThreeFreshBubbles = {
        ...baseState,
        snapshot: {
          ...baseState.snapshot,
          timeline: [
            ...baseState.snapshot.timeline,
            { id: "new-0", type: "message" as const, role: "assistant" as const, text: "一つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "new-group", sequence: 0 as const },
            { id: "new-1", type: "message" as const, role: "assistant" as const, text: "二つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "new-group", sequence: 1 as const },
            { id: "new-2", type: "message" as const, role: "assistant" as const, text: "三つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "new-group", sequence: 2 as const },
          ],
        },
      };
      const props = { hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn() };
      const view = render(<Chat state={baseState} {...props} />);
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("すでに見た返信")).toBeVisible();

      view.rerender(<Chat state={stateWithThreeFreshBubbles} {...props} />);
      const status = screen.getByRole("status", { name: "ずんだもんが入力中" });
      expect(status).not.toHaveTextContent("入力中");
      expect(status.querySelectorAll(".typing-dot")).toHaveLength(3);

      await act(async () => { await vi.advanceTimersByTimeAsync(399); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("一つ目")).not.toBeInTheDocument();
      expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("一つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("二つ目")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("二つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("三つ目")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("三つ目")).toBeVisible();
      expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues revealing a fresh reply group after an unrelated timeline update", async () => {
    vi.useFakeTimers();
    try {
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] } };
      const replyState = {
        ...baseState,
        snapshot: { ...baseState.snapshot, timeline: [
          { id: "continued-0", type: "message" as const, role: "assistant" as const, text: "一つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "continued-group", sequence: 0 as const },
          { id: "continued-1", type: "message" as const, role: "assistant" as const, text: "二つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "continued-group", sequence: 1 as const },
          { id: "continued-2", type: "message" as const, role: "assistant" as const, text: "三つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "continued-group", sequence: 2 as const },
        ] },
      };
      const props = { hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn() };
      const view = render(<Chat state={baseState} {...props} />);

      view.rerender(<Chat state={replyState} {...props} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("一つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("二つ目")).not.toBeInTheDocument();

      view.rerender(<Chat state={{ ...replyState, snapshot: { ...replyState.snapshot, timeline: [
        ...replyState.snapshot.timeline,
        { id: "continued-user", type: "message", role: "user", text: "途中の更新", createdAt: now, delivery: "sent" },
      ] } }} {...props} />);
      expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("二つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("三つ目")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("三つ目")).toBeVisible();
      expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reveals overlapping fresh reply groups independently and keeps the status until both finish", async () => {
    vi.useFakeTimers();
    try {
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] } };
      const firstReplyGroup = [
        { id: "first-0", type: "message" as const, role: "assistant" as const, text: "A一つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "first-group", sequence: 0 as const },
        { id: "first-1", type: "message" as const, role: "assistant" as const, text: "A二つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "first-group", sequence: 1 as const },
        { id: "first-2", type: "message" as const, role: "assistant" as const, text: "A三つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "first-group", sequence: 2 as const },
      ];
      const secondReplyGroup = [
        { id: "second-0", type: "message" as const, role: "assistant" as const, text: "B一つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "second-group", sequence: 0 as const },
        { id: "second-1", type: "message" as const, role: "assistant" as const, text: "B二つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "second-group", sequence: 1 as const },
        { id: "second-2", type: "message" as const, role: "assistant" as const, text: "B三つ目", createdAt: now, delivery: "sent" as const, replyGroupId: "second-group", sequence: 2 as const },
      ];
      const props = { hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn() };
      const view = render(<Chat state={baseState} {...props} />);

      view.rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: firstReplyGroup } }} {...props} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("A一つ目")).toBeVisible();

      view.rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [...firstReplyGroup, ...secondReplyGroup] } }} {...props} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("A二つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("B一つ目")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("B一つ目")).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("A三つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("B二つ目")).not.toBeInTheDocument();
      expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("B二つ目")).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("B三つ目")).toBeVisible();
      expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("paces the persisted first greeting with an exact typing status and reveals it once", async () => {
    vi.useFakeTimers();
    try {
      const onGreetingRevealed = vi.fn();
      const state = {
        profile,
        openingRequestId: null,
        delayedGreetingReplyGroupId: "profile-1",
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
          { id: "profile-1:0", type: "message" as const, role: "assistant" as const, text: "大輝さん、はじめまして", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-1", sequence: 0 as const },
          { id: "profile-1:1", type: "message" as const, role: "assistant" as const, text: "これからよろしくね", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-1", sequence: 1 as const },
        ] },
      };

      render(<Chat state={state} delayedGreetingReplyGroupId="profile-1" onGreetingRevealed={onGreetingRevealed} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      const typing = screen.getByRole("status", { name: "ずんだもんが入力中" });
      expect(typing).toBeVisible();
      expect(typing).not.toHaveTextContent("入力中");
      expect(typing.querySelectorAll(".typing-dot")).toHaveLength(3);
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("大輝さん、はじめまして")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_799); });
      expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("大輝さん、はじめまして")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("これからよろしくね")).not.toBeInTheDocument();
      expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("これからよろしくね")).toBeVisible();
      expect(onGreetingRevealed).toHaveBeenCalledTimes(1);
      expect(onGreetingRevealed).toHaveBeenCalledWith("profile-1");

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(onGreetingRevealed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a date divider to the first visible message while greeting bubbles are hidden", () => {
    const state = {
      profile,
      openingRequestId: null,
      delayedGreetingReplyGroupId: "profile-hidden",
      snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
        { id: "profile-hidden:0", type: "message" as const, role: "assistant" as const, text: "まだ見えない挨拶", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-hidden", sequence: 0 as const },
        { id: "profile-hidden:1", type: "message" as const, role: "assistant" as const, text: "まだ見えない続き", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-hidden", sequence: 1 as const },
        { id: "visible-user", type: "message" as const, role: "user" as const, text: "先に見える発言", createdAt: now, delivery: "sent" as const },
      ] },
    };

    render(<Chat state={state} delayedGreetingReplyGroupId="profile-hidden" onGreetingRevealed={vi.fn()} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("先に見える発言")).toBeVisible();
    expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("まだ見えない挨拶")).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("8月8日（土）")).toBeVisible();
  });

  it("does not let ordinary fresh-reply staging reveal the delayed greeting early", async () => {
    vi.useFakeTimers();
    try {
      const onGreetingRevealed = vi.fn();
      const baseState = {
        profile,
        openingRequestId: null,
        delayedGreetingReplyGroupId: null,
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] },
      };
      const { rerender } = render(<Chat state={baseState} delayedGreetingReplyGroupId={null} onGreetingRevealed={onGreetingRevealed} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const greetingState = { ...baseState,
        delayedGreetingReplyGroupId: "profile-fresh",
        snapshot: { ...baseState.snapshot, timeline: [
          { id: "profile-fresh:0", type: "message" as const, role: "assistant" as const, text: "遅れて見える一つ目", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-fresh", sequence: 0 as const },
          { id: "profile-fresh:1", type: "message" as const, role: "assistant" as const, text: "遅れて見える二つ目", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-fresh", sequence: 1 as const },
        ] },
      };

      rerender(<Chat state={greetingState} delayedGreetingReplyGroupId="profile-fresh" onGreetingRevealed={onGreetingRevealed} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });

      expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("遅れて見える一つ目")).not.toBeInTheDocument();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("遅れて見える二つ目")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_300); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("遅れて見える一つ目")).toBeVisible();
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("遅れて見える二つ目")).toBeVisible();
      expect(onGreetingRevealed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a persisted greeting immediately on reload without replaying its typing wait", () => {
    const state = {
      profile,
      openingRequestId: null,
      delayedGreetingReplyGroupId: null,
      snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
        { id: "profile-1:0", type: "message" as const, role: "assistant" as const, text: "大輝さん、はじめまして", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-1", sequence: 0 as const },
        { id: "profile-1:1", type: "message" as const, role: "assistant" as const, text: "これからよろしくね", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-1", sequence: 1 as const },
      ] },
    };

    render(<Chat state={state} delayedGreetingReplyGroupId={null} onGreetingRevealed={vi.fn()} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("大輝さん、はじめまして")).toBeVisible();
    expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("これからよろしくね")).toBeVisible();
    expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();
  });

  it("keeps the first-greeting wait under reduced motion", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    try {
      const state = {
        profile,
        openingRequestId: null,
        delayedGreetingReplyGroupId: "profile-reduced",
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
          { id: "profile-reduced:0", type: "message" as const, role: "assistant" as const, text: "大輝さん、はじめまして", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-reduced", sequence: 0 as const },
          { id: "profile-reduced:1", type: "message" as const, role: "assistant" as const, text: "これからよろしくね", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-reduced", sequence: 1 as const },
        ] },
      };
      render(<Chat state={state} delayedGreetingReplyGroupId="profile-reduced" onGreetingRevealed={vi.fn()} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(1_799); });
      expect(screen.getByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("大輝さん、はじめまして")).not.toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("大輝さん、はじめまして")).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("ignores stale first-greeting timers after the conversation generation resets", async () => {
    vi.useFakeTimers();
    try {
      const onGreetingRevealed = vi.fn();
      const state = {
        profile,
        openingRequestId: null,
        delayedGreetingReplyGroupId: "profile-old",
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
          { id: "profile-old:0", type: "message" as const, role: "assistant" as const, text: "古いはじめまして", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-old", sequence: 0 as const },
          { id: "profile-old:1", type: "message" as const, role: "assistant" as const, text: "古いよろしくね", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-old", sequence: 1 as const },
        ] },
      };
      const { rerender } = render(<Chat state={state} delayedGreetingReplyGroupId="profile-old" onGreetingRevealed={onGreetingRevealed} conversationGeneration={1} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      rerender(<Chat state={{ ...state, delayedGreetingReplyGroupId: null, snapshot: { ...state.snapshot, timeline: [] } }} delayedGreetingReplyGroupId={null} onGreetingRevealed={onGreetingRevealed} conversationGeneration={2} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_400); });

      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("古いはじめまして")).not.toBeInTheDocument();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).queryByText("古いよろしくね")).not.toBeInTheDocument();
      expect(onGreetingRevealed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force first-greeting reveals to the bottom after a manual upward scroll", async () => {
    vi.useFakeTimers();
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const state = {
        profile,
        openingRequestId: null,
        delayedGreetingReplyGroupId: "profile-scrolled",
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
          { id: "profile-scrolled:0", type: "message" as const, role: "assistant" as const, text: "スクロール中の挨拶", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-scrolled", sequence: 0 as const },
          { id: "profile-scrolled:1", type: "message" as const, role: "assistant" as const, text: "スクロール中の続き", createdAt: now, delivery: "sent" as const, flow: "profile" as const, replyGroupId: "profile-scrolled", sequence: 1 as const },
        ] },
      };
      render(<Chat state={state} delayedGreetingReplyGroupId="profile-scrolled" onGreetingRevealed={vi.fn()} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 100 },
        scrollTop: { configurable: true, writable: true, value: 100 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      scrollTo.mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_800); });

      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("スクロール中の挨拶")).toBeVisible();
      expect(scrollTo).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();

      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("スクロール中の続き")).toBeVisible();
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
      vi.useRealTimers();
    }
  });

  it("reveals every fresh reply bubble immediately without scheduling timers when reduced motion is preferred", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    try {
      const baseState = {
        profile,
        openingRequestId: null,
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] },
      };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const pendingTimerCount = vi.getTimerCount();

      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [
        { id: "reduced-0", type: "message", role: "assistant", text: "一つ目", createdAt: now, delivery: "sent", replyGroupId: "reduced-group", sequence: 0 },
        { id: "reduced-1", type: "message", role: "assistant", text: "二つ目", createdAt: now, delivery: "sent", replyGroupId: "reduced-group", sequence: 1 },
        { id: "reduced-2", type: "message", role: "assistant", text: "三つ目", createdAt: now, delivery: "sent", replyGroupId: "reduced-group", sequence: 2 },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("一つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("二つ目")).toBeVisible();
      expect(within(screen.getByRole("list", {name: "ずんだもんとの会話"})).getByText("三つ目")).toBeVisible();
      expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(pendingTimerCount);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("searches chat history from the header, highlights the selected result, and keeps the searchbox focused", async () => {
    const user = userEvent.setup();
    const baseState = {
      profile,
      openingRequestId: null,
      snapshot: {
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          { id: "m1", type: "message" as const, role: "user" as const, text: "会議は明日にしよう", createdAt: now, delivery: "sent" as const },
          { id: "m2", type: "message" as const, role: "assistant" as const, text: "明日の会議、楽しみにしてる", createdAt: now, delivery: "sent" as const },
        ],
      },
    };
    render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "履歴を検索" }));
    const searchbox = screen.getByRole("searchbox", { name: "チャット履歴を検索" });
    expect(searchbox).toHaveFocus();
    await user.type(searchbox, "会議");
    expect(screen.getByText("1 / 2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "次の検索結果" }));
    expect(screen.getByTestId("message-m2")).toHaveClass("is-search-match");
    expect(screen.getByRole("button", { name: "次の検索結果" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("searchbox", { name: "チャット履歴を検索" })).not.toBeInTheDocument();
  });

  it("scrolls to and focuses a memory source message without creating another conversation", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    const state = {
      profile,
      openingRequestId: null,
      snapshot: {
        ...EMPTY_LOCAL_CHAT,
        timeline: [{ id: "memory-source", type: "message" as const, role: "user" as const, text: "コーヒーが好き", createdAt: now, delivery: "sent" as const }],
      },
    };

    const props = { sourceMessageId: "memory-source", hydrating: false, persistenceWarning: false, onSend: vi.fn(), onRetry: vi.fn(), onCall: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender } = render(<Chat state={state} {...props} />);

    const source = await screen.findByTestId("message-memory-source");
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(source).toHaveFocus();
    expect(source).toHaveClass("is-memory-source");
    const composer = screen.getByRole("textbox", { name: "メッセージ" });
    composer.focus();
    rerender(<Chat state={{ ...state, snapshot: { ...state.snapshot, timeline: [...state.snapshot.timeline, { id: "new-reply", type: "message" as const, role: "assistant" as const, text: "新しい返信", createdAt: now, delivery: "sent" as const }] } }} {...props} />);
    expect(composer).toHaveFocus();
    if (originalScrollTo) Object.defineProperty(Element.prototype, "scrollTo", originalScrollTo);
    else Reflect.deleteProperty(Element.prototype, "scrollTo");
  });

  it("shows a latest button after manual scrolling even without a new reply", async () => {
    const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
    render(<Chat state={state} hydrating={false} persistenceWarning={false}
      onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
      onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "トークを開く" }));
    const scroller = screen.getByTestId("chat-scroll-area");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 503 },
    });
    fireEvent.scroll(scroller);

    expect(await screen.findByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();
  });

  it("hides the latest action while searching chat history", async () => {
    const user = userEvent.setup();
    const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
    render(<Chat state={state} hydrating={false} persistenceWarning={false}
      onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
      onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "トークを開く" }));
    const scroller = screen.getByTestId("chat-scroll-area");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 503 },
    });
    fireEvent.scroll(scroller);
    expect(await screen.findByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "履歴を検索" }));

    expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();
  });

  it("shows the latest action again after closing search more than 96px from the bottom", async () => {
    const user = userEvent.setup();
    const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
    render(<Chat state={state} hydrating={false} persistenceWarning={false}
      onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
      onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
    const scroller = screen.getByTestId("chat-scroll-area");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 503 },
    });

    await user.click(screen.getByRole("button", { name: "履歴を検索" }));
    await user.click(screen.getByRole("button", { name: "検索を閉じる" }));

    expect(screen.getByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();
  });

  it("restores a past search anchor without re-following after the result reaches the latest messages", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const user = userEvent.setup();
      const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
      render(<Chat state={state} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 503 },
        getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: 100 }) },
      });
      for (const id of ["long-assistant-1", "long-user-2", "long-assistant-2", "long-user-3", "long-assistant-3"]) {
        Object.defineProperty(screen.getByTestId(`message-${id}`), "getBoundingClientRect", { configurable: true, value: () => ({ top: -80, bottom: -20, height: 60 }) });
      }
      Object.defineProperty(screen.getByTestId("message-long-user-1"), "getBoundingClientRect", { configurable: true, value: () => ({ top: 20, bottom: 60, height: 40 }) });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      fireEvent.scroll(scroller);
      expect(screen.getByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "履歴を検索" }));
      await user.type(screen.getByRole("searchbox", { name: "チャット履歴を検索" }), "三つ目");
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
      (scroller as HTMLElement).scrollTop = 600;
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      const scrollsBeforeClose = scrollTo.mock.calls.length;
      const endScrollsBeforeClose = scrollTo.mock.calls.filter(([options]) => (options as ScrollToOptions).top === scroller.scrollHeight - scroller.clientHeight).length;

      await user.click(screen.getByRole("button", { name: "検索を閉じる" }));

      expect(scrollTo.mock.calls).toHaveLength(scrollsBeforeClose + 1);
      expect(scrollTo.mock.calls[scrollTo.mock.calls.length - 1]).toEqual([{ behavior: "smooth", top: expect.any(Number) }]);
      expect(scrollTo.mock.calls.filter(([options]) => (options as ScrollToOptions).top === scroller.scrollHeight - scroller.clientHeight)).toHaveLength(endScrollsBeforeClose);
      expect(screen.getByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("does not resume follow from a near-bottom scroll while search is open", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const user = userEvent.setup();
      const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
      const { rerender } = render(<Chat state={state} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 504 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      await user.click(screen.getByRole("button", { name: "履歴を検索" }));
      fireEvent.scroll(scroller);
      scrollTo.mockClear();

      rerender(<Chat state={{ ...state, snapshot: { ...state.snapshot, timeline: [...state.snapshot.timeline,
        { id: "search-open-user", type: "message", role: "user", text: "検索中の送信", createdAt: now, delivery: "sent" },
      ] } }} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

      expect(scrollTo).not.toHaveBeenCalledWith({ behavior: "smooth", top: scroller.scrollHeight - scroller.clientHeight });
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("resumes follow after closing search within 96px of the bottom", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const user = userEvent.setup();
      const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
      const { rerender } = render(<Chat state={state} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 504 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      await user.click(screen.getByRole("button", { name: "履歴を検索" }));
      await user.click(screen.getByRole("button", { name: "検索を閉じる" }));
      scrollTo.mockClear();

      rerender(<Chat state={{ ...state, snapshot: { ...state.snapshot, timeline: [...state.snapshot.timeline,
        { id: "post-search-user", type: "message", role: "user", text: "検索後の送信", createdAt: now, delivery: "sent" },
      ] } }} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("jumps to the latest message and clears the latest action", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const user = userEvent.setup();
      const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
      render(<Chat state={state} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 503 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      fireEvent.scroll(scroller);
      const latest = await screen.findByRole("button", { name: "最新のメッセージへ移動" });

      await user.click(latest);

      expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) });
      expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("uses instant motion to jump to the latest message when reduced motion is preferred", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    try {
      const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
      render(<Chat state={state} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 503 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      fireEvent.scroll(scroller);
      scrollTo.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "最新のメッセージへ移動" }));

      expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: expect.any(Number) });
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
      vi.unstubAllGlobals();
    }
  });

  it("keeps the reader's position when a new reply appears above the latest action", async () => {
    vi.useFakeTimers();
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const state = { profile, openingRequestId: null, snapshot: longTimelineSnapshot };
      const { rerender } = render(<Chat state={state} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 1000 },
        clientHeight: { configurable: true, value: 400 },
        scrollTop: { configurable: true, writable: true, value: 503 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      fireEvent.scroll(scroller);
      expect(screen.getByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();
      scrollTo.mockClear();

      rerender(<Chat state={{ ...state, snapshot: { ...state.snapshot, timeline: [...state.snapshot.timeline,
        { id: "new-reply", type: "message", role: "assistant", text: "新しい返信", createdAt: now, delivery: "sent", replyGroupId: "new-reply", sequence: 0 },
      ] } }} hydrating={false} persistenceWarning={false}
        onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()}
        onOpenSettings={vi.fn()} onStartDictation={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      expect(scroller.scrollTop).toBe(503);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
      vi.useRealTimers();
    }
  });

  it("keeps one clickable latest action above the measured composer after the 97px boundary", async () => {
    const scrollTo = vi.fn();
    const style = document.createElement("style");
    style.textContent = chatStyles;
    document.head.append(style);
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] } };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 100 },
        scrollTop: { configurable: true, writable: true, value: 204 },
      });

      fireEvent.scroll(scroller);
      scrollTo.mockClear();
      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [{ id: "at-boundary", type: "message", role: "assistant", text: "見えている返信", createdAt: now, delivery: "sent", replyGroupId: "boundary", sequence: 0 }] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
      expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();

      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      (scroller as HTMLElement).scrollTop = 203;
      fireEvent.scroll(scroller);
      scrollTo.mockClear();
      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [
        { id: "at-boundary", type: "message", role: "assistant", text: "見えている返信", createdAt: now, delivery: "sent", replyGroupId: "boundary", sequence: 0 },
        { id: "unread-1", type: "message", role: "assistant", text: "新しい返信", createdAt: now, delivery: "sent", replyGroupId: "unread", sequence: 0 },
        { id: "unread-2", type: "message", role: "assistant", text: "続きの返信", createdAt: now, delivery: "sent", replyGroupId: "unread", sequence: 1 },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      const latest = await screen.findByRole("button", { name: "最新のメッセージへ移動" });
      expect(screen.getAllByRole("button", { name: "最新のメッセージへ移動" })).toHaveLength(1);
      expect(latest.parentElement).toHaveClass("chat-history-shell");
      expect(latest).toBeVisible();
      expect(latest.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(getComputedStyle(latest).bottom).toBe("calc(var(--chat-composer-height, 90px) + 16px)");
      expect(getComputedStyle(latest).left).toBe("50%");
      expect(Number.parseInt(getComputedStyle(latest).zIndex, 10)).toBeGreaterThan(6);
      expect(getComputedStyle(latest).pointerEvents).toBe("auto");
      expect(scrollTo).not.toHaveBeenCalled();
      await userEvent.setup().click(latest);
      expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) });
      expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
      style.remove();
    }
  });

  it("keeps following through a later smooth-scroll event that is still away from the bottom", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] } };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 100 },
        scrollTop: { configurable: true, writable: true, value: 204 },
      });

      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [{ id: "first", type: "message", role: "assistant", text: "最初の返信", createdAt: now, delivery: "sent", replyGroupId: "first", sequence: 0 }] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
      (scroller as HTMLElement).scrollTop = 180;
      fireEvent.scroll(scroller);
      scrollTo.mockClear();

      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [
        { id: "first", type: "message", role: "assistant", text: "最初の返信", createdAt: now, delivery: "sent", replyGroupId: "first", sequence: 0 },
        { id: "second", type: "message", role: "assistant", text: "次の返信", createdAt: now, delivery: "sent", replyGroupId: "second", sequence: 0 },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
      expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("stops following when an interrupted smooth scroll ends away from the bottom", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [] } };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 100 },
        scrollTop: { configurable: true, writable: true, value: 204 },
      });

      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [{ id: "first", type: "message", role: "assistant", text: "最初の返信", createdAt: now, delivery: "sent", replyGroupId: "first", sequence: 0 }] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
      (scroller as HTMLElement).scrollTop = 180;
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      scrollTo.mockClear();

      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [
        { id: "first", type: "message", role: "assistant", text: "最初の返信", createdAt: now, delivery: "sent", replyGroupId: "first", sequence: 0 },
        { id: "second", type: "message", role: "assistant", text: "次の返信", createdAt: now, delivery: "sent", replyGroupId: "second", sequence: 0 },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      expect(await screen.findByRole("button", { name: "最新のメッセージへ移動" })).toBeVisible();
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("keeps follow suspended when a search scroll finishes near the bottom", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const user = userEvent.setup();
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [
        { id: "anchor", type: "message" as const, role: "user" as const, text: "今の場所", createdAt: now, delivery: "sent" as const },
        { id: "match", type: "message" as const, role: "assistant" as const, text: "検索する返信", createdAt: now, delivery: "sent" as const },
      ] } };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 400 },
        clientHeight: { configurable: true, value: 100 },
        scrollTop: { configurable: true, writable: true, value: 300 },
      });
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      scrollTo.mockClear();

      await user.click(screen.getByRole("button", { name: "履歴を検索" }));
      const searchbox = screen.getByRole("searchbox", { name: "チャット履歴を検索" });
      await user.type(searchbox, "検索");
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
      (scroller as HTMLElement).scrollTop = 204;
      fireEvent(scroller, new Event("scrollend", { bubbles: true }));
      scrollTo.mockClear();

      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [...baseState.snapshot.timeline,
        { id: "fresh", type: "message", role: "assistant", text: "新しい返信", createdAt: now, delivery: "sent", replyGroupId: "fresh", sequence: 0 },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();
      expect(scrollTo).not.toHaveBeenCalledWith({ behavior: "smooth", top: scroller.scrollHeight - scroller.clientHeight });
      expect(searchbox).toHaveFocus();
      expect(screen.getByTestId("message-match")).toHaveClass("is-search-match");
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("scrolls to the end when a newly rendered user message arrives while following", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "old", type: "message" as const, role: "assistant" as const, text: "前の会議", createdAt: now, delivery: "sent" as const }] } };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      scrollTo.mockClear();
      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [...baseState.snapshot.timeline,
        { id: "new-user", type: "message", role: "user", text: "次の会議", createdAt: now, delivery: "sent" },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ behavior: "smooth", top: expect.any(Number) }));
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("uses a newly rendered visible user message as the search return anchor", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    try {
      const user = userEvent.setup();
      const baseState = { profile, openingRequestId: null, snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "old", type: "message" as const, role: "assistant" as const, text: "前の会議", createdAt: now, delivery: "sent" as const }] } };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [...baseState.snapshot.timeline,
        { id: "new-user", type: "message", role: "user", text: "次の会議", createdAt: now, delivery: "sent" },
        { id: "later", type: "message", role: "assistant", text: "最後の会議", createdAt: now, delivery: "sent" },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      const scroller = screen.getByTestId("chat-scroll-area");
      Object.defineProperty(scroller, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 100 }) });
      Object.defineProperty(screen.getByTestId("message-old"), "getBoundingClientRect", { configurable: true, value: () => ({ top: -80, bottom: -20, height: 60 }) });
      Object.defineProperty(screen.getByTestId("message-new-user"), "getBoundingClientRect", { configurable: true, value: () => ({ top: 20, bottom: 60, height: 40 }) });

      await user.click(screen.getByRole("button", { name: "履歴を検索" }));
      await user.type(screen.getByRole("searchbox", { name: "チャット履歴を検索" }), "会議");
      expect(screen.getByText("2 / 3")).toBeVisible();
      expect(screen.getByTestId("message-new-user")).toHaveClass("is-search-match");
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("suspends follow when search opens, restores the anchor on close, and uses instant motion when requested", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: scrollTo });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    try {
      const user = userEvent.setup();
      const baseState = {
        profile,
        openingRequestId: null,
        snapshot: { ...EMPTY_LOCAL_CHAT, timeline: [{ id: "anchor", type: "message" as const, role: "user" as const, text: "ここに戻る", createdAt: now, delivery: "sent" as const }] },
      };
      const { rerender } = render(<Chat state={baseState} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "履歴を検索" }));
      const searchbox = screen.getByRole("searchbox", { name: "チャット履歴を検索" });
      expect(searchbox).toHaveFocus();
      scrollTo.mockClear();
      rerender(<Chat state={{ ...baseState, snapshot: { ...baseState.snapshot, timeline: [...baseState.snapshot.timeline,
        { id: "fresh", type: "message", role: "assistant", text: "新しい返信", createdAt: now, delivery: "sent", replyGroupId: "fresh", sequence: 0 },
      ] } }} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={vi.fn()} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

      expect(screen.queryByRole("button", { name: "最新のメッセージへ移動" })).not.toBeInTheDocument();
      expect(searchbox).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "検索を閉じる" }));
      expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", top: expect.any(Number) });
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
      vi.unstubAllGlobals();
    }
  });

  it("ignores a synchronous double click before React has rerendered the pending send", async () => {
    let resolveReply: ((value: { id: string; role: "assistant"; text: string; createdAt: string }) => void) | undefined;
    const respond = vi.fn(({ kind, clientMessageId }: { kind: "opening" | "reply"; clientMessageId: string }) => kind === "opening"
      ? Promise.resolve({ id: `${clientMessageId}:assistant`, role: "assistant" as const, text: "こんばんは", createdAt: now })
      : new Promise<{ id: string; role: "assistant"; text: string; createdAt: string }>((resolve) => { resolveReply = resolve; }));
    chatApp({ profileApi: { get: async () => profile, save: async () => profile }, chatApi: { respond } });
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "ただいま");
    await user.dblClick(screen.getByRole("button", { name: "メッセージを送信" }));

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText("ただいま")).toHaveLength(1);
    resolveReply?.({ id: "reply:assistant", role: "assistant", text: "おかえりなさい", createdAt: now });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  });

  it("adds a local date divider for every local day transition", async () => {
    chatApp({
      store: { load: async () => ({ ...EMPTY_LOCAL_CHAT, timeline: [
        { id: "one", type: "message", role: "assistant", text: "昨日です", createdAt: "2026-08-07T14:55:00.000Z", delivery: "sent" },
        { id: "two", type: "message", role: "user", text: "今日です", createdAt: "2026-08-08T12:48:00.000Z", delivery: "sent" },
      ] }), save: async () => undefined },
    });

    expect(await screen.findByText("8月7日（金）")).toBeVisible();
    expect(screen.getByText("23:55")).toHaveClass("chat-message-time");
    expect(screen.getByText("8月8日（土）")).toBeVisible();
    expect(screen.getByTestId("message-two").querySelector("time")).toHaveClass("chat-message-time");
  });

  it("renders LINE-style local dates and role-aware message times without making time searchable", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const state = {
      profile,
      openingRequestId: null,
      failureByMessageId: { "user-morning": "upstream" as const },
      snapshot: {
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          { id: "assistant-morning", type: "message" as const, role: "assistant" as const, text: "おはよう", createdAt: "2025-08-09T00:48:00.000Z", delivery: "sent" as const },
          { id: "user-morning", type: "message" as const, role: "user" as const, text: "おはよう、ずんだもん", createdAt: "2025-08-09T00:50:00.000Z", delivery: "failed" as const },
          { id: "call-between-days", type: "call" as const, startedAt: "2025-08-09T00:52:00.000Z", endedAt: "2025-08-09T00:53:00.000Z" },
          { id: "assistant-midnight", type: "message" as const, role: "assistant" as const, text: "次の日だね", createdAt: "2025-08-10T00:01:00.000Z", delivery: "sent" as const },
          { id: "invalid-time", type: "message" as const, role: "user" as const, text: "時刻なし", createdAt: "not-a-date", delivery: "sent" as const },
        ],
      },
    };

    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={retry} onCall={vi.fn()} onOpenSettings={vi.fn()} />);

    expect(screen.getByText("8月9日（土）")).toBeVisible();
    expect(screen.queryByText(/8月9日（土）\s+09:48/)).not.toBeInTheDocument();
    expect(screen.getByText("8月10日（日）")).toBeVisible();
    expect(screen.getAllByText(/8月[0-9]+日/)).toHaveLength(2);
    expect(screen.getByText("09:48")).toHaveClass("chat-message-time");
    expect(screen.getByText("09:50")).toHaveClass("chat-message-time");
    expect(screen.getByText("09:48").previousElementSibling).toHaveTextContent("おはよう");
    expect(screen.getByText("09:50").nextElementSibling).toHaveTextContent("おはよう、ずんだもん");
    expect(screen.getByTestId("message-assistant-morning")).toHaveAccessibleName("ずんだもん：おはよう（09:48）");
    expect(screen.getByTestId("message-invalid-time")).toHaveAccessibleName("あなた：時刻なし");
    expect(screen.getByRole("button", { name: "もう一度送る" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("ただいま接続先が不安定です");
    await user.click(screen.getByRole("button", { name: "もう一度送る" }));
    expect(retry).toHaveBeenCalledWith("user-morning");
    expect(screen.getByText("ずんだもんと1分話しました").querySelector("time")).toBeNull();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.getByTestId("message-invalid-time").querySelector("time")).toBeNull();

    const anchor = screen.getByTestId("message-assistant-morning");
    await user.click(screen.getByRole("button", { name: "履歴を検索" }));
    await user.type(screen.getByRole("searchbox", { name: "チャット履歴を検索" }), "09:48");
    expect(screen.getByText("0 / 0")).toBeVisible();
    expect(screen.getByTestId("message-assistant-morning")).toBe(anchor);
  });

  it("opens settings instead of retrying a Talk send that requires a profile", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const openSettings = vi.fn();
    const state = {
      profile,
      openingRequestId: null,
      failureByMessageId: { "profile-required-message": "profile-required" as const },
      snapshot: {
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          { id: "profile-required-message", type: "message" as const, role: "user" as const, text: "話しかけたい", createdAt: now, delivery: "failed" as const },
        ],
      },
    };

    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={retry} onCall={vi.fn()} onOpenSettings={openSettings} />);

    expect(screen.getByRole("status")).toHaveTextContent("プロフィールの設定を確認して、もう一度お試しください");
    expect(screen.queryByRole("button", { name: "もう一度送る" })).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId("message-profile-required-message")).getByRole("button", { name: "設定を開く" }));
    expect(openSettings).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("returns to login instead of retrying a Talk send after authentication expires", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const requireAuthentication = vi.fn();
    const state = {
      profile,
      openingRequestId: null,
      failureByMessageId: { "authentication-required-message": "authentication" as const },
      snapshot: {
        ...EMPTY_LOCAL_CHAT,
        timeline: [
          { id: "authentication-required-message", type: "message" as const, role: "user" as const, text: "話しかけたい", createdAt: now, delivery: "failed" as const },
        ],
      },
    };

    render(<Chat state={state} hydrating={false} persistenceWarning={false} onSend={vi.fn()} onRetry={retry} onCall={vi.fn()} onOpenSettings={vi.fn()} onAuthenticationRequired={requireAuthentication} />);

    expect(screen.getByRole("status")).toHaveTextContent("ログイン状態を確認して、もう一度お試しください");
    expect(screen.queryByRole("button", { name: "もう一度送る" })).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId("message-authentication-required-message")).getByRole("button", { name: "ログイン画面に戻る" }));
    expect(requireAuthentication).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("returns the hosted app to authentication instead of retrying an expired Talk session", async () => {
    const user = userEvent.setup();
    const onSignOut = vi.fn(async () => undefined);
    render(<App splashDurationMs={0}
      chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => undefined }}
      profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }}
      chatApi={{ respond: async () => { throw new YuiRequestError("authentication", 401); } }}
      onSignOut={onSignOut}
      now={() => now}
      nextId={() => "authentication-required-message"}
    />);

    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "話しかけたい");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    await user.click(await screen.findByRole("button", { name: "ログイン画面に戻る" }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "もう一度送る" })).not.toBeInTheDocument();
  });

  it("renders pending, retryable, and non-blocking persistence states", async () => {
    let rejectReply: ((cause?: unknown) => void) | undefined;
    const respond = vi.fn(({ kind, clientMessageId }: { kind: "opening" | "reply"; clientMessageId: string }) => kind === "opening"
      ? Promise.resolve({ id: `${clientMessageId}:assistant`, role: "assistant" as const, text: "こんばんは", createdAt: now })
      : new Promise<never>((_, reject) => { rejectReply = reject; }));
    chatApp({
      store: { load: async () => EMPTY_LOCAL_CHAT, save: async () => { throw new Error("private mode"); } },
      profileApi: { get: async () => profile, save: async () => profile },
      chatApi: { respond },
    });
    const user = userEvent.setup();
    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    await user.type(composer, "ただいま");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));

    expect(await screen.findByRole("status", { name: "ずんだもんが入力中" })).toBeVisible();
    expect(screen.getByText("この端末には履歴を保存できません")).toBeVisible();
    rejectReply?.(new Error("offline"));
    expect(await screen.findByRole("button", { name: "もう一度送る" })).toBeVisible();
  });

  it("keeps initial setup open after a failed profile save and allows an explicit retry", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(profile);
    chatApp({ profileApi: { get: async () => null, save } });
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "あなたの名前" });
    await user.type(name, "大輝");
    await user.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    expect(screen.queryByText("大輝さん、はじめまして")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("設定を保存できませんでした");
    expect(name).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "はじめる" }));

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
  });

  it("returns from the separate memory screen to the existing source message", async () => {
    const sourceMemory = {
      id: "00000000-0000-4000-8000-000000000001", kind: "preference" as const, scope: "shared" as const,
      content: "コーヒーが好き", normalizedContent: "コーヒーが好き", status: "active" as const, origin: "extracted" as const,
      sensitivity: "normal" as const, importance: 3 as const, sourceMessageId: "memory-source", sourceOccurredAt: now,
      validFrom: null, validUntil: null, expiresAt: null, pinned: true, supersedesId: null, createdAt: now, updatedAt: now,
    };
    const memoryApi: MemoryApi = {
      process: async ({ sourceMessageId }) => ({ sourceMessageId, state: "completed", appliedCount: 0 }),
      list: async () => [sourceMemory], update: async () => sourceMemory, forget: async () => undefined,
      listTombstones: async () => [], releaseTombstone: async () => undefined,
      getSettings: async () => ({ memoryEnabled: true, updatedAt: now }),
      updateSettings: async (settings) => ({ ...settings, updatedAt: now }),
    };
    const snapshot = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now, lastConversationAt: now, timeline: [
      { id: "memory-source", type: "message" as const, role: "user" as const, text: "コーヒーが好き", createdAt: now, delivery: "sent" as const },
      { id: "memory-source:assistant:0", type: "message" as const, role: "assistant" as const, text: "覚えておくね", createdAt: now, delivery: "sent" as const, replyGroupId: "memory-source:assistant", sequence: 0 as const },
    ] };
    const user = userEvent.setup();
    chatApp({ store: { load: async () => snapshot, save: async () => undefined }, memoryApi, integratedUiEnabled: true });

    await openIntegratedSettings(user);
    await user.click(screen.getByRole("button", { name: "覚えたことを開く" }));
    await user.click(await screen.findByRole("button", { name: "元の会話を見る" }));

    expect(await screen.findByTestId("message-memory-source")).toHaveFocus();
    expect(screen.getByRole("main", { name: "ずんだもんとの継続トーク" })).toBeVisible();
    expect(screen.getByRole("button", { name: "メニューを開く" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "覚えていること" })).not.toBeInTheDocument();
  });

  it("ignores a delayed persistence failure from an old App generation", async () => {
    let rejectOldSave: ((reason?: unknown) => void) | undefined;
    const loadedSnapshot = { ...EMPTY_LOCAL_CHAT, lastOpeningAt: now };
    const oldStore: LocalStateStore = {
      load: async () => loadedSnapshot,
      save: async () => new Promise<void>((_, reject) => { rejectOldSave = reject; }),
    };
    const newStore: LocalStateStore = { load: async () => loadedSnapshot, save: async () => undefined };
    const { rerender } = render(<App splashDurationMs={0} chatStore={oldStore} profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} chatApi={{ respond: async ({ clientMessageId }) => reply(clientMessageId, "こんばんは") }} now={() => now} nextId={() => "old"} />);
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "大輝");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    await waitFor(() => expect(rejectOldSave).toBeDefined());

    rerender(<App splashDurationMs={0} chatStore={newStore} profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }} chatApi={{ respond: async ({ clientMessageId }) => reply(clientMessageId, "こんばんは") }} now={() => now} nextId={() => "new"} />);
    rejectOldSave?.(new Error("stale save"));

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    expect(screen.queryByText("この端末には履歴を保存できません")).not.toBeInTheDocument();
  });

});

it("replaces send with stop during generation and allows the next question without a late reply", async () => {
  let finish!: (value: ReturnType<typeof reply>) => void;
  let cancelledSignal: AbortSignal | undefined;
  let firstId = "";
  const respond = vi.fn().mockImplementationOnce((input, signal) => {
    firstId = input.clientMessageId;
    cancelledSignal = signal;
    return new Promise(resolve => { finish = resolve; });
  }).mockImplementation(async input => reply(input.clientMessageId, "次の返事なのだ"));
  const user = userEvent.setup();
  chatApp({store: {load: async () => ({...EMPTY_LOCAL_CHAT, lastOpeningAt: now}), save: async () => {}}, chatApi: {respond}});
  const input = await screen.findByRole("textbox", {name: "メッセージ"});
  await user.type(input, "長く説明して");
  await user.click(screen.getByRole("button", {name: "メッセージを送信"}));
  const stop = await screen.findByRole("button", {name: "生成を停止"});
  expect(stop).toHaveAttribute("type", "button");
  await user.click(stop);
  expect(cancelledSignal?.aborted).toBe(true);
  expect(screen.queryByRole("button", {name: "生成を停止"})).not.toBeInTheDocument();
  await user.type(input, "次の質問");
  await user.click(screen.getByRole("button", {name: "メッセージを送信"}));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  await act(async () => { finish(reply(firstId, "キャンセル後の返事")); });
  expect(screen.queryByText("キャンセル後の返事")).not.toBeInTheDocument();
});
