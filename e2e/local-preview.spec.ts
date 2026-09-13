import { test, expect } from "playwright/test";
for (const width of [320, 390, 1280]) {
  test(`character first preview preserves conversation and voice choice at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const apiRequests: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
    await page.goto("/");
    await page.getByRole("textbox").fill("表示確認");
    await page.getByRole("button", { name: "はじめる", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "メッセージ", exact: true });
    await expect(composer).toBeEnabled();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "坂本アヒルさんのずんだもん" })).toBeVisible();
    const voice = page.getByRole("button", { name: "音声OFF", exact: true });
    await expect(voice).toHaveAttribute("aria-pressed", "false");
    await voice.click();
    await expect(page.getByRole("button", { name: "音声ON", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("音声はまだ未接続です", { exact: true })).toBeVisible();
    await composer.fill("今日の話をしてみよう");
    await page.getByRole("button", { name: "メッセージを送信", exact: true }).click();
    await expect(page.getByText(/表示確認用の定型文・AI未接続/).first()).toBeVisible({ timeout: 20000 });
    await composer.fill("切り替え中の下書き");
    await page.getByRole("button", { name: "姿を隠す", exact: true }).click();
    await expect(composer).toHaveValue("切り替え中の下書き");
    await page.getByRole("button", { name: "姿を表示", exact: true }).click();
    await expect(composer).toHaveValue("切り替え中の下書き");
    await expect(page.getByText("今日の話をしてみよう", { exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "音声ON", exact: true }).click();
    await page.screenshot({ path: `test-results/local-preview/character-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(composer).toHaveValue("切り替え中の下書き");
    await expect(page.getByRole("button", { name: "音声OFF", exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: "坂本アヒルさんのずんだもん" })).toBeVisible();
    expect(apiRequests).toEqual([]);
  });
}
