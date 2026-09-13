import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { createMemoryLocalStateStore, EMPTY_LOCAL_CHAT, type LocalStateStore } from "../src/local-state";
import { Setup } from "../src/screens/Setup";

const now = "2026-08-09T03:00:00.000Z";

describe("initial setup", () => {
  it("shows a safe setup error when the existing profile cannot be loaded", async () => {
    const save = vi.fn(async () => ({ displayName: "大輝", addressingStyle: "san" as const, updatedAt: now }));
    render(<App
      splashDurationMs={0}
      chatStore={createMemoryLocalStateStore()}
      profileApi={{ get: async () => { throw new Error("private profile lookup failed"); }, save }}
      chatApi={{ respond: async ({ clientMessageId }) => ({ replyGroupId: clientMessageId, bubbles: [] }) }}
      now={() => now}
      nextId={() => "unused"}
    />);

    expect(await screen.findByRole("alert")).toHaveTextContent("設定を読み込めませんでした。再読み込みしてもう一度お試しください。");
    expect(screen.getByLabelText("あなたの名前")).toBeDisabled();
    expect(screen.getByRole("button", { name: "はじめる" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private profile lookup failed");
  });

  it("saves a name with the default さん addressing style", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(<Setup saving={false} error={null} onSave={onSave} />);

    await user.type(screen.getByLabelText("あなたの名前"), "大輝");
    await user.click(screen.getByRole("button", { name: "はじめる" }));

    expect(onSave).toHaveBeenCalledWith({ displayName: "大輝", addressingStyle: "san" });
  });

  it("does not persist an unfinished setup name and enters chat only after the first save succeeds", async () => {
    const store: LocalStateStore = {
      load: async () => EMPTY_LOCAL_CHAT,
      save: vi.fn(async () => undefined),
    };
    const save = vi.fn(async (input: { displayName: string; addressingStyle: "san" | "none" }) => ({ ...input, updatedAt: now }));
    const user = userEvent.setup();

    render(<App
      splashDurationMs={0}
      chatStore={store}
      profileApi={{ get: async () => null, save }}
      chatApi={{ respond: async ({ clientMessageId }) => ({ replyGroupId: clientMessageId, bubbles: [] }) }}
      now={() => now}
      nextId={() => "greeting"}
    />);

    const name = await screen.findByLabelText("あなたの名前");
    await user.type(name, "大輝");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.load()).toEqual(EMPTY_LOCAL_CHAT);
    expect(screen.queryByRole("textbox", { name: "メッセージ" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "はじめる" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ displayName: "大輝", addressingStyle: "san" }));
    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      timeline: [
        expect.objectContaining({ id: "greeting:0", text: "大輝さん、はじめまして" }),
        expect.objectContaining({ id: "greeting:1", text: "これからよろしくね" }),
      ],
    }));
    const typing = screen.getByRole("status", { name: "ずんだもんが入力中" });
    expect(typing).toBeVisible();
    expect(typing).not.toHaveTextContent("入力中");
    expect(typing.querySelectorAll(".typing-dot")).toHaveLength(3);
    expect(screen.queryByText("大輝さん、はじめまして")).not.toBeInTheDocument();
  });

  it("keeps Setup idle when the atomic greeting save fails and starts the delay only after retry succeeds", async () => {
    let storeAvailable = false;
    const attemptedSnapshots: Parameters<LocalStateStore["save"]>[0][] = [];
    const store: LocalStateStore = {
      load: async () => EMPTY_LOCAL_CHAT,
      save: async (snapshot) => {
        attemptedSnapshots.push(snapshot);
        if (!storeAvailable) throw new Error("IndexedDB unavailable");
      },
    };
    const save = vi.fn(async (input: { displayName: string; addressingStyle: "san" | "none" }) => ({ ...input, updatedAt: now }));
    const ids = ["opening-unused", "greeting-failed", "greeting-retried"];
    const user = userEvent.setup();

    render(<App
      splashDurationMs={0}
      chatStore={store}
      profileApi={{ get: async () => null, save }}
      chatApi={{ respond: async ({ clientMessageId }) => ({ replyGroupId: clientMessageId, bubbles: [] }) }}
      now={() => now}
      nextId={() => ids.shift() ?? "extra"}
    />);

    await user.type(await screen.findByLabelText("あなたの名前"), "大輝");
    await user.click(screen.getByRole("button", { name: "はじめる" }));

    expect(await screen.findByText("設定を保存できませんでした。もう一度お試しください。")).toBeVisible();
    expect(screen.getByLabelText("あなたの名前")).toBeVisible();
    expect(screen.queryByRole("button", { name: "設定を開く" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "ずんだもんが入力中" })).not.toBeInTheDocument();
    expect(screen.queryByText("大輝さん、はじめまして")).not.toBeInTheDocument();
    expect(attemptedSnapshots).toHaveLength(1);
    expect(attemptedSnapshots[0]?.timeline).toEqual([
      expect.objectContaining({ id: "greeting-failed:0", text: "大輝さん、はじめまして" }),
      expect.objectContaining({ id: "greeting-failed:1", text: "これからよろしくね" }),
    ]);

    storeAvailable = true;
    await user.click(screen.getByRole("button", { name: "はじめる" }));

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeVisible();
    const typing = screen.getByRole("status", { name: "ずんだもんが入力中" });
    expect(typing).toBeVisible();
    expect(typing).not.toHaveTextContent("入力中");
    expect(typing.querySelectorAll(".typing-dot")).toHaveLength(3);
    expect(screen.queryByText("大輝さん、はじめまして")).not.toBeInTheDocument();
    expect(attemptedSnapshots).toHaveLength(2);
    expect(attemptedSnapshots[1]?.timeline).toEqual([
      expect.objectContaining({ id: "greeting-retried:0", text: "大輝さん、はじめまして" }),
      expect.objectContaining({ id: "greeting-retried:1", text: "これからよろしくね" }),
    ]);
  });
});
