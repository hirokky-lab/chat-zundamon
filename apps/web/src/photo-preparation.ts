import { assertStrictSanitizedCanvasJpeg, sanitizeCanvasJpeg } from "./photo-jpeg-sanitizer.js";

export const PHOTO_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const PHOTO_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_JPEG_QUALITIES = [0.82, 0.78, 0.74, 0.70] as const;

export type PhotoBitmap = { width: number; height: number; close(): void };
export type PhotoCanvasSurface = { encode(quality: number): Promise<Blob>; verifySanitized(blob: Blob): Promise<void>; dispose(): void };
export type HeicConverter = (input: { blob: Blob; toType: "image/jpeg"; quality: number }) => Promise<unknown>;

export type PhotoPreparationDeps = {
  createImageBitmap(blob: Blob, options: { imageOrientation: "from-image" | "none" }): Promise<PhotoBitmap>;
  createSurface(bitmap: PhotoBitmap, width: number, height: number): PhotoCanvasSurface;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  loadHeic(): Promise<HeicConverter>;
  sanitizeJpeg(candidate: Blob): Promise<Blob>;
  signal?: AbortSignal;
};

export type PhotoSendLease = {
  blob(): Blob;
  markRetryable(): void;
  finish(): void;
  cancel(): void;
  terminal(): void;
};

export type PreparedPhoto = {
  readonly blob: Blob;
  readonly previewUrl: string;
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  transfer(): PhotoSendLease;
  dispose(): void;
};

type PreparedPhotoInput = {
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  revokeObjectURL(url: string): void;
};

export function createPreparedPhoto(input: PreparedPhotoInput): PreparedPhoto {
  let retainedBlob: Blob | null = input.blob;
  let retainedUrl: string | null = input.previewUrl;
  let state: "owned" | "transferred" | "disposed" = "owned";

  const assertOwned = () => {
    if (state === "transferred") throw new Error("photo_ownership_transferred");
    if (state === "disposed") throw new Error("photo_blob_released");
  };
  const release = () => {
    if (retainedUrl !== null) input.revokeObjectURL(retainedUrl);
    retainedUrl = null;
    retainedBlob = null;
  };

  return {
    get blob() { assertOwned(); return retainedBlob as Blob; },
    get previewUrl() { assertOwned(); return retainedUrl as string; },
    width: input.width,
    height: input.height,
    byteSize: input.blob.size,
    dispose() {
      assertOwned();
      state = "disposed";
      release();
    },
    transfer() {
      assertOwned();
      state = "transferred";
      let leaseState: "sending" | "retryable" | "released" = "sending";
      const settle = () => {
        if (leaseState === "released") return;
        leaseState = "released";
        release();
      };
      return {
        blob() {
          if (leaseState === "released" || retainedBlob === null) throw new Error("photo_blob_released");
          return retainedBlob;
        },
        markRetryable() {
          if (leaseState === "released") throw new Error("photo_blob_released");
          leaseState = "retryable";
        },
        finish: settle,
        cancel: settle,
        terminal: settle,
      };
    },
  };
}

const supportedPairs = new Map([
  ["image/jpeg", new Set(["jpg", "jpeg"])],
  ["image/png", new Set(["png"])],
  ["image/webp", new Set(["webp"])],
  ["image/heic", new Set(["heic"])],
  ["image/heif", new Set(["heif"])],
]);

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("photo_cancelled");
}

function validateInput(file: File) {
  if (file.size > PHOTO_INPUT_MAX_BYTES) throw new Error("photo_input_too_large");
  const extension = file.name.toLocaleLowerCase("en-US").match(/\.([a-z0-9]+)$/u)?.[1];
  if (!extension || !supportedPairs.get(file.type)?.has(extension)) throw new Error("unsupported_photo");
}

