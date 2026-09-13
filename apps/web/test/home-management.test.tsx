import { readFileSync } from "node:fs";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HomeManagement } from "../src/screens/HomeManagement";
import {
  EMPTY_HOME_MANAGEMENT_MODEL,
  setHomeServiceConnection,
  setHomeServiceHomeVisible,
  setHomeWeatherLocation,
  toHomeViewModel,
  type HomeManagementModel,
} from "../src/home-management";

const model: HomeManagementModel = {
  services: [
    { id: "calendar", label: "Googleカレンダー", connected: true, homeSupported: true, homeVisible: true },
    { id: "tasks", label: "Google Tasks", connected: true, homeSupported: true, homeVisible: false },
    { id: "drive", label: "Google Drive", connected: true, homeSupported: false, homeVisible: false },
    { id: "gmail", label: "Gmail", connected: true, homeSupported: false, homeVisible: false },
    { id: "weather", label: "天気", connected: false, homeSupported: true, homeVisible: false },
  ],
  widgets: [
    { id: "calendar", label: "Googleカレンダー", visible: true, configurable: true },
  ],
};

describe("Home management", () => {
  it("derives Home from connected visible widgets without inventing provider data", () => {
    expect(toHomeViewModel(model)).toEqual({
      shellState: { state: "off" },
      sections: [
        { id: "calendar", kind: "calendar", label: "Googleカレンダー", state: "empty" },
        { id: "weather", kind: "weather", label: "天気", state: "unconfigured" },
      ],
    });
  });

  it("uses widget order for weather, Calendar, and Tasks Home sections", () => {
    const ordered: HomeManagementModel = {
      ...model,
      weatherLocation: "東京都",
      services: model.services.map((service) => service.id === "weather" || service.id === "tasks"
        ? { ...service, connected: true, homeVisible: true }
        : service),
      widgets: [
        { id: "tasks", label: "Google Tasks", visible: true, configurable: false },
        { id: "weather", label: "天気", visible: true, configurable: true },
        { id: "calendar", label: "Googleカレンダー", visible: true, configurable: false },
      ],
    };
    expect(toHomeViewModel(ordered).sections.map(({ id }) => id)).toEqual(["tasks", "weather", "calendar"]);
  });

  it("clears Home placement on disconnect and never restores it on reconnect", () => {
    const disconnected = setHomeServiceConnection(model, "calendar", false);
    expect(disconnected.services.find(({ id }) => id === "calendar")).toMatchObject({ connected: false, homeVisible: false });
    expect(disconnected.widgets).toEqual([]);

    const reconnected = setHomeServiceConnection(disconnected, "calendar", true);
    expect(reconnected.services.find(({ id }) => id === "calendar")).toMatchObject({ connected: true, homeVisible: false });
    expect(reconnected.widgets).toEqual([]);
  });

  it("fails closed when an unconnected or unsupported service is placed on Home", () => {
    expect(() => setHomeServiceHomeVisible(model, "weather", true)).toThrow("connected");
    expect(() => setHomeServiceHomeVisible(model, "drive", true)).toThrow("Home");
  });

  it("preserves model metadata except when weather itself is disconnected", () => {
    const configured = { ...model, weatherLocation: "東京都" };
    expect(setHomeServiceConnection(configured, "calendar", false).weatherLocation).toBe("東京都");
    expect(setHomeServiceHomeVisible(configured, "calendar", false).weatherLocation).toBe("東京都");
    expect(setHomeServiceConnection(configured, "weather", false).weatherLocation).toBeUndefined();
  });

  it("keeps the approved Home-like hierarchy without repeated row dividers", () => {
    render(<HomeManagement view="home" model={model} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onSaveWeatherLocation={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "ホームを編集" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "表示中" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "ウィジェットを追加" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Googleカレンダーを上へ移動" })).toBeVisible();
    expect(screen.getByRole("switch", { name: "Googleカレンダーをホームに表示" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Google Tasksをホームに追加" })).toBeVisible();
    expect(screen.getByRole("button", { name: "接続サービスを管理" })).toBeVisible();
    expect(document.querySelectorAll(".management-section")).toHaveLength(2);
    expect(document.querySelectorAll(".management-row-divider")).toHaveLength(0);
  });

  it("keeps connection actions separate from Home placement and disconnects only local state", async () => {
    const user = userEvent.setup();
    const onToggleHome = vi.fn();
    const onChangeView = vi.fn();
    const onDisconnect = vi.fn();
    render(<HomeManagement view="connections" model={model} onClose={vi.fn()} onChangeView={onChangeView} onToggleHome={onToggleHome} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={onDisconnect} onSaveWeatherLocation={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "接続サービス" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "接続サービス一覧" })).toBeVisible();
    expect(screen.getAllByText("接続済み")).toHaveLength(3);
    expect(screen.queryByText("未接続")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ホームに追加|ホームから外す/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Googleカレンダーのその他の操作" }));
    expect(screen.getByText("取得を止め、対象キャッシュを削除します。再接続してもホーム表示は戻りません")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Googleカレンダーの接続を解除" }));
    expect(onDisconnect).toHaveBeenCalledWith("calendar");
    expect(onToggleHome).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "ホームを編集" })).not.toBeInTheDocument();
  });

  it("starts a disconnected Google service once and exposes only a fixed retryable failure", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn(() => Promise.reject(new Error("private OAuth transport detail")));
    const disconnected: HomeManagementModel = {
      ...EMPTY_HOME_MANAGEMENT_MODEL,
      services: EMPTY_HOME_MANAGEMENT_MODEL.services.map((service) => service.id === "calendar"
        ? { ...service, connectionState: "disconnected" as const }
        : service),
    };
    render(<HomeManagement view="connections" model={disconnected} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onConnect={onConnect} onSaveWeatherLocation={vi.fn()} />);

    const connect = screen.getByRole("button", { name: "Googleカレンダーを接続" });
    await user.click(connect);

    expect(onConnect).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent("Googleカレンダーの状態を変更できませんでした");
    expect(screen.getByRole("region", { name: "接続サービス一覧" })).not.toHaveAttribute("aria-busy");
    expect(connect).toBeEnabled();
    expect(document.body.textContent).not.toContain("private OAuth transport detail");
  });

  it("fails closed after a connection timeout until the original action settles", async () => {
    vi.useFakeTimers();
    let resolveConnection: (() => void) | undefined;
    const onConnect = vi.fn(() => new Promise<void>((resolve) => { resolveConnection = resolve; }));
    const disconnected: HomeManagementModel = {
      ...EMPTY_HOME_MANAGEMENT_MODEL,
      services: EMPTY_HOME_MANAGEMENT_MODEL.services.map((service) => service.id === "calendar"
        ? { ...service, connectionState: "disconnected" as const }
        : service),
    };
    render(<HomeManagement view="connections" model={disconnected} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onConnect={onConnect} onSaveWeatherLocation={vi.fn()} />);
    const connect = screen.getByRole("button", { name: "Googleカレンダーを接続" });

    try {
      act(() => connect.click());
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole("alert")).toHaveTextContent("確認が終わるまで再試行できません");
      expect(connect).toBeDisabled();
      act(() => connect.click());
      expect(onConnect).toHaveBeenCalledOnce();
      await act(async () => { resolveConnection?.(); await Promise.resolve(); });
      expect(connect).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a local weather-setting path and keeps Calendar and Tasks settings in Home display controls", async () => {
    const user = userEvent.setup();
    const onSaveWeatherLocation = vi.fn();
    render(<HomeManagement view="weather" model={model} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onSaveWeatherLocation={onSaveWeatherLocation} />);
    await user.type(screen.getByRole("textbox", { name: "地域" }), "東京都");
    await user.click(screen.getByRole("button", { name: "地域を保存" }));
    expect(onSaveWeatherLocation).toHaveBeenCalledWith("東京都");
    expect(setHomeWeatherLocation(model, "東京都").services.find(({ id }) => id === "weather")).toMatchObject({ connected: true, homeVisible: false });
  });

  it("keeps a 44px switch target around the smaller visual track and shows a short empty state", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync("src/styles.css", "utf8");
    document.head.append(style);
    try {
      render(<HomeManagement view="home" model={EMPTY_HOME_MANAGEMENT_MODEL} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onSaveWeatherLocation={vi.fn()} />);
      expect(screen.getByText("表示中のウィジェットはありません")).toBeVisible();
      expect(screen.getByText("接続済みサービスはトークで引き続き利用できます")).toBeVisible();
      const addSection = screen.getByRole("heading", { name: "ウィジェットを追加" }).closest("section");
      expect(addSection).not.toBeNull();
      expect(addSection).toHaveTextContent("追加できる接続済みサービスはありません");
      const populated = render(<HomeManagement view="home" model={model} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onSaveWeatherLocation={vi.fn()} />);
      const toggle = screen.getByRole("switch", { name: "Googleカレンダーをホームに表示" });
      expect(getComputedStyle(toggle).minHeight).toBe("44px");
      expect(toggle.querySelector(".management-switch-track")).toBeInTheDocument();
      populated.unmount();
    } finally {
      style.remove();
    }
  });

  it("gives long 320px management rows and the disconnect notice full-width wrapping blocks", async () => {
    const user = userEvent.setup();
    const longLabel = "とても長い地域名を含む天気ウィジェット表示名";
    const narrowModel: HomeManagementModel = {
      ...model,
      services: model.services.map((service) => service.id === "weather"
        ? { ...service, label: longLabel, connected: true, homeVisible: true }
        : service),
      widgets: [{ id: "weather", label: longLabel, visible: true, configurable: true }],
    };
    const { rerender } = render(<HomeManagement view="home" model={narrowModel} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onSaveWeatherLocation={vi.fn()} />);
    const weatherRow = screen.getByText(longLabel).closest(".management-row");
    expect(weatherRow?.querySelector(":scope > .management-row-main")).toBeInTheDocument();
    expect(weatherRow?.querySelector(":scope > .management-row-actions")).toBeInTheDocument();

    rerender(<HomeManagement view="connections" model={narrowModel} onClose={vi.fn()} onChangeView={vi.fn()} onToggleHome={vi.fn()} onToggleWidget={vi.fn()} onMoveWidget={vi.fn()} onDisconnect={vi.fn()} onSaveWeatherLocation={vi.fn()} />);
    expect(screen.queryByText(longLabel)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Googleカレンダーのその他の操作" }));
    const connectionRow = screen.getByText("取得を止め、対象キャッシュを削除します。再接続してもホーム表示は戻りません").closest(".management-row");
    expect(connectionRow?.querySelector(":scope > .management-disconnect-menu")).toBeInTheDocument();

    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*\.management-row\s*\{[^}]*flex-direction:\s*column/u);
    expect(css).toMatch(/\.management-disconnect-menu\s*\{[^}]*width:\s*100%[^}]*overflow-wrap:\s*anywhere/u);
  });
});
