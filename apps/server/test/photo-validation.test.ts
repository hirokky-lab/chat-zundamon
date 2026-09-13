import jpeg from "jpeg-js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validatePreparedJpeg } from "../src/photo-validation.js";
import { sanitizeCanvasJpeg } from "../../web/src/photo-jpeg-sanitizer.js";

function encoded(width = 2, height = 2): Uint8Array {
  return jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 127) }, 90).data;
}

function insertSegment(bytes: Uint8Array, marker: number, payload: number[]): Uint8Array {
  const segment = Uint8Array.from([0xff, marker, 0, payload.length + 2, ...payload]);
  return Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
}

function truncateEntropy(bytes: Uint8Array): Uint8Array {
  const sos = Buffer.from(bytes).indexOf(Buffer.from([0xff, 0xda]));
  const headerLength = Buffer.from(bytes).readUInt16BE(sos + 2);
  return Buffer.concat([bytes.subarray(0, sos + 2 + headerLength + 1), Buffer.from([0xff, 0xd9])]);
}

describe("validatePreparedJpeg", () => {
  it("fully decodes a strict JFIF JPEG and returns its canonical digest", () => {
    expect(validatePreparedJpeg(encoded(3, 2))).toMatchObject({ width: 3, height: 2, byteSize: encoded(3, 2).byteLength });
    expect(validatePreparedJpeg(encoded()).sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["canvas-chromium", "canvas-chromium-q78", "canvas-chromium-q74"])("rejects the raw %s fixture because Chromium includes APP2 ICC", async (fixture) => {
    const bytes = await readFile(new URL(`./fixtures/${fixture}.jpg`, import.meta.url));
    expect(Buffer.from(bytes).includes(Buffer.from("ICC_PROFILE"))).toBe(true);
    expect(() => validatePreparedJpeg(bytes)).toThrow("invalid_photo");
    expect(validatePreparedJpeg(sanitizeCanvasJpeg(bytes))).toMatchObject({ width: 3, height: 2 });
  });

  it.each([0xe1, 0xe2, 0xef, 0xfe])("rejects metadata marker ff%s", (marker) => {
    expect(() => validatePreparedJpeg(insertSegment(encoded(), marker, [1, 2]))).toThrow("invalid_photo");
  });

  it.each([
    ["missing SOI", (value: Uint8Array) => value.subarray(1)],
    ["missing EOI", (value: Uint8Array) => value.subarray(0, -2)],
    ["trailing bytes", (value: Uint8Array) => Buffer.concat([value, Buffer.from([0])])],
    ["oversize", () => encoded(2049, 1)],
    ["pixel limit", () => encoded(2048, 2049)],
    ["corrupt entropy", truncateEntropy],
  ])("rejects %s", (_name, mutate) => expect(() => validatePreparedJpeg(mutate(encoded()))).toThrow("invalid_photo"));

  it("rejects duplicate or noncanonical JFIF", () => {
    const strictJfif = [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    expect(() => validatePreparedJpeg(insertSegment(encoded(), 0xe0, strictJfif))).toThrow("invalid_photo");
    expect(() => validatePreparedJpeg(insertSegment(encoded(), 0xe0, [...strictJfif.slice(0, 7), 1, ...strictJfif.slice(8)]))).toThrow("invalid_photo");
  });

  it.each([
    ["identifier", [0x58, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]],
    ["major", [0x4a, 0x46, 0x49, 0x46, 0, 2, 1, 0, 0, 1, 0, 1, 0, 0]],
    ["minor", [0x4a, 0x46, 0x49, 0x46, 0, 1, 3, 0, 0, 1, 0, 1, 0, 0]],
    ["units", [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0]],
    ["xdensity", [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 2, 0, 1, 0, 0]],
    ["ydensity", [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0]],
    ["thumbnail", [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0]],
  ])("rejects wrong JFIF %s", (_name, payload) => expect(() => validatePreparedJpeg(insertSegment(encoded(), 0xe0, payload as number[]))).toThrow("invalid_photo"));

  it("rejects a second frame marker and a SOF/decode dimension mismatch", () => {
    const source = encoded();
    const sof = Buffer.from(source).indexOf(Buffer.from([0xff, 0xc0]));
    const segmentLength = Buffer.from(source).readUInt16BE(sof + 2);
    expect(() => validatePreparedJpeg(Buffer.concat([source.subarray(0, sof), source.subarray(sof, sof + 2 + segmentLength), source.subarray(sof)]))).toThrow("invalid_photo");
    expect(() => validatePreparedJpeg(source, (() => ({ width: 3, height: 2, data: new Uint8Array(24) })) as typeof jpeg.decode)).toThrow("invalid_photo");
  });

  it("rejects 5 MiB + 1 before decode", () => expect(() => validatePreparedJpeg(Buffer.alloc(5 * 1024 * 1024 + 1))).toThrow("invalid_photo"));
});
