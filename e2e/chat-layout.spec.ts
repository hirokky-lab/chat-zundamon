import { readFileSync } from "node:fs";
import { devices, expect, test, type Browser, type Page } from "playwright/test";

const chatStyles = readFileSync("apps/web/src/styles.css", "utf8");
const messages = Array.from(
  { length: 24 },
  (_, index) => `<li class="chat-message ${index % 2 === 0 ? "is-assistant" : "is-user"}" data-message-index="${index}">
    <div class="chat-message-row"><p>${index}: ${"長い会話です。".repeat(8)}</p></div>
  </li>`,
).join("");

const layoutTargets = [
  { name: "320x700", viewport: { width: 320, height: 700 } },
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "iPhone 17 preset", viewport: devices["iPhone 17"].viewport, device: devices["iPhone 17"] },
] as const;

function chatMarkup({ searchOpen = false } = {}) {
  return `
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${chatStyles}</style>
    <script>document.documentElement.dataset.yuiStyle = "minimal";</script>
    <main class="chat-screen" data-integrated-ui="false">
      <header class="chat-header">
        <div class="chat-header-bar">
          <button class="header-action" type="button" aria-label="設定を開く">設定</button>
          <h1>YUI</h1>
          <div class="header-actions">
            <button class="header-action" type="button" aria-label="履歴を検索">検索</button>
            <button class="call-action" type="button" aria-label="ユイに電話する">電話</button>
          </div>
        </div>
        <div class="chat-search-slot">
          ${searchOpen ? `<section class="chat-search" aria-label="履歴検索">
            <input aria-label="履歴を検索" value="ユイ">
            <output>1 / 12</output>
            <button type="button">前へ</button>
            <button type="button">次へ</button>
            <button type="button" aria-label="検索を閉じる">閉じる</button>
          </section>` : ""}
        </div>
      </header>
      <div class="chat-history-shell">
        <section class="chat-scroll-area">
          <ol class="chat-timeline">${messages}<li class="chat-end-sentinel" aria-hidden="true"></li></ol>
        </section>
        <button type="button" class="latest-chat-action" aria-label="最新のメッセージへ移動">↓</button>
      </div>
      <div class="chat-bottom-stack">
        <form class="chat-composer">
          <div class="composer-shell" data-empty="true">
            <textarea aria-label="メッセージ" placeholder="メッセージ" rows="1" style="height: 32px"></textarea>
            <div class="composer-actions-row">
              <button class="attach-action" type="button" aria-label="追加機能は現在利用できません" disabled>＋</button>
              <div class="composer-actions">
                <button class="microphone-action" type="button" aria-label="音声入力を開始">音声</button>
                <button class="send-action" type="submit" aria-label="メッセージを送信">↑</button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </main>`;
}

async function newLayoutPage(browser: Browser, target: (typeof layoutTargets)[number]): Promise<Page> {
  const context = await browser.newContext(target.device ?? { viewport: target.viewport });
  const page = await context.newPage();
  await page.setContent(chatMarkup());
  await syncOverlayInsets(page);
  return page;
}

async function syncOverlayInsets(page: Page): Promise<void> {
  await page.locator(".chat-screen").evaluate((screen) => {
    const header = screen.querySelector<HTMLElement>(".chat-header");
    const composer = screen.querySelector<HTMLElement>(".chat-composer");
    if (!header || !composer) throw new Error("chat overlays missing");
    screen.style.setProperty("--chat-header-height", `${header.getBoundingClientRect().height}px`);
    screen.style.setProperty("--chat-composer-height", `${composer.getBoundingClientRect().height}px`);
  });
}

