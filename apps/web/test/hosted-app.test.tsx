import { act, render, within, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostedApp } from "../src/App";
import type { AuthClient, AuthSession } from "../src/auth";
import { createMemoryLocalStateStore } from "../src/local-state";

const now = "2026-08-10T06:30:00.000Z";
const profile = { displayName: "大輝", addressingStyle: "san", updatedAt: now };
const emptyRemote = { timeline: [], lastOpeningAt: null, lastConversationAt: null, version: 2, revision: 0, updatedAt: now };

function controllableAuth() {
  let session: AuthSession | null = null;
  const listeners = new Set<(next: AuthSession | null) => void>();
  const emit = (next: AuthSession | null) => {
    session = next;
    for (const listener of listeners) listener(next);
  };
  const client: AuthClient = {
    getSession: async () => session,
    signInWithPassword: async (email) => {
      const next = { accessToken: "token-1", userId: "user-1", email };
      emit(next);
      return next;
    },
    requestOtp: async () => undefined,
    verifyOtp: async (email) => {
      const next = { accessToken: "token-1", userId: "user-1", email };
      emit(next);
      return next;
    },
    updatePassword: async () => undefined,
    signOut: async () => emit(null),
    onSessionChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { client, emit };
}

function apiFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("Authorization");
    if (authorization !== "Bearer token-1") return new Response(null, { status: 401 });
    if (url.endsWith("/api/profile")) return Response.json({ profile });
    if (url.endsWith("/api/chat-state") && (!init?.method || init.method === "GET")) return Response.json({ snapshot: emptyRemote });
    if (url.endsWith("/api/chat-state") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return Response.json({ snapshot: { ...body.snapshot, revision: body.expectedRevision + 1, updatedAt: now } });
    }
    return new Response(null, { status: 500 });
  });
}

