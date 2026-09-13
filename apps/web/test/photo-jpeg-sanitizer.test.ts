// @vitest-environment node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertStrictSanitizedCanvasJpeg, sanitizeCanvasJpeg } from "../src/photo-jpeg-sanitizer";

const chromiumFixture = fileURLToPath(new URL("../../server/test/fixtures/canvas-chromium.jpg", import.meta.url));

describe("canvas JPEG sanitizer", () => {
  it.each([0, 1, 2])("normalizes JFIF density and removes embedded thumbnails for unit %i", async (unit) => {
    const raw = await readFile(chromiumFixture);
    const offset = raw.indexOf(Buffer.from([0xff, 0xe0]));
    const length = raw.readUInt16BE(offset + 2);
    const app0 = Buffer.from([0xff, 0xe0, 0, 19, 74, 70, 73, 70, 0, 1, 1, unit, 0, 72, 0, 72, 1, 1, 23, 45, 67]);
    const output = sanitizeCanvasJpeg(Buffer.concat([raw.subarray(0, offset), app0, raw.subarray(offset + 2 + length)]));
    expect(() => assertStrictSanitizedCanvasJpeg(output)).not.toThrow();
    expect(Array.from(output.subarray(2, 20))).toEqual([255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  });

  it("removes the real Chromium APP2 ICC segment as a whole while preserving decodable JPEG structure", async () => {
    const raw = await readFile(chromiumFixture);
    expect(raw.includes(Buffer.from("ICC_PROFILE"))).toBe(true);
    const sanitized = sanitizeCanvasJpeg(raw);
    expect(Buffer.from(sanitized).includes(Buffer.from("ICC_PROFILE"))).toBe(false);
    expect(sanitized.slice(0, 2)).toEqual(Uint8Array.from([0xff, 0xd8]));
    expect(sanitized.slice(-2)).toEqual(Uint8Array.from([0xff, 0xd9]));
  });

  it.each([
    ["bad SOI", Uint8Array.from([0, 0, 0xff, 0xd9])],
    ["truncated length", Uint8Array.from([0xff, 0xd8, 0xff, 0xe2, 0, 20, 1, 2, 0xff, 0xd9])],
    ["unknown marker", Uint8Array.from([0xff, 0xd8, 0xff, 0x02, 0, 2, 0xff, 0xd9])],
    ["empty scan", Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9])],
    ["trailing bytes", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0])],
  ])("fails closed for %s", (_name, bytes) => expect(() => sanitizeCanvasJpeg(bytes)).toThrow("photo_encode_failed"));

  it.each([
    ["split ICC", [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0,1,2]],
    ["wrong ICC sequence", [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0,2,1]],
    ["short ICC header", [0x49,0x43,0x43,0x5f,0x50,0x52,0x4f,0x46,0x49,0x4c,0x45,0,1]],
  ])("rejects %s", async (_name, payload) => {
    const raw = await readFile(chromiumFixture);
    const app2 = Buffer.from(raw).indexOf(Buffer.from([0xff, 0xe2]));
    const length = Buffer.from(raw).readUInt16BE(app2 + 2);
    const replacement = Buffer.from([0xff, 0xe2, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]);
    const fixture = Buffer.concat([raw.subarray(0, app2), replacement, raw.subarray(app2 + 2 + length)]);
    expect(() => sanitizeCanvasJpeg(fixture)).toThrow("photo_encode_failed");
  });

  it("rejects two individually valid complete ICC segments", async () => {
    const raw = await readFile(chromiumFixture);
    const app2 = Buffer.from(raw).indexOf(Buffer.from([0xff, 0xe2]));
    const length = Buffer.from(raw).readUInt16BE(app2 + 2);
    const segment = raw.subarray(app2, app2 + 2 + length);
    expect(() => sanitizeCanvasJpeg(Buffer.concat([raw.subarray(0, app2), segment, raw.subarray(app2)]))).toThrow("photo_encode_failed");
  });

  it("removes crafted EXIF/GPS/XMP APP segments and COM by marker boundaries", async () => {
    const raw = await readFile(chromiumFixture);
    const app2 = Buffer.from(raw).indexOf(Buffer.from([0xff, 0xe2]));
    const app2Length = Buffer.from(raw).readUInt16BE(app2 + 2);
    const withoutIcc = Buffer.concat([raw.subarray(0, app2), raw.subarray(app2 + 2 + app2Length)]);
    const segment = (marker: number, text: string) => {
      const payload = Buffer.from(text); return Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    };
    const crafted = Buffer.concat([withoutIcc.subarray(0, 2), segment(0xe1, "Exif\0\0GPS secret"), segment(0xeb, "http://ns.adobe.com/xap/1.0/ XMP secret"), segment(0xfe, "comment secret"), withoutIcc.subarray(2)]);
    const sanitized = Buffer.from(sanitizeCanvasJpeg(crafted));
    expect(sanitized.includes(Buffer.from("Exif"))).toBe(false);
    expect(sanitized.includes(Buffer.from("GPS"))).toBe(false);
    expect(sanitized.includes(Buffer.from("XMP"))).toBe(false);
    expect(sanitized.includes(Buffer.from("comment"))).toBe(false);
  });

  it.each([512 * 1024, 5 * 1024 * 1024])("copies a %i-byte entropy payload without argument overflow", (size) => {
    const scan = Buffer.alloc(size, 1);
    const jpeg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xda,0,2]), scan, Buffer.from([0xff,0xd9])]);
    expect(sanitizeCanvasJpeg(jpeg).byteLength).toBe(jpeg.byteLength);
  });
});
