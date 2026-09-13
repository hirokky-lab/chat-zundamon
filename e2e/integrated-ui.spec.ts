import { readFileSync } from "node:fs";
import { devices, expect, test, type Browser, type Page } from "playwright/test";

declare global {
  interface Window {
    __YUI_E2E_REALTIME_CLIENT__?: (dispatch: (action: { type: string }) => void) => {
      start(): Promise<void>;
      stop(): void;
      usageContext(): { sessionId: string; startedAt: string; endedAt: string };
    };
  }
}

type Profile = { displayName: string; addressingStyle: "san" | "none"; updatedAt: string };

const now = "2026-08-14T03:00:00.000Z";
const sentinels = {
  light: { ownerBg: "rgb(1, 2, 3)", ownerText: "rgb(4, 5, 6)", ownerBorder: "rgb(7, 8, 9)", assistantBg: "rgb(10, 11, 12)", assistantBorder: "rgb(13, 14, 15)", speechText: "rgb(16, 17, 18)" },
  dark: { ownerBg: "rgb(21, 22, 23)", ownerText: "rgb(24, 25, 26)", ownerBorder: "rgb(27, 28, 29)", assistantBg: "rgb(30, 31, 32)", assistantBorder: "rgb(33, 34, 35)", speechText: "rgb(36, 37, 38)" },
} as const;

function relativeLuminance(rgb: string): number {
  const [red, green, blue] = rgb.match(/\d+/g)!.map(Number).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const [first, second] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (first + 0.05) / (second + 0.05);
}

async function setThemeSentinels(page: Page) {
  await page.locator("html").evaluate((root, values) => {
    const style = (root as HTMLElement).style;
    for (const [prefix, token] of [["light", values.light], ["dark", values.dark]] as const) {
      style.setProperty(`--yui-owner-bubble-${prefix}-bg`, token.ownerBg);
      style.setProperty(`--yui-owner-bubble-${prefix}-text`, token.ownerText);
      style.setProperty(`--yui-owner-bubble-${prefix}-border`, token.ownerBorder);
      style.setProperty(`--yui-assistant-bubble-${prefix}-bg`, token.assistantBg);
      style.setProperty(`--yui-assistant-bubble-${prefix}-border`, token.assistantBorder);
      style.setProperty(`--yui-speech-text-${prefix}`, token.speechText);
    }
  }, sentinels);
}

async function setResolvedThemeSentinels(page: Page, values: typeof sentinels[keyof typeof sentinels]) {
  await page.locator("html").evaluate((root, tokens) => {
    const style = (root as HTMLElement).style;
    style.setProperty("--yui-owner-bubble-bg", tokens.ownerBg);
    style.setProperty("--yui-owner-bubble-text", tokens.ownerText);
    style.setProperty("--yui-owner-bubble-border", tokens.ownerBorder);
    style.setProperty("--yui-assistant-bubble-bg", tokens.assistantBg);
    style.setProperty("--yui-assistant-bubble-border", tokens.assistantBorder);
    style.setProperty("--yui-speech-text", tokens.speechText);
  }, values);
}

