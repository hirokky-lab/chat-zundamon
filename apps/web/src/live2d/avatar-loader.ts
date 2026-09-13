import type {
  AvatarAsset,
  AvatarModelManifest,
  AvatarRenderer,
} from "./avatar-contract";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type BridgeModule = {
  createAvatarRenderer(input: {
    canvas: HTMLCanvasElement;
    manifest: AvatarModelManifest;
    assets: ReadonlyMap<string, Uint8Array>;
  }): Promise<AvatarRenderer> | AvatarRenderer;
};

export type LoadVerifiedAvatarRendererOptions = {
  canvas: HTMLCanvasElement;
  manifest: AvatarModelManifest;
  signal: AbortSignal;
  origin?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  importBridge?: (bytes: Uint8Array) => Promise<unknown>;
};

const knownErrors = new Set([
  "avatar_asset_rejected",
  "avatar_bridge_rejected",
  "avatar_load_failed",
]);

function reject(message: string): never {
  throw new Error(message);
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function validateAsset(asset: AvatarAsset, origin: string): void {
  if (!asset || typeof asset !== "object" || Array.isArray(asset) || !hasExactKeys(asset, ["path", "url", "sha256", "maxBytes"])) reject("avatar_asset_rejected");
  if (!asset.path || asset.path.length > 160 || asset.path.startsWith("/") || asset.path.includes("..")) reject("avatar_asset_rejected");
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) reject("avatar_asset_rejected");
  if (!Number.isSafeInteger(asset.maxBytes) || asset.maxBytes < 1 || asset.maxBytes > 16 * 1024 * 1024) reject("avatar_asset_rejected");
  let url: URL;
  try {
    url = new URL(asset.url, origin);
  } catch {
    reject("avatar_asset_rejected");
  }
  if (url.origin !== origin || url.username || url.password || url.hash) reject("avatar_asset_rejected");
}

function validateManifest(manifest: AvatarModelManifest, origin: string): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !hasExactKeys(manifest, ["id", "sdkVersion", "bridge", "assets", "notice", "provisional"])) reject("avatar_asset_rejected");
  if (!manifest.id || !manifest.sdkVersion || !manifest.notice || typeof manifest.provisional !== "boolean") reject("avatar_asset_rejected");
  if (!Array.isArray(manifest.assets)) reject("avatar_asset_rejected");
  if (manifest.assets.length === 0 || manifest.assets.length > 16) reject("avatar_asset_rejected");
  validateAsset(manifest.bridge, origin);
  const paths = new Set<string>();
  for (const asset of manifest.assets) {
    validateAsset(asset, origin);
    if (paths.has(asset.path)) reject("avatar_asset_rejected");
    paths.add(asset.path);
  }
}

async function digestSha256(value: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", value.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readVerifiedAsset(asset: AvatarAsset, fetchImpl: FetchLike, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetchImpl(asset.url, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/octet-stream" },
    method: "GET",
    redirect: "error",
    signal,
  });
  if (!response.ok) reject("avatar_asset_rejected");
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > asset.maxBytes)) reject("avatar_asset_rejected");
  if (!response.body) reject("avatar_asset_rejected");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > asset.maxBytes) {
        await reader.cancel();
        reject("avatar_asset_rejected");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total < 1) reject("avatar_asset_rejected");
  const value = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (await digestSha256(value) !== asset.sha256) reject("avatar_asset_rejected");
  return value;
}

function waitForAbort<T>(work: Promise<T>, signal: AbortSignal, onLateValue?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, rejectWork) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      rejectWork(new Error("avatar_load_failed"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then((value) => {
      if (settled) {
        onLateValue?.(value);
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (cause) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      rejectWork(cause);
    });
  });
}

// Keep one fixed, verified module so reopening does not accumulate new blob
// module instances. Assets are still fetched and checked on every mount.
let bridgeModule: { hash: string; promise: Promise<unknown> } | undefined;
async function importVerifiedBridge(bytes: Uint8Array): Promise<unknown> {
  const hash = await digestSha256(bytes);
  if (bridgeModule?.hash === hash) return bridgeModule.promise;
  const promise = importBridgeModule(bytes);
  const entry = { hash, promise };
  bridgeModule = entry;
  try { return await promise; } catch (error) {
    if (bridgeModule === entry) bridgeModule = undefined;
    throw error;
  }
}

async function importBridgeModule(bytes: Uint8Array): Promise<unknown> {
  const blobUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function isRenderer(value: unknown): value is AvatarRenderer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AvatarRenderer>;
  return typeof candidate.setInput === "function" && typeof candidate.resize === "function" && typeof candidate.dispose === "function";
}

function isBridge(value: unknown): value is BridgeModule {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as Partial<BridgeModule>).createAvatarRenderer === "function");
}

function disposeLateRenderer(value: unknown): void {
  if (!isRenderer(value)) return;
  try {
    value.dispose();
  } catch {
    // A late optional SDK result must remain isolated after timeout.
  }
}

export async function loadVerifiedAvatarRenderer(options: LoadVerifiedAvatarRendererOptions): Promise<AvatarRenderer> {
  const origin = options.origin ?? window.location.origin;
  validateManifest(options.manifest, origin);
  if (options.signal.aborted) reject("avatar_load_failed");

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, Math.max(1, options.timeoutMs ?? 8_000));

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const bridgeBytes = await waitForAbort(readVerifiedAsset(options.manifest.bridge, fetchImpl, controller.signal), controller.signal);
    const assets = new Map<string, Uint8Array>();
    for (const asset of options.manifest.assets) {
      assets.set(asset.path, await waitForAbort(readVerifiedAsset(asset, fetchImpl, controller.signal), controller.signal));
    }
    if (controller.signal.aborted) reject("avatar_load_failed");
    const bridge = await waitForAbort(Promise.resolve().then(() => (options.importBridge ?? importVerifiedBridge)(bridgeBytes)), controller.signal);
    if (!isBridge(bridge)) reject("avatar_bridge_rejected");
    const renderer = await waitForAbort(Promise.resolve().then(() => bridge.createAvatarRenderer({ canvas: options.canvas, manifest: options.manifest, assets })), controller.signal, disposeLateRenderer);
    if (!isRenderer(renderer)) reject("avatar_bridge_rejected");
    return renderer;
  } catch (cause) {
    if (cause instanceof Error && knownErrors.has(cause.message)) throw cause;
    throw new Error("avatar_load_failed");
  } finally {
    window.clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}
