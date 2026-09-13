// @vitest-environment node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import { browserPhotoPreparationDeps, PHOTO_INPUT_MAX_BYTES, PHOTO_OUTPUT_MAX_BYTES, preparePhoto, type PhotoPreparationDeps } from "../src/photo-preparation";

const jpegBytes = (size = 100) => {
  const header = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01,
    0xff, 0xda, 0x00, 0x02,
  ]);
  const entropy = new Uint8Array(Math.max(1, size - header.length - 2)).fill(1);
  const bytes = new Uint8Array(header.length + entropy.length + 2);
  bytes.set(header);
  bytes.set(entropy, header.length);
  bytes.set([0xff, 0xd9], header.length + entropy.length);
  return bytes;
};
const jpeg = (size = 100) => new Blob([jpegBytes(size)], { type: "image/jpeg" });
const file = (name: string, type: string, size = 100) => new File([new Uint8Array(size)], name, { type });
const systemChromiumPaths = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
const browserExecutablePath = [chromium.executablePath(), ...systemChromiumPaths].find((path) => existsSync(path));

function deps(input: { width?: number; height?: number; outputs?: Blob[]; heic?: unknown; sanitized?: Blob } = {}) {
  const sourceWidth = input.width ?? 4000;
  const sourceHeight = input.height ?? 2000;
  const scale = Math.min(1, 2048 / Math.max(sourceWidth, sourceHeight));
  const bitmap = { width: sourceWidth, height: sourceHeight, close: vi.fn(), uprightCorners: ["red", "green", "blue", "yellow"] };
  const verificationBitmap = {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    close: vi.fn(),
  };
  const surface = { encode: vi.fn(), verifySanitized: vi.fn(async () => undefined), dispose: vi.fn() };
  if (input.outputs) {
    for (const output of input.outputs) surface.encode.mockResolvedValueOnce(output);
  } else {
    surface.encode.mockResolvedValue(jpeg());
  }
  const result: PhotoPreparationDeps = {
    createImageBitmap: vi.fn(async (_blob, options) => options.imageOrientation === "none" ? verificationBitmap : bitmap),
    createSurface: vi.fn(() => surface),
    createObjectURL: vi.fn(() => "blob:preview"),
    revokeObjectURL: vi.fn(),
    loadHeic: vi.fn(async () => async () => input.heic ?? jpeg()),
    sanitizeJpeg: vi.fn(async (candidate: Blob) => input.sanitized ?? candidate),
  };
  return { result, bitmap, verificationBitmap, surface };
}