async function openIntegratedApp(page: Page, visualStyle: "yui" | "minimal" = "minimal"): Promise<void> {
  let profile: Profile | null = null;
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ contentType: "application/json", json: { profile } });
    const input = route.request().postDataJSON() as Pick<Profile, "displayName" | "addressingStyle">;
    profile = { ...input, updatedAt: now };
    return route.fulfill({ contentType: "application/json", json: { profile } });
  });
  await page.route("**/api/chat/responses", async (route) => {
    const body = route.request().postDataJSON() as { clientMessageId: string; turns: Array<{ text: string }> };
    const search = body.turns.at(-1)?.text.includes("検索")
      ? {
          status: "completed",
          searchedAt: now,
          sources: [{ title: "公式発表", url: "https://example.com/official" }],
          evidence: {
            facts: [{ text: "公式の案内を確認しました", sourceUrl: "https://example.com/official" }],
            inference: "予定は変更される可能性があります",
            suggestion: "ユイからは公式をもう一度見るのがおすすめ",
          },
        }
      : undefined;
    await route.fulfill({ contentType: "application/json", json: { reply: { replyGroupId: `${body.clientMessageId}:assistant`, bubbles: [{ id: `${body.clientMessageId}:assistant:0`, text: "ユイの返事", createdAt: now, sequence: 0 }], ...(search ? { search } : {}) } } });
  });
  let sourceMessageId = "missing-source";
  await page.route("**/api/memories", async (route) => route.fulfill({ contentType: "application/json", json: { memories: [{ id: "integrated-memory", kind: "preference", scope: "daily", content: "元の会話に戻る記憶", normalizedContent: "元の会話に戻る記憶", status: "active", origin: "manual", sensitivity: "normal", importance: 3, sourceMessageId, sourceOccurredAt: now, validFrom: null, validUntil: null, expiresAt: null, pinned: false, supersedesId: null, createdAt: now, updatedAt: now }] } }));
  await page.route("**/api/memory-settings", async (route) => route.fulfill({ contentType: "application/json", json: { settings: { automaticMemoryEnabled: true, recallMemoryEnabled: true, voiceMemoryEnabled: true, updatedAt: null } } }));
  await page.route("**/api/memory-tombstones", async (route) => route.fulfill({ contentType: "application/json", json: { tombstones: [] } }));
  await page.route("**/api/memory/process", async (route) => route.fulfill({ status: 202, contentType: "application/json", json: { sourceMessageId: route.request().postDataJSON().sourceMessageId, state: "completed", appliedCount: 0 } }));
  await page.addInitScript(() => {
    type Dispatch = (action: { type: string }) => void;
    let dispatch: Dispatch | undefined;
    window.__YUI_E2E_REALTIME_CLIENT__ = (nextDispatch: Dispatch) => {
      dispatch = nextDispatch;
      return { async start() { dispatch?.({ type: "connected" }); }, stop() { dispatch?.({ type: "stopped" }); }, usageContext() { return { sessionId: "integrated-call", startedAt: "2026-08-14T03:00:00.000Z", endedAt: "2026-08-14T03:01:00.000Z" }; } };
    };
  });
  await page.addInitScript((style) => {
    window.localStorage.setItem("yui.visual-style.v1", style);
  }, visualStyle);
  await page.goto("/");
  await page.getByLabel("あなたの名前").fill("大輝");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByRole("button", { name: "トークへ移動" })).toBeVisible();
  await page.getByRole("textbox", { name: "メッセージ" }).fill("色を確認する");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await expect(page.getByText("ユイの返事", { exact: true })).toBeVisible();
  sourceMessageId = (await page.locator(".chat-message.is-user").last().getAttribute("data-testid"))!.replace("message-", "");
}

async function computedBubble(page: Page, selector: string) {
  return page.locator(selector).last().evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, color: style.color, borderColor: style.borderColor, borderTopWidth: style.borderTopWidth };
  });
}

async function dispatchTouchSwipe(page: Page, selector: string, start: { x: number; y: number }, end: { x: number; y: number }, pointerId = 1): Promise<void> {
  await page.locator(selector).evaluate((node, gesture) => {
    for (const [type, point] of [["pointerdown", gesture.start], ["pointermove", gesture.end], ["pointerup", gesture.end]] as const) {
      node.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: gesture.pointerId, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y }));
    }
  }, { start, end, pointerId });
}

function expectNeutral(color: string): void {
  const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  expect(channels).toHaveLength(3);
  expect(Math.max(...channels!) - Math.min(...channels!)).toBeLessThanOrEqual(1);
}

test("resolves Light and Dark bubble tokens in the production Talk and Home DOM", async ({ page }) => {
  await openIntegratedApp(page);
  await setThemeSentinels(page);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const values = sentinels[scheme];
    await setResolvedThemeSentinels(page, values);
    expect(await computedBubble(page, ".chat-message.is-user .chat-message-bubble")).toMatchObject({ backgroundColor: values.ownerBg, color: values.ownerText, borderColor: values.ownerBorder, borderTopWidth: "1px" });
    expect(await computedBubble(page, ".chat-message.is-assistant .chat-message-bubble")).toMatchObject({ backgroundColor: values.assistantBg, color: values.speechText, borderColor: values.assistantBorder, borderTopWidth: "1px" });
    await page.getByRole("button", { name: "ホームへ移動" }).click();
    expect(await computedBubble(page, ".yui-speech-bubble")).toMatchObject({ backgroundColor: values.assistantBg, color: values.speechText, borderColor: values.assistantBorder, borderTopWidth: "1px" });
    await page.getByRole("button", { name: "トークへ移動" }).click();
  }
});

