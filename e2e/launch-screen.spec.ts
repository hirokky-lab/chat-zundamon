import { expect, test } from "playwright/test";

const viewports = [
  { width: 390, height: 844 },
  { width: 320, height: 700 },
] as const;

test("renders the approved launch frame before app readiness and releases it with opacity only", async ({ browser }) => {
  for (const viewport of viewports) {
    for (const reducedMotion of ["no-preference", "reduce"] as const) {
      const context = await browser.newContext({ viewport, colorScheme: reducedMotion === "reduce" ? "dark" : "light", reducedMotion });
      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(window.indexedDB, "open", { configurable: true, value: () => ({}) });
      });
      await page.goto("/");
      const geometry = await page.locator("[data-testid=launch-screen]").evaluate((node) => {
        const launch = node as HTMLElement;
        const logo = launch.querySelector<HTMLImageElement>(".splash-logo")!;
        const wordmark = launch.querySelector<HTMLElement>(".splash-wordmark")!;
        const style = getComputedStyle(launch);
        const wordmarkStyle = getComputedStyle(wordmark);
        return {
          opacity: style.opacity,
          background: style.backgroundColor,
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
          logoWidth: logo.getBoundingClientRect().width,
          logoRadius: getComputedStyle(logo).borderRadius,
          wordmarkSize: wordmarkStyle.fontSize,
          wordmarkSpacing: wordmarkStyle.letterSpacing,
          wordmarkBottom: wordmarkStyle.bottom,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      });
      expect(geometry).toEqual(expect.objectContaining({
        opacity: "1",
        background: "rgb(254, 254, 253)",
        transitionProperty: "opacity",
        transitionDuration: reducedMotion === "reduce" ? "0.08s" : "0.24s",
        logoRadius: "0px",
        wordmarkSize: "20px",
        wordmarkSpacing: "4.8px",
        wordmarkBottom: "46px",
        documentWidth: viewport.width,
        viewportWidth: viewport.width,
      }));
      expect(geometry.logoWidth).toBeGreaterThan(0);
      await context.close();
    }
  }
});
