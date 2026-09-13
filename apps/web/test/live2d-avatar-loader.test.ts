import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadVerifiedAvatarRenderer } from "../src/live2d/avatar-loader";
import type { AvatarAsset, AvatarModelManifest, AvatarRenderer } from "../src/live2d/avatar-contract";

const bytes = (value: string) => new TextEncoder().encode(value);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const bridgeBytes = bytes("verified bridge");
const modelBytes = bytes("verified model");

const asset = (path: string, url: string, value: Uint8Array): AvatarAsset => ({
  path,
  url,
  sha256: sha256(value),
  maxBytes: value.byteLength,
});

const manifest: AvatarModelManifest = {
  id: "live2d-simple-official-fixture",
  sdkVersion: "5-r.5",
  bridge: asset("bridge", "https://yui.example/live2d/bridge.js", bridgeBytes),
  assets: [asset("simple.model3.json", "https://yui.example/live2d/simple.model3.json", modelBytes)],
  notice: "公式検証用サンプル・YUI正式デザインではありません",
  provisional: true,
};

const renderer = (): AvatarRenderer => ({
  setInput: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
});

function successfulFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.endsWith("bridge.js")) return Promise.resolve(new Response(bridgeBytes));
  if (url.endsWith("simple.model3.json")) return Promise.resolve(new Response(modelBytes));
  return Promise.resolve(new Response(null, { status: 404 }));
}

describe("verified Live2D avatar loader", () => {
  it("passes only verified same-origin bytes to the bridge", async () => {
    const created = renderer();
    const createAvatarRenderer = vi.fn(async ({ assets }: { assets: ReadonlyMap<string, Uint8Array> }) => {
      expect(new TextDecoder().decode(assets.get("simple.model3.json"))).toBe("verified model");
      return created;
    });
    const importBridge = vi.fn(async (value: Uint8Array) => {
      expect(new TextDecoder().decode(value)).toBe("verified bridge");
      return { createAvatarRenderer };
    });

    await expect(loadVerifiedAvatarRenderer({
      canvas: document.createElement("canvas"),
      manifest,
      signal: new AbortController().signal,
      origin: "https://yui.example",
      fetchImpl: successfulFetch,
      importBridge,
    })).resolves.toBe(created);
    expect(createAvatarRenderer).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign-origin bridge and model URLs before fetch", async () => {
    const fetchImpl = vi.fn(successfulFetch);
    const foreignBridge = { ...manifest, bridge: { ...manifest.bridge, url: "https://other.example/bridge.js" } };
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest: foreignBridge, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, importBridge: vi.fn() })).rejects.toThrow("avatar_asset_rejected");

    const foreignModel = { ...manifest, assets: [{ ...manifest.assets[0]!, url: "https://other.example/model.json" }] };
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest: foreignModel, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, importBridge: vi.fn() })).rejects.toThrow("avatar_asset_rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unknown manifest and asset fields before fetch", async () => {
    const fetchImpl = vi.fn(successfulFetch);
    const unknownManifest = { ...manifest, unexpected: true } as AvatarModelManifest;
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest: unknownManifest, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, importBridge: vi.fn() })).rejects.toThrow("avatar_asset_rejected");

    const unknownAsset = { ...manifest, assets: [{ ...manifest.assets[0]!, unexpected: true }] } as AvatarModelManifest;
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest: unknownAsset, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, importBridge: vi.fn() })).rejects.toThrow("avatar_asset_rejected");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP failure", async () => new Response(null, { status: 404 })],
    ["oversized body", async () => new Response(bytes("verified model too large"))],
    ["hash mismatch", async () => new Response(bytes("tampered"))],
  ] as const)("fails closed for %s", async (_name, response) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("bridge.js") ? new Response(bridgeBytes) : response());
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, importBridge: vi.fn(async () => ({ createAvatarRenderer: async () => renderer() })) })).rejects.toThrow("avatar_asset_rejected");
  });

  it("aborts a hung read at the bounded timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, timeoutMs: 25, importBridge: vi.fn() });
    const assertion = expect(pending).rejects.toThrow("avatar_load_failed");
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    vi.useRealTimers();
  });

  it.each(["bridge import", "renderer creation"] as const)("times out a hung %s", async (phase) => {
    const never = new Promise<never>(() => undefined);
    const createAvatarRenderer = vi.fn(() => never);
    const importBridge = phase === "bridge import"
      ? vi.fn(() => never)
      : vi.fn(async () => ({ createAvatarRenderer }));
    const pending = loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl: successfulFetch, timeoutMs: 500, importBridge });
    const result = await Promise.race([
      pending.then(() => "resolved", (cause: unknown) => cause instanceof Error ? cause.message : "unknown"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1_000)),
    ]);

    expect(result).toBe("avatar_load_failed");
    expect(importBridge).toHaveBeenCalledTimes(1);
    if (phase === "renderer creation") expect(createAvatarRenderer).toHaveBeenCalledTimes(1);
  });

  it("cancels a chunked response as soon as it exceeds the byte ceiling", async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
        if (pulls === 3) controller.close();
      },
      cancel,
    }, { highWaterMark: 0 });
    const limited = { ...manifest, assets: [{ ...manifest.assets[0]!, maxBytes: 5 }] };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("bridge.js") ? new Response(bridgeBytes) : new Response(oversized));

    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest: limited, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl, importBridge: vi.fn() })).rejects.toThrow("avatar_asset_rejected");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBe(2);
  });

  it("accepts an approved replacement-model manifest", async () => {
    const approved = { ...manifest, provisional: false } as unknown as AvatarModelManifest;
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest: approved, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl: successfulFetch, importBridge: vi.fn(async () => ({ createAvatarRenderer: async () => renderer() })) })).resolves.toBeDefined();
  });

  it("rejects malformed bridge modules and renderer contracts", async () => {
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl: successfulFetch, importBridge: vi.fn(async () => ({})) })).rejects.toThrow("avatar_bridge_rejected");
    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest, signal: new AbortController().signal, origin: "https://yui.example", fetchImpl: successfulFetch, importBridge: vi.fn(async () => ({ createAvatarRenderer: async () => ({}) })) })).rejects.toThrow("avatar_bridge_rejected");
  });

  it("honors caller cancellation before importing the bridge", async () => {
    const controller = new AbortController();
    const importBridge = vi.fn();
    controller.abort();

    await expect(loadVerifiedAvatarRenderer({ canvas: document.createElement("canvas"), manifest, signal: controller.signal, origin: "https://yui.example", fetchImpl: successfulFetch, importBridge })).rejects.toThrow("avatar_load_failed");
    expect(importBridge).not.toHaveBeenCalled();
  });
});