test("keeps the common shell while Default and Simple switch locally at 390x844", async ({ page }) => {
  await openIntegratedApp(page, "yui");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("html")).toHaveAttribute("data-yui-style", "yui");
  await expect(page.getByTestId("header-yui-prism")).toBeVisible();
  expect(await page.getByTestId("header-yui-prism").evaluate((element) => getComputedStyle(element).opacity)).toBe("0.9");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "メニューを開く" }).click();
  await page.getByRole("button", { name: "アプリ設定" }).click();
  await page.getByRole("radio", { name: "シンプル" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-yui-style", "minimal");
  expect(await page.getByTestId("header-yui-prism").evaluate((element) => getComputedStyle(element).opacity)).toBe("0.78");

  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--yui-canvas").trim())).toBe("#1D1D1D");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("keeps the shared desktop and mobile canvas continuous without restoring an outer frame", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await openIntegratedApp(page, "yui");

  const readShell = async (selector: string) => page.locator(selector).evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      borderLeftWidth: style.borderLeftWidth,
      borderRightWidth: style.borderRightWidth,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
    };
  });

  expect(await readShell(".chat-screen")).toMatchObject({
    left: 240,
    right: 960,
    width: 720,
    borderLeftWidth: "0px",
    borderRightWidth: "0px",
    boxShadow: "none",
    backgroundColor: "rgba(0, 0, 0, 0)",
  });
  expect(await page.locator("body").evaluate((element) => getComputedStyle(element).backgroundImage)).toContain("radial-gradient");

  for (const [label, selector] of [["ホームへ移動", ".integrated-page"], ["ニュースへ移動", ".integrated-page"]] as const) {
    await page.getByRole("button", { name: label }).click();
    expect(await readShell(selector)).toMatchObject({ left: 240, right: 960, width: 720, borderLeftWidth: "0px", borderRightWidth: "0px", boxShadow: "none", backgroundColor: "rgba(0, 0, 0, 0)" });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await readShell(".integrated-page")).toMatchObject({ left: 0, right: 390, width: 390, borderLeftWidth: "0px", borderRightWidth: "0px", boxShadow: "none" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("shows distinct send, focus, and selected navigation states", async ({ page }) => {
  await openIntegratedApp(page, "yui");
  await page.emulateMedia({ colorScheme: "dark" });

  const send = page.getByRole("button", { name: "メッセージを送信" });
  await expect(send).toBeDisabled();
  const disabledSurface = await send.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { background: style.background, borderColor: style.borderColor, opacity: getComputedStyle(element).opacity };
  });
  expect(disabledSurface.opacity).toBe("1");

  const composer = page.locator(".composer-shell");
  const borderBefore = await composer.evaluate((element) => getComputedStyle(element).borderColor);
  await page.getByRole("textbox", { name: "メッセージ" }).focus();
  const focused = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor, outlineWidth: style.outlineWidth, transform: style.transform, backgroundColor: style.backgroundColor };
  });
  expect(focused.borderColor).toBe(borderBefore);
  expect(focused.outlineWidth).toBe("3px");
  expect(focused.transform).not.toBe("none");
  const focusChannels = focused.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  expect(focusChannels).toHaveLength(3);
  expect(Math.max(...focusChannels!)).toBeLessThan(0.4);

  await page.getByRole("textbox", { name: "メッセージ" }).fill("送信状態を確認する");
  await expect(send).toBeEnabled();
  const enabledSurface = await send.evaluate((element) => getComputedStyle(element, "::before").backgroundImage);
  expect(enabledSurface).toContain("linear-gradient");
  expect(enabledSurface).not.toBe(disabledSurface.background);

  const current = page.getByRole("button", { name: "トークへ移動" });
  await expect(current).toHaveAttribute("aria-current", "page");
  expect(await current.evaluate((element) => getComputedStyle(element, "::after").content)).toBe("none");
  const rect = await current.boundingBox();
  expect(rect?.width).toBeGreaterThanOrEqual(44);
  expect(rect?.height).toBeGreaterThanOrEqual(44);
});

