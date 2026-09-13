import { within, act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { EMPTY_LOCAL_CHAT } from "../src/local-state";
import { createBrowserNotificationPreferenceStore, createLocalFixtureProactiveApi, createMemoryNotificationPreferenceStore, type ProactiveExperienceApi } from "../src/proactive-message";

const now = "2026-08-29T17:30:00.000Z";
const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: now };
const candidate = {
  id: "opening-20260829",
  source: "time" as const,
  sourceRef: "time:2026-08-29",
  templateId: "app_open_greeting_v1" as const,
  purpose: "greeting" as const,
  text: "おかえりなさい。今日もここにいますよ",
  dedupeKey: "opening:2026-08-29",
  contextRef: "talk:latest",
  createdAt: "2026-08-29T17:00:00.000Z",
  expiresAt: "2026-08-29T18:00:00.000Z",
  timeZone: "Asia/Tokyo",
  explicitlyRequested: false,
};

function api(): ProactiveExperienceApi & { open: ReturnType<typeof vi.fn>; act: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(async () => ({ status: "candidate" as const, candidate, actions: ["dismiss", "later", "unneeded", "cancel"] as const })),
    act: vi.fn(async ({ candidateId, action }) => ({ status: "updated" as const, candidateId, state: action === "later" ? "deferred" as const : action === "cancel" ? "cancelled" as const : action === "unneeded" ? "unneeded" as const : "dismissed" as const })),
  };
}

function renderExperience(options: { enabled?: boolean; notifications?: boolean; proactiveApi?: ProactiveExperienceApi; osPermission?: () => "granted" | "denied" | "default" | "unsupported"; strict?: boolean } = {}) {
  const proactiveApi = options.proactiveApi ?? api();
  const preferenceStore = createMemoryNotificationPreferenceStore(options.notifications ?? true);
  const app = <App
    splashDurationMs={0}
    chatStore={{ load: async () => ({ ...EMPTY_LOCAL_CHAT, lastOpeningAt: now }), save: async () => undefined }}
    profileApi={{ get: async () => profile, save: async (input) => ({ ...input, updatedAt: now }) }}
    chatApi={{ respond: async ({ clientMessageId }) => ({ replyGroupId: `${clientMessageId}:assistant`, bubbles: [] }) }}
    now={() => now}
    proactiveMessagingEnabled={options.enabled ?? true}
    proactiveApi={proactiveApi}
    notificationPreferenceStore={preferenceStore}
    osNotificationPermission={options.osPermission}
    integratedUiEnabled
  />;
  render(options.strict ? <StrictMode>{app}</StrictMode> : app);
  return { proactiveApi, preferenceStore };
}

