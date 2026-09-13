import { readFileSync } from "node:fs";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AppProps } from "../src/App";
import { EMPTY_LOCAL_CHAT } from "../src/local-state";
import { Splash } from "../src/screens/Splash";

const splashStyles = readFileSync("src/styles.css", "utf8");
const now = "2026-08-16T00:00:00.000Z";

function appProps(overrides: Partial<AppProps> = {}): AppProps {
  return {
    splashDurationMs: 1_000,
    chatStore: { load: async () => EMPTY_LOCAL_CHAT, save: async () => undefined },
    profileApi: { get: async () => null, save: async (displayName) => ({ displayName, updatedAt: now }) },
    chatApi: { respond: async ({ clientMessageId }) => ({ id: `${clientMessageId}:assistant`, role: "assistant", text: "こんばんは", createdAt: now }) },
    now: () => now,
    nextId: () => "opening",
    ...overrides,
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("YUI launch screen", () => {
  it("keeps startup free of character marks and wordmarks", () => {
    render(<Splash ready={false} />);
    expect(screen.queryByText("ず")).not.toBeInTheDocument();
    expect(screen.queryByText("ずんだもん")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uses the approved character PNG as the browser icon", () => {
    const documentHtml = readFileSync("index.html", "utf8");
    const document = new DOMParser().parseFromString(documentHtml, "text/html");
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(icon?.type).toBe("image/png");
    expect(icon?.getAttribute("href")).toBe("/icons/zundamon-32-v2.png");
  });

  it("uses only the approved canvas and opacity fade", () => {
    const reducedMotionRules = splashStyles.slice(splashStyles.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(splashStyles).toMatch(/\.splash-screen[^}]*background:\s*#FEFEFD/s);
    expect(splashStyles).toMatch(/\.splash-logo[^}]*border:\s*0/s);
    expect(splashStyles).toMatch(/\.splash-wordmark[^}]*font-size:\s*20px/s);
    expect(splashStyles).toMatch(/\.splash-wordmark[^}]*letter-spacing:\s*\.24em/s);
    expect(splashStyles).toMatch(/\.splash-wordmark[^}]*bottom:\s*max\(46px,\s*calc\(env\(safe-area-inset-bottom\)/s);
    expect(splashStyles).toMatch(/\.splash-screen\.is-ready[^}]*opacity:\s*0/s);
    expect(splashStyles).toMatch(/\.splash-screen[^}]*transition:\s*opacity\s+240ms/s);
    expect(splashStyles).not.toMatch(/\.splash-screen[^}]*transform\s*:/s);
    expect(reducedMotionRules).toMatch(/\.splash-screen[^}]*80ms/s);
  });

  it("waits for initialization rather than a fixed hold", async () => {
    vi.useFakeTimers();
    let finishLoad: (() => void) | undefined;
    const load = vi.fn(() => new Promise<typeof EMPTY_LOCAL_CHAT>((resolve) => { finishLoad = () => resolve(EMPTY_LOCAL_CHAT); }));
    render(<App {...appProps({ splashDurationMs: 1, chatStore: { load, save: async () => undefined } })} />);
    expect(screen.getByLabelText("Chatずんだもん 起動画面")).toBeVisible();
    await act(async () => { await Promise.resolve(); });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByLabelText("Chatずんだもん 起動画面")).toBeVisible();
    await act(async () => { finishLoad?.(); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("launch-screen")).toHaveClass("is-ready");
  });

  it("does not show the launch layer again after a mounted App rerenders", async () => {
    vi.useFakeTimers();
    const props = appProps();
    const { rerender } = render(<App {...props} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(() => vi.advanceTimersByTimeAsync(240));
    expect(screen.queryByTestId("launch-screen")).not.toBeInTheDocument();
    rerender(<App {...props} splashDurationMs={2_000} />);
    expect(screen.queryByTestId("launch-screen")).not.toBeInTheDocument();
  });

  it("renders the brand without depending on a remote logo asset", () => {
    render(<Splash ready={false} />);
    expect(screen.getByLabelText("Chatずんだもん 起動画面")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("cleans up the ready fade when App unmounts early", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<App {...appProps()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(240));
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/state update|unmounted component/i);
  });
});