test("preserves focus and state boundaries in forced colors", async ({ page }, testInfo) => {
  await openIntegratedApp(page, "yui");
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });

  const composer = page.locator(".composer-shell");
  await page.getByRole("textbox", { name: "メッセージ" }).focus();
  const focus = await composer.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
  });
  expect(focus.outlineStyle).toBe("solid");
  expect(focus.outlineWidth).toBe("2px");
  expect(focus.outlineColor).not.toBe("rgba(0, 0, 0, 0)");

  const current = page.getByRole("button", { name: "トークへ移動" });
  await expect(current).toHaveAttribute("aria-current", "page");
  const currentRect = await current.boundingBox();
  expect(currentRect?.width).toBeGreaterThanOrEqual(44);
  expect(currentRect?.height).toBeGreaterThanOrEqual(44);

  const send = page.getByRole("button", { name: "メッセージを送信" });
  await expect(send).toBeDisabled();
  const disabled = await send.evaluate((element) => ({
    borderStyle: getComputedStyle(element, "::before").borderStyle,
    imageOpacity: getComputedStyle(element.querySelector("img")!).opacity,
  }));
  expect(disabled.borderStyle).toBe("solid");
  expect(Number(disabled.imageOpacity)).toBeLessThan(1);
  await page.getByRole("textbox", { name: "メッセージ" }).fill("高コントラスト送信");
  await expect(send).toBeEnabled();
  expect(Number(await send.locator("img").evaluate((element) => getComputedStyle(element).opacity))).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("forced-colors-focus-and-send.png") });
});

test("keeps the approved assistant contrast in the production DOM", async ({ page }) => {
  await openIntegratedApp(page);
  for (const [scheme, expected, ratio] of [
    ["light", { backgroundColor: "rgb(255, 255, 255)", color: "rgb(36, 36, 36)", borderColor: "rgb(233, 233, 232)", borderTopWidth: "1px" }, 15.52],
    ["dark", { backgroundColor: "rgb(39, 39, 39)", color: "rgb(247, 247, 246)", borderColor: "rgb(61, 61, 61)", borderTopWidth: "1px" }, 13.94],
  ] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const assistant = await computedBubble(page, ".chat-message.is-assistant .chat-message-bubble");
    expect(assistant).toEqual(expected);
    expect(contrast(assistant.color, assistant.backgroundColor)).toBeCloseTo(ratio, 1);
    await page.getByRole("button", { name: "ホームへ移動" }).click();
    expect((await computedBubble(page, ".yui-speech-bubble")).color).toBe(assistant.color);
    await page.getByRole("button", { name: "トークへ移動" }).click();
  }
});

