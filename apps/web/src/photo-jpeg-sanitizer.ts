const standalone = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const knownSegments = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf,
  0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
  0xe9, 0xea, 0xeb, 0xec, 0xed, 0xee, 0xef, 0xfe,
]);
const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function fail(): never { throw new Error("photo_encode_failed"); }

function isStrictJfif(payload: Uint8Array): boolean {
  return payload.length === 14
    && new TextDecoder().decode(payload.subarray(0, 5)) === "JFIF\0"
    && payload[5] === 1 && (payload[6] === 1 || payload[6] === 2)
    && payload[7] === 0
    && payload[8] === 0 && payload[9] === 1
    && payload[10] === 0 && payload[11] === 1
    && payload[12] === 0 && payload[13] === 0;
}

/** Checks the exact JPEG profile accepted after browser-side sanitization. */
export function assertStrictSanitizedCanvasJpeg(input: Uint8Array): void {
  const bytes = Uint8Array.from(input);
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail();
  let offset = 2;
  let app0Count = 0;
  let frames = 0;
  let sawScan = false;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) fail();
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || standalone.has(marker) || !knownSegments.has(marker)) fail();
    if (offset + 2 > bytes.length - 2) fail();
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length - 2) fail();
    const end = offset + length;
    const payload = bytes.subarray(offset + 2, end);
    if (marker === 0xe0) {
      app0Count += 1;
      if (app0Count > 1 || !isStrictJfif(payload)) fail();
    } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) fail();
    if (sofMarkers.has(marker)) {
      frames += 1;
      if (frames !== 1 || payload.length < 6) fail();
    }
    offset = end;
    if (marker === 0xda) {
      sawScan = true;
      let entropyBytes = 0;
      while (offset < bytes.length - 2) {
        if (bytes[offset] !== 0xff) { offset += 1; entropyBytes += 1; continue; }
        const escapeStart = offset++;
        while (bytes[offset] === 0xff) offset += 1;
        const entropyMarker = bytes[offset++];
        if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) { entropyBytes += offset - escapeStart; continue; }
        fail();
      }
      if (entropyBytes === 0) fail();
    }
  }
  if (!sawScan || frames !== 1 || offset !== bytes.length - 2) fail();
}

export function sanitizeCanvasJpeg(input: Uint8Array): Uint8Array {
  const bytes = Uint8Array.from(input);
  if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) fail();
  const chunks: Uint8Array[] = [Uint8Array.from([0xff, 0xd8])];
  let offset = 2;
  let sawScan = false;
  let iccSegments = 0;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) fail();
    const markerStart = offset;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || standalone.has(marker) || !knownSegments.has(marker)) fail();
    if (offset + 2 > bytes.length - 2) fail();
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length - 2) fail();
    const end = offset + length;
    const payload = bytes.subarray(offset + 2, end);
    const isIcc = marker === 0xe2 && payload.length >= 12
      && new TextDecoder().decode(payload.subarray(0, 12)) === "ICC_PROFILE\0";
    if (marker === 0xe2 && (isIcc || payload.length < 14)) {
      if (!isIcc || payload.length < 14 || payload[12] !== 1 || payload[13] !== 1 || iccSegments !== 0) fail();
      iccSegments += 1;
    }
    // WebKit emits JFIF density 72:72; normalize browser metadata before
    // enforcing the same strict, metadata-free output profile on every engine.
    if (marker === 0xe0) {
      if (payload.length < 14
        || new TextDecoder().decode(payload.subarray(0, 5)) !== "JFIF\0"
        || payload[5] !== 1 || payload[6] > 2 || payload[7] > 2
        || payload.length !== 14 + 3 * payload[12] * payload[13]) fail();
      chunks.push(Uint8Array.from([0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
    }
    const strip = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!strip) chunks.push(bytes.subarray(markerStart, end));
    offset = end;
    if (marker === 0xda) {
      sawScan = true;
      const entropyStart = offset;
      let entropyBytes = 0;
      while (offset < bytes.length - 2) {
        if (bytes[offset] !== 0xff) { offset += 1; entropyBytes += 1; continue; }
        const escapeStart = offset++;
        while (bytes[offset] === 0xff) offset += 1;
        const entropyMarker = bytes[offset++];
        if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) { entropyBytes += offset - escapeStart; continue; }
        fail();
      }
      if (entropyBytes === 0) fail();
      chunks.push(bytes.subarray(entropyStart, offset));
    }
  }
  if (!sawScan || offset !== bytes.length - 2) fail();
  chunks.push(Uint8Array.from([0xff, 0xd9]));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let writeOffset = 0;
  for (const chunk of chunks) { output.set(chunk, writeOffset); writeOffset += chunk.byteLength; }
  return output;
}
