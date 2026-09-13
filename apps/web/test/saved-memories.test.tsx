import { readFile } from "node:fs/promises";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "@yui/domain";
import type { MemoryApi, MemorySettings, MemoryTombstoneSummary } from "../src/api";
import { SavedMemories } from "../src/screens/SavedMemories";

const now = "2026-08-11T03:00:00.000Z";
const baseMemory: Memory = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "preference",
  scope: "shared",
  content: "ブラックコーヒーが好き",
  normalizedContent: "ブラックコーヒーが好き",
  status: "active",
  origin: "extracted",
  sensitivity: "normal",
  importance: 3,
  sourceMessageId: "message-source-1",
  sourceOccurredAt: "2026-08-10T03:00:00.000Z",
  validFrom: null,
  validUntil: null,
  expiresAt: "2026-09-01T00:00:00.000Z",
  pinned: false,
  supersedesId: null,
  createdAt: "2026-08-10T03:00:00.000Z",
  updatedAt: "2026-08-10T03:00:00.000Z",
};

const memories: Memory[] = [
  baseMemory,
  { ...baseMemory, id: "00000000-0000-4000-8000-000000000002", content: "偏頭痛で通院している", normalizedContent: "偏頭痛で通院している", sensitivity: "sensitive", origin: "explicit", sourceMessageId: null, createdAt: "2026-07-01T03:00:00.000Z", updatedAt: "2026-07-01T03:00:00.000Z", pinned: true, expiresAt: null },
  { ...baseMemory, id: "00000000-0000-4000-8000-000000000003", content: "前の勤務先", normalizedContent: "前の勤務先", status: "past", origin: "manual", sourceMessageId: null },
  { ...baseMemory, id: "00000000-0000-4000-8000-000000000004", content: "来週の予定かもしれない", normalizedContent: "来週の予定かもしれない", status: "uncertain", kind: "schedule", scope: "work", sourceMessageId: null },
];

const defaultSettings: MemorySettings = { memoryEnabled: true, updatedAt: now };

function memoryApi(overrides: Partial<MemoryApi> = {}): MemoryApi {
  return {
    process: async ({ sourceMessageId }) => ({ sourceMessageId, state: "completed", appliedCount: 0 }),
    list: async () => memories,
    update: async (_id, patch) => ({ ...baseMemory, ...patch, updatedAt: now }),
    keep: async () => ({ ...baseMemory, reviewState: "eligible", ownerReviewedAt: now }),
    forget: async () => undefined,
    listTombstones: async () => [],
    releaseTombstone: async () => undefined,
    getSettings: async () => defaultSettings,
    updateSettings: async (settings) => ({ ...settings, updatedAt: now }),
    ...overrides,
  };
}

