import { describe, expect, it } from "vitest";
import {
  EMPTY_HOME_VIEW_MODEL,
  EMPTY_NEWS_VIEW_MODEL,
  INTEGRATED_UI_DEFAULT_ENABLED,
  createHomeViewModel,
  createNewsViewModel,
  isIntegratedUiEnabled,
  moveIntegratedUiView,
} from "../src/integrated-ui";

describe("integrated UI contract", () => {
  it("is disabled unless the local flag is exactly true", () => {
    expect(INTEGRATED_UI_DEFAULT_ENABLED).toBe(false);
    expect(isIntegratedUiEnabled(undefined)).toBe(false);
    expect(isIntegratedUiEnabled("false")).toBe(false);
    expect(isIntegratedUiEnabled("true")).toBe(true);
  });

  it("cycles the three views in both directions", () => {
    expect(moveIntegratedUiView("talk", 1)).toBe("home");
    expect(moveIntegratedUiView("news", 1)).toBe("talk");
    expect(moveIntegratedUiView("talk", -1)).toBe("news");
  });

  it("keeps initial shell states safely off without naming an external feature", () => {
    expect(EMPTY_HOME_VIEW_MODEL).toEqual({ shellState: { state: "off" }, sections: [{ id: "weather", kind: "weather", label: "天気", state: "unconfigured" }] });
    expect(EMPTY_NEWS_VIEW_MODEL).toEqual({ state: "off" });
  });

  it("keeps Home service fixtures restricted to connected calendar and tasks", () => {
    expect(createHomeViewModel({
      shellState: { state: "ready", value: { label: "今日の予定" } },
      sections: [
        { id: "calendar-1", kind: "calendar", label: "15:00 企画確認", state: "empty" },
        { id: "tasks-1", kind: "tasks", label: "原稿を確認", state: "empty" },
      ],
    }).sections).toHaveLength(2);
    expect(() => createHomeViewModel({
      shellState: { state: "off" },
      sections: [{ id: "mail-1", kind: "mail" as never, label: "受信箱", state: "empty" }],
    })).toThrow("calendar or tasks");
  });

  it("bounds typed News fixtures to ten unique article IDs", () => {
    const item = (id: string) => ({ id, title: `記事 ${id}`, source: "YUI", publishedAt: "2026-08-14T00:00:00.000Z", url: `https://example.com/${id}` });
    expect(createNewsViewModel({ state: "ready", value: [item("one")] }).value).toHaveLength(1);
    expect(() => createNewsViewModel({ state: "ready", value: [item("one"), item("one")] })).toThrow("duplicate");
    expect(() => createNewsViewModel({ state: "ready", value: Array.from({ length: 11 }, (_, index) => item(String(index))) })).toThrow("10");
  });
});