test("keeps Dark navigation and composer actions visibly operable", async ({ page }) => {
  await openIntegratedApp(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("textbox", { name: "メッセージ" }).fill("送信可能状態");
  const values = await page.evaluate(() => {
    const read = (selector: string, pseudo?: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector} missing`);
      const style = getComputedStyle(element, pseudo);
      return { color: style.color, backgroundColor: style.backgroundColor, borderColor: style.borderBottomColor };
    };
    return {
      header: read(".header-action"),
      currentNav: read(".integrated-navigation-button.is-current"),
      attach: read(".attach-action"),
      send: read(".send-action", "::before"),
      sendGlyphOpacity: getComputedStyle(document.querySelector<HTMLImageElement>(".send-action img")!).opacity,
      canvas: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(contrast(values.header.color, values.canvas)).toBeGreaterThanOrEqual(3);
  expect(contrast(values.currentNav.color, values.canvas)).toBeGreaterThanOrEqual(3);
  expect(contrast(values.attach.color, values.canvas)).toBeGreaterThanOrEqual(3);
  expect(contrast(values.send.backgroundColor, values.canvas)).toBeGreaterThanOrEqual(3);
  expect(values.sendGlyphOpacity).toBe("1");
});

test("renders source-linked search evidence without overflow at 390x844 in Light and Dark", async ({ page }) => {
  await openIntegratedApp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("textbox", { name: "メッセージ" }).fill("最新の公式情報を検索して");
  await page.getByRole("button", { name: "メッセージを送信" }).click();

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.getByText("事実", { exact: true })).toBeVisible();
    await expect(page.getByText("考えられること", { exact: true })).toBeVisible();
    await expect(page.getByText("ユイからの提案", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "公式発表" })).toHaveAttribute("href", "https://example.com/official");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test("records the integrated shell states used for prototype visual review", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await openIntegratedApp(page, "yui");
  await page.setViewportSize({ width: 390, height: 844 });

  const capture = async (name: string) => {
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      if (name === "talk") {
        const fixedShell = await page.evaluate(() => {
          const header = document.querySelector<HTMLElement>(".chat-header");
          const navigation = document.querySelector<HTMLElement>(".chat-bottom-stack .integrated-navigation");
          if (!header || !navigation) return null;
          const headerRect = header.getBoundingClientRect();
          const navigationRect = navigation.getBoundingClientRect();
          return { headerTop: headerRect.top, headerHeight: headerRect.height, navigationBottom: navigationRect.bottom, navigationHeight: navigationRect.height };
        });
        expect(fixedShell).not.toBeNull();
        expect(fixedShell!.headerTop).toBe(0);
        expect(fixedShell!.headerHeight).toBeGreaterThanOrEqual(68);
        expect(fixedShell!.navigationHeight).toBeGreaterThanOrEqual(44);
        expect(fixedShell!.navigationBottom).toBeCloseTo(844, 0);
      }
      await page.screenshot({ path: testInfo.outputPath(`${name}-${colorScheme}-390x844.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  };

  await capture("talk");
  await page.getByRole("textbox", { name: "メッセージ" }).fill("送信可能状態");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("talk-default-dark-enabled-390x844.png") });
  await page.getByRole("textbox", { name: "メッセージ" }).fill("");
  await page.getByRole("button", { name: "ホームへ移動" }).click();
  await capture("home");
  await page.getByRole("button", { name: "ニュースへ移動" }).click();
  await capture("news");
  await page.getByRole("button", { name: "トークへ移動" }).click();
  await page.getByRole("button", { name: "メニューを開く" }).click();
  await page.getByRole("button", { name: "アプリ設定" }).click();
  await capture("settings");
  await page.getByRole("radio", { name: "シンプル" }).check();
  await capture("settings-simple");
  await page.getByRole("button", { name: "チャットに戻る" }).click();
  await capture("talk-simple");
  await page.getByRole("button", { name: "メニューを開く" }).click();
  await page.getByRole("button", { name: "アプリ設定" }).click();
  await page.getByRole("radio", { name: "デフォルト" }).check();
  await page.getByRole("button", { name: "チャットに戻る" }).click();
  await page.setViewportSize({ width: 1428, height: 1230 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("talk-default-dark-1428x1230.png") });
  expect(consoleErrors).toEqual([]);
});

