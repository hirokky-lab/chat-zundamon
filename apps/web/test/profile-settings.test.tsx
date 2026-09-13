import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProfileSettings } from "../src/screens/ProfileSettings";

const profile = { displayName: "大輝", addressingStyle: "san" as const, updatedAt: "2026-08-09T03:00:00.000Z" };

describe("profile settings", () => {
  it("is a dedicated settings screen without a duplicate Google management surface", async () => {
    const onOpenMemories = vi.fn();
    const user = userEvent.setup();
    render(<ProfileSettings profile={profile} saving={false} error={null} onSave={vi.fn()} onClose={vi.fn()} onOpenMemories={onOpenMemories} />);

    expect(screen.getByRole("main", { name: "設定" })).toBeVisible();
    expect(screen.queryByText("ライフメイトAI ずんだもん")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "壁紙" }));
    expect(screen.getByRole("heading", { name: "壁紙" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Google連携" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Google Calendar|Google Tasks/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "ずんだもんの呼び方" })).not.toBeInTheDocument();
    expect(screen.queryByText("Mac版から移行")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "設定へ戻る" }));
    await user.click(screen.getByRole("button", { name: "覚えたことを開く" }));
    expect(onOpenMemories).toHaveBeenCalledOnce();
  });

  it("offers integrated Talk history search from settings instead of the fixed header", async () => {
    const onOpenChatSearch = vi.fn();
    const user = userEvent.setup();
    render(<ProfileSettings profile={profile} saving={false} error={null} onSave={vi.fn()} onClose={vi.fn()} onOpenMemories={vi.fn()} onOpenChatSearch={onOpenChatSearch} />);
    await user.click(screen.getByRole("button", { name: "トーク履歴を検索" }));
    expect(onOpenChatSearch).toHaveBeenCalledOnce();
  });

  it("removes the old Default and Simple selection", async () => {
    const user = userEvent.setup();
    render(<ProfileSettings profile={profile} saving={false} error={null} onSave={vi.fn()} onClose={vi.fn()} onOpenMemories={vi.fn()} visualStyle="minimal" onVisualStyleChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "壁紙" }));
    expect(screen.getByRole("heading", { name: "壁紙" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "ずんだもんを表示" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "シンプル" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "デフォルト" })).not.toBeInTheDocument();
  });

  it("edits the name while preserving the current chat-selected addressing style", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<ProfileSettings profile={profile} saving={false} error={null} onSave={onSave} onClose={vi.fn()} onOpenMemories={vi.fn()} />);
    await user.clear(screen.getByLabelText("あなたの名前"));
    await user.type(screen.getByLabelText("あなたの名前"), "大禅");
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(onSave).toHaveBeenCalledWith({ displayName: "大禅", addressingStyle: "san" });
  });

  it("keeps the settings screen open with a retryable error", () => {
    render(<ProfileSettings profile={profile} saving={false} error="保存できませんでした。もう一度お試しください。" onSave={vi.fn()} onClose={vi.fn()} onOpenMemories={vi.fn()} />);
    expect(screen.getByRole("main", { name: "設定" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("保存できませんでした");
    expect(screen.getByRole("button", { name: "保存する" })).toBeEnabled();
  });

  it("lets the signed-in owner set a password for home-screen login", async () => {
    const onUpdatePassword = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<ProfileSettings profile={profile} saving={false} error={null} onSave={vi.fn()} onClose={vi.fn()} onOpenMemories={vi.fn()} onUpdatePassword={onUpdatePassword} />);
    await user.type(screen.getByLabelText("新しいパスワード"), "new-long-password");
    await user.type(screen.getByLabelText("新しいパスワード（確認）"), "new-long-password");
    await user.click(screen.getByRole("button", { name: "パスワードを設定" }));
    expect(onUpdatePassword).toHaveBeenCalledWith("new-long-password");
    expect(await screen.findByRole("status")).toHaveTextContent("パスワードを設定しました");
  });
});