describe("photo preparation", () => {
  it("rejects a surface that omits sanitized pixel verification before preview or send", async () => {
    const image = deps();
    delete (image.surface as Partial<typeof image.surface>).verifySanitized;

    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_encode_failed");
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects a sanitized pixel verifier failure before preview or send", async () => {
    const image = deps();
    image.surface.verifySanitized.mockRejectedValueOnce(new Error("pixel_verification_failed"));

    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_encode_failed");
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong MIME", new Blob([jpeg()], { type: "image/png" })],
    ["empty bytes", new Blob([], { type: "image/jpeg" })],
    ["oversized bytes", jpeg(PHOTO_OUTPUT_MAX_BYTES + 1)],
    ["forbidden APP1", new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]), jpegBytes().subarray(2)], { type: "image/jpeg" })],
    ["forbidden COM", new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x02]), jpegBytes().subarray(2)], { type: "image/jpeg" })],
    ["corrupt bytes", new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" })],
  ])("rejects a sanitizer output with %s before preview or send", async (_name, sanitized) => {
    const image = deps({ sanitized });

    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow(/photo_(encode_failed|output_too_large)/);
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects a sanitizer output with a non-strict APP0 JFIF profile", async () => {
    const raw = jpegBytes();
    const sanitized = new Blob([raw.subarray(0, 2), Uint8Array.from([0xff, 0xe0, 0x00, 0x02]), raw.subarray(2)], { type: "image/jpeg" });
    const image = deps({ sanitized });

    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_encode_failed");
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects when the sanitized output cannot be independently decoded", async () => {
    const image = deps();
    image.result.createImageBitmap = vi.fn()
      .mockResolvedValueOnce(image.bitmap)
      .mockRejectedValueOnce(new DOMException("sanitized decode details", "EncodingError"));

    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_encode_failed");
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects sanitized output whose decoded dimensions or pixel count exceed the prepared bounds", async () => {
    const image = deps({ width: 2048, height: 2048 });
    const invalidVerification = { width: 2048, height: 2049, close: vi.fn() };
    image.result.createImageBitmap = vi.fn()
      .mockResolvedValueOnce(image.bitmap)
      .mockResolvedValueOnce(invalidVerification);

    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_encode_failed");
    expect(invalidVerification.close).toHaveBeenCalledOnce();
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it("keeps only the independently validated sanitized Blob for preview and send", async () => {
    const sanitized = jpeg(140);
    const image = deps({ outputs: [jpeg(120)], sanitized });

    const prepared = await preparePhoto(file("a.jpg", "image/jpeg"), image.result);
    expect(prepared.blob).toBe(sanitized);
    expect(image.result.createObjectURL).toHaveBeenCalledWith(sanitized);
    expect(prepared.transfer().blob()).toBe(sanitized);
  });

  it.each([2, 3, 4, 5, 6, 7, 8])("normalizes EXIF orientation %s exactly once", async (orientation) => {
    const image = deps();
    const output = await preparePhoto(file(`quadrants-o${orientation}.jpg`, "image/jpeg"), image.result);

    expect(image.result.createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: "from-image" });
    expect(image.result.createSurface).toHaveBeenCalledWith(expect.objectContaining({ uprightCorners: ["red", "green", "blue", "yellow"] }), 2048, 1024);
    expect(output).toMatchObject({ width: 2048, height: 1024, byteSize: 100 });
  });

  it("accepts exactly 20 MiB and rejects one byte more", async () => {
    await expect(preparePhoto(file("edge.jpg", "image/jpeg", PHOTO_INPUT_MAX_BYTES), deps().result)).resolves.toBeDefined();
    await expect(preparePhoto(file("over.jpg", "image/jpeg", PHOTO_INPUT_MAX_BYTES + 1), deps().result)).rejects.toThrow("photo_input_too_large");
  });

  it.each([
    ["a.jpg", "image/jpeg"], ["a.jpeg", "image/jpeg"], ["a.png", "image/png"],
    ["a.webp", "image/webp"], ["a.heic", "image/heic"], ["a.heif", "image/heif"],
  ])("accepts the supported MIME and extension pair %s", async (name, type) => {
    await expect(preparePhoto(file(name, type), deps().result)).resolves.toBeDefined();
  });

  it.each([["a.png", "image/jpeg"], ["a.jpg", "image/png"], ["a.gif", "image/gif"], ["a", "image/jpeg"]])
    ("rejects mismatched or unsupported pair %s", async (name, type) => {
      await expect(preparePhoto(file(name, type), deps().result)).rejects.toThrow("unsupported_photo");
    });

  it("tries fixed qualities and retains the first JPEG at most five MiB", async () => {
    const image = deps({ outputs: [jpeg(5_242_881), jpeg(5_242_881), jpeg(120)] });
    const prepared = await preparePhoto(file("a.jpg", "image/jpeg"), image.result);

    expect(image.surface.encode).toHaveBeenNthCalledWith(1, 0.82);
    expect(image.surface.encode).toHaveBeenNthCalledWith(2, 0.78);
    expect(image.surface.encode).toHaveBeenNthCalledWith(3, 0.74);
    expect(image.surface.encode).toHaveBeenCalledTimes(3);
    expect(prepared.byteSize).toBe(120);
  });

  it("rejects when every fixed quality remains over five MiB and releases decode resources", async () => {
    const image = deps({ outputs: [jpeg(5_242_881), jpeg(5_242_881), jpeg(5_242_881), jpeg(5_242_881)] });
    await expect(preparePhoto(file("a.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_output_too_large");
    expect(image.bitmap.close).toHaveBeenCalledOnce();
    expect(image.surface.dispose).toHaveBeenCalledOnce();
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it("does not dynamically load HEIC support for ordinary formats", async () => {
    const image = deps();
    await preparePhoto(file("a.png", "image/png"), image.result);
    expect(image.result.loadHeic).not.toHaveBeenCalled();
  });

  it.each([[[]], [[jpeg()]], [[jpeg(), jpeg()]], ["not-a-blob"]])("rejects non-single-Blob HEIC output", async (heic) => {
    const image = deps({ heic });
    await expect(preparePhoto(file("a.heic", "image/heic"), image.result)).rejects.toThrow("heic_conversion_failed");
    expect(image.result.createImageBitmap).not.toHaveBeenCalled();
  });

  it("cancels after an in-flight HEIC import without decoding", async () => {
    let finishImport!: (value: (input: Blob) => Promise<Blob>) => void;
    const image = deps();
    image.result.loadHeic = vi.fn(() => new Promise((resolve) => { finishImport = resolve; }));
    const controller = new AbortController();
    const pending = preparePhoto(file("a.heic", "image/heic"), { ...image.result, signal: controller.signal });
    controller.abort();
    finishImport(async () => jpeg());
    await expect(pending).rejects.toThrow("photo_cancelled");
    expect(image.result.createImageBitmap).not.toHaveBeenCalled();
  });

  it("cancels after decode and closes the late bitmap", async () => {
    let finishDecode!: (value: typeof image.bitmap) => void;
    const image = deps();
    image.result.createImageBitmap = vi.fn(() => new Promise((resolve) => { finishDecode = resolve; }));
    const controller = new AbortController();
    const pending = preparePhoto(file("a.jpg", "image/jpeg"), { ...image.result, signal: controller.signal });
    controller.abort();
    finishDecode(image.bitmap);
    await expect(pending).rejects.toThrow("photo_cancelled");
    expect(image.bitmap.close).toHaveBeenCalledOnce();
    expect(image.result.createSurface).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN])("closes the bitmap once for invalid decoded width %s", async (width) => {
    const image = deps({ width });
    await expect(preparePhoto(file("bad.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_decode_failed");
    expect(image.bitmap.close).toHaveBeenCalledOnce();
    expect(image.result.createSurface).not.toHaveBeenCalled();
  });

  it("maps a decoder rejection to a safe failure without constructing a surface", async () => {
    const image = deps();
    image.result.createImageBitmap = vi.fn(async () => { throw new DOMException("decode details", "EncodingError"); });
    await expect(preparePhoto(file("broken.jpg", "image/jpeg"), image.result)).rejects.toThrow("photo_decode_failed");
    expect(image.result.createSurface).not.toHaveBeenCalled();
  });

  it("releases bitmap and canvas when cancellation arrives during encoding", async () => {
    let finishEncode!: (blob: Blob) => void;
    const image = deps();
    image.surface.encode = vi.fn(() => new Promise((resolve) => { finishEncode = resolve; }));
    const controller = new AbortController();
    const pending = preparePhoto(file("a.jpg", "image/jpeg"), { ...image.result, signal: controller.signal });
    await vi.waitFor(() => expect(image.surface.encode).toHaveBeenCalledOnce());
    controller.abort();
    finishEncode(jpeg());
    await expect(pending).rejects.toThrow("photo_cancelled");
    expect(image.bitmap.close).toHaveBeenCalledOnce();
    expect(image.surface.dispose).toHaveBeenCalledOnce();
    expect(image.result.createObjectURL).not.toHaveBeenCalled();
  });

  it.each(["chromium", "webkit"] as const)("normalizes real asymmetric EXIF JPEG orientations 2-8 in %s and loads the actual HEIC converter", async (engine) => {
    const server = await createServer({
      root: new URL("..", import.meta.url).pathname,
      logLevel: "silent",
      optimizeDeps: { include: ["heic2any"] },
      server: { host: "127.0.0.1", port: 4398, strictPort: false, hmr: false },
    });
    server.middlewares.use("/__photo-preparation-browser-test", (_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><html><body>photo preparation browser test</body></html>");
    });
    await server.listen();
    await server.warmupRequest("/src/photo-preparation.ts");
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("test_server_unavailable");

    const browser = await (engine === "webkit" ? webkit : chromium).launch({
      headless: true,
      ...(engine === "chromium" && browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/__photo-preparation-browser-test`);
      const actual = await page.evaluate(async () => {
        const photoModule = await (0, eval)("import('/src/photo-preparation.ts')") as typeof import("../src/photo-preparation");
        const converter = await photoModule.browserPhotoPreparationDeps().loadHeic();

        const expectedColors = [
          [220, 30, 30],
          [30, 180, 50],
          [30, 70, 220],
          [225, 190, 30],
        ];
        const jpegBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("fixture_encode_failed")), "image/jpeg", 1);
        });
        const addExifOrientation = async (blob: Blob, orientation: number) => {
          const jpeg = new Uint8Array(await blob.arrayBuffer());
          const app1 = new Uint8Array([
            0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
            0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01,
            0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          ]);
          const bytes = new Uint8Array(jpeg.length + app1.length);
          bytes.set(jpeg.subarray(0, 2));
          bytes.set(app1, 2);
          bytes.set(jpeg.subarray(2), app1.length + 2);
          return new Blob([bytes], { type: "image/jpeg" });
        };
        const sourceCoordinate = (orientation: number, x: number, y: number, sourceWidth: number, sourceHeight: number) => {
          if (orientation === 2) return [sourceWidth - 1 - x, y];
          if (orientation === 3) return [sourceWidth - 1 - x, sourceHeight - 1 - y];
          if (orientation === 4) return [x, sourceHeight - 1 - y];
          if (orientation === 5) return [y, x];
          if (orientation === 6) return [y, sourceHeight - 1 - x];
          if (orientation === 7) return [sourceWidth - 1 - y, sourceHeight - 1 - x];
          return [sourceWidth - 1 - y, x];
        };
        const makeFixture = async (orientation: number) => {
          const outputWidth = 80;
          const outputHeight = 60;
          const swapsAxes = orientation >= 5;
          const sourceWidth = swapsAxes ? outputHeight : outputWidth;
          const sourceHeight = swapsAxes ? outputWidth : outputHeight;
          const canvas = document.createElement("canvas");
          canvas.width = sourceWidth;
          canvas.height = sourceHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("fixture_canvas_unavailable");
          const image = context.createImageData(sourceWidth, sourceHeight);
          for (let y = 0; y < outputHeight; y += 1) {
            for (let x = 0; x < outputWidth; x += 1) {
              const quadrant = (y < outputHeight / 2 ? 0 : 2) + (x < outputWidth / 2 ? 0 : 1);
              const [sourceX, sourceY] = sourceCoordinate(orientation, x, y, sourceWidth, sourceHeight);
              const offset = (sourceY * sourceWidth + sourceX) * 4;
              const color = expectedColors[quadrant];
              image.data.set([...color, 255], offset);
            }
          }
          context.putImageData(image, 0, 0);
          return addExifOrientation(await jpegBlob(canvas), orientation);
        };
        const classifyCorner = (pixel: Uint8ClampedArray) => expectedColors
          .map((color, index) => ({ index, distance: color.reduce((sum, channel, i) => sum + Math.abs(channel - pixel[i]), 0) }))
          .sort((a, b) => a.distance - b.distance)[0].index;

        const orientations = [];
        for (let orientation = 2; orientation <= 8; orientation += 1) {
          const fixture = await makeFixture(orientation);
          const prepared = await photoModule.preparePhoto(
            new File([fixture], `quadrants-o${orientation}.jpg`, { type: "image/jpeg" }),
            photoModule.browserPhotoPreparationDeps(),
          );
          const outputBitmap = await createImageBitmap(prepared.blob);
          const canvas = document.createElement("canvas");
          canvas.width = outputBitmap.width;
          canvas.height = outputBitmap.height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("result_canvas_unavailable");
          context.drawImage(outputBitmap, 0, 0);
          const corners = [[10, 10], [70, 10], [10, 50], [70, 50]].map(([x, y]) =>
            classifyCorner(context.getImageData(x, y, 1, 1).data));
          orientations.push({ orientation, width: outputBitmap.width, height: outputBitmap.height, corners });
          outputBitmap.close();
          prepared.dispose();
        }
        return { converterType: typeof converter, orientations };
      });

      await page.addStyleTag({ url: `http://127.0.0.1:${address.port}/src/styles.css` });
      await page.evaluate(() => {
        const canvas = document.createElement("canvas"); canvas.width = 3; canvas.height = 2;
        const context = canvas.getContext("2d")!; context.fillStyle = "red"; context.fillRect(0, 0, 3, 2);
        const item = document.createElement("div"); item.className = "chat-photo";
        const image = document.createElement("img"); image.alt = "送信した写真"; image.src = canvas.toDataURL();
        item.append(image); document.body.append(item);
      });
      for (const width of [320, 402]) {
        await page.setViewportSize({ width, height: 874 });
        const thumbnail = await page.locator(".chat-photo img").boundingBox();
        expect(thumbnail?.width).toBeGreaterThan(200);
        expect(thumbnail?.height).toBeGreaterThan(150);
        expect(thumbnail?.width).toBeLessThan(width);
      }
      expect(actual.converterType).toBe("function");
      expect(actual.orientations).toEqual([2, 3, 4, 5, 6, 7, 8].map((orientation) => ({
        orientation,
        width: 80,
        height: 60,
        corners: [0, 1, 2, 3],
      })));
    } finally {
      await browser.close();
      await server.close();
    }
  }, 30_000);
});