describe("saved memories", () => {
  it("shows one YUI memory switch rather than detailed controls", async () => {
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [] })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    expect(await screen.findByRole("switch", { name: "ずんだもんの記憶" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "会話から自動で覚える" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "電話から自動で覚える" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "会話で記憶を使う" })).not.toBeInTheDocument();
  });

  it("groups statuses, hides sensitive content, and shows source metadata naturally", async () => {
    const api = memoryApi({
      listTombstones: async () => [{ id: "00000000-0000-4000-8000-000000000010", memoryId: baseMemory.id, createdAt: now }],
    });
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={api} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    expect(await screen.findByRole("heading", { name: "最近覚えた" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "今も覚えている" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "過去・期限切れ" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "まだ確かではない" })).toBeVisible();
    expect(screen.getAllByText("会話から自動で記憶")[0]).toBeVisible();
    expect(screen.getAllByText("2026年8月10日")[0]).toBeVisible();
    expect(screen.getAllByText("共有")[0]).toBeVisible();
    expect(screen.queryByText("偏頭痛で通院している")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /偏頭痛で通院している/u })).not.toBeInTheDocument();
    expect(screen.getByText("敏感な内容は非表示です")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "敏感な内容を表示" }));
    expect(screen.getByText("偏頭痛で通院している")).toBeVisible();
    expect(screen.getByRole("heading", { name: "再び覚えてよいもの" })).toBeVisible();
  });

  it("edits inline with cancel/save and pins a memory without losing focus on failure", async () => {
    const update = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...baseMemory, content: "最近はカフェラテが好き", normalizedContent: "最近はカフェラテが好き" })
      .mockResolvedValueOnce({ ...baseMemory, pinned: true, expiresAt: null });
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory], update })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    await user.click(await screen.findByRole("button", { name: "ブラックコーヒーが好きの内容を編集" }));
    await user.clear(screen.getByLabelText("記憶の内容"));
    await user.type(screen.getByLabelText("記憶の内容"), "キャンセルする内容");
    await user.click(screen.getByRole("button", { name: "編集をキャンセル" }));
    expect(screen.getByText(baseMemory.content)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "ブラックコーヒーが好きの内容を編集" }));
    await user.clear(screen.getByLabelText("記憶の内容"));
    await user.type(screen.getByLabelText("記憶の内容"), "最近はカフェラテが好き");
    await user.click(screen.getByRole("button", { name: "編集を保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存できませんでした");
    expect(screen.getByRole("button", { name: "編集を保存" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "編集を保存" }));
    expect(await screen.findByText("最近はカフェラテが好き")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "最近はカフェラテが好きを期限なしで残す" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(baseMemory.id, { pinned: true }));
  });

  it("keeps a pending review memory only after an explicit owner action", async () => {
    const keep = vi.fn(async () => ({ ...baseMemory, reviewState: "eligible" as const, ownerReviewedAt: now }));
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [{ ...baseMemory, reviewState: "needs_review" }], keep })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    expect(await screen.findByText("会話ではまだ使いません。内容を確認してから使えます。")).toHaveClass("memory-review-note");
    await user.click(screen.getByRole("button", { name: "この記憶を会話で使う" }));
    await waitFor(() => expect(keep).toHaveBeenCalledWith(baseMemory.id));
    expect(screen.queryByText("会話ではまだ使いません。内容を確認してから使えます。")).not.toBeInTheDocument();
  });

  it("confirms forgetting with relearning choice and restores focus after a partial failure", async () => {
    const forget = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory], forget })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    const forgetButton = await screen.findByRole("button", { name: "ブラックコーヒーが好きを忘れる" });
    await user.click(forgetButton);
    expect(screen.getByRole("dialog", { name: "この記憶を忘れますか" })).toBeVisible();
    expect(screen.getByRole("button", { name: "キャンセル" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "この記憶を忘れますか" })).not.toBeInTheDocument();
    expect(forgetButton).toHaveFocus();
    await user.click(forgetButton);
    await user.tab();
    expect(screen.getByRole("button", { name: "忘れる" })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("同じ内容を会話から再び覚えない")).toHaveFocus();
    await user.click(screen.getByLabelText("同じ内容を会話から再び覚えない"));
    await user.click(screen.getByRole("button", { name: "忘れる" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("忘れられませんでした");
    expect(forgetButton).toHaveFocus();
    expect(screen.getByText(baseMemory.content)).toBeVisible();
    await user.click(forgetButton);
    await user.click(screen.getByLabelText("同じ内容を会話から再び覚えない"));
    await user.click(screen.getByRole("button", { name: "忘れる" }));
    await waitFor(() => expect(screen.queryByText(baseMemory.content)).not.toBeInTheDocument());
    expect(forget).toHaveBeenLastCalledWith(baseMemory.id, false);
  });

  it("opens an existing source and gracefully reports a deleted source", async () => {
    const onOpenSource = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory] })} onClose={vi.fn()} onOpenSource={onOpenSource} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    const source = await screen.findByRole("button", { name: "元の会話を見る" });
    await user.click(source);
    expect(screen.getByRole("status")).toHaveTextContent("元の会話はありません");
    expect(source).toHaveFocus();
    await user.click(source);
    expect(onOpenSource).toHaveBeenLastCalledWith("message-source-1");
  });

  it("restores a missing source to the exact originating button", async () => {
    const second = { ...baseMemory, id: "00000000-0000-4000-8000-000000000099", content: "紅茶が好き", normalizedContent: "紅茶が好き" };
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory, second] })} onClose={vi.fn()} onOpenSource={vi.fn(() => false)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    const sourceButtons = await screen.findAllByRole("button", { name: "元の会話を見る" });
    await user.click(sourceButtons[1]!);

    expect(sourceButtons[1]).toHaveFocus();
  });

  it("moves focus to the logical next memory after a successful forget", async () => {
    const second = { ...baseMemory, id: "00000000-0000-4000-8000-000000000099", content: "紅茶が好き", normalizedContent: "紅茶が好き" };
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory, second] })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    await user.click(await screen.findByRole("button", { name: "ブラックコーヒーが好きを忘れる" }));
    await user.click(screen.getByLabelText("同じ内容を会話から再び覚えない"));
    await user.click(screen.getByRole("button", { name: "忘れる" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "紅茶が好きを忘れる" })).toHaveFocus());
  });

  it("moves focus to Back after successfully forgetting the final memory", async () => {
    let resolveRefresh!: (value: MemoryTombstoneSummary[]) => void;
    const refresh = new Promise<MemoryTombstoneSummary[]>((resolve) => { resolveRefresh = resolve; });
    const listTombstones = vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(refresh);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory], listTombstones })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    await user.click(await screen.findByRole("button", { name: "ブラックコーヒーが好きを忘れる" }));
    await user.click(screen.getByRole("button", { name: "忘れる" }));

    await waitFor(() => expect(listTombstones).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 10));
    resolveRefresh([]);
    await waitFor(() => expect(screen.getByRole("button", { name: "プロフィールへ戻る" })).toHaveFocus());
  });

  it("renders successful resources when settings fail and retries only settings", async () => {
    const getSettings = vi.fn()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValueOnce(defaultSettings);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ getSettings, listTombstones: async () => [{ id: "00000000-0000-4000-8000-000000000010", memoryId: baseMemory.id, createdAt: now }] })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    expect(await screen.findByText(baseMemory.content)).toBeVisible();
    expect(screen.getByRole("heading", { name: "再び覚えてよいもの" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("記憶の設定を読み込めませんでした");
    await user.click(screen.getByRole("button", { name: "記憶の設定を再読み込み" }));
    expect(await screen.findByRole("switch", { name: "ずんだもんの記憶" })).toBeVisible();
  });

  it("renders memories and settings when tombstones fail and retries only tombstones", async () => {
    const listTombstones = vi.fn()
      .mockRejectedValueOnce(new Error("tombstones unavailable"))
      .mockResolvedValueOnce([{ id: "00000000-0000-4000-8000-000000000010", memoryId: baseMemory.id, createdAt: now }]);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ listTombstones })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    expect(await screen.findByText(baseMemory.content)).toBeVisible();
    expect(screen.getByRole("switch", { name: "ずんだもんの記憶" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("再学習防止の状態を読み込めませんでした");
    await user.click(screen.getByRole("button", { name: "再学習防止の状態を再読み込み" }));
    expect(await screen.findByRole("heading", { name: "再び覚えてよいもの" })).toBeVisible();
  });

  it("keeps settings and tombstones available while only memory listing retries", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("memories unavailable")).mockResolvedValueOnce([baseMemory]);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list, listTombstones: async () => [{ id: "00000000-0000-4000-8000-000000000010", memoryId: baseMemory.id, createdAt: now }] })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    expect(await screen.findByRole("switch", { name: "ずんだもんの記憶" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "再び覚えてよいもの" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("覚えたことを読み込めませんでした");
    await user.click(screen.getByRole("button", { name: "覚えたことを再読み込み" }));
    expect(await screen.findByText(baseMemory.content)).toBeVisible();
  });

  it("keeps a successful forget when only the tombstone refresh fails", async () => {
    const listTombstones = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("refresh failed"));
    const forget = vi.fn(async () => undefined);
    const onMemoryChanged = vi.fn();
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory], listTombstones, forget })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={onMemoryChanged} now={() => new Date(now)} />);

    await user.click(await screen.findByRole("button", { name: "ブラックコーヒーが好きを忘れる" }));
    await user.click(screen.getByRole("button", { name: "忘れる" }));

    await waitFor(() => expect(screen.queryByText(baseMemory.content)).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("再学習防止の状態を更新できませんでした");
    expect(screen.getByRole("alert")).not.toHaveTextContent("忘れられませんでした");
    expect(onMemoryChanged).toHaveBeenCalledOnce();
  });

  it("turns YUI memory off without deleting existing memories", async () => {
    let storedSettings = defaultSettings;
    const updateSettings = vi.fn(async (patch) => {
      storedSettings = { ...storedSettings, ...patch, updatedAt: now };
      return storedSettings;
    });
    const forget = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<SavedMemories memoryApi={memoryApi({ list: async () => [baseMemory], updateSettings, forget })} onClose={vi.fn()} onOpenSource={vi.fn(() => true)} onMemoryChanged={vi.fn()} now={() => new Date(now)} />);

    await user.click(await screen.findByRole("switch", { name: "ずんだもんの記憶" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ memoryEnabled: false }));
    expect(forget).not.toHaveBeenCalled();
    expect(screen.getByText(baseMemory.content)).toBeVisible();
  });

  it("keeps interactive controls at least 44px and prevents 320px horizontal overflow", async () => {
    const css = await readFile("src/styles.css", "utf8");
    expect(css).toMatch(/\.memory-[^{]+\{[^}]*min-height:\s*44px/su);
    expect(css).toMatch(/\.saved-memories[^}]*overflow-x:\s*hidden/su);
    expect(css).toMatch(/\.saved-memory-card[^}]*min-width:\s*0/su);
  });

  it("keeps saved-memory action labels readable in Dark mode", async () => {
    const css = await readFile("src/styles.css", "utf8");
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*\.memory-actions button, \.memory-source-action, \.memory-text-action \{ color: var\(--yui-text\); \}/u);
  });
});