describe("hosted YUI app", () => {
  it("keeps hosted navigation in Talk and opens synced region settings from its menu", async () => {
    const auth=controllableAuth();auth.emit({accessToken:'token-1',userId:'user-1',email:'owner@example.com'});
    const base=apiFetch();
    const fetchImpl=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>String(input).endsWith('/api/memory-settings')?Response.json({settings:{memoryEnabled:true,updatedAt:null}}):String(input).endsWith('/api/life-settings')?Response.json({revision:0,home:null,calendar:null,tasks:null}):base(input,init));
    const user=userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} integratedUiEnabled splashDurationMs={0}/>);
    await screen.findByRole('textbox',{name:'メッセージ'});
    expect(screen.queryByRole('button',{name:'ホームへ移動'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'ニュースへ移動'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'メニューを開く'}));
    expect(screen.queryByRole('button',{name:'ホームを編集'})).not.toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'プロフィール',exact:true}));
    await user.click(await screen.findByRole('button',{name:/地域/u}));
    await screen.findByRole('textbox',{name:'地域名'});
    expect(fetchImpl.mock.calls.some(([input])=>String(input).includes('dashboard-progress'))).toBe(false);
    await user.click(screen.getByRole('button',{name:'閉じてホームへ戻る'}));
    await screen.findByRole('textbox',{name:'メッセージ'});
  });
  it("keeps one launch layer through hosted initialization and releases the login", async () => {
    vi.useFakeTimers();
    try {
      const auth = controllableAuth();
      render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" cacheStore={createMemoryLocalStateStore()} splashDurationMs={1} />);

      expect(screen.getByTestId("launch-screen")).toBeVisible();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(screen.getByTestId("launch-screen")).toHaveClass("is-ready");
      expect(screen.getByRole("region", { name: "ずんだもんのログイン" })).toBeVisible();
      await act(() => vi.advanceTimersByTimeAsync(240));
      expect(screen.queryByTestId("launch-screen")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps primary navigation absent after authenticated hydration when the integrated flag is false", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const fetchImpl = apiFetch();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} integratedUiEnabled={false} />);

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "ずんだもんの主な画面" })).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/api/web_search"))).toBe(false);
  });

  it("threads the hosted Prism Echo opt-in into the real Talk lifecycle", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const remote = { ...emptyRemote, lastOpeningAt: now, lastConversationAt: now };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (new Headers(init?.headers).get("Authorization") !== "Bearer token-1") return new Response(null, { status: 401 });
      if (url.endsWith("/api/profile")) return Response.json({ profile });
      if (url.endsWith("/api/chat-state") && (!init?.method || init.method === "GET")) return Response.json({ snapshot: remote });
      if (url.endsWith("/api/chat-state") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Response.json({ snapshot: { ...body.snapshot, revision: body.expectedRevision + 1, updatedAt: now } });
      }
      if (url.endsWith("/api/chat/responses")) return new Promise<Response>(() => undefined);
      return new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    render(<HostedApp
      authClient={auth.client}
      apiBaseUrl="https://api.yui.example"
      fetchImpl={fetchImpl}
      cacheStore={createMemoryLocalStateStore()}
      splashDurationMs={0}
      integratedUiEnabled={false}
      prismEchoEnabled
      nextId={() => "message-prism"}
      now={() => now}
    />);

    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "fixture message");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));

    expect((await screen.findByRole("status", { name: "ずんだもんが返事をつくっています" })).querySelectorAll(".typing-dot")).toHaveLength(3);
  });

  it("keeps duplicated Google controls out of hosted App Settings without a Google request", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const fetchImpl = apiFetch();
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} />);

    await user.click(await screen.findByRole("button", { name: "設定を開く" }));
    expect(screen.queryByRole("heading", { name: "Google連携" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Google (Calendar|Tasks)/u })).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/api/google/"))).toBe(false);
  });

  it("keeps the character UI fixed even with retired style preferences", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const fetchImpl = apiFetch();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} />);
    await screen.findByRole("textbox", { name: "メッセージ" });
    window.dispatchEvent(new StorageEvent("storage", { key: "zundamon-ai.visual-style.preference.v1", newValue: JSON.stringify({ style: "minimal", revision: 99 }) }));
    expect(document.documentElement.dataset.yuiStyle).toBe("yui");
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("visual-style-preference"))).toBe(false);
    expect(screen.queryByRole("button", { name: "表示スタイル" })).not.toBeInTheDocument();
  });

  it("does not fetch or show the retired dashboard in hosted Talk", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (new Headers(init?.headers).get("Authorization") !== "Bearer token-1") return new Response(null, { status: 401 });
      if (url.endsWith("/api/profile")) return Response.json({ profile });
      if (url.endsWith("/api/chat-state")) return Response.json({ snapshot: emptyRemote });
      if (url.endsWith("/api/dashboard/progress")) return Response.json({
        connection: "available",
        updates: [{ project: "yui", requestId: "YUI-DASHBOARD-PROJECTION-20260823-001", shortTitle: "進捗の安全な参照を追加する", status: "working", currentPhase: "autonomous_execution", needsOwnerAction: false, updatedAt: "2026-08-23T00:00:00.000Z", nextSafeAction: "作業を継続する" }],
      });
      return new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} integratedUiEnabled />);

    await screen.findByRole("textbox", { name: "メッセージ" });
    expect(screen.queryByRole("heading", { name: "開発の進捗" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ホームへ移動" })).not.toBeInTheDocument();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).endsWith("/api/dashboard/progress"))).toBe(false);
  });

  it("does not enqueue an admitted web search query for automatic memory", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    let memoryRequests = 0;
    const remote = { ...emptyRemote, lastOpeningAt: now, lastConversationAt: now };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (new Headers(init?.headers).get("Authorization") !== "Bearer token-1") return new Response(null, { status: 401 });
      if (url.endsWith("/api/profile")) return Response.json({ profile });
      if (url.endsWith("/api/chat-state") && (!init?.method || init.method === "GET")) return Response.json({ snapshot: remote });
      if (url.endsWith("/api/chat-state") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Response.json({ snapshot: { ...body.snapshot, revision: body.expectedRevision + 1, updatedAt: now } });
      }
      if (url.endsWith("/api/chat/responses")) return Response.json({ reply: {
        replyGroupId: "message-search:assistant",
        bubbles: [{ id: "message-search:assistant:0", text: "公式情報を確認したよ", createdAt: now, sequence: 0 }],
        search: {
          status: "completed",
          searchedAt: now,
          sources: [{ title: "OpenAI", url: "https://openai.com/" }],
          evidence: { facts: [{ text: "Web検索ツールがある", sourceUrl: "https://openai.com/" }], inference: null, suggestion: null },
        },
      } });
      if (url.endsWith("/api/memory/process")) {
        memoryRequests += 1;
        return Response.json({ sourceMessageId: "message-search", state: "completed", appliedCount: 0 }, { status: 202 });
      }
      return new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} nextId={() => "message-search"} now={() => now} />);

    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "OpenAIのWeb検索について公式情報を検索して");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));

    expect(await within(screen.getByLabelText("ずんだもんの今のセリフ")).findByText("公式情報を確認したよ")).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(memoryRequests).toBe(0);
  });

  it("does not enqueue an external-context reply for automatic memory", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    let memoryRequests = 0;
    const remote = { ...emptyRemote, lastOpeningAt: now, lastConversationAt: now };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (new Headers(init?.headers).get("Authorization") !== "Bearer token-1") return new Response(null, { status: 401 });
      if (url.endsWith("/api/profile")) return Response.json({ profile });
      if (url.endsWith("/api/chat-state") && (!init?.method || init.method === "GET")) return Response.json({ snapshot: remote });
      if (url.endsWith("/api/chat-state") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Response.json({ snapshot: { ...body.snapshot, revision: body.expectedRevision + 1, updatedAt: now } });
      }
      if (url.endsWith("/api/chat/responses")) return Response.json({ reply: {
        replyGroupId: "message-calendar:assistant",
        bubbles: [{ id: "message-calendar:assistant:0", text: "10時は予定ありだよ", createdAt: now, sequence: 0, flow: "external_context" }],
      } });
      if (url.endsWith("/api/memory/process")) {
        memoryRequests += 1;
        return Response.json({ sourceMessageId: "message-calendar", state: "completed", appliedCount: 0 }, { status: 202 });
      }
      return new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} nextId={() => "message-calendar"} now={() => now} />);

    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "今日の予定を教えて");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));

    expect(await within(screen.getByLabelText("ずんだもんの今のセリフ")).findByText("10時は予定ありだよ")).toBeVisible();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(memoryRequests).toBe(0);
  });

  it("skips failed chats and enqueues the same source after a rendered retry succeeds", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const process = vi.fn(async () => Response.json({ sourceMessageId: "message-1", state: "completed", appliedCount: 1 }, { status: 202 }));
    let replies = 0;
    const remote = { ...emptyRemote, lastOpeningAt: now, lastConversationAt: now };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (new Headers(init?.headers).get("Authorization") !== "Bearer token-1") return new Response(null, { status: 401 });
      if (url.endsWith("/api/profile")) return Response.json({ profile });
      if (url.endsWith("/api/chat-state") && (!init?.method || init.method === "GET")) return Response.json({ snapshot: remote });
      if (url.endsWith("/api/chat-state") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Response.json({ snapshot: { ...body.snapshot, revision: body.expectedRevision + 1, updatedAt: now } });
      }
      if (url.endsWith("/api/chat/responses")) {
        replies += 1;
        if (replies === 1) return Response.json({ error: "upstream_unavailable" }, { status: 502 });
        return Response.json({ reply: {
          replyGroupId: "message-1:assistant",
          bubbles: [{ id: "message-1:assistant:0", text: "今度は届いたよ", createdAt: now, sequence: 0 }],
        } });
      }
      if (url.endsWith("/api/memory/process")) return process();
      return new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} nextId={() => "message-1"} now={() => now} />);

    await user.type(await screen.findByRole("textbox", { name: "メッセージ" }), "朝は紅茶が好き");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));
    const retry = await screen.findByRole("button", { name: "もう一度送る" });
    expect(process).not.toHaveBeenCalled();
    await user.click(retry);
    expect(await within(screen.getByRole("list", { name: "ずんだもんとの会話" })).findByText("今度は届いたよ")).toBeVisible();
    await waitFor(() => expect(process).toHaveBeenCalledOnce());
  });

  it("renders the reply and keeps the composer usable while automatic memory never resolves", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const calls: string[] = [];
    let memoryBody: unknown;
    const memoryStarted = vi.fn();
    let memorySignal: AbortSignal | null = null;
    const remote = { ...emptyRemote, lastOpeningAt: now, lastConversationAt: now };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== "Bearer token-1") return new Response(null, { status: 401 });
      if (url.endsWith("/api/profile")) return Response.json({ profile });
      if (url.endsWith("/api/chat-state") && (!init?.method || init.method === "GET")) return Response.json({ snapshot: remote });
      if (url.endsWith("/api/chat-state") && init?.method === "PUT") {
        calls.push("snapshot");
        const body = JSON.parse(String(init.body));
        return Response.json({ snapshot: { ...body.snapshot, revision: body.expectedRevision + 1, updatedAt: now } });
      }
      if (url.endsWith("/api/chat/responses")) {
        calls.push("reply");
        return Response.json({ reply: {
          replyGroupId: "message-1:assistant",
          bubbles: [{ id: "message-1:assistant:0", text: "紅茶の時間、いいね", createdAt: now, sequence: 0 }],
        } });
      }
      if (url.endsWith("/api/memory/process")) {
        calls.push("memory");
        memoryBody = JSON.parse(String(init?.body));
        memoryStarted();
        memorySignal = init?.signal ?? null;
        return new Promise<Response>(() => undefined);
      }
      return new Response(null, { status: 500 });
    });
    const user = userEvent.setup();
    render(<HostedApp
      authClient={auth.client}
      apiBaseUrl="https://api.yui.example"
      fetchImpl={fetchImpl}
      cacheStore={createMemoryLocalStateStore()}
      splashDurationMs={0}
      nextId={() => "message-1"}
      now={() => now}
    />);

    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    await user.type(composer, "朝は紅茶が好き");
    await user.click(screen.getByRole("button", { name: "メッセージを送信" }));

    expect(await within(screen.getByRole("list", { name: "ずんだもんとの会話" })).findByText("紅茶の時間、いいね")).toBeVisible();
    await waitFor(() => expect(memoryStarted).toHaveBeenCalledOnce());
    expect(calls.at(-1)).toBe("memory");
    expect(memoryBody).toEqual({ sourceMessageId: "message-1", sourceOccurredAt: now });
    expect(JSON.stringify(memoryBody)).not.toContain("朝は紅茶が好き");
    expect(calls.filter((entry) => entry === "snapshot")).toHaveLength(2);
    await user.type(screen.getByRole("textbox", { name: "メッセージ" }), "次の話もできる");
    expect(screen.getByDisplayValue("次の話もできる")).toBeEnabled();
    expect(screen.queryByText(/覚えた|保存しました/u)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "設定を開く" }));
    await user.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(memorySignal?.aborted).toBe(true);
  });

  it("does not hydrate private APIs until email link login succeeds", async () => {
    const auth = controllableAuth();
    const fetchImpl = apiFetch();
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} />);

    expect(await screen.findByLabelText("メールアドレス")).toBeVisible();
    expect(screen.getByLabelText("メールアドレス")).toBeVisible();
    expect(fetchImpl).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "ログインリンクを使う" }));
    await user.type(screen.getByLabelText("メールアドレス"), "owner@example.com");
    await user.click(screen.getByRole("button", { name: "ログインリンクを受け取る" }));
    expect(await screen.findByText("ログインリンクを送信しました。メール内のリンクを開いてください。")).toBeVisible();
    expect(fetchImpl).not.toHaveBeenCalled();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });

    expect(await screen.findByRole("button", { name: "設定を開く" })).toBeVisible();
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("preserves only the local draft when the session expires and hydrates again after login", async () => {
    const auth = controllableAuth();
    const cacheStore = createMemoryLocalStateStore();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={apiFetch()} cacheStore={cacheStore} splashDurationMs={0} />);

    const composer = await screen.findByRole("textbox", { name: "メッセージ" });
    await user.type(composer, "まだ送らない文章");
    await waitFor(async () => expect((await cacheStore.load()).draft).toBe("まだ送らない文章"));

    auth.emit(null);
    expect(await screen.findByLabelText("メールアドレス")).toBeVisible();

    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    expect(await screen.findByDisplayValue("まだ送らない文章")).toBeVisible();
  });

  it("logs out from settings instead of adding an action to the chat timeline", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={apiFetch()} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} />);

    await user.click(await screen.findByRole("button", { name: "設定を開く" }));

    expect(screen.getByRole("main", { name: "設定" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "ずんだもん" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ログアウト" }));

    expect(await screen.findByLabelText("メールアドレス")).toBeVisible();
    expect(screen.queryByRole("button", { name: "ログアウト" })).not.toBeInTheDocument();
  });

  it("keeps settings retryable when an explicit logout request fails", async () => {
    const auth = controllableAuth();
    auth.emit({ accessToken: "token-1", userId: "user-1", email: "owner@example.com" });
    auth.client.signOut = async () => { throw new Error("offline"); };
    const user = userEvent.setup();
    render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={apiFetch()} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} />);

    await user.click(await screen.findByRole("button", { name: "設定を開く" }));
    await user.click(screen.getByRole("button", { name: "ログアウト" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ログアウトできませんでした");
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeEnabled();
    expect(screen.queryByLabelText("メールアドレス")).not.toBeInTheDocument();
  });
});