test("uses graphite interaction effects and retains integrated Talk behavior", async ({ page }) => {
  await openIntegratedApp(page);
  await page.getByRole("textbox", { name: "メッセージ" }).fill("残る下書き");
  await page.getByRole("button", { name: "ホームへ移動" }).click();
  await page.getByRole("button", { name: "トークへ移動" }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue("残る下書き");
  await page.getByRole("button", { name: "メニューを開く" }).click();
  await page.getByRole("button", { name: "アプリ設定" }).click();
  await page.getByRole("button", { name: "トーク履歴を検索" }).click();
  await expect(page.getByRole("searchbox", { name: "チャット履歴を検索" })).toBeVisible();
  await page.getByRole("searchbox", { name: "チャット履歴を検索" }).fill("色を確認する");
  await expect(page.locator(".chat-message.is-search-match")).toHaveCount(1);
  expectNeutral(await page.locator(".chat-message.is-search-match .chat-message-bubble").evaluate((element) => getComputedStyle(element).outlineColor));
  const searchClose = page.getByRole("button", { name: "検索を閉じる" });
  await searchClose.hover();
  expectNeutral(await searchClose.evaluate((element) => getComputedStyle(element).backgroundColor));
  await searchClose.click();
  const menuAction = page.getByRole("button", { name: "メニューを開く" });
  await menuAction.hover();
  expectNeutral(await menuAction.evaluate((element) => getComputedStyle(element).backgroundColor));
  await page.getByRole("button", { name: "ユイに電話" }).click();
  await expect(page.getByRole("button", { name: "今日はここまで" })).toBeVisible();
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  await page.getByRole("button", { name: "メニューを開く" }).click();
  await page.getByRole("button", { name: "アプリ設定" }).click();
  await page.getByRole("button", { name: "覚えたことを開く" }).click();
  await page.getByRole("button", { name: "元の会話を見る" }).click();
  await expect(page.locator(".chat-message.is-user").last()).toBeFocused();
  await page.getByRole("textbox", { name: "メッセージ" }).fill("Web検索して");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await expect(page.getByRole("link", { name: "公式発表" })).toHaveAttribute("href", "https://example.com/official");
  await page.setViewportSize({ width: 320, height: 500 });
  await page.getByRole("textbox", { name: "メッセージ" }).fill("長い会話 " + "会話が続きます。".repeat(40));
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await expect(page.getByRole("status", { name: "ユイが入力中" })).toHaveCount(0);
  await page.locator(".chat-scroll-area").evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  const latest = page.getByRole("button", { name: "最新のメッセージへ移動" });
  await expect(latest).toBeVisible();
  const latestCenters = await latest.evaluate((element) => {
    const button = element.getBoundingClientRect();
    const icon = element.querySelector("svg")!.getBoundingClientRect();
    return { x: Math.abs((button.left + button.width / 2) - (icon.left + icon.width / 2)), y: Math.abs((button.top + button.height / 2) - (icon.top + icon.height / 2)) };
  });
  expect(latestCenters.x).toBeLessThanOrEqual(1);
  expect(latestCenters.y).toBeLessThanOrEqual(1.5);
  await latest.hover();
  expectNeutral(await latest.evaluate((element) => getComputedStyle(element).backgroundColor));
  const literals = ["#" + "285A8E", "#" + "A9CCFF", "#" + "1F4A75", "rgb(" + "169 204 255 / 28%)"];
  const stylesheet = readFileSync("apps/web/src/styles.css", "utf8").toUpperCase();
  for (const literal of literals) expect(stylesheet).not.toContain(literal.toUpperCase());
});

test("cycles Talk, Home, and News with pointer swipes while vertical movement and the Talk draft stay safe", async ({ page }) => {
  await openIntegratedApp(page);
  const composer = page.getByRole("textbox", { name: "メッセージ" });
  await composer.fill("スワイプ後も残る下書き");
  await composer.focus();

  await dispatchTouchSwipe(page, ".chat-screen", { x: 300, y: 200 }, { x: 120, y: 205 });
  await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
  await dispatchTouchSwipe(page, ".home-screen", { x: 260, y: 130 }, { x: 220, y: 350 });
  await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
  await dispatchTouchSwipe(page, ".home-screen", { x: 300, y: 200 }, { x: 120, y: 202 });
  await expect(page.getByRole("heading", { name: "ニュース" })).toBeVisible();
  await dispatchTouchSwipe(page, ".news-screen", { x: 300, y: 200 }, { x: 120, y: 202 });
  await expect(composer).toHaveValue("スワイプ後も残る下書き");
  await expect(composer).toBeFocused();

  await dispatchTouchSwipe(page, ".chat-screen", { x: 120, y: 200 }, { x: 300, y: 202 });
  await expect(page.getByRole("heading", { name: "ニュース" })).toBeVisible();
  await page.getByRole("button", { name: "トークへ移動" }).click();
  await page.locator(".chat-screen").evaluate((node) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 300, clientY: 180 }));
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "touch", isPrimary: false, clientX: 260, clientY: 180 }));
    node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 120, clientY: 180 }));
  });
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
});