describe("app-open proactive Talk experience", () => {
  it("adds one quiet Talk bubble only after app open, with no modal or automatic audio", async () => {
    const speak = vi.fn();
    Object.defineProperty(globalThis, "speechSynthesis", { configurable: true, value: { speak } });
    const { proactiveApi } = renderExperience();
    expect(await within(await screen.findByRole("list", { name: "ずんだもんとの会話" })).findByText(candidate.text)).toBeVisible();
    expect(proactiveApi.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "閉じる" })).toBeVisible();
    expect(screen.getByRole("button", { name: "あとで" })).toBeVisible();
    expect(screen.getByRole("button", { name: "不要" })).toBeVisible();
    delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
  });

  it("opens the trigger once across React strict-effect replay", async () => {
    const proactiveApi = api();
    renderExperience({ proactiveApi, strict: true });
    expect(await within(await screen.findByRole("list", { name: "ずんだもんとの会話" })).findByText(candidate.text)).toBeVisible();
    expect(proactiveApi.open).toHaveBeenCalledTimes(1);
  });

  it("applies an action once and shows its honest state", async () => {
    const user = userEvent.setup();
    const proactiveApi = api();
    renderExperience({ proactiveApi });
    await user.click(await screen.findByRole("button", { name: "あとで" }));
    expect(proactiveApi.act).toHaveBeenCalledWith({ candidateId: candidate.id, action: "later" });
    expect(await screen.findByText("次に開いた時まで控えます")).toBeVisible();
  });

  it("starts a proactive action only once before React can render the processing state", async () => {
    let resolveAction: ((result: { status: "updated"; candidateId: string; state: "dismissed" }) => void) | undefined;
    const proactiveApi = api();
    proactiveApi.act.mockImplementationOnce(() => new Promise((resolve) => { resolveAction = resolve; }));
    renderExperience({ proactiveApi });

    const dismiss = await screen.findByRole("button", { name: "閉じる" });
    act(() => {
      dismiss.click();
      dismiss.click();
    });

    expect(proactiveApi.act).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAction?.({ status: "updated", candidateId: candidate.id, state: "dismissed" });
    });
    expect(await screen.findByText("閉じました")).toBeVisible();
  });

  it("fails closed when an action result belongs to another candidate generation", async () => {
    const user = userEvent.setup();
    const proactiveApi = api();
    proactiveApi.act.mockResolvedValueOnce({ status: "updated", candidateId: "opening-stale", state: "dismissed" });
    renderExperience({ proactiveApi });

    await user.click(await screen.findByRole("button", { name: "閉じる" }));

    expect(await screen.findByRole("status")).toHaveTextContent("操作を反映できませんでした");
    expect(screen.getByRole("status")).not.toHaveTextContent("opening-stale");
    expect(screen.getByRole("button", { name: "閉じる" })).toBeEnabled();
  });

  it("shows a fixed failure without exposing adapter text", async () => {
    const user = userEvent.setup();
    const proactiveApi = api();
    proactiveApi.act.mockRejectedValueOnce(new Error(candidate.text));
    renderExperience({ proactiveApi });
    await user.click(await screen.findByRole("button", { name: "不要" }));
    expect(await screen.findByRole("status")).toHaveTextContent("操作を反映できませんでした");
    expect(screen.getByRole("status")).not.toHaveTextContent(candidate.text);
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    expect(proactiveApi.act).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("閉じました")).toBeVisible();
  });

  it("keeps the feature and adapter untouched when the flag is off", async () => {
    const proactiveApi = api();
    renderExperience({ enabled: false, proactiveApi });
    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(proactiveApi.open).not.toHaveBeenCalled();
    expect(screen.queryByText(candidate.text)).not.toBeInTheDocument();
  });

  it("shows only the notification master switch and observed OS permission without requesting it", async () => {
    const user = userEvent.setup();
    const requestPermission = vi.fn();
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "denied", requestPermission } });
    const { preferenceStore } = renderExperience({ osPermission: () => "denied" });
    await user.click(await screen.findByRole("button", { name: "メニューを開く" }));
    await user.click(screen.getByRole("button", { name: "アプリ設定" }));
    expect(screen.getByText("OS通知: 許可されていません")).toBeVisible();
    const toggle = screen.getByRole("checkbox", { name: "ずんだもんの通知" });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(async () => expect(await preferenceStore.load()).toBe(false));
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.queryByText(/静かな時間|集中モード|Time Sensitive/u)).not.toBeInTheDocument();
    delete (globalThis as { Notification?: unknown }).Notification;
  });
});

