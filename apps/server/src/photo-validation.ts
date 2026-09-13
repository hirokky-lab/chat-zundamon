import { createHash } from "node:crypto";
import jpeg from "jpeg-js";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 2048;
const MAX_PIXELS = 4_194_304;
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export type PreparedJpegValidation = { width: number; height: number; byteSize: number; sha256: string };

function invalid(): never { throw new Error("invalid_photo"); }

function isStrictJfif(payload: Uint8Array): boolean {
  return payload.length === 14
    && Buffer.from(payload.subarray(0, 5)).equals(Buffer.from("JFIF\0", "binary"))
    && payload[5] === 1 && (payload[6] === 1 || payload[6] === 2)
    && payload[7] === 0
    && payload[8] === 0 && payload[9] === 1
    && payload[10] === 0 && payload[11] === 1
    && payload[12] === 0 && payload[13] === 0;
}

export function validatePreparedJpeg(input: Uint8Array, decode: typeof jpeg.decode = jpeg.decode): PreparedJpegValidation {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 4 || bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) invalid();
  let offset = 2;
  let app0Count = 0;
  let frames = 0;
  let width = 0;
  let height = 0;
  let sawSos = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) invalid();
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid();
    if (offset + 2 > bytes.length - 2) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) invalid();
    const payloadStart = offset + 2;
    const payloadEnd = offset + length;
    const payload = bytes.subarray(payloadStart, payloadEnd);
    if (marker === 0xe0) {
      app0Count += 1;
      if (app0Count > 1 || length !== 16 || !isStrictJfif(payload)) invalid();
    } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) invalid();
    if (SOF_MARKERS.has(marker)) {
      frames += 1;
      if (frames !== 1 || payload.length < 6) invalid();
      height = payload.readUInt16BE(1);
      width = payload.readUInt16BE(3);
    }
    offset = payloadEnd;
    if (marker === 0xda) {
      sawSos = true;
      while (offset < bytes.length - 2) {
        if (bytes[offset++] !== 0xff) continue;
        while (bytes[offset] === 0xff) offset += 1;
        const entropyMarker = bytes[offset++];
        if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) continue;
        invalid();
      }
    }
  }
  if (!sawSos || frames !== 1 || offset !== bytes.length - 2 || width < 1 || height < 1
    || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) invalid();
  try {
    const decoded = decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64, maxResolutionInMP: 5 });
    if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4) invalid();
  } catch { invalid(); }
  return { width, height, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