it.each(['コーデックスくんにサンプルアプリの進捗聞いて', 'CodexにREADMEを調べて', 'ずんだもんAIの進捗をコーデックスでしらべて', 'ずんだもんAIの進捗確認して　コーデックス'])('routes an authenticated Codex request to Codex and persists its reply: %s', async text => {
  const auth = controllableAuth(); auth.emit({accessToken:'token-1',userId:'user-1',email:'owner@example.com'});
  const base = apiFetch();
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/codex/status')) return Response.json({enabled:true,project:'ずんだもんAI',mode:'research'});
    if (url.endsWith('/api/codex/jobs/latest')) return Response.json({job:null});
    if (/\/api\/codex\/jobs\/[^/]+$/.test(url)) return Response.json({job:{id:'job-1',requestId:decodeURIComponent(url.split('/').at(-1)!),prompt:'進捗確認',status:'completed',message:'完了',result:'接続テストの調査結果です。',createdAt:now,updatedAt:now}});
    if (url.endsWith('/api/codex/jobs') && init?.method === 'POST') {
      const request = JSON.parse(String(init.body));
      return Response.json({job:{id:'job-1',requestId:request.requestId,prompt:request.prompt,status:'completed',message:'完了',result:'接続テストの調査結果です。',createdAt:now,updatedAt:now}});
    }
    return base(input, init);
  });
  const user = userEvent.setup();
  render(<HostedApp authClient={auth.client} apiBaseUrl="https://api.yui.example" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} integratedUiEnabled splashDurationMs={0} now={() => now}/>);
  const composer = await screen.findByRole('textbox',{name:'メッセージ'});
  await user.type(composer,text);
  await user.click(screen.getByRole('button',{name:'メッセージを送信'}));
  await waitFor(() => expect(fetchImpl.mock.calls.some(([input,init]) => String(input).endsWith('/api/codex/jobs') && init?.method === 'POST')).toBe(true));
  await waitFor(() => expect(fetchImpl.mock.calls.some(([input,init]) => String(input).endsWith('/api/chat-state') && init?.method === 'PUT' && String(init.body).includes('接続テストの調査結果です'))).toBe(true));
  const request = fetchImpl.mock.calls.find(([input,init]) => String(input).endsWith('/api/codex/jobs') && init?.method === 'POST')!;
  expect(new Headers(request[1]?.headers).get('Authorization')).toBe('Bearer token-1');
  if(text==='コーデックスくんにサンプルアプリの進捗聞いて') {
    const before=fetchImpl.mock.calls.length;
    await user.type(composer,'今は待ち？');
    await user.click(screen.getByRole('button',{name:'メッセージを送信'}));
    const requestId=JSON.parse(String(request[1]?.body)).requestId;
    await waitFor(()=>expect(fetchImpl.mock.calls.slice(before).some(([url])=>String(url).endsWith('/api/codex/jobs/'+requestId))).toBe(true));
    await waitFor(()=>expect(fetchImpl.mock.calls.slice(before).some(([url,init])=>String(url).endsWith('/api/chat-state') && init?.method==='PUT' && String(init.body).includes('Codexの作業は完了'))).toBe(true));
    expect(fetchImpl.mock.calls.slice(before).some(([url,init])=>(String(url).endsWith('/api/codex/jobs') || String(url).endsWith('/api/chat/responses')) && init?.method==='POST')).toBe(false);
  }

});