describe("local proactive fixture persistence", () => {
  function storage() {
    const values = new Map<string, string>();
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  }

  it("keeps the notification master setting across app instances", async () => {
    const shared = storage();
    await createBrowserNotificationPreferenceStore(shared).save(true);
    await expect(createBrowserNotificationPreferenceStore(shared).load()).resolves.toBe(true);
  });

  it("redelivers later on the next app instance and then keeps dismissal deduped without storing body text", async () => {
    const shared = storage();
    const first = createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo");
    const opened = await first.open({ openedAt: now, notificationsEnabled: true });
    expect(opened.status).toBe("candidate");
    if (opened.status !== "candidate") throw new Error("candidate required");
    await first.act({ candidateId: opened.candidate.id, action: "later" });
    const reopened = await createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo").open({ openedAt: now, notificationsEnabled: true });
    expect(reopened.status).toBe("candidate");
    await createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo").act({ candidateId: opened.candidate.id, action: "dismiss" });
    await expect(createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo").open({ openedAt: now, notificationsEnabled: true })).resolves.toEqual({ status: "none", reason: "duplicate" });
    expect([...sharedValues(shared)].join("\n")).not.toContain(candidate.text);
  });

  it("rejects an unknown action without changing the stored delivery", async () => {
    const shared = storage();
    const fixture = createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo");
    const opened = await fixture.open({ openedAt: now, notificationsEnabled: true });
    expect(opened.status).toBe("candidate");
    if (opened.status !== "candidate") throw new Error("candidate required");
    const before = shared.getItem("zundamon-ai-proactive-delivery-v1");

    const result = await (fixture.act as (input: { candidateId: string; action: string }) => Promise<unknown>)({
      candidateId: opened.candidate.id,
      action: "archive",
    });

    expect(result).toEqual({ status: "failure", code: "not_found" });
    expect(shared.getItem("zundamon-ai-proactive-delivery-v1")).toBe(before);
  });

  it("rejects a stale different action without rewriting a settled delivery", async () => {
    const shared = storage();
    const fixture = createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo");
    const opened = await fixture.open({ openedAt: now, notificationsEnabled: true });
    expect(opened.status).toBe("candidate");
    if (opened.status !== "candidate") throw new Error("candidate required");
    await fixture.act({ candidateId: opened.candidate.id, action: "dismiss" });
    const before = shared.getItem("zundamon-ai-proactive-delivery-v1");

    await expect(fixture.act({ candidateId: opened.candidate.id, action: "later" }))
      .resolves.toEqual({ status: "failure", code: "not_found" });
    expect(shared.getItem("zundamon-ai-proactive-delivery-v1")).toBe(before);
  });

  it("fails closed without replacing an unknown stored delivery state", async () => {
    const shared = storage();
    shared.setItem("zundamon-ai-proactive-delivery-v1", JSON.stringify({
      candidateId: "opening-20260830",
      dedupeKey: "opening:2026-08-30",
      status: "unknown",
      updatedAt: now,
    }));
    const before = shared.getItem("zundamon-ai-proactive-delivery-v1");

    const result = await createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo").open({
      openedAt: now,
      notificationsEnabled: true,
    });

    expect(result).toEqual({ status: "failure", code: "invalid_request" });
    expect(shared.getItem("zundamon-ai-proactive-delivery-v1")).toBe(before);
  });

  it("fails closed without propagating or exposing unknown persisted fields", async () => {
    const shared = storage();
    const privateSentinel = "private-reminder-body";
    shared.setItem("zundamon-ai-proactive-delivery-v1", JSON.stringify({
      candidateId: "opening-20260830",
      dedupeKey: "opening:2026-08-30",
      status: "delivered",
      updatedAt: now,
      text: privateSentinel,
    }));
    const before = shared.getItem("zundamon-ai-proactive-delivery-v1");

    const result = await createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo")
      .act({ candidateId: "opening-20260830", action: "dismiss" });

    expect(result).toEqual({ status: "failure", code: "not_found" });
    expect(JSON.stringify(result)).not.toContain(privateSentinel);
    expect(shared.getItem("zundamon-ai-proactive-delivery-v1")).toBe(before);
  });

  it("fails closed without replacing an empty stored delivery state", async () => {
    const shared = storage();
    shared.setItem("zundamon-ai-proactive-delivery-v1", "");

    const result = await createLocalFixtureProactiveApi(shared, () => "Asia/Tokyo").open({
      openedAt: now,
      notificationsEnabled: true,
    });

    expect(result).toEqual({ status: "failure", code: "invalid_request" });
    expect(shared.getItem("zundamon-ai-proactive-delivery-v1")).toBe("");
  });
});

function sharedValues(storage: { getItem(key: string): string | null }): string[] {
  return [storage.getItem("zundamon-ai-proactive-delivery-v1") ?? ""];
}