test.describe("YUI floating mobile chat layout", () => {
  for (const target of layoutTargets) {
    test(`keeps floating controls clear and messages readable at ${target.name}`, async ({ browser }) => {
      const page = await newLayoutPage(browser, target);
      const viewport = page.viewportSize()!;
      const textarea = page.getByRole("textbox", { name: "メッセージ" });
      const oneLineHeight = (await textarea.boundingBox())!.height;
      await textarea.fill("あ");
      const oneCharacterHeight = (await textarea.boundingBox())!.height;
      await textarea.fill("一行目\n二行目");
      await textarea.evaluate((element) => {
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
      });
      await syncOverlayInsets(page);

      const composerShellBox = await page.locator(".composer-shell").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
      });
      const textareaTwoLineHeight = (await textarea.boundingBox())!.height;
      const latestButtonBox = await page.getByRole("button", { name: "最新のメッセージへ移動" }).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
      });
      expect(composerShellBox.left).toBeGreaterThanOrEqual(14);
      expect(viewport.width - composerShellBox.right).toBeGreaterThanOrEqual(14);
      expect(viewport.height - composerShellBox.bottom).toBeGreaterThanOrEqual(18);
      expect(oneCharacterHeight).toBeCloseTo(oneLineHeight, 4);
      expect(oneLineHeight).toBeLessThan(textareaTwoLineHeight);
      expect(latestButtonBox.width).toBeGreaterThanOrEqual(44);
      expect(latestButtonBox.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(latestButtonBox.left + latestButtonBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
      // The focused composer lifts by one CSS pixel; retain at least seven visible pixels.
      expect(composerShellBox.top - latestButtonBox.bottom).toBeGreaterThanOrEqual(7);

      const actionInsets = await page.locator(".composer-shell").evaluate((shell) => {
        const shellRect = shell.getBoundingClientRect();
        const microphone = shell.querySelector<HTMLElement>(".microphone-action");
        const send = shell.querySelector<HTMLElement>(".send-action");
        const composerLayer = document.querySelector<HTMLElement>(".chat-composer");
        if (!microphone || !send || !composerLayer) throw new Error("composer action fixture missing");
        const microphoneRect = microphone.getBoundingClientRect();
        const sendRect = send.getBoundingClientRect();
        const shellStyle = getComputedStyle(shell);
        const sendVisualStyle = getComputedStyle(send, "::before");
        return {
          right: shellRect.right - sendRect.right,
          bottom: shellRect.bottom - Math.max(microphoneRect.bottom, sendRect.bottom),
          rightRadius: shellRect.right - (sendRect.left + sendRect.width / 2),
          bottomRadius: shellRect.bottom - (sendRect.top + sendRect.height / 2),
          shellRadius: Number.parseFloat(shellStyle.borderRadius),
          microphoneWidth: microphoneRect.width,
          microphoneHeight: microphoneRect.height,
          sendWidth: sendRect.width,
          sendHeight: sendRect.height,
          sendVisualWidth: Number.parseFloat(sendVisualStyle.width),
          sendVisualHeight: Number.parseFloat(sendVisualStyle.height),
          sendVisualRadius: Number.parseFloat(sendVisualStyle.borderRadius),
          backdropFilter: shellStyle.backdropFilter,
          layerBackground: getComputedStyle(composerLayer).backgroundColor,
        };
      });
      expect(actionInsets.right).toBeCloseTo(6, 1);
      expect(actionInsets.bottom).toBeCloseTo(6, 1);
      expect(actionInsets.rightRadius).toBeCloseTo(28, 1);
      expect(actionInsets.bottomRadius).toBeCloseTo(28, 1);
      expect(actionInsets.shellRadius).toBe(28);
      expect(actionInsets.microphoneWidth).toBeGreaterThanOrEqual(44);
      expect(actionInsets.microphoneHeight).toBeGreaterThanOrEqual(44);
      expect(actionInsets.sendWidth).toBe(44);
      expect(actionInsets.sendHeight).toBe(44);
      expect(actionInsets.sendVisualWidth).toBe(36);
      expect(actionInsets.sendVisualHeight).toBe(36);
      expect(actionInsets.sendVisualRadius).toBe(18);
      expect(actionInsets.backdropFilter).toContain("blur(18px)");
      expect(actionInsets.layerBackground).toBe("rgba(0, 0, 0, 0)");

      const scrollGeometry = await page.locator(".chat-scroll-area").evaluate((scrollArea) => {
        const header = document.querySelector<HTMLElement>(".chat-header");
        const composer = document.querySelector<HTMLElement>(".chat-composer");
        const first = scrollArea.querySelector<HTMLElement>("[data-message-index='0']");
        const underHeader = scrollArea.querySelector<HTMLElement>("[data-message-index='10']");
        const underComposer = scrollArea.querySelector<HTMLElement>("[data-message-index='14']");
        const last = scrollArea.querySelector<HTMLElement>("[data-message-index='23']");
        if (!header || !composer || !first || !underHeader || !underComposer || !last) {
          throw new Error("chat geometry fixture missing");
        }
        const headerRect = header.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();

        scrollArea.scrollTop = underHeader.offsetTop - headerRect.bottom + underHeader.offsetHeight / 2;
        const headerMessageRect = underHeader.getBoundingClientRect();
        const headerIntersection = headerMessageRect.top < headerRect.bottom && headerMessageRect.bottom > headerRect.top;

        scrollArea.scrollTop = underComposer.offsetTop - composerRect.top + underComposer.offsetHeight / 2;
        const composerMessageRect = underComposer.getBoundingClientRect();
        const composerIntersection = composerMessageRect.top < composerRect.bottom && composerMessageRect.bottom > composerRect.top;

        scrollArea.scrollTop = 0;
        const firstRect = first.getBoundingClientRect();
        scrollArea.scrollTop = scrollArea.scrollHeight;
        const lastRect = last.getBoundingClientRect();
        return {
          headerIntersection,
          composerIntersection,
          firstTop: firstRect.top,
          headerBottom: headerRect.bottom,
          lastBottom: lastRect.bottom,
          composerTop: composerRect.top,
          scrollDistance: scrollArea.scrollHeight - scrollArea.clientHeight,
          documentWidth: document.documentElement.scrollWidth,
        };
      });

      expect(scrollGeometry.headerIntersection).toBe(true);
      expect(scrollGeometry.composerIntersection).toBe(true);
      expect(scrollGeometry.firstTop).toBeGreaterThanOrEqual(scrollGeometry.headerBottom + 8);
      expect(scrollGeometry.lastBottom).toBeLessThanOrEqual(scrollGeometry.composerTop - 8);
      expect(scrollGeometry.scrollDistance).toBeGreaterThan(96);
      expect(scrollGeometry.documentWidth).toBeLessThanOrEqual(viewport.width);

      const composerLayerStyle = await page.locator(".chat-composer").evaluate((element) => {
        const style = getComputedStyle(element);
        const before = getComputedStyle(element, "::before");
        return { backgroundImage: style.backgroundImage, beforeContent: before.content };
      });
      expect(composerLayerStyle.backgroundImage).toBe("none");
      expect(["none", "normal", ""]).toContain(composerLayerStyle.beforeContent);
      await page.context().close();
    });

    test(`keeps ${target.name} search controls reachable without document overflow`, async ({ browser }) => {
      const context = await browser.newContext(target.device ?? { viewport: target.viewport });
      const page = await context.newPage();
      await page.setContent(chatMarkup({ searchOpen: true }));
      await syncOverlayInsets(page);

      const search = page.getByRole("region", { name: "履歴検索" });
      const actions = search.getByRole("button");
      await expect(actions).toHaveCount(3);
      for (let index = 0; index < 3; index += 1) {
        const box = await actions.nth(index).boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      const bounds = await search.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          innerWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.innerWidth);
      expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.innerWidth);
      await context.close();
    });
  }

  test("uses the approved Minimal focus indicators while preserving the composer's surface elevation", async ({ page }) => {
    await page.setContent(`${chatMarkup({ searchOpen: true })}
      <main class="profile-settings">
        <form class="settings-content" aria-label="設定fixture">
          <label>あなたの名前<input aria-label="あなたの名前" value="大輝"></label>
        </form>
      </main>
      <label>記憶を選択<input type="checkbox" aria-label="記憶を選択"></label>`);

    const focusStyle = async (locator: ReturnType<Page["locator"]>) => {
      await locator.focus();
      return locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          borderColor: style.borderColor,
          outlineWidth: style.outlineWidth,
          boxShadow: style.boxShadow,
        };
      });
    };

    const composer = page.getByRole("textbox", { name: "メッセージ" });
    const restingShellShadow = await page.locator(".composer-shell").evaluate((element) => getComputedStyle(element).boxShadow);
    const composerStyle = await focusStyle(composer);
    const composerShellStyle = await page.locator(".composer-shell").evaluate((element) => {
      const style = getComputedStyle(element);
      return { borderColor: style.borderColor, boxShadow: style.boxShadow, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
    });
    expect(composerStyle.outlineWidth).toBe("0px");
    expect(composerStyle.boxShadow).toBe("none");
    expect(composerShellStyle.borderColor).toBe("rgb(229, 229, 227)");
    expect(composerShellStyle.outlineWidth).toBe("3px");
    expect(composerShellStyle.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(restingShellShadow).not.toBe("none");
    expect(composerShellStyle.boxShadow).not.toBe("none");

    for (const field of [
      page.getByRole("textbox", { name: "履歴を検索" }),
      page.getByRole("textbox", { name: "あなたの名前" }),
    ]) {
      const style = await focusStyle(field);
      expect(style.outlineWidth).toBe("0px");
      expect(style.boxShadow).toBe("none");
      expect(style.borderColor).toBe("rgb(59, 59, 59)");
    }

    const checkbox = page.getByRole("checkbox", { name: "記憶を選択" });
    await checkbox.focus();
    expect(await checkbox.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe("3px");
  });
});
