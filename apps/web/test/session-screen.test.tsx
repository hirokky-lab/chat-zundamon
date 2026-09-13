import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App, type RealtimeClientFactory } from "../src/App";
import type { SessionAction } from "../src/session-reducer";

import { EMPTY_LOCAL_CHAT } from "../src/local-state";
const freshStore = () => ({ load: async () => ({ ...EMPTY_LOCAL_CHAT }), save: async () => undefined });

const profileApi = {
  get: async () => ({ displayName: "大輝", addressingStyle: "san" as const, updatedAt: "2026-08-09T03:00:00.000Z" }),
  save: async (input: { displayName: string; addressingStyle: "san" | "none" }) => ({ ...input, updatedAt: "2026-08-09T03:00:00.000Z" }),
};

function fakeConnectedClient(): RealtimeClientFactory {
  return (dispatch) => ({
    start: async () => {
      dispatch({ type: "connected" });
      dispatch({
        type: "transcript",
        turn: { role: "assistant", text: "おかえりなさい" },
      });
    },
    stop: () => dispatch({ type: "stopped" }),
  });
}

function controlledClient() {
  let dispatch: ((action: SessionAction) => void) | undefined;
  const start = vi.fn(async () => undefined);
  const stop = vi.fn();
  const factory: RealtimeClientFactory = (nextDispatch) => {
    dispatch = nextDispatch;
    return { start, stop };
  };

  return {
    factory,
    start,
    stop,
    emit(action: SessionAction) {
      if (!dispatch) {
        throw new Error("Realtime client has not been created");
      }
      act(() => dispatch?.(action));
    },
  };
}

async function startCall() {
  const button = await screen.findByRole("button", { name: "ライブチャットを開始" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

describe("Yui conversation screen", () => {
  it("lets Yui speak first after one explicit start action", async () => {
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={fakeConnectedClient()} />);

    await startCall();

    expect(await screen.findByText("おかえりなさい")).toBeVisible();
    expect(
      screen.queryByText("ずんだもん、ただいまと話してください"),
    ).not.toBeInTheDocument();
  });

  it("does not invent Yui's greeting before the realtime connection delivers it", async () => {
    const client = controlledClient();
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={client.factory} />);

    await startCall();

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "通話を準備しています" })).toBeDisabled();
    expect(screen.queryByText("おかえりなさい")).not.toBeInTheDocument();

    client.emit({ type: "connected" });
    expect(screen.getByText("聞いています")).toBeVisible();
    expect(screen.queryByText("おかえりなさい")).not.toBeInTheDocument();

    client.emit({
      type: "transcript",
      turn: { role: "assistant", text: "おかえりなさい" },
    });
    expect(screen.getByText("おかえりなさい")).toBeVisible();
  });

  it("always exposes microphone state and an end button", async () => {
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={fakeConnectedClient()} />);
    await startCall();

    expect(screen.getByText("マイク使用中")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "ライブチャットを終了" }),
    ).toBeVisible();
    expect(screen.getByText("文字起こし")).toBeVisible();
  });

  it("stays on the session until stop reports that the microphone is off", async () => {
    const client = controlledClient();
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={client.factory} />);
    await startCall();
    client.emit({ type: "connected" });

    const endButton = screen.getByRole("button", { name: "ライブチャットを終了" });
    fireEvent.click(endButton);
    fireEvent.click(endButton);

    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "ライブチャットを終了" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "記憶の確認" })).not.toBeInTheDocument();

    client.emit({ type: "stopped" });

    expect(await screen.findByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    expect(screen.queryByText("マイク使用中")).not.toBeInTheDocument();
  });

  it("shows the prescribed safe failure message", async () => {
    const error = new Error("permission denied");
    const factory: RealtimeClientFactory = (dispatch) => ({
      start: async () => {
        dispatch({ type: "failed", error });
        throw error;
      },
      stop: vi.fn(),
    });
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={factory} />);

    await startCall();

    expect(
      await screen.findByText(
        "ずんだもんとの接続に失敗しました。マイクは停止しています",
      ),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "もう一度試す" })).not.toBeInTheDocument();
  });

  it("returns to usable chat after a connection failure", async () => {
    const client = controlledClient();
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={client.factory} />);
    await startCall();
    client.emit({ type: "failed", error: new Error("connection failed") });

    expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeEnabled();
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/VOICEVOX Nemoを起動/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "もう一度試す" })).not.toBeInTheDocument();
  });
});

