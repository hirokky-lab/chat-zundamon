import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { HostedApp } from "../src/App";
import { createMemoryLocalStateStore } from "../src/local-state";
import { createZundamonModelManifest } from "../src/live2d/zundamon-model-manifest";
import { attachVoiceAudioReader, readVoiceAudioSignal } from "../src/voice-audio-signal";
import type { AuthSession } from "../src/auth";
import type { AvatarStageProps } from "../src/live2d/AvatarStage";

const mounts = vi.hoisted(() => ({ active: 0, peak: 0, readers: [] as unknown[] }));
vi.mock("../src/live2d/AvatarStage", () => ({ AvatarStage: (props: AvatarStageProps) => {
  useEffect(() => {
    mounts.active++; mounts.peak = Math.max(mounts.peak, mounts.active);
    return () => { mounts.active--; };
  }, []);
  mounts.readers.push(props.readAudioSignal);
  return <output data-testid="avatar-signal">{props.readAudioSignal?.().volume ?? 0}</output>;
} }));

it("loads the selected stage only after authentication, releases it during calls and restores it on return", async () => {
  mounts.active = 0; mounts.peak = 0; mounts.readers = [];
  const detach = attachVoiceAudioReader(() => ({ speechState: "speaking", volume: 0.6 }));
  let session: AuthSession | null = null;
  let changeSession: (session: AuthSession | null) => void = () => {};
  const authClient = {
    getSession: async () => session, onSessionChange: (listener: typeof changeSession) => { changeSession = next => { session = next; listener(next); }; return () => {}; },
    signInWithPassword: vi.fn(), requestOtp: vi.fn(), verifyOtp: vi.fn(), updatePassword: vi.fn(), signOut: vi.fn(),
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/profile")) return Response.json({ profile: { displayName: "所有者", addressingStyle: "san", updatedAt: "2026-09-06T00:00:00.000Z" } });
    if (url.endsWith("/api/chat-state")) return Response.json({ snapshot: init?.method === "PUT" ? { ...JSON.parse(String(init.body)).snapshot, revision: 1 } : { version: 2, revision: 0, updatedAt: "2026-09-06T00:00:00.000Z", timeline: [], lastOpeningAt: null, lastConversationAt: null } });
    return new Response(null, { status: 500 });
  };
  const user = userEvent.setup();
  const view = render(<HostedApp authClient={authClient} apiBaseUrl="" fetchImpl={fetchImpl} cacheStore={createMemoryLocalStateStore()} splashDurationMs={0} integratedUiEnabled live2dAvatarEnabled live2dModel={createZundamonModelManifest("a".repeat(64))}
    realtimeClient={dispatch => ({ start: async () => { dispatch({ type: "connected" }); }, stop: () => dispatch({ type: "stopped" }) })} />);
  try {
    await screen.findByRole("button", { name: "ログイン", exact: true });
    expect(mounts.active).toBe(0);
    await act(async () => changeSession({ accessToken: "fixture", userId: "owner", email: "owner@example.com" }));
    await screen.findByRole("textbox", { name: "メッセージ" });
    await waitFor(() => expect(mounts.active).toBe(1));
    expect(await screen.findByTestId("avatar-signal")).toHaveTextContent("0.6");
    await user.click(screen.getByRole("button", { name: "ライブチャットを開始" }));
    await screen.findByRole("button", { name: "ライブチャットを終了" });
    expect(screen.getByText("マイク使用中")).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-signal")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "メッセージ" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "ライブチャットを終了" }));
    await screen.findByRole("textbox", { name: "メッセージ" });
    expect(await screen.findByTestId("avatar-signal")).toHaveTextContent("0.6");
    expect(screen.getByRole("button", {name: "トークを開く"})).toBeVisible();
    expect(mounts.readers.filter(Boolean).every(reader => reader === readVoiceAudioSignal)).toBe(true);
    expect(mounts.peak).toBe(1);

    await waitFor(() => expect(mounts.active).toBe(1));
  } finally { view.unmount(); detach(); }
});
