import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvatarStage } from "../src/live2d/AvatarStage";
import type { AvatarFrameInput, AvatarModelManifest, AvatarRenderer } from "../src/live2d/avatar-contract";

const manifest: AvatarModelManifest = {
  id: "simple",
  sdkVersion: "5-r.5",
  bridge: { path: "bridge", url: "/live2d/bridge.js", sha256: "a".repeat(64), maxBytes: 100 },
  assets: [{ path: "simple.model3.json", url: "/live2d/simple.model3.json", sha256: "b".repeat(64), maxBytes: 100 }],
  notice: "公式検証用サンプル・YUI正式デザインではありません",
  provisional: true,
};

const fallback = { src: "/static-yui.png", alt: "SDユイ" };
const animate = { mode: "animate" } as const;

function renderer(): AvatarRenderer {
  return { setInput: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
}

function clock() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  return {
    request: vi.fn((callback: FrameRequestCallback) => { callbacks.set(++id, callback); return id; }),
    cancel: vi.fn((frameId: number) => { callbacks.delete(frameId); }),
    tick(time: number) {
      const current = [...callbacks.entries()];
      callbacks.clear();
      current.forEach(([, callback]) => callback(time));
    },
  };
}

describe("Live2D AvatarStage", () => {
  it('uses a loading notice instead of another character until the first rendered frame', async () => {
    const animation = clock(), loaded = renderer();
    let resolve!: (value: AvatarRenderer) => void;
    const source = { load: vi.fn(() => new Promise<AvatarRenderer>(done => { resolve = done; })) };
    const view = render(<AvatarStage enabled fallback={fallback} capability={animate} rendererSource={source} animationClock={animation} loadingNotice="モデルを準備中" />);
    await waitFor(() => expect(source.load).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('モデルを準備中');
    expect(view.container.querySelector('img')).not.toBeVisible();
    await act(async () => resolve(loaded));
    act(() => animation.tick(100));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('live2d-avatar-canvas')).toBeVisible();
  });
  it('still offers the static fallback if VRM loading actually fails', async () => {
    const source = { load: vi.fn(async () => { throw Error('load failure'); }) };
    render(<AvatarStage enabled fallback={fallback} capability={animate} rendererSource={source} loadingNotice="モデルを準備中" />);
    await screen.findByText('静止画で表示しています');
    expect(screen.queryByText('モデルを準備中')).toBeNull();
    expect(screen.getByRole('img', { name: fallback.alt })).toBeVisible();
  });

  it('shares rendering signals and cleanup with a local VRM source without loading Live2D', async () => {
    const liveRenderer=renderer(),animation=clock(),loadRenderer=vi.fn();
    const source={load:vi.fn(async(_canvas: HTMLCanvasElement,_signal: AbortSignal)=>liveRenderer)};
    const view=render(<AvatarStage enabled fallback={fallback} capability={animate} rendererSource={source} loadRenderer={loadRenderer} animationClock={animation} audioSignal={{speechState:'speaking',volume:.7}} />);
    await waitFor(()=>expect(animation.request).toHaveBeenCalled());
    act(()=>animation.tick(1000));
    expect(liveRenderer.setInput).toHaveBeenCalledWith(expect.objectContaining({mouthOpen:.7,speechState:'speaking'}));
    expect(loadRenderer).not.toHaveBeenCalled();
    view.unmount();expect(liveRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(source.load.mock.calls[0][1].aborted).toBe(true);
  });
  it('shows preparation until real speech starts and updates without reloading the renderer', async () => {
    const liveRenderer = renderer(), animation = clock();
    const loadRenderer = vi.fn(async () => liveRenderer);
    let speechState: 'silent' | 'speaking' = 'silent';
    const readAudioSignal = () => ({speechState, volume: speechState === 'speaking' ? .6 : 0});
    const props = {enabled:true,manifest,fallback,capability:animate,loadRenderer,animationClock:animation,readAudioSignal};
    const view = render(<AvatarStage {...props} preparing />);
    await waitFor(() => expect(animation.request).toHaveBeenCalled());
    act(() => animation.tick(10000));
    expect(vi.mocked(liveRenderer.setInput).mock.lastCall?.[0].speechState).toBe('preparing');
    speechState = 'speaking';
    act(() => animation.tick(10100));
    expect(vi.mocked(liveRenderer.setInput).mock.lastCall?.[0]).toMatchObject({speechState:'speaking',mouthOpen:.6});
    speechState = 'silent';
    view.rerender(<AvatarStage {...props} preparing={false} />);
    act(() => animation.tick(10200));
    expect(vi.mocked(liveRenderer.setInput).mock.lastCall?.[0].speechState).toBe('silent');
    expect(loadRenderer).toHaveBeenCalledTimes(1);
  });
  it("does not lazy-load while the feature is disabled", () => {
    const loadRenderer = vi.fn();
    render(<AvatarStage enabled={false} manifest={manifest} fallback={fallback} capability={{ mode: "fallback", reason: "disabled" }} loadRenderer={loadRenderer} />);

    expect(screen.getByRole("img", { name: "SDユイ" })).toHaveAttribute("src", "/static-yui.png");
    expect(loadRenderer).not.toHaveBeenCalled();
    expect(screen.queryByTestId("live2d-avatar-canvas")).not.toBeInTheDocument();
  });

  it.each(["reduced-motion", "mobile", "low-performance", "unsupported"] as const)("uses a safe static fallback for %s", (reason) => {
    const loadRenderer = vi.fn();
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={{ mode: "fallback", reason }} loadRenderer={loadRenderer} />);

    expect(screen.getByRole("img", { name: "SDユイ" })).toBeVisible();
    expect(screen.getByText("静止画で表示しています")).toBeInTheDocument();
    expect(loadRenderer).not.toHaveBeenCalled();
  });

  it("keeps the portrait visible until the canvas renderer is ready", async () => {
    let resolve!: (value: AvatarRenderer) => void;
    const pending = new Promise<AvatarRenderer>((next) => { resolve = next; });
    const loadRenderer = vi.fn(() => pending);
    const liveRenderer = renderer();
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={loadRenderer} />);

    expect(screen.getByRole("img", { name: "SDユイ" })).toBeVisible();
    expect(screen.getByTestId("live2d-avatar-canvas")).not.toBeVisible();

    resolve(liveRenderer);
    await waitFor(() => expect(screen.getByTestId("live2d-avatar-canvas")).toBeVisible());
    expect(screen.getByAltText("SDユイ")).not.toBeVisible();
    expect(liveRenderer.resize).toHaveBeenCalled();
  });

  it("forwards deterministic idle, blink, and speech fixture input", async () => {
    const liveRenderer = renderer();
    const animation = clock();
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={async () => liveRenderer} animationClock={animation} audioSignal={{ speechState: "speaking", volume: 0.6 }} />);
    await waitFor(() => expect(animation.request).toHaveBeenCalled());

    act(() => animation.tick(10_000));
    const input = vi.mocked(liveRenderer.setInput).mock.calls.at(-1)?.[0] as AvatarFrameInput;
    expect(input).toMatchObject({ mouthOpen: 0.6, speechState: "speaking", volume: 0.6 });
    expect(input.idle).toBeGreaterThanOrEqual(0);
    expect(input.eyeOpenLeft).toBeGreaterThanOrEqual(0);
  });

  it("disposes a loaded renderer and cancels animation on unmount", async () => {
    const liveRenderer = renderer();
    const animation = clock();
    const view = render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={async () => liveRenderer} animationClock={animation} />);
    await waitFor(() => expect(animation.request).toHaveBeenCalled());

    view.unmount();
    expect(liveRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(animation.cancel).toHaveBeenCalled();
  });

  it("fails closed without retry when loading rejects", async () => {
    const loadRenderer = vi.fn(async () => { throw new Error("private detail"); });
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={loadRenderer} />);

    await waitFor(() => expect(screen.getByText("静止画で表示しています")).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "SDユイ" })).toBeVisible();
    expect(screen.queryByText("private detail")).not.toBeInTheDocument();
    expect(loadRenderer).toHaveBeenCalledTimes(1);
  });

  it("reports a broken fallback image to the host screen", () => {
    const onFallbackError = vi.fn();
    render(<AvatarStage enabled={false} manifest={manifest} fallback={fallback} capability={{ mode: "fallback", reason: "disabled" }} onFallbackError={onFallbackError} />);

    screen.getByRole("img", { name: "SDユイ" }).dispatchEvent(new Event("error", { bubbles: true }));
    expect(onFallbackError).toHaveBeenCalledTimes(1);
  });

  it("disposes a renderer that resolves after unmount", async () => {
    let resolve!: (value: AvatarRenderer) => void;
    const late = new Promise<AvatarRenderer>((next) => { resolve = next; });
    const liveRenderer = renderer();
    const view = render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={() => late} />);
    view.unmount();

    await act(async () => resolve(liveRenderer));
    expect(liveRenderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails closed and disposes when renderer resize throws", async () => {
    const liveRenderer = renderer();
    vi.mocked(liveRenderer.resize).mockImplementation(() => { throw new Error("private resize failure"); });
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={async () => liveRenderer} />);

    await waitFor(() => expect(screen.getByText("静止画で表示しています")).toBeInTheDocument());
    expect(screen.getByRole("img", { name: "SDユイ" })).toBeVisible();
    expect(liveRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("private resize failure")).not.toBeInTheDocument();
  });

  it("fails closed and disposes when a render frame throws", async () => {
    const liveRenderer = renderer();
    const animation = clock();
    vi.mocked(liveRenderer.setInput).mockImplementation(() => { throw new Error("private render failure"); });
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={async () => liveRenderer} animationClock={animation} />);
    await waitFor(() => expect(animation.request).toHaveBeenCalled());

    act(() => animation.tick(100));
    expect(screen.getByText("静止画で表示しています")).toBeInTheDocument();
    expect(liveRenderer.dispose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("private render failure")).not.toBeInTheDocument();
  });

  it("keeps the static fallback when renderer disposal also throws", async () => {
    const liveRenderer = renderer();
    const animation = clock();
    vi.mocked(liveRenderer.setInput).mockImplementation(() => { throw new Error("render failure"); });
    vi.mocked(liveRenderer.dispose).mockImplementation(() => { throw new Error("dispose failure"); });
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={async () => liveRenderer} animationClock={animation} />);
    await waitFor(() => expect(animation.request).toHaveBeenCalled());

    expect(() => act(() => animation.tick(100))).not.toThrow();
    expect(screen.getByText("静止画で表示しています")).toBeInTheDocument();
  });
  it("releases when hidden and creates a fresh renderer on return", async () => {
    const first = renderer();
    const second = renderer();
    const loadRenderer = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const props = { enabled: true, manifest, fallback, capability: animate, loadRenderer };
    const view = render(<AvatarStage {...props} visible />);
    await waitFor(() => expect(first.resize).toHaveBeenCalled());
    view.rerender(<AvatarStage {...props} visible={false} />);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    view.rerender(<AvatarStage {...props} visible />);
    await waitFor(() => expect(second.resize).toHaveBeenCalled());
    expect(loadRenderer).toHaveBeenCalledTimes(2);
  });

  it("disposes on background and resumes without catching up elapsed time", async () => {
    const loadRenderer = vi.fn(async () => renderer());
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={loadRenderer} />);
    await waitFor(() => expect(loadRenderer).toHaveBeenCalledTimes(1));
    const first = await loadRenderer.mock.results[0].value;
    act(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    act(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(loadRenderer).toHaveBeenCalledTimes(2));
  });

  it("caps rendering at 30fps and drawing scale at 1.5", async () => {
    const liveRenderer = renderer();
    const animation = clock();
    render(<AvatarStage enabled manifest={manifest} fallback={fallback} capability={animate} loadRenderer={async () => liveRenderer} animationClock={animation} />);
    await waitFor(() => expect(animation.request).toHaveBeenCalled());
    act(() => { for (let t = 0; t <= 1000; t += 10) animation.tick(t); });
    expect(vi.mocked(liveRenderer.setInput).mock.calls.length).toBeLessThanOrEqual(32);
    expect(vi.mocked(liveRenderer.resize).mock.calls[0][2]).toBeLessThanOrEqual(1.5);
  });

});