it("offers mute, interruption and end controls on the round-face call screen", async () => {
  const {Session} = await import('../src/screens/Session');
  const onMute=vi.fn(),onInterrupt=vi.fn(),onEnd=vi.fn();
  render(<Session ending={false} onEnd={onEnd} onMute={onMute} onInterrupt={onInterrupt} state={{phase:'speaking',microphoneEnabled:true,turns:[],error:null,errorKind:null}} />);
  fireEvent.click(screen.getByRole('button',{name:'マイクをミュート'}));
  fireEvent.click(screen.getByRole('button',{name:'返事を止めて話す'}));
  fireEvent.click(screen.getByRole('button',{name:'ライブチャットを終了'}));
  expect(onMute).toHaveBeenCalledOnce();expect(onInterrupt).toHaveBeenCalledOnce();expect(onEnd).toHaveBeenCalledOnce();
  expect(screen.getByRole('img',{name:'ずんだもん'})).toBeVisible();
});


describe("character layout across the call lifecycle", () => {
  it.each(["ended", "start-failed", "call-failed"] as const)("preserves the character and talk toggle after %s", async outcome => {
    const client = controlledClient();
    render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} realtimeClient={client.factory} />);
    await screen.findByRole("button", {name: "トークを開く"});
    await startCall();
    // Preparing must retain the same character stage, not enter the old log-only UI.
    expect(screen.getByRole("button", {name: "トークを開く"})).toBeVisible();
    expect(screen.getByLabelText("ずんだもんの姿")).toBeVisible();
    if (outcome !== "start-failed") {
      client.emit({type: "connected"});
      expect(screen.getByRole("heading", {name: "ずんだもんと通話中"})).toBeVisible();
    }
    if (outcome === "ended") {
      fireEvent.click(screen.getByRole("button", {name: "ライブチャットを終了"}));
      client.emit({type: "stopped"});
    } else client.emit({type: "failed", error: new Error("connection failed")});
    expect(await screen.findByRole("button", {name: "トークを開く"})).toBeVisible();
    expect(screen.getByLabelText("ずんだもんの姿")).toBeVisible();
    expect(screen.getByRole("textbox", {name: "メッセージ"})).toBeEnabled();
    fireEvent.click(screen.getByRole("button", {name: "トークを開く"}));
    expect(screen.getByRole("button", {name: "トークを閉じる"})).toBeVisible();
    fireEvent.click(screen.getByRole("button", {name: "トークを閉じる"}));
    expect(screen.getByRole("button", {name: "ライブチャットを開始"})).toBeEnabled();
  });
});

it("closes nested menu pages directly to the character home, including an open talk log", async () => {
 render(<App chatStore={freshStore()} splashDurationMs={0} profileApi={profileApi} integratedUiEnabled />);
 await screen.findByRole("button", {name: "トークを開く"});
 fireEvent.click(screen.getByRole("button", {name: "トークを開く"}));
 fireEvent.click(screen.getByRole("button", {name: "メニューを開く"}));
 fireEvent.click(screen.getByRole("button", {name: "クレジット"}));
 expect(screen.getByRole("dialog", {name: "クレジット"})).toBeVisible();
 fireEvent.click(screen.getByRole("button", {name: "閉じてホームへ戻る"}));
 expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
 expect(screen.getByRole("button", {name: "トークを開く"})).toBeVisible();
 expect(screen.getByLabelText("ずんだもんの姿")).toBeVisible();
 fireEvent.click(screen.getByRole("button", {name: "メニューを開く"}));
 expect(screen.getByRole("dialog", {name: "メニュー"})).toBeVisible();
});