test("keeps an image News row to three columns without mobile horizontal overflow", async ({ page }) => {
  await openIntegratedApp(page);
  await page.getByRole("button", { name: "ニュースへ移動" }).click();
  const layout = await page.locator(".news-screen").evaluate((screen) => {
    const list = document.createElement("ul");
    list.className = "news-list";
    const row = document.createElement("li");
    row.className = "news-row has-image";
    row.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""><div><a href="https://example.com/image">画像付き記事</a><p>公式</p></div><button type="button" aria-label="画像付き記事についてユイに話す">話す</button>';
    list.append(row);
    screen.append(list);
    const [image, text, action] = [...row.children].map((child) => child.getBoundingClientRect());
    return { imageRight: image.right, textLeft: text.left, textRight: text.right, actionLeft: action.left, actionWidth: action.width, screenWidth: screen.getBoundingClientRect().width, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  });
  expect(layout.imageRight).toBeLessThanOrEqual(layout.textLeft);
  expect(layout.textRight).toBeLessThanOrEqual(layout.actionLeft);
  expect(layout.actionWidth).toBeGreaterThanOrEqual(44);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test("wraps long Home management actions and disconnect details inside 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openIntegratedApp(page);
  await page.getByRole("button", { name: "ホームへ移動" }).click();
  await page.getByRole("button", { name: "ホームを編集" }).click();
  const geometry = await page.locator(".management-screen").evaluate((screen) => {
    const list = screen.querySelector(".management-list");
    if (!list) throw new Error("management list missing");
    list.innerHTML = `
      <li class="management-row" data-layout="weather">
        <div class="management-row-main"><span>とても長い地域名を含む天気ウィジェット表示名</span></div>
        <div class="management-row-actions">
          <button type="button" aria-label="上へ移動">↑</button><button type="button" aria-label="下へ移動">↓</button>
          <button type="button">とても長い天気の地域名を設定</button><button class="management-switch-control" type="button" role="switch"><span class="management-switch-track"></span></button>
        </div>
      </li>
      <li class="management-row" data-layout="disconnect">
        <div class="management-row-main"><strong>とても長い接続サービス表示名</strong></div>
        <div class="management-row-actions"><button type="button" aria-label="その他の操作">…</button></div>
        <div class="management-disconnect-menu"><p>取得を止め、対象キャッシュを削除します。再接続してもホーム表示は戻りません</p><button type="button">とても長い接続サービス表示名の接続を解除</button></div>
      </li>`;
    const measure = (selector: string) => {
      const element = screen.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`${selector} missing`);
      return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    return {
      screen: { clientWidth: (screen as HTMLElement).clientWidth, scrollWidth: (screen as HTMLElement).scrollWidth },
      weather: measure('[data-layout="weather"]'),
      weatherActions: measure('[data-layout="weather"] .management-row-actions'),
      disconnect: measure('[data-layout="disconnect"]'),
      disconnectMenu: measure(".management-disconnect-menu"),
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  });
  for (const value of [geometry.screen, geometry.weather, geometry.weatherActions, geometry.disconnect, geometry.disconnectMenu]) {
    expect(value.scrollWidth).toBeLessThanOrEqual(value.clientWidth);
  }
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
});

test("contains appearance-dialog focus and restores the trigger after Escape", async ({ page }) => {
  await openIntegratedApp(page);
  const trigger = page.getByRole("button", { name: "ユイの姿を選ぶ" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "ユイの姿を選ぶ" });
  const choose = dialog.getByRole("button", { name: "この姿を選ぶ" });
  const close = dialog.getByRole("button", { name: "閉じる" });
  await expect(choose).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(choose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("selects the provisional appearance locally without persisting or trapping Close", async ({ page }) => {
  await openIntegratedApp(page);
  const trigger = page.getByRole("button", { name: "ユイの姿を選ぶ" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "ユイの姿を選ぶ" });
  const choose = dialog.getByRole("button", { name: "この姿を選ぶ" });
  await expect(choose).toHaveAttribute("aria-pressed", "false");
  await choose.click();
  await expect(dialog.getByRole("button", { name: "暫定SD候補を選択中" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "閉じる" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("resolves the provisional appearance candidate to the defined neutral surface", async ({ page }) => {
  await openIntegratedApp(page);
  await page.getByRole("button", { name: "ユイの姿を選ぶ" }).click();
  await expect(page.locator(".appearance-candidate")).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

for (const target of [
  { name: "320×700", viewport: { width: 320, height: 700 } },
  { name: "390×844", viewport: { width: 390, height: 844 } },
  { name: "iPhone 17", viewport: devices["iPhone 17"].viewport, device: devices["iPhone 17"] },
] as const) {
  test(`keeps the real integrated layout inside ${target.name}`, async ({ browser }) => {
    const context = await browser.newContext({ ...(target.device ?? { viewport: target.viewport }), serviceWorkers: "block" });
    const page = await context.newPage();
    await openIntegratedApp(page);
    for (let index = 0; index < 5; index += 1) {
      await page.getByRole("textbox", { name: "メッセージ" }).fill(`スクロール確認 ${index} ${"会話が続きます。".repeat(24)}`);
      await page.getByRole("button", { name: "メッセージを送信" }).click();
      await expect(page.locator(".chat-message.is-user")).toHaveCount(index + 2);
      await expect(page.getByRole("status", { name: "ユイが入力中" })).toHaveCount(0);
    }
    const geometry = await page.locator(".chat-scroll-area").evaluate((area) => {
      const nav = document.querySelector<HTMLElement>(".integrated-navigation");
      const header = document.querySelector<HTMLElement>(".chat-header");
      const composer = document.querySelector<HTMLElement>(".chat-composer");
      const messages = document.querySelectorAll<HTMLElement>(".chat-message");
      const message = messages.item(messages.length - 1);
      if (!nav || !header || !composer || !message) throw new Error("integrated layout missing");
      const targets = [...nav.querySelectorAll<HTMLElement>("button")].map((button) => { const rect = button.getBoundingClientRect(); return { width: rect.width, height: rect.height, current: button.getAttribute("aria-current"), marker: getComputedStyle(button, "::after").content }; });
      const headerTopBeforeScroll = header.getBoundingClientRect().top;
      const navTopBeforeScroll = nav.getBoundingClientRect().top;
      area.scrollTop = area.scrollHeight;
      return { navInHistory: area.contains(nav), composerInHistory: area.contains(composer), headerInHistory: area.contains(header), headerTopBeforeScroll, headerTopAfterScroll: header.getBoundingClientRect().top, navTopBeforeScroll, navTopAfterScroll: nav.getBoundingClientRect().top, targets, finalBottom: message.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top, navTop: nav.getBoundingClientRect().top, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    expect(geometry.headerInHistory).toBe(false);
    expect(geometry.composerInHistory).toBe(false);
    expect(geometry.navInHistory).toBe(false);
    expect(geometry.headerTopAfterScroll).toBe(geometry.headerTopBeforeScroll);
    expect(geometry.navTopAfterScroll).toBe(geometry.navTopBeforeScroll);
    for (const nav of geometry.targets) { expect(nav.width).toBeGreaterThanOrEqual(44); expect(nav.height).toBeGreaterThanOrEqual(44); }
    expect(geometry.targets[0]).toMatchObject({ current: "page", marker: "none" });
    expect(geometry.finalBottom).toBeLessThanOrEqual(geometry.composerTop - 8);
    expect(geometry.composerTop).toBeLessThan(geometry.navTop);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await page.getByRole("button", { name: "ホームへ移動" }).click();
    await expect(page.locator(".chat-header")).toBeVisible();
    await expect(page.locator(".yui-portrait")).toBeVisible();
    const homeGeometry = await page.locator(".home-screen").evaluate((screen) => {
      const scroller = screen.querySelector<HTMLElement>(".integrated-page-scroll");
      const nav = screen.querySelector<HTMLElement>(".integrated-navigation");
      const header = screen.querySelector<HTMLElement>(".chat-header");
      if (!scroller || !nav || !header) throw new Error("fixed Home shell missing");
      const before = { header: header.getBoundingClientRect().top, nav: nav.getBoundingClientRect().top };
      scroller.scrollTop = scroller.scrollHeight;
      return { headerInScroller: scroller.contains(header), navInScroller: scroller.contains(nav), before, after: { header: header.getBoundingClientRect().top, nav: nav.getBoundingClientRect().top }, documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    expect(homeGeometry.headerInScroller).toBe(false);
    expect(homeGeometry.navInScroller).toBe(false);
    expect(homeGeometry.after).toEqual(homeGeometry.before);
    expect(homeGeometry.documentWidth).toBeLessThanOrEqual(homeGeometry.viewportWidth);
    await expect.poll(() => page.locator(".yui-portrait").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await context.close();
  });
}

test("uses keyboard nav focus without stealing Talk composer focus", async ({ page }) => {
  await openIntegratedApp(page);
  const talk = page.getByRole("button", { name: "トークへ移動" });
  await talk.focus();
  await talk.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "ホーム" })).toBeVisible();
  await expect(page.getByRole("button", { name: "ホームへ移動" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "ホームへ移動" })).toBeFocused();
  await page.getByRole("button", { name: "ホームへ移動" }).press("ArrowLeft");
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  await expect(talk).toHaveAttribute("aria-current", "page");
  await expect(talk).toBeFocused();
  await page.getByRole("button", { name: "ホームへ移動" }).click();
  await page.getByRole("button", { name: "トークへ移動" }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeFocused();
});