function scaledSize(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error("photo_decode_failed");
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function validateSanitizedOutput(blob: Blob, dimensions: { width: number; height: number }, deps: PhotoPreparationDeps): Promise<void> {
  if (!(blob instanceof Blob) || blob.type !== "image/jpeg" || blob.size === 0) throw new Error("photo_encode_failed");
  if (blob.size > PHOTO_OUTPUT_MAX_BYTES) throw new Error("photo_output_too_large");
  try {
    assertStrictSanitizedCanvasJpeg(new Uint8Array(await blob.arrayBuffer()));
    const bitmap = await deps.createImageBitmap(blob, { imageOrientation: "none" });
    try {
      if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height || bitmap.width * bitmap.height > 4_194_304) {
        throw new Error("photo_encode_failed");
      }
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if (error instanceof Error && (error.message === "photo_encode_failed" || error.message === "photo_output_too_large")) throw error;
    throw new Error("photo_encode_failed", { cause: error });
  }
}

export async function preparePhoto(file: File, deps: PhotoPreparationDeps): Promise<PreparedPhoto> {
  validateInput(file);
  assertNotCancelled(deps.signal);

  let decodeBlob: Blob = file;
  if (file.type === "image/heic" || file.type === "image/heif") {
    const convert = await deps.loadHeic();
    assertNotCancelled(deps.signal);
    const converted = await convert({ blob: file, toType: "image/jpeg", quality: 1 });
    assertNotCancelled(deps.signal);
    if (!(converted instanceof Blob) || Array.isArray(converted)) throw new Error("heic_conversion_failed");
    decodeBlob = converted;
  }

  let bitmap: PhotoBitmap;
  try {
    bitmap = await deps.createImageBitmap(decodeBlob, { imageOrientation: "from-image" });
  } catch (error) {
    if (deps.signal?.aborted) throw new Error("photo_cancelled");
    throw new Error("photo_decode_failed", { cause: error });
  }
  if (deps.signal?.aborted) {
    bitmap.close();
    throw new Error("photo_cancelled");
  }

  let dimensions: { width: number; height: number };
  let surface: PhotoCanvasSurface | null = null;
  let output: Blob | null = null;
  try {
    dimensions = scaledSize(bitmap.width, bitmap.height);
    surface = deps.createSurface(bitmap, dimensions.width, dimensions.height);
    if (typeof surface.verifySanitized !== "function") throw new Error("photo_encode_failed");
    for (const quality of PHOTO_JPEG_QUALITIES) {
      assertNotCancelled(deps.signal);
      const candidate = await surface.encode(quality);
      assertNotCancelled(deps.signal);
      if (candidate.type !== "image/jpeg" || candidate.size === 0) throw new Error("photo_encode_failed");
      let sanitized: Blob;
      try {
        sanitized = await deps.sanitizeJpeg(candidate);
        assertNotCancelled(deps.signal);
        await validateSanitizedOutput(sanitized, dimensions, deps);
        await surface.verifySanitized(sanitized);
      } catch (error) {
        if (error instanceof Error && error.message === "photo_output_too_large") continue;
        if (error instanceof Error && error.message === "photo_cancelled") throw error;
        throw new Error("photo_encode_failed", { cause: error });
      }
      output = sanitized;
      break;
    }
  } finally {
    surface?.dispose();
    bitmap.close();
  }
  if (output === null) throw new Error("photo_output_too_large");

  const previewUrl = deps.createObjectURL(output);
  return createPreparedPhoto({ ...dimensions, blob: output, previewUrl, revokeObjectURL: deps.revokeObjectURL });
}

export function browserPhotoPreparationDeps(signal?: AbortSignal): PhotoPreparationDeps {
  return {
    signal,
    createImageBitmap: (blob, options) => globalThis.createImageBitmap(blob, options) as Promise<PhotoBitmap>,
    createSurface(bitmap, width, height) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("photo_canvas_unavailable");
      context.drawImage(bitmap as ImageBitmap, 0, 0, width, height);
      return {
        encode: (quality) => new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
          if (!blob) { reject(new Error("photo_encode_failed")); return; }
          resolve(blob);
        }, "image/jpeg", quality)),
        async verifySanitized(sanitized) {
          const verification = await globalThis.createImageBitmap(sanitized);
          const verificationCanvas = document.createElement("canvas");
          try {
            if (verification.width !== width || verification.height !== height || width * height > 4_194_304) throw new Error("photo_encode_failed");
            verificationCanvas.width = width;
            verificationCanvas.height = height;
            const verificationContext = verificationCanvas.getContext("2d");
            if (!verificationContext) throw new Error("photo_encode_failed");
            verificationContext.drawImage(verification, 0, 0);
            const before = context.getImageData(0, 0, width, height).data;
            const after = verificationContext.getImageData(0, 0, width, height).data;
            let totalDifference = 0;
            for (let index = 0; index < before.length; index += 4) {
              totalDifference += Math.abs(before[index] - after[index])
                + Math.abs(before[index + 1] - after[index + 1])
                + Math.abs(before[index + 2] - after[index + 2]);
            }
            if (totalDifference / (width * height * 3) > 32) throw new Error("photo_encode_failed");
          } finally {
            verification.close();
            verificationCanvas.width = 0;
            verificationCanvas.height = 0;
          }
        },
        dispose() { canvas.width = 0; canvas.height = 0; },
      };
    },
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    async sanitizeJpeg(candidate) {
      const sanitizedBytes = sanitizeCanvasJpeg(new Uint8Array(await candidate.arrayBuffer()));
      return new Blob([sanitizedBytes.slice().buffer], { type: "image/jpeg" });
    },
    async loadHeic() {
      const module = await import("heic2any");
      const direct = module.default as unknown;
      const converter = typeof direct === "function"
        ? direct
        : (direct && typeof direct === "object" ? (direct as { default?: unknown }).default : undefined);
      if (typeof converter !== "function") throw new Error("heic_conversion_unavailable");
      return converter as HeicConverter;
    },
  };
}
