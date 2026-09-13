import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Preserve the approved artwork: fit two complete rows without stretching pods.
// Keep originals for future exports; these square assets are lossless PNGs.
const backgrounds = new URL("../apps/web/public/backgrounds/", import.meta.url);
const originals = [
  ["edamame-day-v5", "edamame-day-square-v1"],
  ["edamame-night-v1", "edamame-night-square-v1"],
  ...["pink", "lavender", "sky", "milktea"].flatMap(color =>
    ["day", "night"].map(tone => [`edamame-${color}-${tone}-v1`, `edamame-${color}-${tone}-square-v1`])),
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  for (const [source, destination] of originals) {
    const bytes = await readFile(new URL(`${source}.png`, backgrounds));
    const result = await page.evaluate(async src => {
      const image = new Image(); image.src = src; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2048;
      const context = canvas.getContext("2d");
      const sample = document.createElement("canvas"); sample.width = sample.height = 8;
      const sampleContext = sample.getContext("2d"); sampleContext.drawImage(image, 0, 0);
      const pixels = sampleContext.getImageData(0, 0, 8, 8).data;
      const rgb = [0, 1, 2].map(channel => {
        let sum = 0; for (let i = channel; i < pixels.length; i += 4) sum += pixels[i];
        return Math.round(sum / 64);
      });
      context.fillStyle = `rgb(${rgb.join(" ")})`; context.fillRect(0, 0, 2048, 2048);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
      const height = 1024, width = image.naturalWidth * height / image.naturalHeight;
      if (width > 2048) throw new Error("Source is too wide for two complete rows");
      for (const top of [0, 1024]) context.drawImage(image, (2048 - width) / 2, top, width, height);
      return canvas.toDataURL("image/png").split(",")[1];
    }, `data:image/png;base64,${bytes.toString("base64")}`);
    const output = Buffer.from(result, "base64");
    if (output.readUInt32BE(16) !== 2048 || output.readUInt32BE(20) !== 2048) throw new Error("Wrong export dimensions");
    const destinationUrl = new URL(`${destination}.png`, backgrounds);
    await writeFile(destinationUrl, output);
    console.log(`${fileURLToPath(destinationUrl)}: 2048 x 2048`);
  }
} finally { await browser.close(); }
